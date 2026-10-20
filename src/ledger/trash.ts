import { z } from 'zod';
import { assertChanged, commandIdentity, executeCommand } from '../lib/command';
import { HttpError } from '../lib/http';

const transition = z
  .object({
    ...commandIdentity,
    id: z.uuid(),
    version: z.number().int().positive(),
    confirmed: z.literal(true),
  })
  .strict();
export type EntryTransition = 'delete' | 'restore' | 'purge';

export async function transitionEntry(
  db: D1Database,
  raw: unknown,
  action: EntryTransition
) {
  const parsed = transition.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_entry_transition');
  const input = parsed.data;
  const now = Date.now();
  const statement =
    action === 'purge'
      ? db
          .prepare(
            'DELETE FROM entries WHERE dataset_id = ? AND id = ? AND version = ? AND deleted_at IS NOT NULL'
          )
          .bind(input.datasetId, input.id, input.version)
      : db
          .prepare(`UPDATE entries SET deleted_at = ?, updated_at = ?, version = version + 1
      WHERE dataset_id = ? AND id = ? AND version = ? AND deleted_at IS ${action === 'delete' ? 'NULL' : 'NOT NULL'}`)
          .bind(
            action === 'delete' ? now : null,
            now,
            input.datasetId,
            input.id,
            input.version
          );
  return executeCommand(
    db,
    `${action}_entry`,
    input,
    [statement, assertChanged(db)],
    { entryId: input.id, action }
  );
}
