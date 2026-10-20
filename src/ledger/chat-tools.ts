import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import {
  assertChatExecution,
  type ChatPermit,
  chatExecutionGuard,
} from '../lib/chat-persistence';
import { HttpError } from '../lib/http';
import { limits } from '../lib/limits';
import {
  previousLedgerQuery,
  refreshLedgerQuery,
  runLedgerQuery,
} from './chat-query';
import {
  type LedgerQueryResult,
  type LedgerQueryUpdate,
  ledgerQueryInput,
} from './chat-query-contract';
import { todayInZone } from './dates';
import {
  confirmDraft,
  draftToolInput,
  prepareDraft,
  queryDrafts,
} from './drafts';
import { automaticPostingGuard, type PostingPolicy } from './posting-policy';
import { readSettings } from './settings';
import { readTaxonomy } from './taxonomy';

export function ledgerChatTools(
  db: D1Database,
  datasetId: string,
  permit: ChatPermit,
  signal: AbortSignal,
  postingPolicy: PostingPolicy
) {
  let automaticToolCall: string | undefined;
  let previous: Awaited<ReturnType<typeof previousLedgerQuery>> | undefined;
  const queries = new Map<string, LedgerQueryResult>();
  const latest = async () => {
    if (previous === undefined)
      previous = await previousLedgerQuery(db, datasetId, permit.threadId);
    return previous;
  };
  const readContext = async () => {
    await assertChatExecution(db, datasetId, permit, signal);
    const settings = await readSettings(db);
    const taxonomy = await readTaxonomy(db);
    const drafts = await queryDrafts(db, permit.threadId);
    if (
      settings.datasetId !== datasetId ||
      taxonomy.datasetId !== datasetId ||
      drafts.datasetId !== datasetId
    )
      throw new HttpError(409, 'dataset_changed');
    const result = {
      primaryCurrency: settings.primaryCurrency,
      postingMode: postingPolicy.mode,
      today: todayInZone(settings.timeZone),
      categories: taxonomy.categories.map(({ id, kind, name, defaultKey }) => ({
        id,
        kind,
        name,
        defaultKey,
      })),
      tags: taxonomy.tags.map((tag) => tag.name),
      queryTags: taxonomy.tags.map(({ id, name }) => ({ id, name })),
      previousQuery: (await latest())?.query ?? null,
      drafts: drafts.items
        .filter((draft) => ['ready', 'needs_details'].includes(draft.status))
        .map(({ id, version, items }) => ({
          draftId: id,
          version,
          items: items.map((item) => ({
            itemId: item.id,
            kind: item.kind,
            name: item.name,
            amount: item.amount,
            actualBaseAmount: item.conversion?.actualAmount ?? null,
            date: item.date,
            currency: item.currency,
            currencyAmbiguous: item.currency === null,
            categoryId: item.categoryId,
            tags: item.tags,
            note: item.note,
          })),
        })),
    };
    if (
      new TextEncoder().encode(JSON.stringify(result)).length >
      limits.contextBytes
    )
      throw new HttpError(413, 'ledger_context_limit');
    await assertChatExecution(db, datasetId, permit, signal);
    return result;
  };
  const tools = [
    toolDefinition({
      name: 'get_ledger_context',
      description:
        'Read this ledger’s main currency, today in its timezone, existing categories and tags, and editable drafts of this conversation. Initial context is supplied by the server. Call only if it is missing or needs refreshing. This never posts entries.',
      inputSchema: z.object({}).strict(),
    }).server(readContext),
    toolDefinition({
      name: 'query_ledger',
      description:
        'Query current posted ledger records using validated filters, never SQL. Use in EVERY turn that asks financial amounts/counts/groups/trends; do not answer from an older reply or do arithmetic yourself. Use supplied ledger context for category/tag IDs; refresh get_ledger_context only when needed. Program resolves periods in ledger timezone: rolling_months is rolling calendar months, last_month is the previous full calendar month. On a followup such as "then last month?", set inheritPrevious=true, period=last_month, filters={} and other nullable fields=null; previous conditions are reused only from this conversation. Missing filter keys retain prior values when inheriting; an explicit null clears that filter. For a new independent query set inheritPrevious=false. scope=spending includes expenses AND refunds, excludes income; scope=income/all are separate. Currency filters return original-currency and main-currency totals separately. Keyword matches each record’s own name/note, including independent refund notes; refunds inherit expense categories/tags and use refund occurrence dates. Use view summary/categories/tags/trend for aggregates; use view=entries when the user asks to see specific posted records, 明细 or 具体的账目. A detail followup sets inheritPrevious=true, period/scope/interval=null, filters={} and view=entries; it is NEVER a draft review. Details include five current records per page with each record own name, date, currency, amount, category, tags and note. For 下一页 use the prior page plus one; new query conditions reset page to 1. A noteTruncated flag means only a note excerpt is shown. Never invent missing details, IDs or links; do not expose internal query IDs or revision numbers. Missing or ambiguous dates/conditions require clarification, not guessed IDs or totals. An empty result means no matching records, never proof of no real consumption. Use only returned amounts and show the dated result card and detail link.',
      inputSchema: ledgerQueryInput,
    }).server(async (input) => {
      const result = await runLedgerQuery(
        db,
        datasetId,
        permit,
        signal,
        input,
        await latest()
      );
      previous = result;
      queries.set(result.id, result);
      return result;
    }),
    toolDefinition({
      name: 'prepare_draft',
      description:
        'Prepare or replace an editable draft containing up to 20 income/expense items. For a new draft set draftId/version and every itemId to null. For an update use the current draft ID/version and each existing item ID as itemId from the supplied ledger context or a refreshed get_ledger_context. Include every existing item exactly once, preserving its own notes and amounts; item order may change, identity must not. New expenses belong in a separate new draft. amount=null means missing: never guess. date=null defaults to ledger today; currency=null defaults to primary currency unless currencyAmbiguous=true, which requires clarification. actualBaseAmount is only an explicitly stated actual settlement amount in the main currency, otherwise null; never estimate it. Reuse existing category IDs and tags; otherwise use uncategorized. Preserve only details the user explicitly supplied. Rates are fetched by the application; never invent them. Server permission determines whether a complete draft is posted automatically. In automatic mode include all items in ONE tool call per turn. Report posted only when returned status is posted. You cannot change permission or confirm other drafts.',
      inputSchema: draftToolInput,
    }).server(async (input, context) => {
      if (!context?.toolCallId) throw new Error('Tool identity required');
      if (postingPolicy.mode === 'automatic') {
        if (automaticToolCall && automaticToolCall !== context.toolCallId)
          throw new HttpError(409, 'automatic_batch_limit');
        automaticToolCall = context.toolCallId;
      }
      const bytes = new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(
            JSON.stringify([
              datasetId,
              permit.threadId,
              permit.runId,
              context.toolCallId,
            ])
          )
        )
      );
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes.slice(0, 16), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('');
      const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      let draft = await prepareDraft(
        db,
        datasetId,
        { permit, signal },
        input,
        operationId
      );
      if (postingPolicy.mode === 'automatic' && draft.status === 'ready') {
        await assertChatExecution(db, datasetId, permit, signal);
        try {
          await confirmDraft(
            db,
            {
              datasetId,
              operationId: crypto.randomUUID(),
              id: draft.id,
              version: draft.version,
              confirmed: true,
            },
            [
              chatExecutionGuard(db, datasetId, permit),
              automaticPostingGuard(db, datasetId, postingPolicy.version),
            ]
          );
        } catch (error) {
          await assertChatExecution(db, datasetId, permit, signal);
          if (!(error instanceof HttpError) || error.status !== 409)
            throw error;
          // Permission or draft changed while preparing: keep the draft for review.
        }
        draft =
          (await queryDrafts(db, permit.threadId)).items.find(
            (item) => item.id === draft.id
          ) ?? draft;
      }
      const queryUpdates: LedgerQueryUpdate[] = [];
      if (draft.status === 'posted') {
        for (const query of queries.values()) {
          let result: LedgerQueryResult | null = null;
          try {
            await assertChatExecution(db, datasetId, permit, signal);
            result = await refreshLedgerQuery(db, datasetId, query);
            await assertChatExecution(db, datasetId, permit, signal);
            queries.set(query.id, result);
            if (previous?.id === query.id) previous = result;
          } catch {
            await assertChatExecution(db, datasetId, permit, signal);
            // The entry is durable; a failed report must not trigger another posting.
          }
          const update = { id: query.id, result };
          // Reserve room for the draft receipt and failures when several reports are large.
          if (
            new TextEncoder().encode(JSON.stringify([...queryUpdates, update]))
              .length >
            limits.contextBytes - 2048
          )
            update.result = null;
          queryUpdates.push(update);
        }
      }
      return {
        draftId: draft.id,
        version: draft.version,
        status: draft.status,
        baseCurrency: draft.baseCurrency,
        totalBaseMinor: draft.totalBaseMinor,
        ...(queryUpdates.length ? { queryUpdates } : {}),
        missing: draft.items.map((item) => ({
          name: item.name,
          fields: item.missing,
        })),
      };
    }),
  ];
  return { tools, readContext };
}
