import { expect, it } from 'vitest';
import { draftReviewSummary } from '../../src/ledger/draft-review-summary';
import type { Draft, DraftItem } from '../../src/ledger/drafts';

const meal = {
  kind: 'expense',
  date: '2026-10-19',
  currency: 'CNY',
  originalMinor: 3500,
};
function draft(items = [meal], status: Draft['status'] = 'ready'): Draft {
  return {
    status,
    totalBaseMinor: status === 'needs_details' ? null : 3500,
    items: items as DraftItem[],
  } as Draft;
}
it('warns for equal financial values across different drafts without merging their entries', () => {
  const drafts = [draft(), draft()];
  const summary = draftReviewSummary(drafts);
  expect(summary.duplicate).toBe(true);
  expect(summary.pending).toHaveLength(2);
  expect(summary.itemCount).toBe(2);
  expect(drafts[0].items).toHaveLength(1);
  expect(drafts[1].items).toHaveLength(1);
});
it.each([
  { kind: 'income' },
  { date: '2026-10-18' },
  { currency: 'USD' },
  { originalMinor: 3501 },
])('does not warn when the financial identity differs: %o', (patch) => {
  expect(
    draftReviewSummary([draft(), draft([{ ...meal, ...patch }])]).duplicate
  ).toBe(false);
});
it('counts only pending items and excludes incomplete and posted entries from duplicate comparisons', () => {
  const summary = draftReviewSummary([
    draft(),
    draft([meal, meal], 'needs_details'),
    draft([meal], 'posted'),
    draft([meal], 'cancelled'),
  ]);
  expect(summary.pending).toHaveLength(2);
  expect(summary.itemCount).toBe(3);
  expect(summary.ready).toHaveLength(1);
  expect(summary.duplicate).toBe(false);
});
