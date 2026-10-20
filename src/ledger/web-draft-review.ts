import { EventType, type ModelMessage, type StreamChunk } from '@tanstack/ai';
import {
  assertChatExecution,
  type ChatPermit,
  chatExecutionGuard,
} from '../lib/chat-persistence';
import { conversationIntent } from '../lib/conversation-intent';
import { HttpError } from '../lib/http';
import { type AppLocale, message } from '../lib/locale';
import { previousLedgerQuery } from './chat-query';
import {
  confirmDraftReview,
  type DraftReview,
  planDraftReview,
  reviewContext,
  reviewTargets,
  selectedDrafts,
  type VisibleDraftReview,
} from './draft-review';
import { queryDrafts } from './drafts';
import { lastQueryDetails } from './query-fallback';

export async function webDraftReply(
  env: Env,
  datasetId: string,
  permit: ChatPermit,
  signal: AbortSignal,
  text: string,
  visible: VisibleDraftReview | null,
  locale: AppLocale
) {
  let drafts = (await queryDrafts(env.DB, permit.threadId)).items;
  const review: DraftReview | null = visible
    ? {
        ...visible,
        draftId: visible.drafts[0].id,
        version: visible.drafts[0].version,
      }
    : null;
  const selected = selectedDrafts(review, drafts);
  const tail = await env.DB.prepare(
    'SELECT message_json FROM chat_messages WHERE dataset_id=? AND thread_id=? ORDER BY position DESC LIMIT 32'
  )
    .bind(datasetId, permit.threadId)
    .all<{ message_json: string }>();
  // The accepted current user message is last; inspect only the preceding bounded turn.
  const previousTurn: ModelMessage[] = [];
  for (const row of tail.results.slice(1)) {
    const item = JSON.parse(row.message_json) as ModelMessage;
    if (item.role === 'user') break;
    previousTurn.unshift(item);
  }
  const prepareCalls = new Set(
    previousTurn.flatMap(
      (item) =>
        item.toolCalls
          ?.filter((call) => call.function.name === 'prepare_draft')
          .map((call) => call.id) ?? []
    )
  );
  const awaitingReview = previousTurn.some(
    (item) =>
      item.metadata?.moniDraftReview === true ||
      (item.role === 'tool' &&
        item.toolCallId &&
        prepareCalls.has(item.toolCallId) &&
        readyToolResult(item.content))
  );
  // Only the owner UI supplies the versions visible when this message was sent; model output never does.
  const reviewed = Boolean(
    review &&
      awaitingReview &&
      selected.length === reviewTargets(review).length &&
      selected.length > 0 &&
      selected.reduce((count, draft) => count + draft.items.length, 0) <= 20
  );
  const previous = await previousLedgerQuery(
    env.DB,
    datasetId,
    permit.threadId
  );
  const decision = await conversationIntent(
    env,
    text,
    {
      ...reviewContext(reviewed, review, drafts),
      previousQuery: previous?.query ?? null,
    },
    signal
  );
  await assertChatExecution(env.DB, datasetId, permit, signal);
  drafts = (await queryDrafts(env.DB, permit.threadId)).items;
  const plan = planDraftReview(decision, reviewed, review, drafts);
  if (plan.action === 'continue') return null;
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const fallback =
    decision === null
      ? await lastQueryDetails(env.DB, datasetId, previous, locale)
      : null;
  let reply: string;
  if (fallback) reply = fallback;
  else if (plan.action === 'preview') {
    const ready = plan.drafts.filter((draft) => draft.status === 'ready');
    const tooLarge =
      ready.length > 20 ||
      ready.reduce((count, draft) => count + draft.items.length, 0) > 20;
    reply = !plan.drafts.length
      ? t('wechat_no_pending')
      : `${plan.changed ? `${t('wechat_confirmation_changed')}\n` : ''}${plan.drafts.length} ${t('wechat_pending_count')}\n${t(tooLarge ? 'chat_review_too_large' : 'chat_review_ready')}${ready.length < plan.drafts.length ? `\n${t('chat_review_incomplete')}` : ''}`;
  } else if (plan.action === 'confirm' && review) {
    reply = `${t('wechat_posted')} · ${selectedDrafts(review, drafts).reduce((count, draft) => count + draft.items.length, 0)} ${t('draft_items')}`;
  } else {
    const keys = {
      unavailable: 'wechat_confirmation_unavailable',
      decline: 'wechat_confirmation_declined',
      posted_change: 'chat_posted_change',
      already_posted: 'wechat_already_posted',
      clarify: 'wechat_confirmation_clarify',
      choose: 'chat_review_choose',
      incomplete: 'chat_review_incomplete',
      confirm: 'chat_review_choose',
    } as const;
    reply = t(keys[plan.action]);
  }
  const messageId = crypto.randomUUID();
  const finish = () => [
    chatExecutionGuard(env.DB, datasetId, permit),
    env.DB.prepare(`INSERT INTO chat_messages(dataset_id,thread_id,position,message_json)
      SELECT ?,?,coalesce(max(position),-1)+1,? FROM chat_messages WHERE dataset_id=? AND thread_id=?`).bind(
      datasetId,
      permit.threadId,
      JSON.stringify({
        id: messageId,
        role: 'assistant',
        content: reply,
        metadata: {
          moniDraftReview:
            !fallback &&
            (plan.action === 'preview' ||
              (reviewed &&
                !['continue', 'decline', 'posted_change'].includes(
                  plan.action
                ))),
        },
      }),
      datasetId,
      permit.threadId
    ),
    env.DB.prepare(
      "UPDATE chat_runs SET status='completed',finished_at=? WHERE dataset_id=? AND run_id=? AND status='running'"
    ).bind(Date.now(), datasetId, permit.runId),
    env.DB.prepare(
      'UPDATE moni_state SET revision=revision+1 WHERE singleton=1 AND active_dataset=?'
    ).bind(datasetId),
  ];
  if (plan.action === 'confirm' && review) {
    try {
      // Each accepted turn has its own receipt, while draft versions prevent repeated posting.
      await confirmDraftReview(
        env.DB,
        datasetId,
        permit.threadId,
        { ...review, operationId: crypto.randomUUID() },
        decision === 'confirm_all',
        finish()
      );
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
      reply = t('wechat_confirmation_changed');
      await env.DB.batch(finish());
    }
  } else await env.DB.batch(finish());
  return { reply, messageId };
}

function readyToolResult(content: unknown) {
  try {
    const value = typeof content === 'string' ? JSON.parse(content) : content;
    return (
      value &&
      typeof value === 'object' &&
      'status' in value &&
      ['ready', 'needs_details'].includes(value.status as string)
    );
  } catch {
    return false;
  }
}

export async function* webDraftStream(
  threadId: string,
  runId: string,
  result: { reply: string; messageId: string }
): AsyncGenerator<StreamChunk> {
  yield { type: EventType.RUN_STARTED, threadId, runId };
  yield {
    type: EventType.TEXT_MESSAGE_START,
    messageId: result.messageId,
    role: 'assistant',
  };
  yield {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: result.messageId,
    delta: result.reply,
  };
  yield { type: EventType.TEXT_MESSAGE_END, messageId: result.messageId };
  yield { type: EventType.RUN_FINISHED, threadId, runId, finishReason: 'stop' };
}
