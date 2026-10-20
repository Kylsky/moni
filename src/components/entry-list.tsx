import { Checkbox } from '@base-ui/react/checkbox';
import { Input } from '@base-ui/react/input';
import { Popover } from '@base-ui/react/popover';
import {
  IconArrowBackUp,
  IconBriefcase,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconFilter,
  IconHanger,
  IconRun,
  IconSearch,
  IconToolsKitchen2,
  IconWallet,
} from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { currencies } from '@/ledger/currencies';
import type { Entry } from '@/ledger/entries';
import {
  type EntryFilters,
  type EntryPage,
  entryFilters,
} from '@/ledger/entry-query';
import { displayMoney } from '@/ledger/money';
import type { LedgerSettings } from '@/ledger/settings';
import type { Taxonomy } from '@/ledger/taxonomy';
import { categoryLabel } from '@/lib/category-label';
import { type AppLocale, message } from '@/lib/locale';

export function EntryList({
  data,
  taxonomy,
  settings,
  locale,
  filters,
  onApply,
}: {
  data: EntryPage;
  taxonomy: Taxonomy;
  settings: LedgerSettings;
  locale: AppLocale;
  filters: EntryFilters;
  onApply: (value: EntryFilters) => void;
}) {
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const category = (entry: Entry) =>
    categoryLabel(entry.categoryName, entry.categoryKey, locale);
  const kind = (entry: Entry) =>
    t(
      entry.kind === 'income'
        ? 'entry_income'
        : entry.kind === 'refund'
          ? 'query_refund'
          : 'entry_expense'
    );
  const icon = (entry: Entry) => {
    const Icon =
      entry.kind === 'refund'
        ? IconArrowBackUp
        : entry.kind === 'income'
          ? IconBriefcase
          : entry.categoryKey === 'expense-food'
            ? IconToolsKitchen2
            : entry.categoryKey === 'expense-sports'
              ? IconRun
              : entry.categoryKey === 'expense-clothing'
                ? IconHanger
                : IconWallet;
    return (
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${entry.kind === 'expense' ? 'bg-orange/10' : 'bg-green/20'}`}
      >
        <Icon size={21} aria-hidden />
      </span>
    );
  };
  const kindBadge = (entry: Entry) => (
    <span
      className={`inline-flex max-w-full rounded-full px-2.5 py-1 text-xs font-bold ${entry.kind === 'expense' ? 'bg-orange/10' : 'bg-green/20'}`}
    >
      {kind(entry)}
    </span>
  );
  const tags = (entry: Entry) =>
    entry.tags.map((tag) => (
      <span
        key={tag.id}
        className="max-w-full break-words rounded-full bg-yellow/20 px-2.5 py-1 text-xs text-muted-foreground"
      >
        {tag.name}
      </span>
    ));
  const active = Boolean(
    filters.from ||
      filters.to ||
      filters.kind ||
      filters.currency ||
      filters.categoryId ||
      filters.tagIds?.length ||
      filters.requiredTagIds?.length ||
      filters.untagged ||
      filters.keyword
  );
  return (
    <>
      <section
        className="rounded-2xl border border-foreground/10 bg-surface p-4 md:px-5 md:pt-5"
        aria-label={t('query_filters')}
      >
        <EntryFilterForm
          key={JSON.stringify(filters)}
          filters={filters}
          taxonomy={taxonomy}
          locale={locale}
          onApply={onApply}
        />
      </section>
      <output className="my-5 flex items-center gap-2 text-sm font-bold text-muted-foreground">
        <span className="size-1.5 rounded-full bg-orange" aria-hidden />
        {t('query_matches')} {data.total}
      </output>
      {!data.items.length ? (
        <div className="rounded-2xl border border-dashed border-foreground/20 bg-surface/60 px-5 py-10 text-center">
          <img
            alt=""
            src="/moni/illustrations/assistant-search.png"
            className="mx-auto w-40"
          />
          <h2 className="mt-3 text-xl font-bold">
            {t(active || data.total > 0 ? 'query_empty' : 'app_empty_ledger')}
          </h2>
          <p className="mt-3 text-muted-foreground">
            {t(
              active || data.total > 0
                ? 'query_empty_hint'
                : 'app_empty_description'
            )}
          </p>
        </div>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-2xl border border-foreground/10 bg-surface xl:block">
            <table className="w-full min-w-[980px] table-fixed text-left text-sm">
              <caption className="sr-only">{t('app_entries')}</caption>
              <thead className="border-b border-foreground/10 bg-muted/25 text-xs text-muted-foreground">
                <tr>
                  <th className="w-28 p-4 font-bold">{t('entry_date')}</th>
                  <th className="w-[26%] p-4">{t('entry_name')}</th>
                  <th className="w-24 p-4">{t('query_type')}</th>
                  <th className="w-24 p-4">{t('entry_category')}</th>
                  <th className="w-32 p-4">{t('entry_tags')}</th>
                  <th className="w-36 p-4 text-right">
                    {t('entry_amount')} ({t('query_currency')})
                  </th>
                  <th className="w-36 p-4 text-right">
                    {t('query_equivalent')} ({settings.primaryCurrency})
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-foreground/10">
                {data.items.map((entry) => (
                  <tr
                    key={entry.id}
                    className="transition-colors hover:bg-muted/20"
                  >
                    <td className="p-4 align-top text-xs text-muted-foreground tabular-nums">
                      <time dateTime={entry.date}>{entry.date}</time>
                    </td>
                    <td className="min-w-0 p-4 align-top">
                      <Link
                        to="/"
                        search={{ view: 'entries', entry: entry.id, filters }}
                        className="group flex min-h-11 items-start gap-3 rounded-lg outline-none focus-visible:ring-4 focus-visible:ring-focus"
                      >
                        {icon(entry)}
                        <div className="min-w-0 flex-1">
                          <h2 className="break-words font-bold group-hover:underline decoration-orange underline-offset-4">
                            {entry.name}
                          </h2>
                          {entry.note && (
                            <p className="mt-2 line-clamp-2 break-words text-sm text-muted-foreground">
                              {entry.note}
                            </p>
                          )}
                        </div>
                      </Link>
                    </td>
                    <td className="break-words p-4 align-top text-sm">
                      {kindBadge(entry)}
                    </td>
                    <td className="break-words p-4 align-top text-sm">
                      {category(entry)}
                    </td>
                    <td className="p-4 align-top">
                      <div className="flex flex-wrap gap-2">{tags(entry)}</div>
                    </td>
                    <td className="p-4 text-right align-top font-extrabold tabular-nums">
                      <span className="break-words">
                        {displayMoney(
                          entry.originalMinor,
                          entry.currency,
                          locale
                        )}
                      </span>
                    </td>
                    <td className="break-words p-4 text-right align-top font-extrabold tabular-nums">
                      {displayMoney(
                        entry.baseMinor,
                        settings.primaryCurrency,
                        locale
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-foreground/10 rounded-2xl border border-foreground/10 bg-surface px-4 xl:hidden">
            {data.items.map((entry) => (
              <li key={entry.id}>
                <Link
                  to="/"
                  search={{ view: 'entries', entry: entry.id, filters }}
                  className="group block rounded-xl py-5 outline-none hover:bg-muted/20 focus-visible:ring-4 focus-visible:ring-focus"
                >
                  <div className="flex items-start gap-3">
                    {icon(entry)}
                    <div className="min-w-0 flex-1">
                      <h2 className="break-words font-bold leading-snug group-hover:underline decoration-orange underline-offset-4">
                        {entry.name}
                      </h2>
                      <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                        <time dateTime={entry.date}>{entry.date}</time>
                      </p>
                    </div>
                    <div className="ml-auto min-w-0 max-w-[48%] text-right">
                      <p className="break-words font-extrabold tabular-nums">
                        {displayMoney(
                          entry.originalMinor,
                          entry.currency,
                          locale
                        )}
                      </p>
                      {entry.currency !== settings.primaryCurrency && (
                        <p className="mt-1 break-words text-xs text-muted-foreground">
                          {t('query_equivalent')}{' '}
                          {displayMoney(
                            entry.baseMinor,
                            settings.primaryCurrency,
                            locale
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {kindBadge(entry)}
                    <span className="max-w-full break-words rounded-full bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground">
                      {category(entry)}
                    </span>
                    {tags(entry)}
                    <IconChevronRight
                      size={16}
                      className="ml-auto shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  </div>
                  {entry.note && (
                    <p className="mt-3 line-clamp-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                      {entry.note}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      <section
        aria-label={t('query_totals')}
        className="mt-5 rounded-2xl border border-foreground/10 bg-surface p-4 md:p-5"
      >
        <h2 className="text-sm font-bold text-muted-foreground">
          {t('query_totals')} · {data.primaryCurrency}
        </h2>
        <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {(['income', 'expense', 'refund', 'netExpense'] as const).map(
            (key) => (
              <div
                key={key}
                className={`min-w-0 rounded-xl p-3 ${key === 'netExpense' ? 'bg-orange/10' : 'bg-muted/25'}`}
              >
                <dt className="text-sm text-muted-foreground">
                  {t(
                    key === 'income'
                      ? 'entry_income'
                      : key === 'expense'
                        ? 'entry_expense'
                        : key === 'refund'
                          ? 'query_refund'
                          : 'query_net_expense'
                  )}
                </dt>
                <dd className="mt-2 break-words text-lg font-extrabold tracking-tight tabular-nums">
                  {displayMoney(data.totals[key], data.primaryCurrency, locale)}
                </dd>
              </div>
            )
          )}
        </dl>
        {filters.currency && data.originalTotals && (
          <div className="mt-5 border-t border-muted pt-4">
            <h3 className="font-bold">
              {t('query_original_totals')} · {filters.currency}
            </h3>
            <dl className="mt-3 grid grid-cols-2 gap-4 md:grid-cols-4">
              {(['income', 'expense', 'refund', 'netExpense'] as const).map(
                (key) => (
                  <div key={key}>
                    <dt className="text-sm text-muted-foreground">
                      {t(
                        key === 'income'
                          ? 'entry_income'
                          : key === 'expense'
                            ? 'entry_expense'
                            : key === 'refund'
                              ? 'query_refund'
                              : 'query_net_expense'
                      )}
                    </dt>
                    <dd className="mt-1 break-words font-extrabold tabular-nums">
                      {displayMoney(
                        data.originalTotals?.[key] ?? 0,
                        filters.currency as NonNullable<
                          EntryFilters['currency']
                        >,
                        locale
                      )}
                    </dd>
                  </div>
                )
              )}
            </dl>
          </div>
        )}
      </section>
      {data.pageCount > 1 || filters.page > 1 ? (
        <nav
          aria-label={t('query_pagination')}
          className="mt-6 flex flex-wrap items-center justify-center gap-4"
        >
          <Button
            variant="plain"
            disabled={filters.page <= 1}
            onClick={() => onApply({ ...filters, page: filters.page - 1 })}
          >
            <IconChevronLeft size={20} aria-hidden />
            {t('query_previous')}
          </Button>
          <span className="tabular-nums">
            {filters.page} / {Math.max(1, data.pageCount)}
          </span>
          <Button
            variant="plain"
            disabled={filters.page >= data.pageCount}
            onClick={() => onApply({ ...filters, page: filters.page + 1 })}
          >
            {t('query_next')}
            <IconChevronRight size={20} aria-hidden />
          </Button>
        </nav>
      ) : null}
    </>
  );
}

export function EntryFilterForm({
  filters,
  taxonomy,
  locale,
  onApply,
}: {
  filters: EntryFilters;
  taxonomy: Taxonomy;
  locale: AppLocale;
  onApply: (value: EntryFilters) => void;
}) {
  const [draft, setDraft] = useState(filters);
  const filterId = useId();
  const [expanded, setExpanded] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const summary = [
    filters.kind
      ? t(
          filters.kind === 'income'
            ? 'entry_income'
            : filters.kind === 'spending'
              ? 'query_spending'
              : filters.kind === 'expense'
                ? 'entry_expense'
                : 'query_refund'
        )
      : '',
    filters.categoryId
      ? categoryLabel(
          taxonomy.categories.find((item) => item.id === filters.categoryId)
            ?.name ?? t('query_unknown_filter'),
          taxonomy.categories.find((item) => item.id === filters.categoryId)
            ?.defaultKey ?? null,
          locale
        )
      : '',
    filters.currency,
    filters.untagged ? t('report_untagged') : '',
    ...(filters.requiredTagIds ?? []).map(
      (id) =>
        taxonomy.tags.find((tag) => tag.id === id)?.name ??
        t('query_unknown_filter')
    ),
    ...(filters.tagIds ?? []).map(
      (id) =>
        taxonomy.tags.find((tag) => tag.id === id)?.name ??
        t('query_unknown_filter')
    ),
  ].filter(Boolean);
  return (
    <form
      aria-label={t('query_filters')}
      className="mb-6"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = entryFilters.safeParse({ ...draft, page: 1 });
        setInvalid(!parsed.success);
        if (parsed.success) onApply(parsed.data);
      }}
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-[2fr_1fr_1fr]">
        <label
          htmlFor={`${filterId}-keyword`}
          className="col-span-2 block min-w-0 font-bold lg:col-span-1"
        >
          <span className="mb-2 flex items-center gap-2">
            <IconSearch size={20} aria-hidden />
            {t('query_keyword')}
          </span>
          <Input
            id={`${filterId}-keyword`}
            type="search"
            value={draft.keyword ?? ''}
            onChange={(event) =>
              setDraft({ ...draft, keyword: event.target.value || undefined })
            }
            className="moni-field"
          />
        </label>
        <label htmlFor={`${filterId}-from`} className="block min-w-0 font-bold">
          {t('query_from')}
          <Input
            id={`${filterId}-from`}
            type="date"
            value={draft.from ?? ''}
            onChange={(event) =>
              setDraft({ ...draft, from: event.target.value || undefined })
            }
            className="moni-field mt-2"
          />
        </label>
        <label htmlFor={`${filterId}-to`} className="block min-w-0 font-bold">
          {t('query_to')}
          <Input
            id={`${filterId}-to`}
            type="date"
            value={draft.to ?? ''}
            onChange={(event) =>
              setDraft({ ...draft, to: event.target.value || undefined })
            }
            className="moni-field mt-2"
          />
        </label>
      </div>
      <Button
        type="button"
        variant="plain"
        className="mt-3 md:hidden"
        aria-expanded={expanded}
        aria-controls="entry-more-filters"
        onClick={() => setExpanded(!expanded)}
      >
        <IconFilter size={20} aria-hidden />
        {t('query_more')}
      </Button>
      <div
        id="entry-more-filters"
        className={`${expanded ? 'grid' : 'hidden md:grid'} mt-3 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4`}
      >
        <div className="min-w-0 font-bold">
          <p className="mb-2 text-sm">{t('query_type')}</p>
          <Select
            label={t('query_type')}
            value={draft.kind ?? ''}
            onValueChange={(value) =>
              setDraft({
                ...draft,
                kind: value || undefined,
                categoryId: undefined,
              })
            }
            items={[
              { value: '', label: t('query_all') },
              { value: 'spending', label: t('query_spending') },
              { value: 'expense', label: t('entry_expense') },
              { value: 'income', label: t('entry_income') },
              { value: 'refund', label: t('query_refund') },
            ]}
          />
        </div>
        <div className="min-w-0 font-bold">
          <p className="mb-2 text-sm">{t('entry_category')}</p>
          <Select
            label={t('entry_category')}
            value={draft.categoryId ?? ''}
            onValueChange={(value) =>
              setDraft({
                ...draft,
                categoryId: value || undefined,
              })
            }
            items={[
              { value: '', label: t('query_all') },
              ...taxonomy.categories
                .filter(
                  (item) =>
                    !draft.kind ||
                    item.kind ===
                      (draft.kind === 'income' ? 'income' : 'expense')
                )
                .map((item) => ({
                  value: item.id,
                  label: `${!draft.kind ? `${t(item.kind === 'income' ? 'entry_income' : 'entry_expense')} · ` : ''}${categoryLabel(item.name, item.defaultKey, locale)}`,
                })),
            ]}
          />
        </div>
        <div className="min-w-0 font-bold">
          <p className="mb-2 text-sm">{t('query_currency')}</p>
          <Select
            label={t('query_currency')}
            value={draft.currency ?? ''}
            onValueChange={(value) =>
              setDraft({
                ...draft,
                currency: value || undefined,
              })
            }
            items={[
              { value: '', label: t('query_all') },
              ...currencies.map((code) => ({ value: code, label: code })),
            ]}
          />
        </div>
        <Popover.Root>
          <Popover.Trigger className="flex min-h-11 min-w-0 items-center justify-between gap-2 self-end rounded-xl border border-foreground/20 bg-surface px-3 py-2 text-left text-sm font-bold outline-none hover:border-foreground/50 focus-visible:ring-4 focus-visible:ring-focus">
            {t('query_tags_any')} ({draft.tagIds?.length ?? 0})
            <IconChevronDown size={18} className="shrink-0" aria-hidden />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner
              sideOffset={6}
              align="start"
              className="z-[100] outline-none"
            >
              <Popover.Popup className="max-h-[min(20rem,var(--available-height))] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-foreground/20 bg-surface p-3 text-foreground shadow-lg outline-none">
                <Popover.Title className="mb-2 text-sm font-bold">
                  {t('query_tags_any')}
                </Popover.Title>
                {taxonomy.tags.length ? (
                  taxonomy.tags.map((tag) => (
                    <label
                      key={tag.id}
                      htmlFor={`${filterId}-${tag.id}`}
                      className="flex min-h-11 cursor-pointer items-center gap-3"
                    >
                      <Checkbox.Root
                        id={`${filterId}-${tag.id}`}
                        className="flex size-5 shrink-0 items-center justify-center rounded border border-muted-foreground outline-none focus-visible:ring-4 focus-visible:ring-focus data-[checked]:border-orange data-[checked]:bg-orange data-[checked]:text-ink"
                        checked={draft.tagIds?.includes(tag.id) ?? false}
                        onCheckedChange={(checked) =>
                          setDraft({
                            ...draft,
                            tagIds: checked
                              ? [...(draft.tagIds ?? []), tag.id]
                              : draft.tagIds?.filter((id) => id !== tag.id),
                          })
                        }
                      >
                        <Checkbox.Indicator>
                          <IconCheck size={16} stroke={3} aria-hidden />
                        </Checkbox.Indicator>
                      </Checkbox.Root>
                      <span className="break-words">{tag.name}</span>
                    </label>
                  ))
                ) : (
                  <p className="text-sm">{t('query_no_tags')}</p>
                )}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>
      {summary.length > 0 && (
        <p className="mt-3 break-words text-sm text-muted-foreground">
          {t('query_active')} {summary.join(' · ')}
        </p>
      )}
      {invalid && (
        <p role="alert" className="mt-3 font-bold">
          {t('query_invalid')}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        <Button type="submit">{t('query_apply')}</Button>
        <Button
          type="button"
          variant="plain"
          onClick={() => {
            setDraft(entryFilters.parse({}));
            setInvalid(false);
            onApply(entryFilters.parse({}));
          }}
        >
          {t('query_clear')}
        </Button>
      </div>
    </form>
  );
}
