import {
  IconChartBar,
  IconChevronRight,
  IconHistory,
  IconNotebook,
  IconRefresh,
  IconSend,
  IconSoup,
  IconSquare,
  IconUser,
} from '@tabler/icons-react';
import {
  fetchServerSentEvents,
  type UIMessage,
  useChat,
} from '@tanstack/ai-react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatMarkdown } from '@/components/chat-markdown';
import { DraftCards } from '@/components/draft-cards';
import { QueryResultCard, queryResults } from '@/components/query-result-card';
import { Button } from '@/components/ui/button';
import type {
  ConversationRun,
  LedgerConversation,
} from '@/ledger/conversations';
import type { VisibleDraftReview } from '@/ledger/draft-review';
import type { LedgerSettings } from '@/ledger/settings';
import { ApiError, privateApi } from '@/lib/client-api';
import { limits } from '@/lib/limits';
import { type AppLocale, message } from '@/lib/locale';

type Snapshot = {
  conversation?: LedgerConversation;
  messages: UIMessage[];
  activeRun: { runId: string } | null;
  runs?: { runId: string; status: string }[];
  latestRun?: ConversationRun | null;
  coordinationBusy?: boolean;
  page?: { truncated: boolean; cursor?: string };
};
type Failure =
  | 'load'
  | 'model'
  | 'busy'
  | 'limit'
  | 'accepted'
  | 'conflict'
  | 'deleted';

export function ChatWorkspace({
  settings,
  locale,
  threadId,
  onConversationChange,
  onLedgerChange,
}: {
  settings: LedgerSettings & {
    aiConfigured: boolean;
    postingMode?: 'review' | 'automatic';
  };
  locale: AppLocale;
  threadId?: string;
  onConversationChange: () => void;
  onLedgerChange: () => Promise<void>;
}) {
  const [selection, setSelection] = useState(() => ({
    route: threadId,
    id: threadId ?? crypto.randomUUID(),
  }));
  if (selection.route !== threadId)
    setSelection({ route: threadId, id: threadId ?? crypto.randomUUID() });
  return (
    <ChatSession
      key={selection.id}
      id={selection.id}
      existing={Boolean(threadId)}
      settings={settings}
      locale={locale}
      onConversationChange={onConversationChange}
      onLedgerChange={onLedgerChange}
    />
  );
}

function ChatSession({
  id,
  existing,
  settings,
  locale,
  onConversationChange,
  onLedgerChange,
}: {
  id: string;
  existing: boolean;
  settings: LedgerSettings & {
    aiConfigured: boolean;
    postingMode?: 'review' | 'automatic';
  };
  locale: AppLocale;
  onConversationChange: () => void;
  onLedgerChange: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [conversation, setConversation] = useState<LedgerConversation | null>(
    null
  );
  const [hydrated, setHydrated] = useState(false);
  const [serverActive, setServerActive] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [historyPage, setHistoryPage] = useState<Snapshot['page']>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [latestRun, setLatestRun] = useState<ConversationRun | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const retryOf = useRef<string | null>(null);
  const cancelOperation = useRef<{ value: string; id: string } | null>(null);
  const metadata = useRef<LedgerConversation | null>(null);
  const persisted = useRef(existing);
  const routed = useRef(existing);
  const operation = useRef(crypto.randomUUID());
  const submitted = useRef<{ runId: string; text: string } | null>(null);
  const sending = useRef(false);
  const visibleReview = useRef<VisibleDraftReview | null>(null);
  const currentLocale = useRef(locale);
  currentLocale.current = locale;
  const rememberReview = useCallback((review: VisibleDraftReview | null) => {
    visibleReview.current = review;
  }, []);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    // Zoom and on-screen keyboards can shrink the visible area without resizing the layout viewport.
    const update = () =>
      form.current?.style.setProperty(
        '--chat-viewport-gap',
        `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`
      );
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  const remember = useCallback(
    (snapshot: Snapshot) => {
      if (snapshot.conversation) {
        if (
          snapshot.conversation.datasetId !== settings.datasetId ||
          snapshot.conversation.id !== id
        )
          throw new Error('conversation_changed');
        metadata.current = snapshot.conversation;
        setConversation(snapshot.conversation);
        persisted.current = true;
      }
      setServerActive(
        Boolean(snapshot.activeRun) || Boolean(snapshot.coordinationBusy)
      );
      setActiveRunId(snapshot.activeRun?.runId ?? null);
      setLatestRun(snapshot.latestRun ?? null);
      setHistoryPage(snapshot.page);
      setHydrated(true);
      setSnapshotRevision((value) => value + 1);
      onConversationChange();
      const pending = submitted.current;
      if (
        pending &&
        (snapshot.activeRun?.runId === pending.runId ||
          snapshot.runs?.some((run) => run.runId === pending.runId))
      )
        setInput((value) => (value.trim() === pending.text ? '' : value));
    },
    [id, settings.datasetId, onConversationChange]
  );
  const connection = useMemo(() => {
    const transport = fetchServerSentEvents('/api/chat', {
      fetchClient: async (url, init) => {
        if (init?.method !== 'POST') {
          // A new, unsaved conversation has no server history or active execution.
          if (!persisted.current) {
            setHydrated(true);
            return Response.json({
              messages: [],
              activeRun: null,
              interrupts: null,
            });
          }
          try {
            const response = await fetch(url, init);
            if (!response.ok) throw new ApiError(response.status);
            remember((await response.clone().json()) as Snapshot);
            return response;
          } catch (error) {
            setFailure(
              error instanceof ApiError && error.status === 404
                ? 'deleted'
                : 'load'
            );
            throw new Error('history_unavailable');
          }
        }
        const wire = JSON.parse(String(init.body)) as {
          runId: string;
          messages: { role: string; content?: unknown }[];
        };
        const current = wire.messages.at(-1);
        if (current?.role !== 'user' || typeof current.content !== 'string')
          throw new Error('current_input_required');
        submitted.current = { runId: wire.runId, text: current.content };
        const review = visibleReview.current;
        const replyLocale = currentLocale.current;
        if (!persisted.current) {
          await privateApi('conversations', {
            datasetId: settings.datasetId,
            operationId: operation.current,
            id,
          });
          persisted.current = true;
          metadata.current = await privateApi<LedgerConversation>(
            `conversations/${id}`
          );
          setConversation(metadata.current);
        }
        if (!metadata.current) throw new Error('history_unavailable');
        if (!routed.current) {
          await navigate({
            to: '/',
            search: { view: 'chat', thread: id },
            replace: true,
            resetScroll: false,
          });
          routed.current = true;
        }
        const response = await fetch(url, {
          ...init,
          body: JSON.stringify({
            datasetId: settings.datasetId,
            threadId: id,
            runId: wire.runId,
            version: metadata.current.version,
            text: current.content,
            review,
            locale: replyLocale,
            ...(retryOf.current ? { retryOf: retryOf.current } : {}),
          }),
        });
        if (response.status === 202) {
          setFailure('accepted');
          throw new Error('already_accepted');
        }
        if (!response.ok) {
          const body = (await response
            .clone()
            .json()
            .catch(() => ({}))) as { error?: string };
          setFailure(
            response.status === 413
              ? 'limit'
              : body.error === 'conversation_busy'
                ? 'busy'
                : response.status === 409
                  ? 'conflict'
                  : 'model'
          );
        } else {
          setActiveRunId(wire.runId);
          setServerActive(true);
          setInput((value) => (value.trim() === current.content ? '' : value));
        }
        return response;
      },
    });
    // Restore authoritative history without joining or replaying an active model run.
    return { connect: transport.connect, hydrate: transport.hydrate };
  }, [id, navigate, remember, settings.datasetId]);
  const {
    messages,
    sendMessage,
    setMessages,
    isLoading,
    isHydrating,
    reload,
    stop,
  } = useChat({
    threadId: id,
    connection,
    persistence: true,
    queue: { whenBusy: 'drop' },
    onError: () => setFailure((value) => value ?? 'model'),
  });
  const refreshHistory = async () => {
    if (!persisted.current) return;
    setRefreshing(true);
    try {
      const snapshot = await privateApi<Snapshot>(`chat?threadId=${id}`);
      remember(snapshot);
      setMessages(snapshot.messages);
      if (!routed.current) {
        await navigate({
          to: '/',
          search: { view: 'chat', thread: id },
          replace: true,
          resetScroll: false,
        });
        routed.current = true;
      }
    } catch (error) {
      const deleted = error instanceof ApiError && error.status === 404;
      setFailure(deleted ? 'deleted' : 'load');
      if (deleted) {
        setMessages([]);
        setConversation(null);
        setServerActive(false);
        setActiveRunId(null);
        setLatestRun(null);
        onConversationChange();
      }
      setHydrated(false);
    } finally {
      setRefreshing(false);
    }
  };
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const busy =
    isLoading || serverActive || refreshing || stopping || loadingOlder;
  const loadOlder = async () => {
    if (busy || !historyPage?.cursor) return;
    setLoadingOlder(true);
    try {
      const snapshot = await privateApi<Snapshot>(
        `chat?threadId=${id}&limit=${limits.historyPageMessages}&before=${encodeURIComponent(historyPage.cursor)}`
      );
      if (
        snapshot.conversation?.id !== id ||
        snapshot.conversation.datasetId !== settings.datasetId
      )
        throw new Error('conversation_changed');
      setMessages([
        ...new Map(
          [...snapshot.messages, ...messages].map((message) => [
            message.id,
            message,
          ])
        ).values(),
      ]);
      setHistoryPage(snapshot.page);
    } catch {
      setFailure('load');
    } finally {
      setLoadingOlder(false);
    }
  };
  const presentation = messages.map((item) => ({
    item,
    text: item.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.content)
      .join('\n\n'),
    results: queryResults(item),
  }));
  // Keep each turn's result cards below its answer, including after reloading tool history.
  for (let index = 0; index < presentation.length - 1; index++) {
    const current = presentation[index];
    const next = presentation[index + 1];
    if (current.item.role === 'assistant' && next.item.role === 'assistant') {
      next.results = new Map([...current.results, ...next.results]);
      current.results = new Map();
    }
  }
  if (
    latestRun?.ledgerSaved &&
    ['aborted', 'failed'].includes(latestRun.status)
  ) {
    let start = -1;
    for (let index = 0; index < presentation.length; index++)
      if (presentation[index].item.role === 'user') start = index;
    for (const row of presentation.slice(start + 1))
      for (const key of row.results.keys()) row.results.set(key, null);
  }
  return (
    <div className="flex min-h-[calc(100dvh-12rem)] flex-col md:min-h-[calc(100dvh-6rem)]">
      <div className="mb-5 flex items-center justify-between gap-4">
        <h1
          title={conversation?.title || undefined}
          className="line-clamp-2 min-w-0 break-words text-2xl font-extrabold md:text-3xl"
        >
          {conversation?.source === 'wechat' ? `${t('wechat_source')} · ` : ''}
          {conversation?.title || t('chat_title')}
        </h1>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            to="/"
            search={{ view: 'chat', panel: 'conversations' }}
            aria-label={t('conversations_title')}
            className="inline-flex size-11 items-center justify-center rounded-lg focus-visible:outline-4 focus-visible:outline-focus"
          >
            <IconHistory size={22} aria-hidden />
          </Link>
          <Button
            variant="icon"
            aria-label={t('chat_refresh')}
            disabled={isLoading || refreshing || !persisted.current}
            onClick={() => {
              setFailure(null);
              void refreshHistory();
            }}
          >
            <IconRefresh size={22} aria-hidden />
          </Button>
        </div>
      </div>
      <section aria-label={t('chat_history')} className="flex-1 pb-6">
        {isHydrating || (!hydrated && !failure) ? (
          <output>{t('probe_loading')}</output>
        ) : !messages.length && !failure ? (
          <div className="mx-auto max-w-lg py-4 text-center md:py-8">
            <img
              alt=""
              src="/moni/illustrations/assistant-writing.png"
              className="mx-auto w-32 md:w-52"
            />
            <h2 className="mt-2 text-2xl font-extrabold md:mt-4">
              {t(
                conversation?.source === 'wechat'
                  ? 'wechat_source'
                  : 'app_welcome'
              )}
            </h2>
            <p
              hidden={conversation?.source === 'wechat'}
              className="mt-2 text-muted-foreground md:mt-3"
            >
              {t('app_welcome_description')}
            </p>
            <div
              hidden={conversation?.source === 'wechat'}
              className="mt-4 space-y-3 text-left md:mt-6"
            >
              <button
                type="button"
                onClick={() => setInput(t('app_example_entry'))}
                className="flex min-h-12 w-full items-center gap-3 rounded-2xl bg-yellow/25 px-4 py-3 focus-visible:outline-4 focus-visible:outline-focus"
              >
                <IconSoup size={22} className="shrink-0" aria-hidden />
                <span className="flex-1">{t('app_example_entry')}</span>
                <IconChevronRight size={18} className="shrink-0" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => setInput(t('app_example_query'))}
                className="flex min-h-12 w-full items-center gap-3 rounded-2xl bg-yellow/25 px-4 py-3 focus-visible:outline-4 focus-visible:outline-focus"
              >
                <IconChartBar size={22} className="shrink-0" aria-hidden />
                <span className="flex-1">{t('app_example_query')}</span>
                <IconChevronRight size={18} className="shrink-0" aria-hidden />
              </button>
            </div>
          </div>
        ) : (
          <ol className="space-y-6">
            {historyPage?.truncated && (
              <li className="text-center">
                <Button
                  variant="plain"
                  disabled={busy}
                  onClick={() => void loadOlder()}
                >
                  {t(loadingOlder ? 'chat_loading_older' : 'chat_load_older')}
                </Button>
              </li>
            )}
            {presentation.map(({ item, text, results }) => {
              if (!text.trim() && !results.size) return null;
              return (
                <li key={item.id}>
                  {text.trim() && (
                    <div
                      className={`flex items-start gap-3 ${item.role === 'user' ? 'flex-row-reverse' : ''}`}
                    >
                      {item.role === 'user' ? (
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
                          <IconUser aria-hidden size={24} />
                        </span>
                      ) : (
                        <img
                          alt=""
                          src="/moni/illustrations/assistant-writing.png"
                          className="w-12 shrink-0"
                        />
                      )}
                      <div
                        className={`min-w-0 max-w-[85%] break-words rounded-2xl px-4 py-3 md:max-w-[75%] md:px-5 md:py-4 ${item.role === 'user' ? 'whitespace-pre-wrap bg-yellow/70 text-ink' : 'bg-surface'}`}
                      >
                        <span className="sr-only">
                          {t(
                            item.role === 'user' ? 'chat_you' : 'chat_assistant'
                          )}
                          ：
                        </span>
                        {item.role === 'user' ? (
                          text
                        ) : (
                          <ChatMarkdown text={text} locale={locale} />
                        )}
                      </div>
                    </div>
                  )}
                  {[...results].map(([resultId, result]) => (
                    <div key={resultId} className="mt-4 md:ml-16">
                      {result ? (
                        <QueryResultCard
                          result={result}
                          locale={locale}
                          datasetId={settings.datasetId}
                        />
                      ) : (
                        <p role="alert">{t('report_load_error')}</p>
                      )}
                    </div>
                  ))}
                </li>
              );
            })}
          </ol>
        )}
        {conversation && (
          <DraftCards
            threadId={id}
            revision={snapshotRevision}
            settings={settings}
            locale={locale}
            onPosted={onLedgerChange}
            onReview={rememberReview}
          />
        )}
        <output
          aria-live="polite"
          className="mt-5 block text-sm text-muted-foreground"
        >
          {busy
            ? t(serverActive && !isLoading ? 'chat_busy' : 'chat_working')
            : messages.length && hydrated
              ? t('chat_saved')
              : ''}
        </output>
        {failure && (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-foreground/30 bg-yellow/15 p-4"
          >
            {t(
              failure === 'deleted'
                ? 'conversations_deleted'
                : failure === 'load'
                  ? 'chat_load_error'
                  : failure === 'limit'
                    ? 'chat_limit'
                    : failure === 'busy'
                      ? 'chat_busy'
                      : failure === 'accepted'
                        ? 'chat_accepted'
                        : failure === 'conflict'
                          ? 'chat_conflict'
                          : 'chat_reply_error'
            )}
          </p>
        )}
        {!busy &&
          latestRun &&
          ['aborted', 'failed'].includes(latestRun.status) && (
            <output
              aria-live="polite"
              className="mt-4 block rounded-xl border border-foreground/30 bg-yellow/15 p-4"
            >
              {t(
                latestRun.ledgerSaved
                  ? 'chat_ledger_saved'
                  : latestRun.errorCode === 'context_limit'
                    ? 'chat_limit'
                    : !latestRun.retryable
                      ? 'chat_partial_saved'
                      : latestRun.errorCode === 'cancelled'
                        ? 'chat_cancelled'
                        : latestRun.errorCode === 'timed_out'
                          ? 'chat_timed_out'
                          : latestRun.errorCode === 'interrupted'
                            ? 'chat_interrupted'
                            : 'chat_failed'
              )}
            </output>
          )}
        <div className="mt-3 flex flex-wrap gap-3">
          {!busy &&
            hydrated &&
            conversation?.source !== 'wechat' &&
            latestRun?.retryable &&
            settings.aiConfigured && (
              <Button
                variant="plain"
                onClick={async () => {
                  if (sending.current) return;
                  sending.current = true;
                  retryOf.current = latestRun.runId;
                  setFailure(null);
                  try {
                    await reload();
                  } catch {
                    setFailure((value) => value ?? 'model');
                  } finally {
                    retryOf.current = null;
                    await refreshHistory();
                    sending.current = false;
                  }
                }}
              >
                {t('chat_retry')}
              </Button>
            )}
          {activeRunId && (isLoading || serverActive) && (
            <Button
              variant="plain"
              disabled={stopping || refreshing}
              onClick={async () => {
                const target = activeRunId;
                setStopping(true);
                setFailure(null);
                try {
                  const snapshot = await privateApi<Snapshot>(
                    `chat?threadId=${id}`
                  );
                  remember(snapshot);
                  if (
                    snapshot.activeRun?.runId === target &&
                    snapshot.conversation
                  ) {
                    const value = `${target}:${snapshot.conversation.version}`;
                    if (cancelOperation.current?.value !== value)
                      cancelOperation.current = {
                        value,
                        id: crypto.randomUUID(),
                      };
                    await privateApi('conversations/cancel', {
                      datasetId: settings.datasetId,
                      id,
                      version: snapshot.conversation.version,
                      runId: target,
                      operationId: cancelOperation.current.id,
                      confirmed: true,
                    });
                  }
                  stop();
                  await refreshHistory();
                } catch {
                  setFailure('conflict');
                } finally {
                  setStopping(false);
                }
              }}
            >
              <IconSquare size={17} aria-hidden />
              {t('chat_stop')}
            </Button>
          )}
          {(failure === 'limit' || failure === 'deleted') && (
            <Link
              to="/"
              search={{ view: 'chat' }}
              className="inline-flex min-h-11 items-center rounded-lg px-3 font-bold focus-visible:outline-4 focus-visible:outline-focus"
            >
              {t('app_new_chat')}
            </Link>
          )}
        </div>
        {!settings.aiConfigured && (
          <p className="mt-5 rounded-xl bg-yellow/15 p-4">
            {t('app_ai_later')}
          </p>
        )}
      </section>
      {conversation?.source === 'wechat' && (
        <p className="mt-5 rounded-xl bg-green/20 p-4">
          {t('wechat_web_history')}
        </p>
      )}
      <form
        hidden={conversation?.source === 'wechat'}
        ref={form}
        className="sticky bottom-[max(6rem,var(--chat-viewport-gap,0px))] bg-background pb-3 pt-3 md:bottom-[var(--chat-viewport-gap,0px)]"
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            sending.current ||
            busy ||
            !hydrated ||
            !settings.aiConfigured ||
            !input.trim()
          )
            return;
          sending.current = true;
          setFailure(null);
          try {
            await sendMessage(input.trim());
          } catch {
            setFailure((value) => value ?? 'model');
          } finally {
            await refreshHistory();
            await onLedgerChange().catch(() => setFailure('load'));
            sending.current = false;
          }
        }}
      >
        <label htmlFor="chat-input" className="sr-only">
          {t('chat_input')}
        </label>
        <div className="flex items-end gap-2 rounded-2xl border-2 border-foreground/40 bg-surface p-2">
          <textarea
            id="chat-input"
            rows={1}
            aria-describedby="chat-confirm-hint"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                form.current?.requestSubmit();
              }
            }}
            disabled={busy || !hydrated || !settings.aiConfigured}
            maxLength={limits.inputCharacters}
            placeholder={t('chat_input')}
            className="min-h-12 min-w-0 flex-1 resize-y rounded-xl bg-transparent p-3 outline-none focus-visible:ring-4 focus-visible:ring-focus"
          />
          <Button
            type="submit"
            variant="icon"
            className="shrink-0 rounded-full! border-0! bg-orange! text-ink!"
            aria-label={t('chat_send')}
            disabled={
              busy || !hydrated || !settings.aiConfigured || !input.trim()
            }
          >
            <IconSend size={24} aria-hidden />
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
          <Link
            id="chat-confirm-hint"
            to="/"
            search={{ view: 'settings' }}
            className="inline-flex min-h-11 items-center rounded-lg px-2 font-bold focus-visible:outline-4 focus-visible:outline-focus"
          >
            {t('posting_permissions')} ·{' '}
            {t(
              settings.postingMode === 'automatic'
                ? 'posting_automatic'
                : 'posting_review'
            )}
          </Link>
          <Link
            to="/"
            search={{ view: 'entries', entry: 'new' }}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 font-bold focus-visible:outline-4 focus-visible:outline-focus"
          >
            <IconNotebook size={20} aria-hidden />
            {t('entry_manual')}
          </Link>
        </div>
      </form>
    </div>
  );
}
