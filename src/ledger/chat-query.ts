import type { ModelMessage } from '@tanstack/ai';
import {
  assertChatExecution,
  type ChatPermit,
  chatPersistence,
} from '../lib/chat-persistence';
import { HttpError } from '../lib/http';
import { limits } from '../lib/limits';
import {
  type LedgerQueryInput,
  type LedgerQueryResult,
  ledgerQueryInput,
  ledgerQueryResult,
  parseQueryUpdates,
} from './chat-query-contract';
import { resolveDatePeriod, shiftMonth, todayInZone } from './dates';
import { entryFilters, queryEntries } from './entry-query';
import { queryReport, type Report } from './reports';
import { readSettings } from './settings';
import { readTaxonomy } from './taxonomy';

async function readQueryEntries(db: D1Database, report: Report, page: number) {
  const data = await queryEntries(db, { ...report.filters, page, pageSize: 5 });
  if (data.datasetId !== report.datasetId || data.revision !== report.revision)
    throw new HttpError(409, 'conversation_changed');
  return {
    page,
    pageSize: 5 as const,
    pageCount: data.pageCount,
    items: data.items.map((entry) => {
      const note = Array.from(entry.note);
      return {
        id: entry.id,
        name: entry.name,
        date: entry.date,
        kind: entry.kind,
        currency: entry.currency,
        originalMinor: entry.originalMinor,
        baseMinor: entry.baseMinor,
        categoryName: entry.categoryName,
        categoryKey: entry.categoryKey,
        tags: entry.tags.map((tag) => tag.name),
        note: note.slice(0, 200).join(''),
        noteTruncated: note.length > 200,
      };
    }),
  };
}

export function resolveQueryPeriod(
  period: NonNullable<LedgerQueryInput['period']>,
  timeZone: string,
  now = new Date()
) {
  const today = todayInZone(timeZone, now);
  if (period.kind === 'all_time')
    return { from: '1900-01-01', to: '9999-12-31' };
  if (period.kind === 'custom') return { from: period.from, to: period.to };
  if (period.kind === 'last_days') {
    const start = new Date(`${today}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - period.days + 1);
    return { from: start.toISOString().slice(0, 10), to: today };
  }
  if (
    period.kind === 'month' ||
    period.kind === 'rolling_months' ||
    period.kind === 'complete_months'
  )
    return resolveDatePeriod(period, timeZone, now);
  return resolveDatePeriod(
    {
      kind: 'month',
      month: shiftMonth(
        today.slice(0, 7),
        period.kind === 'last_month' ? -1 : 0
      ),
    },
    timeZone,
    now
  );
}

export async function previousLedgerQuery(
  db: D1Database,
  datasetId: string,
  threadId: string
) {
  const messages = (await chatPersistence(
    db,
    datasetId
  ).stores.messages.loadThread(threadId)) as ModelMessage[];
  const names = new Map<string, string>();
  let latest: LedgerQueryResult | null = null;
  for (const message of messages) {
    for (const call of message.toolCalls ?? [])
      names.set(call.id, call.function.name);
    if (
      message.role === 'tool' &&
      message.toolCallId &&
      ['query_ledger', 'prepare_draft'].includes(
        names.get(message.toolCallId) ?? ''
      )
    ) {
      for (const update of parseQueryUpdates(message.content))
        if (
          update.result &&
          (names.get(message.toolCallId) === 'query_ledger' ||
            update.id === latest?.id)
        )
          latest = update.result;
    }
  }
  return latest;
}

export async function refreshLedgerQuery(
  db: D1Database,
  datasetId: string,
  query: LedgerQueryResult
): Promise<LedgerQueryResult> {
  const report = await queryReport(db, {
    filters: query.report.filters,
    groupBy: query.report.groupBy,
    interval: query.report.interval,
  });
  if (report.datasetId !== datasetId)
    throw new HttpError(409, 'dataset_changed');
  const result = ledgerQueryResult.parse({
    ...query,
    asOf: Date.now(),
    ...(query.query.view === 'entries'
      ? { entries: await readQueryEntries(db, report, query.query.page ?? 1) }
      : {}),
    report: {
      ...report,
      groups: ['categories', 'tags'].includes(query.query.view)
        ? report.groups
        : [],
      trend: query.query.view === 'trend' ? report.trend : [],
    },
  });
  if (
    new TextEncoder().encode(JSON.stringify(result)).length >
    limits.contextBytes
  )
    throw new HttpError(413, 'query_result_limit');
  return result;
}

export async function runLedgerQuery(
  db: D1Database,
  datasetId: string,
  permit: ChatPermit,
  signal: AbortSignal,
  raw: unknown,
  previous: LedgerQueryResult | null
): Promise<LedgerQueryResult> {
  const parsed = ledgerQueryInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_ledger_query');
  const input = parsed.data;
  await assertChatExecution(db, datasetId, permit, signal);
  if (input.inheritPrevious && !previous)
    throw new HttpError(400, 'query_context_required');
  const inherited = input.inheritPrevious ? previous?.query : null;
  const period = input.period ?? inherited?.period;
  if (!period) throw new HttpError(400, 'query_period_required');
  const patch = { ...inherited?.filters, ...input.filters };
  const filters: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch))
    if (
      value !== null &&
      value !== undefined &&
      !(key === 'untagged' && !value)
    )
      filters[key] = value;
  const settings = await readSettings(db);
  const taxonomy = await readTaxonomy(db);
  if (settings.datasetId !== datasetId || taxonomy.datasetId !== datasetId)
    throw new HttpError(409, 'dataset_changed');
  const scope = input.scope ?? inherited?.scope ?? 'spending';
  const view = input.view ?? inherited?.view ?? 'summary';
  const interval = input.interval ?? inherited?.interval ?? 'week';
  const page =
    input.page ??
    (input.period || Object.keys(input.filters).length
      ? 1
      : (inherited?.page ?? 1));
  const category = filters.categoryId
    ? taxonomy.categories.find((item) => item.id === filters.categoryId)
    : null;
  if (filters.categoryId && !category)
    throw new HttpError(400, 'invalid_query_filter');
  if (
    category &&
    ((scope === 'income' && category.kind !== 'income') ||
      (scope === 'spending' && category.kind !== 'expense'))
  )
    throw new HttpError(400, 'invalid_query_filter');
  const ids = [
    ...new Set([
      ...((filters.tagIds as string[] | undefined) ?? []),
      ...((filters.requiredTagIds as string[] | undefined) ?? []),
    ]),
  ];
  const tagRows = ids.length
    ? (
        await db
          .prepare(
            `SELECT t.id,coalesce(target.id,t.id) AS canonicalId,coalesce(target.name,t.name) AS name FROM tags t LEFT JOIN tags target ON target.dataset_id=t.dataset_id AND target.id=t.merged_into WHERE t.dataset_id=? AND t.id IN (${ids.map(() => '?').join(',')})`
          )
          .bind(datasetId, ...ids)
          .all<{ id: string; canonicalId: string; name: string }>()
      ).results
    : [];
  if (tagRows.length !== ids.length)
    throw new HttpError(400, 'invalid_query_filter');
  for (const field of ['tagIds', 'requiredTagIds'] as const)
    if (filters[field])
      filters[field] = [
        ...new Set(
          (filters[field] as string[]).map(
            (id) => tagRows.find((tag) => tag.id === id)?.canonicalId
          )
        ),
      ];
  const now = new Date();
  const range = resolveQueryPeriod(period, settings.timeZone, now);
  const criteria = entryFilters.safeParse({
    ...filters,
    ...range,
    ...(scope === 'spending'
      ? { kind: 'spending' }
      : scope === 'income'
        ? { kind: 'income' }
        : {}),
    page: 1,
  });
  if (!criteria.success) throw new HttpError(400, 'invalid_query_period');
  const report = await queryReport(
    db,
    {
      filters: criteria.data,
      groupBy: view === 'tags' ? 'tag' : 'category',
      interval,
    },
    now
  );
  if (
    report.datasetId !== datasetId ||
    report.primaryCurrency !== settings.primaryCurrency ||
    report.timeZone !== settings.timeZone
  )
    throw new HttpError(409, 'dataset_changed');
  const result = ledgerQueryResult.parse({
    type: 'ledger_query',
    id: crypto.randomUUID(),
    asOf: Date.now(),
    query: {
      inheritPrevious: false,
      period,
      scope,
      filters,
      view,
      interval,
      ...(view === 'entries' ? { page } : {}),
    },
    ...(view === 'entries'
      ? { entries: await readQueryEntries(db, report, page) }
      : {}),
    criteria: {
      category: category
        ? { name: category.name, defaultKey: category.defaultKey }
        : null,
      tags: [
        ...new Map(
          tagRows.map((tag) => [
            tag.canonicalId,
            { id: tag.canonicalId, name: tag.name },
          ])
        ).values(),
      ],
    },
    report: {
      ...report,
      groups: ['categories', 'tags'].includes(view) ? report.groups : [],
      trend: view === 'trend' ? report.trend : [],
    },
  });
  if (
    new TextEncoder().encode(JSON.stringify(result)).length >
    limits.contextBytes
  )
    throw new HttpError(413, 'query_result_limit');
  await assertChatExecution(db, datasetId, permit, signal);
  return result;
}
