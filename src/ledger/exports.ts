import { HttpError } from '../lib/http';
import { limits } from '../lib/limits';
import type { Entry } from './entries';
import { entryFilters, entryQuery, entrySelect } from './entry-query';
import { decimalAmount } from './money';

// This allowlist is the versioned business format; execution receipts, permits and deployment config are never selected.
export const backupSections = [
  {
    name: 'categories',
    table: 'categories',
    fields: {
      id: 'id',
      kind: 'kind',
      name: 'name',
      defaultKey: 'default_key',
      version: 'version',
    },
    order: 'id',
  },
  {
    name: 'tags',
    table: 'tags',
    fields: {
      id: 'id',
      name: 'name',
      normalizedName: 'normalized_name',
      version: 'version',
      mergedInto: 'merged_into',
    },
    order: 'id',
  },
  {
    name: 'entries',
    table: 'entries',
    fields: {
      id: 'id',
      kind: 'kind',
      name: 'name',
      date: 'entry_date',
      currency: 'currency',
      originalMinor: 'original_minor',
      baseMinor: 'base_minor',
      categoryId: 'category_id',
      note: 'note',
      version: 'version',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      deletedAt: 'deleted_at',
      conversion: 'json(conversion_json)',
    },
    order: 'id',
  },
  {
    name: 'entryTags',
    table: 'entry_tags',
    fields: { entryId: 'entry_id', tagId: 'tag_id' },
    order: 'entry_id,tag_id',
  },
  {
    name: 'refundLinks',
    table: 'refund_links',
    fields: {
      refundId: 'refund_id',
      expenseId: 'expense_id',
      defaultBaseMinor: 'default_base_minor',
      actualOverride: 'actual_override',
    },
    order: 'refund_id',
  },
  {
    name: 'conversations',
    table: 'conversations',
    fields: {
      id: 'id',
      title: 'title',
      source: 'source',
      version: 'version',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      deletedAt: 'deleted_at',
    },
    order: 'id',
  },
  {
    name: 'messages',
    table: 'chat_messages',
    fields: {
      threadId: 'thread_id',
      position: 'position',
      message: 'json(message_json)',
    },
    order: 'thread_id,position',
  },
  {
    name: 'runs',
    table: 'chat_runs',
    fields: {
      id: 'run_id',
      threadId: 'thread_id',
      status: 'status',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      errorCode: 'error_code',
      usage: 'json(usage_json)',
      parentRunId: 'parent_run_id',
    },
    order: 'thread_id,started_at,run_id',
  },
  {
    name: 'interrupts',
    table: 'chat_interrupts',
    fields: {
      id: 'interrupt_id',
      runId: 'run_id',
      threadId: 'thread_id',
      status: 'status',
      requestedAt: 'requested_at',
      resolvedAt: 'resolved_at',
      payload: 'json(payload_json)',
      response: 'json(response_json)',
    },
    order: 'thread_id,requested_at,interrupt_id',
  },
  {
    name: 'drafts',
    table: 'drafts',
    fields: {
      id: 'id',
      threadId: 'thread_id',
      version: 'version',
      status: 'status',
      baseCurrency: 'base_currency',
      items: 'json(items_json)',
      totalBaseMinor: 'total_base_minor',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    order: 'id',
  },
] as const;

type Selection = { sql: string; values?: (string | number)[] };
const stateSelect = `SELECT s.active_dataset AS datasetId,s.revision,d.primary_currency AS primaryCurrency,d.time_zone AS timeZone,
  d.initialized,d.currency_locked AS currencyLocked,d.version FROM moni_state s JOIN datasets d ON d.id=s.active_dataset WHERE s.singleton=1`;
type ExportState = {
  datasetId: string;
  revision: number;
  primaryCurrency: Entry['currency'];
  timeZone: string;
  initialized: number;
  currencyLocked: number;
  version: number;
};

async function snapshot(db: D1Database, selections: Selection[]) {
  const preflight = await db.batch<Record<string, unknown>>([
    db.prepare(stateSelect),
    ...selections.map(({ sql, values = [] }) =>
      db
        .prepare(
          `SELECT count(*) AS count,coalesce(sum(length(CAST(item AS BLOB))),0) AS bytes FROM (${sql})`
        )
        .bind(...values)
    ),
  ]);
  const before = preflight[0].results[0] as ExportState | undefined;
  if (!before) throw new HttpError(503, 'storage_not_ready');
  const records = preflight
    .slice(1)
    .reduce((sum, result) => sum + Number(result.results[0].count), 0);
  const bytes = preflight
    .slice(1)
    .reduce((sum, result) => sum + Number(result.results[0].bytes), 0);
  if (records > limits.backupRecords || bytes + records > limits.backupBytes)
    throw new HttpError(413, 'export_too_large');
  // Both batches are transactional snapshots; reject any mutation between the bounded preflight and the actual read.
  const captured = await db.batch<{ item: string } | ExportState>([
    db.prepare(stateSelect),
    ...selections.map(({ sql, values = [] }) =>
      db.prepare(`${sql} LIMIT ?`).bind(...values, limits.backupRecords + 1)
    ),
  ]);
  const state = captured[0].results[0] as ExportState;
  if (
    !state ||
    state.datasetId !== before.datasetId ||
    state.revision !== before.revision
  )
    throw new HttpError(409, 'export_changed');
  const rows = captured.slice(1).map((result, index) => {
    if (result.results.length !== preflight[index + 1].results[0].count)
      throw new HttpError(409, 'export_changed');
    return (result.results as { item: string }[]).map(({ item }) =>
      JSON.parse(item)
    );
  });
  return { state, rows };
}

export function backupSelections(datasetId?: string): Selection[] {
  return backupSections.map((section) => {
    const fields = Object.entries(section.fields)
      .flatMap(([key, column]) => [`'${key}'`, column])
      .join(',');
    const formal = ['chat_messages', 'chat_runs', 'chat_interrupts'].includes(
      section.table
    )
      ? ` AND thread_id IN (SELECT id FROM conversations c WHERE c.dataset_id=${section.table}.dataset_id)`
      : '';
    return {
      sql: `SELECT json_object(${fields}) AS item FROM ${section.table} WHERE dataset_id=${datasetId ? '?' : '(SELECT active_dataset FROM moni_state WHERE singleton=1)'}${formal} ORDER BY ${section.order}`,
      values: datasetId ? [datasetId] : [],
    };
  });
}

export async function exportBackup(db: D1Database) {
  const { state, rows } = await snapshot(db, backupSelections());
  const backup = {
    format: 'moni',
    version: 1,
    exportedAt: Date.now(),
    revision: state.revision,
    settings: {
      primaryCurrency: state.primaryCurrency,
      timeZone: state.timeZone,
      initialized: Boolean(state.initialized),
      currencyLocked: Boolean(state.currencyLocked),
      version: state.version,
    },
    data: Object.fromEntries(
      backupSections.map((section, index) => [section.name, rows[index]])
    ),
  };
  const content = JSON.stringify(backup);
  if (new TextEncoder().encode(content).length > limits.backupBytes)
    throw new HttpError(413, 'export_too_large');
  return { content, datasetId: state.datasetId, revision: state.revision };
}

export function csvCell(value: unknown) {
  const text = String(value ?? '');
  // A leading apostrophe keeps spreadsheet formulas and control-prefixed formulas inert.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: These controls can hide spreadsheet formula prefixes.
  const formulaPrefix = /^[\s\u0000-\u001f]*[=+@-]/u;
  const safe =
    formulaPrefix.test(text) || /^[\t\r\n]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export async function exportCsv(db: D1Database, raw: unknown) {
  const parsed = entryFilters.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_entry_query');
  const { condition, values } = entryQuery(parsed.data);
  const fields = [
    'id',
    'kind',
    'name',
    'date',
    'currency',
    'originalMinor',
    'baseMinor',
    'categoryName',
    'note',
    'refundOf',
    'refundDefaultMinor',
    'refundActual',
  ].flatMap((name) => [`'${name}'`, name]);
  const { state, rows } = await snapshot(db, [
    {
      sql: `SELECT json_object(${fields.join(',')},'conversion',json(conversion_json),'tags',json(tags_json)) AS item FROM (${entrySelect} WHERE ${condition}) ORDER BY date DESC,id DESC`,
      values,
    },
  ]);
  const header = [
    'id',
    'date',
    'type',
    'name',
    'note',
    'original_currency',
    'original_amount',
    'primary_currency',
    'primary_amount',
    'category',
    'tags',
    'refund_of',
    'refund_default_primary_amount',
    'refund_actual_override',
    'conversion_method',
    'conversion_source',
    'conversion_rate',
    'conversion_numerator',
    'conversion_denominator',
    'quote_date',
    'ledger_revision',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const entry of rows[0] as Entry[]) {
    const conversion = entry.conversion;
    lines.push(
      [
        entry.id,
        entry.date,
        entry.kind,
        entry.name,
        entry.note,
        entry.currency,
        decimalAmount(entry.originalMinor, entry.currency),
        state.primaryCurrency,
        decimalAmount(entry.baseMinor, state.primaryCurrency),
        entry.categoryName,
        JSON.stringify(entry.tags.map((tag) => tag.name)),
        entry.refundOf,
        entry.refundDefaultMinor === null
          ? ''
          : decimalAmount(entry.refundDefaultMinor, state.primaryCurrency),
        entry.refundActual ? 'true' : 'false',
        conversion?.method,
        conversion?.source,
        conversion?.rate,
        conversion?.numerator,
        conversion?.denominator,
        conversion?.quoteDate,
        state.revision,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  const content = `\uFEFF${lines.join('\r\n')}\r\n`;
  if (new TextEncoder().encode(content).length > limits.backupBytes)
    throw new HttpError(413, 'export_too_large');
  return { content, datasetId: state.datasetId, revision: state.revision };
}

export function exportResponse(
  result: { content: string; datasetId: string; revision: number },
  kind: 'csv' | 'json'
) {
  return new Response(result.content, {
    headers: {
      'Content-Type':
        kind === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="moni-${kind === 'csv' ? 'entries' : 'backup'}.${kind}"`,
      'X-Moni-Dataset': result.datasetId,
      'X-Moni-Revision': String(result.revision),
    },
  });
}
