import { Dialog } from '@base-ui/react/dialog';
import { IconTrash } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import type { Entry } from '@/ledger/entries';
import { displayMoney } from '@/ledger/money';
import type { EntryTransition } from '@/ledger/trash';
import { privateApi } from '@/lib/client-api';
import { type AppLocale, message } from '@/lib/locale';

export function EntryConfirmation({
  entry,
  datasetId,
  action,
  locale,
  onClose,
  onSaved,
}: {
  entry: Entry;
  datasetId: string;
  action: Exclude<EntryTransition, 'restore'>;
  locale: AppLocale;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [operationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const committed = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
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
          className="fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[90dvh] max-w-xl overflow-y-auto overscroll-contain rounded-t-2xl border-2 border-ink bg-surface p-5 pb-7 md:inset-x-4 md:bottom-auto md:top-1/2 md:-translate-y-1/2 md:rounded-2xl md:p-8"
        >
          <Dialog.Title className="text-2xl font-extrabold">
            {t(action === 'purge' ? 'trash_purge_title' : 'trash_delete_title')}
          </Dialog.Title>
          <Dialog.Description className="mt-4 text-muted-foreground">
            {t(
              action === 'purge'
                ? 'trash_purge_description'
                : 'trash_delete_description'
            )}
          </Dialog.Description>
          <div className="my-6 flex items-center gap-3 rounded-xl bg-yellow/15 p-4">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-yellow/30">
              <IconTrash size={23} aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="mb-1 text-sm text-muted-foreground">
                {t(
                  entry.kind === 'refund'
                    ? 'query_refund'
                    : entry.kind === 'income'
                      ? 'entry_income'
                      : 'entry_expense'
                )}
              </p>
              <p className="break-words font-extrabold">{entry.name}</p>
              <p className="mt-1 break-words tabular-nums">
                {displayMoney(entry.originalMinor, entry.currency, locale)} /{' '}
                {entry.date}
              </p>
            </div>
          </div>
          {entry.kind === 'expense' && (
            <p className="mb-5 text-sm text-muted-foreground">
              {t('refund_delete_hint')}
            </p>
          )}
          {error && (
            <p role="alert" className="mb-5 font-bold">
              {t('trash_action_error')}
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
                setError(false);
                try {
                  await privateApi(`entries/${action}`, {
                    datasetId,
                    id: entry.id,
                    version: entry.version,
                    operationId,
                    confirmed: true,
                  });
                  committed.current = true;
                  await onSaved();
                } catch {
                  setError(true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t(
                busy
                  ? 'app_saving'
                  : action === 'purge'
                    ? 'trash_purge'
                    : 'trash_delete'
              )}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
