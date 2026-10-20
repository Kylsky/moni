import { expect, it } from 'vitest';
import {
  type DraftReview,
  planDraftReview,
} from '../../src/ledger/draft-review';
import type { Draft } from '../../src/ledger/drafts';
import type { ConfirmationIntent } from '../../src/lib/conversation-intent';

const make = (id: string, status: Draft['status'], version = 1): Draft => ({
  datasetId: 'synthetic',
  threadId: 'synthetic',
  id,
  version,
  status,
  baseCurrency: 'CNY',
  items: [
    {
      id: `item-${id}`,
      kind: 'expense',
      name: 'Synthetic lunch',
      amount: status === 'needs_details' ? null : '35',
      date: '2026-10-19',
      currency: 'CNY',
      categoryId: 'expense-food',
      tags: [],
      note: 'Synthetic note',
      conversion: null,
      originalMinor: status === 'needs_details' ? null : 3500,
      baseMinor: status === 'needs_details' ? null : 3500,
      snapshot: null,
      missing: status === 'needs_details' ? ['amount'] : [],
    },
  ],
  totalBaseMinor: status === 'needs_details' ? null : 3500,
  createdAt: 1,
  updatedAt: 1,
});
const review: DraftReview = {
  draftId: 'a',
  version: 1,
  drafts: [
    { id: 'a', version: 1 },
    { id: 'b', version: 1 },
  ],
  operationId: 'synthetic',
};

it('checks 448 draft-state and approval combinations without allowing stale, incomplete or closed posting', () => {
  const statuses: Draft['status'][] = [
    'ready',
    'needs_details',
    'posted',
    'cancelled',
  ];
  const intents: ConfirmationIntent[] = [
    'confirm',
    'confirm_all',
    'review_pending',
    'decline',
    'revise',
    'other',
    'unclear',
  ];
  let checked = 0;
  for (const first of statuses)
    for (const second of statuses)
      for (const reviewed of [false, true])
        for (const stale of [false, true])
          for (const intent of intents) {
            const drafts = [make('a', first, stale ? 2 : 1), make('b', second)];
            const plan = planDraftReview(intent, reviewed, review, drafts);
            const allowed =
              reviewed &&
              !stale &&
              first === 'ready' &&
              second === 'ready' &&
              (intent === 'confirm' || intent === 'confirm_all');
            expect(
              plan.action === 'confirm',
              JSON.stringify({
                first,
                second,
                reviewed,
                stale,
                intent,
              })
            ).toBe(allowed);
            if (plan.action === 'preview')
              expect(
                plan.drafts.every((draft) =>
                  ['ready', 'needs_details'].includes(draft.status)
                )
              ).toBe(true);
            checked++;
          }
  expect(checked).toBe(448);
});
it('re-reviews every newly ready excluded draft and every new pending draft before confirming all', () => {
  const selected = {
    ...review,
    drafts: [{ id: 'a', version: 1 }],
    excludedDraftIds: ['b'],
  };
  const ready = make('a', 'ready');
  expect(
    planDraftReview('confirm_all', true, selected, [
      ready,
      make('b', 'needs_details'),
    ]).action
  ).toBe('confirm');
  for (const changed of [
    make('b', 'ready'),
    make('c', 'ready'),
    make('c', 'needs_details'),
  ]) {
    const plan = planDraftReview('confirm_all', true, selected, [
      ready,
      changed,
    ]);
    expect(plan.action).toBe('preview');
    if (plan.action === 'preview')
      expect(plan.drafts.map((draft) => draft.id)).toContain(changed.id);
  }
});
