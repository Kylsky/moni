import { IconBrandWechat, IconRefresh } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { privateApi } from '@/lib/client-api';
import { type AppLocale, message } from '@/lib/locale';
import type { WechatStatus } from '@/wechat-do';

export function WechatSettings({
  datasetId,
  locale,
  onChange,
  aiConfigured,
}: {
  datasetId: string;
  locale: AppLocale;
  onChange: () => void;
  aiConfigured: boolean;
}) {
  const [status, setStatus] = useState<WechatStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<'disconnect' | 'new-thread' | null>(
    null
  );
  const [verifyCode, setVerifyCode] = useState('');
  const resetId = useRef(crypto.randomUUID());
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  useEffect(() => {
    const controller = new AbortController();
    privateApi<WechatStatus>('wechat', undefined, 'GET', controller.signal)
      .then(setStatus)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);
  const phase = status?.phase;
  const loginId = status?.loginId;
  useEffect(() => {
    if (
      !phase ||
      !loginId ||
      !['waiting', 'scanned', 'binding'].includes(phase)
    )
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await privateApi<WechatStatus>(
          'wechat/check',
          { datasetId, loginId },
          'POST',
          controller.signal
        );
        if (!controller.signal.aborted) {
          setStatus(next);
          setFailed(false);
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [datasetId, phase, loginId]);
  const qr = useMemo(() => {
    if (!status?.qrContent) return null;
    try {
      const value = qrcode(0, 'M');
      value.addData(status.qrContent);
      value.make();
      return value.createDataURL(5, 4);
    } catch {
      return null;
    }
  }, [status?.qrContent]);
  async function act(path: string, body?: object) {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      setStatus(await privateApi<WechatStatus>(path, body));
      setConfirm(null);
      setVerifyCode('');
      onChange();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  const connected = phase === 'connected' || phase === 'thread_deleted';
  const pending =
    phase && ['waiting', 'scanned', 'verify', 'binding'].includes(phase);
  const statusKey =
    phase === 'connected'
      ? 'wechat_connected'
      : phase === 'scanned'
        ? 'wechat_scanned'
        : phase === 'verify'
          ? 'wechat_verify'
          : phase === 'expired'
            ? 'wechat_expired'
            : phase === 'reconnect'
              ? 'wechat_reconnect'
              : phase === 'thread_deleted'
                ? 'wechat_thread_deleted'
                : pending
                  ? 'wechat_waiting'
                  : phase === 'unconfigured'
                    ? 'wechat_unconfigured'
                    : 'wechat_disconnected';
  return (
    <section
      aria-label={t('wechat_title')}
      className="mt-6 rounded-2xl border border-foreground/30 bg-surface p-5 md:p-6"
    >
      <h2 className="flex items-center gap-3 text-xl font-extrabold">
        <IconBrandWechat aria-hidden size={26} />
        {t('wechat_title')}
      </h2>
      <p className="my-3 text-sm text-muted-foreground">
        {t('wechat_description')}
      </p>
      {!aiConfigured && (
        <p className="mb-3 text-sm text-muted-foreground">
          {t('wechat_ai_setup_hint')}
        </p>
      )}
      <output aria-live="polite" className="block font-bold">
        {status ? t(statusKey) : t('probe_loading')}
      </output>
      {qr && pending && (
        <div className="my-5 rounded-xl bg-white p-4 text-center text-black">
          <img
            src={qr}
            alt={t('wechat_qr_alt')}
            className="mx-auto size-60 max-w-full object-contain"
          />
          <p className="mt-3 text-sm">{t('wechat_scan_hint')}</p>
        </div>
      )}
      {phase === 'verify' && (
        <form
          className="my-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void act('wechat/check', { datasetId, loginId, verifyCode });
          }}
        >
          <label className="min-w-0 flex-1 font-bold">
            {t('wechat_verify_label')}
            <input
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{3,12}"
              required
              maxLength={12}
              value={verifyCode}
              onChange={(event) => setVerifyCode(event.target.value)}
              className="moni-field mt-2 w-full"
            />
          </label>
          <Button type="submit" disabled={busy}>
            {t('wechat_verify_submit')}
          </Button>
        </form>
      )}
      {status?.lastError && (
        <output className="mt-3 block text-sm">
          {t(
            status.lastError === 'wechat_reply_failed'
              ? 'wechat_delivery_failed'
              : 'wechat_retrying'
          )}
        </output>
      )}
      {failed && (
        <p role="alert" className="mt-3">
          {t('wechat_error')}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        {status?.configured && !connected && !pending && (
          <Button
            disabled={busy}
            onClick={() => void act('wechat/connect', { datasetId, locale })}
          >
            {t('wechat_connect')}
          </Button>
        )}
        {connected && status?.threadId && phase !== 'thread_deleted' && (
          <Link
            to="/"
            search={{ view: 'chat', thread: status.threadId }}
            className="inline-flex min-h-11 items-center rounded-lg px-3 font-bold underline decoration-orange underline-offset-4 focus-visible:outline-4 focus-visible:outline-focus"
          >
            {t('wechat_open_thread')}
          </Link>
        )}
        {connected && (
          <Button
            variant="plain"
            disabled={busy}
            onClick={() => {
              resetId.current = crypto.randomUUID();
              setConfirm('new-thread');
            }}
          >
            {t('wechat_new_thread')}
          </Button>
        )}
        {(connected || pending || phase === 'reconnect') && (
          <Button
            variant="plain"
            disabled={busy}
            onClick={() => setConfirm('disconnect')}
          >
            {t('wechat_disconnect')}
          </Button>
        )}
        <Button
          variant="icon"
          aria-label={t('wechat_refresh')}
          disabled={busy}
          onClick={() => void act('wechat')}
        >
          <IconRefresh size={21} aria-hidden />
        </Button>
      </div>
      {confirm && (
        <div className="mt-4 rounded-xl border border-foreground/30 bg-yellow/15 p-4">
          <p className="mb-3">
            {t(
              confirm === 'disconnect'
                ? 'wechat_disconnect_hint'
                : 'wechat_reset_hint'
            )}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={busy}
              onClick={() =>
                void act(`wechat/${confirm}`, {
                  datasetId,
                  confirmed: true,
                  ...(confirm === 'new-thread' ? { id: resetId.current } : {}),
                })
              }
            >
              {t(
                confirm === 'disconnect'
                  ? 'wechat_disconnect_confirm'
                  : 'wechat_reset_confirm'
              )}
            </Button>
            <Button
              variant="plain"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              {t('trash_keep')}
            </Button>
          </div>
        </div>
      )}
      <p className="mt-4 text-sm text-muted-foreground">
        {t('wechat_review_hint')}
      </p>
    </section>
  );
}
