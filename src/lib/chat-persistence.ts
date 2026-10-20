import type { ModelMessage, RunRecord } from '@tanstack/ai';
import {
  type ChatPersistence,
  defineAIPersistence,
  type InterruptRecord,
  type InterruptStore,
  type MessagePage,
} from '@tanstack/ai-persistence';
import { HttpError } from './http';
import { limits } from './limits';

type D1Value = string | number | null;

export type ChatPermit = {
  threadId: string;
  runId: string;
  token: string;
  conversationVersion?: number;
  channelEpoch?: string;
};

type RunRow = {
  run_id: string;
  thread_id: string;
  status: RunRecord['status'];
  started_at: number;
  finished_at: number | null;
  error: string | null;
  error_code: string | null;
  usage_json: string | null;
  sandbox_key: string | null;
  detached_since: number | null;
  cancel_requested: number | null;
  driver_epoch: number | null;
  parent_run_id: string | null;
  subagent_run_id: string | null;
  name: string | null;
};

function runFromRow(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    threadId: row.thread_id,
    status: row.status,
    startedAt: row.started_at,
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.error !== null
      ? {
          error: {
            message: row.error,
            ...(row.error_code !== null ? { code: row.error_code } : {}),
          },
        }
      : {}),
    ...(row.usage_json !== null ? { usage: JSON.parse(row.usage_json) } : {}),
    ...(row.sandbox_key !== null ? { sandboxKey: row.sandbox_key } : {}),
    ...(row.detached_since !== null
      ? { detachedSince: row.detached_since }
      : {}),
    ...(row.cancel_requested !== null
      ? { cancelRequested: row.cancel_requested === 1 }
      : {}),
    ...(row.driver_epoch !== null ? { driverEpoch: row.driver_epoch } : {}),
    ...(row.parent_run_id !== null ? { parentRunId: row.parent_run_id } : {}),
    ...(row.subagent_run_id !== null
      ? { subagentRunId: row.subagent_run_id }
      : {}),
    ...(row.name !== null ? { name: row.name } : {}),
  };
}

type InterruptRow = {
  interrupt_id: string;
  run_id: string;
  thread_id: string;
  status: InterruptRecord['status'];
  requested_at: number;
  resolved_at: number | null;
  payload_json: string;
  response_json: string | null;
};

function interruptFromRow(row: InterruptRow): InterruptRecord {
  return {
    interruptId: row.interrupt_id,
    runId: row.run_id,
    threadId: row.thread_id,
    status: row.status,
    requestedAt: row.requested_at,
    payload: JSON.parse(row.payload_json),
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
    ...(row.response_json !== null
      ? { response: JSON.parse(row.response_json) }
      : {}),
  };
}

const permitSelect = `SELECT 1 FROM chat_permits p JOIN moni_state s
  ON s.singleton = 1 AND s.active_dataset = p.dataset_id
  AND (s.restore_expires_at IS NULL OR s.restore_expires_at<=unixepoch('subsec')*1000)
  WHERE p.dataset_id = ? AND p.thread_id = ? AND p.run_id = ?
    AND p.token = ? AND p.expires_at > unixepoch('subsec') * 1000
    AND ((? = -1 AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.dataset_id = p.dataset_id AND c.id = p.thread_id))
      OR EXISTS (SELECT 1 FROM conversations c WHERE c.dataset_id = p.dataset_id AND c.id = p.thread_id
        AND c.deleted_at IS NULL AND c.version = ?))
    AND (? IS NULL OR EXISTS (SELECT 1 FROM wechat_binding w WHERE w.singleton=1
      AND w.enabled=1 AND w.epoch=? AND w.dataset_id=p.dataset_id AND w.thread_id=p.thread_id))`;

function permitValues(dataset: string, permit: ChatPermit): D1Value[] {
  return [
    dataset,
    permit.threadId,
    permit.runId,
    permit.token,
    permit.conversationVersion ?? -1,
    permit.conversationVersion ?? -1,
    permit.channelEpoch ?? null,
    permit.channelEpoch ?? null,
  ];
}

export async function assertChatExecution(
  db: D1Database,
  dataset: string,
  permit: ChatPermit,
  signal?: AbortSignal
) {
  if (
    signal?.aborted ||
    !(await db
      .prepare(permitSelect)
      .bind(...permitValues(dataset, permit))
      .first())
  )
    throw new Error('Conversation execution revoked');
}

export function chatExecutionGuard(
  db: D1Database,
  dataset: string,
  permit: ChatPermit
) {
  return db
    .prepare(
      `INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS (${permitSelect})`
    )
    .bind(...permitValues(dataset, permit));
}

/** Bindings and execution permits belong to this request, never module state. */
export function chatPersistence(
  db: D1Database,
  dataset = 'initial',
  permit?: ChatPermit,
  signal?: AbortSignal
): ChatPersistence {
  const stmt = (sql: string, ...values: D1Value[]) =>
    db.prepare(sql).bind(...values);

  async function write(statements: D1PreparedStatement[]) {
    if (signal?.aborted) throw new Error('Conversation execution revoked');
    // The guard and mutations share one D1 transaction; a stale write rolls back.
    const guard = permit ? [chatExecutionGuard(db, dataset, permit)] : [];
    return db.batch([
      stmt(
        `INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS (
        SELECT 1 FROM moni_state WHERE singleton=1 AND active_dataset=?
          AND (restore_expires_at IS NULL OR restore_expires_at<=unixepoch('subsec')*1000)
      )`,
        dataset
      ),
      ...guard,
      ...statements,
      ...(permit?.conversationVersion !== undefined
        ? [
            stmt(
              'UPDATE conversations SET updated_at = ? WHERE dataset_id = ? AND id = ? AND version = ? AND deleted_at IS NULL',
              Date.now(),
              dataset,
              permit.threadId,
              permit.conversationVersion
            ),
            stmt(
              'UPDATE moni_state SET revision = revision + 1 WHERE singleton = 1 AND active_dataset = ?',
              dataset
            ),
          ]
        : []),
    ]);
  }

  const getRun = async (runId: string) => {
    const row = await stmt(
      'SELECT * FROM chat_runs WHERE dataset_id = ? AND run_id = ?',
      dataset,
      runId
    ).first<RunRow>();
    return row ? runFromRow(row) : null;
  };
  const listRuns = async (condition: string, ...values: D1Value[]) => {
    const { results } = await stmt(
      `SELECT * FROM chat_runs WHERE dataset_id = ? AND ${condition} ORDER BY started_at ASC`,
      dataset,
      ...values
    ).all<RunRow>();
    return results.map(runFromRow);
  };
  const listInterrupts = async (condition: string, ...values: D1Value[]) => {
    const { results } = await stmt(
      `SELECT * FROM chat_interrupts WHERE dataset_id = ? AND ${condition} ORDER BY requested_at ASC`,
      dataset,
      ...values
    ).all<InterruptRow>();
    return results.map(interruptFromRow);
  };
  const settleInterrupt = (id: string, status: string, response?: unknown) =>
    stmt(
      `UPDATE chat_interrupts SET status = ?, resolved_at = ?, response_json = ?
       WHERE dataset_id = ? AND interrupt_id = ?`,
      status,
      Date.now(),
      response === undefined ? null : JSON.stringify(response),
      dataset,
      id
    );

  const interrupts: InterruptStore = {
    async create(record) {
      await write([
        stmt(
          `INSERT INTO chat_interrupts
           (dataset_id, interrupt_id, run_id, thread_id, requested_at, payload_json)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          dataset,
          record.interruptId,
          record.runId,
          record.threadId,
          record.requestedAt,
          JSON.stringify(record.payload)
        ),
      ]);
    },
    async resolve(id, response) {
      await write([settleInterrupt(id, 'resolved', response)]);
    },
    async cancel(id) {
      await write([settleInterrupt(id, 'cancelled')]);
    },
    async commitBatch(entries) {
      const ids = new Set(entries.map((entry) => entry.interruptId));
      if (ids.size !== entries.length)
        throw new Error('Duplicate interrupt id');
      if (!entries.length) return;
      await write([
        ...entries.map((entry) =>
          stmt(
            `INSERT INTO invariant_assertions (valid) SELECT 0 WHERE NOT EXISTS (
              SELECT 1 FROM chat_interrupts
              WHERE dataset_id = ? AND interrupt_id = ? AND status = 'pending'
            )`,
            dataset,
            entry.interruptId
          )
        ),
        ...entries.map((entry) =>
          settleInterrupt(
            entry.interruptId,
            entry.status,
            entry.status === 'resolved' ? entry.response : undefined
          )
        ),
      ]);
    },
    async get(id) {
      const row = await stmt(
        'SELECT * FROM chat_interrupts WHERE dataset_id = ? AND interrupt_id = ?',
        dataset,
        id
      ).first<InterruptRow>();
      return row ? interruptFromRow(row) : null;
    },
    list: (threadId) => listInterrupts('thread_id = ?', threadId),
    listPending: (threadId) =>
      listInterrupts("thread_id = ? AND status = 'pending'", threadId),
    listByRun: (runId) => listInterrupts('run_id = ?', runId),
    listPendingByRun: (runId) =>
      listInterrupts("run_id = ? AND status = 'pending'", runId),
  };

  function jsonValue(value: unknown): string {
    if (value === null || value === undefined)
      throw new TypeError(
        'Metadata value must be non-null; use delete instead'
      );
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Metadata must be JSON');
    return encoded;
  }

  async function historyRows(threadId: string) {
    // shortcut: SDK snapshots need a full array; add an archival adapter before histories approach Worker memory.
    const rows: { position: number; message_json: string }[] = [];
    let position = -1;
    for (;;) {
      const page = await stmt(
        'SELECT position,message_json FROM chat_messages WHERE dataset_id=? AND thread_id=? AND position>? ORDER BY position LIMIT 200',
        dataset,
        threadId,
        position
      ).all<{ position: number; message_json: string }>();
      rows.push(...page.results);
      if (page.results.length < 200) return rows;
      position = page.results.at(-1)?.position ?? position;
    }
  }

  function loadThread(threadId: string): Promise<ModelMessage[]>;
  function loadThread(
    threadId: string,
    options: { limit?: number; before?: string }
  ): Promise<ModelMessage[] | MessagePage>;
  async function loadThread(
    threadId: string,
    options?: { limit?: number; before?: string }
  ): Promise<ModelMessage[] | MessagePage> {
    if (options?.limit !== undefined) {
      const limit = Math.min(200, options.limit);
      if (!Number.isInteger(limit) || limit < 1)
        throw new HttpError(400, 'invalid_history_page');
      let before = Number.MAX_SAFE_INTEGER;
      if (options.before) {
        try {
          const cursor = JSON.parse(atob(options.before));
          if (
            cursor.dataset !== dataset ||
            cursor.thread !== threadId ||
            !Number.isSafeInteger(cursor.position) ||
            cursor.position < 0
          )
            throw new Error('Invalid cursor');
          before = cursor.position;
        } catch {
          // reconstructChat can replace an adapter cursor with the first visible UI message ID.
          const position = await stmt(
            "SELECT position FROM chat_messages WHERE dataset_id=? AND thread_id=? AND json_extract(message_json,'$.id')=? LIMIT 1",
            dataset,
            threadId,
            options.before
          ).first<number>('position');
          if (position === null)
            throw new HttpError(400, 'invalid_history_cursor');
          before = position;
        }
      }
      const page = await stmt(
        'SELECT position,message_json FROM chat_messages WHERE dataset_id=? AND thread_id=? AND position<? ORDER BY position DESC LIMIT ?',
        dataset,
        threadId,
        before,
        limit + 1
      ).all<{ position: number; message_json: string }>();
      const truncated = page.results.length > limit;
      let rows = page.results.slice(0, limit).reverse();
      if (
        truncated &&
        rows.length &&
        JSON.parse(rows[0].message_json).role !== 'user'
      ) {
        const start = await stmt(
          "SELECT position FROM chat_messages WHERE dataset_id=? AND thread_id=? AND position<=? AND json_extract(message_json,'$.role')='user' ORDER BY position DESC LIMIT 1",
          dataset,
          threadId,
          rows[0].position
        ).first<number>('position');
        if (start !== null)
          rows = (
            await stmt(
              'SELECT position,message_json FROM chat_messages WHERE dataset_id=? AND thread_id=? AND position>=? AND position<? ORDER BY position',
              dataset,
              threadId,
              start,
              before
            ).all<{ position: number; message_json: string }>()
          ).results;
      }
      const messages = rows.map((row) => {
        const message = JSON.parse(row.message_json) as ModelMessage;
        return {
          ...message,
          id:
            message.id ??
            btoa(
              JSON.stringify({
                dataset,
                thread: threadId,
                position: row.position,
              })
            ),
        };
      });
      const hasEarlier =
        rows.length > 0 &&
        Boolean(
          await stmt(
            'SELECT 1 AS found FROM chat_messages WHERE dataset_id=? AND thread_id=? AND position<? LIMIT 1',
            dataset,
            threadId,
            rows[0].position
          ).first('found')
        );
      return hasEarlier
        ? {
            messages,
            truncated: true,
            cursor: btoa(
              JSON.stringify({
                dataset,
                thread: threadId,
                position: rows[0].position,
              })
            ),
          }
        : { messages, truncated: false };
    }
    return (await historyRows(threadId)).map(
      (row) => JSON.parse(row.message_json) as ModelMessage
    );
  }

  return defineAIPersistence({
    stores: {
      messages: {
        loadThread,
        async saveThread(threadId, messages) {
          if (permit && permit.threadId !== threadId)
            throw new Error('Conversation permit mismatch');
          const stored = new Map(
            (await historyRows(threadId)).map((row) => [
              row.position,
              row.message_json,
            ])
          );
          const statements: D1PreparedStatement[] = [];
          let chunk: { position: number; message: string }[] = [];
          let size = 0;
          const flush = () => {
            if (!chunk.length) return;
            statements.push(
              stmt(
                `INSERT INTO chat_messages(dataset_id,thread_id,position,message_json)
              SELECT ?,?,json_extract(value,'$.position'),json_extract(value,'$.message') FROM json_each(?) WHERE 1
              ON CONFLICT(dataset_id,thread_id,position) DO UPDATE SET message_json=excluded.message_json`,
                dataset,
                threadId,
                JSON.stringify(chunk)
              )
            );
            chunk = [];
            size = 0;
          };
          messages.forEach((message, position) => {
            const encoded = JSON.stringify(message);
            const bytes = new TextEncoder().encode(encoded).length;
            if (bytes > limits.historyMessageBytes)
              throw new RangeError('Individual message limit exceeded');
            if (stored.get(position) === encoded) return;
            if (size + bytes > 32 * 1024) flush();
            chunk.push({ position, message: encoded });
            size += bytes;
          });
          flush();
          statements.push(
            stmt(
              'DELETE FROM chat_messages WHERE dataset_id=? AND thread_id=? AND position>=?',
              dataset,
              threadId,
              messages.length
            )
          );
          await write(statements);
        },
      },
      runs: {
        async createOrResume(input) {
          if (
            permit &&
            (input.threadId !== permit.threadId || input.runId !== permit.runId)
          )
            throw new Error('Conversation permit mismatch');
          await write([
            stmt(
              `INSERT INTO chat_runs
               (dataset_id, run_id, thread_id, status, started_at, parent_run_id, subagent_run_id, name)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
              dataset,
              input.runId,
              input.threadId,
              input.status ?? 'running',
              input.startedAt,
              input.parentRunId ?? null,
              input.subagentRunId ?? null,
              input.name ?? null
            ),
          ]);
          const record = await getRun(input.runId);
          if (!record) throw new Error('Run was not saved');
          return record;
        },
        async update(runId, patch) {
          if (permit && runId !== permit.runId)
            throw new Error('Conversation permit mismatch');
          const columns: string[] = [];
          const values: D1Value[] = [];
          const put = (column: string, value: D1Value) => {
            columns.push(`${column} = ?`);
            values.push(value);
          };
          if ('status' in patch) put('status', patch.status ?? null);
          if ('finishedAt' in patch)
            put('finished_at', patch.finishedAt ?? null);
          if ('error' in patch) {
            // Provider error text may contain private request details.
            put(
              'error',
              patch.error
                ? permit
                  ? patch.error.code === 'context_limit'
                    ? 'Conversation context limit reached'
                    : 'AI execution failed'
                  : patch.error.message
                : null
            );
            put(
              'error_code',
              patch.error
                ? permit
                  ? patch.error.code === 'context_limit'
                    ? 'context_limit'
                    : 'ai_unavailable'
                  : (patch.error.code ?? null)
                : null
            );
          }
          if ('usage' in patch)
            put('usage_json', patch.usage ? JSON.stringify(patch.usage) : null);
          if ('sandboxKey' in patch)
            put('sandbox_key', patch.sandboxKey ?? null);
          if ('detachedSince' in patch)
            put('detached_since', patch.detachedSince ?? null);
          if ('cancelRequested' in patch)
            put(
              'cancel_requested',
              patch.cancelRequested === undefined
                ? null
                : Number(patch.cancelRequested)
            );
          if ('driverEpoch' in patch)
            put('driver_epoch', patch.driverEpoch ?? null);
          if (!columns.length) return;
          await write([
            stmt(
              `UPDATE chat_runs SET ${columns.join(', ')} WHERE dataset_id = ? AND run_id = ?`,
              ...values,
              dataset,
              runId
            ),
          ]);
        },
        get: getRun,
        listByThread: (threadId) => listRuns('thread_id = ?', threadId),
        listByParentRun: (parentRunId) =>
          listRuns('parent_run_id = ?', parentRunId),
        listReclaimable: ({ now, ttlMs }) =>
          listRuns("status = 'running' AND detached_since <= ?", now - ttlMs),
        async findActiveRun(threadId) {
          const row = await stmt(
            `SELECT * FROM chat_runs WHERE dataset_id = ? AND thread_id = ?
             AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
            dataset,
            threadId
          ).first<RunRow>();
          return row ? runFromRow(row) : null;
        },
      },
      interrupts,
      metadata: {
        async get(namespace, key) {
          const row = await stmt(
            'SELECT value_json FROM chat_metadata WHERE dataset_id = ? AND namespace = ? AND key = ?',
            dataset,
            namespace,
            key
          ).first<{ value_json: string }>();
          return row ? JSON.parse(row.value_json) : null;
        },
        async getVersioned(namespace, key) {
          const row = await stmt(
            'SELECT value_json, revision FROM chat_metadata WHERE dataset_id = ? AND namespace = ? AND key = ?',
            dataset,
            namespace,
            key
          ).first<{ value_json: string; revision: string }>();
          return row
            ? { value: JSON.parse(row.value_json), revision: row.revision }
            : null;
        },
        async set(namespace, key, value) {
          await write([
            stmt(
              `INSERT INTO chat_metadata (dataset_id, namespace, key, value_json, revision)
               VALUES (?, ?, ?, ?, ?) ON CONFLICT(dataset_id, namespace, key)
               DO UPDATE SET value_json = excluded.value_json, revision = excluded.revision`,
              dataset,
              namespace,
              key,
              jsonValue(value),
              crypto.randomUUID()
            ),
          ]);
        },
        async setIf(namespace, key, value, expectedRevision) {
          const revision = crypto.randomUUID();
          const encoded = jsonValue(value);
          const results = await write([
            expectedRevision === null
              ? stmt(
                  `INSERT INTO chat_metadata (dataset_id, namespace, key, value_json, revision)
                   VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
                  dataset,
                  namespace,
                  key,
                  encoded,
                  revision
                )
              : stmt(
                  `UPDATE chat_metadata SET value_json = ?, revision = ?
                   WHERE dataset_id = ? AND namespace = ? AND key = ? AND revision = ?`,
                  encoded,
                  revision,
                  dataset,
                  namespace,
                  key,
                  expectedRevision
                ),
          ]);
          return results[results.length - 1].meta.changes > 0
            ? { ok: true, revision }
            : { ok: false, reason: 'conflict' };
        },
        async delete(namespace, key) {
          await write([
            stmt(
              'DELETE FROM chat_metadata WHERE dataset_id = ? AND namespace = ? AND key = ?',
              dataset,
              namespace,
              key
            ),
          ]);
        },
      },
    },
  });
}
