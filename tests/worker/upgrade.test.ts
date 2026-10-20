import { applyD1Migrations, env } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('upgrades a populated pre-conversion ledger without losing active/trash entries, tags, notes or merge aliases', async () => {
  const before = env.TEST_MIGRATIONS.filter(
    (migration) => migration.name < '0006_fixed_conversion.sql'
  );
  const next = env.TEST_MIGRATIONS.filter(
    (migration) => migration.name === '0006_fixed_conversion.sql'
  );
  expect(next).toHaveLength(1);
  await applyD1Migrations(env.DB_UPGRADE, before);
  await env.DB_UPGRADE.batch([
    env.DB_UPGRADE.prepare(
      "INSERT INTO tags(dataset_id,id,name,normalized_name) VALUES ('initial','target','合成午餐','合成午餐')"
    ),
    env.DB_UPGRADE.prepare(
      "INSERT INTO tags(dataset_id,id,name,normalized_name,merged_into) VALUES ('initial','source','合成午饭','合成午饭','target')"
    ),
    env.DB_UPGRADE.prepare(
      "INSERT INTO entries(dataset_id,id,kind,name,entry_date,currency,original_minor,base_minor,category_id,note,created_at,updated_at) VALUES ('initial','entry','expense','合成午餐','2026-10-18','CNY',3500,3500,'expense-food','保留合成备注',1,1)"
    ),
    env.DB_UPGRADE.prepare(
      "INSERT INTO entries(dataset_id,id,kind,name,entry_date,currency,original_minor,base_minor,category_id,note,created_at,updated_at,deleted_at) VALUES ('initial','trashed','expense','合成误删','2026-10-18','CNY',1200,1200,'expense-food','保留回收站备注',1,1,2)"
    ),
    env.DB_UPGRADE.prepare(
      "INSERT INTO entry_tags(dataset_id,entry_id,tag_id) VALUES ('initial','entry','target')"
    ),
  ]);
  await applyD1Migrations(env.DB_UPGRADE, next);
  const row = await env.DB_UPGRADE.prepare(
    "SELECT * FROM entries WHERE id='entry'"
  ).first();
  expect(row).toMatchObject({
    base_minor: 3500,
    note: '保留合成备注',
    conversion_json: null,
  });
  expect(
    await env.DB_UPGRADE.prepare(
      "SELECT note FROM entries WHERE id='trashed' AND deleted_at=2"
    ).first('note')
  ).toBe('保留回收站备注');
  expect(
    await env.DB_UPGRADE.prepare(
      'SELECT count(*) AS count FROM entry_tags'
    ).first('count')
  ).toBe(1);
  expect(
    await env.DB_UPGRADE.prepare(
      "SELECT merged_into FROM tags WHERE id='source'"
    ).first('merged_into')
  ).toBe('target');
  expect(
    (await env.DB_UPGRADE.prepare('PRAGMA foreign_key_check').all()).results
  ).toEqual([]);
  await expect(
    env.DB_UPGRADE.prepare(
      "INSERT INTO entry_tags(dataset_id,entry_id,tag_id) VALUES ('initial','trashed','source')"
    ).run()
  ).rejects.toThrow();
  await applyD1Migrations(
    env.DB_UPGRADE,
    env.TEST_MIGRATIONS.filter(
      (migration) => migration.name >= '0007' && migration.name < '0009'
    )
  );
  for (const [id, amount, deleted] of [
    ['refund-active', 1000, null],
    ['refund-trash', 500, 2],
  ] as const) {
    await env.DB_UPGRADE.prepare(`INSERT INTO entries(dataset_id,id,kind,name,entry_date,currency,original_minor,base_minor,category_id,note,created_at,updated_at,deleted_at)
      VALUES ('initial',?,'refund','合成历史退款','2026-10-18','CNY',?,?,'expense-food','保留历史退款备注',1,1,?)`)
      .bind(id, amount, amount, deleted)
      .run();
    await env.DB_UPGRADE.prepare(
      "INSERT INTO refund_links(dataset_id,refund_id,expense_id) VALUES ('initial',?,'entry')"
    )
      .bind(id)
      .run();
  }
  await applyD1Migrations(
    env.DB_UPGRADE,
    env.TEST_MIGRATIONS.filter(
      (migration) => migration.name === '0009_refund_allocation.sql'
    )
  );
  expect(
    (
      await env.DB_UPGRADE.prepare(
        "SELECT refund_id,default_base_minor,actual_override FROM refund_links WHERE dataset_id='initial' ORDER BY refund_id"
      ).all()
    ).results
  ).toEqual([
    {
      refund_id: 'refund-active',
      default_base_minor: 1000,
      actual_override: 0,
    },
    { refund_id: 'refund-trash', default_base_minor: 500, actual_override: 0 },
  ]);
  expect(
    await env.DB_UPGRADE.prepare(
      "SELECT default_minor FROM refund_allocations WHERE dataset_id='initial' AND expense_id='entry'"
    ).first('default_minor')
  ).toBe(1000);
  expect(
    await env.DB_UPGRADE.prepare(
      "SELECT note FROM entries WHERE id='refund-trash' AND deleted_at=2"
    ).first('note')
  ).toBe('保留历史退款备注');
  expect(
    (await env.DB_UPGRADE.prepare('PRAGMA foreign_key_check').all()).results
  ).toEqual([]);
});
