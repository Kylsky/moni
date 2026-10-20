import { z } from 'zod';
import { HttpError } from '../lib/http';
import { limits } from '../lib/limits';
import { type Currency, currencyDecimals } from './currencies';
import { entryDate } from './dates';
import { amountMinor } from './money';

export const conversionInput = z
  .object({
    rate: z
      .string()
      .regex(/^\d{1,9}(?:\.\d{1,12})?$/)
      .optional(),
    actualAmount: z.string().min(1).max(20).optional(),
    quoteDate: entryDate.optional(),
    quoteId: z.uuid().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.rate !== undefined ||
      value.actualAmount !== undefined ||
      value.quoteId !== undefined
  );
export type ConversionInput = z.infer<typeof conversionInput>;
export type ConversionSnapshot = {
  method: 'manual_rate' | 'actual' | 'reference';
  source: 'manual' | 'actual' | 'ECB';
  baseCurrency: Currency;
  numerator: string;
  denominator: string;
  rate: string | null;
  quoteDate: string | null;
};

export function roundRatio(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n)
    throw new HttpError(400, 'invalid_conversion');
  return (numerator * 2n + denominator) / (2n * denominator);
}

export function prepareConversion(
  originalMinor: number,
  currency: Currency,
  baseCurrency: Currency,
  date: string,
  input: ConversionInput
) {
  const parsed = conversionInput.safeParse(input);
  if (
    !parsed.success ||
    !Number.isSafeInteger(originalMinor) ||
    originalMinor <= 0 ||
    originalMinor > limits.moneyMinor ||
    currency === baseCurrency
  )
    throw new HttpError(400, 'invalid_conversion');
  const originalScale = 10n ** BigInt(currencyDecimals[currency]);
  const baseScale = 10n ** BigInt(currencyDecimals[baseCurrency]);
  let numerator: bigint;
  let denominator: bigint;
  let baseMinor: bigint;
  if (parsed.data.actualAmount !== undefined) {
    baseMinor = BigInt(amountMinor(parsed.data.actualAmount, baseCurrency));
    numerator = baseMinor * originalScale;
    denominator = BigInt(originalMinor) * baseScale;
  } else {
    const rate = parsed.data.rate ?? '';
    const [whole, fraction = ''] = rate.split('.');
    numerator = BigInt(whole + fraction);
    denominator = 10n ** BigInt(fraction.length);
    if (numerator <= 0n) throw new HttpError(400, 'invalid_rate');
    if (parsed.data.quoteDate && parsed.data.quoteDate > date)
      throw new HttpError(400, 'future_quote');
    baseMinor = roundRatio(
      BigInt(originalMinor) * numerator * baseScale,
      denominator * originalScale
    );
  }
  if (baseMinor > BigInt(limits.moneyMinor))
    throw new HttpError(400, 'conversion_out_of_range');
  const actual = parsed.data.actualAmount !== undefined;
  const snapshot: ConversionSnapshot = {
    method: actual ? 'actual' : 'manual_rate',
    source: actual ? 'actual' : 'manual',
    baseCurrency,
    numerator: numerator.toString(),
    denominator: denominator.toString(),
    rate: actual ? null : (parsed.data.rate ?? null),
    quoteDate: actual ? null : (parsed.data.quoteDate ?? date),
  };
  return { baseMinor: Number(baseMinor), snapshot };
}
