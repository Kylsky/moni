import { expect, it } from 'vitest';
import { displayMoney } from '../../src/ledger/money';

it('formats safe integer aggregates without losing minor units or the sign of a negative fractional total', () => {
  expect(displayMoney(Number.MAX_SAFE_INTEGER, 'CNY', 'en')).toBe(
    'CN¥90,071,992,547,409.91'
  );
  expect(displayMoney(-1, 'CNY', 'en')).toBe('-CN¥0.01');
  expect(displayMoney(1, 'KWD', 'en')).toBe('KWD\u00a00.001');
  expect(displayMoney(9000000000000, 'JPY', 'en')).toBe('¥9,000,000,000,000');
});
