import { z } from 'zod';
import { assertChanged, commandIdentity, executeCommand } from '../lib/command';
import { HttpError } from '../lib/http';
import { readRunDraftIds } from './draft-outcomes';

const createInput = z.object({ ...commandIdentity, id: z.uuid() }).strict();

export type LedgerConversation = {
  datasetId: string;
  id: string;
  title: string;
  source: 'web' | 'wechat';
  version: number;
  createdAt: number;
  updatedAt: number;
};

export async function readConversation(
  db: D1Database,
  id: string
): Promise<LedgerConversation> {
  const row = await db
    .prepare(`SELECT c.dataset_id AS datasetId, c.id, c.title, c.source, c.version,
    c.created_at AS createdAt, c.updated_at AS updatedAt FROM conversations c
    JOIN moni_state s ON s.singleton = 1 AND s.active_dataset = c.dataset_id
    WHERE c.id = ? AND c.deleted_at IS NULL`)
    .bind(id)
    .first<LedgerConversation>();
  if (!row) throw new HttpError(404, 'conversation_not_found');
  return row;
}

export async function createConversation(db: D1Database, raw: unknown) {
  const parsed = createInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_conversation');
  const input = parsed.data;
  const now = Date.now();
  return executeCommand(
    db,
    'conversation_create',
    input,
    [
      db
        .prepare(`INSERT INTO conversations(dataset_id,id,created_at,updated_at)
      SELECT ?,?,?,? WHERE NOT EXISTS (
        SELECT 1 FROM chat_messages WHERE dataset_id = ? AND thread_id = ?
      ) AND NOT EXISTS (SELECT 1 FROM chat_requests WHERE dataset_id = ? AND thread_id = ?)`)
        .bind(
          input.datasetId,
          input.id,
          now,
          now,
          input.datasetId,
          input.id,
          input.datasetId,
          input.id
        ),
      assertChanged(db),
    ],
    { id: input.id, created: true }
  );
}

const listInput = z
  .object({
    keyword: z.string().trim().max(200).default(''),
    page: z.number().int().min(1).max(5000).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export const conversationAction = z
  .object({
    ...commandIdentity,
    id: z.uuid(),
    version: z.number().int().positive(),
    confirmed: z.literal(true),
  })
  .strict();
export const cancelConversationInput = conversationAction
  .extend({
    runId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type ConversationPage = {
  datasetId: string;
  items: (LedgerConversation & { preview: string })[];
  total: number;
  page: number;
  pageCount: number;
};

export async function queryConversations(
  db: D1Database,
  raw: unknown
): Promise<ConversationPage> {
  const parsed = listInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_conversation_query');
  const { keyword, page, pageSize } = parsed.data;
  const search = keyword
    ? `AND (instr(lower(c.title),lower(?)) > 0 OR EXISTS (
    SELECT 1 FROM chat_messages m WHERE m.dataset_id = c.dataset_id AND m.thread_id = c.id
      AND json_extract(m.message_json,'$.role') IN ('user','assistant')
      AND json_type(m.message_json,'$.content') = 'text'
      AND instr(lower(json_extract(m.message_json,'$.content')),lower(?)) > 0))`
    : '';
  const values = keyword ? [keyword, keyword] : [];
  const from = `FROM conversations c JOIN moni_state s ON s.singleton = 1 AND s.active_dataset = c.dataset_id
    WHERE c.deleted_at IS NULL ${search}`;
  const [state, count, rows] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT active_dataset FROM moni_state WHERE singleton = 1'),
    db.prepare(`SELECT count(*) AS count ${from}`).bind(...values),
    db
      .prepare(`SELECT c.dataset_id AS datasetId,c.id,c.title,c.source,c.version,c.created_at AS createdAt,c.updated_at AS updatedAt,
      coalesce((SELECT substr(json_extract(m.message_json,'$.content'),1,120) FROM chat_messages m
        WHERE m.dataset_id = c.dataset_id AND m.thread_id = c.id AND json_extract(m.message_json,'$.role') IN ('user','assistant')
          AND json_type(m.message_json,'$.content') = 'text' AND length(json_extract(m.message_json,'$.content')) > 0
        ORDER BY m.position DESC LIMIT 1),'') AS preview
      ${from} ORDER BY c.updated_at DESC,c.id DESC LIMIT ? OFFSET ?`)
      .bind(...values, pageSize, (page - 1) * pageSize),
  ]);
  if (!state.results.length) throw new HttpError(503, 'storage_not_ready');
  const total = count.results[0].count as number;
  return {
    datasetId: state.results[0].active_dataset as string,
    items: rows.results as ConversationPage['items'],
    total,
    page,
    pageCount: Math.ceil(total / pageSize),
  };
}

export async function deleteConversation(db: D1Database, raw: unknown) {
  const parsed = conversationAction.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_conversation_action');
  const input = parsed.data;
  return executeCommand(
    db,
    'conversation_delete',
    input,
    [
      db
        .prepare(`UPDATE conversations SET deleted_at = ?, updated_at = ?, title = '', version = version + 1
      WHERE dataset_id = ? AND id = ? AND version = ? AND deleted_at IS NULL`)
        .bind(Date.now(), Date.now(), input.datasetId, input.id, input.version),
      assertChanged(db),
      db
        .prepare(
          'DELETE FROM chat_permits WHERE dataset_id = ? AND thread_id = ?'
        )
        .bind(input.datasetId, input.id),
      db
        .prepare(
          'DELETE FROM chat_messages WHERE dataset_id = ? AND thread_id = ?'
        )
        .bind(input.datasetId, input.id),
      db
        .prepare(
          "DELETE FROM chat_metadata WHERE dataset_id=? AND namespace='@tanstack/ai-compaction' AND key=?"
        )
        .bind(input.datasetId, input.id),
      db
        .prepare(
          'DELETE FROM chat_interrupts WHERE dataset_id = ? AND thread_id = ?'
        )
        .bind(input.datasetId, input.id),
      db
        .prepare(
          `UPDATE drafts SET status='cancelled',version=version+1,updated_at=? WHERE dataset_id=? AND thread_id=? AND status IN ('ready','needs_details')`
        )
        .bind(Date.now(), input.datasetId, input.id),
      db
        .prepare(`UPDATE chat_runs SET status = 'aborted',finished_at = ?,error = 'Conversation deleted',error_code = 'conversation_deleted'
      WHERE dataset_id = ? AND thread_id = ? AND status = 'running'`)
        .bind(Date.now(), input.datasetId, input.id),
    ],
    { deleted: true }
  );
}

export async function cancelConversation(db: D1Database, raw: unknown) {
  const parsed = cancelConversationInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_conversation_action');
  const input = parsed.data;
  return executeCommand(
    db,
    'conversation_cancel',
    input,
    [
      db
        .prepare(`UPDATE conversations SET version = version + 1,updated_at = ?
      WHERE dataset_id = ? AND id = ? AND version = ? AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM chat_runs r WHERE r.dataset_id = conversations.dataset_id AND r.thread_id = conversations.id
        AND r.run_id = ? AND r.status = 'running')`)
        .bind(
          Date.now(),
          input.datasetId,
          input.id,
          input.version,
          input.runId
        ),
      assertChanged(db),
      db
        .prepare(`UPDATE chat_runs SET status = 'aborted',finished_at = ?,error = 'Cancelled by owner',error_code = 'cancelled'
      WHERE dataset_id = ? AND thread_id = ? AND run_id = ? AND status = 'running'`)
        .bind(Date.now(), input.datasetId, input.id, input.runId),
      db
        .prepare(
          'DELETE FROM chat_permits WHERE dataset_id = ? AND thread_id = ? AND run_id = ?'
        )
        .bind(input.datasetId, input.id, input.runId),
    ],
    { cancelled: true }
  );
}

export type ConversationRun = {
  runId: string;
  status: string;
  errorCode: string | null;
  retryable: boolean;
  ledgerSaved?: boolean;
};

export async function readConversationRun(
  db: D1Database,
  datasetId: string,
  threadId: string
): Promise<ConversationRun | null> {
  const row = await db
    .prepare(`SELECT q.run_id AS runId,r.status,r.error_code AS errorCode,
    (r.status IN ('failed','aborted') AND coalesce(r.error_code,'') <> 'context_limit' AND q.user_message_id IS NOT NULL AND q.user_message_id = (
      SELECT json_extract(m.message_json,'$.id') FROM chat_messages m
      WHERE m.dataset_id = q.dataset_id AND m.thread_id = q.thread_id
        AND m.position = (SELECT max(tail.position) FROM chat_messages tail WHERE tail.dataset_id = q.dataset_id AND tail.thread_id = q.thread_id)
        AND json_extract(m.message_json,'$.role') = 'user'
    )) AS retryable
    FROM chat_requests q JOIN chat_runs r ON r.dataset_id = q.dataset_id AND r.run_id = q.run_id
    JOIN conversations c ON c.dataset_id = q.dataset_id AND c.id = q.thread_id AND c.deleted_at IS NULL
    JOIN moni_state s ON s.singleton = 1 AND s.active_dataset = q.dataset_id
    WHERE q.dataset_id = ? AND q.thread_id = ? ORDER BY q.accepted_at DESC,q.rowid DESC LIMIT 1`)
    .bind(datasetId, threadId)
    .first<Omit<ConversationRun, 'retryable'> & { retryable: number }>();
  if (row) {
    const ledgerSaved =
      (await readRunDraftIds(db, datasetId, threadId, row.runId)).length > 0;
    return {
      ...row,
      ledgerSaved,
      retryable: Boolean(row.retryable) && !ledgerSaved,
    };
  }
  const archived = await db
    .prepare(`SELECT r.run_id AS runId,r.status,r.error_code AS errorCode
    FROM chat_runs r JOIN conversations c ON c.dataset_id=r.dataset_id AND c.id=r.thread_id AND c.deleted_at IS NULL
    JOIN moni_state s ON s.singleton=1 AND s.active_dataset=r.dataset_id
    WHERE r.dataset_id=? AND r.thread_id=? ORDER BY r.started_at DESC,r.rowid DESC LIMIT 1`)
    .bind(datasetId, threadId)
    .first<Omit<ConversationRun, 'retryable'>>();
  return archived ? { ...archived, retryable: false } : null;
}
