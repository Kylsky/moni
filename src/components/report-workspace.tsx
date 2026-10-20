import { Collapsible } from '@base-ui/react/collapsible';
import {
  IconArrowDown,
  IconArrowRight,
  IconArrowUpRight,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconFilter,
  IconHanger,
  IconInfoCircle,
  IconRefresh,
  IconRun,
  IconTag,
  IconToolsKitchen2,
  IconWallet,
} from '@tabler/icons-react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { EntryFilterForm } from '@/components/entry-list';
import { ReportMonthPicker } from '@/components/report-month-picker';
import { Button, buttonVariants } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { shiftMonth, todayInZone } from '@/ledger/dates';
import { type EntryFilters, entryFilters } from '@/ledger/entry-query';
import { decimalAmount, displayMoney } from '@/ledger/money';
import type { Report } from '@/ledger/reports';
import type { LedgerSettings } from '@/ledger/settings';
import type { Taxonomy } from '@/ledger/taxonomy';
import { categoryLabel } from '@/lib/category-label';
import { ApiError, privateApi } from '@/lib/client-api';
import { type AppLocale, message } from '@/lib/locale';

const metrics = [
  {
    key: 'income',
    label: 'entry_income',
    Icon: IconArrowUpRight,
    color: 'bg-green/25',
  },
  {
    key: 'expense',
    label: 'entry_expense',
    Icon: IconArrowDown,
    color: 'bg-orange/15',
  },
  {
    key: 'refund',
    label: 'query_refund',
    Icon: IconRefresh,
    color: 'bg-yellow/30',
  },
  {
    key: 'netExpense',
    label: 'query_net_expense',
    Icon: IconWallet,
    color: 'bg-muted',
  },
] as const;

export const reportOptions = z
  .object({
    mode: z.enum(['month', 'rolling_months', 'complete_months', 'custom']),
    month: z.string().regex(/^(19\d{2}|[2-9]\d{3})-(0[1-9]|1[0-2])$/),
    months: z.number().int().min(1).max(120),
    groupBy: z.enum(['category', 'tag']),
    interval: z.enum(['day', 'week', 'month']),
  })
  .strict();

export function ReportWorkspace({
  settings,
  locale,
  filters: requested,
  options,
}: {
  settings: LedgerSettings;
  locale: AppLocale;
  filters?: EntryFilters;
  options?: z.infer<typeof reportOptions>;
}) {
  const [filters, setFilters] = useState(
    () => requested ?? entryFilters.parse({})
  );
  const [mode, setMode] = useState<
    'month' | 'rolling_months' | 'complete_months' | 'custom'
  >(options?.mode ?? (requested?.from || requested?.to ? 'custom' : 'month'));
  const [month, setMonth] = useState(
    () => options?.month ?? todayInZone(settings.timeZone).slice(0, 7)
  );
  const [months, setMonths] = useState(options?.months ?? 3);
  const [groupBy, setGroupBy] = useState<'category' | 'tag'>(
    options?.groupBy ?? 'category'
  );
  const [interval, setInterval] = useState<'day' | 'week' | 'month'>(
    options?.interval ?? 'week'
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const navigate = useNavigate();
  const location = JSON.stringify({
    filters,
    report: { mode, month, months, groupBy, interval },
  });
  useEffect(() => {
    void navigate({
      to: '/',
      search: { view: 'reports', ...JSON.parse(location) },
      replace: true,
      resetScroll: false,
    });
  }, [navigate, location]);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<null | 'load' | 'large'>(null);
  const [data, setData] = useState<Report | null>(null);
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null);
  const payload = JSON.stringify({
    filters: {
      ...filters,
      ...(mode !== 'custom' ? { from: undefined, to: undefined } : {}),
    },
    ...(mode === 'month'
      ? { period: { kind: 'month', month } }
      : mode === 'custom'
        ? {}
        : { period: { kind: mode, months } }),
    groupBy,
    interval,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly reloads the current financial report.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);
    void Promise.all([
      privateApi<Report>(
        'reports/query',
        JSON.parse(payload),
        'POST',
        controller.signal
      ),
      privateApi<Taxonomy>('taxonomy', undefined, 'GET', controller.signal),
    ])
      .then(([result, catalog]) => {
        if (controller.signal.aborted) return;
        if (
          result.datasetId !== settings.datasetId ||
          catalog.datasetId !== settings.datasetId
        )
          throw new Error('dataset_changed');
        setData(result);
        setTaxonomy(catalog);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setFailure(
            error instanceof ApiError && error.status === 413 ? 'large' : 'load'
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [payload, settings.datasetId, retry]);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const money = (amount: number) =>
    displayMoney(amount, settings.primaryCurrency, locale);
  const label = (group: Report['groups'][number]) =>
    group.name === null
      ? t('report_untagged')
      : categoryLabel(group.name, group.categoryKey, locale);
  const apply = (next: EntryFilters) => {
    setFilters(next);
    setMode('custom');
  };
  const formFilters = {
    ...filters,
    ...(mode !== 'custom' && data
      ? { from: data.filters.from, to: data.filters.to }
      : {}),
  };
  const groups =
    data?.groups.filter(
      (group) => group.counts.expense || group.counts.refund
    ) ?? [];
  const peak = Math.max(
    1,
    ...(data?.trend.flatMap((bucket) => [
      bucket.totals.expense,
      bucket.totals.refund,
    ]) ?? [])
  );
  const visible = !loading && !failure ? data : null;
  return (
    <div className="space-y-6 md:space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight md:text-4xl">
            {t('app_reports')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('report_overview')}
          </p>
        </div>
        <Button
          variant="icon"
          aria-label={t('report_refresh')}
          className="shrink-0 rounded-xl border-foreground/15!"
          onClick={() => setRetry((value) => value + 1)}
        >
          <IconRefresh
            aria-hidden
            size={20}
            className={loading ? 'motion-safe:animate-spin' : ''}
          />
        </Button>
      </header>
      <Collapsible.Root
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        className="rounded-2xl border border-foreground/10 bg-surface"
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 p-3 md:flex md:justify-between md:p-4">
          <div className="contents md:flex md:min-w-0 md:flex-wrap md:items-center md:gap-3">
            <Select
              label={t('report_period')}
              className="w-full! max-w-full md:w-auto!"
              value={mode}
              onValueChange={(next) => {
                if (next === 'custom') {
                  setFilters(formFilters);
                  setFiltersOpen(true);
                }
                setMode(next);
              }}
              items={[
                { value: 'month', label: t('report_calendar_month') },
                { value: 'rolling_months', label: t('report_rolling_months') },
                {
                  value: 'complete_months',
                  label: t('report_complete_months'),
                },
                { value: 'custom', label: t('report_custom') },
              ]}
            />
            {mode === 'month' && (
              <div className="col-span-2 row-start-2 flex max-w-full items-center rounded-xl border border-foreground/15">
                <Button
                  variant="icon"
                  className="shrink-0 border-0! bg-transparent!"
                  aria-label={t('report_previous_month')}
                  disabled={month <= '1900-01'}
                  onClick={() => setMonth(shiftMonth(month, -1))}
                >
                  <IconChevronLeft aria-hidden size={19} />
                </Button>
                <ReportMonthPicker
                  value={month}
                  onChange={setMonth}
                  locale={locale}
                />
                <Button
                  variant="icon"
                  className="shrink-0 border-0! bg-transparent!"
                  aria-label={t('report_next_month')}
                  disabled={month >= '9999-12'}
                  onClick={() => setMonth(shiftMonth(month, 1))}
                >
                  <IconChevronRight aria-hidden size={19} />
                </Button>
              </div>
            )}
            {(mode === 'rolling_months' || mode === 'complete_months') && (
              <div className="col-span-2 row-start-2 flex items-center gap-2 text-sm">
                <span>{t('report_month_count')}</span>
                <Select
                  label={t('report_month_count')}
                  value={months}
                  onValueChange={setMonths}
                  items={[...new Set([1, 3, 6, 12, months])]
                    .sort((a, b) => a - b)
                    .map((value) => ({ value, label: String(value) }))}
                  className="w-20!"
                />
              </div>
            )}
          </div>
          <Collapsible.Trigger
            render={
              <Button
                variant="plain"
                className="col-start-2 row-start-1 border-0! px-3! shadow-none!"
              />
            }
          >
            <IconFilter size={18} aria-hidden />
            {t('query_filters')}
            <IconChevronDown
              size={16}
              aria-hidden
              className={`transition-transform ${filtersOpen ? 'rotate-180' : ''}`}
            />
          </Collapsible.Trigger>
        </div>
        <Collapsible.Panel className="border-t border-foreground/10 px-4 pt-5 md:px-5">
          {taxonomy && (
            <EntryFilterForm
              key={JSON.stringify(formFilters)}
              filters={formFilters}
              taxonomy={taxonomy}
              locale={locale}
              onApply={apply}
            />
          )}
        </Collapsible.Panel>
      </Collapsible.Root>
      {visible && (
        <p
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground tabular-nums"
          aria-live="polite"
        >
          <span className="font-bold text-foreground">
            {visible.filters.from} — {visible.filters.to}
          </span>
          <span>· {visible.timeZone}</span>
        </p>
      )}
      {failure ? (
        <div className="rounded-2xl border border-orange/40 bg-orange/5 p-6">
          <p role="alert" className="mb-4">
            {t(
              failure === 'large'
                ? 'query_aggregate_error'
                : 'report_load_error'
            )}
          </p>
          <Button onClick={() => setRetry((value) => value + 1)}>
            {t('app_retry')}
          </Button>
        </div>
      ) : (
        <>
          <section aria-label={t('query_totals')} aria-busy={loading}>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {metrics.map(({ key, label, Icon, color }) =>
                visible ? (
                  <Link
                    key={key}
                    to="/"
                    search={{ view: 'entries', filters: visible.filters }}
                    className={`group relative min-w-0 rounded-2xl border p-4 outline-none transition-colors hover:border-orange/60 focus-visible:ring-4 focus-visible:ring-focus md:p-5 ${key === 'netExpense' ? 'border-orange/35 bg-orange/10' : 'border-foreground/10 bg-surface'}`}
                  >
                    <dl>
                      <dt className="flex items-center justify-between gap-2 text-sm font-bold text-muted-foreground">
                        {t(label)}
                        <span
                          className={`flex size-8 shrink-0 items-center justify-center rounded-xl ${color}`}
                        >
                          <Icon
                            aria-hidden
                            size={18}
                            className="text-foreground"
                          />
                        </span>
                      </dt>
                      <dd className="mt-4 break-words text-xl leading-tight font-extrabold tracking-tight tabular-nums sm:text-2xl">
                        {money(visible.totals[key])}
                      </dd>
                      <dd className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground md:text-sm">
                        <span>
                          {key !== 'netExpense'
                            ? visible.counts[key]
                            : visible.counts.expense +
                              visible.counts.refund}{' '}
                          {t('report_records')}
                        </span>
                        <IconArrowUpRight
                          size={16}
                          aria-hidden
                          className="shrink-0 opacity-50 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                        />
                      </dd>
                    </dl>
                  </Link>
                ) : (
                  <div
                    key={key}
                    aria-hidden
                    className="h-36 rounded-2xl border border-foreground/10 bg-muted/35 motion-safe:animate-pulse"
                  />
                )
              )}
            </div>
            {visible?.originalTotals && filters.currency && (
              <div className="mt-4 rounded-2xl border border-yellow/40 bg-yellow/10 p-4 md:p-5">
                <h2 className="text-sm font-bold">
                  {t('query_original_totals')} · {filters.currency}
                </h2>
                <dl className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
                  {metrics.map(({ key, label }) => (
                    <div key={key}>
                      <dt className="text-sm text-muted-foreground">
                        {t(label)}
                      </dt>
                      <dd className="mt-1 break-words font-bold tabular-nums">
                        {displayMoney(
                          visible.originalTotals?.[key] ?? 0,
                          filters.currency as NonNullable<
                            EntryFilters['currency']
                          >,
                          locale
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </section>
          {loading && (
            <output className="sr-only">{t('report_loading')}</output>
          )}
          {visible && (
            <p className="flex gap-2 text-xs leading-relaxed text-muted-foreground md:text-sm">
              <IconInfoCircle
                size={18}
                className="mt-0.5 shrink-0"
                aria-hidden
              />
              {t('report_basis')} · {visible.primaryCurrency} · {visible.total}{' '}
              {t('report_records')}
            </p>
          )}
          {visible && !visible.total && (
            <div className="rounded-2xl border border-dashed border-foreground/20 py-8 text-center">
              <img
                src="/moni/illustrations/assistant-search.png"
                className="mx-auto w-28"
                alt=""
              />
              <h2 className="mt-3 text-lg font-bold">{t('query_empty')}</h2>
            </div>
          )}
        </>
      )}
      <section
        className="min-w-0 rounded-2xl border border-foreground/10 bg-surface p-4 md:p-6"
        aria-labelledby="report-trend-title"
        aria-busy={loading}
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 id="report-trend-title" className="text-lg font-extrabold">
            {t('report_trend')}
          </h2>
          <SegmentedControl
            label={t('report_interval')}
            value={interval}
            onValueChange={setInterval}
            items={[
              { value: 'day', label: t('report_daily') },
              { value: 'week', label: t('report_weekly') },
              { value: 'month', label: t('report_monthly') },
            ]}
          />
        </div>
        {visible ? (
          <>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground md:text-sm">
              <span>{visible.primaryCurrency}</span>
              <p className="flex gap-4">
                <span className="flex items-center gap-2">
                  <span className="size-2.5 rounded-sm bg-orange" />
                  {t('entry_expense')}
                </span>
                <span className="flex items-center gap-2">
                  <span className="size-2.5 rounded-sm bg-yellow" />
                  {t('query_refund')}
                </span>
              </p>
            </div>
            {visible.counts.expense || visible.counts.refund ? (
              <div className="mt-7 flex min-w-0 gap-2 md:gap-4">
                <div
                  aria-hidden
                  className="mt-6 flex h-52 shrink-0 flex-col justify-between pb-0 text-right text-[11px] leading-none text-muted-foreground tabular-nums md:text-xs"
                >
                  {[peak, 0].map((amount) => (
                    <span key={amount}>
                      {decimalAmount(
                        Math.round(amount),
                        settings.primaryCurrency
                      ).replace(/\.0+$/, '')}
                    </span>
                  ))}
                </div>
                <section
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable chart needs keyboard access on narrow screens.
                  tabIndex={0}
                  aria-label={t('report_trend')}
                  className="min-w-0 flex-1 overflow-x-auto rounded outline-none focus-visible:ring-4 focus-visible:ring-focus"
                >
                  <div
                    className="relative pt-6"
                    style={{
                      minWidth: Math.max(210, visible.trend.length * 90),
                    }}
                    role="img"
                    aria-label={t('report_chart_alternative')}
                  >
                    <div className="pointer-events-none absolute inset-x-0 top-6 flex h-52 flex-col justify-between">
                      {[0, 1, 2].map((line) => (
                        <div
                          key={line}
                          className="border-t border-dashed border-foreground/10 last:border-solid last:border-foreground/20"
                        />
                      ))}
                    </div>
                    <div className="relative flex gap-4">
                      {visible.trend.map((bucket) => (
                        <div
                          key={bucket.from}
                          className="min-w-0 flex-1 text-center"
                        >
                          <div className="flex h-52 items-end justify-center gap-2 md:gap-3">
                            {(['expense', 'refund'] as const).map((kind) => (
                              <div
                                key={kind}
                                className={`relative w-[22%] max-w-14 rounded-t-md ${kind === 'expense' ? 'bg-orange' : 'bg-yellow'}`}
                                style={{
                                  height: `${(bucket.totals[kind] / peak) * 100}%`,
                                }}
                              >
                                {bucket.totals[kind] > 0 && (
                                  <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 text-xs font-bold tabular-nums">
                                    {decimalAmount(
                                      bucket.totals[kind],
                                      settings.primaryCurrency
                                    ).replace(/\.0+$/, '')}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                          <p className="pt-3 pb-2 text-[11px] text-muted-foreground tabular-nums md:text-xs">
                            {bucket.from.slice(5)}
                            {bucket.from !== bucket.to && (
                              <> — {bucket.to.slice(5)}</>
                            )}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              </div>
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {t('report_no_expenses')}
              </p>
            )}
            <Collapsible.Root className="mt-5 border-t border-foreground/10 pt-2">
              <Collapsible.Trigger className="group flex min-h-11 items-center gap-2 rounded-lg text-sm font-bold outline-none hover:text-orange-strong focus-visible:ring-4 focus-visible:ring-focus">
                {t('report_data_table')}
                <IconChevronDown
                  size={16}
                  aria-hidden
                  className="transition-transform group-data-[panel-open]:rotate-180"
                />
              </Collapsible.Trigger>
              <Collapsible.Panel>
                <section
                  aria-label={t('report_data_table')}
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the wide data table.
                  tabIndex={0}
                  className="overflow-x-auto rounded-lg outline-none focus-visible:ring-4 focus-visible:ring-focus"
                >
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">{t('report_trend')}</caption>
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="p-3">{t('report_period')}</th>
                        {metrics.map((metric) => (
                          <th key={metric.key} className="p-3">
                            {t(metric.label)}
                          </th>
                        ))}
                        <th className="p-3">{t('report_records')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.trend.map((bucket) => (
                        <tr
                          key={bucket.from}
                          className="border-t border-foreground/10"
                        >
                          <th className="p-2 font-normal">
                            <Link
                              to="/"
                              search={{
                                view: 'entries',
                                filters: bucket.filters,
                              }}
                              className="inline-flex min-h-11 items-center whitespace-nowrap rounded-lg px-1 underline decoration-foreground/30 underline-offset-4 outline-none hover:text-orange-strong focus-visible:ring-4 focus-visible:ring-focus"
                            >
                              {bucket.from} — {bucket.to}
                            </Link>
                          </th>
                          {metrics.map((metric) => (
                            <td
                              key={metric.key}
                              className="whitespace-nowrap p-3 tabular-nums"
                            >
                              {money(bucket.totals[metric.key])}
                            </td>
                          ))}
                          <td className="p-3">{bucket.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              </Collapsible.Panel>
            </Collapsible.Root>
          </>
        ) : loading ? (
          <div
            aria-hidden
            className="mt-6 h-64 rounded-xl bg-muted/35 motion-safe:animate-pulse"
          />
        ) : null}
      </section>
      <section
        className="rounded-2xl border border-foreground/10 bg-surface p-4 md:p-6"
        aria-labelledby="report-groups-title"
        aria-busy={loading}
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 id="report-groups-title" className="text-lg font-extrabold">
            {t('report_distribution')}
          </h2>
          <SegmentedControl
            label={t('report_group_by')}
            value={groupBy}
            onValueChange={setGroupBy}
            items={[
              { value: 'category', label: t('entry_category') },
              { value: 'tag', label: t('entry_tags') },
            ]}
          />
        </div>
        {groupBy === 'tag' && (
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {t('report_tags_overlap')}
          </p>
        )}
        {visible ? (
          <>
            <ul className="mt-5 divide-y divide-foreground/10">
              {groups.map((group) => {
                const CategoryIcon =
                  groupBy === 'tag'
                    ? IconTag
                    : group.categoryKey === 'expense-food'
                      ? IconToolsKitchen2
                      : group.categoryKey === 'expense-sports'
                        ? IconRun
                        : group.categoryKey === 'expense-clothing'
                          ? IconHanger
                          : IconWallet;
                const share = visible.totals.expense
                  ? group.totals.expense / visible.totals.expense
                  : 0;
                return (
                  <li key={group.id ?? 'untagged'}>
                    <Link
                      to="/"
                      search={{ view: 'entries', filters: group.filters }}
                      className="group flex min-w-0 gap-3 rounded-xl py-5 outline-none hover:bg-muted/30 focus-visible:ring-4 focus-visible:ring-focus md:gap-4 md:px-2"
                    >
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-orange/10 text-foreground md:size-12">
                        <CategoryIcon size={22} aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
                          <span className="min-w-0 break-words font-bold">
                            {label(group)}
                            <span className="text-sm font-normal text-muted-foreground">
                              {' '}
                              · {group.total} {t('report_records')}
                            </span>
                          </span>
                          <span className="font-extrabold tabular-nums">
                            {money(group.totals.expense)}
                          </span>
                        </div>
                        <div className="mt-3 flex items-center gap-3">
                          <div
                            className="h-2 flex-1 overflow-hidden rounded-full bg-muted/60"
                            aria-hidden
                          >
                            <div
                              className="h-full rounded-full bg-orange"
                              style={{ width: `${share * 100}%` }}
                            />
                          </div>
                          <span className="min-w-12 text-right text-xs text-muted-foreground tabular-nums">
                            {new Intl.NumberFormat(locale, {
                              style: 'percent',
                              maximumFractionDigits: 1,
                            }).format(share)}
                          </span>
                        </div>
                        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground md:text-sm">
                          <span>
                            {t('query_refund')} {money(group.totals.refund)}
                          </span>
                          <span>
                            {t('query_net_expense')}{' '}
                            {money(group.totals.netExpense)}
                          </span>
                        </p>
                      </div>
                      <IconChevronRight
                        size={18}
                        aria-hidden
                        className="mt-1 hidden shrink-0 self-center text-muted-foreground transition-transform group-hover:translate-x-0.5 sm:block"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
            {!groups.length && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {t('report_no_expenses')}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-4 border-t border-foreground/10 pt-5">
              <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground md:text-sm">
                {t('report_refund_date')}
              </p>
              <Link
                to="/"
                search={{ view: 'entries', filters: visible.filters }}
                className={buttonVariants({
                  variant: 'plain',
                  className: 'w-full border-foreground/15! text-sm sm:w-auto',
                })}
              >
                {t('report_view_entries')}
                <IconArrowRight size={18} aria-hidden />
              </Link>
            </div>
          </>
        ) : loading ? (
          <div
            aria-hidden
            className="mt-5 h-52 rounded-xl bg-muted/35 motion-safe:animate-pulse"
          />
        ) : null}
      </section>
    </div>
  );
}
