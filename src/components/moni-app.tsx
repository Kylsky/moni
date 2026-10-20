import {
  IconChartBar,
  IconCheck,
  IconChevronRight,
  IconCurrencyYuan,
  IconLanguage,
  IconMessageCircle,
  IconNotebook,
  IconPlus,
  IconRobot,
  IconSettings,
  IconWorld,
} from '@tabler/icons-react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { AiSettings } from '@/components/ai-settings';
import { AppLanguageSwitcher } from '@/components/app-language-switcher';
import { BackupWorkspace } from '@/components/backup-workspace';
import { ChatWorkspace } from '@/components/chat-workspace';
import { ConversationList } from '@/components/conversation-list';
import { EntryWorkspace } from '@/components/entry-workspace';
import { ThemeSwitcher } from '@/components/layout/theme-switcher';
import { MoniBrand } from '@/components/moni-brand';
import { PostingPermissions } from '@/components/posting-permissions';
import {
  ReportWorkspace,
  type reportOptions,
} from '@/components/report-workspace';
import { TaxonomyWorkspace } from '@/components/taxonomy-workspace';
import { TrashWorkspace } from '@/components/trash-workspace';
import { Button } from '@/components/ui/button';
import { WechatSettings } from '@/components/wechat-settings';
import { type LanguagePreference, useAppLocale } from '@/hooks/use-app-locale';
import { currencies } from '@/ledger/currencies';
import type { EntryFilters } from '@/ledger/entry-query';
import type { LedgerSettings } from '@/ledger/settings';
import { privateApi } from '@/lib/client-api';
import { type AppLocale, message } from '@/lib/locale';

export type AppView = 'chat' | 'entries' | 'reports' | 'settings';
type Settings = LedgerSettings & {
  aiConfigured: boolean;
  postingMode: 'review' | 'automatic';
};
const navigation = [
  { view: 'chat', key: 'app_chat', Icon: IconMessageCircle },
  { view: 'entries', key: 'app_entries', Icon: IconNotebook },
  { view: 'reports', key: 'app_reports', Icon: IconChartBar },
  { view: 'settings', key: 'app_settings', Icon: IconSettings },
] as const;

export function MoniApp({
  view = 'chat',
  entryId,
  editing,
  initialLocale,
  panel,
  filters,
  report,
  threadId,
}: {
  view?: AppView;
  entryId?: string;
  editing?: boolean;
  initialLocale?: AppLocale;
  panel?: 'taxonomy' | 'trash' | 'conversations' | 'backup';
  filters?: EntryFilters;
  report?: z.infer<typeof reportOptions>;
  threadId?: string;
}) {
  const language = useAppLocale(initialLocale);
  const { locale } = language;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [failed, setFailed] = useState(false);
  const [conversationRevision, setConversationRevision] = useState(0);
  const conversationsChanged = useCallback(
    () => setConversationRevision((value) => value + 1),
    []
  );
  const navigate = useNavigate();
  const refresh = useCallback(async () => {
    const result = await privateApi<Settings>('settings');
    setSettings(result);
    setFailed(false);
  }, []);
  useEffect(() => {
    refresh().catch(() => setFailed(true));
  }, [refresh]);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  if (failed)
    return (
      <main id="main-content" className="mx-auto max-w-xl px-5 py-16">
        <MoniBrand />
        <img
          alt=""
          src="/moni/illustrations/assistant-lock.png"
          className="mx-auto w-52"
        />
        <h1 className="text-3xl font-extrabold">{t('app_access_title')}</h1>
        <p role="alert" className="my-5">
          {t('app_load_error')}
        </p>
        <Button onClick={() => refresh().catch(() => setFailed(true))}>
          {t('app_retry')}
        </Button>
      </main>
    );
  if (!settings)
    return (
      <main id="main-content" className="mx-auto max-w-xl p-8">
        <MoniBrand />
        <output className="mt-12">{t('probe_loading')}</output>
      </main>
    );
  if (!settings.initialized)
    return (
      <main id="main-content" className="min-h-dvh px-5 py-6 md:px-10">
        <MoniBrand />
        <section className="mx-auto max-w-2xl pb-8 text-center md:pt-3">
          <img
            alt=""
            src="/moni/illustrations/assistant-writing.png"
            className="mx-auto w-36 md:w-48"
          />
          <h1 className="text-3xl font-extrabold md:text-4xl">
            {t('app_initialize_title')}
          </h1>
          <p className="mt-3 text-muted-foreground">
            {t('app_initialize_description')}
          </p>
          <p className="mx-auto mb-3 mt-4 flex max-w-lg items-center justify-center gap-2 rounded-xl bg-green/25 px-4 py-2 font-bold">
            <IconCheck aria-hidden size={22} />
            {t('app_verified')}
          </p>
          <SettingsForm
            settings={settings}
            locale={locale}
            language={language}
            onSaved={refresh}
            initialize
          />
          <details className="mt-5 text-left text-sm text-muted-foreground">
            <summary className="mx-auto min-h-11 w-fit cursor-pointer py-2 font-bold focus-visible:outline-4 focus-visible:outline-focus">
              {t('app_configuration_help')}
            </summary>
            <p className="rounded-xl border border-muted p-4">
              {t('app_configuration_description')}
            </p>
          </details>
        </section>
      </main>
    );
  return (
    <div className="min-h-dvh md:flex">
      <a href="#main-content" className="moni-skip">
        {t('skip_to_content')}
      </a>
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-muted p-6 md:flex">
        <div className="flex items-center justify-between gap-2">
          <Link to="/" search={{ view: 'chat' }} aria-label="Moni">
            <MoniBrand />
          </Link>
          <AppLanguageSwitcher language={language} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('app_private_ledger')}
        </p>
        <Button
          className="my-7 w-full"
          onClick={() => navigate({ to: '/', search: { view: 'chat' } })}
        >
          <IconPlus size={22} aria-hidden />
          {t('app_new_chat')}
        </Button>
        <nav
          aria-label={t('app_navigation')}
          className="flex min-h-0 flex-1 flex-col gap-3"
        >
          {navigation.map(({ view: target, key, Icon }) => (
            <Fragment key={target}>
              <Link
                to="/"
                search={{ view: target }}
                aria-current={view === target ? 'page' : undefined}
                className={`moni-nav ${target === 'settings' ? 'mt-auto' : ''} ${view === target ? 'moni-nav-active' : ''}`}
              >
                <Icon size={24} aria-hidden />
                {t(key)}
              </Link>
              {target === 'reports' && view === 'chat' && (
                <ConversationList
                  datasetId={settings.datasetId}
                  locale={locale}
                  timeZone={settings.timeZone}
                  revision={conversationRevision}
                  recent
                  onChange={conversationsChanged}
                />
              )}
            </Fragment>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between px-5 pt-4 md:hidden">
          <Link to="/" search={{ view: 'chat' }} aria-label="Moni">
            <MoniBrand />
          </Link>
          <span className="text-sm text-muted-foreground">
            {t('app_private_ledger')}
          </span>
          <AppLanguageSwitcher language={language} />
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto min-h-[calc(100dvh-5rem)] max-w-6xl px-5 pb-28 pt-5 outline-none md:min-h-dvh md:px-9 md:pb-9 md:pt-8"
        >
          {view === 'settings' && panel === 'trash' ? (
            <TrashWorkspace
              key={settings.datasetId}
              datasetId={settings.datasetId}
              locale={locale}
            />
          ) : view === 'settings' && panel === 'taxonomy' ? (
            <TaxonomyWorkspace
              key={settings.datasetId}
              datasetId={settings.datasetId}
              locale={locale}
            />
          ) : view === 'settings' && panel === 'backup' ? (
            <BackupWorkspace
              key={settings.datasetId}
              datasetId={settings.datasetId}
              locale={locale}
            />
          ) : view === 'settings' ? (
            <>
              <h1 className="mb-6 text-3xl font-extrabold">
                {t('app_settings')}
              </h1>
              <SettingsForm
                settings={settings}
                locale={locale}
                language={language}
                onSaved={refresh}
              />
              <PostingPermissions
                key={settings.datasetId}
                datasetId={settings.datasetId}
                locale={locale}
                onSaved={refresh}
              />
              <AiSettings locale={locale} onSaved={refresh} />
              <WechatSettings
                datasetId={settings.datasetId}
                locale={locale}
                aiConfigured={settings.aiConfigured}
                onChange={conversationsChanged}
              />
              <Link
                to="/"
                search={{ view: 'settings', panel: 'taxonomy' }}
                className="mt-6 flex min-h-16 items-center justify-between rounded-2xl border border-foreground/30 bg-surface p-5 font-bold focus-visible:outline-4 focus-visible:outline-focus"
              >
                {t('taxonomy_title')}
                <IconChevronRight size={22} aria-hidden />
              </Link>
              <Link
                to="/"
                search={{ view: 'settings', panel: 'trash' }}
                className="mt-4 flex min-h-16 items-center justify-between rounded-2xl border border-foreground/30 bg-surface p-5 font-bold focus-visible:outline-4 focus-visible:outline-focus"
              >
                {t('trash_title')}
                <IconChevronRight size={22} aria-hidden />
              </Link>
              <Link
                to="/"
                search={{ view: 'settings', panel: 'backup' }}
                className="mt-4 flex min-h-16 items-center justify-between rounded-2xl border border-foreground/30 bg-surface p-5 font-bold focus-visible:outline-4 focus-visible:outline-focus"
              >
                {t('backup_title')}
                <IconChevronRight size={22} aria-hidden />
              </Link>
            </>
          ) : view === 'chat' && panel === 'conversations' ? (
            <ConversationList
              key={settings.datasetId}
              datasetId={settings.datasetId}
              locale={locale}
              timeZone={settings.timeZone}
              revision={conversationRevision}
              onChange={conversationsChanged}
            />
          ) : view === 'chat' ? (
            <ChatWorkspace
              key={settings.datasetId}
              settings={settings}
              locale={locale}
              threadId={threadId}
              onConversationChange={conversationsChanged}
              onLedgerChange={refresh}
            />
          ) : view === 'entries' ? (
            <EntryWorkspace
              key={`${settings.datasetId}:${entryId ?? 'list'}:${Boolean(editing)}:${JSON.stringify(filters)}`}
              settings={settings}
              locale={locale}
              entryId={entryId}
              filters={filters}
              editing={editing}
              onDataChange={refresh}
            />
          ) : (
            <ReportWorkspace
              key={settings.datasetId}
              settings={settings}
              locale={locale}
              filters={filters}
              options={report}
            />
          )}
        </main>
      </div>
      <nav
        aria-label={t('app_navigation')}
        className="fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-muted bg-background px-2 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-3 md:hidden"
      >
        {navigation.map(({ view: target, key, Icon }) => (
          <Link
            key={target}
            to="/"
            search={{ view: target }}
            aria-current={view === target ? 'page' : undefined}
            className={`flex min-h-12 min-w-16 flex-col items-center gap-1 rounded-lg px-2 text-sm font-bold focus-visible:outline-4 focus-visible:outline-focus ${view === target ? 'text-foreground after:h-1 after:w-6 after:rounded-full after:bg-orange' : 'text-muted-foreground'}`}
          >
            <Icon size={25} aria-hidden />
            {t(key)}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function SettingsForm({
  settings,
  locale,
  language,
  onSaved,
  initialize = false,
}: {
  settings: Settings;
  locale: AppLocale;
  language: ReturnType<typeof useAppLocale>;
  onSaved: () => Promise<void>;
  initialize?: boolean;
}) {
  const [currency, setCurrency] = useState(settings.primaryCurrency);
  const [zone, setZone] = useState(settings.timeZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const operation = useRef<{ value: string; id: string } | null>(null);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(false);
        setSaved(false);
        const payload = {
          datasetId: settings.datasetId,
          primaryCurrency: currency,
          timeZone: zone,
          ...(!initialize ? { version: settings.version } : {}),
        };
        const value = JSON.stringify(payload);
        if (operation.current?.value !== value)
          operation.current = { value, id: crypto.randomUUID() };
        try {
          await privateApi(
            initialize ? 'initialize' : 'settings',
            { ...payload, operationId: operation.current.id },
            initialize ? 'POST' : 'PUT'
          );
          await onSaved();
          setSaved(true);
        } catch {
          setError(true);
        } finally {
          setBusy(false);
        }
      }}
      className="space-y-5 text-left"
    >
      <section
        aria-label={t('app_basic_settings')}
        className="rounded-2xl border border-foreground/40 bg-surface px-4 py-1 md:px-6"
      >
        <SettingRow
          icon={<IconCurrencyYuan aria-hidden />}
          title={t('app_currency')}
          description={
            settings.currencyLocked
              ? t('app_currency_locked')
              : t('app_currency_hint')
          }
        >
          <select
            aria-label={t('app_currency')}
            disabled={settings.currencyLocked || busy}
            value={currency}
            onChange={(e) => setCurrency(e.target.value as typeof currency)}
            className="moni-field"
          >
            {currencies.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          icon={<IconWorld aria-hidden />}
          title={t('app_timezone')}
          description={t('app_timezone_hint')}
        >
          <select
            aria-label={t('app_timezone')}
            disabled={busy}
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            className="moni-field"
          >
            {[
              ...new Set([zone, 'UTC', ...Intl.supportedValuesOf('timeZone')]),
            ].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          icon={<IconLanguage aria-hidden />}
          title={t('language_label')}
          description={t('app_language_hint')}
        >
          <select
            aria-label={t('language_label')}
            value={language.preference}
            onChange={(e) =>
              language.selectLanguage(e.target.value as LanguagePreference)
            }
            className="moni-field"
          >
            <option value="browser">{t('app_browser_language')}</option>
            <option value="zh">简体中文</option>
            <option value="en">English</option>
          </select>
        </SettingRow>
        {initialize && (
          <SettingRow
            icon={<IconRobot aria-hidden />}
            title={t('app_ai_assistant')}
            description={t('app_ai_later')}
          >
            <span
              className={`rounded-lg px-3 py-2 text-sm font-bold ${settings.aiConfigured ? 'bg-green/25' : 'bg-muted'}`}
            >
              {settings.aiConfigured
                ? t('app_configured')
                : t('app_not_configured')}
            </span>
          </SettingRow>
        )}
        {!initialize && (
          <SettingRow
            icon={<IconSettings aria-hidden />}
            title={t('theme_label')}
          >
            <ThemeSwitcher locale={locale} />
          </SettingRow>
        )}
      </section>
      <p role="alert" className="text-foreground empty:hidden">
        {error ? t('app_save_error') : ''}
      </p>
      <output className="text-positive empty:hidden">
        {saved ? t('app_saved') : ''}
      </output>
      <Button
        type="submit"
        disabled={busy}
        className={initialize ? 'w-full' : 'w-full md:min-w-56 md:w-auto'}
      >
        {busy
          ? t('app_saving')
          : initialize
            ? t('app_create_ledger')
            : t('app_save_settings')}
      </Button>
    </form>
  );
}

function SettingRow({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_minmax(7.5rem,40%)] items-center gap-x-2 border-b border-muted py-3 last:border-0 md:py-4 md:grid-cols-[2.75rem_minmax(0,1fr)_minmax(12rem,16rem)] md:gap-x-3">
      <span className="flex size-10 items-center justify-center rounded-full bg-yellow/35 text-foreground">
        {icon}
      </span>
      <div>
        <p className="font-bold">{title}</p>
        {description && (
          <p className="mt-1 text-sm leading-snug text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
