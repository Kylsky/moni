import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { PostingPolicy } from '@/ledger/posting-policy';
import { privateApi } from '@/lib/client-api';
import { type AppLocale, message } from '@/lib/locale';

export function PostingPermissions({
  datasetId,
  locale,
  onSaved,
}: {
  datasetId: string;
  locale: AppLocale;
  onSaved: () => Promise<void>;
}) {
  const [policy, setPolicy] = useState<PostingPolicy | null>(null);
  const [mode, setMode] = useState<PostingPolicy['mode']>('review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const operation = useRef<{ value: string; id: string } | null>(null);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  useEffect(() => {
    const controller = new AbortController();
    privateApi<PostingPolicy>(
      'posting-policy',
      undefined,
      'GET',
      controller.signal
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setPolicy(value);
          setMode(value.mode);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, []);
  return (
    <form
      aria-label={t('posting_permissions')}
      className="mt-6 space-y-4 rounded-2xl border border-foreground/40 bg-surface p-4 text-left md:p-6"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!policy || busy) return;
        setBusy(true);
        setError(false);
        setSaved(false);
        const payload = {
          datasetId,
          mode,
          version: policy.version,
          confirmed: true,
        };
        const value = JSON.stringify(payload);
        if (operation.current?.value !== value)
          operation.current = { value, id: crypto.randomUUID() };
        try {
          await privateApi('posting-policy', {
            ...payload,
            operationId: operation.current.id,
          });
          const current = await privateApi<PostingPolicy>('posting-policy');
          setPolicy(current);
          setMode(current.mode);
          setSaved(true);
          await onSaved();
        } catch {
          setError(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset
        disabled={busy || !policy}
        aria-describedby="posting-permissions-hint"
        className="space-y-3"
      >
        <legend className="mb-3 text-lg font-extrabold">
          {t('posting_permissions')}
        </legend>
        <p
          id="posting-permissions-hint"
          className="text-sm text-muted-foreground"
        >
          {t('posting_permissions_hint')}
        </p>
        {(['review', 'automatic'] as const).map((value) => (
          <label
            key={value}
            className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border p-3 ${mode === value ? 'border-orange bg-orange/5' : 'border-muted'}`}
          >
            <input
              type="radio"
              name="posting-permission"
              value={value}
              checked={mode === value}
              onChange={() => {
                setMode(value);
                setSaved(false);
              }}
              className="mt-1 size-5 shrink-0 accent-orange"
            />
            <span>
              <span className="block font-bold">
                {t(value === 'review' ? 'posting_review' : 'posting_automatic')}
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                {t(
                  value === 'review'
                    ? 'posting_review_hint'
                    : 'posting_automatic_hint'
                )}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <Button type="submit" disabled={busy || !policy}>
        {t(busy ? 'app_saving' : 'posting_save')}
      </Button>
      <output className="block text-sm">{saved ? t('app_saved') : ''}</output>
      {error && (
        <p role="alert" className="text-sm">
          {t('posting_save_error')}
        </p>
      )}
    </form>
  );
}
