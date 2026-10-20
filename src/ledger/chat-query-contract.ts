import { z } from 'zod';
import { currencies } from './currencies';
import { datePeriod, entryDate } from './dates';
import { entryFilters } from './entry-query';

export const queryPeriod = z.union([
  datePeriod,
  z.object({ kind: z.enum(['this_month', 'last_month', 'all_time']) }).strict(),
  z
    .object({
      kind: z.literal('last_days'),
      days: z.number().int().min(1).max(3650),
    })
    .strict(),
  z
    .object({ kind: z.literal('custom'), from: entryDate, to: entryDate })
    .strict()
    .refine((value) => value.from <= value.to),
]);
export const queryFilterPatch = z
  .object({
    currency: z.enum(currencies).nullable().optional(),
    categoryId: z.string().min(1).max(100).nullable().optional(),
    tagIds: z.array(z.uuid()).max(20).nullable().optional(),
    requiredTagIds: z.array(z.uuid()).max(20).nullable().optional(),
    keyword: z.string().trim().max(200).nullable().optional(),
    untagged: z.boolean().nullable().optional(),
  })
  .strict();
export const ledgerQueryInput = z
  .object({
    inheritPrevious: z.boolean(),
    period: queryPeriod.nullable(),
    scope: z.enum(['spending', 'income', 'all']).nullable(),
    filters: queryFilterPatch,
    view: z
      .enum(['summary', 'categories', 'tags', 'trend', 'entries'])
      .nullable(),
    interval: z.enum(['day', 'week', 'month']).nullable(),
    page: z.number().int().min(1).max(5000).nullable().optional(),
  })
  .strict();
export type LedgerQueryInput = z.infer<typeof ledgerQueryInput>;
export const resolvedLedgerQuery = ledgerQueryInput.extend({
  inheritPrevious: z.literal(false),
  period: queryPeriod,
  scope: z.enum(['spending', 'income', 'all']),
  view: z.enum(['summary', 'categories', 'tags', 'trend', 'entries']),
  interval: z.enum(['day', 'week', 'month']),
});
const integer = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const count = integer.min(0);
const totals = z
  .object({ income: count, expense: count, refund: count, netExpense: integer })
  .strict();
const aggregate = z
  .object({
    total: count,
    counts: z.object({ income: count, expense: count, refund: count }).strict(),
    totals,
    originalTotals: totals.nullable(),
  })
  .strict();
const resultFilters = entryFilters.safeExtend({
  from: entryDate,
  to: entryDate,
});
const report = aggregate.extend({
  datasetId: z.string().min(1).max(100),
  revision: count,
  primaryCurrency: z.enum(currencies),
  timeZone: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
  filters: resultFilters,
  groupBy: z.enum(['category', 'tag']),
  interval: z.enum(['day', 'week', 'month']),
  groups: z.array(
    aggregate.extend({
      id: z.string().nullable(),
      name: z.string().nullable(),
      categoryKey: z.string().nullable(),
      kind: z.enum(['income', 'expense']).nullable(),
      filters: resultFilters,
    })
  ),
  trend: z.array(
    aggregate.extend({ from: entryDate, to: entryDate, filters: resultFilters })
  ),
});
export const ledgerQueryResult = z
  .object({
    type: z.literal('ledger_query'),
    id: z.uuid(),
    asOf: count.max(8640000000000000),
    query: resolvedLedgerQuery,
    criteria: z
      .object({
        category: z
          .object({ name: z.string(), defaultKey: z.string().nullable() })
          .nullable(),
        tags: z.array(z.object({ id: z.uuid(), name: z.string() })),
      })
      .strict(),
    report,
    entries: z
      .object({
        page: count.min(1).max(5000),
        pageSize: z.literal(5),
        pageCount: count,
        items: z
          .array(
            z
              .object({
                id: z.uuid(),
                name: z.string().max(120),
                date: entryDate,
                kind: z.enum(['income', 'expense', 'refund']),
                currency: z.enum(currencies),
                originalMinor: count,
                baseMinor: count,
                categoryName: z.string(),
                categoryKey: z.string().nullable(),
                tags: z.array(z.string()).max(10),
                note: z.string().max(400),
                noteTruncated: z.boolean(),
              })
              .strict()
          )
          .max(5),
      })
      .strict()
      .optional(),
  })
  .strict();
export type LedgerQueryResult = z.infer<typeof ledgerQueryResult>;

export function parseQueryResult(raw: unknown): LedgerQueryResult | null {
  try {
    const parsed = ledgerQueryResult.safeParse(
      typeof raw === 'string' ? JSON.parse(raw) : raw
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const queryUpdate = z
  .object({ id: z.uuid(), result: ledgerQueryResult.nullable() })
  .strict()
  .refine(({ id, result }) => result === null || result.id === id);
export type LedgerQueryUpdate = z.infer<typeof queryUpdate>;

export function parseQueryUpdates(raw: unknown): LedgerQueryUpdate[] {
  const direct = parseQueryResult(raw);
  if (direct) return [{ id: direct.id, result: direct }];
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(value?.queryUpdates)) {
      const updates = z
        .array(queryUpdate)
        .max(12)
        .safeParse(value.queryUpdates);
      return updates.success ? updates.data : [];
    }
    // Existing transcripts retain their original single-result representation.
    const refreshed = parseQueryResult(value?.queryResult);
    if (refreshed) return [{ id: refreshed.id, result: refreshed }];
    const failed = z.uuid().safeParse(value?.queryRefreshError);
    return failed.success ? [{ id: failed.data, result: null }] : [];
  } catch {
    return [];
  }
}
