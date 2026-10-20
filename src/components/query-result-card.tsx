import { IconInfoCircle } from '@tabler/icons-react';
import type { UIMessage } from '@tanstack/ai-react';
import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button';
import {
  type LedgerQueryResult,
  parseQueryUpdates,
} from '@/ledger/chat-query-contract';
import { displayMoney } from '@/ledger/money';
import { categoryLabel } from '@/lib/category-label';
import { type AppLocale, message } from '@/lib/locale';

export function queryResults(
  item: UIMessage
): Map<string, LedgerQueryResult | null> {
  const results = new Map<string, LedgerQueryResult | null>();
  for (const part of item.parts)
    if (
      part.type === 'tool-call' &&
      ['query_ledger', 'prepare_draft'].includes(part.name)
    ) {
      for (const update of parseQueryUpdates(part.output))
        results.set(update.id, update.result);
    }
  return results;
}

export function QueryResultCard({
  result,
  locale,
  datasetId,
}: {
  result: LedgerQueryResult;
  locale: AppLocale;
  datasetId: string;
}) {
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const { report, query, criteria } = result;
  const filters = report.filters;
  const originalTotals = report.originalTotals;
  const originalCurrency = filters.currency;
  const money = (value: number) =>
    report.total ? displayMoney(value, report.primaryCurrency, locale) : '—';
  const tagNames = (ids: string[]) =>
    ids
      .map(
        (id) =>
          criteria.tags.find((tag) => tag.id === id)?.name ??
          t('query_unknown_filter')
      )
      .join('、');
  const scope = t(
    query.scope === 'spending'
      ? 'query_spending'
      : query.scope === 'income'
        ? 'entry_income'
        : 'query_all'
  );
  const labels = [
    scope,
    filters.currency,
    criteria.category
      ? categoryLabel(
          criteria.category.name,
          criteria.category.defaultKey,
          locale
        )
      : '',
    filters.tagIds?.length
      ? `${t('nl_query_any_tags')}：${tagNames(filters.tagIds)}`
      : '',
    filters.requiredTagIds?.length
      ? `${t('nl_query_required_tags')}：${tagNames(filters.requiredTagIds)}`
      : '',
    filters.untagged ? t('report_untagged') : '',
    filters.keyword ? `${t('nl_query_keyword')}：“${filters.keyword}”` : '',
  ].filter(Boolean);
  const rows =
    query.view === 'trend'
      ? report.trend.map((row) => ({
          ...row,
          key: `${row.from}:${row.to}`,
          label: `${row.from} — ${row.to}`,
        }))
      : report.groups.map((row) => ({
          ...row,
          key: row.id ?? 'untagged',
          label:
            query.view === 'tags'
              ? (row.name ?? t('report_untagged'))
              : categoryLabel(
                  row.name ?? t('query_unknown_filter'),
                  row.categoryKey,
                  locale
                ),
        }));
  const metrics = [
    { key: 'income', label: 'entry_income' },
    { key: 'expense', label: 'entry_expense' },
    { key: 'refund', label: 'query_refund' },
    { key: 'netExpense', label: 'query_net_expense' },
  ] as const;
  return (
    <article
      aria-label={t('nl_query_result')}
      className="rounded-2xl border-2 border-foreground bg-surface p-4 md:p-6"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-xl font-extrabold after:mt-2 after:block after:h-1 after:w-8 after:rounded-full after:bg-yellow">
          {t(
            query.view === 'entries'
              ? 'nl_query_entries'
              : query.view === 'categories'
                ? 'nl_query_categories'
                : query.view === 'tags'
                  ? 'nl_query_tags'
                  : query.view === 'trend'
                    ? 'nl_query_trend'
                    : 'nl_query_title'
          )}
        </h2>
        <p className="text-sm text-muted-foreground">
          {filters.from} — {filters.to} · {report.timeZone}
        </p>
      </header>
      <ul
        aria-label={t('nl_query_conditions')}
        className="my-4 flex flex-wrap gap-2 text-sm"
      >
        {labels.map((label) => (
          <li key={label} className="break-all rounded-full bg-muted px-3 py-1">
            {label}
          </li>
        ))}
      </ul>
      {report.datasetId !== datasetId && (
        <p className="mb-4 rounded-xl bg-yellow/20 p-3">
          {t('nl_query_historical')}
        </p>
      )}
      {!report.total && (
        <p className="mb-4 rounded-xl bg-yellow/20 p-4 font-bold">
          {t('nl_query_no_matches')}
        </p>
      )}
      <div className="rounded-2xl bg-yellow/20 p-4 md:grid md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] md:items-center md:gap-4">
        <div className="pb-3 md:pb-0">
          <p className="font-bold">
            {t(query.scope === 'income' ? 'entry_income' : 'query_net_expense')}{' '}
            · {report.primaryCurrency}
          </p>
          <p className="mt-2 break-all text-3xl font-extrabold tabular-nums md:text-4xl">
            {money(
              query.scope === 'income'
                ? report.totals.income
                : report.totals.netExpense
            )}
          </p>
        </div>
        {(
          [
            { key: 'expense', label: 'entry_expense' },
            { key: 'refund', label: 'query_refund' },
          ] as const
        ).map(({ key, label }) => (
          <div
            key={key}
            className="flex justify-between gap-3 border-t border-foreground/15 py-2 md:block md:border-l md:border-t-0 md:pl-4"
          >
            <p>{t(label)}</p>
            <p className="break-all font-extrabold tabular-nums md:mt-2 md:text-xl">
              {money(report.totals[key])}
            </p>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t border-foreground/15 py-2 md:block md:border-l md:border-t-0 md:pl-4">
          <p>{t('nl_query_matching')}</p>
          <p className="font-extrabold tabular-nums md:mt-2 md:text-xl">
            {report.total}
          </p>
        </div>
      </div>
      {query.scope === 'all' && (
        <p className="mt-3 flex flex-wrap justify-between gap-2">
          <span>
            {t('entry_income')} · {report.primaryCurrency}
          </span>
          <strong className="tabular-nums">
            {money(report.totals.income)}
          </strong>
        </p>
      )}
      {originalTotals && originalCurrency && (
        <section
          aria-label={t('query_original_totals')}
          className="mt-4 rounded-xl border border-foreground/30 p-4"
        >
          <h3 className="mb-2 font-bold">
            {t('query_original_totals')} · {originalCurrency}
          </h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            {metrics.map(({ key, label }) => (
              <div key={key}>
                <dt className="text-sm text-muted-foreground">{t(label)}</dt>
                <dd className="break-all font-bold tabular-nums">
                  {report.total
                    ? displayMoney(
                        originalTotals[key],
                        originalCurrency,
                        locale
                      )
                    : '—'}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <p className="my-4 flex items-start gap-2 text-sm text-muted-foreground">
        <IconInfoCircle size={20} className="shrink-0" aria-hidden />
        <span>
          {t('report_refund_date')}
          {filters.keyword ? ` ${t('nl_query_keyword_hint')}` : ''}
        </span>
      </p>
      {query.view === 'tags' && (
        <p className="mb-4 text-sm text-muted-foreground">
          {t('report_tags_overlap')}
        </p>
      )}
      {rows.length > 0 && (
        <section
          aria-label={t('nl_query_table')}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the wide results table.
          tabIndex={0}
          className="my-4 overflow-x-auto rounded-xl border border-foreground/30 focus-visible:outline-4 focus-visible:outline-focus"
        >
          <table className="w-full min-w-[36rem] text-left text-sm">
            <caption className="sr-only">
              {t('nl_query_table')} · {report.primaryCurrency}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="p-3">
                  {t(
                    query.view === 'trend'
                      ? 'entry_date'
                      : query.view === 'tags'
                        ? 'entry_tags'
                        : 'entry_category'
                  )}
                </th>
                {metrics.map(({ key, label }) => (
                  <th scope="col" key={key} className="p-3 text-right">
                    {t(label)}
                  </th>
                ))}
                <th scope="col" className="p-3 text-right">
                  {t('nl_query_matching')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-muted">
                  <th scope="row" className="p-3">
                    <Link
                      to="/"
                      search={{ view: 'entries', filters: row.filters }}
                      className="inline-flex min-h-11 items-center rounded-lg font-bold underline decoration-orange underline-offset-4 focus-visible:outline-4 focus-visible:outline-focus"
                    >
                      {row.label}
                    </Link>
                  </th>
                  {metrics.map(({ key }) => (
                    <td key={key} className="p-3 text-right tabular-nums">
                      {displayMoney(
                        row.totals[key],
                        report.primaryCurrency,
                        locale
                      )}
                    </td>
                  ))}
                  <td className="p-3 text-right tabular-nums">{row.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {query.view === 'entries' && result.entries && (
        <section aria-label={t('nl_query_entries')} className="my-4">
          <p className="mb-3 text-sm text-muted-foreground">
            {t('nl_query_page')} {result.entries.page} /{' '}
            {Math.max(1, result.entries.pageCount)}
            {result.entries.page < result.entries.pageCount
              ? ` · ${t('nl_query_next_hint')}`
              : ''}
          </p>
          <ul className="divide-y divide-muted rounded-xl border border-foreground/30 px-4">
            {result.entries.items.map((entry) => (
              <li key={entry.id}>
                <Link
                  to="/"
                  search={{ view: 'entries', entry: entry.id, filters }}
                  className="block rounded-lg py-4 focus-visible:outline-4 focus-visible:outline-focus"
                >
                  <div className="flex flex-wrap justify-between gap-3 font-bold">
                    <span className="min-w-0 break-words">{entry.name}</span>
                    <span className="tabular-nums">
                      {displayMoney(
                        entry.originalMinor,
                        entry.currency,
                        locale
                      )}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {entry.date} ·{' '}
                    {t(
                      entry.kind === 'income'
                        ? 'entry_income'
                        : entry.kind === 'refund'
                          ? 'query_refund'
                          : 'entry_expense'
                    )}{' '}
                    ·{' '}
                    {categoryLabel(
                      entry.categoryName,
                      entry.categoryKey,
                      locale
                    )}
                  </p>
                  {entry.currency !== report.primaryCurrency && (
                    <p className="mt-2 text-sm">
                      {t('query_equivalent')}{' '}
                      {displayMoney(
                        entry.baseMinor,
                        report.primaryCurrency,
                        locale
                      )}
                    </p>
                  )}
                  {!!entry.tags.length && (
                    <p className="mt-2 break-words text-sm">
                      {t('entry_tags')}：{entry.tags.join(' · ')}
                    </p>
                  )}
                  {entry.note && (
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                      {t('entry_note')}：{entry.note}
                      {entry.noteTruncated
                        ? ` · ${t('nl_query_note_excerpt')}`
                        : ''}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="grid gap-3 md:grid-cols-[1.3fr_1fr]">
        <Link
          to="/"
          search={{ view: 'entries', filters }}
          className={buttonVariants()}
        >
          {t('nl_query_details')} · {report.total}
        </Link>
        <Link
          to="/"
          search={{
            view: 'reports',
            filters,
            report: {
              mode: 'custom',
              month: filters.to.slice(0, 7),
              months: 3,
              groupBy: report.groupBy,
              interval: report.interval,
            },
          }}
          className={buttonVariants({ variant: 'plain' })}
        >
          {t('nl_query_modify')}
        </Link>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        {t('nl_query_as_of')}{' '}
        {new Intl.DateTimeFormat(locale, {
          timeZone: report.timeZone,
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(result.asOf)}
      </p>
    </article>
  );
}
