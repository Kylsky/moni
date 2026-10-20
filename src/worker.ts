import { reconstructChat } from '@tanstack/ai-persistence';
import { z } from 'zod';
import { chatInput, probeInput } from './chat-do';
import {
  cancelConversation,
  cancelConversationInput,
  conversationAction,
  createConversation,
  deleteConversation,
  queryConversations,
  readConversation,
  readConversationRun,
} from './ledger/conversations';
import {
  cancelDraft,
  confirmDraft,
  queryDrafts,
  saveDraft,
} from './ledger/drafts';
import { saveEntry } from './ledger/entries';
import { entryFilters, queryEntries, readEntries } from './ledger/entry-query';
import { exportBackup, exportCsv, exportResponse } from './ledger/exports';
import { readPostingPolicy, savePostingPolicy } from './ledger/posting-policy';
import { previewQuote } from './ledger/rates';
import { readRefunds, saveRefund } from './ledger/refunds';
import { queryReport } from './ledger/reports';
import { cancelRestore, prepareRestore } from './ledger/restore';
import {
  abortRestoreSession,
  beginRestoreSession,
  cleanRetiredRestore,
  commitRestoreSession,
  currentRestoreSession,
  downloadCurrentBackup,
} from './ledger/restore-session';
import { readSettings, saveSettings } from './ledger/settings';
import {
  addTag,
  mergeTagRecords,
  readCategories,
  readTaxonomy,
  saveCategory,
} from './ledger/taxonomy';
import { type EntryTransition, transitionEntry } from './ledger/trash';
import { AccessError, verifyAccess } from './lib/access';
import {
  aiConfiguration,
  clearAiSettings,
  readAiSettings,
  saveAiSettings,
  testAiSettings,
} from './lib/ai-settings';
import { chatPersistence } from './lib/chat-persistence';
import { HttpError, privateResponse, readJson } from './lib/http';
import { limits } from './lib/limits';
import { wechatConfigured } from './lib/wechat-api';
import type { WechatAction } from './wechat-do';

export { Conversation } from './chat-do';
export { WechatBot } from './wechat-do';

export async function handlePrivateApi(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    await verifyAccess(request, env);
    const url = new URL(request.url);
    if (url.pathname === '/api/ai' || url.pathname === '/api/ai/test') {
      if (url.pathname === '/api/ai/test' && request.method === 'POST')
        return privateResponse(
          Response.json(await testAiSettings(env, await readJson(request)))
        );
      if (url.pathname === '/api/ai') {
        if (request.method === 'GET')
          return privateResponse(Response.json(await readAiSettings(env)));
        if (request.method === 'PUT')
          return privateResponse(
            Response.json(await saveAiSettings(env, await readJson(request)))
          );
        if (request.method === 'DELETE')
          return privateResponse(
            Response.json(await clearAiSettings(env, await readJson(request)))
          );
      }
      throw new HttpError(405, 'method_not_allowed');
    }
    if (url.pathname === '/api/posting-policy') {
      if (request.method === 'GET')
        return privateResponse(Response.json(await readPostingPolicy(env.DB)));
      if (request.method === 'POST')
        return privateResponse(
          Response.json(
            await savePostingPolicy(env.DB, await readJson(request))
          )
        );
      throw new HttpError(405, 'method_not_allowed');
    }
    if (
      url.pathname === '/api/wechat' ||
      url.pathname.startsWith('/api/wechat/')
    ) {
      let action: WechatAction;
      if (url.pathname === '/api/wechat' && request.method === 'GET')
        action = { action: 'status' };
      else {
        if (request.method !== 'POST')
          throw new HttpError(405, 'method_not_allowed');
        const common = z.object({ datasetId: z.string().min(1).max(100) });
        const body = await readJson(request);
        if (url.pathname === '/api/wechat/connect') {
          const input = common
            .extend({ locale: z.enum(['zh', 'en']) })
            .strict()
            .safeParse(body);
          if (!input.success) throw new HttpError(400, 'invalid_wechat_action');
          action = { action: 'connect', ...input.data, origin: url.origin };
        } else if (url.pathname === '/api/wechat/check') {
          const input = common
            .extend({
              loginId: z.uuid(),
              verifyCode: z
                .string()
                .regex(/^\d{3,12}$/)
                .optional(),
            })
            .strict()
            .safeParse(body);
          if (!input.success) throw new HttpError(400, 'invalid_wechat_action');
          action = { action: 'check', ...input.data };
        } else if (url.pathname === '/api/wechat/disconnect') {
          const input = common
            .extend({ confirmed: z.literal(true) })
            .strict()
            .safeParse(body);
          if (!input.success) throw new HttpError(400, 'invalid_wechat_action');
          if ((await readSettings(env.DB)).datasetId !== input.data.datasetId)
            throw new HttpError(409, 'dataset_changed');
          action = { action: 'disconnect' };
        } else if (url.pathname === '/api/wechat/new-thread') {
          const input = common
            .extend({ id: z.uuid(), confirmed: z.literal(true) })
            .strict()
            .safeParse(body);
          if (!input.success) throw new HttpError(400, 'invalid_wechat_action');
          action = {
            action: 'newThread',
            datasetId: input.data.datasetId,
            id: input.data.id,
          };
        } else throw new HttpError(404, 'not_found');
      }
      if (!wechatConfigured(env)) {
        if (action.action === 'status')
          return privateResponse(
            Response.json({ configured: false, phase: 'unconfigured' })
          );
        if (action.action !== 'disconnect')
          throw new HttpError(503, 'wechat_not_configured');
      }
      const result = await env.WECHAT.getByName('owner').handle(action);
      if (!result.ok) throw new HttpError(result.status, result.error);
      return privateResponse(Response.json(result.value));
    }
    if (
      !url.pathname.startsWith('/api/restores/') &&
      (request.method === 'GET' || url.pathname.endsWith('/query'))
    ) {
      try {
        await cleanRetiredRestore(env.DB);
      } catch {
        console.warn('Retired ledger cleanup deferred');
      }
    }
    if (url.pathname === '/api/restores/current' && request.method === 'GET')
      return privateResponse(
        Response.json(await currentRestoreSession(env.DB))
      );
    if (url.pathname === '/api/restores/begin' && request.method === 'POST') {
      const result = await beginRestoreSession(env.DB, await readJson(request));
      await Promise.allSettled(
        result.cancellationTargets.map(async ({ threadId, runId }) =>
          env.CONVERSATIONS.getByName(
            `${result.datasetId}:${threadId}`
          ).cancelRun(result.datasetId, threadId, runId)
        )
      );
      return privateResponse(Response.json(result.session));
    }
    if (
      url.pathname === '/api/restores/current-backup' &&
      request.method === 'POST'
    )
      return privateResponse(
        await downloadCurrentBackup(env.DB, await readJson(request))
      );
    if (url.pathname === '/api/restores/abort' && request.method === 'POST')
      return privateResponse(
        Response.json(
          await abortRestoreSession(env.DB, await readJson(request))
        )
      );
    if (url.pathname === '/api/restores/commit' && request.method === 'POST')
      return privateResponse(
        Response.json(
          await commitRestoreSession(env.DB, await readJson(request))
        )
      );
    if (url.pathname === '/api/restores/prepare' && request.method === 'POST')
      return privateResponse(
        Response.json(
          await prepareRestore(
            env.DB,
            await readJson(request, limits.backupBytes + limits.requestBytes)
          )
        )
      );
    if (url.pathname === '/api/restores/cancel' && request.method === 'POST')
      return privateResponse(
        Response.json(await cancelRestore(env.DB, await readJson(request)))
      );
    if (url.pathname === '/api/exports/backup' && request.method === 'GET') {
      const datasetId = url.searchParams.get('datasetId');
      if (!datasetId || datasetId.length > 100)
        throw new HttpError(400, 'invalid_dataset');
      const result = await exportBackup(env.DB);
      if (result.datasetId !== datasetId)
        throw new HttpError(409, 'dataset_changed');
      return privateResponse(exportResponse(result, 'json'));
    }
    if (url.pathname === '/api/exports/csv' && request.method === 'POST') {
      const input = z
        .object({
          datasetId: z.string().min(1).max(100),
          filters: entryFilters,
        })
        .strict()
        .safeParse(await readJson(request));
      if (!input.success) throw new HttpError(400, 'invalid_export');
      const result = await exportCsv(env.DB, input.data.filters);
      if (result.datasetId !== input.data.datasetId)
        throw new HttpError(409, 'dataset_changed');
      return privateResponse(exportResponse(result, 'csv'));
    }
    if (url.pathname === '/api/drafts' && request.method === 'GET')
      return privateResponse(
        Response.json(
          await queryDrafts(env.DB, url.searchParams.get('threadId') ?? '')
        )
      );
    if (url.pathname === '/api/drafts/save' && request.method === 'POST')
      return privateResponse(
        Response.json(await saveDraft(env.DB, await readJson(request)))
      );
    if (url.pathname === '/api/drafts/confirm' && request.method === 'POST')
      return privateResponse(
        Response.json(await confirmDraft(env.DB, await readJson(request)))
      );
    if (url.pathname === '/api/drafts/cancel' && request.method === 'POST')
      return privateResponse(
        Response.json(await cancelDraft(env.DB, await readJson(request)))
      );
    if (
      url.pathname === '/api/conversations/query' &&
      request.method === 'POST'
    )
      return privateResponse(
        Response.json(await queryConversations(env.DB, await readJson(request)))
      );
    if (
      url.pathname === '/api/conversations/delete' &&
      request.method === 'POST'
    ) {
      const parsed = conversationAction.safeParse(await readJson(request));
      if (!parsed.success)
        throw new HttpError(400, 'invalid_conversation_action');
      const result = await deleteConversation(env.DB, parsed.data);
      try {
        await env.CONVERSATIONS.getByName(
          `${parsed.data.datasetId}:${parsed.data.id}`
        ).cancelRun(parsed.data.datasetId, parsed.data.id);
      } catch {
        /* D1 already revoked the permission; notification is best effort. */
      }
      return privateResponse(Response.json(result));
    }
    if (
      url.pathname === '/api/conversations/cancel' &&
      request.method === 'POST'
    ) {
      const parsed = cancelConversationInput.safeParse(await readJson(request));
      if (!parsed.success)
        throw new HttpError(400, 'invalid_conversation_action');
      const result = await cancelConversation(env.DB, parsed.data);
      try {
        await env.CONVERSATIONS.getByName(
          `${parsed.data.datasetId}:${parsed.data.id}`
        ).cancelRun(parsed.data.datasetId, parsed.data.id, parsed.data.runId);
      } catch {
        /* The persisted cancellation fences late writes even if notification fails. */
      }
      return privateResponse(Response.json(result));
    }
    if (url.pathname === '/api/conversations' && request.method === 'POST')
      return privateResponse(
        Response.json(await createConversation(env.DB, await readJson(request)))
      );
    const conversationPath = /^\/api\/conversations\/([^/]+)$/.exec(
      url.pathname
    );
    if (conversationPath && request.method === 'GET') {
      const id = z.uuid().safeParse(conversationPath[1]);
      if (!id.success) throw new HttpError(400, 'invalid_thread');
      return privateResponse(
        Response.json(await readConversation(env.DB, id.data))
      );
    }
    if (url.pathname === '/api/reports/query' && request.method === 'POST')
      return privateResponse(
        Response.json(await queryReport(env.DB, await readJson(request)))
      );
    if (url.pathname === '/api/refunds' && request.method === 'GET') {
      const expenseId = z.uuid().safeParse(url.searchParams.get('expenseId'));
      const page = z.coerce
        .number()
        .int()
        .min(1)
        .max(5000)
        .safeParse(url.searchParams.get('page') ?? 1);
      if (!expenseId.success || !page.success)
        throw new HttpError(400, 'invalid_refund_query');
      return privateResponse(
        Response.json(await readRefunds(env.DB, expenseId.data, page.data))
      );
    }
    if (
      url.pathname === '/api/refunds' &&
      ['POST', 'PUT'].includes(request.method)
    )
      return privateResponse(
        Response.json(
          await saveRefund(
            env.DB,
            await readJson(request),
            request.method === 'PUT'
          )
        )
      );
    if (url.pathname === '/api/rates/preview' && request.method === 'POST')
      return privateResponse(
        Response.json(await previewQuote(env.DB, await readJson(request)))
      );
    const entryAction = /^\/api\/entries\/(delete|restore|purge)$/.exec(
      url.pathname
    )?.[1] as EntryTransition | undefined;
    if (entryAction && request.method === 'POST')
      return privateResponse(
        Response.json(
          await transitionEntry(env.DB, await readJson(request), entryAction)
        )
      );
    if (url.pathname === '/api/trash/query' && request.method === 'POST')
      return privateResponse(
        Response.json(
          await queryEntries(env.DB, await readJson(request), undefined, true)
        )
      );
    if (url.pathname === '/api/taxonomy' && request.method === 'GET')
      return privateResponse(Response.json(await readTaxonomy(env.DB)));
    if (
      url.pathname === '/api/categories' &&
      ['POST', 'PUT'].includes(request.method)
    )
      return privateResponse(
        Response.json(
          await saveCategory(
            env.DB,
            await readJson(request),
            request.method === 'PUT'
          )
        )
      );
    if (url.pathname === '/api/tags' && request.method === 'POST')
      return privateResponse(
        Response.json(await addTag(env.DB, await readJson(request)))
      );
    if (url.pathname === '/api/tags/merge' && request.method === 'POST')
      return privateResponse(
        Response.json(await mergeTagRecords(env.DB, await readJson(request)))
      );
    if (url.pathname === '/api/categories' && request.method === 'GET')
      return privateResponse(Response.json(await readCategories(env.DB)));
    if (url.pathname === '/api/entries/query' && request.method === 'POST')
      return privateResponse(
        Response.json(await queryEntries(env.DB, await readJson(request)))
      );
    if (url.pathname === '/api/entries' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      if (id !== null && !z.uuid().safeParse(id).success)
        throw new HttpError(400, 'invalid_entry_id');
      const entries = await readEntries(env.DB, id ?? undefined);
      if (id && !entries.length) throw new HttpError(404, 'entry_not_found');
      return privateResponse(Response.json(entries));
    }
    if (
      url.pathname === '/api/entries' &&
      ['POST', 'PUT'].includes(request.method)
    )
      return privateResponse(
        Response.json(
          await saveEntry(
            env.DB,
            await readJson(request),
            request.method === 'PUT'
          )
        )
      );
    if (url.pathname === '/api/settings' && request.method === 'GET')
      return privateResponse(
        Response.json({
          ...(await readSettings(env.DB)),
          aiConfigured: Boolean(await aiConfiguration(env)),
          postingMode: (await readPostingPolicy(env.DB)).mode,
        })
      );
    if (
      (url.pathname === '/api/initialize' && request.method === 'POST') ||
      (url.pathname === '/api/settings' && request.method === 'PUT')
    )
      return privateResponse(
        Response.json(
          await saveSettings(
            env.DB,
            await readJson(request),
            url.pathname === '/api/initialize'
          )
        )
      );
    if (url.pathname === '/api/status' && request.method === 'GET') {
      const state = await env.DB.prepare(
        'SELECT active_dataset FROM moni_state WHERE singleton = 1'
      ).first<{ active_dataset: string }>();
      if (!state) throw new HttpError(503, 'storage_not_ready');
      return privateResponse(
        Response.json({
          aiConfigured: Boolean(await aiConfiguration(env)),
          datasetId: state.active_dataset,
        })
      );
    }
    if (!['/api/probe', '/api/chat'].includes(url.pathname))
      throw new HttpError(404, 'not_found');
    const formal = url.pathname === '/api/chat';
    if (request.method === 'GET') {
      const thread = z.uuid().safeParse(url.searchParams.get('threadId'));
      if (!thread.success) throw new HttpError(400, 'invalid_thread');
      if (formal) {
        const conversation = await readConversation(env.DB, thread.data);
        const coordination = await env.CONVERSATIONS.getByName(
          `${conversation.datasetId}:${thread.data}`
        ).reconcile(conversation.datasetId, thread.data);
        const before = await env.DB.prepare(
          'SELECT revision FROM moni_state WHERE singleton = 1 AND active_dataset = ?'
        )
          .bind(conversation.datasetId)
          .first<number>('revision');
        const historyUrl = new URL(request.url);
        const requestedLimit = historyUrl.searchParams.get('limit');
        if (
          requestedLimit !== null &&
          (!Number.isInteger(Number(requestedLimit)) ||
            Number(requestedLimit) < 1 ||
            Number(requestedLimit) > 200)
        )
          throw new HttpError(400, 'invalid_history_page');
        if ((historyUrl.searchParams.get('before')?.length ?? 0) > 2048)
          throw new HttpError(400, 'invalid_history_cursor');
        if (!historyUrl.searchParams.has('limit'))
          historyUrl.searchParams.set(
            'limit',
            String(limits.historyPageMessages)
          );
        const response = await reconstructChat(
          chatPersistence(env.DB, conversation.datasetId),
          new Request(historyUrl, request),
          {
            authorize: async (id) => id === conversation.id,
            includeRuns: true,
          }
        );
        if (!response.ok) return privateResponse(response);
        const restored = await response.json();
        const latestRun = await readConversationRun(
          env.DB,
          conversation.datasetId,
          thread.data
        );
        const current = await readConversation(env.DB, thread.data);
        const after = await env.DB.prepare(
          'SELECT revision FROM moni_state WHERE singleton = 1 AND active_dataset = ?'
        )
          .bind(conversation.datasetId)
          .first<number>('revision');
        if (
          current.datasetId !== conversation.datasetId ||
          current.version !== conversation.version ||
          before === null ||
          before !== after
        )
          throw new HttpError(409, 'conversation_changed');
        return privateResponse(
          Response.json({
            ...(restored as object),
            conversation: current,
            latestRun,
            coordinationBusy: coordination.busy,
          })
        );
      }
      const state = await env.DB.prepare(
        'SELECT active_dataset FROM moni_state WHERE singleton = 1'
      ).first<{ active_dataset: string }>();
      if (!state) throw new HttpError(503, 'storage_not_ready');
      return privateResponse(
        await reconstructChat(
          chatPersistence(env.DB, state.active_dataset),
          request,
          {
            authorize: async () => true,
          }
        )
      );
    }
    if (request.method !== 'POST')
      throw new HttpError(405, 'method_not_allowed');
    const raw = await readJson(request);
    const input = formal ? chatInput.safeParse(raw) : probeInput.safeParse(raw);
    if (!input.success) throw new HttpError(400, 'invalid_input');
    const state = await env.DB.prepare(
      'SELECT active_dataset FROM moni_state WHERE singleton = 1'
    ).first<{ active_dataset: string }>();
    if (!state) throw new HttpError(503, 'storage_not_ready');
    if (input.data.datasetId !== state.active_dataset)
      throw new HttpError(409, 'dataset_changed');
    const stub = env.CONVERSATIONS.getByName(
      `${state.active_dataset}:${input.data.threadId}`
    );
    const forwarded = new Request(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input.data),
      signal: request.signal,
    });
    return privateResponse(await stub.fetch(forwarded));
  } catch (error) {
    if (error instanceof AccessError || error instanceof HttpError)
      return privateResponse(
        Response.json({ error: error.code }, { status: error.status })
      );
    return privateResponse(
      Response.json({ error: 'request_failed' }, { status: 500 })
    );
  }
}
