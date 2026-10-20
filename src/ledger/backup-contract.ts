import { z } from 'zod';
import { HttpError } from '../lib/http';
import { limits } from '../lib/limits';
import { roundRatio } from './conversion';
import { currencies, currencyDecimals } from './currencies';
import { entryDate } from './dates';
import { draftItemInput } from './drafts';
import { amountMinor } from './money';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const version = integer.min(1);
const timestamp = integer.max(8640000000000000);
const minor = integer.max(limits.moneyMinor);
const identifier = z.string().min(1).max(128);
const currency = z.enum(currencies);
export const conversionSnapshot = z
  .object({
    method: z.enum(['manual_rate', 'actual', 'reference']),
    source: z.enum(['manual', 'actual', 'ECB']),
    baseCurrency: currency,
    numerator: z.string().regex(/^[1-9]\d{0,47}$/),
    denominator: z.string().regex(/^[1-9]\d{0,47}$/),
    rate: z.string().max(50).nullable(),
    quoteDate: entryDate.nullable(),
  })
  .strict();
const category = z
  .object({
    id: identifier.max(100),
    kind: z.enum(['income', 'expense']),
    name: z.string().min(1).max(50),
    defaultKey: z.string().max(100).nullable(),
    version,
  })
  .strict();
const tag = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(30),
    normalizedName: z.string().min(1).max(60),
    version,
    mergedInto: z.uuid().nullable(),
  })
  .strict();
const entry = z
  .object({
    id: z.uuid(),
    kind: z.enum(['income', 'expense', 'refund']),
    name: z.string().min(1).max(120),
    date: entryDate,
    currency,
    originalMinor: minor.min(1),
    baseMinor: minor,
    categoryId: identifier.max(100),
    note: z.string().max(limits.noteCharacters),
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: timestamp.nullable(),
    conversion: conversionSnapshot.nullable(),
  })
  .strict();
const conversation = z
  .object({
    id: z.uuid(),
    title: z.string().max(80),
    source: z.enum(['web', 'wechat']).default('web'),
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: timestamp.nullable(),
  })
  .strict();
// Validate the text/tool transcript and preserve SDK thinking and provider metadata.
const modelMessage = z
  .object({
    role: z.enum(['user', 'assistant', 'tool']),
    content: z.union([
      z.string(),
      z.null(),
      z.array(
        z
          .object({
            type: z.literal('text'),
            content: z.string(),
            metadata: z.unknown().optional(),
          })
          .strict()
      ),
    ]),
    id: identifier.optional(),
    name: z.string().max(128).optional(),
    toolCallId: identifier.optional(),
    createdAt: z.iso.datetime({ offset: true }).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    error: z.string().optional(),
    thinking: z
      .array(
        z
          .object({
            content: z.string(),
            signature: z.string().optional(),
            redacted: z.boolean().optional(),
          })
          .strict()
      )
      .optional(),
    blockOrder: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('thinking'), index: integer }).strict(),
          z.object({ type: z.literal('text'), length: integer }).strict(),
          z.object({ type: z.literal('tool-call'), id: identifier }).strict(),
        ])
      )
      .optional(),
    midConversationChange: z
      .object({
        tools: z.array(z.string()).optional(),
        toolsAdded: z.array(z.string()).optional(),
        systemPrompts: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    toolCalls: z
      .array(
        z
          .object({
            id: identifier,
            type: z.literal('function'),
            function: z
              .object({
                name: z.string().min(1).max(128),
                arguments: z.string(),
              })
              .strict(),
            metadata: z.unknown().optional(),
          })
          .strict()
      )
      .optional(),
  })
  .strict();
const draftItem = draftItemInput
  .extend({
    originalMinor: minor.min(1).nullable(),
    baseMinor: minor.nullable(),
    snapshot: conversionSnapshot.nullable(),
    missing: z.array(z.enum(['amount', 'currency', 'conversion'])).max(3),
  })
  .strict();
const draft = z
  .object({
    id: z.uuid(),
    threadId: z.uuid(),
    version,
    status: z.enum(['needs_details', 'ready', 'posted', 'cancelled']),
    baseCurrency: currency,
    items: z.array(draftItem).min(1).max(20),
    totalBaseMinor: integer.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const backupFile = z
  .object({
    format: z.literal('moni'),
    version: z.literal(1),
    exportedAt: timestamp,
    revision: integer,
    settings: z
      .object({
        primaryCurrency: currency,
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
        initialized: z.boolean(),
        currencyLocked: z.boolean(),
        version: integer,
      })
      .strict(),
    data: z
      .object({
        categories: z.array(category),
        tags: z.array(tag),
        entries: z.array(entry),
        entryTags: z.array(
          z.object({ entryId: z.uuid(), tagId: z.uuid() }).strict()
        ),
        refundLinks: z.array(
          z
            .object({
              refundId: z.uuid(),
              expenseId: z.uuid(),
              defaultBaseMinor: minor,
              actualOverride: z.union([z.literal(0), z.literal(1)]),
            })
            .strict()
        ),
        conversations: z.array(conversation),
        messages: z.array(
          z
            .object({
              threadId: z.uuid(),
              position: integer,
              message: modelMessage,
            })
            .strict()
        ),
        runs: z.array(
          z
            .object({
              id: identifier,
              threadId: z.uuid(),
              status: z.enum(['running', 'completed', 'failed', 'aborted']),
              startedAt: timestamp,
              finishedAt: timestamp.nullable(),
              errorCode: z.string().max(128).nullable(),
              usage: z.record(z.string(), z.unknown()).nullable(),
              parentRunId: identifier.nullable(),
            })
            .strict()
        ),
        interrupts: z.array(
          z
            .object({
              id: identifier,
              runId: identifier,
              threadId: z.uuid(),
              status: z.enum(['pending', 'resolved', 'cancelled']),
              requestedAt: timestamp,
              resolvedAt: timestamp.nullable(),
              payload: z.unknown(),
              response: z.unknown(),
            })
            .strict()
        ),
        drafts: z.array(draft),
      })
      .strict(),
  })
  .strict();
export type LedgerBackup = z.infer<typeof backupFile>;

function invalid(code = 'backup_inconsistent'): never {
  throw new HttpError(400, code);
}
function unique<T>(rows: T[], key: (row: T) => string) {
  const map = new Map(rows.map((row) => [key(row), row]));
  if (map.size !== rows.length) invalid('backup_duplicates');
  return map;
}
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

function checkConversion(
  row: {
    currency: LedgerBackup['settings']['primaryCurrency'];
    originalMinor: number;
    baseMinor: number;
    conversion: z.infer<typeof conversionSnapshot> | null;
    date: string;
  },
  base: LedgerBackup['settings']['primaryCurrency'],
  exact = true
) {
  const snapshot = row.conversion;
  if (row.currency === base) {
    if (snapshot || row.originalMinor !== row.baseMinor)
      invalid('backup_money');
    return;
  }
  if (!snapshot || snapshot.baseCurrency !== base) invalid('backup_money');
  const numerator = BigInt(snapshot.numerator);
  const denominator = BigInt(snapshot.denominator);
  const originalScale = 10n ** BigInt(currencyDecimals[row.currency]);
  const baseScale = 10n ** BigInt(currencyDecimals[base]);
  if (
    exact &&
    roundRatio(
      BigInt(row.originalMinor) * numerator * baseScale,
      denominator * originalScale
    ) !== BigInt(row.baseMinor)
  )
    invalid('backup_money');
  if (snapshot.method === 'actual') {
    if (
      snapshot.source !== 'actual' ||
      snapshot.rate !== null ||
      snapshot.quoteDate !== null ||
      (exact &&
        numerator * BigInt(row.originalMinor) * baseScale !==
          BigInt(row.baseMinor) * denominator * originalScale)
    )
      invalid('backup_money');
  } else {
    if (!snapshot.quoteDate || (exact && snapshot.quoteDate > row.date))
      invalid('backup_money');
    if (snapshot.method === 'manual_rate') {
      if (
        snapshot.source !== 'manual' ||
        !snapshot.rate ||
        !/^\d{1,9}(?:\.\d{1,12})?$/.test(snapshot.rate)
      )
        invalid('backup_money');
      const [whole, fraction = ''] = snapshot.rate.split('.');
      if (
        BigInt(whole + fraction) * denominator !==
        numerator * 10n ** BigInt(fraction.length)
      )
        invalid('backup_money');
    } else {
      const display = roundRatio(numerator * 10n ** 12n, denominator)
        .toString()
        .padStart(13, '0');
      const rate = `${display.slice(0, -12)}.${display.slice(-12)}`.replace(
        /\.?0+$/,
        ''
      );
      if (snapshot.source !== 'ECB' || snapshot.rate !== rate)
        invalid('backup_money');
    }
  }
}

export function validateBackup(raw: unknown): LedgerBackup {
  // Reject pathological JSON nesting before schemas or serialization can exhaust the call stack.
  const stack = [{ value: raw, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    if (++nodes > 1_000_000 || current.depth > 80) invalid('backup_structure');
    if (current.value && typeof current.value === 'object')
      for (const value of Object.values(current.value))
        stack.push({ value, depth: current.depth + 1 });
  }
  if (bytes(raw) > limits.backupBytes)
    throw new HttpError(413, 'backup_too_large');
  if (raw && typeof raw === 'object' && 'version' in raw && raw.version !== 1)
    invalid('backup_version');
  const parsed = backupFile.safeParse(raw);
  if (!parsed.success) invalid('backup_structure');
  const value = parsed.data;
  const { data, settings } = value;
  if (
    Object.values(data).reduce((sum, rows) => sum + rows.length, 0) >
    limits.backupRecords
  )
    throw new HttpError(413, 'backup_too_large');
  const categories = unique(data.categories, (row) => row.id);
  unique(data.categories, (row) => `${row.kind}:${row.name}`);
  const tags = unique(data.tags, (row) => row.id);
  unique(data.tags, (row) => row.normalizedName);
  const entries = unique(data.entries, (row) => row.id);
  const threads = unique(data.conversations, (row) => row.id);
  const runs = unique(data.runs, (row) => row.id);
  unique(data.interrupts, (row) => row.id);
  unique(data.drafts, (row) => row.id);
  unique(data.entryTags, (row) => `${row.entryId}:${row.tagId}`);
  const links = unique(data.refundLinks, (row) => row.refundId);
  unique(data.messages, (row) => `${row.threadId}:${row.position}`);
  if (
    (settings.currencyLocked && !settings.initialized) ||
    (!settings.initialized &&
      (data.entries.length ||
        data.conversations.length ||
        data.drafts.length)) ||
    (data.entries.length && !settings.currencyLocked)
  )
    invalid();
  for (const kind of ['income', 'expense'])
    if (categories.get(`${kind}-uncategorized`)?.kind !== kind)
      invalid('backup_association');
  for (const tag of data.tags) {
    if (
      tag.name !== tag.name.normalize('NFC') ||
      tag.normalizedName !== tag.name.toLowerCase() ||
      tag.name.trim() !== tag.name
    )
      invalid();
    if (
      tag.mergedInto &&
      (tag.mergedInto === tag.id ||
        !tags.has(tag.mergedInto) ||
        tags.get(tag.mergedInto)?.mergedInto)
    )
      invalid('backup_association');
  }
  for (const row of data.entries) {
    const category = categories.get(row.categoryId);
    if (
      !category ||
      category.kind !== (row.kind === 'income' ? 'income' : 'expense')
    )
      invalid('backup_association');
    if (row.updatedAt < row.createdAt) invalid();
    if (row.kind === 'refund' ? !links.has(row.id) : links.has(row.id))
      invalid('backup_association');
    checkConversion(row, settings.primaryCurrency, row.kind !== 'refund');
  }
  for (const link of data.entryTags)
    if (
      !entries.has(link.entryId) ||
      !tags.has(link.tagId) ||
      tags.get(link.tagId)?.mergedInto
    )
      invalid('backup_association');
  const budgets = new Map<string, { original: bigint; base: bigint }>();
  for (const link of data.refundLinks) {
    const refund = entries.get(link.refundId);
    const parent = entries.get(link.expenseId);
    if (
      !refund ||
      refund.kind !== 'refund' ||
      !parent ||
      parent.id === refund.id ||
      parent.kind === 'refund'
    )
      invalid('backup_association');
    if (
      (!link.actualOverride && refund.baseMinor !== link.defaultBaseMinor) ||
      (link.actualOverride &&
        (refund.currency === settings.primaryCurrency ||
          refund.conversion?.method !== 'actual'))
    )
      invalid('backup_money');
    if (link.actualOverride) checkConversion(refund, settings.primaryCurrency);
    if (refund.deletedAt === null) {
      if (
        parent.kind !== 'expense' ||
        parent.deletedAt !== null ||
        refund.currency !== parent.currency
      )
        invalid('backup_association');
      const budget = budgets.get(parent.id) ?? { original: 0n, base: 0n };
      budget.original += BigInt(refund.originalMinor);
      budget.base += BigInt(link.defaultBaseMinor);
      budgets.set(parent.id, budget);
    }
  }
  for (const [id, budget] of budgets) {
    const parent = entries.get(id);
    if (
      !parent ||
      budget.original > BigInt(parent.originalMinor) ||
      budget.base > BigInt(parent.baseMinor) ||
      (budget.original === BigInt(parent.originalMinor) &&
        budget.base !== BigInt(parent.baseMinor))
    )
      invalid('backup_money');
  }
  const histories = new Map<string, LedgerBackup['data']['messages']>();
  for (const row of data.messages) {
    if (
      !threads.has(row.threadId) ||
      threads.get(row.threadId)?.deletedAt !== null
    )
      invalid('backup_association');
    const rows = histories.get(row.threadId) ?? [];
    rows.push(row);
    histories.set(row.threadId, rows);
  }
  for (const rows of histories.values()) {
    rows.sort((a, b) => a.position - b.position);
    const calls = new Set<string>();
    const ids = new Set<string>();
    rows.forEach(({ position, message }, index) => {
      if (bytes(message) > limits.historyMessageBytes)
        throw new HttpError(413, 'backup_too_large');
      if (position !== index || (message.id && ids.has(message.id)))
        invalid('backup_association');
      if (message.id) ids.add(message.id);
      for (const call of message.toolCalls ?? []) {
        if (message.role !== 'assistant' || calls.has(call.id))
          invalid('backup_association');
        calls.add(call.id);
      }
      if (
        message.role === 'tool' &&
        (!message.toolCallId || !calls.has(message.toolCallId))
      )
        invalid('backup_association');
    });
  }
  for (const run of data.runs)
    if (
      !threads.has(run.threadId) ||
      (run.parentRunId &&
        (!runs.has(run.parentRunId) || run.parentRunId === run.id))
    )
      invalid('backup_association');
  for (const interrupt of data.interrupts)
    if (runs.get(interrupt.runId)?.threadId !== interrupt.threadId)
      invalid('backup_association');
  for (const draft of data.drafts) {
    if (
      !threads.has(draft.threadId) ||
      draft.baseCurrency !== settings.primaryCurrency
    )
      invalid('backup_association');
    unique(draft.items, (item) => item.id);
    let total = 0;
    let ready = true;
    for (const item of draft.items) {
      if (categories.get(item.categoryId)?.kind !== item.kind)
        invalid('backup_association');
      const original =
        item.amount && item.currency
          ? amountMinor(item.amount, item.currency)
          : null;
      if (
        original !== item.originalMinor ||
        (item.baseMinor !== null && original === null)
      )
        invalid('backup_money');
      if (
        (item.currency === settings.primaryCurrency && item.conversion) ||
        (item.snapshot && (original === null || item.baseMinor === null)) ||
        (item.currency &&
          item.currency !== settings.primaryCurrency &&
          !item.conversion &&
          (item.snapshot || item.baseMinor !== null))
      )
        invalid('backup_money');
      if (item.currency && original !== null && item.conversion) {
        if (item.baseMinor === null || !item.snapshot) invalid('backup_money');
        if (item.conversion.actualAmount !== undefined) {
          if (
            item.snapshot.method !== 'actual' ||
            amountMinor(
              item.conversion.actualAmount,
              settings.primaryCurrency
            ) !== item.baseMinor
          )
            invalid('backup_money');
        } else if (item.conversion.quoteId) {
          if (item.snapshot.method !== 'reference') invalid('backup_money');
        } else if (
          item.snapshot.method !== 'manual_rate' ||
          item.snapshot.rate !== item.conversion.rate ||
          item.snapshot.quoteDate !== (item.conversion.quoteDate ?? item.date)
        )
          invalid('backup_money');
      }
      const missing = [
        ...(!item.amount ? ['amount'] : []),
        ...(!item.currency ? ['currency'] : []),
        ...(item.currency &&
        item.currency !== settings.primaryCurrency &&
        !item.conversion
          ? ['conversion']
          : []),
      ];
      if (
        new Set(item.missing).size !== missing.length ||
        !missing.every((field) =>
          item.missing.includes(field as 'amount' | 'currency' | 'conversion')
        )
      )
        invalid();
      if (item.currency && original !== null && item.baseMinor !== null)
        checkConversion(
          {
            ...item,
            currency: item.currency,
            originalMinor: original,
            baseMinor: item.baseMinor,
            conversion: item.snapshot,
          },
          settings.primaryCurrency
        );
      if (item.baseMinor === null || item.missing.length) ready = false;
      total += item.baseMinor ?? 0;
    }
    if (
      !Number.isSafeInteger(total) ||
      draft.totalBaseMinor !== (ready ? total : null) ||
      (draft.status === 'ready' && !ready) ||
      (draft.status === 'needs_details' && ready)
    )
      invalid('backup_money');
  }
  // Canonical order binds retries and the sealed dataset to the same business content.
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    data[key].sort((a, b) => {
      const left =
        'id' in a
          ? a.id
          : 'refundId' in a
            ? a.refundId
            : 'entryId' in a
              ? `${a.entryId}:${a.tagId}`
              : `${a.threadId}:${String(a.position).padStart(8, '0')}`;
      const right =
        'id' in b
          ? b.id
          : 'refundId' in b
            ? b.refundId
            : 'entryId' in b
              ? `${b.entryId}:${b.tagId}`
              : `${b.threadId}:${String(b.position).padStart(8, '0')}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }
  return value;
}
