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

async function create(
  name: string,
  date: string,
  tags: string[] = [],
  note = ''
) {
  const id = crypto.randomUUID();
  expect(
    (
      await api('entries', {
        ...command(),
        id,
        name,
        date,
        tags,
        note,
        amount: '35',
        kind: 'expense',
        categoryId: 'expense-food',
      })
    ).status
  ).toBe(200);
  return id;
}
const query = async (filters: unknown = {}) =>
  (await api('entries/query', filters)).json<EntryPage>();

describe('shared protected entry queries', () => {
  it('combines inclusive dates, kind, category, original currency, any tags and current note text without duplicating entries', async () => {
    const id = await create(
      '午餐',
      '2026-10-18',
      ['午餐', '外卖'],
      '在肯德基吃的'
    );
    await create('早餐', '2026-10-17', ['外卖'], '其他商家');
    await create('午餐', '2026-09-30', ['午餐'], '在肯德基吃的');
    const tags =
      (await query()).items.find((item) => item.id === id)?.tags ?? [];
    const filters = {
      from: '2026-10-18',
      to: '2026-10-18',
      kind: 'expense',
      currency: 'CNY',
      categoryId: 'expense-food',
      tagIds: tags.map((tag) => tag.id),
      keyword: '肯德基',
    };
    const result = await query(filters);
    expect(result.total).toBe(1);
    expect(result.items.map((item) => item.id)).toEqual([id]);
    expect(result.filters).toMatchObject(filters);
    expect(result.datasetId).toBe(datasetId);
    const entry = result.items[0];
    expect(
      (
        await api(
          'entries',
          {
            ...command(),
            id,
            version: entry.version,
            name: '午餐',
            date: entry.date,
            tags: ['午餐', '外卖'],
            amount: '35',
            kind: 'expense',
            note: '改为其他地方',
          },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect((await query(filters)).total).toBe(0);
    expect((await query({ keyword: '其他地方' })).items[0].id).toBe(id);
    expect(
      (
        await api(
          'entries',
          {
            ...command(),
            id,
            version: 2,
            name: '午餐',
            date: entry.date,
            amount: '35',
            kind: 'expense',
            note: '',
          },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect((await query({ keyword: '其他地方' })).total).toBe(0);
  });

  it('matches percent, underscore, quotes and SQL-looking text literally in names or notes', async () => {
    const id = await create(
      '100%_off',
      '2026-10-18',
      [],
      "' OR 1=1 -- synthetic"
    );
    await create('1000abc', '2026-10-18');
    for (const keyword of ['%_', "' OR 1=1 --", 'OFF']) {
      const result = await query({ keyword });
      expect(result.total).toBe(1);
      expect(result.items[0].id).toBe(id);
    }
    expect((await query({ keyword: '不存在' })).items).toEqual([]);
  });

  it('uses deterministic date and id ordering with bounded pages and exposes coherent dataset revision/counts', async () => {
    const ids = [];
    for (let index = 0; index < 7; index++)
      ids.push(
        await create(`合成${index}`, index < 4 ? '2026-10-18' : '2026-10-17')
      );
    const first = await query({ pageSize: 3 });
    const second = await query({ pageSize: 3, page: 2 });
    const last = await query({ pageSize: 3, page: 3 });
    expect([
      first.total,
      first.pageCount,
      first.items.length,
      last.items.length,
    ]).toEqual([7, 3, 3, 1]);
    const expected = [
      ...ids.slice(0, 4).sort().reverse(),
      ...ids.slice(4).sort().reverse(),
    ];
    expect(
      [...first.items, ...second.items, ...last.items].map((item) => item.id)
    ).toEqual(expected);
    expect(first.revision).toBe(second.revision);
    expect((await query({ page: 4, pageSize: 3 })).items).toEqual([]);
    expect((await api(`entries?id=${expected[6]}`)).status).toBe(200);
  });

  it('resolves merged tag ids and excludes deleted records and other datasets', async () => {
    const id = await create('合成 A', '2026-10-18', ['午餐', '午饭']);
    const deleted = await create('删除夹具', '2026-10-18', ['午饭']);
    await env.DB.prepare(
      'UPDATE entries SET deleted_at = ? WHERE dataset_id = ? AND id = ?'
    )
      .bind(Date.now(), datasetId, deleted)
      .run();
    const catalog = await (await api('taxonomy')).json<{
      tags: { id: string; name: string; version: number }[];
    }>();
    const source = catalog.tags.find((tag) => tag.name === '午饭');
    const target = catalog.tags.find((tag) => tag.name === '午餐');
    if (!source || !target) throw new Error('Missing synthetic tags');
    expect(
      (
        await api('tags/merge', {
          ...command(),
          sources: [{ id: source.id, version: source.version }],
          target: { id: target.id, version: target.version },
        })
      ).status
    ).toBe(200);
    expect(
      (await query({ tagIds: [source.id, target.id] })).items.map(
        (item) => item.id
      )
    ).toEqual([id]);
    const other = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO datasets(id) VALUES (?)')
      .bind(other)
      .run();
    await env.DB.prepare(
      'UPDATE moni_state SET active_dataset = ? WHERE singleton = 1'
    )
      .bind(other)
      .run();
    expect((await query()).items).toEqual([]);
    expect((await api(`entries?id=${id}`)).status).toBe(404);
  });

  it('rejects malformed, oversized and executable conditions at the protected boundary', async () => {
    for (const filters of [
      { from: '2026-02-30' },
      { from: '2026-10-19', to: '2026-10-18' },
      { page: 0 },
      { page: 1.5 },
      { pageSize: 101 },
      { keyword: 'x'.repeat(201) },
      { tagIds: ['invalid'] },
      { currency: 'XYZ' },
      { kind: 'transfer' },
      { sql: 'select * from entries' },
      { datasetId: 'other' },
    ])
      expect((await api('entries/query', filters)).status).toBe(400);
    expect(
      (
        await SELF.fetch('https://moni.test/api/entries/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status
    ).toBe(401);
    const empty = await query({ kind: 'income' });
    expect(empty.total).toBe(0);
    expect(empty.pageCount).toBe(0);
  });
});
