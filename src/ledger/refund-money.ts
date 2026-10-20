import { HttpError } from '../lib/http';
import { prepareConversion, roundRatio } from './conversion';
import { type Currency, currencyDecimals } from './currencies';
import type { Entry } from './entries';
import { amountMinor } from './money';

export function prepareRefund(
  expense: Entry,
  baseCurrency: Currency,
  refundedOriginal: number,
  refundedDefault: number,
  amount: string,
  actualAmount?: string,
  current?: Entry
) {
  const minor = amountMinor(amount, expense.currency);
  const available = expense.originalMinor - refundedOriginal;
  const budget = expense.baseMinor - refundedDefault;
  const actual = actualAmount !== undefined;
  if (
    minor > available ||
    budget < 0 ||
    (actual && expense.currency === baseCurrency)
  )
    throw new HttpError(409, 'refund_balance_changed');
  const actualMinor = actual
    ? amountMinor(actualAmount, baseCurrency)
    : undefined;
  if (
    current &&
    current.currency === expense.currency &&
    current.originalMinor === minor &&
    current.refundActual === actual &&
    (!actual || actualMinor === current.baseMinor)
  )
    return {
      originalMinor: minor,
      baseMinor: current.baseMinor,
      defaultMinor: current.refundDefaultMinor ?? current.baseMinor,
      snapshot: current.conversion,
      actual,
      tailAdjusted: false,
    };
  const snapshot = expense.conversion;
  if (expense.currency !== baseCurrency && !snapshot)
    throw new HttpError(409, 'conversion_required');
  const ordinary = snapshot
    ? Number(
        roundRatio(
          BigInt(minor) *
            BigInt(snapshot.numerator) *
            10n ** BigInt(currencyDecimals[baseCurrency]),
          BigInt(snapshot.denominator) *
            10n ** BigInt(currencyDecimals[expense.currency])
        )
      )
    : minor;
  if (!Number.isSafeInteger(ordinary))
    throw new HttpError(400, 'conversion_out_of_range');
  // Allocate the final tail from the remaining budget, including after deletions.
  const defaultMinor =
    minor === available ? budget : Math.min(ordinary, budget);
  const converted = actual
    ? prepareConversion(minor, expense.currency, baseCurrency, expense.date, {
        actualAmount,
      })
    : null;
  return {
    originalMinor: minor,
    baseMinor: actualMinor ?? defaultMinor,
    defaultMinor,
    snapshot: converted?.snapshot ?? snapshot,
    actual,
    tailAdjusted: defaultMinor !== ordinary,
  };
}
