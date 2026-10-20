import { z } from 'zod';
import { HttpError } from './http';

export const commandIdentity = {
  datasetId: z.string().min(1).max(100),
  operationId: z.uuid(),
};

export async function executeCommand<T>(
  db: D1Database,
  kind: string,
  input: { datasetId: string; operationId: string },
  statements: D1PreparedStatement[] | (() => Promise<D1PreparedStatement[]>),
  result: T,
  restoreToken?: string
): Promise<T> {
  const state = await db
    .prepare(
      'SELECT active_dataset,restore_token,restore_expires_at FROM moni_state WHERE singleton = 1'
    )
    .first<{
      active_dataset: string;
      restore_token: string | null;
      restore_expires_at: number | null;
    }>();
  if (state?.active_dataset !== input.datasetId)
    throw new HttpError(409, 'dataset_changed');
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify({ kind, input }))
      )
    ),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
  const receipt = await db
    .prepare(
      'SELECT input_hash, result_json FROM operation_receipts WHERE dataset_id = ? AND operation_id = ?'
    )
    .bind(input.datasetId, input.operationId)
    .first<{ input_hash: string; result_json: string }>();
  if (receipt) {
    if (receipt.input_hash !== hash)
      throw new HttpError(409, 'operation_conflict');
    return JSON.parse(receipt.result_json) as T;
  }
  if (
    state.restore_expires_at &&
    state.restore_expires_at > Date.now() &&
    state.restore_token !== restoreToken
  )
    throw new HttpError(423, 'restore_locked');
  const commands =
    typeof statements === 'function' ? await statements() : statements;
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS (
        SELECT 1 FROM moni_state WHERE singleton = 1 AND active_dataset = ?
          AND (restore_expires_at IS NULL OR restore_expires_at<=unixepoch('subsec')*1000 OR restore_token=?)
      )`)
        .bind(input.datasetId, restoreToken ?? null),
      ...commands,
      db
        .prepare(
          'INSERT INTO operation_receipts(dataset_id, operation_id, input_hash, result_json) VALUES (?, ?, ?, ?)'
        )
        .bind(input.datasetId, input.operationId, hash, JSON.stringify(result)),
      db.prepare(
        'UPDATE moni_state SET revision = revision + 1 WHERE singleton = 1'
      ),
    ]);
    return result;
  } catch {
    // A concurrent duplicate can win after the first receipt lookup.
    const winner = await db
      .prepare(
        'SELECT input_hash, result_json FROM operation_receipts WHERE dataset_id = ? AND operation_id = ?'
      )
      .bind(input.datasetId, input.operationId)
      .first<{ input_hash: string; result_json: string }>();
    if (winner?.input_hash === hash) return JSON.parse(winner.result_json) as T;
    const current = await db
      .prepare(
        'SELECT active_dataset,restore_token,restore_expires_at FROM moni_state WHERE singleton=1'
      )
      .first<{
        active_dataset: string;
        restore_token: string | null;
        restore_expires_at: number | null;
      }>();
    if (current?.active_dataset !== input.datasetId)
      throw new HttpError(409, 'dataset_changed');
    if (
      current.restore_expires_at &&
      current.restore_expires_at > Date.now() &&
      current.restore_token !== restoreToken
    )
      throw new HttpError(423, 'restore_locked');
    throw new HttpError(409, 'command_conflict');
  }
}

export const assertChanged = (db: D1Database) =>
  db.prepare(
    'INSERT INTO invariant_assertions(valid) SELECT 0 WHERE changes() <> 1'
  );
