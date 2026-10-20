import { DurableObject } from 'cloudflare:workers';
import type { ModelMessage } from '@tanstack/ai';
import { z } from 'zod';
import { previousLedgerQuery, refreshLedgerQuery } from './ledger/chat-query';
import {
  type LedgerQueryResult,
  parseQueryUpdates,
} from './ledger/chat-query-contract';
import { readConversation } from './ledger/conversations';
import { readRunDraftIds } from './ledger/draft-outcomes';
import {
  confirmDraftReview,
  pendingDrafts,
  planDraftReview,
  reviewContext,
} from './ledger/draft-review';
import { draftReviewSummary } from './ledger/draft-review-summary';
import { type Draft, queryDrafts } from './ledger/drafts';
import { displayMoney } from './ledger/money';
import { lastQueryDetails } from './ledger/query-fallback';
import { readSettings } from './ledger/settings';
import { readTaxonomy } from './ledger/taxonomy';
import { aiConfiguration } from './lib/ai-settings';
import { categoryLabel } from './lib/category-label';
import { chatPersistence } from './lib/chat-persistence';
import { assertChanged, executeCommand } from './lib/command';
import {
  type ConfirmationIntent,
  conversationIntent,
} from './lib/conversation-intent';
import { HttpError } from './lib/http';
import { limits } from './lib/limits';
import { type AppLocale, message } from './lib/locale';
import {
  loginResponse,
  openWechat,
  qrResponse,
  safeWechatOrigin,
  sealWechat,
  updatesResponse,
  wechatApi,
  wechatConfigured,
  wechatMessage,
  wechatOrigin,
} from './lib/wechat-api';
import { markdownText, wechatStatistics } from './lib/wechat-format';

type Phase =
  | 'disconnected'
  | 'waiting'
  | 'scanned'
  | 'verify'
  | 'binding'
  | 'connected'
  | 'expired'
  | 'reconnect'
  | 'thread_deleted';
type Credentials = {
  token: string;
  botId: string;
  userId: string;
  apiOrigin: string;
};
type Login = {
  qrcode: string;
  content: string;
  apiOrigin: string;
  redirects: number;
};
type State = {
  phase: Phase;
  epoch: string;
  datasetId: string;
  threadId: string;
  origin: string;
  locale: AppLocale;
  expiresAt: number;
  auth?: string;
  qr?: string;
  lastError?: string;
  lastPollAt?: number;
};
type Delivery = {
  runId: string;
  threadId: string;
  context: string;
  userId: string;
  text: string;
  locale: AppLocale;
  createdAt: number;
  sentAt?: number;
  reply?: string;
  replyId?: string;
  review?: Confirmation;
  reviewOperationId?: string;
  confirmationIntent?: ConfirmationIntent;
  attempts: number;
};
type Confirmation = {
  epoch: string;
  threadId: string;
  draftId: string;
  version: number;
  drafts?: { id: string; version: number }[];
  excludedDraftIds?: string[];
  operationId: string;
  shown: boolean;
  shownAt?: number;
};
export type WechatStatus = {
  configured: boolean;
  phase: Phase | 'unconfigured';
  loginId?: string;
  qrContent?: string;
  threadId?: string;
  lastError?: string;
  lastPollAt?: number;
};
export type WechatAction =
  | { action: 'status' }
  | { action: 'connect'; datasetId: string; origin: string; locale: AppLocale }
  | { action: 'check'; datasetId: string; loginId: string; verifyCode?: string }
  | { action: 'disconnect' }
  | { action: 'newThread'; datasetId: string; id: string };

export class WechatBot extends DurableObject<Env> {
  async handle(input: WechatAction) {
    try {
      const value =
        input.action === 'status'
          ? await this.status()
          : input.action === 'connect'
            ? await this.beginLogin(input.datasetId, input.origin, input.locale)
            : input.action === 'check'
              ? await this.check(
                  input.datasetId,
                  input.loginId,
                  input.verifyCode
                )
              : input.action === 'newThread'
                ? await this.newThread(input.datasetId, input.id)
                : await this.disconnect();
      return { ok: true as const, value };
    } catch (error) {
      return {
        ok: false as const,
        status: error instanceof HttpError ? error.status : 502,
        error: error instanceof HttpError ? error.code : 'wechat_unavailable',
      };
    }
  }
  async status(): Promise<WechatStatus> {
    if (!wechatConfigured(this.env))
      return { configured: false, phase: 'unconfigured' };
    const state = await this.ctx.storage.get<State>('state');
    if (!state) return { configured: true, phase: 'disconnected' };
    const settings = await readSettings(this.env.DB);
    if (state.datasetId !== settings.datasetId) {
      await this.revoke();
      return {
        configured: true,
        phase: 'reconnect',
        lastError: 'dataset_changed',
      };
    }
    if (
      state.qr &&
      state.expiresAt < Date.now() &&
      state.phase !== 'connected'
    ) {
      await this.ctx.storage.put('state', {
        ...state,
        phase: 'expired',
        qr: undefined,
      });
      return { configured: true, phase: 'expired' };
    }
    let phase = state.phase;
    let qrContent: string | undefined;
    if (state.qr) {
      try {
        qrContent = (await openWechat<Login>(this.env, state.qr)).content;
      } catch {
        await this.revoke();
        return { configured: true, phase: 'reconnect' };
      }
    }
    if (phase === 'connected') {
      try {
        await readConversation(this.env.DB, state.threadId);
      } catch (error) {
        if (
          !(error instanceof HttpError) ||
          error.code !== 'conversation_not_found'
        )
          throw error;
        phase = 'thread_deleted';
      }
    }
    return {
      configured: true,
      phase,
      ...(state.auth ? { threadId: state.threadId } : {}),
      ...(state.qr
        ? {
            loginId: state.epoch,
            qrContent,
          }
        : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      ...(state.lastPollAt ? { lastPollAt: state.lastPollAt } : {}),
    };
  }

  async beginLogin(datasetId: string, origin: string, locale: AppLocale) {
    if (!wechatConfigured(this.env))
      throw new HttpError(503, 'wechat_not_configured');
    const settings = await readSettings(this.env.DB);
    if (settings.datasetId !== datasetId)
      throw new HttpError(409, 'dataset_changed');
    if (!settings.initialized)
      throw new HttpError(409, 'ledger_not_initialized');
    const previous = await this.ctx.storage.get<State>('state');
    if (previous?.auth && previous.phase !== 'reconnect')
      throw new HttpError(409, 'wechat_already_connected');
    await this.revoke();
    const state: State = {
      phase: 'waiting',
      epoch: crypto.randomUUID(),
      threadId: crypto.randomUUID(),
      datasetId,
      origin: new URL(origin).origin,
      locale,
      expiresAt: Date.now() + 180000,
    };
    await this.ctx.storage.put('state', state);
    await this.env.DB.prepare(`INSERT INTO wechat_binding(singleton,epoch,dataset_id,thread_id,enabled) VALUES (1,?,?,?,0)
      ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch,dataset_id=excluded.dataset_id,thread_id=excluded.thread_id,enabled=0`)
      .bind(state.epoch, datasetId, state.threadId)
      .run();
    const qr = qrResponse.parse(
      await wechatApi(
        wechatOrigin,
        'get_bot_qrcode?bot_type=3',
        { local_token_list: [] },
        undefined,
        15000
      )
    );
    const sealed = await sealWechat(this.env, {
      qrcode: qr.qrcode,
      content: qr.qrcode_img_content,
      apiOrigin: wechatOrigin,
      redirects: 0,
    } satisfies Login);
    await this.update(state.epoch, { qr: sealed });
    return this.status();
  }

  async check(datasetId: string, loginId: string, verifyCode?: string) {
    const state = await this.ctx.storage.get<State>('state');
    if (
      !state ||
      state.datasetId !== datasetId ||
      state.epoch !== loginId ||
      (await readSettings(this.env.DB)).datasetId !== datasetId
    )
      throw new HttpError(409, 'wechat_login_expired');
    if (state.phase === 'connected') return this.status();
    if (state.phase === 'binding') {
      await this.finishBinding(state);
      return this.status();
    }
    if (!state.qr || state.expiresAt < Date.now())
      throw new HttpError(409, 'wechat_login_expired');
    const login = await openWechat<Login>(this.env, state.qr);
    const params = new URLSearchParams({ qrcode: login.qrcode });
    if (verifyCode) params.set('verify_code', verifyCode);
    const response = loginResponse.parse(
      await wechatApi(
        login.apiOrigin,
        `get_qrcode_status?${params}`,
        undefined,
        undefined,
        15000
      )
    );
    if (response.status === 'confirmed') {
      if (
        !response.bot_token ||
        !response.ilink_bot_id ||
        !response.ilink_user_id ||
        !response.baseurl
      )
        throw new HttpError(502, 'wechat_invalid_login');
      const auth = await sealWechat(this.env, {
        token: response.bot_token,
        botId: response.ilink_bot_id,
        userId: response.ilink_user_id,
        apiOrigin: safeWechatOrigin(response.baseurl),
      } satisfies Credentials);
      const claimed = await this.ctx.storage.transaction(async (storage) => {
        const current = await storage.get<State>('state');
        if (current?.epoch !== state.epoch || current.auth) return false;
        await storage.put('state', { ...current, phase: 'binding', auth });
        return true;
      });
      if (claimed)
        await this.finishBinding({ ...state, phase: 'binding', auth });
    } else if (response.status === 'scaned_but_redirect') {
      if (!response.redirect_host || login.redirects >= 3)
        throw new HttpError(502, 'wechat_invalid_redirect');
      await this.update(state.epoch, {
        qr: await sealWechat(this.env, {
          ...login,
          apiOrigin: safeWechatOrigin(response.redirect_host),
          redirects: login.redirects + 1,
        }),
      });
    } else {
      const phase: Phase =
        response.status === 'scaned'
          ? 'scanned'
          : response.status === 'need_verifycode'
            ? 'verify'
            : ['expired', 'verify_code_blocked', 'binded_redirect'].includes(
                  response.status
                )
              ? 'expired'
              : 'waiting';
      await this.update(state.epoch, {
        phase,
        ...(phase === 'expired' ? { qr: undefined } : {}),
      });
    }
    return this.status();
  }

  private async finishBinding(state: State) {
    await this.createThread(state, state.threadId, state.epoch);
    await this.env.DB.batch([
      this.env.DB.prepare(`UPDATE wechat_binding SET enabled=1 WHERE singleton=1 AND epoch=? AND dataset_id=?
        AND EXISTS(SELECT 1 FROM moni_state WHERE singleton=1 AND active_dataset=?)`).bind(
        state.epoch,
        state.datasetId,
        state.datasetId
      ),
      assertChanged(this.env.DB),
    ]);
    await this.update(state.epoch, {
      phase: 'connected',
      qr: undefined,
      lastError: undefined,
    });
    await this.ctx.storage.delete('confirmation');
    await this.schedule(state.epoch, 1000);
  }

  async disconnect() {
    await this.revoke();
    return this.status();
  }

  async newThread(datasetId: string, id: string) {
    const state = await this.ctx.storage.get<State>('state');
    if (
      !state?.auth ||
      state.datasetId !== datasetId ||
      !['connected', 'thread_deleted'].includes(state.phase)
    )
      throw new HttpError(409, 'wechat_not_connected');
    if (state.threadId === id) return this.status();
    await this.createThread(state, id, id);
    await this.stopThread(state);
    await this.env.DB.batch([
      this.env.DB.prepare(
        'UPDATE wechat_binding SET thread_id=? WHERE singleton=1 AND epoch=? AND enabled=1 AND dataset_id=?'
      ).bind(id, state.epoch, datasetId),
      assertChanged(this.env.DB),
    ]);
    await this.update(state.epoch, {
      threadId: id,
      phase: 'connected',
      lastError: undefined,
    });
    await this.ctx.storage.delete('confirmation');
    await this.schedule(state.epoch, 1000);
    return this.status();
  }

  private async createThread(state: State, id: string, operationId: string) {
    const now = Date.now();
    const input = { datasetId: state.datasetId, operationId, id };
    await executeCommand(
      this.env.DB,
      'wechat_conversation',
      input,
      [
        this.env.DB.prepare(
          "INSERT INTO conversations(dataset_id,id,title,source,created_at,updated_at) VALUES (?,?,'','wechat',?,?)"
        ).bind(state.datasetId, id, now, now),
        assertChanged(this.env.DB),
      ],
      { id }
    );
  }

  private async stopThread(state: State) {
    await this.env.DB.batch([
      this.env.DB.prepare(
        "UPDATE chat_runs SET status='aborted',finished_at=?,error='WeChat connection revoked',error_code='cancelled' WHERE dataset_id=? AND thread_id=? AND status='running'"
      ).bind(Date.now(), state.datasetId, state.threadId),
      this.env.DB.prepare(
        'UPDATE moni_state SET revision=revision+1 WHERE singleton=1 AND active_dataset=? AND changes()>0'
      ).bind(state.datasetId),
      this.env.DB.prepare(
        'DELETE FROM chat_permits WHERE dataset_id=? AND thread_id=?'
      ).bind(state.datasetId, state.threadId),
    ]);
    try {
      await this.env.CONVERSATIONS.getByName(
        `${state.datasetId}:${state.threadId}`
      ).cancelRun(state.datasetId, state.threadId);
    } catch {
      /* Persisted revocation fences any late tool execution. */
    }
  }

  private async revoke() {
    const state = await this.ctx.storage.get<State>('state');
    // Remove the channel authority before awaiting other objects.
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    if (state)
      await this.env.DB.prepare(
        'UPDATE wechat_binding SET enabled=0,epoch=? WHERE singleton=1 AND epoch=?'
      )
        .bind(crypto.randomUUID(), state.epoch)
        .run();
    if (state?.auth) await this.stopThread(state);
  }

  private async update(epoch: string, patch: Partial<State>) {
    return this.ctx.storage.transaction(async (storage) => {
      const state = await storage.get<State>('state');
      if (state?.epoch !== epoch)
        throw new HttpError(409, 'wechat_binding_changed');
      await storage.put('state', { ...state, ...patch });
    });
  }

  private async current(state: State, threadId = state.threadId) {
    const current = await this.ctx.storage.get<State>('state');
    if (
      current?.epoch !== state.epoch ||
      current.phase !== 'connected' ||
      current.threadId !== threadId
    )
      throw new HttpError(409, 'wechat_binding_changed');
    const settings = await readSettings(this.env.DB);
    if (settings.datasetId !== state.datasetId)
      throw new HttpError(409, 'dataset_changed');
    const root = await this.env.DB.prepare(
      'SELECT restore_expires_at FROM moni_state WHERE singleton=1'
    ).first<number>('restore_expires_at');
    if (root && root > Date.now()) throw new HttpError(423, 'restore_locked');
    await readConversation(this.env.DB, threadId);
  }

  private async schedule(epoch: string, delay: number) {
    const state = await this.ctx.storage.get<State>('state');
    if (state?.epoch === epoch && state.phase === 'connected')
      await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  async alarm() {
    const state = await this.ctx.storage.get<State>('state');
    if (!state || state.phase !== 'connected' || !state.auth) return;
    // A crash during network I/O leaves a persisted wake-up, never an in-memory loop.
    await this.schedule(state.epoch, 60000);
    try {
      await this.current(state);
      const auth = await openWechat<Credentials>(this.env, state.auth);
      const pending = await this.ctx.storage.list<string>({
        prefix: 'pending:',
        limit: 1,
      });
      const first = pending.entries().next().value;
      if (first)
        await this.deliver(
          state,
          auth,
          first[0],
          await openWechat<Delivery>(this.env, first[1])
        );
      else await this.receive(state, auth);
      await this.update(state.epoch, { lastError: undefined });
      await this.schedule(state.epoch, 1000);
    } catch (error) {
      const current = await this.ctx.storage.get<State>('state');
      if (current?.epoch !== state.epoch) return;
      const code =
        error instanceof HttpError ? error.code : 'wechat_unavailable';
      if (code === 'dataset_changed') {
        await this.revoke();
        return;
      }
      if (code === 'conversation_not_found') {
        await this.update(state.epoch, { phase: 'thread_deleted' });
        await this.ctx.storage.deleteAlarm();
        return;
      }
      if (code === 'wechat_reconnect_required') {
        await this.update(state.epoch, {
          phase: 'reconnect',
          auth: undefined,
          lastError: code,
        });
        await this.env.DB.prepare(
          'UPDATE wechat_binding SET enabled=0 WHERE singleton=1 AND epoch=?'
        )
          .bind(state.epoch)
          .run();
        await this.stopThread(state);
        await this.ctx.storage.deleteAlarm();
        return;
      }
      await this.update(state.epoch, { lastError: code });
      await this.schedule(
        state.epoch,
        code === 'restore_locked' ? 10000 : 30000
      );
    }
  }

  private async receive(state: State, auth: Credentials) {
    const cursor = (await this.ctx.storage.get<string>('cursor')) ?? '';
    const result = updatesResponse.parse(
      await wechatApi(
        auth.apiOrigin,
        'getupdates',
        { get_updates_buf: cursor },
        auth.token
      )
    );
    await this.current(state);
    const deliveries: { hash: string; sealed: string }[] = [];
    const sealedReview = await this.ctx.storage.get<string>('confirmation');
    const review = sealedReview
      ? await openWechat<Confirmation>(this.env, sealedReview)
      : null;
    for (const raw of result.msgs) {
      const parsed = wechatMessage.safeParse(raw);
      if (!parsed.success) continue;
      const msg = parsed.data;
      if (
        msg.from_user_id !== auth.userId ||
        (msg.to_user_id && msg.to_user_id !== auth.botId) ||
        msg.group_id ||
        msg.message_type !== 1 ||
        msg.message_state !== 2 ||
        !msg.context_token
      )
        continue;
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify([state.epoch, auth.botId, auth.userId, msg.message_id])
        )
      );
      const runId = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('');
      const allText = msg.item_list.every(
        (item) => item.type === 1 && item.text_item
      );
      const text = msg.item_list
        .map((item) => item.text_item?.text ?? '')
        .join('\n')
        .trim();
      const delivery: Delivery = {
        runId,
        threadId: state.threadId,
        context: msg.context_token,
        userId: auth.userId,
        text: text.slice(0, limits.inputCharacters),
        locale: /\p{Script=Han}/u.test(text) ? 'zh' : state.locale,
        createdAt: Date.now(),
        sentAt: msg.create_time_ms,
        attempts: 0,
        ...(review?.shown ? { reviewOperationId: review.operationId } : {}),
      };
      if (!allText || !text || text.length > limits.inputCharacters)
        delivery.reply = message('wechat_text_only', delivery.locale);
      deliveries.push({
        hash: runId,
        sealed: await sealWechat(this.env, delivery),
      });
    }
    // Inbox acceptance and cursor advancement commit together, before any AI work.
    await this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get<State>('state');
      if (
        current?.epoch !== state.epoch ||
        current.threadId !== state.threadId ||
        current.phase !== 'connected'
      )
        throw new HttpError(409, 'wechat_binding_changed');
      let sequence = (await storage.get<number>('sequence')) ?? 0;
      for (const delivery of deliveries) {
        if (await storage.get(`seen:${delivery.hash}`)) continue;
        await storage.put(
          `pending:${String(++sequence).padStart(16, '0')}`,
          delivery.sealed
        );
        await storage.put(`seen:${delivery.hash}`, true);
      }
      await storage.put('sequence', sequence);
      if (result.get_updates_buf)
        await storage.put('cursor', result.get_updates_buf);
      await storage.put('state', { ...current, lastPollAt: Date.now() });
    });
  }

  private async deliver(
    state: State,
    auth: Credentials,
    key: string,
    delivery: Delivery
  ) {
    if (
      delivery.threadId !== state.threadId ||
      Date.now() - delivery.createdAt > 3600000
    ) {
      await this.ctx.storage.delete(key);
      return;
    }
    await this.current(state, delivery.threadId);
    if (!delivery.reply) {
      delivery.reply = await this.confirmationReply(state, delivery, key);
      if (delivery.reply) {
        delivery.reply = await this.pendingReminder(state, delivery);
        await this.ctx.storage.put(key, await sealWechat(this.env, delivery));
      }
    }
    if (!delivery.reply) {
      const accepted = await this.env.DB.prepare(
        'SELECT user_message_id FROM chat_requests WHERE dataset_id=? AND run_id=?'
      )
        .bind(state.datasetId, delivery.runId)
        .first<{ user_message_id: string }>();
      const stub = this.env.CONVERSATIONS.getByName(
        `${state.datasetId}:${state.threadId}`
      );
      if (!accepted) {
        const conversation = await readConversation(
          this.env.DB,
          state.threadId
        );
        const response = await stub.fetch(
          new Request('https://moni.internal/api/chat', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Moni-Wechat-Epoch': state.epoch,
            },
            body: JSON.stringify({
              datasetId: state.datasetId,
              threadId: state.threadId,
              version: conversation.version,
              runId: delivery.runId,
              text: delivery.text,
            }),
          })
        );
        if (response.status === 409) {
          await response.body?.cancel();
          throw new HttpError(409, 'conversation_busy');
        }
        if (!response.ok) {
          const error = await response
            .json<{ error?: string }>()
            .catch(() => null);
          delivery.reply = message(
            error?.error === 'ai_not_configured'
              ? 'wechat_ai_setup_hint'
              : error?.error === 'history_limit' ||
                  error?.error === 'context_limit'
                ? 'wechat_context_limit'
                : 'wechat_ai_failed',
            delivery.locale
          );
        } else {
          try {
            const reader = response.body?.getReader();
            if (reader) {
              try {
                while (!(await reader.read()).done) {
                  /* Drain existing SSE; authoritative results are in D1. */
                }
              } finally {
                reader.releaseLock();
              }
            }
          } catch {
            /* Inspect the durable run; never replay accepted model work. */
          }
        }
      }
      await this.current(state, delivery.threadId);
      await stub.reconcile(state.datasetId, state.threadId);
      const run = await this.env.DB.prepare(
        'SELECT status,error_code FROM chat_runs WHERE dataset_id=? AND run_id=?'
      )
        .bind(state.datasetId, delivery.runId)
        .first<{ status: string; error_code: string | null }>();
      if (run?.status === 'running')
        throw new HttpError(409, 'conversation_busy');
      if (!delivery.reply)
        delivery.reply = await this.reply(
          state,
          delivery,
          run?.status === 'completed'
            ? undefined
            : message(
                run?.error_code === 'context_limit'
                  ? 'wechat_context_limit'
                  : 'wechat_ai_failed',
                delivery.locale
              )
        );
      delivery.reply = await this.pendingReminder(state, delivery);
      await this.ctx.storage.put(key, await sealWechat(this.env, delivery));
    }
    await this.current(state, delivery.threadId);
    if (delivery.review) {
      const targets = delivery.review.drafts ?? [
        { id: delivery.review.draftId, version: delivery.review.version },
      ];
      const excluded = delivery.review.excludedDraftIds ?? [];
      const drafts = (await queryDrafts(this.env.DB, state.threadId)).items;
      if (
        targets.some(
          ({ id, version }) =>
            !drafts.some(
              (draft) =>
                draft.id === id &&
                draft.version === version &&
                draft.status === 'ready'
            )
        ) ||
        excluded.some(
          (id) =>
            !drafts.some(
              (draft) => draft.id === id && draft.status === 'needs_details'
            )
        )
      ) {
        delete delivery.review;
        const run =
          await this.env.DB.prepare(`SELECT r.status,r.error_code FROM chat_runs r
          JOIN chat_requests q ON q.dataset_id=r.dataset_id AND q.run_id=r.run_id
          WHERE r.dataset_id=? AND r.thread_id=? AND r.run_id=?`)
            .bind(state.datasetId, state.threadId, delivery.runId)
            .first<{ status: string; error_code: string | null }>();
        delivery.reply = run
          ? await this.reply(
              state,
              delivery,
              run.status === 'completed'
                ? undefined
                : message(
                    run.error_code === 'context_limit'
                      ? 'wechat_context_limit'
                      : 'wechat_ai_failed',
                    delivery.locale
                  )
            )
          : ((await this.draftReplies(state, delivery, [
              ...targets.map(({ id }) => id),
              ...excluded,
            ])) ?? message('wechat_web_history', delivery.locale));
        delivery.reply = await this.pendingReminder(state, delivery);
        // Changed content needs a new transport ID; an earlier send may have succeeded.
        delivery.replyId = `moni-${crypto.randomUUID()}`;
        delivery.attempts = 0;
        await this.ctx.storage.put(key, await sealWechat(this.env, delivery));
      }
      await this.current(state, delivery.threadId);
    }
    try {
      await wechatApi(
        auth.apiOrigin,
        'sendmessage',
        {
          msg: {
            from_user_id: '',
            to_user_id: auth.userId,
            client_id: delivery.replyId ?? `moni-${delivery.runId}`,
            message_type: 2,
            message_state: 2,
            context_token: delivery.context,
            item_list: [{ type: 1, text_item: { text: delivery.reply } }],
          },
        },
        auth.token,
        15000
      );
      if (delivery.review) {
        await this.current(state, delivery.threadId);
        await this.ctx.storage.put(
          'confirmation',
          await sealWechat(this.env, {
            ...delivery.review,
            shown: true,
            shownAt: Date.now(),
          })
        );
      }
      await this.ctx.storage.delete(key);
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.code === 'wechat_reconnect_required'
      )
        throw error;
      delivery.attempts++;
      if (delivery.attempts >= 3) {
        await this.ctx.storage.delete(key);
        await this.update(state.epoch, { lastError: 'wechat_reply_failed' });
      } else {
        await this.ctx.storage.put(key, await sealWechat(this.env, delivery));
      }
      throw new HttpError(502, 'wechat_reply_failed');
    }
  }

  private async pendingReminder(state: State, delivery: Delivery) {
    const reply = delivery.reply ?? '';
    if (delivery.confirmationIntent === 'decline') return reply;
    const pending = (
      await queryDrafts(this.env.DB, state.threadId)
    ).items.filter(
      (draft) => draft.status === 'ready' || draft.status === 'needs_details'
    );
    if (!pending.length) return reply;
    const shown =
      delivery.review?.drafts?.map(({ id }) => id) ??
      (delivery.review ? [delivery.review.draftId] : []);
    if (pending.every(({ id }) => shown.includes(id))) return reply;
    return `${reply}\n\n💡 **${pending.length} ${message('wechat_pending_count', delivery.locale)} · ${pending.reduce((count, draft) => count + draft.items.length, 0)} ${message('draft_items', delivery.locale)}**\n${message('wechat_pending_reminder', delivery.locale)}`;
  }

  private channelGuard(state: State) {
    return this.env.DB.prepare(`INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS (
      SELECT 1 FROM wechat_binding w JOIN conversations c ON c.dataset_id=w.dataset_id AND c.id=w.thread_id
      WHERE w.singleton=1 AND w.enabled=1 AND w.epoch=? AND w.dataset_id=? AND w.thread_id=? AND c.deleted_at IS NULL)`).bind(
      state.epoch,
      state.datasetId,
      state.threadId
    );
  }

  private actionStatements(state: State, delivery: Delivery, reply: string) {
    const messages = JSON.stringify([
      { id: `wechat-${delivery.runId}`, role: 'user', content: delivery.text },
      {
        id: `wechat-${delivery.runId}-reply`,
        role: 'assistant',
        content: reply,
      },
    ]);
    return [
      this.channelGuard(state),
      this.env.DB.prepare(`INSERT INTO invariant_assertions(valid) SELECT 0 WHERE
        EXISTS(SELECT 1 FROM chat_runs WHERE dataset_id=? AND thread_id=? AND status='running')`).bind(
        state.datasetId,
        state.threadId
      ),
      this.env.DB.prepare(`INSERT INTO chat_messages(dataset_id,thread_id,position,message_json)
        SELECT ?,?,tail.position+CAST(j.key AS INTEGER),j.value FROM json_each(?) j,
        (SELECT coalesce(max(position),-1)+1 AS position FROM chat_messages WHERE dataset_id=? AND thread_id=?) tail
        WHERE NOT EXISTS(SELECT 1 FROM chat_messages m WHERE m.dataset_id=? AND m.thread_id=? AND json_extract(m.message_json,'$.id')=json_extract(j.value,'$.id'))`).bind(
        state.datasetId,
        state.threadId,
        messages,
        state.datasetId,
        state.threadId,
        state.datasetId,
        state.threadId
      ),
      this.env.DB.prepare(
        'UPDATE conversations SET version=version+1,updated_at=? WHERE dataset_id=? AND id=? AND deleted_at IS NULL'
      ).bind(Date.now(), state.datasetId, state.threadId),
      assertChanged(this.env.DB),
    ];
  }

  private async confirmationReply(
    state: State,
    delivery: Delivery,
    key: string
  ): Promise<string | undefined> {
    const drafts = (await queryDrafts(this.env.DB, state.threadId)).items;
    const pending = drafts.filter(
      (draft) => draft.status === 'ready' || draft.status === 'needs_details'
    );
    const sealed = await this.ctx.storage.get<string>('confirmation');
    const review = sealed
      ? await openWechat<Confirmation>(this.env, sealed)
      : null;
    const id = delivery.runId;
    const operationId = `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-a${id.slice(17, 20)}-${id.slice(20, 32)}`;
    const receipt = await this.env.DB.prepare(
      'SELECT result_json FROM operation_receipts WHERE dataset_id=? AND operation_id=?'
    )
      .bind(state.datasetId, operationId)
      .first<string>('result_json');
    if (receipt) return JSON.parse(receipt).reply as string;
    const targets =
      review?.drafts ??
      (review ? [{ id: review.draftId, version: review.version }] : []);
    const selected = review
      ? targets.flatMap(({ id }) => drafts.filter((draft) => draft.id === id))
      : pending.length === 1
        ? [pending[0]]
        : [];
    const candidate = selected[0];
    // A message sent before the preview can be fetched only after it was shown.
    const reviewed = Boolean(
      review?.shown &&
        review.shownAt !== undefined &&
        delivery.sentAt !== undefined &&
        delivery.sentAt > review.shownAt &&
        delivery.sentAt <= delivery.createdAt &&
        selected.length === targets.length &&
        selected.length > 0 &&
        review.epoch === state.epoch &&
        review.threadId === state.threadId &&
        review.operationId === delivery.reviewOperationId
    );
    if (!delivery.confirmationIntent && !(await aiConfiguration(this.env)))
      return message('wechat_ai_setup_hint', delivery.locale);
    const previous = await previousLedgerQuery(
      this.env.DB,
      state.datasetId,
      state.threadId
    );
    const decision =
      delivery.confirmationIntent ??
      (await conversationIntent(this.env, delivery.text, {
        ...reviewContext(reviewed, review, drafts),
        previousQuery: previous?.query ?? null,
      }));
    await this.current(state, delivery.threadId);
    const t = (key: Parameters<typeof message>[0]) =>
      message(key, delivery.locale);
    let reply = t('wechat_confirmation_unavailable');
    if (!decision) {
      const fallback = await lastQueryDetails(
        this.env.DB,
        state.datasetId,
        previous,
        delivery.locale
      );
      if (fallback) {
        reply = fallback;
        await this.ctx.storage.delete('confirmation');
      }
    }
    if (decision) {
      delivery.confirmationIntent = decision;
      await this.ctx.storage.put(key, await sealWechat(this.env, delivery));
      const currentDrafts = (await queryDrafts(this.env.DB, state.threadId))
        .items;
      const plan = planDraftReview(decision, reviewed, review, currentDrafts);
      if (
        plan.action === 'posted_change' &&
        pendingDrafts(currentDrafts).length
      )
        await this.ctx.storage.delete('confirmation');
      if (plan.action === 'continue') {
        await this.ctx.storage.delete('confirmation');
        return;
      }
      if (plan.action === 'decline') {
        await this.ctx.storage.delete('confirmation');
        reply = t('wechat_confirmation_declined');
      } else if (plan.action === 'preview') {
        const preview = plan.batch
          ? await this.batchReply(state, delivery, plan.drafts)
          : await this.draftReply(state, delivery, plan.drafts[0]);
        reply = `${plan.changed ? `${t('wechat_confirmation_changed')}\n` : ''}${preview}`;
      } else if (plan.action !== 'confirm') {
        reply = t(
          {
            posted_change: 'wechat_posted_change_required',
            already_posted: 'wechat_already_posted',
            clarify: 'wechat_confirmation_clarify',
            choose: 'wechat_confirmation_choose',
            incomplete: 'wechat_web_review_required',
            unavailable: 'wechat_confirmation_unavailable',
          }[plan.action] as Parameters<typeof message>[0]
        );
      } else if (review && candidate) {
        reply = review.drafts
          ? `✅ ${t('wechat_posted')}\n${selected.length} ${t('wechat_batch_posted_count')} · ${selected.reduce((count, draft) => count + draft.items.length, 0)} ${t('draft_items')}`
          : `${t('wechat_posted')}\n${candidate.items.length} ${t('draft_items')} · ${displayMoney(candidate.totalBaseMinor as number, candidate.baseCurrency, delivery.locale)}`;
        const guards = this.actionStatements(state, delivery, reply);
        try {
          await confirmDraftReview(
            this.env.DB,
            state.datasetId,
            state.threadId,
            review,
            decision === 'confirm_all',
            guards
          );
          return reply;
        } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 409)
            throw error;
          const latest = (
            await queryDrafts(this.env.DB, state.threadId)
          ).items.filter((draft) =>
            decision === 'confirm_all'
              ? draft.status === 'ready' ||
                draft.status === 'needs_details' ||
                targets.some(({ id }) => id === draft.id)
              : targets.some(({ id }) => id === draft.id)
          );
          reply =
            latest.length === targets.length &&
            latest.every((draft) => draft.status === 'posted')
              ? t('wechat_already_posted')
              : review?.drafts || decision === 'confirm_all'
                ? `${t('wechat_confirmation_changed')}\n${await this.batchReply(
                    state,
                    delivery,
                    latest.filter((draft) =>
                      ['ready', 'needs_details'].includes(draft.status)
                    )
                  )}`
                : latest[0] &&
                    ['ready', 'needs_details'].includes(latest[0].status)
                  ? `${t('wechat_confirmation_changed')}\n${await this.draftReply(state, delivery, latest[0])}`
                  : t('wechat_confirmation_choose');
        }
      }
    }
    if (delivery.review)
      await this.ctx.storage.put(key, await sealWechat(this.env, delivery));
    const input = {
      datasetId: state.datasetId,
      operationId,
      threadId: state.threadId,
      text: delivery.text,
      reply,
    };
    await executeCommand(
      this.env.DB,
      'wechat_confirmation_reply',
      input,
      this.actionStatements(state, delivery, reply),
      { reply }
    );
    return reply;
  }

  private async draftText(delivery: Delivery, draft: Draft) {
    const t = (key: Parameters<typeof message>[0]) =>
      message(key, delivery.locale);
    const colon = delivery.locale === 'zh' ? '：' : ': ';
    const field = (key: Parameters<typeof message>[0], value: string) =>
      `- ${t(key)}${colon}${markdownText(value).replace(/\r\n?|\n/g, '  \n  ')}`;
    const taxonomy = await readTaxonomy(this.env.DB);
    const lines = draft.items.map((item, index) => {
      const category = taxonomy.categories.find(
        (category) => category.id === item.categoryId
      );
      const money =
        item.currency && item.originalMinor !== null
          ? displayMoney(item.originalMinor, item.currency, delivery.locale)
          : markdownText(`${item.currency ?? '?'} ${item.amount ?? '?'}`);
      let line = `**${draft.items.length > 1 ? `${index + 1}. ` : ''}${markdownText(item.name.replace(/\r\n?|\n/g, ' '))}**\n\n**${money}** · ${t(item.kind === 'expense' ? 'entry_expense' : 'entry_income')}\n\n- ${t('entry_date')}${colon}${item.date}\n${field('entry_category', category ? categoryLabel(category.name, category.defaultKey, delivery.locale) : item.categoryId)}`;
      if (item.tags.length)
        line += `\n${field('entry_tags', item.tags.join(' · '))}`;
      if (item.note) line += `\n${field('entry_note', item.note)}`;
      if (item.snapshot && item.baseMinor !== null) {
        line += `\n- ${t('draft_converted')}${colon}**${displayMoney(item.baseMinor, draft.baseCurrency, delivery.locale)}**\n- ${t(item.snapshot.method === 'actual' ? 'fx_actual_source' : item.snapshot.source === 'ECB' ? 'fx_reference_source' : 'fx_manual_source')}`;
        if (item.snapshot.method !== 'actual') {
          line += `\n- ${t('fx_rate')}${colon}1 ${item.currency} = ${item.snapshot.rate} ${draft.baseCurrency}`;
          if (item.snapshot.quoteDate)
            line += `\n- ${t('fx_quote_date')}${colon}${item.snapshot.quoteDate}`;
        }
      }
      return line;
    });
    let reply = `🧾 **${t(draft.status === 'posted' ? 'wechat_posted' : draft.status === 'needs_details' ? 'draft_needs_details' : 'wechat_draft_ready')}**\n\n${lines.join('\n\n')}`;
    if (draft.totalBaseMinor !== null)
      reply += `\n\n---\n\n**${t('draft_total')}${colon}${displayMoney(draft.totalBaseMinor, draft.baseCurrency, delivery.locale)}**`;
    return reply;
  }

  private async draftReply(state: State, delivery: Delivery, draft: Draft) {
    const t = (key: Parameters<typeof message>[0]) =>
      message(key, delivery.locale);
    if (draft.status === 'cancelled') {
      await this.ctx.storage.delete('confirmation');
      return t('draft_cancelled');
    }
    let reply = await this.draftText(delivery, draft);
    if (draft.status !== 'posted')
      await this.ctx.storage.delete('confirmation');
    if (draft.status !== 'ready')
      return `${reply}\n${draft.status === 'posted' ? '' : t('wechat_web_review_required')}`.trim();
    if (reply.length > 2200) return t('wechat_web_review_required');
    delivery.review = {
      epoch: state.epoch,
      threadId: state.threadId,
      draftId: draft.id,
      version: draft.version,
      operationId: crypto.randomUUID(),
      shown: false,
    };
    reply += `\n\n${t('wechat_confirm_hint')}`;
    return reply;
  }

  private async batchReply(state: State, delivery: Delivery, pending: Draft[]) {
    const t = (key: Parameters<typeof message>[0]) =>
      message(key, delivery.locale);
    await this.ctx.storage.delete('confirmation');
    const { ready, duplicate } = draftReviewSummary(pending);
    if (!pending.length) return t('wechat_no_pending');
    if (!ready.length) return t('wechat_web_review_required');
    if (
      ready.length > 20 ||
      ready.reduce((count, draft) => count + draft.items.length, 0) > 20
    )
      return t('wechat_batch_too_long');
    let reply = `🧾 **${t('wechat_batch_review')}**\n\n${(await Promise.all(ready.map((draft) => this.draftText(delivery, draft)))).map((text, index) => `**${t('wechat_batch_draft')} ${index + 1}**\n${text}`).join('\n\n---\n\n')}`;
    if (ready.length < pending.length)
      reply += `\n\n⚠️ ${t('wechat_batch_incomplete')}`;
    if (duplicate) reply += `\n\n⚠️ ${t('wechat_batch_duplicate')}`;
    reply += `\n\n${t('wechat_batch_confirm_hint')}`;
    if (reply.length > 2200) return t('wechat_batch_too_long');
    delivery.review = {
      epoch: state.epoch,
      threadId: state.threadId,
      draftId: ready[0].id,
      version: ready[0].version,
      drafts: ready.map(({ id, version }) => ({ id, version })),
      excludedDraftIds: pending
        .filter((draft) => draft.status === 'needs_details')
        .map(({ id }) => id),
      operationId: crypto.randomUUID(),
      shown: false,
    };
    return reply;
  }

  private async reply(state: State, delivery: Delivery, failure?: string) {
    const t = (key: Parameters<typeof message>[0]) =>
      message(key, delivery.locale);
    if (failure) {
      // Financial writes can commit before a later model or transcript failure.
      const outcomes = await readRunDraftIds(
        this.env.DB,
        state.datasetId,
        state.threadId,
        delivery.runId
      );
      if (outcomes.length) {
        const text = await this.draftReplies(state, delivery, outcomes);
        if (text) return text;
      }
    }
    const receipt = await this.env.DB.prepare(
      'SELECT user_message_id FROM chat_requests WHERE dataset_id=? AND run_id=?'
    )
      .bind(state.datasetId, delivery.runId)
      .first<string>('user_message_id');
    const messages = (await chatPersistence(
      this.env.DB,
      state.datasetId
    ).stores.messages.loadThread(state.threadId)) as ModelMessage[];
    const index = messages.findIndex((item) => item.id === receipt);
    if (index < 0) return failure ?? t('wechat_ai_failed');
    const turn = messages.slice(index + 1);
    const results = turn
      .filter((item) => item.role === 'tool')
      .map((item) => (typeof item.content === 'string' ? item.content : ''));
    const queries = new Map<string, LedgerQueryResult | null>();
    for (const update of results.flatMap(parseQueryUpdates))
      queries.set(update.id, update.result);
    const references = results
      .map((item) => {
        try {
          return z
            .object({
              draftId: z.uuid(),
            })
            .parse(JSON.parse(item));
        } catch {
          return null;
        }
      })
      .filter((item) => item !== null);
    if (references.length) {
      for (const [id, query] of queries) {
        if (!query) continue;
        try {
          // Refresh every displayed report after posting or a cached reply's later web edit.
          queries.set(
            id,
            await refreshLedgerQuery(this.env.DB, state.datasetId, query)
          );
        } catch {
          queries.set(id, null);
        }
        await this.current(state, delivery.threadId);
      }
    }
    let statistics = queries.size
      ? [...queries.values()]
          .map((query) =>
            query
              ? wechatStatistics(query, delivery.locale)
              : `📊 **${t('nl_query_title')}**\n${t('report_load_error')}`
          )
          .join('\n\n---\n\n')
      : undefined;
    if (statistics && statistics.length > 2300)
      statistics = `📊 **${t('nl_query_title')}**\n${t('wechat_report_web_required')}`;
    const financial = references.length
      ? ((await this.draftReplies(
          state,
          delivery,
          references.map(({ draftId }) => draftId)
        )) ?? t('wechat_web_history'))
      : undefined;
    let text = financial ?? statistics;
    if (financial && statistics) {
      const combined = `${financial}\n\n---\n\n${statistics}`;
      const fallback = `${financial}\n\n📊 **${t('nl_query_title')}**\n${t('wechat_report_web_required')}`;
      if (combined.length <= 2300) text = combined;
      else if (fallback.length <= 2300) text = fallback;
      else {
        // Never truncate a review and leave authority to approve hidden details.
        delete delivery.review;
        await this.ctx.storage.delete('confirmation');
        text = `${t('wechat_web_review_required')}\n\n📊 **${t('nl_query_title')}**\n${t('wechat_report_web_required')}`;
      }
    }
    text ??=
      failure ??
      (turn
        .filter(
          (item) =>
            item.role === 'assistant' && typeof item.content === 'string'
        )
        .map((item) => item.content)
        .join('\n')
        .trim() ||
        t('wechat_ai_failed'));
    return text.slice(0, 2300);
  }

  private async draftReplies(state: State, delivery: Delivery, ids: string[]) {
    const drafts = (
      await queryDrafts(this.env.DB, state.threadId)
    ).items.filter(({ id }) => ids.includes(id));
    if (!drafts.length) return;
    const pending = drafts.filter(
      ({ status }) => status === 'ready' || status === 'needs_details'
    );
    const blocks: string[] = [];
    for (const draft of drafts.filter((draft) => !pending.includes(draft)))
      blocks.push(await this.draftReply(state, delivery, draft));
    if (pending.length)
      blocks.push(
        pending.length > 1
          ? await this.batchReply(state, delivery, pending)
          : await this.draftReply(state, delivery, pending[0])
      );
    const text = blocks.join('\n\n---\n\n');
    if (text.length <= 2300) return text;
    delete delivery.review;
    await this.ctx.storage.delete('confirmation');
    return message(
      pending.length ? 'wechat_web_review_required' : 'wechat_web_history',
      delivery.locale
    );
  }
}
