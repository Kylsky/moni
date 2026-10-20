import { Dialog } from '@base-ui/react/dialog';
import {
  IconMessageCircle,
  IconPlus,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import type {
  ConversationPage,
  LedgerConversation,
} from '@/ledger/conversations';
import { todayInZone } from '@/ledger/dates';
import { privateApi } from '@/lib/client-api';
import { type AppLocale, message } from '@/lib/locale';

export function ConversationList({
  datasetId,
  locale,
  timeZone,
  revision,
  recent = false,
  onChange,
}: {
  datasetId: string;
  locale: AppLocale;
  timeZone: string;
  revision: number;
  recent?: boolean;
  onChange: () => void;
}) {
  const [data, setData] = useState<ConversationPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [deleting, setDeleting] = useState<LedgerConversation | null>(null);
  const sequence = useRef(0);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const reload = useCallback(async () => {
    const current = ++sequence.current;
    const result = await privateApi<ConversationPage>('conversations/query', {
      keyword: search,
      page,
      pageSize: recent ? 5 : 20,
    });
    if (current !== sequence.current) return;
    if (result.datasetId !== datasetId) throw new Error('dataset_changed');
    setData(result);
    setFailed(false);
  }, [datasetId, search, page, recent]);
  useEffect(() => {
    void revision;
    reload().catch(() => setFailed(true));
    return () => {
      sequence.current++;
    };
  }, [reload, revision]);
  const today = todayInZone(timeZone);
  const monday = new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const week = monday.toISOString().slice(0, 10);
  const group = (item: LedgerConversation) => {
    const date = todayInZone(timeZone, new Date(item.updatedAt));
    return date >= today
      ? 'conversations_today'
      : date >= week
        ? 'conversations_week'
        : 'conversations_older';
  };
  return (
    <section
      aria-label={t(recent ? 'conversations_recent' : 'conversations_title')}
      className={recent ? 'min-h-0 overflow-y-auto py-3' : ''}
    >
      {recent ? (
        <p className="mb-3 text-sm font-bold text-muted-foreground">
          {t('conversations_recent')}
        </p>
      ) : (
        <>
          <h1 className="text-3xl font-extrabold after:mt-3 after:block after:h-1 after:w-9 after:rounded-full after:bg-orange">
            {t('conversations_title')}
          </h1>
          <form
            className="my-6 grid gap-3 md:grid-cols-[minmax(0,1fr)_15rem]"
            onSubmit={(event) => {
              event.preventDefault();
              setPage(1);
              setSearch(keyword.trim());
            }}
          >
            <div className="flex min-w-0 gap-2">
              <input
                type="search"
                aria-label={t('conversations_search')}
                placeholder={t('conversations_search')}
                maxLength={200}
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                className="moni-field min-w-0 flex-1"
              />
              <Button
                type="submit"
                variant="icon"
                aria-label={t('conversations_search')}
              >
                <IconSearch size={22} aria-hidden />
              </Button>
            </div>
            <Link to="/" search={{ view: 'chat' }} className={buttonVariants()}>
              <IconPlus size={22} aria-hidden />
              {t('app_new_chat')}
            </Link>
          </form>
        </>
      )}
      {failed ? (
        <div role="alert">
          <p className="mb-3 text-sm">{t('conversations_error')}</p>
          <Button
            variant="plain"
            onClick={() => reload().catch(() => setFailed(true))}
          >
            {t('app_retry')}
          </Button>
        </div>
      ) : !data ? (
        <output>{t('probe_loading')}</output>
      ) : !data.items.length ? (
        <p className="py-5 text-muted-foreground">
          {t(search ? 'conversations_no_results' : 'conversations_empty')}
        </p>
      ) : (
        <ul className={recent ? 'space-y-1' : 'space-y-3'}>
          {data.items.map((item, index) => (
            <li key={item.id}>
              {!recent &&
                (index === 0 ||
                  group(data.items[index - 1]) !== group(item)) && (
                  <h2 className="mb-3 mt-6 font-bold text-muted-foreground">
                    {t(group(item))}
                  </h2>
                )}
              <div
                className={`flex items-center gap-2 rounded-2xl ${recent ? '' : 'border border-foreground/30 bg-surface p-2 md:p-3'}`}
              >
                <Link
                  to="/"
                  search={{ view: 'chat', thread: item.id }}
                  className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl focus-visible:outline-4 focus-visible:outline-focus ${recent ? 'p-2 hover:bg-yellow/20' : 'p-3'}`}
                >
                  <span
                    className={
                      recent
                        ? 'shrink-0'
                        : 'flex size-12 shrink-0 items-center justify-center rounded-full bg-yellow/40 text-foreground md:size-16'
                    }
                  >
                    <IconMessageCircle
                      size={recent ? 20 : 26}
                      className="shrink-0"
                      aria-hidden
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold">
                      {item.source === 'wechat' && (
                        <span className="mr-2 rounded-full bg-green/25 px-2 py-1 text-xs">
                          {t('wechat_source')}
                        </span>
                      )}
                      {item.title || t('app_new_chat')}
                    </p>
                    {!recent && (
                      <>
                        <p className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground">
                          {item.preview || t('conversations_no_messages')}
                        </p>
                        <time
                          dateTime={new Date(item.updatedAt).toISOString()}
                          className="mt-2 block text-xs text-muted-foreground"
                        >
                          {new Intl.DateTimeFormat(locale, {
                            timeZone,
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }).format(item.updatedAt)}
                        </time>
                      </>
                    )}
                  </div>
                </Link>
                {!recent && (
                  <Button
                    variant="icon"
                    aria-label={`${t('conversations_delete')} · ${item.title || t('app_new_chat')}`}
                    onClick={() => setDeleting(item)}
                  >
                    <IconTrash size={21} aria-hidden />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {recent ? (
        <Link
          to="/"
          search={{ view: 'chat', panel: 'conversations' }}
          className="mt-2 inline-flex min-h-11 items-center rounded-lg text-sm font-bold focus-visible:outline-4 focus-visible:outline-focus"
        >
          {t('conversations_all')}
        </Link>
      ) : (
        data &&
        data.pageCount > 1 && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="plain"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              {t('query_previous')}
            </Button>
            <output>
              {page} / {data.pageCount}
            </output>
            <Button
              variant="plain"
              disabled={page >= data.pageCount}
              onClick={() => setPage(page + 1)}
            >
              {t('query_next')}
            </Button>
          </div>
        )
      )}
      {!recent && (
        <p className="mt-6 text-sm text-muted-foreground">
          {t('conversations_ledger_kept')}
        </p>
      )}
      {deleting && (
        <DeleteConversation
          key={deleting.id}
          conversation={deleting}
          locale={locale}
          onClose={() => setDeleting(null)}
          onSaved={async () => {
            setDeleting(null);
            onChange();
            await reload();
          }}
        />
      )}
    </section>
  );
}

function DeleteConversation({
  conversation,
  locale,
  onClose,
  onSaved,
}: {
  conversation: LedgerConversation;
  locale: AppLocale;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [operationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const committed = useRef(false);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/45" />
        <Dialog.Popup
          initialFocus={cancel}
          finalFocus={() =>
            committed.current ? document.getElementById('main-content') : true
          }
          className="fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[90dvh] max-w-xl overflow-y-auto rounded-t-2xl border-2 border-ink bg-surface p-5 pb-7 md:inset-x-4 md:bottom-auto md:top-1/2 md:-translate-y-1/2 md:rounded-2xl md:p-8"
        >
          <img
            alt=""
            src="/moni/illustrations/assistant-delete.png"
            className="mx-auto w-32"
          />
          <Dialog.Title className="mt-3 text-2xl font-extrabold">
            {t('conversations_delete_title')}
          </Dialog.Title>
          <Dialog.Description className="my-4 text-muted-foreground">
            {t('conversations_delete_description')}
          </Dialog.Description>
          <p className="my-5 break-words rounded-xl bg-yellow/20 p-4 font-bold">
            {conversation.title || t('app_new_chat')}
          </p>
          {failed && (
            <p role="alert" className="mb-4">
              {t('conversations_delete_error')}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Dialog.Close
              ref={cancel}
              disabled={busy}
              className={buttonVariants({ variant: 'plain' })}
            >
              {t('trash_keep')}
            </Dialog.Close>
            <Button
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                setFailed(false);
                try {
                  await privateApi('conversations/delete', {
                    datasetId: conversation.datasetId,
                    id: conversation.id,
                    version: conversation.version,
                    operationId,
                    confirmed: true,
                  });
                  committed.current = true;
                  await onSaved();
                } catch {
                  setFailed(true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t(busy ? 'app_saving' : 'conversations_delete')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
