import { z } from 'zod';
import {
  assertChatExecution,
  type ChatPermit,
  chatExecutionGuard,
} from '../lib/chat-persistence';
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
import { entryInput, entryWriteStatements } from './entries';
import { amountMinor } from './money';
import { previewQuote, readQuote } from './rates';
import { applyReference } from './reference-conversion';
import { readSettings } from './settings';
import { readTaxonomy, tagName } from './taxonomy';

export const draftToolInput = z
  .object({
    draftId: z.uuid().nullable(),
    version: z.number().int().positive().nullable(),
    items: z
      .array(
        z
          .object({
            itemId: z.uuid().nullable(),
            kind: z.enum(['income', 'expense']),
            name: z.string().trim().min(1).max(120),
            amount: z.string().min(1).max(20).nullable(),
            actualBaseAmount: z.string().min(1).max(20).nullable(),
            date: entryDate.nullable(),
            currency: z.enum(currencies).nullable(),
            currencyAmbiguous: z.boolean(),
            categoryId: z.string().min(1).max(100).nullable(),
            tags: z.array(tagName).max(10),
            note: z.string().max(limits.noteCharacters),
          })
          .strict()
      )
      .min(1)
      .max(20),
  })
  .strict();

export const draftItemInput = z
  .object({
    id: z.uuid(),
    kind: z.enum(['income', 'expense']),
    name: z.string().trim().min(1).max(120),
    amount: z.string().min(1).max(20).nullable(),
    date: entryDate,
    currency: z.enum(currencies).nullable(),
    categoryId: z.string().min(1).max(100),
    tags: z.array(tagName).max(10),
    note: z.string().max(limits.noteCharacters),
    conversion: conversionInput.nullable(),
  })
  .strict();
const itemsInput = z
  .array(draftItemInput)
  .min(1)
  .max(20)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length
  );
const actionInput = z
  .object({
    ...commandIdentity,
    id: z.uuid(),
    version: z.number().int().positive(),
    confirmed: z.literal(true),
  })
  .strict();
const saveInput = actionInput
  .omit({ confirmed: true })
  .extend({ items: itemsInput })
  .strict();

export type DraftItem = z.infer<typeof draftItemInput> & {
  originalMinor: number | null;
  baseMinor: number | null;
  snapshot: ConversionSnapshot | null;
  missing: ('amount' | 'currency' | 'conversion')[];
};
export type Draft = {
  datasetId: string;
  id: string;
  threadId: string;
  version: number;
  status: 'needs_details' | 'ready' | 'posted' | 'cancelled';
  baseCurrency: Currency;
  items: DraftItem[];
  totalBaseMinor: number | null;
  createdAt: number;
  updatedAt: number;
};
type DraftRow = Omit<Draft, 'items'> & { itemsJSON: string };
const draftColumns = `d.dataset_id AS datasetId,d.id,d.thread_id AS threadId,d.version,d.status,d.base_currency AS baseCurrency,
  d.items_json AS itemsJSON,d.total_base_minor AS totalBaseMinor,d.created_at AS createdAt,d.updated_at AS updatedAt`;
const fromRow = (row: DraftRow): Draft => {
  const { itemsJSON, ...rest } = row;
  return { ...rest, items: JSON.parse(itemsJSON) };
};
async function readDraft(db: D1Database, datasetId: string, id: string) {
  const row = await db
    .prepare(`SELECT ${draftColumns} FROM drafts d
    JOIN moni_state s ON s.singleton=1 AND s.active_dataset=d.dataset_id
    JOIN conversations c ON c.dataset_id=d.dataset_id AND c.id=d.thread_id AND c.deleted_at IS NULL
    WHERE d.dataset_id=? AND d.id=?`)
    .bind(datasetId, id)
    .first<DraftRow>();
  if (!row) throw new HttpError(409, 'draft_unavailable');
  return fromRow(row);
}
export async function queryDrafts(db: D1Database, threadId: string) {
  if (!z.uuid().safeParse(threadId).success)
    throw new HttpError(400, 'invalid_thread');
  const [conversation, rows] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT c.dataset_id AS datasetId FROM conversations c JOIN moni_state s ON s.singleton=1 AND s.active_dataset=c.dataset_id WHERE c.id=? AND c.deleted_at IS NULL`
      )
      .bind(threadId),
    db
      .prepare(
        `SELECT ${draftColumns} FROM drafts d JOIN moni_state s ON s.singleton=1 AND s.active_dataset=d.dataset_id JOIN conversations c ON c.dataset_id=d.dataset_id AND c.id=d.thread_id AND c.deleted_at IS NULL WHERE d.thread_id=? ORDER BY d.created_at,d.id`
      )
      .bind(threadId),
  ]);
  if (!conversation.results.length)
    throw new HttpError(404, 'conversation_not_found');
  return {
    datasetId: conversation.results[0].datasetId as string,
    items: (rows.results as DraftRow[]).map(fromRow),
  };
}
const conversationGuard = (
  db: D1Database,
  datasetId: string,
  threadId: string
) =>
  db
    .prepare(
      `INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE dataset_id=? AND id=? AND deleted_at IS NULL)`
    )
    .bind(datasetId, threadId);
const pending = (draft: Draft) => {
  if (!['ready', 'needs_details'].includes(draft.status))
    throw new HttpError(409, 'draft_closed');
};

const draftSizeGuard = (db: D1Database, items: DraftItem[]) =>
  db
    .prepare(
      'INSERT INTO invariant_assertions(valid) SELECT 0 WHERE length(CAST(? AS BLOB)) > ?'
    )
    .bind(JSON.stringify(items), limits.requestBytes);

async function prepareItems(
  db: D1Database,
  datasetId: string,
  items: z.infer<typeof itemsInput>,
  autoQuotes: boolean,
  execution?: { permit: ChatPermit; signal: AbortSignal }
) {
  const settings = await readSettings(db);
  if (!settings.initialized || settings.datasetId !== datasetId)
    throw new HttpError(409, 'dataset_changed');
  const taxonomy = await readTaxonomy(db);
  if (taxonomy.datasetId !== datasetId)
    throw new HttpError(409, 'dataset_changed');
  const prepared: DraftItem[] = [];
  for (const item of items) {
    if (
      !taxonomy.categories.some(
        (category) =>
          category.id === item.categoryId && category.kind === item.kind
      )
    )
      throw new HttpError(400, 'invalid_category');
    const missing: DraftItem['missing'] = [];
    if (!item.amount) missing.push('amount');
    if (!item.currency) missing.push('currency');
    const originalMinor =
      item.amount && item.currency
        ? amountMinor(item.amount, item.currency)
        : null;
    let baseMinor: number | null = null;
    let snapshot: ConversionSnapshot | null = null;
    let conversion = item.conversion;
    if (item.currency && item.currency !== settings.primaryCurrency) {
      if (!conversion && autoQuotes) {
        try {
          const quote = await previewQuote(
            db,
            {
              datasetId,
              operationId: crypto.randomUUID(),
              currency: item.currency,
              date: item.date,
            },
            execution
          );
          conversion = { quoteId: quote.id };
        } catch (error) {
          // A missing quote leaves an editable draft; revoked execution must stop.
          if (execution)
            await assertChatExecution(
              db,
              datasetId,
              execution.permit,
              execution.signal
            );
          if (
            !(error instanceof HttpError) ||
            ![400, 424, 502].includes(error.status)
          )
            throw error;
        }
      }
      if (!conversion) missing.push('conversion');
      if (conversion && originalMinor !== null) {
        const result =
          conversion.quoteId && conversion.actualAmount === undefined
            ? applyReference(
                originalMinor,
                item.currency,
                settings.primaryCurrency,
                item.date,
                await readQuote(db, datasetId, conversion.quoteId)
              )
            : prepareConversion(
                originalMinor,
                item.currency,
                settings.primaryCurrency,
                item.date,
                conversion
              );
        baseMinor = result.baseMinor;
        snapshot = result.snapshot;
      }
    } else if (item.currency) {
      if (conversion) throw new HttpError(400, 'invalid_conversion');
      baseMinor = originalMinor;
    }
    const tags = new Map<string, string>();
    for (const name of item.tags) {
      const canonical =
        taxonomy.tags.find(
          (tag) => tag.name.toLowerCase() === name.toLowerCase()
        )?.name ?? name;
      if (!tags.has(canonical.toLowerCase()))
        tags.set(canonical.toLowerCase(), canonical);
    }
    prepared.push({
      ...item,
      conversion,
      tags: [...tags.values()],
      originalMinor,
      baseMinor,
      snapshot,
      missing,
    });
  }
  const ready = prepared.every(
    (item) => !item.missing.length && item.baseMinor !== null
  );
  return {
    items: prepared,
    baseCurrency: settings.primaryCurrency,
    status: ready ? ('ready' as const) : ('needs_details' as const),
    totalBaseMinor: ready
      ? prepared.reduce((sum, item) => sum + (item.baseMinor ?? 0), 0)
      : null,
  };
}

export async function prepareDraft(
  db: D1Database,
  datasetId: string,
  execution: { permit: ChatPermit; signal: AbortSignal },
  raw: unknown,
  operationId: string
) {
  const parsed = draftToolInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_draft');
  const input = parsed.data;
  if (Boolean(input.draftId) !== Boolean(input.version))
    throw new HttpError(400, 'invalid_draft_version');
  if (
    new TextEncoder().encode(JSON.stringify(input)).length > limits.contextBytes
  )
    throw new HttpError(413, 'draft_limit');
  const id = input.draftId ?? operationId;
  const toolInput = {
    ...input,
    datasetId,
    operationId,
    threadId: execution.permit.threadId,
  };
  await assertChatExecution(db, datasetId, execution.permit, execution.signal);
  await executeCommand(
    db,
    'prepare_draft',
    toolInput,
    async () => {
      const current = input.draftId ? await readDraft(db, datasetId, id) : null;
      if (current) {
        pending(current);
        if (
          current.threadId !== execution.permit.threadId ||
          current.version !== input.version
        )
          throw new HttpError(409, 'draft_changed');
        if (
          input.items.length !== current.items.length ||
          new Set(input.items.map((item) => item.itemId)).size !==
            current.items.length ||
          input.items.some(
            (item) => !current.items.some((row) => row.id === item.itemId)
          )
        )
          throw new HttpError(400, 'invalid_draft_items');
      } else if (input.items.some((item) => item.itemId !== null))
        throw new HttpError(400, 'invalid_draft_items');
      const settings = await readSettings(db);
      const taxonomy = await readTaxonomy(db);
      if (taxonomy.datasetId !== datasetId)
        throw new HttpError(409, 'dataset_changed');
      const items = input.items.map((item) => {
        const previous = current?.items.find((row) => row.id === item.itemId);
        const date = item.date ?? todayInZone(settings.timeZone);
        const currency = item.currencyAmbiguous
          ? null
          : (item.currency ?? settings.primaryCurrency);
        return {
          id: previous?.id ?? crypto.randomUUID(),
          kind: item.kind,
          name: item.name,
          amount: item.amount,
          date,
          currency,
          categoryId:
            taxonomy.categories.find(
              (category) =>
                category.id === item.categoryId && category.kind === item.kind
            )?.id ?? `${item.kind}-uncategorized`,
          tags: item.tags,
          note: item.note,
          conversion:
            item.actualBaseAmount !== null
              ? { actualAmount: item.actualBaseAmount }
              : previous?.currency === currency &&
                  previous.date === date &&
                  (previous.amount === item.amount ||
                    (item.amount !== null &&
                      currency !== null &&
                      previous.originalMinor ===
                        amountMinor(item.amount, currency)))
                ? previous.conversion
                : null,
        };
      });
      const values = await prepareItems(db, datasetId, items, true, execution);
      await assertChatExecution(
        db,
        datasetId,
        execution.permit,
        execution.signal
      );
      const now = Date.now();
      return [
        chatExecutionGuard(db, datasetId, execution.permit),
        draftSizeGuard(db, values.items),
        current
          ? db
              .prepare(
                `UPDATE drafts SET items_json=?,status=?,base_currency=?,total_base_minor=?,version=version+1,updated_at=? WHERE dataset_id=? AND id=? AND version=? AND status IN ('ready','needs_details')`
              )
              .bind(
                JSON.stringify(values.items),
                values.status,
                values.baseCurrency,
                values.totalBaseMinor,
                now,
                datasetId,
                id,
                input.version
              )
          : db
              .prepare(
                `INSERT INTO drafts(dataset_id,id,thread_id,status,base_currency,items_json,total_base_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`
              )
              .bind(
                datasetId,
                id,
                execution.permit.threadId,
                values.status,
                values.baseCurrency,
                JSON.stringify(values.items),
                values.totalBaseMinor,
                now,
                now
              ),
        assertChanged(db),
      ];
    },
    {
      draftId: id,
      threadId: execution.permit.threadId,
      runId: execution.permit.runId,
    }
  );
  return readDraft(db, datasetId, id);
}

export async function saveDraft(db: D1Database, raw: unknown) {
  const parsed = saveInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_draft');
  const input = parsed.data;
  return executeCommand(
    db,
    'save_draft',
    input,
    async () => {
      const current = await readDraft(db, input.datasetId, input.id);
      pending(current);
      const values = await prepareItems(
        db,
        input.datasetId,
        input.items,
        false
      );
      return [
        conversationGuard(db, input.datasetId, current.threadId),
        draftSizeGuard(db, values.items),
        db
          .prepare(
            `UPDATE drafts SET items_json=?,status=?,base_currency=?,total_base_minor=?,version=version+1,updated_at=? WHERE dataset_id=? AND id=? AND version=? AND status IN ('ready','needs_details')`
          )
          .bind(
            JSON.stringify(values.items),
            values.status,
            values.baseCurrency,
            values.totalBaseMinor,
            Date.now(),
            input.datasetId,
            input.id,
            input.version
          ),
        assertChanged(db),
      ];
    },
    { draftId: input.id, saved: true }
  );
}

export async function confirmDraft(
  db: D1Database,
  raw: unknown,
  guards: D1PreparedStatement[] = []
) {
  const parsed = actionInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_draft_action');
  const input = parsed.data;
  return executeCommand(
    db,
    'confirm_draft',
    input,
    async () => [...guards, ...(await draftConfirmationStatements(db, input))],
    { draftId: input.id, posted: true }
  );
}

async function draftConfirmationStatements(
  db: D1Database,
  input: z.infer<typeof actionInput>
) {
  const draft = await readDraft(db, input.datasetId, input.id);
  if (draft.status !== 'ready') throw new HttpError(409, 'draft_incomplete');
  const statements = [
    conversationGuard(db, input.datasetId, draft.threadId),
    db
      .prepare(
        `INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM datasets WHERE id=? AND primary_currency=?)`
      )
      .bind(input.datasetId, draft.baseCurrency),
    db
      .prepare(
        `UPDATE drafts SET status='posted',version=version+1,updated_at=? WHERE dataset_id=? AND id=? AND version=? AND status='ready'`
      )
      .bind(Date.now(), input.datasetId, input.id, input.version),
    assertChanged(db),
  ];
  for (const item of draft.items) {
    const entry = entryInput.safeParse({
      datasetId: input.datasetId,
      operationId: input.operationId,
      id: item.id,
      kind: item.kind,
      name: item.name,
      amount: item.amount,
      currency: item.currency,
      date: item.date,
      categoryId: item.categoryId,
      tags: item.tags,
      note: item.note,
      ...(item.conversion ? { conversion: item.conversion } : {}),
      confirmedBaseMinor: item.baseMinor,
    });
    if (!entry.success) throw new HttpError(409, 'draft_incomplete');
    statements.push(...(await entryWriteStatements(db, entry.data, false)));
  }
  return statements;
}

export async function confirmDraftBatch(
  db: D1Database,
  raw: unknown,
  guards: D1PreparedStatement[] = []
) {
  const parsed = actionInput
    .omit({ id: true, version: true })
    .extend({
      threadId: z.uuid(),
      drafts: z
        .array(actionInput.pick({ id: true, version: true }))
        .min(1)
        .max(20),
    })
    .strict()
    .safeParse(raw);
  if (
    !parsed.success ||
    new Set(parsed.data.drafts.map(({ id }) => id)).size !==
      parsed.data.drafts.length
  )
    throw new HttpError(400, 'invalid_draft_action');
  const input = parsed.data;
  return executeCommand(
    db,
    'confirm_draft_batch',
    input,
    async () => {
      const statements = [...guards];
      let itemCount = 0;
      for (const target of input.drafts) {
        const draft = await readDraft(db, input.datasetId, target.id);
        itemCount += draft.items.length;
        if (draft.threadId !== input.threadId || itemCount > 20)
          throw new HttpError(409, 'draft_unavailable');
        statements.push(
          ...(await draftConfirmationStatements(db, { ...input, ...target }))
        );
      }
      return statements;
    },
    { posted: true, draftIds: input.drafts.map(({ id }) => id) }
  );
}

export async function cancelDraft(db: D1Database, raw: unknown) {
  const parsed = actionInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_draft_action');
  const input = parsed.data;
  return executeCommand(
    db,
    'cancel_draft',
    input,
    async () => {
      const draft = await readDraft(db, input.datasetId, input.id);
      return [
        conversationGuard(db, input.datasetId, draft.threadId),
        db
          .prepare(
            `UPDATE drafts SET status='cancelled',version=version+1,updated_at=? WHERE dataset_id=? AND id=? AND version=? AND status IN ('ready','needs_details')`
          )
          .bind(Date.now(), input.datasetId, input.id, input.version),
        assertChanged(db),
      ];
    },
    { draftId: input.id, cancelled: true }
  );
}
