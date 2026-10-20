import { IconArrowUp, IconPlus } from '@tabler/icons-react';
import { fetchServerSentEvents, useChat } from '@tanstack/ai-react';
import { useEffect, useMemo, useState } from 'react';
import { ThemeSwitcher } from '@/components/layout/theme-switcher';
import { Button } from '@/components/ui/button';
import { type AppLocale, localeMeta, message } from '@/lib/locale';

export function ProbePage({
  threadId,
  onNew,
}: {
  threadId: string;
  onNew: () => void;
}) {
  const [locale, setLocale] = useState<AppLocale>('en');
  const [status, setStatus] = useState<{
    aiConfigured: boolean;
    datasetId: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setLocale(navigator.language.startsWith('zh') ? 'zh' : 'en');
    const controller = new AbortController();
    fetch('/api/status', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Private status unavailable');
        setStatus(await response.json());
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    document.documentElement.lang = localeMeta[locale].hreflang;
  }, [locale]);
  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-dvh max-w-5xl flex-col px-5 py-6 md:px-10 md:py-10"
    >
      <header className="flex flex-wrap items-center justify-between gap-4">
        <a href="/verify" aria-label="Moni" className="shrink-0">
          <img
            src="/moni/brand/wordmark-on-light.png"
            alt="Moni"
            className="h-auto w-28 dark:hidden"
          />
          <img
            src="/moni/brand/wordmark-on-dark-v2.png"
            alt="Moni"
            className="hidden h-auto w-28 dark:block"
          />
        </a>
        <div className="flex items-center gap-3">
          <select
            aria-label={message('language_label', locale)}
            value={locale}
            onChange={(event) =>
              setLocale(event.target.value === 'zh' ? 'zh' : 'en')
            }
            className="min-h-11 rounded-lg border border-muted bg-surface px-3 text-foreground"
          >
            <option value="en">English</option>
            <option value="zh">简体中文</option>
          </select>
          <ThemeSwitcher locale={locale} />
        </div>
      </header>
      <div className="mt-10 flex flex-wrap items-start justify-between gap-4 border-b border-muted pb-5">
        <div>
          <h1 className="text-2xl font-extrabold md:text-3xl">
            {message('probe_title', locale)}
          </h1>
          <p className="mt-2 max-w-xl text-muted-foreground">
            {message('probe_description', locale)}
          </p>
        </div>
        <Button variant="plain" onClick={onNew}>
          <IconPlus size={20} aria-hidden />
          {message('probe_new', locale)}
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="mt-10 rounded-xl border-2 border-orange p-5">
          {message('probe_load_error', locale)}
        </p>
      ) : !status ? (
        <output className="mt-10">{message('probe_loading', locale)}</output>
      ) : !status.aiConfigured ? (
        <output className="mt-10 rounded-xl border-2 border-muted p-5">
          {message('probe_unconfigured', locale)}
        </output>
      ) : (
        <ProbeChat
          key={`${status.datasetId}:${threadId}`}
          datasetId={status.datasetId}
          threadId={threadId}
          locale={locale}
        />
      )}
    </main>
  );
}

function ProbeChat({
  datasetId,
  threadId,
  locale,
}: {
  datasetId: string;
  threadId: string;
  locale: AppLocale;
}) {
  const [input, setInput] = useState('');
  const connection = useMemo(() => {
    const transport = fetchServerSentEvents('/api/probe', {
      fetchClient: async (url, init) => {
        if (init?.method !== 'POST') return fetch(url, init);
        const wire = JSON.parse(String(init.body)) as {
          threadId: string;
          runId: string;
          messages: { role: string; content?: unknown }[];
        };
        const current = wire.messages.at(-1);
        if (current?.role !== 'user' || typeof current.content !== 'string')
          throw new Error('Current user text required');
        return fetch(url, {
          ...init,
          body: JSON.stringify({
            datasetId,
            threadId: wire.threadId,
            runId: wire.runId,
            text: current.content,
          }),
        });
      },
    });
    // v0.1 restores history but does not promise delivery replay or auto rejoin.
    return { connect: transport.connect, hydrate: transport.hydrate };
  }, [datasetId]);
  const { messages, sendMessage, isLoading, error } = useChat({
    threadId,
    connection,
    persistence: true,
  });
  return (
    <>
      <section
        aria-label={message('probe_title', locale)}
        aria-live="polite"
        className="flex-1 py-8"
      >
        {!messages.length ? (
          <div className="mx-auto flex max-w-lg flex-col items-center py-8 text-center">
            <img
              src="/moni/illustrations/assistant-writing.png"
              alt=""
              className="h-auto w-48"
            />
            <h2 className="mt-3 text-2xl font-extrabold">
              {message('probe_welcome', locale)}
            </h2>
            <button
              type="button"
              onClick={() => setInput(message('probe_synthetic', locale))}
              className="mt-6 rounded-2xl bg-yellow-soft px-5 py-4 text-left font-bold text-ink focus-visible:outline-4 focus-visible:outline-focus"
            >
              {message('probe_synthetic', locale)}
            </button>
          </div>
        ) : (
          <ol className="space-y-5">
            {messages.map((item) => (
              <li
                key={item.id}
                className={`flex ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[90%] whitespace-pre-wrap break-words rounded-2xl px-5 py-4 ${item.role === 'user' ? 'bg-yellow-soft text-ink' : 'border border-muted bg-surface'}`}
                >
                  {item.parts
                    .filter((part) => part.type === 'text')
                    .map((part) => part.content)
                    .join('\n\n')}
                </div>
              </li>
            ))}
          </ol>
        )}
        {isLoading && (
          <output className="mt-4 text-muted-foreground">
            {message('probe_working', locale)}
          </output>
        )}
        {error && (
          <p
            role="alert"
            className="mt-4 rounded-xl border-2 border-orange p-4"
          >
            {message('probe_reply_error', locale)}
          </p>
        )}
      </section>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!input.trim() || isLoading) return;
          const text = input;
          setInput('');
          try {
            await sendMessage(text);
          } catch {
            setInput(text);
          }
        }}
        className="sticky bottom-0 bg-background pb-4 pt-3"
      >
        <label htmlFor="probe-input" className="sr-only">
          {message('probe_placeholder', locale)}
        </label>
        <div className="flex items-end gap-3 rounded-2xl border-2 border-ink bg-surface p-3">
          <textarea
            id="probe-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            maxLength={4000}
            disabled={isLoading}
            rows={2}
            placeholder={message('probe_placeholder', locale)}
            className="min-w-0 flex-1 resize-none bg-transparent p-2 outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
          <Button
            type="submit"
            aria-label={message('probe_send', locale)}
            disabled={isLoading || !input.trim()}
            variant="icon"
            className="shrink-0 rounded-full bg-orange text-ink"
          >
            <IconArrowUp size={24} aria-hidden />
          </Button>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          {message('probe_saved', locale)}
        </p>
      </form>
    </>
  );
}
