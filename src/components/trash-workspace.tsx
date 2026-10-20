import {
  IconArrowLeft,
  IconChevronLeft,
  IconChevronRight,
  IconRestore,
  IconTrash,
} from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EntryConfirmation } from '@/components/entry-confirmation';
import { Button } from '@/components/ui/button';
import type { Entry } from '@/ledger/entries';
import type { EntryPage } from '@/ledger/entry-query';
import { displayMoney } from '@/ledger/money';
import { categoryLabel } from '@/lib/category-label';
import { privateApi } from '@/lib/client-api';
import { type AppLocale, message } from '@/lib/locale';

export function TrashWorkspace({
  datasetId,
  locale,
}: {
  datasetId: string;
  locale: AppLocale;
}) {
  const [data, setData] = useState<EntryPage | null>(null);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);
  const [selection, setSelection] = useState<{
    entry: Entry;
    action: 'purge';
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const operation = useRef<{ value: string; id: string } | null>(null);
  const sequence = useRef(0);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const load = useCallback(async () => {
    const generation = ++sequence.current;
    const result = await privateApi<EntryPage>('trash/query', { page });
    if (generation !== sequence.current) return;
    if (result.datasetId !== datasetId) throw new Error('dataset_changed');
    if (!result.items.length && page > 1) {
      setPage(page - 1);
      return;
    }
    setData(result);
    setFailed(false);
  }, [datasetId, page]);
  useEffect(() => {
    setData(null);
    load().catch(() => setFailed(true));
    return () => {
      sequence.current++;
    };
  }, [load]);
  return (
    <>
      <Link
        to="/"
        search={{ view: 'settings' }}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg font-bold focus-visible:outline-4 focus-visible:outline-focus"
      >
        <IconArrowLeft size={20} aria-hidden />
        {t('app_settings')}
      </Link>
      <h1 className="mt-2 text-3xl font-extrabold">{t('trash_title')}</h1>
      <p className="my-5 text-muted-foreground">{t('trash_description')}</p>
      {actionFailed && (
        <p role="alert" className="mb-4 font-bold">
          {t('trash_action_error')}
        </p>
      )}
      {failed ? (
        <div>
          <p role="alert" className="mb-4">
            {t('entry_load_error')}
          </p>
          <Button onClick={() => load().catch(() => setFailed(true))}>
            {t('app_retry')}
          </Button>
        </div>
      ) : !data ? (
        <output>{t('probe_loading')}</output>
      ) : !data.items.length ? (
        <div className="py-10 text-center">
          <img
            src="/moni/illustrations/assistant-delete.png"
            alt=""
            className="mx-auto w-40"
          />
          <h2 className="mt-4 text-xl font-bold">{t('trash_empty')}</h2>
        </div>
      ) : (
        <ul className="divide-y divide-muted rounded-2xl border border-foreground/40 bg-surface px-4 md:px-6">
          {data.items.map((entry) => (
            <li key={entry.id} className="py-5">
              <div className="flex flex-wrap items-start gap-3">
                <details className="min-w-0 flex-1">
                  <summary className="min-h-11 cursor-pointer break-words rounded-lg font-extrabold focus-visible:outline-4 focus-visible:outline-focus">
                    {entry.kind === 'refund' && (
                      <span className="mr-2 rounded-full bg-green/20 px-2 py-1 text-sm">
                        {t('query_refund')}
                      </span>
                    )}
                    {entry.name}
                  </summary>
                  <dl className="my-3 space-y-2 text-sm">
                    <dt className="font-bold">{t('entry_note')}</dt>
                    <dd className="whitespace-pre-wrap break-words">
                      {entry.note || t('entry_no_note')}
                    </dd>
                    <dt className="font-bold">{t('entry_date')}</dt>
                    <dd>{entry.date}</dd>
                    <dt className="font-bold">{t('entry_category')}</dt>
                    <dd className="break-words">
                      {categoryLabel(
                        entry.categoryName,
                        entry.categoryKey,
                        locale
                      )}
                    </dd>
                    <dt className="font-bold">{t('entry_tags')}</dt>
                    <dd className="break-words">
                      {entry.tags.map((tag) => tag.name).join(' · ') || '—'}
                    </dd>
                  </dl>
                </details>
                <div className="max-w-full text-right">
                  <p className="break-words font-extrabold tabular-nums">
                    {displayMoney(entry.originalMinor, entry.currency, locale)}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('trash_deleted_on')}{' '}
                    {entry.deletedAt
                      ? new Intl.DateTimeFormat(locale, {
                          dateStyle: 'medium',
                        }).format(entry.deletedAt)
                      : ''}
                  </p>
                </div>
                <div className="flex gap-2 max-md:w-full max-md:justify-end">
                  <Button
                    variant="plain"
                    aria-label={`${t('trash_restore')} ${entry.name}`}
                    disabled={busy}
                    onClick={async () => {
                      if (busy) return;
                      const body = {
                        datasetId,
                        id: entry.id,
                        version: entry.version,
                        confirmed: true,
                      };
                      const value = JSON.stringify(body);
                      if (operation.current?.value !== value)
                        operation.current = { value, id: crypto.randomUUID() };
                      setBusy(true);
                      setActionFailed(false);
                      try {
                        await privateApi('entries/restore', {
                          ...body,
                          operationId: operation.current.id,
                        });
                        await load();
                        document.getElementById('main-content')?.focus();
                      } catch {
                        setActionFailed(true);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <IconRestore size={20} aria-hidden />
                    {t('trash_restore')}
                  </Button>
                  <Button
                    variant="icon"
                    aria-label={`${t('trash_purge')} ${entry.name}`}
                    disabled={busy}
                    onClick={() => setSelection({ entry, action: 'purge' })}
                  >
                    <IconTrash size={21} aria-hidden />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {data && (data.pageCount > 1 || page > 1) && (
        <nav
          aria-label={t('query_pagination')}
          className="mt-6 flex flex-wrap items-center justify-center gap-4"
        >
          <Button
            variant="plain"
            disabled={busy || page <= 1}
            onClick={() => setPage(page - 1)}
          >
            <IconChevronLeft size={20} aria-hidden />
            {t('query_previous')}
          </Button>
          <span>
            {page} / {Math.max(1, data.pageCount)}
          </span>
          <Button
            variant="plain"
            disabled={busy || page >= data.pageCount}
            onClick={() => setPage(page + 1)}
          >
            {t('query_next')}
            <IconChevronRight size={20} aria-hidden />
          </Button>
        </nav>
      )}
      {selection && (
        <EntryConfirmation
          key={`${selection.action}:${selection.entry.id}`}
          {...selection}
          datasetId={datasetId}
          locale={locale}
          onClose={() => setSelection(null)}
          onSaved={async () => {
            await load();
            setSelection(null);
          }}
        />
      )}
    </>
  );
}
