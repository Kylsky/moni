import {
  IconAlertTriangle,
  IconCheck,
  IconFileImport,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { RestoreActivation } from '@/components/restore-activation';
import { Button, buttonVariants } from '@/components/ui/button';
import type { RestorePreview } from '@/ledger/restore';
import type { RestoreRecovery } from '@/ledger/restore-session';
import { privateApi } from '@/lib/client-api';
import { limits } from '@/lib/limits';
import { type AppLocale, message } from '@/lib/locale';

export function RestorePreparation({
  datasetId,
  locale,
}: {
  datasetId: string;
  locale: AppLocale;
}) {
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<RestoreRecovery['recovery']>(null);
  const [recovering, setRecovering] = useState(true);
  const [stage, setStage] = useState<1 | 2 | 3>(1);
  const selected = useRef<{
    datasetId: string;
    operationId: string;
    backup: unknown;
  } | null>(null);
  const cancellation = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (returnFocus.current && !busy && !recovering && preview === null) {
      returnFocus.current = false;
      document.getElementById('restore-file')?.focus();
    }
  }, [busy, recovering, preview]);
  useEffect(
    () => () => {
      generation.current++;
      request.current?.abort();
    },
    []
  );
  useEffect(() => {
    const controller = new AbortController();
    const current = generation.current;
    privateApi<RestoreRecovery>(
      'restores/current',
      undefined,
      'GET',
      controller.signal
    )
      .then((result) => {
        if (current !== generation.current) return;
        if (result.datasetId !== datasetId) {
          window.location.reload();
          return;
        }
        if (result.recovery) {
          setRecovered(result.recovery);
          setPreview(result.recovery.preview);
          setStage(2);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && current === generation.current)
          setFailure('restore_recovery_failed');
      })
      .finally(() => {
        if (current === generation.current) setRecovering(false);
      });
    return () => controller.abort();
  }, [datasetId]);
  const reset = () => {
    returnFocus.current = true;
    generation.current++;
    request.current?.abort();
    selected.current = null;
    cancellation.current = null;
    setName('');
    setPreview(null);
    setRecovered(null);
    setStage(1);
    setFailure(null);
    setBusy(false);
    setRecovering(false);
    const input = document.getElementById(
      'restore-file'
    ) as HTMLInputElement | null;
    if (input) input.value = '';
  };

  const prepare = async () => {
    if (!selected.current) return;
    const current = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setFailure(null);
    try {
      while (current === generation.current) {
        const response = await fetch('/api/restores/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(selected.current),
          signal: controller.signal,
        });
        if (current !== generation.current) return;
        if (!response.ok) {
          const error = (await response.json()) as { error?: string };
          setFailure(error.error ?? 'restore_prepare_failed');
          return;
        }
        const next = (await response.json()) as RestorePreview;
        if (current !== generation.current) return;
        setPreview(next);
        if (next.status === 'sealed') {
          requestAnimationFrame(() =>
            document.getElementById('restore-preview')?.focus()
          );
          break;
        }
        if (next.status !== 'loading') {
          setFailure('restore_closed');
          break;
        }
      }
    } catch {
      if (current === generation.current) setFailure('restore_prepare_failed');
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const cancel = async () => {
    if (!preview) return;
    generation.current++;
    request.current?.abort();
    setBusy(true);
    setFailure(null);
    cancellation.current ??= crypto.randomUUID();
    try {
      const response = await fetch('/api/restores/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          datasetId,
          operationId: cancellation.current,
          id: preview.id,
        }),
      });
      if (!response.ok) {
        setFailure('restore_cancel_failed');
        return;
      }
      reset();
    } catch {
      setFailure('restore_cancel_failed');
    } finally {
      setBusy(false);
    }
  };
  const errorKey =
    failure === 'restore_recovery_failed'
      ? 'restore_recovery_error'
      : failure === 'backup_version'
        ? 'restore_version_error'
        : failure === 'backup_money'
          ? 'restore_money_error'
          : failure === 'backup_association'
            ? 'restore_links_error'
            : failure === 'backup_duplicates'
              ? 'restore_duplicates_error'
              : ['backup_too_large', 'request_too_large'].includes(
                    failure ?? ''
                  )
                ? 'restore_size_error'
                : failure === 'restore_cancel_failed'
                  ? 'restore_cancel_error'
                  : [
                        'backup_structure',
                        'backup_inconsistent',
                        'invalid_json',
                      ].includes(failure ?? '')
                    ? 'restore_file_error'
                    : 'restore_prepare_error';
  const counts = [
    ['entries', 'app_entries'],
    ['trash', 'trash_title'],
    ['refunds', 'query_refund'],
    ['categories', 'entry_category'],
    ['tags', 'entry_tags'],
    ['aliases', 'restore_aliases'],
    ['conversations', 'conversations_title'],
    ['deletedConversations', 'restore_deleted_chats'],
    ['messages', 'restore_messages'],
    ['drafts', 'restore_drafts'],
    ['unfinishedRuns', 'restore_unfinished'],
  ] as const;
  return (
    <section
      aria-labelledby="restore-heading"
      className="rounded-2xl border-2 border-foreground bg-surface p-5 md:p-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="flex max-w-xl items-start gap-4">
          <img
            alt=""
            src="/moni/illustrations/assistant-backup.png"
            className="w-20 shrink-0 md:w-28"
          />
          <div>
            <h2 id="restore-heading" className="text-xl font-extrabold">
              3. {t('restore_title')}
            </h2>
            <p className="mt-3 text-muted-foreground">
              {t('restore_description')}
            </p>
          </div>
        </div>
        <div>
          <input
            id="restore-file"
            type="file"
            accept="application/json,.json"
            disabled={busy || recovering || preview !== null}
            className="peer sr-only"
            onChange={async (event) => {
              const file = event.currentTarget.files?.[0];
              if (!file) return;
              event.currentTarget.value = '';
              const readGeneration = ++generation.current;
              setRecovering(false);
              setRecovered(null);
              setStage(1);
              setName(file.name);
              setFailure(null);
              selected.current = null;
              cancellation.current = null;
              if (file.size > limits.backupBytes) {
                setFailure('backup_too_large');
                return;
              }
              setBusy(true);
              try {
                const backup = JSON.parse(
                  new TextDecoder('utf-8', { fatal: true }).decode(
                    await file.arrayBuffer()
                  )
                );
                if (readGeneration !== generation.current) return;
                selected.current = {
                  datasetId,
                  operationId: crypto.randomUUID(),
                  backup,
                };
                await prepare();
              } catch {
                if (readGeneration === generation.current) {
                  setFailure('invalid_json');
                  setBusy(false);
                }
              }
            }}
          />
          <label
            htmlFor="restore-file"
            className={buttonVariants({
              variant: 'plain',
              className:
                'peer-focus-visible:ring-4 peer-focus-visible:ring-focus peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
            })}
          >
            <IconFileImport size={22} aria-hidden />
            {t('restore_choose')}
          </label>
        </div>
      </div>
      {name && <p className="mt-4 break-all text-sm">{name}</p>}
      {recovering && (
        <output className="mt-4 block">{t('restore_loading_recovery')}</output>
      )}
      {failure && (
        <p role="alert" className="mt-4 rounded-xl bg-yellow/20 p-4">
          {t(errorKey)}
        </p>
      )}
      {busy && (
        <output aria-live="polite" className="mt-4 block">
          {t('restore_preparing')}
          {preview ? ` · ${preview.progress} / ${preview.total}` : ''}
        </output>
      )}
      {preview && (
        <div className="mt-6">
          <ol
            aria-label={t('restore_steps')}
            className="mb-5 grid grid-cols-3 gap-3 text-sm font-bold"
          >
            <li
              aria-current={stage === 1 ? 'step' : undefined}
              className={
                stage === 1 ? 'text-orange-strong' : 'text-muted-foreground'
              }
            >
              1. {t('restore_step_preview')}
            </li>
            <li
              aria-current={stage === 2 ? 'step' : undefined}
              className={
                stage === 2 ? 'text-orange-strong' : 'text-muted-foreground'
              }
            >
              2. {t('restore_step_backup')}
            </li>
            <li
              aria-current={stage === 3 ? 'step' : undefined}
              className={
                stage === 3 ? 'text-orange-strong' : 'text-muted-foreground'
              }
            >
              3. {t('restore_step_replace')}
            </li>
          </ol>
          <p className="mb-5 flex items-start gap-3 rounded-xl border border-yellow bg-yellow/20 p-4">
            <IconAlertTriangle className="shrink-0" size={24} aria-hidden />
            <span>
              <strong className="block">{t('restore_replace_warning')}</strong>
              {t('restore_current_unchanged')}
            </span>
          </p>
          <section
            id="restore-preview"
            tabIndex={-1}
            aria-label={t('restore_preview')}
            className="rounded-2xl border border-foreground/30 p-4 focus-visible:outline-4 focus-visible:outline-focus md:p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-xl font-extrabold">{t('restore_preview')}</h3>
              {preview.status === 'sealed' && (
                <span className="inline-flex items-center gap-1 rounded-lg bg-green/25 px-3 py-1 text-sm font-bold">
                  <IconCheck size={18} aria-hidden />
                  {t('restore_valid')}
                </span>
              )}
            </div>
            <dl className="my-5 grid grid-cols-2 gap-3 md:grid-cols-4">
              {counts.map(([field, label]) => (
                <div
                  key={field}
                  className="rounded-xl border border-foreground/15 p-3"
                >
                  <dt className="text-sm text-muted-foreground">{t(label)}</dt>
                  <dd className="mt-1 text-xl font-extrabold tabular-nums">
                    {preview.summary[field]}
                  </dd>
                </div>
              ))}
            </dl>
            <dl className="space-y-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <dt>{t('app_currency')}</dt>
                <dd className="font-bold">{preview.summary.primaryCurrency}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt>{t('app_timezone')}</dt>
                <dd className="font-bold">{preview.summary.timeZone}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt>{t('restore_currencies')}</dt>
                <dd className="font-bold">
                  {preview.summary.currencies.join(', ') || '—'}
                </dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt>{t('restore_date_range')}</dt>
                <dd className="font-bold">
                  {preview.summary.from
                    ? `${preview.summary.from} — ${preview.summary.to}`
                    : '—'}
                </dd>
              </div>
            </dl>
          </section>
          {preview.status === 'sealed' && (
            <RestoreActivation
              key={preview.id}
              preview={preview}
              datasetId={datasetId}
              locale={locale}
              recoveredSession={recovered?.session}
              recoveredExpired={recovered?.expired}
              onStageChange={setStage}
              onCancelPreparation={cancel}
              onCancelled={reset}
            />
          )}
        </div>
      )}
      <div className="mt-5 flex flex-wrap gap-3">
        {failure &&
          failure !== 'restore_cancel_failed' &&
          selected.current &&
          !busy && (
            <Button variant="plain" onClick={prepare}>
              {t('restore_retry')}
            </Button>
          )}
        {preview && preview.status !== 'sealed' && (
          <Button
            variant="plain"
            onClick={cancel}
            disabled={busy && request.current?.signal.aborted}
          >
            {t('restore_cancel')}
          </Button>
        )}
      </div>
    </section>
  );
}
