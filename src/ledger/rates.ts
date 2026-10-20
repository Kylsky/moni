import { z } from 'zod';
import {
  assertChatExecution,
  type ChatPermit,
  chatExecutionGuard,
} from '../lib/chat-persistence';
import { commandIdentity, executeCommand } from '../lib/command';
import { HttpError } from '../lib/http';
import type { ConversionSnapshot } from './conversion';
import { roundRatio } from './conversion';
import { type Currency, currencies } from './currencies';
import { entryDate, todayInZone } from './dates';
import type { ReferenceQuote } from './reference-conversion';
import { readSettings } from './settings';

const quoteInput = z
  .object({
    ...commandIdentity,
    currency: z.enum(currencies),
    date: entryDate,
  })
  .strict();
const rateRow = z.object({
  base: z.literal('EUR'),
  quote: z.enum(currencies),
  date: entryDate,
  rate: z.number().positive().finite(),
});

function decimalRatio(value: number) {
  const text = String(value);
  if (!/^\d{1,9}(?:\.\d{1,12})?$/.test(text))
    throw new HttpError(502, 'invalid_quote');
  const [whole, fraction = ''] = text.split('.');
  return {
    numerator: BigInt(whole + fraction),
    denominator: 10n ** BigInt(fraction.length),
  };
}

async function fetchQuote(
  currency: Currency,
  baseCurrency: Currency,
  date: string
) {
  const quotes = [...new Set([currency, baseCurrency])].filter(
    (code) => code !== 'EUR'
  );
  const url = new URL('https://api.frankfurter.dev/v2/providers/ecb/rates');
  url.search = new URLSearchParams({
    base: 'EUR',
    quotes: quotes.join(','),
    date,
  }).toString();
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
    });
    if (!response.ok) throw new HttpError(502, 'quote_unavailable');
    const reader = response.body?.getReader();
    if (!reader) throw new HttpError(502, 'invalid_quote');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 32768) throw new HttpError(502, 'invalid_quote');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    const rows = z
      .array(rateRow)
      .max(2)
      .parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
      );
    if (!rows.length) throw new HttpError(424, 'quote_missing');
    if (
      rows.length !== quotes.length ||
      quotes.some(
        (code) => rows.filter((row) => row.quote === code).length !== 1
      )
    )
      throw new HttpError(424, 'quote_missing');
    const quoteDate = rows[0].date;
    if (rows.some((row) => row.date !== quoteDate) || quoteDate > date)
      throw new HttpError(502, 'invalid_quote');
    if (
      Date.parse(`${date}T00:00:00Z`) - Date.parse(`${quoteDate}T00:00:00Z`) >
      14 * 86400000
    )
      throw new HttpError(424, 'quote_missing');
    const leg = (code: Currency) =>
      code === 'EUR'
        ? { numerator: 1n, denominator: 1n }
        : decimalRatio(rows.find((row) => row.quote === code)?.rate ?? 0);
    const original = leg(currency);
    const base = leg(baseCurrency);
    const numerator = base.numerator * original.denominator;
    const denominator = base.denominator * original.numerator;
    const display = roundRatio(numerator * 10n ** 12n, denominator)
      .toString()
      .padStart(13, '0');
    const rate = `${display.slice(0, -12)}.${display.slice(-12)}`.replace(
      /\.?0+$/,
      ''
    );
    const snapshot: ConversionSnapshot = {
      method: 'reference',
      source: 'ECB',
      baseCurrency,
      numerator: numerator.toString(),
      denominator: denominator.toString(),
      rate,
      quoteDate,
    };
    return snapshot;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'quote_unavailable');
  }
}

export async function readQuote(
  db: D1Database,
  datasetId: string,
  id: string
): Promise<ReferenceQuote> {
  const row = await db
    .prepare(`SELECT q.id, q.currency, q.base_currency, q.entry_date, q.snapshot_json FROM fx_quotes q
    JOIN moni_state s ON s.active_dataset = q.dataset_id AND s.singleton = 1 WHERE q.dataset_id = ? AND q.id = ?`)
    .bind(datasetId, id)
    .first<{
      id: string;
      currency: Currency;
      base_currency: Currency;
      entry_date: string;
      snapshot_json: string;
    }>();
  if (!row) throw new HttpError(409, 'quote_expired');
  return {
    id: row.id,
    currency: row.currency,
    baseCurrency: row.base_currency,
    date: row.entry_date,
    snapshot: JSON.parse(row.snapshot_json),
  };
}

export async function previewQuote(
  db: D1Database,
  raw: unknown,
  execution?: { permit: ChatPermit; signal: AbortSignal }
) {
  const parsed = quoteInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_quote_request');
  const input = parsed.data;
  const id = crypto.randomUUID();
  const receipt = await executeCommand(
    db,
    'preview_quote',
    input,
    async () => {
      const settings = await readSettings(db);
      if (execution)
        await assertChatExecution(
          db,
          input.datasetId,
          execution.permit,
          execution.signal
        );
      if (!settings.initialized)
        throw new HttpError(409, 'initialization_required');
      if (
        input.currency === settings.primaryCurrency ||
        input.date > todayInZone(settings.timeZone)
      )
        throw new HttpError(400, 'invalid_quote_request');
      const snapshot = await fetchQuote(
        input.currency,
        settings.primaryCurrency,
        input.date
      );
      return [
        ...(execution
          ? [chatExecutionGuard(db, input.datasetId, execution.permit)]
          : []),
        db
          .prepare(
            'INSERT INTO fx_quotes(dataset_id, id, currency, base_currency, entry_date, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .bind(
            input.datasetId,
            id,
            input.currency,
            settings.primaryCurrency,
            input.date,
            JSON.stringify(snapshot)
          ),
      ];
    },
    { quoteId: id }
  );
  return readQuote(db, input.datasetId, receipt.quoteId);
}
