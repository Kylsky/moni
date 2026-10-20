import { z } from 'zod';
import type {
  ConfirmationContext,
  ConfirmationIntent,
} from '../lib/conversation-intent';
import { pendingDrafts } from './draft-review-summary';
import { confirmDraft, confirmDraftBatch, type Draft } from './drafts';

export { pendingDrafts } from './draft-review-summary';

export const visibleDraftReview = z
  .object({
    operationId: z.uuid(),
    drafts: z
      .array(
        z
          .object({ id: z.uuid(), version: z.number().int().positive() })
          .strict()
      )
      .min(1)
      .max(20),
    excludedDraftIds: z.array(z.uuid()).max(100).optional(),
  })
  .strict()
  .refine(
    (review) =>
      new Set(review.drafts.map(({ id }) => id)).size === review.drafts.length
  );
export type VisibleDraftReview = z.infer<typeof visibleDraftReview>;
export type DraftReview = {
  draftId: string;
  version: number;
  drafts?: { id: string; version: number }[];
  excludedDraftIds?: string[];
  operationId: string;
};
export const reviewTargets = (review: DraftReview | null) =>
  review?.drafts ??
  (review ? [{ id: review.draftId, version: review.version }] : []);
export function selectedDrafts(review: DraftReview | null, drafts: Draft[]) {
  const pending = pendingDrafts(drafts);
  return review
    ? reviewTargets(review).flatMap(({ id }) =>
        drafts.filter((draft) => draft.id === id)
      )
    : pending.length === 1
      ? pending
      : [];
}
export function reviewContext(
  reviewed: boolean,
  review: DraftReview | null,
  drafts: Draft[]
): ConfirmationContext {
  const selected = selectedDrafts(review, drafts);
  return {
    reviewed,
    reviewedDrafts: selected.length,
    otherPendingDrafts: pendingDrafts(drafts).filter(
      (draft) => !selected.some(({ id }) => draft.id === id)
    ).length,
    items: selected
      .flatMap((draft) =>
        draft.items.map(({ name, amount, currency, date }) => ({
          name,
          amount,
          currency,
          date,
        }))
      )
      .slice(0, 20),
  };
}
type ReviewPlan =
  | {
      action:
        | 'continue'
        | 'decline'
        | 'unavailable'
        | 'posted_change'
        | 'already_posted'
        | 'clarify'
        | 'choose'
        | 'incomplete'
        | 'confirm';
    }
  | { action: 'preview'; drafts: Draft[]; batch: boolean; changed: boolean };

export function planDraftReview(
  intent: ConfirmationIntent | null,
  reviewed: boolean,
  review: DraftReview | null,
  drafts: Draft[]
): ReviewPlan {
  const targets = reviewTargets(review);
  const selected = selectedDrafts(review, drafts);
  const pending = pendingDrafts(drafts);
  const posted =
    selected.length > 0 && selected.every((draft) => draft.status === 'posted');
  const preview = (
    items: Draft[],
    batch: boolean,
    changed = false
  ): ReviewPlan => ({
    action: 'preview',
    drafts: pendingDrafts(items),
    batch,
    changed,
  });
  if (!intent) return { action: 'unavailable' };
  if (
    !review &&
    !pending.length &&
    ['confirm', 'confirm_all', 'review_pending', 'decline', 'unclear'].includes(
      intent
    )
  )
    return preview([], true);
  if (!review && !pending.length && intent === 'revise')
    return {
      action: drafts.some((draft) => draft.status === 'posted')
        ? 'posted_change'
        : 'choose',
    };
  if (
    selected.some((draft) => draft.status === 'posted') &&
    (intent === 'decline' || intent === 'revise')
  )
    return { action: 'posted_change' };
  if (
    intent === 'review_pending' ||
    (intent === 'confirm_all' &&
      (!reviewed ||
        pending.some(
          (draft) =>
            !targets.some(({ id }) => id === draft.id) &&
            !(
              draft.status === 'needs_details' &&
              review?.excludedDraftIds?.includes(draft.id)
            )
        )))
  )
    return preview(pending, true);
  if (intent === 'other' || intent === 'revise') return { action: 'continue' };
  if (intent === 'decline') return { action: 'decline' };
  if (intent === 'unclear')
    return !reviewed && selected[0] && pendingDrafts([selected[0]]).length
      ? preview(selected, Boolean(review?.drafts))
      : { action: 'clarify' };
  if (reviewed && posted) return { action: 'already_posted' };
  if (
    !selected[0] ||
    (review && selected.length !== targets.length) ||
    selected.some((draft) => draft.status === 'cancelled')
  )
    return review?.drafts
      ? preview(selected, true, true)
      : { action: 'choose' };
  if (
    !reviewed ||
    !review ||
    selected.some(
      (draft) =>
        draft.version !== targets.find(({ id }) => id === draft.id)?.version
    )
  )
    return preview(selected, Boolean(review?.drafts), true);
  if (
    selected.some(
      (draft) => draft.status !== 'ready' || draft.totalBaseMinor === null
    )
  )
    return { action: 'incomplete' };
  return { action: 'confirm' };
}

export async function confirmDraftReview(
  db: D1Database,
  datasetId: string,
  threadId: string,
  review: DraftReview,
  all: boolean,
  guards: D1PreparedStatement[]
) {
  const targets = reviewTargets(review);
  if (all)
    guards = [
      db
        .prepare(`INSERT INTO invariant_assertions(valid) SELECT 0 WHERE EXISTS (
    SELECT 1 FROM drafts WHERE dataset_id=? AND thread_id=? AND status IN ('ready','needs_details')
    AND id NOT IN (SELECT json_extract(value,'$.id') FROM json_each(?))
    AND NOT (status='needs_details' AND id IN (SELECT value FROM json_each(?))))`)
        .bind(
          datasetId,
          threadId,
          JSON.stringify(targets),
          JSON.stringify(review.excludedDraftIds ?? [])
        ),
      ...guards,
    ];
  return review.drafts
    ? confirmDraftBatch(
        db,
        {
          datasetId,
          operationId: review.operationId,
          threadId,
          drafts: targets,
          confirmed: true,
        },
        guards
      )
    : confirmDraft(
        db,
        {
          datasetId,
          operationId: review.operationId,
          id: review.draftId,
          version: review.version,
          confirmed: true,
        },
        guards
      );
}
