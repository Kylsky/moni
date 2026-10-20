import { HttpError } from '../lib/http';
import { limits } from '../lib/limits';
import type { ConversionSnapshot } from './conversion';
import { roundRatio } from './conversion';
import type { Currency } from './currencies';
import { currencyDecimals } from './currencies';

export type ReferenceQuote = {
  id: string;
  currency: Currency;
  baseCurrency: Currency;
  date: string;
  snapshot: ConversionSnapshot;
};

export function applyReference(
  originalMinor: number,
  currency: Currency,
  baseCurrency: Currency,
  date: string,
  quote: ReferenceQuote
) {
  if (
    quote.currency !== currency ||
    quote.baseCurrency !== baseCurrency ||
    quote.date !== date ||
    !Number.isSafeInteger(originalMinor) ||
    originalMinor <= 0 ||
    originalMinor > limits.moneyMinor
  )
    throw new HttpError(400, 'quote_mismatch');
  const baseMinor = roundRatio(
    BigInt(originalMinor) *
      BigInt(quote.snapshot.numerator) *
      10n ** BigInt(currencyDecimals[baseCurrency]),
    BigInt(quote.snapshot.denominator) *
      10n ** BigInt(currencyDecimals[currency])
  );
  if (baseMinor > BigInt(limits.moneyMinor))
    throw new HttpError(400, 'conversion_out_of_range');
  return { baseMinor: Number(baseMinor), snapshot: quote.snapshot };
}
