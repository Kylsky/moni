import { Dialog } from '@base-ui/react/dialog';
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { DownloadButton } from '@/components/download-button';
import { Button, buttonVariants } from '@/components/ui/button';
import type { RestorePreview } from '@/ledger/restore';
import type {
  RestoreRecovery,
  RestoreSessionView,
} from '@/ledger/restore-session';
import { ApiError, privateApi } from '@/lib/client-api';
import { type AppLocale, message } from '@/lib/locale';

export function RestoreActivation({
  preview,
  datasetId,
  locale,
  recoveredSession,
  recoveredExpired = false,
  onStageChange,
  onCancelPreparation,
  onCancelled,
}: {
  preview: RestorePreview;
  datasetId: string;
  locale: AppLocale;
  recoveredSession?: RestoreSessionView | null;
  recoveredExpired?: boolean;
  onStageChange: (step: 2 | 3) => void;
  onCancelPreparation: () => Promise<void>;
  onCancelled: () => void;
}) {
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const [session, setSession] = useState<RestoreSessionView | null>(
    recoveredSession ?? null
  );
  const [serverExpired, setServerExpired] = useState(recoveredExpired);
  const [receipt, setReceipt] = useState<{
    digest: string;
    revision: number;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<
    'begin' | 'cancel' | 'confirm' | 'locked' | null
  >(null);
  const [dialog, setDialog] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const beginId = useRef(crypto.randomUUID());
  const abortId = useRef(crypto.randomUUID());
  const confirmId = useRef(crypto.randomUUID());
  const cancelFocus = useRef<HTMLButtonElement>(null);
  const expired = Boolean(
    session && (serverExpired || session.expiresAt <= clock)
  );
  const previewExpired = preview.expiresAt <= clock;
  const ready = Boolean(
    session && receipt && saved && !expired && !previewExpired
  );
  useEffect(() => {
    const deadline = session?.expiresAt ?? preview.expiresAt;
    const timer = setTimeout(
      () => {
        setClock(Date.now());
        setSaved(false);
        setReceipt(null);
        if (session) onStageChange(2);
      },
      Math.max(0, deadline - Date.now() + 10)
    );
    return () => clearTimeout(timer);
  }, [session, preview.expiresAt, onStageChange]);
  useEffect(() => {
    if (session) onStageChange(2);
  }, [session, onStageChange]);

  const begin = async () => {
    setBusy(true);
    setFailure(null);
    if (expired) beginId.current = crypto.randomUUID();
    try {
      const next = await privateApi<RestoreSessionView>('restores/begin', {
        datasetId,
        operationId: beginId.current,
        preparationId: preview.id,
        digest: preview.digest,
      });
      setSession(next);
      setServerExpired(false);
      setReceipt(null);
      setSaved(false);
      setClock(Date.now());
      abortId.current = crypto.randomUUID();
      confirmId.current = crypto.randomUUID();
    } catch (error) {
      setFailure(
        error instanceof ApiError && error.status === 423 ? 'locked' : 'begin'
      );
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    setFailure(null);
    try {
      let current = session;
      if (!current) {
        const recovery = await privateApi<RestoreRecovery>('restores/current');
        if (recovery.datasetId !== datasetId)
          throw new Error('Dataset changed');
        if (recovery.recovery?.preview.id === preview.id)
          current = recovery.recovery.session;
      }
      if (!current) await onCancelPreparation();
      else {
        await privateApi('restores/abort', {
          datasetId,
          operationId: abortId.current,
          id: current.id,
          token: current.token,
        });
        onCancelled();
      }
    } catch {
      setFailure('cancel');
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!ready || !session || !receipt || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await privateApi<{ restored: boolean; datasetId: string }>(
        'restores/commit',
        {
          datasetId,
          operationId: confirmId.current,
          id: session.id,
          token: session.token,
          digest: preview.digest,
          backupDigest: receipt.digest,
          backupRevision: receipt.revision,
          savedBackup: true,
          confirmed: true,
        }
      );
      if (
        !result.restored ||
        !result.datasetId ||
        result.datasetId === datasetId
      )
        throw new Error('Unconfirmed restoration');
      // A full reload drops every old dataset response, editor and stream before showing the restored ledger.
      window.location.assign('/?view=entries');
    } catch {
      setFailure('confirm');
      setBusy(false);
    }
  };
  return (
    <div className="mt-5">
      {(expired || previewExpired) && (
        <p role="alert" className="mb-4 rounded-xl bg-yellow/20 p-4">
          {t(
            previewExpired ? 'restore_preview_expired' : 'restore_lock_expired'
          )}
        </p>
      )}
      {!previewExpired && (!session || expired) && (
        <Button disabled={busy} onClick={begin}>
          {t(busy ? 'app_saving' : 'restore_begin')}
        </Button>
      )}
      {session && !expired && !previewExpired && (
        <section
          aria-labelledby="restore-current-heading"
          className="rounded-2xl border border-foreground/30 p-4 md:p-5"
        >
          <h3 id="restore-current-heading" className="text-xl font-extrabold">
            {t('restore_save_current_title')}
          </h3>
          <p className="my-4 flex items-start gap-2 rounded-xl bg-yellow/20 p-4">
            <IconAlertTriangle size={22} className="shrink-0" aria-hidden />
            <span>
              {t('restore_lock_notice')}
              <br />
              {t('restore_lock_until')}{' '}
              {new Intl.DateTimeFormat(locale, {
                dateStyle: 'short',
                timeStyle: 'short',
              }).format(session.expiresAt)}
            </span>
          </p>
          <DownloadButton
            path="restores/current-backup"
            body={{ datasetId, id: session.id, token: session.token }}
            datasetId={datasetId}
            filename="moni-current-before-restore.json"
            label={t('restore_download_current')}
            locale={locale}
            primary
            disabled={busy || dialog}
            onDownloaded={(headers) => {
              const digest = headers.get('X-Moni-Restore-Digest');
              const revision = Number(headers.get('X-Moni-Revision'));
              if (
                !digest ||
                !/^[a-f0-9]{64}$/.test(digest) ||
                !headers.has('X-Moni-Revision') ||
                !Number.isSafeInteger(revision) ||
                revision < 0
              )
                throw new Error('Backup receipt missing');
              setReceipt({ digest, revision });
              setSaved(false);
              confirmId.current = crypto.randomUUID();
              onStageChange(2);
            }}
          />
          <p className="my-3 break-all text-sm text-muted-foreground">
            moni-current-before-restore.json
          </p>
          {receipt && (
            <p className="my-3 flex items-start gap-2 text-sm">
              <IconCheck size={20} className="shrink-0" aria-hidden />
              {t('restore_download_hint')}
            </p>
          )}
          <label className="mt-5 flex min-h-12 cursor-pointer items-start gap-3 rounded-lg p-2 focus-within:outline-4 focus-within:outline-focus">
            <input
              type="checkbox"
              className="mt-1 size-5 shrink-0 accent-orange"
              checked={saved}
              disabled={!receipt || busy}
              onChange={(event) => {
                setSaved(event.target.checked);
                onStageChange(event.target.checked ? 3 : 2);
              }}
            />
            <span className="font-bold">{t('restore_saved_checkbox')}</span>
          </label>
          <Button
            id="restore-final-review"
            className="mt-4 w-full md:w-auto"
            disabled={!ready || busy}
            onClick={() => {
              setFailure(null);
              setDialog(true);
            }}
          >
            {t('restore_review_replace')}
          </Button>
        </section>
      )}
      {failure && !dialog && (
        <p role="alert" className="my-4 rounded-xl bg-yellow/20 p-4">
          {t(
            failure === 'locked'
              ? 'restore_other_lock'
              : failure === 'cancel'
                ? 'restore_activation_cancel_error'
                : 'restore_begin_error'
          )}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          id="restore-cancel-activation"
          variant="plain"
          disabled={busy}
          onClick={cancel}
        >
          {t('restore_cancel')}
        </Button>
        {failure && (
          <a
            className={buttonVariants({ variant: 'plain' })}
            href="/?view=settings&panel=backup"
          >
            {t('restore_reload_current')}
          </a>
        )}
      </div>
      <Dialog.Root
        open={dialog}
        onOpenChange={(open) => {
          if (!busy) setDialog(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/45" />
          <Dialog.Popup
            initialFocus={cancelFocus}
            finalFocus={() => {
              const trigger = document.getElementById(
                'restore-final-review'
              ) as HTMLButtonElement | null;
              return trigger && !trigger.disabled
                ? trigger
                : document.getElementById('restore-cancel-activation');
            }}
            className="fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[90dvh] max-w-xl overflow-y-auto rounded-t-2xl border-2 border-ink bg-surface p-5 pb-7 md:inset-x-4 md:bottom-auto md:top-1/2 md:-translate-y-1/2 md:rounded-2xl md:p-8"
          >
            <img
              alt=""
              src="/moni/illustrations/assistant-warning.png"
              className="mx-auto w-28"
            />
            <Dialog.Title className="mt-3 text-2xl font-extrabold">
              {t('restore_confirm_title')}
            </Dialog.Title>
            <Dialog.Description className="my-4 text-muted-foreground">
              {t('restore_confirm_description')}
            </Dialog.Description>
            <dl className="my-5 grid grid-cols-2 gap-3 rounded-xl bg-yellow/20 p-4">
              {(
                [
                  ['app_entries', preview.summary.entries],
                  ['trash_title', preview.summary.trash],
                  ['conversations_title', preview.summary.conversations],
                  ['app_currency', preview.summary.primaryCurrency],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-sm">{t(label)}</dt>
                  <dd className="mt-1 font-extrabold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mb-5 text-sm text-muted-foreground">
              {t('restore_archive_hint')}
            </p>
            {(expired || previewExpired) && (
              <p role="alert" className="mb-4">
                {t(
                  previewExpired
                    ? 'restore_preview_expired'
                    : 'restore_lock_expired'
                )}
              </p>
            )}
            {failure === 'confirm' && (
              <p role="alert" className="mb-4">
                {t('restore_confirm_error')}
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Dialog.Close
                ref={cancelFocus}
                disabled={busy}
                className={buttonVariants({ variant: 'plain' })}
              >
                {t('restore_keep_current')}
              </Dialog.Close>
              <Button disabled={!ready || busy} onClick={confirm}>
                {t(busy ? 'app_saving' : 'restore_confirm_replace')}
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
