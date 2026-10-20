import { z } from 'zod';
import { commandIdentity, executeCommand } from '../lib/command';
import { HttpError } from '../lib/http';
import { type LedgerBackup, validateBackup } from './backup-contract';
import { backupSections, backupSelections } from './exports';

const prepareInput = z
  .object({ ...commandIdentity, backup: z.unknown() })
  .strict();
const cancelInput = z.object({ ...commandIdentity, id: z.uuid() }).strict();
export type RestoreSummary = {
  primaryCurrency: string;
  timeZone: string;
  currencies: string[];
  from: string | null;
  to: string | null;
  entries: number;
  trash: number;
  refunds: number;
  categories: number;
  tags: number;
  aliases: number;
  conversations: number;
  deletedConversations: number;
  messages: number;
  drafts: number;
  unfinishedRuns: number;
};
type Preparation = {
  id: string;
  source_dataset: string;
  target_dataset: string;
  digest: string;
  status: 'loading' | 'sealed' | 'cancelled' | 'failed' | 'activated';
  progress: number;
  total: number;
  header_json: string;
  summary_json: string;
  created_at: number;
  expires_at: number;
};
export type RestorePreview = {
  id: string;
  digest: string;
  status: Preparation['status'];
  progress: number;
  total: number;
  expiresAt: number;
  summary: RestoreSummary;
};
const view = (job: Preparation): RestorePreview => ({
  id: job.id,
  digest: job.digest,
  status: job.status,
  progress: job.progress,
  total: job.total,
  expiresAt: job.expires_at,
  summary: JSON.parse(job.summary_json),
});
const hash = async (value: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(value))
      )
    ),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');

function summaryOf(backup: LedgerBackup): RestoreSummary {
  const { data, settings } = backup;
  const dates = data.entries.map((row) => row.date).sort();
  return {
    primaryCurrency: settings.primaryCurrency,
    timeZone: settings.timeZone,
    currencies: [...new Set(data.entries.map((row) => row.currency))].sort(),
    from: dates[0] ?? null,
    to: dates.at(-1) ?? null,
    entries: data.entries.filter((row) => row.deletedAt === null).length,
    trash: data.entries.filter((row) => row.deletedAt !== null).length,
    refunds: data.refundLinks.length,
    categories: data.categories.length,
    tags: data.tags.filter((row) => !row.mergedInto).length,
    aliases: data.tags.filter((row) => row.mergedInto).length,
    conversations: data.conversations.filter((row) => row.deletedAt === null)
      .length,
    deletedConversations: data.conversations.filter(
      (row) => row.deletedAt !== null
    ).length,
    messages: data.messages.length,
    drafts: data.drafts.length,
    unfinishedRuns: data.runs.filter((row) => row.status === 'running').length,
  };
}
async function readJob(db: D1Database, id: string) {
  return db
    .prepare('SELECT * FROM restore_preparations WHERE id=?')
    .bind(id)
    .first<Preparation>();
}
const guard = (db: D1Database, job: Preparation, progress = job.progress) =>
  db
    .prepare(`INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS (
  SELECT 1 FROM restore_preparations r JOIN moni_state s ON s.singleton=1 AND s.active_dataset=r.source_dataset
  WHERE r.id=? AND r.target_dataset=? AND r.target_dataset<>s.active_dataset AND r.digest=? AND r.status='loading' AND r.progress=? AND r.expires_at>unixepoch('subsec')*1000
)`)
    .bind(job.id, job.target_dataset, job.digest, progress);

export async function cleanRestoreStaging(
  db: D1Database,
  job: Pick<Preparation, 'id' | 'target_dataset'>
) {
  const safe =
    "?<>(SELECT active_dataset FROM moni_state WHERE singleton=1) AND EXISTS(SELECT 1 FROM restore_preparations WHERE id=? AND target_dataset=? AND status='cancelled')";
  await db.batch([
    ...[...backupSections]
      .reverse()
      .map((section) =>
        db
          .prepare(
            `DELETE FROM ${section.table} WHERE dataset_id=? AND ${safe}`
          )
          .bind(
            job.target_dataset,
            job.target_dataset,
            job.id,
            job.target_dataset
          )
      ),
    db
      .prepare(`DELETE FROM datasets WHERE id=? AND ${safe}`)
      .bind(job.target_dataset, job.target_dataset, job.id, job.target_dataset),
  ]);
}
async function expireStaging(db: D1Database) {
  const job = await db
    .prepare(
      "SELECT * FROM restore_preparations WHERE status IN ('loading','sealed','failed','cancelled') AND expires_at<=? AND target_dataset<>(SELECT active_dataset FROM moni_state WHERE singleton=1) AND EXISTS(SELECT 1 FROM datasets d WHERE d.id=target_dataset) ORDER BY expires_at LIMIT 1"
    )
    .bind(Date.now())
    .first<Preparation>();
  if (job) {
    await db
      .prepare(
        "UPDATE restore_preparations SET status='cancelled' WHERE id=? AND expires_at<=? AND target_dataset<>(SELECT active_dataset FROM moni_state WHERE singleton=1)"
      )
      .bind(job.id, Date.now())
      .run();
    await cleanRestoreStaging(db, job);
  }
}

export async function prepareRestore(
  db: D1Database,
  raw: unknown
): Promise<RestorePreview> {
  const parsed = prepareInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_restore');
  const input = parsed.data;
  const backup = validateBackup(input.backup);
  const digest = await hash(backup);
  const state = await db
    .prepare('SELECT active_dataset FROM moni_state WHERE singleton=1')
    .first<string>('active_dataset');
  if (state !== input.datasetId) throw new HttpError(409, 'dataset_changed');
  await expireStaging(db);
  let job = await readJob(db, input.operationId);
  const total = Object.values(backup.data).reduce(
    (sum, rows) => sum + rows.length,
    0
  );
  if (!job) {
    const { data: _, ...header } = backup;
    const target = crypto.randomUUID();
    const now = Date.now();
    try {
      await db.batch([
        db
          .prepare(
            'INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM moni_state WHERE singleton=1 AND active_dataset=?)'
          )
          .bind(input.datasetId),
        db
          .prepare(
            'INSERT INTO datasets(id,primary_currency,time_zone,initialized,currency_locked,version) VALUES (?,?,?,?,?,?)'
          )
          .bind(
            target,
            backup.settings.primaryCurrency,
            backup.settings.timeZone,
            Number(backup.settings.initialized),
            Number(backup.settings.currencyLocked),
            backup.settings.version
          ),
        db
          .prepare(
            "INSERT INTO restore_preparations(id,source_dataset,target_dataset,digest,status,total,header_json,summary_json,created_at,expires_at) VALUES (?,?,?,?,'loading',?,?,?,?,?)"
          )
          .bind(
            input.operationId,
            input.datasetId,
            target,
            digest,
            total,
            JSON.stringify(header),
            JSON.stringify(summaryOf(backup)),
            now,
            now + 24 * 60 * 60 * 1000
          ),
      ]);
    } catch {
      if (!(await readJob(db, input.operationId)))
        throw new HttpError(409, 'restore_changed');
    }
    job = await readJob(db, input.operationId);
  }
  if (!job || job.source_dataset !== input.datasetId || job.digest !== digest)
    throw new HttpError(409, 'restore_content_changed');
  if (
    job.expires_at <= Date.now() ||
    ['cancelled', 'failed', 'activated'].includes(job.status)
  )
    throw new HttpError(409, 'restore_closed');
  if (job.status === 'sealed') return view(job);
  const groups = backupSections.map((section) => ({
    section,
    rows: [...backup.data[section.name]] as Record<string, unknown>[],
  }));
  groups
    .find((group) => group.section.name === 'tags')
    ?.rows.sort(
      (a, b) => Number(Boolean(a.mergedInto)) - Number(Boolean(b.mergedInto))
    );
  const flat = groups.flatMap(({ section, rows }) =>
    rows.map((row) => ({ section, row }))
  );
  // Four bounded batches leave room for validation and cleanup within a Worker invocation.
  for (let batch = 0; batch < 4 && job.progress < flat.length; batch++) {
    const first = flat[job.progress];
    const rows: Record<string, unknown>[] = [];
    let size = 0;
    while (rows.length < 500 && job.progress + rows.length < flat.length) {
      const next = flat[job.progress + rows.length];
      const bytes = new TextEncoder().encode(JSON.stringify(next.row)).length;
      if (
        next.section !== first.section ||
        (rows.length && size + bytes > 48 * 1024)
      )
        break;
      rows.push(next.row);
      size += bytes;
    }
    const fields = Object.entries(first.section.fields);
    const columns = fields.map(([, column]) =>
      column.startsWith('json(') ? column.slice(5, -1) : column
    );
    const selection = fields.map(([key]) => `json_extract(value,'$.${key}')`);
    const progress = job.progress + rows.length;
    try {
      await db.batch([
        guard(db, job),
        db
          .prepare(
            `INSERT INTO ${first.section.table}(dataset_id,${columns.join(',')}) SELECT ?,${selection.join(',')} FROM json_each(?)`
          )
          .bind(job.target_dataset, JSON.stringify(rows)),
        db
          .prepare('UPDATE restore_preparations SET progress=? WHERE id=?')
          .bind(progress, job.id),
      ]);
    } catch {
      const concurrent = await readJob(db, job.id);
      if (concurrent?.status === 'sealed' && concurrent.digest === digest)
        return view(concurrent);
      if (
        !concurrent ||
        concurrent.status !== 'loading' ||
        concurrent.progress < progress
      )
        throw new HttpError(503, 'restore_prepare_failed');
    }
    const current = await readJob(db, job.id);
    if (current?.status === 'sealed' && current.digest === digest)
      return view(current);
    if (!current || current.status !== 'loading' || current.digest !== digest)
      throw new HttpError(409, 'restore_closed');
    job = current;
  }
  if (job.progress === total) {
    const captured = await db.batch<Record<string, unknown>>([
      db
        .prepare(
          'SELECT primary_currency AS primaryCurrency,time_zone AS timeZone,initialized,currency_locked AS currencyLocked,version FROM datasets WHERE id=?'
        )
        .bind(job.target_dataset),
      ...backupSelections(job.target_dataset).map(({ sql, values = [] }) =>
        db.prepare(sql).bind(...values)
      ),
    ]);
    let valid = false;
    try {
      const settings = captured[0].results[0];
      const staged = validateBackup({
        ...JSON.parse(job.header_json),
        settings: {
          ...settings,
          initialized: Boolean(settings.initialized),
          currencyLocked: Boolean(settings.currencyLocked),
        },
        data: Object.fromEntries(
          backupSections.map((section, index) => [
            section.name,
            captured[index + 1].results.map((row) =>
              JSON.parse(row.item as string)
            ),
          ])
        ),
      });
      valid = (await hash(staged)) === digest;
    } catch {
      /* Only an identical, completely validated dataset may be sealed. */
    }
    if (!valid) {
      await db
        .prepare(
          "UPDATE restore_preparations SET status='failed' WHERE id=? AND status='loading'"
        )
        .bind(job.id)
        .run();
      throw new HttpError(409, 'restore_staging_failed');
    }
    try {
      await db.batch([
        guard(db, job, total),
        db
          .prepare("UPDATE restore_preparations SET status='sealed' WHERE id=?")
          .bind(job.id),
      ]);
    } catch {
      const concurrent = await readJob(db, job.id);
      if (
        !concurrent ||
        concurrent.status !== 'sealed' ||
        concurrent.digest !== digest
      )
        throw new HttpError(409, 'restore_changed');
    }
    job = (await readJob(db, job.id)) ?? job;
  }
  return view(job);
}

export async function cancelRestore(db: D1Database, raw: unknown) {
  const parsed = cancelInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_restore');
  const input = parsed.data;
  const job = await readJob(db, input.id);
  if (!job || job.source_dataset !== input.datasetId)
    throw new HttpError(404, 'restore_not_found');
  await executeCommand(
    db,
    'cancel_restore',
    input,
    [
      db
        .prepare(
          "INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM restore_preparations WHERE id=? AND status<>'activated' AND target_dataset<>(SELECT active_dataset FROM moni_state WHERE singleton=1))"
        )
        .bind(job.id),
      db
        .prepare(
          "UPDATE restore_preparations SET status='cancelled' WHERE id=?"
        )
        .bind(job.id),
    ],
    { cancelled: true }
  );
  await cleanRestoreStaging(db, job);
  return { cancelled: true };
}
