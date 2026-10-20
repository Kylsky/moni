import { z } from 'zod';
import { assertChanged, commandIdentity, executeCommand } from '../lib/command';
import { HttpError } from '../lib/http';
import { limits } from '../lib/limits';
import { backupSections, exportBackup, exportResponse } from './exports';
import type { RestorePreview } from './restore';
import { cleanRestoreStaging } from './restore';

const digestValue = z.string().regex(/^[a-f0-9]{64}$/);
const beginInput = z
  .object({ ...commandIdentity, preparationId: z.uuid(), digest: digestValue })
  .strict();
const sessionInput = z
  .object({
    datasetId: z.string().min(1).max(100),
    id: z.uuid(),
    token: z.uuid(),
  })
  .strict();
const abortInput = sessionInput.extend({ operationId: z.uuid() }).strict();
const commitInput = abortInput
  .extend({
    digest: digestValue,
    backupDigest: digestValue,
    backupRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    savedBackup: z.literal(true),
    confirmed: z.literal(true),
  })
  .strict();
type Session = {
  id: string;
  preparation_id: string;
  source_dataset: string;
  target_dataset: string;
  target_digest: string;
  token: string;
  expires_at: number;
  status: 'locked' | 'downloaded' | 'activated' | 'cancelled';
  backup_digest: string | null;
  backup_revision: number | null;
  confirmation_id: string | null;
  confirmation_hash: string | null;
};
export type RestoreSessionView = {
  id: string;
  token: string;
  preparationId: string;
  digest: string;
  expiresAt: number;
  status: Session['status'];
};
export type RestoreRecovery = {
  datasetId: string;
  recovery: {
    preview: RestorePreview;
    session: RestoreSessionView;
    expired: boolean;
  } | null;
};
export async function currentRestoreSession(
  db: D1Database
): Promise<RestoreRecovery> {
  const state = await db
    .prepare(
      'SELECT active_dataset,restore_id,restore_token,restore_expires_at FROM moni_state WHERE singleton=1'
    )
    .first<{
      active_dataset: string;
      restore_id: string | null;
      restore_token: string | null;
      restore_expires_at: number | null;
    }>();
  if (!state) throw new HttpError(503, 'storage_not_ready');
  const none = { datasetId: state.active_dataset, recovery: null };
  if (!state.restore_id) return none;
  const row = await readSession(db, state.restore_id);
  if (
    !row ||
    row.source_dataset !== state.active_dataset ||
    row.token !== state.restore_token ||
    !['locked', 'downloaded'].includes(row.status)
  )
    return none;
  const job = await db
    .prepare(
      "SELECT id,digest,progress,total,expires_at,summary_json FROM restore_preparations WHERE id=? AND status='sealed' AND target_dataset=?"
    )
    .bind(row.preparation_id, row.target_dataset)
    .first<{
      id: string;
      digest: string;
      progress: number;
      total: number;
      expires_at: number;
      summary_json: string;
    }>();
  if (!job) return none;
  return {
    datasetId: state.active_dataset,
    recovery: {
      preview: {
        id: job.id,
        digest: job.digest,
        status: 'sealed',
        progress: job.progress,
        total: job.total,
        expiresAt: job.expires_at,
        summary: JSON.parse(job.summary_json),
      },
      session: {
        id: row.id,
        token: row.token,
        preparationId: row.preparation_id,
        digest: row.target_digest,
        expiresAt: row.expires_at,
        status: row.status,
      },
      expired:
        row.expires_at <= Date.now() ||
        (state.restore_expires_at ?? 0) <= Date.now(),
    },
  };
}
const hash = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    ),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
const readSession = (db: D1Database, id: string) =>
  db
    .prepare('SELECT * FROM restore_sessions WHERE id=?')
    .bind(id)
    .first<Session>();

async function ownedSession(
  db: D1Database,
  input: z.infer<typeof sessionInput>,
  live = true
) {
  const row = await readSession(db, input.id);
  if (
    !row ||
    row.source_dataset !== input.datasetId ||
    row.token !== input.token
  )
    throw new HttpError(409, 'restore_session_changed');
  if (
    live &&
    (row.expires_at <= Date.now() ||
      !['locked', 'downloaded'].includes(row.status))
  )
    throw new HttpError(409, 'restore_session_expired');
  return row;
}
function sessionGuard(db: D1Database, row: Session, revision?: number) {
  return db
    .prepare(`INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS (
    SELECT 1 FROM moni_state s JOIN restore_sessions r ON r.id=s.restore_id AND r.token=s.restore_token
    JOIN restore_preparations p ON p.id=r.preparation_id AND p.target_dataset=r.target_dataset AND p.digest=r.target_digest
    WHERE s.singleton=1 AND s.active_dataset=? AND s.restore_id=? AND s.restore_token=? AND s.restore_expires_at>unixepoch('subsec')*1000
      AND r.status IN ('locked','downloaded') AND r.expires_at>unixepoch('subsec')*1000
      AND p.status='sealed' AND p.expires_at>unixepoch('subsec')*1000 AND p.target_dataset<>s.active_dataset
      AND (? IS NULL OR s.revision=?)
  )`)
    .bind(
      row.source_dataset,
      row.id,
      row.token,
      revision ?? null,
      revision ?? null
    );
}

export async function beginRestoreSession(db: D1Database, raw: unknown) {
  const parsed = beginInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_restore_session');
  const input = parsed.data;
  const job = await db
    .prepare('SELECT * FROM restore_preparations WHERE id=?')
    .bind(input.preparationId)
    .first<{
      source_dataset: string;
      target_dataset: string;
      digest: string;
      status: string;
      expires_at: number;
    }>();
  if (
    !job ||
    job.source_dataset !== input.datasetId ||
    job.digest !== input.digest ||
    job.status !== 'sealed' ||
    job.expires_at <= Date.now()
  )
    throw new HttpError(409, 'restore_not_sealed');
  const cancellationTargets = (
    await db
      .prepare(
        "SELECT thread_id AS threadId,run_id AS runId FROM chat_runs WHERE dataset_id=? AND status='running' ORDER BY started_at LIMIT 20"
      )
      .bind(input.datasetId)
      .all<{ threadId: string; runId: string }>()
  ).results;
  const token = crypto.randomUUID();
  const expiresAt = Math.min(
    Date.now() + limits.restoreLockMilliseconds,
    job.expires_at
  );
  const session: RestoreSessionView = {
    id: input.operationId,
    token,
    preparationId: input.preparationId,
    digest: input.digest,
    expiresAt,
    status: 'locked',
  };
  const saved = await executeCommand(
    db,
    'begin_restore_session',
    input,
    [
      db
        .prepare(
          "INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM restore_preparations WHERE id=? AND source_dataset=? AND target_dataset=? AND digest=? AND status='sealed' AND expires_at>unixepoch('subsec')*1000)"
        )
        .bind(
          input.preparationId,
          input.datasetId,
          job.target_dataset,
          input.digest
        ),
      db
        .prepare(
          "INSERT INTO restore_sessions(id,preparation_id,source_dataset,target_dataset,target_digest,token,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?,'locked',?)"
        )
        .bind(
          input.operationId,
          input.preparationId,
          input.datasetId,
          job.target_dataset,
          input.digest,
          token,
          expiresAt,
          Date.now()
        ),
      db
        .prepare(
          'UPDATE moni_state SET restore_id=?,restore_token=?,restore_expires_at=? WHERE singleton=1 AND active_dataset=?'
        )
        .bind(input.operationId, token, expiresAt, input.datasetId),
      assertChanged(db),
      db
        .prepare('DELETE FROM chat_permits WHERE dataset_id=?')
        .bind(input.datasetId),
      db
        .prepare(
          "UPDATE chat_runs SET status='aborted',finished_at=?,error='Restore interrupted execution',error_code='interrupted' WHERE dataset_id=? AND status='running'"
        )
        .bind(Date.now(), input.datasetId),
    ],
    session
  );
  const current = await db
    .prepare(
      'SELECT active_dataset,restore_id,restore_token,restore_expires_at FROM moni_state WHERE singleton=1'
    )
    .first<{
      active_dataset: string;
      restore_id: string | null;
      restore_token: string | null;
      restore_expires_at: number | null;
    }>();
  if (
    !current ||
    current.active_dataset !== input.datasetId ||
    current.restore_id !== saved.id ||
    current.restore_token !== saved.token ||
    (current.restore_expires_at ?? 0) <= Date.now()
  )
    throw new HttpError(409, 'restore_session_expired');
  return { session: saved, cancellationTargets, datasetId: input.datasetId };
}

export async function downloadCurrentBackup(db: D1Database, raw: unknown) {
  const parsed = sessionInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_restore_session');
  const row = await ownedSession(db, parsed.data);
  try {
    await db.batch([sessionGuard(db, row)]);
  } catch {
    throw new HttpError(409, 'restore_session_changed');
  }
  const backup = await exportBackup(db);
  if (backup.datasetId !== row.source_dataset)
    throw new HttpError(409, 'dataset_changed');
  const digest = await hash(backup.content);
  try {
    await db.batch([
      sessionGuard(db, row, backup.revision),
      db
        .prepare(
          "UPDATE restore_sessions SET backup_digest=?,backup_revision=?,status='downloaded' WHERE id=?"
        )
        .bind(digest, backup.revision, row.id),
    ]);
  } catch {
    throw new HttpError(409, 'restore_session_changed');
  }
  const response = exportResponse(backup, 'json');
  response.headers.set(
    'Content-Disposition',
    'attachment; filename="moni-current-before-restore.json"'
  );
  response.headers.set('X-Moni-Restore-Digest', digest);
  return response;
}

export async function abortRestoreSession(db: D1Database, raw: unknown) {
  const parsed = abortInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_restore_session');
  const input = parsed.data;
  const row = await ownedSession(db, input, false);
  if (row.status === 'activated')
    throw new HttpError(409, 'restore_already_activated');
  await executeCommand(
    db,
    'abort_restore_session',
    input,
    [
      db
        .prepare(
          "INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM restore_sessions WHERE id=? AND token=? AND status<>'activated')"
        )
        .bind(row.id, row.token),
      db
        .prepare(
          "UPDATE restore_sessions SET status='cancelled' WHERE id=? AND token=?"
        )
        .bind(row.id, row.token),
      db
        .prepare(
          'UPDATE moni_state SET restore_id=NULL,restore_token=NULL,restore_expires_at=NULL WHERE singleton=1 AND restore_id=? AND restore_token=?'
        )
        .bind(row.id, row.token),
      db
        .prepare(
          "UPDATE restore_preparations SET status='cancelled' WHERE id=? AND target_dataset=? AND status<>'activated'"
        )
        .bind(row.preparation_id, row.target_dataset),
    ],
    { cancelled: true },
    row.token
  );
  await cleanRestoreStaging(db, {
    id: row.preparation_id,
    target_dataset: row.target_dataset,
  });
  return { cancelled: true };
}

export async function commitRestoreSession(db: D1Database, raw: unknown) {
  const parsed = commitInput.safeParse(raw);
  if (!parsed.success)
    throw new HttpError(400, 'restore_confirmation_required');
  const input = parsed.data;
  const row = await ownedSession(db, input, false);
  const confirmationHash = await hash(JSON.stringify(input));
  if (row.status === 'activated') {
    const active = await db
      .prepare('SELECT active_dataset FROM moni_state WHERE singleton=1')
      .first<string>('active_dataset');
    if (
      row.confirmation_id === input.operationId &&
      row.confirmation_hash === confirmationHash &&
      active === row.target_dataset
    )
      return { restored: true, datasetId: row.target_dataset };
    throw new HttpError(409, 'restore_already_activated');
  }
  if (row.expires_at <= Date.now())
    throw new HttpError(409, 'restore_session_expired');
  if (
    row.status !== 'downloaded' ||
    row.target_digest !== input.digest ||
    row.backup_digest !== input.backupDigest ||
    row.backup_revision !== input.backupRevision
  )
    throw new HttpError(409, 'restore_backup_required');
  const now = Date.now();
  return executeCommand(
    db,
    'commit_restore_session',
    input,
    [
      sessionGuard(db, row, input.backupRevision),
      db
        .prepare(
          "INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM restore_sessions WHERE id=? AND status='downloaded' AND backup_digest=? AND backup_revision=?)"
        )
        .bind(row.id, input.backupDigest, input.backupRevision),
      db
        .prepare(
          "UPDATE chat_runs SET status='aborted',finished_at=?,error='Imported unfinished execution',error_code='interrupted',sandbox_key=NULL,detached_since=NULL,cancel_requested=NULL,driver_epoch=NULL WHERE dataset_id=? AND status='running'"
        )
        .bind(now, row.target_dataset),
      db
        .prepare(
          "UPDATE chat_interrupts SET status='cancelled',resolved_at=? WHERE dataset_id=? AND status='pending'"
        )
        .bind(now, row.target_dataset),
      db
        .prepare(
          "UPDATE drafts SET status='cancelled',version=version+1,updated_at=? WHERE dataset_id=? AND status IN ('ready','needs_details')"
        )
        .bind(now, row.target_dataset),
      db
        .prepare(
          'UPDATE conversations SET version=version+1 WHERE dataset_id=?'
        )
        .bind(row.target_dataset),
      db
        .prepare('DELETE FROM chat_permits WHERE dataset_id=?')
        .bind(row.target_dataset),
      db
        .prepare('DELETE FROM chat_requests WHERE dataset_id=?')
        .bind(row.target_dataset),
      db
        .prepare('DELETE FROM operation_receipts WHERE dataset_id=?')
        .bind(row.target_dataset),
      db
        .prepare(
          "UPDATE restore_sessions SET status='activated',confirmation_id=?,confirmation_hash=?,retire_after=? WHERE id=? AND token=?"
        )
        .bind(
          input.operationId,
          confirmationHash,
          now + 2 * limits.runMilliseconds,
          row.id,
          row.token
        ),
      db
        .prepare(
          "UPDATE restore_preparations SET status='activated' WHERE id=? AND digest=?"
        )
        .bind(row.preparation_id, row.target_digest),
      db
        .prepare(
          "UPDATE moni_state SET active_dataset=?,restore_id=NULL,restore_token=NULL,restore_expires_at=NULL WHERE singleton=1 AND active_dataset=? AND restore_id=? AND restore_token=? AND restore_expires_at>unixepoch('subsec')*1000"
        )
        .bind(row.target_dataset, row.source_dataset, row.id, row.token),
      assertChanged(db),
    ],
    { restored: true, datasetId: row.target_dataset },
    row.token
  );
}

export async function cleanRetiredRestore(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT id,source_dataset FROM restore_sessions WHERE status='activated' AND retired_at IS NULL AND retire_after<=? AND source_dataset<>(SELECT active_dataset FROM moni_state WHERE singleton=1) ORDER BY retire_after LIMIT 1"
    )
    .bind(Date.now())
    .first<{ id: string; source_dataset: string }>();
  if (!row) return;
  const condition =
    "?<>(SELECT active_dataset FROM moni_state WHERE singleton=1) AND EXISTS(SELECT 1 FROM restore_sessions WHERE id=? AND source_dataset=? AND status='activated' AND retire_after<=unixepoch('subsec')*1000 AND retired_at IS NULL)";
  await db.batch([
    ...[...backupSections]
      .reverse()
      .map((section) =>
        db
          .prepare(
            `DELETE FROM ${section.table} WHERE dataset_id=? AND ${condition}`
          )
          .bind(
            row.source_dataset,
            row.source_dataset,
            row.id,
            row.source_dataset
          )
      ),
    ...[
      'chat_requests',
      'chat_permits',
      'chat_metadata',
      'operation_receipts',
      'fx_quotes',
    ].map((table) =>
      db
        .prepare(`DELETE FROM ${table} WHERE dataset_id=? AND ${condition}`)
        .bind(
          row.source_dataset,
          row.source_dataset,
          row.id,
          row.source_dataset
        )
    ),
    db
      .prepare(`DELETE FROM datasets WHERE id=? AND ${condition}`)
      .bind(row.source_dataset, row.source_dataset, row.id, row.source_dataset),
    db
      .prepare(
        `UPDATE restore_sessions SET retired_at=? WHERE id=? AND ${condition}`
      )
      .bind(Date.now(), row.id, row.source_dataset, row.id, row.source_dataset),
  ]);
}
