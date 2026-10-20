import { IconRobot } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AiSettings as Settings } from '@/lib/ai-settings';
import { ApiError, privateApi } from '@/lib/client-api';
import { type AppLocale, message } from '@/lib/locale';

export function AiSettings({
  locale,
  onSaved,
}: {
  locale: AppLocale;
  onSaved: () => void;
}) {
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [baseURL, setBaseURL] = useState('');
  const [model, setModel] = useState('');
  const [api, setApi] = useState<Settings['api']>('chat-completions');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'saved' | 'tested' | 'cleared' | null>(
    null
  );
  const [error, setError] = useState<'failed' | 'conflict' | 'test' | null>(
    null
  );
  const [confirmClear, setConfirmClear] = useState(false);
  const accept = useCallback((value: Settings) => {
    setSettings(value);
    setBaseURL(value.baseURL);
    setModel(value.model);
    setApi(value.api);
    setApiKey('');
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    privateApi<Settings>('ai', undefined, 'GET', controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) accept(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('failed');
      });
    return () => controller.abort();
  }, [accept]);
  const dirty = () => {
    setResult(null);
    setError(null);
    setConfirmClear(false);
  };
  async function act(action: 'save' | 'test' | 'clear') {
    if (busy || !settings) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (action === 'test') {
        await privateApi('ai/test', {
          baseURL,
          model,
          api,
          apiKey,
          version: settings.version,
        });
        setResult('tested');
      } else {
        accept(
          await privateApi<Settings>(
            'ai',
            action === 'clear'
              ? { version: settings.version, confirmed: true }
              : { baseURL, model, api, apiKey, version: settings.version },
            action === 'clear' ? 'DELETE' : 'PUT'
          )
        );
        setResult(action === 'clear' ? 'cleared' : 'saved');
        setConfirmClear(false);
        await onSaved();
      }
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? 'conflict'
          : action === 'test'
            ? 'test'
            : 'failed'
      );
      if (failure instanceof ApiError && failure.status === 409) {
        // Refresh only the version/status; keep unsaved fields for the owner to review.
        try {
          setSettings(await privateApi<Settings>('ai'));
        } catch {
          /* Keep the visible error. */
        }
      }
    } finally {
      setBusy(false);
    }
  }
  const ready = Boolean(settings?.editable);
  let canKeepKey = false;
  try {
    canKeepKey = Boolean(
      settings?.configured &&
        new URL(baseURL).origin === new URL(settings.baseURL).origin
    );
  } catch {
    /* A partial URL cannot reuse the saved key. */
  }
  return (
    <section
      aria-label={t('app_ai_assistant')}
      className="mt-6 rounded-2xl border border-foreground/30 bg-surface p-5 md:p-6"
    >
      <h2 className="flex items-center gap-3 text-xl font-extrabold">
        <IconRobot aria-hidden size={26} />
        {t('app_ai_assistant')}
      </h2>
      <p className="my-3 text-sm text-muted-foreground">
        {t('ai_settings_hint')}
      </p>
      <output aria-live="polite" className="block font-bold">
        {settings
          ? t(settings.configured ? 'app_configured' : 'app_not_configured')
          : t('probe_loading')}
      </output>
      {settings && !ready && (
        <p role="alert" className="mt-3">
          {t('ai_setup_missing')}
        </p>
      )}
      {settings?.unreadable && (
        <p role="alert" className="mt-3">
          {t('ai_unreadable')}
        </p>
      )}
      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void act('save');
        }}
      >
        <fieldset disabled={busy || !ready} className="space-y-4">
          <label className="block font-bold">
            {t('ai_base_url')}
            <input
              type="url"
              required
              maxLength={2048}
              value={baseURL}
              onChange={(event) => {
                setBaseURL(event.target.value);
                dirty();
              }}
              className="moni-field mt-2 w-full"
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <div className="font-bold">
            <label htmlFor="ai-protocol">{t('ai_api')}</label>
            <select
              id="ai-protocol"
              value={api}
              onChange={(event) => {
                setApi(event.target.value as Settings['api']);
                dirty();
              }}
              className="moni-field mt-2 w-full"
            >
              <option value="chat-completions">Chat Completions</option>
              <option value="responses">Responses</option>
            </select>
          </div>
          <label className="block font-bold">
            {t('ai_model')}
            <input
              required
              maxLength={200}
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                dirty();
              }}
              className="moni-field mt-2 w-full"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="block font-bold">
            {t('ai_api_key')}
            <input
              type="password"
              required={!canKeepKey}
              maxLength={8192}
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                dirty();
              }}
              className="moni-field mt-2 w-full"
              autoComplete="new-password"
              placeholder={settings?.configured ? t('ai_keep_key') : ''}
              aria-describedby="ai-key-hint"
            />
          </label>
          <p id="ai-key-hint" className="text-sm text-muted-foreground">
            {t('ai_key_hint')}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button type="submit">
              {busy ? t('app_saving') : t('ai_save')}
            </Button>
            <Button
              type="button"
              variant="plain"
              disabled={!baseURL || !model || (!apiKey && !canKeepKey)}
              onClick={() => void act('test')}
            >
              {t('ai_test')}
            </Button>
          </div>
        </fieldset>
      </form>
      {settings?.configured && (
        <Button
          className="mt-4"
          variant="plain"
          disabled={busy}
          onClick={() => setConfirmClear(true)}
        >
          {t('ai_clear')}
        </Button>
      )}
      {confirmClear && (
        <div className="mt-4 rounded-xl border border-foreground/30 bg-yellow/15 p-4">
          <p>{t('ai_clear_hint')}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Button disabled={busy} onClick={() => void act('clear')}>
              {t('ai_clear_confirm')}
            </Button>
            <Button
              variant="plain"
              disabled={busy}
              onClick={() => setConfirmClear(false)}
            >
              {t('entry_cancel')}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3">
          {t(
            error === 'conflict'
              ? 'ai_conflict'
              : error === 'test'
                ? 'ai_test_failed'
                : 'ai_save_failed'
          )}
        </p>
      )}
      {result && (
        <output aria-live="polite" className="mt-3 block text-positive">
          {t(
            result === 'saved'
              ? 'ai_saved'
              : result === 'tested'
                ? 'ai_tested'
                : 'ai_cleared'
          )}
        </output>
      )}
    </section>
  );
}
