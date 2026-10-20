import type { LedgerQueryResult } from '../ledger/chat-query-contract';
import type { Currency } from '../ledger/currencies';
import type { EntryTotals } from '../ledger/entry-query';
import { displayMoney } from '../ledger/money';
import { categoryLabel } from './category-label';
import { type AppLocale, message } from './locale';

export function markdownText(value: string) {
  return value.replace(/[\\`*_[\]{}<>#+.!|()~-]/g, '\\$&');
}

export function wechatStatistics(result: LedgerQueryResult, locale: AppLocale) {
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const literal = (value: string) =>
    markdownText(value.replace(/\r\n?|\n/g, ' '));
  const colon = locale === 'zh' ? '：' : ': ';
  const { query, report, criteria } = result;
  const title = t(
    query.view === 'entries'
      ? 'nl_query_entries'
      : query.view === 'categories'
        ? 'nl_query_categories'
        : query.view === 'tags'
          ? 'nl_query_tags'
          : query.view === 'trend'
            ? 'nl_query_trend'
            : 'nl_query_title'
  );
  const range =
    query.period.kind === 'all_time'
      ? t('wechat_report_all_time')
      : `${report.filters.from} — ${report.filters.to}`;
  const labels = [
    t(
      query.scope === 'income'
        ? 'entry_income'
        : query.scope === 'all'
          ? 'query_all'
          : 'query_spending'
    ),
    criteria.category
      ? categoryLabel(
          criteria.category.name,
          criteria.category.defaultKey,
          locale
        )
      : '',
    report.filters.tagIds?.length
      ? `${t('nl_query_any_tags')}${colon}${report.filters.tagIds.map((id) => criteria.tags.find((tag) => tag.id === id)?.name ?? t('query_unknown_filter')).join(' · ')}`
      : '',
    report.filters.requiredTagIds?.length
      ? `${t('nl_query_required_tags')}${colon}${report.filters.requiredTagIds.map((id) => criteria.tags.find((tag) => tag.id === id)?.name ?? t('query_unknown_filter')).join(' · ')}`
      : '',
    report.filters.untagged ? t('report_untagged') : '',
    report.filters.keyword
      ? `${t('nl_query_keyword')}${colon}“${report.filters.keyword}”`
      : '',
    report.filters.currency
      ? `${t('query_currency')}${colon}${report.filters.currency}`
      : '',
  ].filter(Boolean);
  const metrics =
    query.scope === 'income'
      ? ([{ key: 'income', label: 'entry_income' }] as const)
      : ([
          ...(query.scope === 'all'
            ? ([{ key: 'income', label: 'entry_income' }] as const)
            : []),
          { key: 'expense', label: 'entry_expense' },
          { key: 'refund', label: 'query_refund' },
          { key: 'netExpense', label: 'query_net_expense' },
        ] as const);
  const mainKey = query.scope === 'income' ? 'income' : 'netExpense';
  const amounts = (
    totals: EntryTotals,
    currency: Currency,
    includeMain = false
  ) =>
    metrics
      .filter(({ key }) => includeMain || key !== mainKey)
      .map(
        ({ key, label }) =>
          `${t(label)}${colon}**${displayMoney(totals[key], currency, locale)}**`
      );
  const mainLabel =
    query.scope === 'income' ? 'entry_income' : 'query_net_expense';
  const header = `📊 **${title}**\n\n📅 ${range}\n${literal(labels.join(' · '))}\n${report.timeZone} · ${t('app_currency')} ${report.primaryCurrency}`;
  const footer = [
    t('report_basis'),
    report.totals.refund ? t('report_refund_date') : '',
    query.view === 'tags' ? t('report_tags_overlap') : '',
    `${t('nl_query_as_of')} ${new Intl.DateTimeFormat(locale, { timeZone: report.timeZone, dateStyle: 'short', timeStyle: 'short' }).format(result.asOf)}`,
  ]
    .filter(Boolean)
    .join('\n');
  if (!report.total)
    return `${header}\n\n${t('nl_query_no_matches')}\n\n${footer}`.length <=
      2300
      ? `${header}\n\n${t('nl_query_no_matches')}\n\n${footer}`
      : `📊 **${title}**\n\n${t('wechat_report_web_required')}`;
  let body = `${header}\n\n**${t(mainLabel)}${colon}${displayMoney(report.totals[mainKey], report.primaryCurrency, locale)}**\n\n${amounts(
    report.totals,
    report.primaryCurrency
  )
    .map((line) => `- ${line}`)
    .join('\n')}\n- ${t('nl_query_matching')}${colon}${report.total}`;
  if (report.originalTotals && report.filters.currency)
    body += `\n\n**${t('query_original_totals')} · ${report.filters.currency}**\n${amounts(
      report.originalTotals,
      report.filters.currency,
      true
    )
      .map((line) => `- ${line}`)
      .join('\n')}`;
  if (`${body}\n\n${footer}`.length > 2100)
    return `📊 **${title}**\n\n${t('wechat_report_web_required')}`;
  const rows =
    query.view === 'summary'
      ? []
      : query.view === 'trend'
        ? report.trend.map((row) => ({
            ...row,
            label: row.from === row.to ? row.from : `${row.from} — ${row.to}`,
          }))
        : report.groups.map((row) => ({
            ...row,
            label:
              query.view === 'tags'
                ? (row.name ?? t('report_untagged'))
                : categoryLabel(
                    row.name ?? t('query_unknown_filter'),
                    row.categoryKey,
                    locale
                  ),
          }));
  if (query.view === 'entries' && result.entries) {
    const { entries } = result;
    body += `\n\n${t('nl_query_page')} ${entries.page} / ${entries.pageCount}`;
    let shown = 0;
    for (const entry of entries.items) {
      const kind = t(
        entry.kind === 'income'
          ? 'entry_income'
          : entry.kind === 'refund'
            ? 'query_refund'
            : 'entry_expense'
      );
      const note = entry.note
        ? `\n${t('entry_note')}${colon}${literal(entry.note)}${entry.noteTruncated ? ` · ${t('nl_query_note_excerpt')}` : ''}`
        : '';
      const block = `\n\n**${literal(entry.name)} · ${displayMoney(entry.originalMinor, entry.currency, locale)}**\n${entry.date} · ${kind} · ${literal(categoryLabel(entry.categoryName, entry.categoryKey, locale))}${entry.currency !== report.primaryCurrency ? `\n${t('query_equivalent')}${colon}${displayMoney(entry.baseMinor, report.primaryCurrency, locale)}` : ''}${entry.tags.length ? `\n${t('entry_tags')}${colon}${literal(entry.tags.join(' · '))}` : ''}${note}`;
      if (
        `${body}${block}\n\n${footer}\n\n${t('nl_query_entries_partial')}`
          .length > 2300
      )
        break;
      body += block;
      shown++;
    }
    if (shown < entries.items.length)
      body += `\n\n${t('nl_query_entries_partial')}`;
    else if (entries.page < entries.pageCount)
      body += `\n\n${t('nl_query_next_hint')}`;
    return `${body}\n\n---\n\n${footer}`;
  }
  const visible =
    query.view === 'trend' ? rows.slice(-12).reverse() : rows.slice(0, 12);
  const blocks: string[] = [];
  for (const row of visible) {
    const block = `\n\n**${query.view === 'trend' ? row.label : literal(row.label)} · ${displayMoney(row.totals[mainKey], report.primaryCurrency, locale)}**\n${amounts(row.totals, report.primaryCurrency).join(' · ')}\n${t('nl_query_matching')}${colon}${row.total}`;
    if (
      `${body}${blocks.join('')}${block}\n\n${footer}\n\n${t('wechat_report_partial')}`
        .length > 2300
    )
      break;
    blocks.push(block);
  }
  if (query.view === 'trend') blocks.reverse();
  body += blocks.join('');
  if (blocks.length < rows.length) body += `\n\n${t('wechat_report_partial')}`;
  return `${body}\n\n---\n\n${footer}`;
}
