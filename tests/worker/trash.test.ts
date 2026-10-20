import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { EntryPage } from '../../src/ledger/entry-query';

let signingKey: CryptoKey;
let datasetId: string;
beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  signingKey = keys.privateKey;
  const publicKey = await exportJWK(keys.publicKey);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    if (
      String(input instanceof Request ? input.url : input) ===
      `${env.ACCESS_ISSUER}/cdn-cgi/access/certs`
    )
      return Response.json({
        keys: [{ ...publicKey, kid: 'taxonomy-fixture', alg: 'RS256' }],
      });
    throw new Error('External services disabled in taxonomy tests');
  });
});
afterAll(() => vi.unstubAllGlobals());
async function api(path: string, body?: unknown, method = 'POST') {
  const identity = await new SignJWT({
    type: 'app',
    email: 'synthetic@example.invalid',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'taxonomy-fixture' })
    .setIssuer(env.ACCESS_ISSUER)
    .setAudience(env.ACCESS_AUDIENCE)
    .setSubject(env.OWNER_SUBJECT)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
  return SELF.fetch(`https://moni.test/api/${path}`, {
    method: body === undefined ? 'GET' : method,
    headers: {
      'Cf-Access-Jwt-Assertion': identity,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const command = () => ({ datasetId, operationId: crypto.randomUUID() });
beforeEach(async () => {
  datasetId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO datasets(id) VALUES (?)').bind(datasetId),
    env.DB.prepare(
      "INSERT INTO categories(dataset_id, id, kind, name, default_key) SELECT ?, id, kind, name, default_key FROM categories WHERE dataset_id = 'initial'"
    ).bind(datasetId),
    env.DB.prepare(
      'UPDATE moni_state SET active_dataset = ? WHERE singleton = 1'
    ).bind(datasetId),
  ]);
  expect(
    (
      await api('initialize', {
        ...command(),
        primaryCurrency: 'CNY',
        timeZone: 'Asia/Shanghai',
      })
    ).status
  ).toBe(200);
});

async function create() {
  const id = crypto.randomUUID();
  expect(
    (
      await api('entries', {
        ...command(),
        id,
        kind: 'expense',
        name: '合成午餐',
        amount: '35',
        categoryId: 'expense-food',
        tags: ['午餐', '外卖'],
        note: '在肯德基吃的（合成数据）',
      })
    ).status
  ).toBe(200);
  return id;
}
const active = async () => (await api('entries/query', {})).json<EntryPage>();
const trash = async () => (await api('trash/query', {})).json<EntryPage>();
const action = (id: string, version: number) => ({
  ...command(),
  id,
  version,
  confirmed: true,
});

describe('protected trash transitions', () => {
  it('requires confirmation, excludes deleted entries, restores exact business data and replays safely', async () => {
    const id = await create();
    const original = (await active()).items[0];
    expect(
      (await api('entries/delete', { ...command(), id, version: 1 })).status
    ).toBe(400);
    const deletion = action(id, 1);
    expect((await api('entries/delete', deletion)).status).toBe(200);
    expect((await api('entries/delete', deletion)).status).toBe(200);
    expect((await active()).total).toBe(0);
    expect((await api(`entries?id=${id}`)).status).toBe(404);
    expect((await active()).totals.expense).toBe(0);
    const removed = (await trash()).items[0];
    expect(removed).toMatchObject({
      ...original,
      version: 2,
      deletedAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    const restoration = action(id, 2);
    expect((await api('entries/restore', restoration)).status).toBe(200);
    expect((await api('entries/restore', restoration)).status).toBe(200);
    expect((await active()).totals.expense).toBe(3500);
    const restored = (await active()).items[0];
    expect(restored).toMatchObject({
      ...original,
      version: 3,
      updatedAt: expect.any(Number),
    });
    expect((await trash()).items).toEqual([]);
    expect((await api('entries/delete', deletion)).status).toBe(200);
    expect((await active()).items[0].version).toBe(3);
  });

  it('purges only trashed versions, cascades tag links, and does not claim success after a database fault', async () => {
    const id = await create();
    expect((await api('entries/purge', action(id, 1))).status).toBe(409);
    expect((await api('entries/delete', action(id, 1))).status).toBe(200);
    const purge = action(id, 2);
    await env.DB.prepare(
      "CREATE TRIGGER fail_purge BEFORE DELETE ON entries WHEN OLD.id = '" +
        id +
        "' BEGIN SELECT RAISE(ABORT,'synthetic fault'); END"
    ).run();
    expect((await api('entries/purge', purge)).status).toBe(409);
    expect((await trash()).total).toBe(1);
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS count FROM entry_tags WHERE dataset_id = ? AND entry_id = ?'
      )
        .bind(datasetId, id)
        .first('count')
    ).toBe(2);
    await env.DB.prepare('DROP TRIGGER fail_purge').run();
    expect((await api('entries/purge', purge)).status).toBe(200);
    expect((await api('entries/purge', purge)).status).toBe(200);
    expect((await trash()).total).toBe(0);
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS count FROM entry_tags WHERE dataset_id = ? AND entry_id = ?'
      )
        .bind(datasetId, id)
        .first('count')
    ).toBe(0);
    expect((await api('entries/restore', action(id, 2))).status).toBe(409);
  });

  it('allows one winner when edit and delete race, and rejects stale restore and deletion commands', async () => {
    const id = await create();
    const deletion = api('entries/delete', action(id, 1));
    const edit = api(
      'entries',
      {
        ...command(),
        id,
        version: 1,
        kind: 'expense',
        name: '合成修改',
        amount: '36',
        note: '新的合成备注',
      },
      'PUT'
    );
    const responses = await Promise.all([deletion, edit]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const combined = [...(await active()).items, ...(await trash()).items];
    expect(combined).toHaveLength(1);
    expect(combined[0].version).toBe(2);
    const row = combined[0];
    if (!row.deletedAt)
      expect((await api('entries/delete', action(id, 2))).status).toBe(200);
    const removed = (await trash()).items[0];
    const results = await Promise.all([
      api('entries/restore', action(id, removed.version)),
      api('entries/purge', action(id, removed.version)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await api('entries/delete', action(id, 1))).status).toBe(409);
  });

  it('preserves canonical tags while trashed, and protects other datasets and unauthorized requests', async () => {
    const id = await create();
    expect((await api('entries/delete', action(id, 1))).status).toBe(200);
    const tags = (await trash()).items[0].tags;
    expect(
      (
        await api('tags/merge', {
          ...command(),
          sources: [{ id: tags[0].id, version: 1 }],
          target: { id: tags[1].id, version: 1 },
        })
      ).status
    ).toBe(200);
    expect((await api('entries/restore', action(id, 2))).status).toBe(200);
    expect((await active()).items[0].tags).toHaveLength(1);
    const other = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO datasets(id) VALUES (?)')
      .bind(other)
      .run();
    await env.DB.prepare(
      'UPDATE moni_state SET active_dataset = ? WHERE singleton = 1'
    )
      .bind(other)
      .run();
    expect((await api('entries/delete', action(id, 3))).status).toBe(409);
    expect((await trash()).total).toBe(0);
    for (const endpoint of [
      'entries/delete',
      'entries/restore',
      'entries/purge',
      'trash/query',
    ])
      expect(
        (
          await SELF.fetch(`https://moni.test/api/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).status
      ).toBe(401);
  });
});
