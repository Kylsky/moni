import { z } from 'zod';
import { HttpError } from '../lib/http';
import type { Currency } from './currencies';
import { datePeriod, resolveDatePeriod, todayInZone, trendEnd } from './dates';
import {
  type EntryFilters,
  type EntryTotals,
  entryFilters,
  entryQuery,
  readTotals,
  sumColumns,
} from './entry-query';
import { readSettings } from './settings';

export const reportInput = z
  .object({
    filters: entryFilters.default(() => entryFilters.parse({})),
    period: datePeriod.optional(),
    groupBy: z.enum(['category', 'tag']).default('category'),
    interval: z.enum(['day', 'week', 'month']).default('week'),
  })
  .strict()
  .refine(
    (value) => !value.period || (!value.filters.from && !value.filters.to)
  );

type Aggregate = {
  total: number;
  counts: { income: number; expense: number; refund: number };
  totals: EntryTotals;
  originalTotals: EntryTotals | null;
};
export type Report = Aggregate & {
  datasetId: string;
  revision: number;
  primaryCurrency: Currency;
  timeZone: string;
  filters: EntryFilters;
  groupBy: 'category' | 'tag';
  interval: 'day' | 'week' | 'month';
  groups: (Aggregate & {
    id: string | null;
    name: string | null;
    categoryKey: string | null;
    kind: 'income' | 'expense' | null;
    filters: EntryFilters;
  })[];
  trend: (Aggregate & { from: string; to: string; filters: EntryFilters })[];
};

export async function queryReport(
  db: D1Database,
  raw: unknown,
  now = new Date()
): Promise<Report> {
  const parsed = reportInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_report_query');
  const input = parsed.data;
  const settings = await readSettings(db);
  const range =
    input.period || (!input.filters.from && !input.filters.to)
      ? resolveDatePeriod(
          input.period ?? {
            kind: 'month',
            month: todayInZone(settings.timeZone, now).slice(0, 7),
          },
          settings.timeZone,
          now
        )
      : {
          from: input.filters.from ?? '1900-01-01',
          to: input.filters.to ?? '9999-12-31',
        };
  const resolved = entryFilters.safeParse({
    ...input.filters,
    ...range,
    page: 1,
  });
  if (!resolved.success) throw new HttpError(400, 'invalid_report_query');
  const filters = resolved.data;
  const { from, condition, values } = entryQuery(filters);
  const amounts = `${sumColumns('base_minor', 'base_')}${filters.currency ? `, ${sumColumns('original_minor', 'original_')}` : ''}`;
  const counts = `count(*) AS total, ${(['income', 'expense', 'refund'] as const).map((kind) => `coalesce(sum(e.kind = '${kind}'),0) AS count_${kind}`).join(',')}`;
  const columns = `${counts}, ${amounts}`;
  const tagJoin =
    ' LEFT JOIN entry_tags gt ON gt.dataset_id = e.dataset_id AND gt.entry_id = coalesce(p.id, e.id) LEFT JOIN tags g ON g.dataset_id = gt.dataset_id AND g.id = gt.tag_id';
  const group =
    input.groupBy === 'category'
      ? 'c.id AS id, c.name AS name, c.default_key AS categoryKey, c.kind AS kind'
      : 'g.id AS id, g.name AS name, NULL AS categoryKey, NULL AS kind';
  const bucket =
    input.interval === 'day'
      ? 'e.entry_date'
      : input.interval === 'month'
        ? "substr(e.entry_date,1,7) || '-01'"
        : "date(e.entry_date, 'weekday 0', '-6 days')";
  const [state, total, groups, trend] = await db.batch<Record<string, unknown>>(
    [
      db
        .prepare(
          'SELECT s.revision FROM moni_state s JOIN datasets d ON d.id = s.active_dataset WHERE s.singleton = 1 AND s.active_dataset = ? AND d.version = ?'
        )
        .bind(settings.datasetId, settings.version),
      db
        .prepare(`SELECT ${columns} ${from} WHERE ${condition}`)
        .bind(...values),
      db
        .prepare(
          `SELECT ${group}, ${columns} ${from}${input.groupBy === 'tag' ? tagJoin : ''} WHERE ${condition} GROUP BY ${input.groupBy === 'tag' ? 'g.id' : 'c.id'} ORDER BY base_expense DESC, base_income DESC, id`
        )
        .bind(...values),
      db
        .prepare(
          `SELECT ${bucket} AS bucket, ${columns} ${from} WHERE ${condition} GROUP BY bucket ORDER BY bucket`
        )
        .bind(...values),
    ]
  );
  if (!state.results.length) throw new HttpError(409, 'dataset_changed');
  const aggregate = (row: Record<string, unknown>): Aggregate => ({
    total: row.total as number,
    counts: {
      income: row.count_income as number,
      expense: row.count_expense as number,
      refund: row.count_refund as number,
    },
    totals: readTotals(row, 'base_'),
    originalTotals: filters.currency ? readTotals(row, 'original_') : null,
  });
  return {
    ...aggregate(total.results[0]),
    datasetId: settings.datasetId,
    revision: state.results[0].revision as number,
    primaryCurrency: settings.primaryCurrency,
    timeZone: settings.timeZone,
    filters,
    groupBy: input.groupBy,
    interval: input.interval,
    groups: groups.results.map((row) => ({
      ...aggregate(row),
      id: row.id as string | null,
      name: row.name as string | null,
      categoryKey: row.categoryKey as string | null,
      kind: row.kind as 'income' | 'expense' | null,
      filters: {
        ...filters,
        ...(input.groupBy === 'category'
          ? { categoryId: row.id as string }
          : row.id
            ? {
                requiredTagIds: [
                  ...new Set([
                    ...(filters.requiredTagIds ?? []),
                    row.id as string,
                  ]),
                ],
                untagged: undefined,
              }
            : { untagged: true }),
      },
    })),
    trend: trend.results.map((row) => {
      const start = row.bucket as string;
      const from = start < range.from ? range.from : start;
      const end = trendEnd(start, input.interval);
      const to = end > range.to ? range.to : end;
      return { ...aggregate(row), from, to, filters: { ...filters, from, to } };
    }),
  };
}
