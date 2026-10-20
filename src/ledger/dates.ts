import { z } from 'zod';

export const entryDate = z.iso
  .date()
  .refine((value) => value >= '1900-01-01' && value <= '9999-12-31');

export function todayInZone(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join('-');
}

export const datePeriod = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('month'),
      month: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
        .refine((value) => value >= '1900-01' && value <= '9999-12'),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['rolling_months', 'complete_months']),
      months: z.number().int().min(1).max(120),
    })
    .strict(),
]);

function monthParts(month: string, offset = 0) {
  const [year, number] = month.split('-').map(Number);
  const index = year * 12 + number - 1 + offset;
  return {
    year: Math.floor(index / 12),
    month: (((index % 12) + 12) % 12) + 1,
  };
}

function daysInMonth(year: number, month: number) {
  return [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
}

export function shiftMonth(month: string, offset: number): string {
  const value = monthParts(month, offset);
  return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}`;
}

export function monthEnd(month: string): string {
  const parts = monthParts(month);
  return `${month}-${daysInMonth(parts.year, parts.month)}`;
}

export function resolveDatePeriod(
  period: z.infer<typeof datePeriod>,
  timeZone: string,
  now = new Date()
) {
  const today = todayInZone(timeZone, now);
  const month = today.slice(0, 7);
  if (period.kind === 'month')
    return {
      from: `${period.month}-01`,
      to: period.month === month ? today : monthEnd(period.month),
    };
  const start = shiftMonth(month, -period.months);
  if (period.kind === 'complete_months')
    return { from: `${start}-01`, to: monthEnd(shiftMonth(month, -1)) };
  const parts = monthParts(start);
  return {
    from: `${start}-${String(Math.min(Number(today.slice(8)), daysInMonth(parts.year, parts.month))).padStart(2, '0')}`,
    to: today,
  };
}

export function trendEnd(from: string, interval: 'day' | 'week' | 'month') {
  if (interval === 'day') return from;
  if (interval === 'month') return monthEnd(from.slice(0, 7));
  const date = new Date(`${from}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + (7 - (date.getUTCDay() || 7)));
  if (date.getUTCFullYear() > 9999) return '9999-12-31';
  return date.toISOString().slice(0, 10);
}
