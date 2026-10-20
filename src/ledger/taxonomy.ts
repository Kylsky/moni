import { z } from 'zod';
import { assertChanged, commandIdentity, executeCommand } from '../lib/command';
import { HttpError } from '../lib/http';

export const tagName = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .transform((value) => value.normalize('NFC'));
const categoryName = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .transform((value) => value.normalize('NFC'));
export type Category = {
  id: string;
  kind: 'income' | 'expense';
  name: string;
  defaultKey: string | null;
  version: number;
};
export type LedgerTag = {
  id: string;
  name: string;
  version: number;
  entryCount: number;
};
export type Taxonomy = {
  datasetId: string;
  categories: Category[];
  tags: LedgerTag[];
};

const categorySQL = `SELECT c.id, c.kind, c.name, c.default_key AS defaultKey, c.version FROM categories c JOIN moni_state s
  ON s.singleton = 1 AND s.active_dataset = c.dataset_id ORDER BY c.kind, c.rowid`;
const tagSQL = `SELECT t.id, t.name, t.version,
  (SELECT count(*) FROM entries e LEFT JOIN refund_links l ON l.dataset_id = e.dataset_id AND l.refund_id = e.id
    JOIN entry_tags et ON et.dataset_id = e.dataset_id AND et.entry_id = coalesce(l.expense_id,e.id)
    WHERE et.dataset_id = t.dataset_id AND et.tag_id = t.id) AS entryCount
  FROM tags t JOIN moni_state s ON s.singleton = 1 AND s.active_dataset = t.dataset_id
  WHERE t.merged_into IS NULL ORDER BY t.rowid`;

export async function readCategories(db: D1Database) {
  return (await db.prepare(categorySQL).all<Category>()).results;
}

export async function readTaxonomy(db: D1Database): Promise<Taxonomy> {
  const [state, categories, tags] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT active_dataset FROM moni_state WHERE singleton = 1'),
    db.prepare(categorySQL),
    db.prepare(tagSQL),
  ]);
  if (!state.results.length) throw new HttpError(503, 'storage_not_ready');
  return {
    datasetId: state.results[0].active_dataset as string,
    categories: categories.results as Category[],
    tags: tags.results as LedgerTag[],
  };
}

const createCategory = z
  .object({
    ...commandIdentity,
    id: z.uuid(),
    kind: z.enum(['expense', 'income']),
    name: categoryName,
  })
  .strict();
const renameCategory = z
  .object({
    ...commandIdentity,
    id: z.string().min(1).max(100),
    version: z.number().int().positive(),
    name: categoryName,
  })
  .strict();
const createTag = z
  .object({ ...commandIdentity, id: z.uuid(), name: tagName })
  .strict();
const tagVersion = z
  .object({ id: z.uuid(), version: z.number().int().positive() })
  .strict();
const mergeTags = z
  .object({
    ...commandIdentity,
    sources: z.array(tagVersion).min(1).max(20),
    target: tagVersion,
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.sources.map((source) => source.id)).size ===
        input.sources.length &&
      input.sources.every((source) => source.id !== input.target.id)
  );

function initialized(db: D1Database, dataset: string) {
  return db
    .prepare(`INSERT INTO invariant_assertions(valid) SELECT 0 WHERE NOT EXISTS (
    SELECT 1 FROM datasets WHERE id = ? AND initialized = 1
  )`)
    .bind(dataset);
}

export async function saveCategory(
  db: D1Database,
  raw: unknown,
  rename: boolean
) {
  const parsed = (rename ? renameCategory : createCategory).safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_category');
  const input = parsed.data;
  const statement =
    'kind' in input
      ? db
          .prepare(
            'INSERT INTO categories(dataset_id, id, kind, name) VALUES (?, ?, ?, ?)'
          )
          .bind(input.datasetId, input.id, input.kind, input.name)
      : db
          .prepare(`UPDATE categories SET default_key = CASE WHEN name = ? THEN default_key ELSE NULL END,
      name = ?, version = version + 1 WHERE dataset_id = ? AND id = ? AND version = ?`)
          .bind(
            input.name,
            input.name,
            input.datasetId,
            input.id,
            input.version
          );
  return executeCommand(
    db,
    rename ? 'rename_category' : 'create_category',
    input,
    [initialized(db, input.datasetId), statement, assertChanged(db)],
    { categoryId: input.id }
  );
}

export async function addTag(db: D1Database, raw: unknown) {
  const parsed = createTag.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_tag');
  const input = parsed.data;
  return executeCommand(
    db,
    'create_tag',
    input,
    [
      initialized(db, input.datasetId),
      db
        .prepare(
          'INSERT INTO tags(dataset_id, id, name, normalized_name) VALUES (?, ?, ?, ?)'
        )
        .bind(input.datasetId, input.id, input.name, input.name.toLowerCase()),
    ],
    { tagId: input.id }
  );
}

export async function mergeTagRecords(db: D1Database, raw: unknown) {
  const parsed = mergeTags.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_tag_merge');
  const input = parsed.data;
  const ids = input.sources.map((source) => source.id);
  const placeholders = ids.map(() => '?').join(',');
  const statements = [
    initialized(db, input.datasetId),
    ...[input.target, ...input.sources].map((tag) =>
      db
        .prepare(`INSERT INTO invariant_assertions(valid)
      SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM tags WHERE dataset_id = ? AND id = ? AND version = ? AND merged_into IS NULL)`)
        .bind(input.datasetId, tag.id, tag.version)
    ),
    db
      .prepare(`INSERT OR IGNORE INTO entry_tags(dataset_id, entry_id, tag_id) SELECT dataset_id, entry_id, ?
      FROM entry_tags WHERE dataset_id = ? AND tag_id IN (${placeholders})`)
      .bind(input.target.id, input.datasetId, ...ids),
    db
      .prepare(
        `DELETE FROM entry_tags WHERE dataset_id = ? AND tag_id IN (${placeholders})`
      )
      .bind(input.datasetId, ...ids),
    db
      .prepare(
        `UPDATE tags SET merged_into = ?, version = version + 1 WHERE dataset_id = ? AND merged_into IN (${placeholders})`
      )
      .bind(input.target.id, input.datasetId, ...ids),
    db
      .prepare(
        `UPDATE tags SET merged_into = ?, version = version + 1 WHERE dataset_id = ? AND id IN (${placeholders})`
      )
      .bind(input.target.id, input.datasetId, ...ids),
    db
      .prepare(
        'UPDATE tags SET version = version + 1 WHERE dataset_id = ? AND id = ?'
      )
      .bind(input.datasetId, input.target.id),
  ];
  return executeCommand(db, 'merge_tags', input, statements, {
    targetId: input.target.id,
  });
}
