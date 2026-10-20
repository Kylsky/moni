import { z } from 'zod';
import { assertChanged, commandIdentity, executeCommand } from '../lib/command';
import { HttpError } from '../lib/http';

export type PostingPolicy = { mode: 'review' | 'automatic'; version: number };

export async function readPostingPolicy(
  db: D1Database
): Promise<PostingPolicy> {
  const row = await db
    .prepare(`SELECT CASE WHEN p.dataset_id=s.active_dataset THEN p.mode ELSE 'review' END AS mode,p.version
    FROM posting_policy p JOIN moni_state s ON s.singleton=p.singleton WHERE p.singleton=1`)
    .first<PostingPolicy>();
  if (!row) throw new HttpError(503, 'storage_not_ready');
  return row;
}

export async function savePostingPolicy(db: D1Database, raw: unknown) {
  const input = z
    .object({
      ...commandIdentity,
      mode: z.enum(['review', 'automatic']),
      version: z.number().int().nonnegative(),
      confirmed: z.literal(true),
    })
    .strict()
    .safeParse(raw);
  if (!input.success) throw new HttpError(400, 'invalid_posting_policy');
  const value = input.data;
  return executeCommand(
    db,
    'posting_policy',
    value,
    [
      db
        .prepare(
          'UPDATE posting_policy SET dataset_id=?,mode=?,version=version+1 WHERE singleton=1 AND version=?'
        )
        .bind(value.datasetId, value.mode, value.version),
      assertChanged(db),
    ],
    { saved: true }
  );
}

export function automaticPostingGuard(
  db: D1Database,
  datasetId: string,
  version: number
) {
  return db
    .prepare(`INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS (
    SELECT 1 FROM posting_policy WHERE singleton=1 AND dataset_id=? AND mode='automatic' AND version=?)`)
    .bind(datasetId, version);
}
