import { HttpError } from '../lib/http';
import { limits } from '../lib/limits';
import { type Currency, currencyDecimals } from './currencies';

export function amountMinor(value: string, currency: Currency): number {
  const decimals = currencyDecimals[currency];
  if (!/^\d{1,15}(?:\.\d{1,3})?$/.test(value))
    throw new HttpError(400, 'invalid_amount');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new HttpError(400, 'invalid_precision');
  const minor =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0') || '0');
  if (minor <= 0n || minor > BigInt(limits.moneyMinor))
    throw new HttpError(400, 'amount_out_of_range');
  return Number(minor);
}

export function decimalAmount(minor: number, currency: Currency): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError('Unsafe amount');
  const decimals = currencyDecimals[currency];
  const absolute = BigInt(minor < 0 ? -minor : minor)
    .toString()
    .padStart(decimals + 1, '0');
  const value = decimals
    ? `${absolute.slice(0, -decimals)}.${absolute.slice(-decimals)}`
    : absolute;
  return minor < 0 ? `-${value}` : value;
}

export function displayMoney(
  minor: number,
  currency: Currency,
  locale: string
) {
  const [whole, fraction] = decimalAmount(minor, currency).split('.');
  const integer = minor < 0 && BigInt(whole) === 0n ? -0 : BigInt(whole);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: currencyDecimals[currency],
    maximumFractionDigits: currencyDecimals[currency],
  })
    .formatToParts(integer)
    .map((part) =>
      part.type === 'fraction' ? (fraction ?? part.value) : part.value
    )
    .join('');
}
