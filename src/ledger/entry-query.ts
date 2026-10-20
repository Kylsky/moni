import { z } from 'zod';
import { HttpError } from '../lib/http';
import { type Currency, currencies } from './currencies';
import { entryDate } from './dates';
import type { Entry } from './entries';

export const entryFilters = z
  .object({
    from: entryDate.optional(),
    to: entryDate.optional(),
    kind: z.enum(['income', 'expense', 'refund', 'spending']).optional(),
    currency: z.enum(currencies).optional(),
    categoryId: z.string().min(1).max(100).optional(),
    tagIds: z.array(z.uuid()).max(20).optional(),
    requiredTagIds: z.array(z.uuid()).max(20).optional(),
    keyword: z.string().trim().max(200).optional(),
    untagged: z.literal(true).optional(),
    page: z.number().int().min(1).max(5000).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to);
export type EntryFilters = z.infer<typeof entryFilters>;
export type EntryTotals = {
  income: number;
  expense: number;
  refund: number;
  netExpense: number;
};
export type EntryPage = {
  datasetId: string;
  revision: number;
  primaryCurrency: Currency;
  totals: EntryTotals;
  originalTotals: EntryTotals | null;
  defaultRefundedMinor?: number;
  filters: EntryFilters;
  items: Entry[];
  total: number;
  pageCount: number;
};

const entryFrom = `FROM entries e LEFT JOIN refund_links rl ON rl.dataset_id = e.dataset_id AND rl.refund_id = e.id
  LEFT JOIN entries p ON p.dataset_id = rl.dataset_id AND p.id = rl.expense_id
  JOIN categories c ON c.dataset_id = e.dataset_id AND c.id = coalesce(p.category_id, e.category_id)
  JOIN moni_state s ON s.singleton = 1 AND s.active_dataset = e.dataset_id`;
export const entrySelect = `SELECT e.id, e.kind, rl.expense_id AS refundOf, rl.default_base_minor AS refundDefaultMinor,
  rl.actual_override AS refundActual, e.name, e.entry_date AS date, e.currency,
  e.original_minor AS originalMinor, e.base_minor AS baseMinor, e.conversion_json AS conversion_json,
  coalesce(p.category_id, e.category_id) AS categoryId, c.name AS categoryName, c.default_key AS categoryKey, e.note, e.version,
  e.created_at AS createdAt, e.updated_at AS updatedAt, e.deleted_at AS deletedAt,
  (SELECT json_group_array(json_object('id', t.id, 'name', t.name)) FROM entry_tags et
   JOIN tags t ON t.dataset_id = et.dataset_id AND t.id = et.tag_id
   WHERE et.dataset_id = e.dataset_id AND et.entry_id = coalesce(p.id, e.id)) AS tags_json
  ${entryFrom}`;

export async function queryEntries(
  db: D1Database,
  raw: unknown,
  id?: string,
  trash = false,
  refundOf?: string
): Promise<EntryPage> {
  const parsed = entryFilters.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_entry_query');
  const filters = parsed.data;
  const { condition, values } = entryQuery(filters, id, trash, refundOf);
  const [state, count, rows] = await db.batch<Record<string, unknown>>([
    db.prepare(
      'SELECT s.active_dataset, s.revision, d.primary_currency FROM moni_state s JOIN datasets d ON d.id = s.active_dataset WHERE s.singleton = 1'
    ),
    db
      .prepare(
        `SELECT count(*) AS total, ${sumColumns('base_minor', 'base_')}${filters.currency ? `, ${sumColumns('original_minor', 'original_')}` : ''}${refundOf ? ', coalesce(sum(rl.default_base_minor),0) AS default_refund' : ''} ${entryFrom} WHERE ${condition}`
      )
      .bind(...values),
    db
      .prepare(
        `${entrySelect} WHERE ${condition} ORDER BY ${trash ? 'e.deleted_at' : 'e.entry_date'} DESC, e.id DESC LIMIT ? OFFSET ?`
      )
      .bind(...values, filters.pageSize, (filters.page - 1) * filters.pageSize),
  ]);
  if (!state.results.length) throw new HttpError(503, 'storage_not_ready');
  const total = count.results[0].total as number;

  return {
    datasetId: state.results[0].active_dataset as string,
    revision: state.results[0].revision as number,
    primaryCurrency: state.results[0].primary_currency as Currency,
    totals: readTotals(count.results[0], 'base_'),
    originalTotals: filters.currency
      ? readTotals(count.results[0], 'original_')
      : null,
    ...(refundOf
      ? { defaultRefundedMinor: count.results[0].default_refund as number }
      : {}),
    filters,
    total,
    pageCount: Math.ceil(total / filters.pageSize),
    items: (
      rows.results as (Entry & {
        tags_json: string;
        conversion_json: string | null;
      })[]
    ).map(({ tags_json, conversion_json, ...entry }) => ({
      ...entry,
      refundActual: Boolean(entry.refundActual),
      tags: JSON.parse(tags_json) as Entry['tags'],
      conversion: conversion_json
        ? (JSON.parse(conversion_json) as Entry['conversion'])
        : null,
    })),
  };
}

export async function readEntries(db: D1Database, id?: string) {
  return (await queryEntries(db, { pageSize: 50 }, id)).items;
}

export function entryQuery(
  filters: EntryFilters,
  id?: string,
  trash = false,
  refundOf?: string
) {
  const where = [`e.deleted_at IS ${trash ? 'NOT NULL' : 'NULL'}`];
  const values: (string | number)[] = [];
  for (const [field, value] of [
    ['e.entry_date >= ?', filters.from],
    ['e.entry_date <= ?', filters.to],
    ['e.kind = ?', filters.kind === 'spending' ? undefined : filters.kind],
    ['e.currency = ?', filters.currency],
    ['coalesce(p.category_id, e.category_id) = ?', filters.categoryId],
    ['e.id = ?', id],
    ['rl.expense_id = ?', refundOf],
  ] as const) {
    if (value !== undefined) {
      where.push(field);
      values.push(value);
    }
  }
  if (filters.kind === 'spending') where.push("e.kind IN ('expense','refund')");
  if (filters.keyword) {
    // instr treats percent/underscore and quotes as literal text, never SQL wildcards.
    where.push(
      '(instr(lower(e.name), lower(?)) > 0 OR instr(lower(e.note), lower(?)) > 0)'
    );
    values.push(filters.keyword, filters.keyword);
  }
  if (filters.tagIds?.length) {
    where.push(`EXISTS (SELECT 1 FROM entry_tags et WHERE et.dataset_id = e.dataset_id AND et.entry_id = coalesce(p.id, e.id)
      AND et.tag_id IN (SELECT coalesce(t.merged_into, t.id) FROM tags t WHERE t.dataset_id = e.dataset_id
      AND t.id IN (${filters.tagIds.map(() => '?').join(',')})))`);
    values.push(...filters.tagIds);
  }
  for (const requiredTagId of new Set(filters.requiredTagIds ?? [])) {
    where.push(
      'EXISTS (SELECT 1 FROM entry_tags et WHERE et.dataset_id = e.dataset_id AND et.entry_id = coalesce(p.id, e.id) AND et.tag_id = (SELECT coalesce(t.merged_into, t.id) FROM tags t WHERE t.dataset_id = e.dataset_id AND t.id = ?))'
    );
    values.push(requiredTagId);
  }
  if (filters.untagged)
    where.push(
      'NOT EXISTS (SELECT 1 FROM entry_tags et WHERE et.dataset_id = e.dataset_id AND et.entry_id = coalesce(p.id, e.id))'
    );
  return { from: entryFrom, condition: where.join(' AND '), values };
}

export function sumColumns(
  column: 'base_minor' | 'original_minor',
  prefix: string
) {
  return (['income', 'expense', 'refund'] as const)
    .map(
      (kind) =>
        `coalesce(sum(CASE WHEN e.deleted_at IS NULL AND e.kind = '${kind}' THEN e.${column} ELSE 0 END),0) AS ${prefix}${kind}`
    )
    .join(',');
}

export function readTotals(
  row: Record<string, unknown>,
  prefix: string
): EntryTotals {
  const income = row[`${prefix}income`] as number;
  const expense = row[`${prefix}expense`] as number;
  const refund = row[`${prefix}refund`] as number;
  if (![income, expense, refund, expense - refund].every(Number.isSafeInteger))
    throw new HttpError(413, 'aggregate_out_of_range');
  return { income, expense, refund, netExpense: expense - refund };
}
