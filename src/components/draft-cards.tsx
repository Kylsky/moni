import {
  IconCheck,
  IconCoin,
  IconPencil,
  IconRefresh,
  IconSoup,
} from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { type Currency, currencies } from '@/ledger/currencies';
import type { VisibleDraftReview } from '@/ledger/draft-review';
import { draftReviewSummary } from '@/ledger/draft-review-summary';
import type { Draft, DraftItem } from '@/ledger/drafts';
import { displayMoney } from '@/ledger/money';
import type { ReferenceQuote } from '@/ledger/reference-conversion';
import type { LedgerSettings } from '@/ledger/settings';
import type { Taxonomy } from '@/ledger/taxonomy';
import { categoryLabel } from '@/lib/category-label';
import { privateApi } from '@/lib/client-api';
import { limits } from '@/lib/limits';
import { type AppLocale, message } from '@/lib/locale';

export function DraftCards({
  threadId,
  revision,
  settings,
  locale,
  onPosted,
  onReview,
}: {
  threadId: string;
  revision: number;
  settings: LedgerSettings;
  locale: AppLocale;
  onPosted: () => Promise<void>;
  onReview?: (review: VisibleDraftReview | null) => void;
}) {
  const [data, setData] = useState<{
    items: Draft[];
    taxonomy: Taxonomy;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const current = ++sequence.current;
    const [drafts, taxonomy] = await Promise.all([
      privateApi<{ datasetId: string; items: Draft[] }>(
        `drafts?threadId=${threadId}`
      ),
      privateApi<Taxonomy>('taxonomy'),
    ]);
    if (current !== sequence.current) return;
    if (
      drafts.datasetId !== settings.datasetId ||
      taxonomy.datasetId !== settings.datasetId
    )
      throw new Error('dataset_changed');
    setData({ items: drafts.items, taxonomy });
    setFailed(false);
  }, [threadId, settings.datasetId]);
  useEffect(() => {
    void revision;
    reload().catch(() => setFailed(true));
    return () => {
      sequence.current++;
    };
  }, [reload, revision]);
  useEffect(() => {
    if (!onReview) return;
    const { pending, ready } = draftReviewSummary(data?.items ?? []);
    const selected = ready.length ? ready : pending;
    onReview(
      !failed &&
        selected.length &&
        selected.length <= 20 &&
        selected.reduce((count, draft) => count + draft.items.length, 0) <= 20
        ? {
            operationId: crypto.randomUUID(),
            drafts: selected.map(({ id, version }) => ({ id, version })),
            excludedDraftIds: ready.length
              ? pending
                  .filter((draft) => draft.status === 'needs_details')
                  .map(({ id }) => id)
                  .slice(0, 100)
              : [],
          }
        : null
    );
    return () => onReview(null);
  }, [data, failed, onReview]);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const summary = draftReviewSummary(data?.items ?? []);
  if (!data?.items.length && !failed) return null;
  return (
    <section aria-label={t('draft_title')} className="my-6 space-y-5 md:ml-16">
      {failed && (
        <p role="alert" className="rounded-xl bg-yellow/20 p-4">
          {t('draft_load_error')}
        </p>
      )}

      {summary.pending.length > 0 && (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p className="font-bold">
            {summary.pending.length} {t('wechat_pending_count')} ·{' '}
            {summary.itemCount} {t('draft_items')}
          </p>
          <p>{t('wechat_pending_reminder')}</p>
          {summary.ready.length < summary.pending.length && (
            <p>{t('chat_review_incomplete')}</p>
          )}
          {summary.duplicate && (
            <p role="note" className="rounded-xl bg-yellow/20 p-3">
              {t('wechat_batch_duplicate')}
            </p>
          )}
        </div>
      )}
      {data?.items.map((draft) => (
        <DraftCard
          key={draft.id}
          draft={draft}
          settings={settings}
          locale={locale}
          taxonomy={data.taxonomy}
          onSaved={reload}
          onPosted={onPosted}
        />
      ))}
      <div className="flex justify-end">
        <Button
          variant="plain"
          onClick={() => reload().catch(() => setFailed(true))}
        >
          <IconRefresh size={18} aria-hidden />
          {t('draft_refresh')}
        </Button>
      </div>
    </section>
  );
}

function DraftCard({
  draft,
  settings,
  locale,
  taxonomy,
  onSaved,
  onPosted,
}: {
  draft: Draft;
  settings: LedgerSettings;
  locale: AppLocale;
  taxonomy: Taxonomy;
  onSaved: () => Promise<void>;
  onPosted: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<{
    index: number;
    draft: Draft;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const operation = useRef<{ value: string; id: string } | null>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing === null && wasEditing.current)
      document.getElementById(`${draft.id}-edit`)?.focus();
    wasEditing.current = editing !== null;
  }, [editing, draft.id]);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const pending = ['ready', 'needs_details'].includes(draft.status);
  const staleCurrency = settings.primaryCurrency !== draft.baseCurrency;
  const changeStatus = async (action: 'confirm' | 'cancel') => {
    if (busy) return;
    const value = `${action}:${draft.version}`;
    if (operation.current?.value !== value)
      operation.current = { value, id: crypto.randomUUID() };
    setBusy(true);
    setFailed(false);
    try {
      await privateApi(`drafts/${action}`, {
        datasetId: draft.datasetId,
        id: draft.id,
        version: draft.version,
        operationId: operation.current.id,
        confirmed: true,
      });
      if (action === 'confirm') await onPosted();
      await onSaved();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article
      aria-label={`${t('draft_title')} · ${draft.items.length}`}
      className="rounded-2xl border-2 border-foreground bg-surface p-4 md:p-6"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-muted pb-4">
        <h2 className="text-xl font-extrabold after:mt-2 after:block after:h-1 after:w-8 after:rounded-full after:bg-yellow">
          {t(
            draft.status === 'ready'
              ? 'draft_ready'
              : draft.status === 'needs_details'
                ? 'draft_needs_details'
                : draft.status === 'posted'
                  ? 'draft_posted'
                  : 'draft_cancelled'
          )}{' '}
          · {draft.items.length} {t('draft_items')}
        </h2>
        <span className="text-sm text-muted-foreground">
          {draft.items.every((item) => item.date === draft.items[0].date)
            ? draft.items[0].date
            : t('draft_multiple_dates')}
        </span>
      </header>
      {editing !== null ? (
        <DraftEditor
          draft={editing.draft}
          selected={editing.index}
          settings={settings}
          taxonomy={taxonomy}
          locale={locale}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            await onSaved();
            setEditing(null);
          }}
        />
      ) : (
        <>
          <ul>
            {draft.items.map((item, index) => {
              const category = taxonomy.categories.find(
                (value) => value.id === item.categoryId
              );
              const Icon =
                item.categoryId === 'expense-food' ? IconSoup : IconCoin;
              return (
                <li
                  key={item.id}
                  className="border-b border-muted py-3 md:py-4"
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-1 flex size-10 shrink-0 items-center justify-center rounded-full md:size-14 ${index % 2 ? 'bg-green/35' : 'bg-yellow/40'}`}
                    >
                      <Icon size={26} aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 md:flex md:justify-between md:gap-3">
                        <div className="contents md:block md:min-w-0 md:flex-1">
                          {' '}
                          <h3 className="min-w-0 break-words text-lg font-extrabold">
                            {item.name}
                          </h3>
                          <div className="col-span-2 flex flex-wrap gap-2 text-sm md:mt-2">
                            <span className="rounded-full bg-muted px-3 py-1">
                              {t(
                                item.kind === 'income'
                                  ? 'entry_income'
                                  : 'entry_expense'
                              )}
                            </span>
                            <span className="rounded-full bg-muted px-3 py-1">
                              {category
                                ? categoryLabel(
                                    category.name,
                                    category.defaultKey,
                                    locale
                                  )
                                : item.categoryId}
                            </span>
                            {item.tags.map((tag) => (
                              <span
                                key={tag}
                                className={`rounded-full px-3 py-1 ${index % 2 ? 'bg-green/30' : 'bg-yellow/35'}`}
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                          <div className="col-span-2 flex items-start justify-between gap-2 md:mt-2">
                            <div className="min-w-0 text-sm text-muted-foreground">
                              <p>
                                {item.date} ·{' '}
                                {item.currency ?? t('draft_missing_currency')}
                              </p>
                              {item.note && (
                                <p className="mt-1 whitespace-pre-wrap break-words">
                                  {t('entry_note')}：{item.note}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="col-start-2 row-start-1 flex max-w-48 shrink-0 items-start gap-2 md:max-w-[65%]">
                          <div className="min-w-0 text-right">
                            <p className="break-all text-xl font-extrabold tabular-nums">
                              {item.originalMinor !== null && item.currency
                                ? displayMoney(
                                    item.originalMinor,
                                    item.currency,
                                    locale
                                  )
                                : item.amount
                                  ? `${item.amount} · ${t('draft_missing_currency')}`
                                  : t('draft_missing_amount')}
                            </p>
                            {item.currency &&
                              item.currency !== draft.baseCurrency && (
                                <p className="mt-1 text-sm text-muted-foreground">
                                  {item.baseMinor !== null
                                    ? `${t('draft_converted')} ${displayMoney(item.baseMinor, draft.baseCurrency, locale)}`
                                    : t('draft_missing_conversion')}
                                </p>
                              )}
                          </div>
                          {pending && (
                            <Button
                              variant="icon"
                              aria-label={`${t('draft_edit_item')} · ${item.name}`}
                              disabled={busy}
                              onClick={() => setEditing({ index, draft })}
                            >
                              <IconPencil size={20} aria-hidden />
                            </Button>
                          )}
                        </div>
                      </div>
                      {item.snapshot && (
                        <p className="mt-3 break-words text-sm text-muted-foreground">
                          {item.snapshot.method === 'actual' ? (
                            t('fx_actual_source')
                          ) : (
                            <>
                              {item.snapshot.source === 'ECB'
                                ? t('fx_reference_source')
                                : t('fx_manual_source')}{' '}
                              · 1 {item.currency} = {item.snapshot.rate}{' '}
                              {draft.baseCurrency} · {t('fx_quote_date')}{' '}
                              {item.snapshot.quoteDate}
                            </>
                          )}
                        </p>
                      )}
                      {draft.status === 'posted' && (
                        <Link
                          to="/"
                          search={{ view: 'entries', entry: item.id }}
                          className="mt-2 inline-flex min-h-11 items-center rounded-lg font-bold focus-visible:outline-4 focus-visible:outline-focus"
                        >
                          {t('draft_view_entry')}
                        </Link>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="my-5 flex flex-wrap items-center justify-between gap-3 text-2xl font-extrabold">
            <span>{t('draft_total')}</span>
            <span className="break-all tabular-nums">
              {draft.totalBaseMinor !== null
                ? displayMoney(draft.totalBaseMinor, draft.baseCurrency, locale)
                : t('draft_needs_details')}
            </span>
          </div>
          {pending && (
            <>
              <p className="mb-4 text-sm text-muted-foreground">
                {t(
                  draft.status === 'needs_details'
                    ? 'draft_incomplete_hint'
                    : 'draft_review_hint'
                )}
              </p>
              {staleCurrency && (
                <p role="alert" className="mb-4">
                  {t('draft_currency_changed')}
                </p>
              )}
              {failed && (
                <p role="alert" className="mb-4">
                  {t('draft_action_error')}
                </p>
              )}
              <Button
                className="w-full"
                disabled={busy || draft.status !== 'ready' || staleCurrency}
                onClick={() => changeStatus('confirm')}
              >
                <IconCheck size={22} aria-hidden />
                {t(busy ? 'app_saving' : 'draft_confirm')}
              </Button>
              <div className="mt-3 flex flex-wrap justify-center gap-3">
                <Button
                  id={`${draft.id}-edit`}
                  variant="plain"
                  disabled={busy}
                  onClick={() => setEditing({ index: 0, draft })}
                >
                  {t('draft_edit')}
                </Button>
                <Button
                  variant="plain"
                  disabled={busy}
                  onClick={() => changeStatus('cancel')}
                >
                  {t('draft_cancel')}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </article>
  );
}

type EditableItem = Omit<
  DraftItem,
  'originalMinor' | 'baseMinor' | 'snapshot' | 'missing'
>;
function DraftEditor({
  draft,
  selected,
  settings,
  taxonomy,
  locale,
  onCancel,
  onSaved,
}: {
  draft: Draft;
  selected: number;
  settings: LedgerSettings;
  taxonomy: Taxonomy;
  locale: AppLocale;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [items, setItems] = useState<EditableItem[]>(() =>
    draft.items.map(
      ({
        id,
        kind,
        name,
        amount,
        date,
        currency,
        categoryId,
        tags,
        note,
        conversion,
      }) => ({
        id,
        kind,
        name,
        amount,
        date,
        currency,
        categoryId,
        tags,
        note,
        conversion,
      })
    )
  );
  const [tagText, setTagText] = useState(() =>
    Object.fromEntries(
      draft.items.map((item) => [item.id, item.tags.join(', ')])
    )
  );
  const [busy, setBusy] = useState(false);
  const [quoting, setQuoting] = useState<string | null>(null);
  const [quoteFailed, setQuoteFailed] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const operation = useRef<{ value: string; id: string } | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameField.current?.focus();
  }, []);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const update = (index: number, changes: Partial<EditableItem>) =>
    setItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...changes } : item
      )
    );
  return (
    <form
      className="mt-5 space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || quoting) return;
        const payload = {
          datasetId: draft.datasetId,
          id: draft.id,
          version: draft.version,
          items: items.map((item) => ({
            ...item,
            tags: (tagText[item.id] ?? '')
              .split(/[,，]/)
              .map((name) => name.trim())
              .filter(Boolean),
            amount: item.amount?.trim() || null,
            conversion:
              item.conversion?.rate === '' ||
              item.conversion?.actualAmount === ''
                ? null
                : item.conversion,
          })),
        };
        const value = JSON.stringify(payload);
        if (operation.current?.value !== value)
          operation.current = { value, id: crypto.randomUUID() };
        setBusy(true);
        setFailed(false);
        try {
          await privateApi('drafts/save', {
            ...payload,
            operationId: operation.current.id,
          });
          await onSaved();
        } catch {
          setFailed(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm text-muted-foreground">{t('draft_edit_hint')}</p>
      {items.map((item, index) => (
        <fieldset
          key={item.id}
          disabled={busy || Boolean(quoting)}
          className="grid min-w-0 gap-4 rounded-xl border border-foreground/30 p-4 md:grid-cols-2"
        >
          <legend className="px-2 font-extrabold">
            {index + 1} · {item.name}
          </legend>
          <label className="space-y-2">
            <span className="block font-bold">{t('entry_name')}</span>
            <input
              ref={index === selected ? nameField : undefined}
              value={item.name}
              maxLength={120}
              required
              onChange={(event) => update(index, { name: event.target.value })}
              className="moni-field w-full"
            />
          </label>
          <label className="space-y-2">
            <span className="block font-bold">{t('query_type')}</span>
            <select
              value={item.kind}
              onChange={(event) => {
                const kind = event.target.value as EditableItem['kind'];
                update(index, { kind, categoryId: `${kind}-uncategorized` });
              }}
              className="moni-field w-full"
            >
              <option value="expense">{t('entry_expense')}</option>
              <option value="income">{t('entry_income')}</option>
            </select>
          </label>
          <label className="space-y-2">
            <span className="block font-bold">{t('entry_amount')}</span>
            <input
              inputMode="decimal"
              value={item.amount ?? ''}
              maxLength={20}
              onChange={(event) =>
                update(index, { amount: event.target.value || null })
              }
              className="moni-field w-full"
            />
          </label>
          <label className="space-y-2">
            <span className="block font-bold">{t('fx_currency')}</span>
            <select
              value={item.currency ?? ''}
              onChange={(event) =>
                update(index, {
                  currency: (event.target.value || null) as Currency | null,
                  conversion: null,
                })
              }
              className="moni-field w-full"
            >
              <option value="">{t('draft_missing_currency')}</option>
              {currencies.map((currency) => (
                <option key={currency}>{currency}</option>
              ))}
            </select>
          </label>
          <label className="space-y-2">
            <span className="block font-bold">{t('entry_date')}</span>
            <input
              type="date"
              value={item.date}
              min="1900-01-01"
              max="9999-12-31"
              required
              onChange={(event) =>
                update(index, { date: event.target.value, conversion: null })
              }
              className="moni-field w-full"
            />
          </label>
          <label className="space-y-2">
            <span className="block font-bold">{t('entry_category')}</span>
            <select
              value={item.categoryId}
              onChange={(event) =>
                update(index, { categoryId: event.target.value })
              }
              className="moni-field w-full"
            >
              {taxonomy.categories
                .filter((category) => category.kind === item.kind)
                .map((category) => (
                  <option key={category.id} value={category.id}>
                    {categoryLabel(category.name, category.defaultKey, locale)}
                  </option>
                ))}
            </select>
          </label>
          <label className="space-y-2 md:col-span-2">
            <span className="block font-bold">{t('entry_tags')}</span>
            <input
              aria-label={t('entry_tags')}
              aria-describedby={`${draft.id}-${item.id}-tags-hint`}
              value={tagText[item.id] ?? ''}
              onChange={(event) =>
                setTagText((current) => ({
                  ...current,
                  [item.id]: event.target.value,
                }))
              }
              className="moni-field w-full"
            />
            <span
              id={`${draft.id}-${item.id}-tags-hint`}
              className="block text-sm text-muted-foreground"
            >
              {t('entry_tags_hint')}
            </span>
          </label>
          <label className="space-y-2 md:col-span-2">
            <span className="block font-bold">{t('entry_note')}</span>
            <textarea
              aria-label={t('entry_note')}
              aria-describedby={`${draft.id}-${item.id}-note-hint`}
              rows={2}
              value={item.note}
              maxLength={limits.noteCharacters}
              onChange={(event) => update(index, { note: event.target.value })}
              className="moni-field w-full"
            />
            <span
              id={`${draft.id}-${item.id}-note-hint`}
              className="block text-sm text-muted-foreground"
            >
              {t('entry_note_hint')}
            </span>
          </label>
          {item.currency && item.currency !== settings.primaryCurrency && (
            <div className="space-y-3 md:col-span-2">
              <p className="font-bold">{t('fx_basis')}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant={
                    item.conversion?.quoteId || !item.conversion
                      ? 'secondary'
                      : 'plain'
                  }
                  aria-pressed={
                    Boolean(item.conversion?.quoteId) || !item.conversion
                  }
                  onClick={() =>
                    update(index, {
                      conversion: item.conversion?.quoteId
                        ? item.conversion
                        : null,
                    })
                  }
                >
                  {t('fx_reference')}
                </Button>
                <Button
                  type="button"
                  variant={
                    item.conversion?.rate !== undefined ? 'secondary' : 'plain'
                  }
                  aria-pressed={item.conversion?.rate !== undefined}
                  onClick={() => update(index, { conversion: { rate: '' } })}
                >
                  {t('fx_manual')}
                </Button>
                <Button
                  type="button"
                  variant={
                    item.conversion?.actualAmount !== undefined
                      ? 'secondary'
                      : 'plain'
                  }
                  onClick={() =>
                    update(index, { conversion: { actualAmount: '' } })
                  }
                  aria-pressed={item.conversion?.actualAmount !== undefined}
                >
                  {t('fx_actual')}
                </Button>
              </div>
              {item.conversion?.rate !== undefined ? (
                <label className="block space-y-2">
                  <span>
                    {t('fx_rate')} · 1 {item.currency} = ?{' '}
                    {settings.primaryCurrency}
                  </span>
                  <input
                    inputMode="decimal"
                    value={item.conversion.rate}
                    onChange={(event) =>
                      update(index, {
                        conversion: { rate: event.target.value },
                      })
                    }
                    className="moni-field w-full"
                  />
                </label>
              ) : item.conversion?.actualAmount !== undefined ? (
                <label className="block space-y-2">
                  <span>
                    {t('fx_settlement')} · {settings.primaryCurrency}
                  </span>
                  <input
                    inputMode="decimal"
                    value={item.conversion.actualAmount}
                    onChange={(event) =>
                      update(index, {
                        conversion: { actualAmount: event.target.value },
                      })
                    }
                    className="moni-field w-full"
                  />
                </label>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      item.conversion?.quoteId
                        ? 'draft_quote_kept'
                        : 'draft_missing_conversion'
                    )}
                  </p>
                  <Button
                    type="button"
                    variant="plain"
                    onClick={async () => {
                      setQuoting(item.id);
                      setQuoteFailed(null);
                      try {
                        const quote = await privateApi<ReferenceQuote>(
                          'rates/preview',
                          {
                            datasetId: draft.datasetId,
                            operationId: crypto.randomUUID(),
                            currency: item.currency,
                            date: item.date,
                          }
                        );
                        update(index, { conversion: { quoteId: quote.id } });
                      } catch {
                        setQuoteFailed(item.id);
                      } finally {
                        setQuoting(null);
                      }
                    }}
                  >
                    {t(quoting === item.id ? 'fx_loading' : 'fx_refresh')}
                  </Button>
                </>
              )}
              {quoteFailed === item.id && (
                <p role="alert">{t('fx_unavailable')}</p>
              )}
            </div>
          )}
        </fieldset>
      ))}
      {failed && <p role="alert">{t('draft_edit_error')}</p>}
      <div className="grid grid-cols-2 gap-3">
        <Button
          type="button"
          variant="plain"
          disabled={busy || Boolean(quoting)}
          onClick={onCancel}
        >
          {t('entry_cancel')}
        </Button>
        <Button type="submit" disabled={busy || Boolean(quoting)}>
          {t(busy ? 'app_saving' : 'draft_save')}
        </Button>
      </div>
    </form>
  );
}
