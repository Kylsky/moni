import type { Draft } from './drafts';

export const pendingDrafts = (drafts: Draft[]) =>
  drafts.filter((draft) => ['ready', 'needs_details'].includes(draft.status));

export function draftReviewSummary(drafts: Draft[]) {
  const pending = pendingDrafts(drafts);
  const ready = pending.filter(
    (draft) => draft.status === 'ready' && draft.totalBaseMinor !== null
  );
  const seen = new Set<string>();
  let duplicate = false;
  for (const item of ready.flatMap((draft) => draft.items)) {
    const key = JSON.stringify([
      item.kind,
      item.date,
      item.currency,
      item.originalMinor,
    ]);
    if (seen.has(key)) duplicate = true;
    seen.add(key);
  }
  return {
    pending,
    ready,
    duplicate,
    itemCount: pending.reduce((count, draft) => count + draft.items.length, 0),
  };
}
