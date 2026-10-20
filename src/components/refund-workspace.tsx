import { Input } from '@base-ui/react/input';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { todayInZone } from '@/ledger/dates';
import type { Entry } from '@/ledger/entries';
import { amountMinor, decimalAmount, displayMoney } from '@/ledger/money';
import { prepareRefund } from '@/ledger/refund-money';
import type { RefundPage } from '@/ledger/refunds';
import type { LedgerSettings } from '@/ledger/settings';
import { privateApi } from '@/lib/client-api';
import { type AppLocale, message } from '@/lib/locale';

export function RefundWorkspace({
  expenseId,
  refund,
  settings,
  locale,
  onSaved,
  onCancel,
}: {
  expenseId: string;
  refund?: Entry;
  settings: LedgerSettings;
  locale: AppLocale;
  onSaved: (id: string) => Promise<void>;
  onCancel?: () => unknown;
}) {
  const [data, setData] = useState<RefundPage | null>(null);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const Heading = refund ? 'h1' : 'h2';
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await privateApi<RefundPage>(
        `refunds?expenseId=${encodeURIComponent(expenseId)}&page=${page}`
      );
      if (result.datasetId !== settings.datasetId)
        throw new Error('dataset_changed');
      if (current === generation.current) {
        setData(result);
        setFailed(false);
      }
    } catch {
      if (current === generation.current) setFailed(true);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [expenseId, page, settings.datasetId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  return (
    <section
      className="mt-6 rounded-2xl border border-foreground/10 bg-surface p-4 md:p-6"
      aria-label={t(refund ? 'refund_edit' : 'refund_related')}
    >
      <Heading className="text-xl font-extrabold">
        {t(refund ? 'refund_edit' : 'refund_related')}
      </Heading>
      {failed && (
        <div role="alert" className="my-4">
          <p>{t('refund_load_error')}</p>
          <Button variant="plain" onClick={load} disabled={loading}>
            {t('app_retry')}
          </Button>
        </div>
      )}
      {loading && !data && <output>{t('probe_loading')}</output>}
      {data && (
        <>
          {refund && (
            <Link
              to="/"
              search={{ view: 'entries', entry: expenseId }}
              className="my-3 inline-flex min-h-11 items-center font-bold underline decoration-orange underline-offset-4"
            >
              {t('refund_original')} · {data.expense.name}
            </Link>
          )}
          {!refund && (
            <>
              {!data.total ? (
                <p className="my-4 rounded-xl border border-dashed border-muted p-4 text-muted-foreground">
                  {t('refund_empty')}
                </p>
              ) : (
                <ul className="my-4 divide-y divide-muted">
                  {data.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
                      <Link
                        to="/"
                        search={{ view: 'entries', entry: item.id }}
                        className="min-h-11 py-2 font-bold underline decoration-orange underline-offset-4"
                      >
                        {t('refund_view')} · {item.date}
                      </Link>
                      <span className="font-extrabold tabular-nums">
                        {displayMoney(
                          item.originalMinor,
                          item.currency,
                          locale
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {data.pageCount > 1 && (
                <div className="my-4 flex flex-wrap items-center gap-3">
                  <Button
                    variant="plain"
                    disabled={loading || page === 1}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    {t('query_previous')}
                  </Button>
                  <span>
                    {page} / {data.pageCount}
                  </span>
                  <Button
                    variant="plain"
                    disabled={loading || page >= data.pageCount}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    {t('query_next')}
                  </Button>
                </div>
              )}
              <p className="my-4 font-bold">
                {t('refund_refunded')} ·{' '}
                {displayMoney(
                  data.originalTotals?.refund ?? 0,
                  data.expense.currency,
                  locale
                )}
                {data.expense.currency !== settings.primaryCurrency && (
                  <span className="ml-3 text-sm text-muted-foreground">
                    {t('query_equivalent')}{' '}
                    {displayMoney(
                      data.totals.refund,
                      settings.primaryCurrency,
                      locale
                    )}
                  </span>
                )}
              </p>
            </>
          )}
          <RefundForm
            key={`${refund?.id ?? 'new'}:${data.expense.currency}`}
            data={data}
            refund={refund}
            settings={settings}
            locale={locale}
            onSaved={onSaved}
            onCancel={onCancel}
            onReload={load}
          />
        </>
      )}
    </section>
  );
}

function RefundForm({
  data,
  refund,
  settings,
  locale,
  onSaved,
  onCancel,
  onReload,
}: {
  data: RefundPage;
  refund?: Entry;
  settings: LedgerSettings;
  locale: AppLocale;
  onSaved: (id: string) => Promise<void>;
  onCancel?: () => unknown;
  onReload: () => Promise<void>;
}) {
  const [id] = useState(() => refund?.id ?? crypto.randomUUID());
  const [amount, setAmount] = useState(
    refund ? decimalAmount(refund.originalMinor, refund.currency) : ''
  );
  const [date, setDate] = useState(
    refund?.date ?? todayInZone(settings.timeZone)
  );
  const [note, setNote] = useState(refund?.note ?? '');
  const [actualAmount, setActualAmount] = useState(
    refund?.refundActual
      ? decimalAmount(refund.baseMinor, settings.primaryCurrency)
      : ''
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<
    'amount' | 'actual' | 'note' | 'save' | null
  >(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const actualRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const operation = useRef<{ value: string; id: string } | null>(null);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const available =
    data.expense.originalMinor -
    (data.originalTotals?.refund ?? 0) +
    (refund?.originalMinor ?? 0);
  let minor: number | null = null;
  try {
    minor = amountMinor(amount, data.expense.currency);
  } catch {
    minor = null;
  }
  const valid = minor !== null && minor <= available;
  const foreign = data.expense.currency !== settings.primaryCurrency;
  let preview: ReturnType<typeof prepareRefund> | null = null;
  try {
    preview = prepareRefund(
      data.expense,
      settings.primaryCurrency,
      (data.originalTotals?.refund ?? 0) - (refund?.originalMinor ?? 0),
      data.defaultRefundedMinor - (refund?.refundDefaultMinor ?? 0),
      amount,
      foreign && actualAmount !== '' ? actualAmount : undefined,
      refund
    );
  } catch {
    preview = null;
  }
  return (
    <form
      className="mt-5 rounded-xl border border-yellow/50 bg-yellow/10 p-4 md:p-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setError(null);
        if (!valid || minor === null) {
          setError('amount');
          amountRef.current?.focus();
          return;
        }
        if (!preview) {
          setError('actual');
          actualRef.current?.focus();
          return;
        }
        if (note.length > 2000) {
          setError('note');
          noteRef.current?.focus();
          return;
        }
        const payload = {
          datasetId: settings.datasetId,
          id,
          expenseId: data.expense.id,
          expenseVersion: data.expense.version,
          amount,
          date,
          note,
          confirmedBaseMinor: preview.baseMinor,
          ...(foreign && actualAmount !== '' ? { actualAmount } : {}),
          ...(refund ? { version: refund.version } : {}),
        };
        const value = JSON.stringify(payload);
        if (operation.current?.value !== value)
          operation.current = { value, id: crypto.randomUUID() };
        setBusy(true);
        try {
          const result = await privateApi<{ entryId: string }>(
            'refunds',
            { ...payload, operationId: operation.current.id },
            refund ? 'PUT' : 'POST'
          );
          await onSaved(result.entryId);
        } catch {
          setError('save');
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy} className="grid min-w-0 gap-4 md:grid-cols-3">
        <legend className="mb-4 text-xl font-extrabold">
          {t(refund ? 'refund_edit' : 'refund_register')}
        </legend>
        <label htmlFor="refund-amount" className="min-w-0 font-bold">
          {t('refund_amount')} ({data.expense.currency})
          <Input
            id="refund-amount"
            className="moni-field mt-2"
            ref={amountRef}
            inputMode="decimal"
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-invalid={error === 'amount'}
            aria-describedby="refund-available refund-error"
          />
        </label>
        <label htmlFor="refund-date" className="font-bold">
          {t('refund_date')}
          <Input
            id="refund-date"
            className="moni-field mt-2"
            type="date"
            required
            min="1900-01-01"
            max="9999-12-31"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        {foreign && (
          <label htmlFor="refund-actual" className="font-bold md:col-span-2">
            {t('refund_actual')} ({settings.primaryCurrency})
            <Input
              id="refund-actual"
              ref={actualRef}
              inputMode="decimal"
              value={actualAmount}
              onChange={(event) => setActualAmount(event.target.value)}
              className="moni-field mt-2"
              aria-invalid={error === 'actual'}
            />
          </label>
        )}
        <div className="font-bold md:col-span-2">
          <label htmlFor="refund-note">{t('entry_note')}</label>
          <Input
            render={<textarea rows={3} />}
            id="refund-note"
            className="moni-field mt-2 min-h-24 resize-y"
            ref={noteRef}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            aria-invalid={error === 'note'}
            aria-describedby="refund-note-hint"
          />
          <span
            id="refund-note-hint"
            className="mt-2 block text-sm font-normal text-muted-foreground"
          >
            {t('entry_note_hint')} {note.length}/2000
          </span>
        </div>
        <output
          className={`rounded-xl bg-surface p-4 md:col-start-3 md:row-start-1 md:flex md:flex-col md:justify-center ${foreign ? 'md:row-span-3' : 'md:row-span-2'}`}
          aria-live="polite"
        >
          {foreign && (
            <p className="mb-3 break-words text-sm">
              {t('refund_original_basis')}
              <span className="mt-1 block">
                {data.expense.conversion?.rate
                  ? `1 ${data.expense.currency} ≈ ${data.expense.conversion.rate} ${settings.primaryCurrency}`
                  : `${displayMoney(data.expense.originalMinor, data.expense.currency, locale)} → ${displayMoney(data.expense.baseMinor, settings.primaryCurrency, locale)}`}
              </span>
            </p>
          )}
          <span className="block text-sm">{t('refund_preview')}</span>
          <strong className="mt-1 block text-2xl tabular-nums">
            {preview
              ? displayMoney(
                  preview.baseMinor,
                  settings.primaryCurrency,
                  locale
                )
              : '—'}
          </strong>
          {preview?.actual && (
            <span className="mt-2 text-sm">{t('fx_actual_source')}</span>
          )}
          {preview?.tailAdjusted && !preview.actual && (
            <span className="mt-2 text-sm">{t('refund_tail')}</span>
          )}
        </output>
        <p className="text-sm text-muted-foreground md:col-span-3">
          {t('refund_inherit')}
        </p>
        <p
          id="refund-available"
          className="rounded-xl bg-green/20 p-3 font-bold md:col-span-3"
        >
          {t('refund_available')}{' '}
          {displayMoney(available, data.expense.currency, locale)} ·{' '}
          {t('refund_remaining')}{' '}
          {displayMoney(
            valid && minor !== null ? available - minor : available,
            data.expense.currency,
            locale
          )}
        </p>
        {error && (
          <div className="md:col-span-3">
            <p role="alert" id="refund-error" className="font-bold">
              {t(
                error === 'amount'
                  ? 'refund_amount_error'
                  : error === 'actual'
                    ? 'refund_actual_error'
                    : error === 'note'
                      ? 'entry_fields_error'
                      : 'refund_save_error'
              )}
            </p>
            {error === 'save' && (
              <Button variant="plain" className="mt-3" onClick={onReload}>
                {t('refund_reload')}
              </Button>
            )}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 md:col-span-3 md:ml-auto md:w-2/3">
          <Button
            variant="plain"
            className="px-3!"
            onClick={() => {
              if (onCancel) onCancel();
              else {
                setAmount('');
                setNote('');
                setActualAmount('');
                setDate(todayInZone(settings.timeZone));
                setError(null);
              }
            }}
          >
            {t('entry_cancel')}
          </Button>
          <Button type="submit" className="px-3!">
            {t(busy ? 'app_saving' : 'refund_confirm')}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
