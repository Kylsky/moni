import { Input } from '@base-ui/react/input';
import {
  IconArrowLeft,
  IconEdit,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DownloadButton } from '@/components/download-button';
import { EntryConfirmation } from '@/components/entry-confirmation';
import { EntryFilterForm, EntryList } from '@/components/entry-list';
import { RefundWorkspace } from '@/components/refund-workspace';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { prepareConversion } from '@/ledger/conversion';
import { type Currency, currencies } from '@/ledger/currencies';
import { todayInZone } from '@/ledger/dates';
import type { Entry } from '@/ledger/entries';
import {
  type EntryFilters,
  type EntryPage,
  entryFilters,
} from '@/ledger/entry-query';
import { amountMinor, decimalAmount, displayMoney } from '@/ledger/money';
import {
  applyReference,
  type ReferenceQuote,
} from '@/ledger/reference-conversion';
import type { LedgerSettings } from '@/ledger/settings';
import type { Category, Taxonomy } from '@/ledger/taxonomy';
import { categoryLabel } from '@/lib/category-label';
import { ApiError, privateApi } from '@/lib/client-api';
import { type AppLocale, message } from '@/lib/locale';

export function EntryWorkspace({
  settings,
  locale,
  entryId,
  filters: requestedFilters,
  editing,
  onDataChange,
}: {
  settings: LedgerSettings;
  locale: AppLocale;
  entryId?: string;
  filters?: EntryFilters;
  editing?: boolean;
  onDataChange: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [items, setItems] = useState<Entry[]>([]);
  const [pageData, setPageData] = useState<EntryPage | null>(null);
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null);
  const filters = requestedFilters ?? entryFilters.parse({});
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [tooLarge, setTooLarge] = useState(false);
  const [failed, setFailed] = useState(false);
  const loadGeneration = useRef(0);
  const navigate = useNavigate();
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const catalog = await privateApi<Taxonomy>('taxonomy');
      if (generation !== loadGeneration.current) return;
      if (catalog.datasetId !== settings.datasetId)
        throw new Error('dataset_changed');
      setTaxonomy(catalog);
      setCategories(catalog.categories);
      const result =
        entryId === 'new'
          ? []
          : entryId
            ? await privateApi<Entry[]>(
                `entries?id=${encodeURIComponent(entryId)}`
              )
            : await privateApi<EntryPage>(
                'entries/query',
                requestedFilters ?? {}
              );
      if (generation !== loadGeneration.current) return;
      if (!Array.isArray(result) && result.datasetId !== settings.datasetId)
        throw new Error('dataset_changed');
      setItems(Array.isArray(result) ? result : result.items);
      setPageData(Array.isArray(result) ? null : result);
      setTaxonomy(catalog);
      setCategories(catalog.categories);
      setFailed(false);
    } catch (error) {
      if (generation === loadGeneration.current) {
        setTooLarge(error instanceof ApiError && error.status === 413);
        setFailed(true);
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [entryId, requestedFilters, settings.datasetId]);
  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current++;
    };
  }, [load]);
  if (loading)
    return (
      <div aria-busy="true" className="space-y-5">
        <output className="text-sm text-muted-foreground">
          {t('entry_loading')}
        </output>
        <div
          aria-hidden
          className="h-32 rounded-2xl bg-muted/35 motion-safe:animate-pulse"
        />
        <div
          aria-hidden
          className="h-72 rounded-2xl bg-muted/35 motion-safe:animate-pulse"
        />
      </div>
    );
  if (failed)
    return (
      <div>
        <p role="alert" className="mb-5">
          {t(tooLarge ? 'query_aggregate_error' : 'entry_load_error')}
        </p>
        <Button onClick={load}>{t('app_retry')}</Button>
        {taxonomy && !entryId && (
          <div className="mt-6">
            <EntryFilterForm
              filters={filters}
              taxonomy={taxonomy}
              locale={locale}
              onApply={(next) => {
                void navigate({
                  to: '/',
                  search: { view: 'entries', filters: next },
                });
              }}
            />
          </div>
        )}
      </div>
    );
  const current =
    entryId && entryId !== 'new'
      ? items.find((item) => item.id === entryId)
      : undefined;
  if (current?.kind === 'refund' && editing && current.refundOf)
    return (
      <RefundWorkspace
        expenseId={current.refundOf}
        refund={current}
        settings={settings}
        locale={locale}
        onSaved={async (id) => {
          await onDataChange();
          await navigate({
            to: '/',
            search: { view: 'entries', entry: id, filters },
          });
        }}
        onCancel={() =>
          navigate({
            to: '/',
            search: { view: 'entries', entry: current.id, filters },
          })
        }
      />
    );
  if (entryId === 'new' || (current && editing))
    return (
      <EntryForm
        key={current?.id ?? 'new'}
        entry={current}
        settings={settings}
        categories={categories}
        locale={locale}
        onSaved={async (id) => {
          await onDataChange();
          await navigate({
            to: '/',
            search: { view: 'entries', entry: id, filters },
          });
        }}
        onCancel={() =>
          navigate({
            to: '/',
            search: {
              view: 'entries',
              filters,
              ...(current ? { entry: current.id } : {}),
            },
          })
        }
      />
    );
  if (current)
    return (
      <>
        <Link
          to="/"
          search={{ view: 'entries', filters }}
          className="mb-6 inline-flex min-h-11 items-center gap-2 font-bold focus-visible:outline-4 focus-visible:outline-focus"
        >
          <IconArrowLeft aria-hidden size={20} />
          {t('app_entries')}
        </Link>
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <h1 className="min-w-0 max-w-full break-words text-3xl font-extrabold">
            {current.name}
          </h1>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="plain"
              className="border-foreground/15!"
              onClick={() =>
                navigate({
                  to: '/',
                  search: {
                    view: 'entries',
                    entry: current.id,
                    edit: true,
                    filters,
                  },
                })
              }
            >
              <IconEdit aria-hidden size={20} />
              {t('entry_edit')}
            </Button>
            <Button
              variant="plain"
              className="border-foreground/15! text-muted-foreground"
              onClick={() => setDeleting(true)}
            >
              <IconTrash size={20} aria-hidden />
              {t('trash_delete')}
            </Button>
          </div>
        </div>
        {deleting && (
          <EntryConfirmation
            entry={current}
            datasetId={settings.datasetId}
            action="delete"
            locale={locale}
            onClose={() => setDeleting(false)}
            onSaved={async () => {
              await navigate({ to: '/', search: { view: 'entries', filters } });
            }}
          />
        )}
        <section className="rounded-2xl border border-foreground/10 bg-surface p-5 md:p-7">
          <p className="text-sm text-muted-foreground">
            {t(
              current.kind === 'income'
                ? 'entry_income'
                : current.kind === 'refund'
                  ? 'query_refund'
                  : 'entry_expense'
            )}
          </p>
          <p className="mt-3 break-words text-3xl font-extrabold tracking-tight tabular-nums md:text-4xl">
            {displayMoney(current.originalMinor, current.currency, locale)}
          </p>
          {current.conversion && (
            <div className="mt-5 rounded-xl bg-yellow/15 p-4">
              {current.refundOf && !current.refundActual && (
                <p className="mb-2 text-sm">{t('refund_original_basis')}</p>
              )}
              <p className="font-bold">
                {t('query_equivalent')}{' '}
                {displayMoney(
                  current.baseMinor,
                  settings.primaryCurrency,
                  locale
                )}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {t(
                  current.conversion.method === 'actual'
                    ? 'fx_actual_source'
                    : current.conversion.method === 'reference'
                      ? 'fx_reference_source'
                      : 'fx_manual_source'
                )}
              </p>
              {current.conversion.rate && (
                <p className="mt-1 break-words text-sm">
                  1 {current.currency}{' '}
                  {current.conversion.method === 'reference' ? '≈' : '='}{' '}
                  {current.conversion.rate} {settings.primaryCurrency} ·{' '}
                  {current.conversion.quoteDate}
                </p>
              )}
              <p className="mt-2 text-sm text-muted-foreground">
                {t('fx_fixed')}
              </p>
            </div>
          )}
          <dl className="mt-7 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-5 border-t border-foreground/10 pt-6 text-sm">
            <dt className="text-muted-foreground">{t('entry_date')}</dt>
            <dd>{current.date}</dd>
            <dt className="text-muted-foreground">{t('entry_category')}</dt>
            <dd className="break-words">
              {categoryLabel(current.categoryName, current.categoryKey, locale)}
            </dd>
            <dt className="text-muted-foreground">{t('entry_tags')}</dt>
            <dd className="flex flex-wrap gap-2">
              {current.tags.length
                ? current.tags.map((tag) => (
                    <span
                      key={tag.id}
                      className="min-w-0 max-w-full break-words rounded-full bg-yellow/25 px-3 py-1"
                    >
                      {tag.name}
                    </span>
                  ))
                : '—'}
            </dd>
            <dt className="text-muted-foreground">{t('entry_note')}</dt>
            <dd className="whitespace-pre-wrap break-words">
              {current.note || t('entry_no_note')}
            </dd>
          </dl>
        </section>
        {current.refundOf && (
          <Link
            to="/"
            search={{ view: 'entries', entry: current.refundOf, filters }}
            className="mt-5 inline-flex min-h-11 items-center font-bold underline decoration-orange underline-offset-4"
          >
            {t('refund_original')}
          </Link>
        )}
        {current.kind === 'expense' && (
          <RefundWorkspace
            expenseId={current.id}
            settings={settings}
            locale={locale}
            onSaved={async (id) => {
              await onDataChange();
              await navigate({
                to: '/',
                search: { view: 'entries', entry: id, filters },
              });
            }}
          />
        )}
      </>
    );
  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4 md:mb-8">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight md:text-4xl">
            {t('app_entries')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('entry_overview')}
          </p>
        </div>
        <div className="grid w-full grid-cols-2 gap-3 sm:flex sm:w-auto">
          <DownloadButton
            className="border-foreground/15! text-sm!"
            path="exports/csv"
            body={{ datasetId: settings.datasetId, filters }}
            datasetId={settings.datasetId}
            filename="moni-entries.csv"
            label={t('export_csv')}
            locale={locale}
          />
          <Button
            className="text-sm! sm:flex-none"
            onClick={() =>
              navigate({
                to: '/',
                search: { view: 'entries', entry: 'new', filters },
              })
            }
          >
            <IconPlus size={20} aria-hidden />
            {t('entry_manual')}
          </Button>
        </div>
      </div>
      {pageData && taxonomy && (
        <EntryList
          data={pageData}
          taxonomy={taxonomy}
          settings={settings}
          locale={locale}
          filters={filters}
          onApply={(next) => {
            void navigate({
              to: '/',
              search: { view: 'entries', filters: next },
            });
          }}
        />
      )}
    </>
  );
}

function EntryForm({
  entry,
  settings,
  categories,
  locale,
  onSaved,
  onCancel,
}: {
  entry?: Entry;
  settings: LedgerSettings;
  categories: Category[];
  locale: AppLocale;
  onSaved: (id: string) => Promise<void>;
  onCancel: () => unknown;
}) {
  const [id] = useState(() => entry?.id ?? crypto.randomUUID());
  const [kind, setKind] = useState<'income' | 'expense'>(
    entry?.kind === 'income' ? 'income' : 'expense'
  );
  const [name, setName] = useState(entry?.name ?? '');
  const [amount, setAmount] = useState(
    entry ? decimalAmount(entry.originalMinor, entry.currency) : ''
  );
  const [currency, setCurrency] = useState<Currency>(
    entry?.currency ?? settings.primaryCurrency
  );
  const [basis, setBasis] = useState<'manual_rate' | 'actual' | 'reference'>(
    entry?.conversion?.method ?? 'reference'
  );
  const [quote, setQuote] = useState<ReferenceQuote | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [quoteRefresh, setQuoteRefresh] = useState(0);
  const quoteOperation = useRef<{ key: string; id: string } | null>(null);
  const [rate, setRate] = useState(entry?.conversion?.rate ?? '');
  const [actualAmount, setActualAmount] = useState(
    entry?.conversion?.method === 'actual'
      ? decimalAmount(entry.baseMinor, settings.primaryCurrency)
      : ''
  );
  const [quoteDate, setQuoteDate] = useState(
    entry?.conversion?.quoteDate ??
      entry?.date ??
      todayInZone(settings.timeZone)
  );
  const [date, setDate] = useState(
    entry?.date ?? todayInZone(settings.timeZone)
  );
  const [categoryId, setCategoryId] = useState(
    entry?.categoryId ?? 'expense-uncategorized'
  );
  const [tags, setTags] = useState(
    entry?.tags.map((tag) => tag.name).join(', ') ?? ''
  );
  const [note, setNote] = useState(entry?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<
    'amount' | 'fields' | 'conversion' | 'save' | null
  >(null);
  const conversionRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const tagsRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const operation = useRef<{ value: string; id: string } | null>(null);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const foreign = currency !== settings.primaryCurrency;
  let originalMinor: number | null = null;
  try {
    originalMinor = amountMinor(amount, currency);
  } catch {
    originalMinor = null;
  }
  const financialUnchanged = Boolean(
    entry &&
      entry.currency === currency &&
      entry.date === date &&
      originalMinor === entry.originalMinor
  );
  const basisUnchanged = Boolean(
    entry?.conversion &&
      basis === entry.conversion.method &&
      (basis === 'reference'
        ? !quote && quoteRefresh === 0
        : basis === 'actual'
          ? actualAmount ===
            decimalAmount(entry.baseMinor, settings.primaryCurrency)
          : rate === entry.conversion.rate &&
            quoteDate === entry.conversion.quoteDate)
  );
  const preserve = foreign && financialUnchanged && basisUnchanged;
  const preserveReference = preserve && basis === 'reference';
  useEffect(() => {
    setQuote(null);
    setQuoteFailed(false);
    setQuoteBusy(false);
    if (!foreign || basis !== 'reference' || preserveReference) return;
    const key = `${settings.datasetId}:${currency}:${date}:${quoteRefresh}`;
    if (quoteOperation.current?.key !== key)
      quoteOperation.current = { key, id: crypto.randomUUID() };
    const controller = new AbortController();
    setQuoteBusy(true);
    void privateApi<ReferenceQuote>(
      'rates/preview',
      {
        datasetId: settings.datasetId,
        operationId: quoteOperation.current.id,
        currency,
        date,
      },
      'POST',
      controller.signal
    )
      .then((result) => {
        if (!controller.signal.aborted) setQuote(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setQuoteFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setQuoteBusy(false);
      });
    return () => controller.abort();
  }, [
    foreign,
    basis,
    currency,
    date,
    settings.datasetId,
    preserveReference,
    quoteRefresh,
  ]);
  const conversion =
    basis === 'actual'
      ? { actualAmount }
      : basis === 'reference'
        ? { quoteId: quote?.id }
        : { rate, quoteDate };
  let preview: ReturnType<typeof prepareConversion> | null = null;
  if (foreign) {
    try {
      preview =
        preserve && entry?.conversion
          ? { baseMinor: entry.baseMinor, snapshot: entry.conversion }
          : basis === 'reference'
            ? quote
              ? applyReference(
                  amountMinor(amount, currency),
                  currency,
                  settings.primaryCurrency,
                  date,
                  quote
                )
              : null
            : prepareConversion(
                amountMinor(amount, currency),
                currency,
                settings.primaryCurrency,
                date,
                conversion
              );
    } catch {
      preview = null;
    }
  }
  return (
    <div className="mx-auto max-w-4xl">
      <Button
        variant="plain"
        type="button"
        className="mb-2 border-0! bg-transparent! px-0! shadow-none!"
        onClick={onCancel}
        disabled={busy}
      >
        <IconArrowLeft size={20} aria-hidden />
        {t('app_entries')}
      </Button>
      <div className="relative mb-5 md:flex md:items-center md:justify-between md:gap-3">
        <div>
          <h1 className="pr-20 text-3xl font-extrabold md:pr-0">
            {t(entry ? 'entry_edit' : 'entry_manual')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground md:text-base">
            {t('entry_form_hint')}
          </p>
        </div>
        <img
          alt=""
          src="/moni/illustrations/assistant-writing.png"
          className="absolute -top-10 right-0 w-20 md:static md:w-28 md:shrink-0"
        />
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setError(null);
          try {
            amountMinor(amount, currency);
          } catch {
            setError('amount');
            amountRef.current?.focus();
            return;
          }
          if (foreign && !preview) {
            setError('conversion');
            conversionRef.current?.focus();
            return;
          }
          const names = tags
            .split(/[,，]/)
            .map((value) => value.trim())
            .filter(Boolean);
          if (
            !name.trim() ||
            name.trim().length > 120 ||
            note.length > 2000 ||
            names.length > 10 ||
            names.some((value) => value.length > 30)
          ) {
            setError('fields');
            if (!name.trim() || name.trim().length > 120)
              nameRef.current?.focus();
            else if (note.length > 2000) noteRef.current?.focus();
            else tagsRef.current?.focus();
            return;
          }
          const payload = {
            datasetId: settings.datasetId,
            id,
            kind,
            name: name.trim(),
            amount,
            currency,
            ...(!foreign && entry && entry.currency !== currency
              ? { confirmedBaseMinor: originalMinor ?? undefined }
              : {}),
            ...(foreign && preview
              ? {
                  confirmedBaseMinor: preview.baseMinor,
                  ...(!preserve ? { conversion } : {}),
                }
              : {}),
            date,
            categoryId,
            tags: names,
            note,
            ...(entry ? { version: entry.version } : {}),
          };
          const value = JSON.stringify(payload);
          if (operation.current?.value !== value)
            operation.current = { value, id: crypto.randomUUID() };
          setBusy(true);
          try {
            const result = await privateApi<{ entryId: string }>(
              'entries',
              { ...payload, operationId: operation.current.id },
              entry ? 'PUT' : 'POST'
            );
            await onSaved(result.entryId);
          } catch {
            setError('save');
          } finally {
            setBusy(false);
          }
        }}
        className="rounded-2xl border border-foreground/10 bg-surface p-4 md:p-7"
      >
        <fieldset
          disabled={busy}
          className="grid min-w-0 gap-4 md:grid-cols-2 md:gap-5"
        >
          <legend className="sr-only">{t('entry_form_hint')}</legend>
          <div className="md:col-span-2">
            <SegmentedControl
              label={t('query_type')}
              value={kind}
              onValueChange={(value) => {
                setKind(value);
                setCategoryId(`${value}-uncategorized`);
              }}
              items={[
                { value: 'expense', label: t('entry_expense') },
                { value: 'income', label: t('entry_income') },
              ]}
            />
          </div>
          <div className="font-bold">
            <label htmlFor="entry-amount">{t('entry_amount')}</label>
            <div className="mt-2 flex items-center gap-3">
              <Input
                ref={amountRef}
                id="entry-amount"
                aria-invalid={error === 'amount'}
                aria-describedby={
                  error === 'amount'
                    ? 'entry-amount-currency entry-error'
                    : 'entry-amount-currency'
                }
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="moni-field min-w-0 flex-1 text-xl! font-extrabold tabular-nums"
              />
              <span id="entry-amount-currency" className="sr-only">
                {currency}
              </span>
              <div className="w-28 shrink-0">
                <Select
                  label={t('fx_currency')}
                  value={currency}
                  onValueChange={(value) => {
                    setCurrency(value);
                    setRate('');
                    setActualAmount('');
                    setQuoteDate(date);
                  }}
                  items={currencies.map((code) => ({
                    value: code,
                    label: code,
                  }))}
                />
              </div>
            </div>
          </div>
          <label htmlFor="entry-date" className="block font-bold">
            {t('entry_date')}
            <Input
              id="entry-date"
              type="date"
              required
              min="1900-01-01"
              max="9999-12-31"
              value={date}
              onChange={(e) => {
                if (!entry && quoteDate === date) setQuoteDate(e.target.value);
                setDate(e.target.value);
              }}
              className="moni-field mt-2"
            />
          </label>
          <label htmlFor="entry-name" className="block font-bold md:col-span-2">
            {t('entry_name')}
            <Input
              id="entry-name"
              ref={nameRef}
              required
              value={name}
              aria-invalid={name.trim().length > 120}
              onChange={(e) => setName(e.target.value)}
              className="moni-field mt-2"
            />
          </label>
          {!foreign && entry?.conversion && (
            <output
              aria-live="polite"
              className="rounded-xl border border-muted bg-yellow/10 p-4 md:col-span-2"
            >
              <span className="block text-sm">{t('fx_primary_preview')}</span>
              {originalMinor !== null && (
                <strong className="mt-2 block text-2xl tabular-nums">
                  {displayMoney(
                    originalMinor,
                    settings.primaryCurrency,
                    locale
                  )}
                </strong>
              )}
            </output>
          )}
          {foreign && (
            <section
              aria-label={t('fx_basis')}
              className="min-w-0 rounded-xl border border-muted bg-yellow/10 p-4 md:col-span-2"
            >
              <h2 className="font-extrabold">{t('fx_basis')}</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {t('fx_basis_hint')}
              </p>
              <div className="my-4 grid grid-cols-3 gap-2">
                <Button
                  className="px-2! text-sm!"
                  variant={basis === 'reference' ? 'secondary' : 'plain'}
                  aria-pressed={basis === 'reference'}
                  onClick={() => setBasis('reference')}
                >
                  {t('fx_reference')}
                </Button>
                <Button
                  className="px-2! text-sm!"
                  variant={basis === 'manual_rate' ? 'secondary' : 'plain'}
                  aria-pressed={basis === 'manual_rate'}
                  onClick={() => setBasis('manual_rate')}
                >
                  {t('fx_manual')}
                </Button>
                <Button
                  className="px-2! text-sm!"
                  variant={basis === 'actual' ? 'secondary' : 'plain'}
                  aria-pressed={basis === 'actual'}
                  onClick={() => setBasis('actual')}
                >
                  {t('fx_actual')}
                </Button>
              </div>
              {basis === 'reference' ? (
                <div className="text-sm">
                  <p>{t('fx_reference_hint')}</p>
                  <p className="mt-2">
                    {t('entry_date')}：{date}
                  </p>
                  {quoteBusy && (
                    <output className="mt-2 block">{t('fx_loading')}</output>
                  )}
                  {quoteFailed && (
                    <p role="alert" className="mt-2">
                      {t('fx_unavailable')}
                    </p>
                  )}
                  {(quote || preserveReference) && preview?.snapshot && (
                    <p className="mt-2 break-words">
                      1 {currency} ≈ {preview.snapshot.rate}{' '}
                      {settings.primaryCurrency} · {t('fx_actual_quote_date')}：
                      {preview.snapshot.quoteDate}
                    </p>
                  )}
                  <Button
                    className="mt-2"
                    variant="plain"
                    disabled={quoteBusy}
                    onClick={() => setQuoteRefresh((value) => value + 1)}
                  >
                    {t('fx_refresh')}
                  </Button>
                </div>
              ) : basis === 'actual' ? (
                <label
                  htmlFor="entry-actual-amount"
                  className="block font-bold"
                >
                  {t('fx_settlement')} ({settings.primaryCurrency})
                  <Input
                    id="entry-actual-amount"
                    ref={conversionRef}
                    inputMode="decimal"
                    value={actualAmount}
                    onChange={(event) => setActualAmount(event.target.value)}
                    className="moni-field mt-2"
                    aria-invalid={error === 'conversion'}
                  />
                </label>
              ) : (
                <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                  <label
                    htmlFor="entry-rate"
                    className="block min-w-0 font-bold"
                  >
                    {t('fx_rate')} ({currency} → {settings.primaryCurrency})
                    <Input
                      id="entry-rate"
                      ref={conversionRef}
                      inputMode="decimal"
                      value={rate}
                      onChange={(event) => setRate(event.target.value)}
                      className="moni-field mt-2"
                      aria-invalid={error === 'conversion'}
                    />
                  </label>
                  <label
                    htmlFor="entry-quote-date"
                    className="block min-w-0 font-bold"
                  >
                    {t('fx_quote_date')}
                    <Input
                      id="entry-quote-date"
                      type="date"
                      min="1900-01-01"
                      max={date}
                      value={quoteDate}
                      onChange={(event) => setQuoteDate(event.target.value)}
                      className="moni-field mt-2"
                    />
                  </label>
                </div>
              )}
              <output
                className="mt-5 block break-words rounded-xl bg-surface p-4"
                aria-live="polite"
              >
                {preview ? (
                  <>
                    <span className="text-sm text-muted-foreground">
                      {t('fx_confirm_preview')}
                    </span>
                    <strong className="mt-1 block text-2xl tabular-nums">
                      {displayMoney(
                        preview.baseMinor,
                        settings.primaryCurrency,
                        locale
                      )}
                    </strong>
                    <span className="mt-2 block text-sm">
                      {t(
                        basis === 'actual'
                          ? 'fx_actual_source'
                          : basis === 'reference'
                            ? 'fx_reference_source'
                            : 'fx_manual_source'
                      )}
                      {preview.snapshot.quoteDate
                        ? ` · ${preview.snapshot.quoteDate}`
                        : ''}
                    </span>
                  </>
                ) : (
                  t('fx_missing')
                )}
              </output>
            </section>
          )}
          <div className="font-bold">
            <p className="mb-2">{t('entry_category')}</p>
            <Select
              label={t('entry_category')}
              value={categoryId}
              onValueChange={setCategoryId}
              items={categories
                .filter((category) => category.kind === kind)
                .map((category) => ({
                  value: category.id,
                  label: categoryLabel(
                    category.name,
                    category.defaultKey,
                    locale
                  ),
                }))}
            />
          </div>
          <div className="font-bold">
            <label htmlFor="entry-tags">{t('entry_tags')}</label>
            <Input
              id="entry-tags"
              ref={tagsRef}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              aria-describedby="entry-tags-hint"
              className="moni-field mt-2"
            />
            <span
              id="entry-tags-hint"
              className="mt-2 block text-sm font-normal text-muted-foreground"
            >
              {t('entry_tags_hint')}
            </span>
          </div>
          <div className="font-bold md:col-span-2">
            <label htmlFor="entry-note">{t('entry_note')}</label>
            <Input
              render={<textarea rows={3} />}
              id="entry-note"
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-invalid={note.length > 2000}
              aria-describedby="entry-note-hint"
              className="moni-field mt-2 resize-y"
            />
            <span
              id="entry-note-hint"
              className="mt-2 flex justify-between gap-3 text-sm font-normal text-muted-foreground"
            >
              <span>{t('entry_note_hint')}</span>
              <span>{note.length}/2000</span>
            </span>
          </div>
          {!!error && (
            <p
              role="alert"
              id="entry-error"
              className="font-bold md:col-span-2"
            >
              {t(
                error === 'amount'
                  ? 'entry_amount_error'
                  : error === 'fields'
                    ? 'entry_fields_error'
                    : error === 'conversion'
                      ? 'fx_invalid'
                      : 'entry_save_error'
              )}
            </p>
          )}
          <Button type="submit" className="md:col-start-1">
            {t(
              busy
                ? 'app_saving'
                : foreign || entry?.conversion
                  ? 'fx_save'
                  : 'entry_save'
            )}
          </Button>
          <Button variant="plain" onClick={onCancel}>
            {t('entry_cancel')}
          </Button>
        </fieldset>
      </form>
    </div>
  );
}
