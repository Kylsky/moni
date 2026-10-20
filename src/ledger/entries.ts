import { z } from 'zod';
import { assertChanged, commandIdentity, executeCommand } from '../lib/command';
import { HttpError } from '../lib/http';
import { limits } from '../lib/limits';
import {
  type ConversionSnapshot,
  conversionInput,
  prepareConversion,
} from './conversion';
import { type Currency, currencies } from './currencies';
import { entryDate, todayInZone } from './dates';
import { queryEntries } from './entry-query';
import { amountMinor } from './money';
import { readQuote } from './rates';
import { applyReference } from './reference-conversion';
import { readSettings } from './settings';
import { tagName } from './taxonomy';

export const entryInput = z
  .object({
    ...commandIdentity,
    id: z.uuid(),
    kind: z.enum(['income', 'expense']),
    name: z.string().trim().min(1).max(120),
    date: entryDate.optional(),
    currency: z.enum(currencies).optional(),
    amount: z.string().min(1).max(20),
    categoryId: z.string().min(1).max(100).optional(),
    tags: z.array(tagName).max(10).default([]),
    note: z.string().max(limits.noteCharacters).default(''),
    conversion: conversionInput.optional(),
    confirmedBaseMinor: z
      .number()
      .int()
      .min(0)
      .max(limits.moneyMinor)
      .optional(),
  })
  .strict();
export const editEntryInput = entryInput
  .extend({ version: z.number().int().positive() })
  .strict();

export type Entry = {
  id: string;
  kind: 'income' | 'expense' | 'refund';
  refundOf: string | null;
  refundDefaultMinor: number | null;
  refundActual: boolean;
  name: string;
  date: string;
  currency: Currency;
  originalMinor: number;
  baseMinor: number;
  conversion: ConversionSnapshot | null;
  categoryId: string;
  categoryName: string;
  categoryKey: string | null;
  note: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  tags: { id: string; name: string }[];
};

export async function saveEntry(db: D1Database, raw: unknown, edit: boolean) {
  const parsed = (edit ? editEntryInput : entryInput).safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_entry');
  const input = parsed.data;
  return executeCommand(
    db,
    edit ? 'edit_entry' : 'create_entry',
    input,
    () => entryWriteStatements(db, input, edit),
    { entryId: input.id }
  );
}

export async function entryWriteStatements(
  db: D1Database,
  input: z.infer<typeof entryInput> | z.infer<typeof editEntryInput>,
  edit: boolean
): Promise<D1PreparedStatement[]> {
  const settings = await readSettings(db);
  if (!settings.initialized)
    throw new HttpError(409, 'initialization_required');
  if (settings.datasetId !== input.datasetId)
    throw new HttpError(409, 'dataset_changed');
  const current = edit
    ? (await queryEntries(db, {}, input.id)).items[0]
    : undefined;
  const currency =
    input.currency ?? current?.currency ?? settings.primaryCurrency;
  if (current?.kind === 'refund') throw new HttpError(400, 'use_refund_editor');
  const minor = amountMinor(input.amount, currency);
  const category = input.categoryId ?? `${input.kind}-uncategorized`;
  const date = input.date ?? current?.date ?? todayInZone(settings.timeZone);
  let baseMinor = minor;
  let snapshot: ConversionSnapshot | null = null;
  if (currency !== settings.primaryCurrency) {
    if (input.conversion) {
      const prepared =
        input.conversion.quoteId && input.conversion.actualAmount === undefined
          ? applyReference(
              minor,
              currency,
              settings.primaryCurrency,
              date,
              await readQuote(db, input.datasetId, input.conversion.quoteId)
            )
          : prepareConversion(
              minor,
              currency,
              settings.primaryCurrency,
              date,
              input.conversion
            );
      baseMinor = prepared.baseMinor;
      snapshot = prepared.snapshot;
      if (input.confirmedBaseMinor !== baseMinor)
        throw new HttpError(409, 'conversion_confirmation_required');
    } else if (edit) {
      if (
        !current ||
        current.currency !== currency ||
        current.originalMinor !== minor ||
        current.date !== date ||
        !current.conversion
      )
        throw new HttpError(400, 'conversion_required');
      baseMinor = current.baseMinor;
      snapshot = current.conversion;
      if (
        input.confirmedBaseMinor !== undefined &&
        input.confirmedBaseMinor !== baseMinor
      )
        throw new HttpError(409, 'conversion_confirmation_required');
    } else throw new HttpError(400, 'conversion_required');
  } else if (
    input.conversion ||
    (input.confirmedBaseMinor !== undefined &&
      input.confirmedBaseMinor !== minor)
  )
    throw new HttpError(400, 'invalid_conversion');
  if (
    current &&
    currency !== current.currency &&
    input.confirmedBaseMinor !== baseMinor
  )
    throw new HttpError(409, 'conversion_confirmation_required');
  const now = Date.now();
  const statements = [
    db
      .prepare(`INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS (
  SELECT 1 FROM datasets WHERE id = ? AND primary_currency = ? AND initialized = 1
)`)
      .bind(input.datasetId, settings.primaryCurrency),
    db
      .prepare(`INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS (
  SELECT 1 FROM categories WHERE dataset_id = ? AND id = ? AND kind = ?
)`)
      .bind(input.datasetId, category, input.kind),
    edit
      ? db
          .prepare(`UPDATE entries SET kind = ?, name = ?, entry_date = ?, currency = ?,
  original_minor = ?, base_minor = ?, conversion_json = ?, category_id = ?, note = ?, updated_at = ?, version = version + 1
  WHERE dataset_id = ? AND id = ? AND version = ? AND deleted_at IS NULL`)
          .bind(
            input.kind,
            input.name,
            date,
            currency,
            minor,
            baseMinor,
            snapshot ? JSON.stringify(snapshot) : null,
            category,
            input.note,
            now,
            input.datasetId,
            input.id,
            'version' in input ? input.version : -1
          )
      : db
          .prepare(`INSERT INTO entries(dataset_id, id, kind, name, entry_date, currency, original_minor,
    base_minor, conversion_json, category_id, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            input.datasetId,
            input.id,
            input.kind,
            input.name,
            date,
            currency,
            minor,
            baseMinor,
            snapshot ? JSON.stringify(snapshot) : null,
            category,
            input.note,
            now,
            now
          ),
    assertChanged(db),
    db
      .prepare('DELETE FROM entry_tags WHERE dataset_id = ? AND entry_id = ?')
      .bind(input.datasetId, input.id),
  ];
  const names = new Map(input.tags.map((name) => [name.toLowerCase(), name]));
  for (const [normalized, name] of names)
    statements.push(
      db
        .prepare(`INSERT INTO tags(dataset_id, id, name, normalized_name) VALUES (?, ?, ?, ?)
  ON CONFLICT(dataset_id, normalized_name) DO NOTHING`)
        .bind(input.datasetId, crypto.randomUUID(), name, normalized),
      db
        .prepare(`INSERT OR IGNORE INTO entry_tags(dataset_id, entry_id, tag_id) SELECT ?, ?, coalesce(merged_into, id) FROM tags
  WHERE dataset_id = ? AND normalized_name = ?`)
        .bind(input.datasetId, input.id, input.datasetId, normalized)
    );
  statements.push(
    db
      .prepare(`UPDATE datasets SET currency_locked = 1, version = version + 1
WHERE id = ? AND currency_locked = 0`)
      .bind(input.datasetId)
  );
  return statements;
}
