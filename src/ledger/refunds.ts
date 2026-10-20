import { z } from 'zod';
import { assertChanged, commandIdentity, executeCommand } from '../lib/command';
import { HttpError } from '../lib/http';
import { limits } from '../lib/limits';
import { entryDate, todayInZone } from './dates';
import type { Entry } from './entries';
import { type EntryPage, queryEntries } from './entry-query';
import { prepareRefund } from './refund-money';
import { readSettings } from './settings';

const refundInput = z
  .object({
    ...commandIdentity,
    id: z.uuid(),
    expenseId: z.uuid(),
    expenseVersion: z.number().int().positive(),
    version: z.number().int().positive().optional(),
    amount: z.string().min(1).max(20),
    actualAmount: z.string().min(1).max(20).optional(),
    date: entryDate.optional(),
    note: z.string().max(limits.noteCharacters).default(''),
    confirmedBaseMinor: z.number().int().min(0).max(limits.moneyMinor),
  })
  .strict();

export type RefundPage = EntryPage & {
  expense: Entry;
  defaultRefundedMinor: number;
};
export async function readRefunds(
  db: D1Database,
  expenseId: string,
  page: number
): Promise<RefundPage> {
  const expensePage = await queryEntries(db, {}, expenseId);
  const expense = expensePage.items[0];
  if (!expense || expense.kind !== 'expense')
    throw new HttpError(404, 'expense_not_found');
  const result = await queryEntries(
    db,
    { currency: expense.currency, page },
    undefined,
    false,
    expenseId
  );
  if (result.datasetId !== expensePage.datasetId)
    throw new HttpError(409, 'dataset_changed');
  return {
    ...result,
    expense,
    defaultRefundedMinor: result.defaultRefundedMinor ?? 0,
  };
}

export async function saveRefund(db: D1Database, raw: unknown, edit: boolean) {
  const parsed = refundInput.safeParse(raw);
  if (!parsed.success || edit !== (parsed.data.version !== undefined))
    throw new HttpError(400, 'invalid_refund');
  const input = parsed.data;
  return executeCommand(
    db,
    edit ? 'edit_refund' : 'create_refund',
    input,
    async () => {
      const settings = await readSettings(db);
      if (!settings.initialized)
        throw new HttpError(409, 'initialization_required');
      const related = await readRefunds(db, input.expenseId, 1).catch(
        (error: unknown) => {
          if (error instanceof HttpError && error.status === 404)
            throw new HttpError(409, 'expense_not_found');
          throw error;
        }
      );
      const expense = related.expense;
      const current = edit
        ? (await queryEntries(db, {}, input.id)).items[0]
        : undefined;
      if (
        edit &&
        (!current ||
          current.kind !== 'refund' ||
          current.refundOf !== input.expenseId)
      )
        throw new HttpError(409, 'refund_changed');
      const refundedOriginal =
        (related.originalTotals?.refund ?? 0) - (current?.originalMinor ?? 0);
      const refundedDefault =
        related.defaultRefundedMinor - (current?.refundDefaultMinor ?? 0);
      const prepared = prepareRefund(
        expense,
        settings.primaryCurrency,
        refundedOriginal,
        refundedDefault,
        input.amount,
        input.actualAmount,
        current
      );
      if (input.confirmedBaseMinor !== prepared.baseMinor)
        throw new HttpError(409, 'refund_confirmation_required');
      const date =
        input.date ?? current?.date ?? todayInZone(settings.timeZone);
      const now = Date.now();
      const sum = (
        column: string
      ) => `coalesce((SELECT sum(${column}) FROM refund_links l JOIN entries r ON r.dataset_id=l.dataset_id AND r.id=l.refund_id
      WHERE l.dataset_id=? AND l.expense_id=? AND r.id<>? AND r.deleted_at IS NULL),0)`;
      return [
        db
          .prepare(`INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS (
        SELECT 1 FROM entries WHERE dataset_id=? AND id=? AND version=? AND deleted_at IS NULL AND kind='expense')`)
          .bind(input.datasetId, input.expenseId, input.expenseVersion),
        db
          .prepare(
            `INSERT INTO invariant_assertions(valid) SELECT 0 WHERE ${sum('r.original_minor')} <> ? OR ${sum('l.default_base_minor')} <> ?`
          )
          .bind(
            input.datasetId,
            input.expenseId,
            input.id,
            refundedOriginal,
            input.datasetId,
            input.expenseId,
            input.id,
            refundedDefault
          ),
        edit
          ? db
              .prepare(`UPDATE entries SET original_minor=?,base_minor=?,conversion_json=?,entry_date=?,note=?,updated_at=?,version=version+1
        WHERE dataset_id=? AND id=? AND kind='refund' AND version=? AND deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM refund_links WHERE dataset_id=? AND refund_id=? AND expense_id=?)`)
              .bind(
                prepared.originalMinor,
                prepared.baseMinor,
                prepared.snapshot ? JSON.stringify(prepared.snapshot) : null,
                date,
                input.note,
                now,
                input.datasetId,
                input.id,
                input.version,
                input.datasetId,
                input.id,
                input.expenseId
              )
          : db
              .prepare(`INSERT INTO entries(dataset_id,id,kind,name,entry_date,currency,original_minor,base_minor,conversion_json,category_id,note,created_at,updated_at)
          VALUES (?,?,'refund',?,?,?,?,?,?,?,?,?,?)`)
              .bind(
                input.datasetId,
                input.id,
                expense.name,
                date,
                expense.currency,
                prepared.originalMinor,
                prepared.baseMinor,
                prepared.snapshot ? JSON.stringify(prepared.snapshot) : null,
                expense.categoryId,
                input.note,
                now,
                now
              ),
        assertChanged(db),
        edit
          ? db
              .prepare(
                'UPDATE refund_links SET default_base_minor=?,actual_override=? WHERE dataset_id=? AND refund_id=? AND expense_id=?'
              )
              .bind(
                prepared.defaultMinor,
                prepared.actual ? 1 : 0,
                input.datasetId,
                input.id,
                input.expenseId
              )
          : db
              .prepare(
                'INSERT INTO refund_links(dataset_id,refund_id,expense_id,default_base_minor,actual_override) VALUES (?,?,?,?,?)'
              )
              .bind(
                input.datasetId,
                input.id,
                input.expenseId,
                prepared.defaultMinor,
                prepared.actual ? 1 : 0
              ),
        assertChanged(db),
      ];
    },
    { entryId: input.id }
  );
}
