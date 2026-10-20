import type { ModelMessage } from '@tanstack/ai';
import { z } from 'zod';
import { parseQueryResult, parseQueryUpdates } from './chat-query-contract';
import { type Currency, currencies } from './currencies';
import type { EntryTotals } from './entry-query';
import { decimalAmount } from './money';

const amount = (minor: number, currency: Currency) =>
  `${currency} ${decimalAmount(minor, currency)}`;

function queryMoney(value: unknown): unknown {
  const result = parseQueryResult(value);
  if (!result) return value;
  const { report } = result;
  const totals = (values: EntryTotals, currency: Currency) =>
    Object.fromEntries(
      Object.entries(values).map(([key, minor]) => [
        key,
        amount(minor, currency),
      ])
    );
  const aggregate = (row: {
    totals: EntryTotals;
    originalTotals: EntryTotals | null;
  }) => ({
    ...row,
    totals: totals(row.totals, report.primaryCurrency),
    originalTotals:
      row.originalTotals && report.filters.currency
        ? totals(row.originalTotals, report.filters.currency)
        : null,
  });
  return {
    ...result,
    ...(result.entries
      ? {
          entries: {
            ...result.entries,
            items: result.entries.items.map(
              ({ originalMinor, baseMinor, ...entry }) => ({
                ...entry,
                originalAmount: amount(originalMinor, entry.currency),
                baseAmount: amount(baseMinor, report.primaryCurrency),
              })
            ),
          },
        }
      : {}),
    report: {
      ...aggregate(report),
      groups: report.groups.map(({ filters: _filters, ...row }) =>
        aggregate(row)
      ),
      trend: report.trend.map(({ filters: _filters, ...row }) =>
        aggregate(row)
      ),
    },
  };
}

// Only provider input changes; persisted tool results keep exact integer minor units.
export function modelMoney(message: ModelMessage): ModelMessage {
  if (message.role !== 'tool' || typeof message.content !== 'string')
    return message;
  try {
    const value = JSON.parse(message.content);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return message;
    let presented = queryMoney(value) as Record<string, unknown>;
    if (Array.isArray(value.queryUpdates))
      presented = {
        ...presented,
        queryUpdates: parseQueryUpdates(value).map((update) => ({
          id: update.id,
          result: update.result ? queryMoney(update.result) : null,
        })),
      };
    else if (value.queryResult)
      presented = { ...presented, queryResult: queryMoney(value.queryResult) };
    const currency = z.enum(currencies).safeParse(value.baseCurrency);
    if (currency.success && Number.isSafeInteger(value.totalBaseMinor)) {
      const { totalBaseMinor: _minor, ...rest } = presented;
      presented = {
        ...rest,
        totalBaseAmount: amount(value.totalBaseMinor, currency.data),
      };
    }
    return presented === value
      ? message
      : { ...message, content: JSON.stringify(presented) };
  } catch {
    return message;
  }
}
