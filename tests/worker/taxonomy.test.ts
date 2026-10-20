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
import type { Entry } from '../../src/ledger/entries';
import type { LedgerTag, Taxonomy } from '../../src/ledger/taxonomy';

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
const catalog = async () => (await api('taxonomy')).json<Taxonomy>();
const entries = async () => (await api('entries')).json<Entry[]>();
async function tag(name: string) {
  const id = crypto.randomUUID();
  expect((await api('tags', { ...command(), id, name })).status).toBe(200);
  return id;
}
async function expense(tags: string[], categoryId = 'expense-food') {
  const id = crypto.randomUUID();
  expect(
    (
      await api('entries', {
        ...command(),
        id,
        kind: 'expense',
        name: '合成账目',
        amount: '35',
        currency: 'CNY',
        categoryId,
        tags,
        note: '独立备注保留',
      })
    ).status
  ).toBe(200);
  return id;
}
function mergeBody(tags: LedgerTag[], sourceIds: string[], targetId: string) {
  const version = (id: string) => ({
    id,
    version: tags.find((item) => item.id === id)?.version ?? 1,
  });
  return {
    ...command(),
    sources: sourceIds.map(version),
    target: version(targetId),
  };
}
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

describe('protected category and canonical tag operations', () => {
  it('keeps income/expense categories separate and renames references without changing money or notes', async () => {
    const id = crypto.randomUUID();
    const create = { ...command(), id, kind: 'expense', name: '数码' };
    expect((await api('categories', create)).status).toBe(200);
    expect((await api('categories', create)).status).toBe(200);
    await expense([], id);
    const rename = { ...command(), id, version: 1, name: '设备' };
    expect((await api('categories', rename, 'PUT')).status).toBe(200);
    expect((await api('categories', rename, 'PUT')).status).toBe(200);
    expect(
      (await catalog()).categories.find((item) => item.id === id)
    ).toMatchObject({
      name: '设备',
      version: 2,
      kind: 'expense',
      defaultKey: null,
    });
    expect((await entries())[0]).toMatchObject({
      categoryId: id,
      categoryName: '设备',
      originalMinor: 3500,
      note: '独立备注保留',
    });
    expect(
      (await api('categories', { ...rename, name: 'changed content' }, 'PUT'))
        .status
    ).toBe(409);
    expect(
      (
        await api(
          'categories',
          { ...command(), id, version: 1, name: 'stale' },
          'PUT'
        )
      ).status
    ).toBe(409);
    const income = {
      ...command(),
      id: crypto.randomUUID(),
      kind: 'income',
      name: '设备',
    };
    expect((await api('categories', income)).status).toBe(200);
    const invalidEntry = await api('entries', {
      ...command(),
      id: crypto.randomUUID(),
      kind: 'expense',
      name: 'wrong category kind',
      amount: '1',
      categoryId: income.id,
    });
    expect(invalidEntry.status).toBe(409);
  });

  it('turns an explicitly renamed default category into untranslated user data', async () => {
    expect(
      (
        await api(
          'categories',
          { ...command(), id: 'expense-food', version: 1, name: 'My Meals' },
          'PUT'
        )
      ).status
    ).toBe(200);
    const renamed = (await catalog()).categories.find(
      (item) => item.id === 'expense-food'
    );
    expect(renamed).toMatchObject({
      name: 'My Meals',
      defaultKey: null,
      kind: 'expense',
    });
    await expense([]);
    expect((await entries())[0]).toMatchObject({
      categoryName: 'My Meals',
      categoryKey: null,
    });
  });

  it('merges overlapping tags once and resolves old labels without resurrecting them', async () => {
    const a = await tag('午饭');
    const b = await tag('Lunch');
    const c = await tag('午餐');
    await expense(['午饭', '午餐']);
    await expense(['Lunch']);
    await expense(['午饭', 'Lunch']);
    const body = mergeBody((await catalog()).tags, [a, b], c);
    expect((await api('tags/merge', body)).status).toBe(200);
    expect((await api('tags/merge', body)).status).toBe(200);
    const after = await catalog();
    expect(after.tags).toEqual([
      { id: c, name: '午餐', version: 2, entryCount: 3 },
    ]);
    for (const record of await entries()) {
      expect(record.tags).toEqual([{ id: c, name: '午餐' }]);
      expect(record.originalMinor).toBe(3500);
      expect(record.note).toBe('独立备注保留');
    }
    await expense(['午饭', 'Lunch', '午餐']);
    expect((await catalog()).tags[0].entryCount).toBe(4);
    expect((await entries())[0].tags).toHaveLength(1);
    expect(
      (await api('tags/merge', { ...body, operationId: crypto.randomUUID() }))
        .status
    ).toBe(409);
  });

  it('flattens prior aliases when their target is merged again', async () => {
    const a = await tag('a');
    const b = await tag('b');
    const c = await tag('c');
    await expense(['a']);
    expect(
      (await api('tags/merge', mergeBody((await catalog()).tags, [a], b)))
        .status
    ).toBe(200);
    expect(
      (await api('tags/merge', mergeBody((await catalog()).tags, [b], c)))
        .status
    ).toBe(200);
    await expense(['a', 'b', 'c']);
    expect((await catalog()).tags).toEqual([
      { id: c, name: 'c', version: 2, entryCount: 2 },
    ]);
    expect(
      (await entries()).every(
        (record) => record.tags.length === 1 && record.tags[0].id === c
      )
    ).toBe(true);
  });

  it('rolls back late merge failures and permits only one concurrent source merge', async () => {
    const a = await tag('synthetic-fail');
    const b = await tag('b');
    const c = await tag('c');
    await expense(['synthetic-fail', 'b']);
    const before = await catalog();
    const body = mergeBody(before.tags, [a], b);
    await env.DB.prepare(`CREATE TRIGGER inject_merge_failure BEFORE UPDATE OF merged_into ON tags
      WHEN NEW.name = 'synthetic-fail' AND NEW.merged_into IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'synthetic fault'); END;`).run();
    try {
      expect((await api('tags/merge', body)).status).toBe(409);
      expect(await catalog()).toEqual(before);
      expect((await entries())[0].tags).toHaveLength(2);
    } finally {
      await env.DB.exec('DROP TRIGGER inject_merge_failure');
    }
    const attempts = await Promise.all([
      api('tags/merge', body),
      api('tags/merge', mergeBody(before.tags, [a], c)),
    ]);
    expect(attempts.map((result) => result.status).sort()).toEqual([200, 409]);
    const record = (await entries())[0];
    expect(record.tags.some((item) => item.id === a)).toBe(false);
    expect((await catalog()).tags).toHaveLength(2);
    expect(record.originalMinor).toBe(3500);
  });

  it('rejects invalid names, duplicate merges, stale and foreign scope before changing links', async () => {
    for (const name of ['', ' ', 'a'.repeat(31)])
      expect(
        (await api('tags', { ...command(), id: crypto.randomUUID(), name }))
          .status
      ).toBe(400);
    expect(
      (
        await api('categories', {
          ...command(),
          id: crypto.randomUUID(),
          kind: 'refund',
          name: 'invalid',
        })
      ).status
    ).toBe(400);
    const a = await tag('Lunch');
    const b = await tag('other');
    expect(
      (
        await api('tags', {
          ...command(),
          id: crypto.randomUUID(),
          name: 'lunch',
        })
      ).status
    ).toBe(409);
    const body = mergeBody((await catalog()).tags, [a], b);
    expect(
      (await api('tags/merge', { ...body, sources: [body.target] })).status
    ).toBe(400);
    expect(
      (
        await api('tags/merge', {
          ...body,
          sources: [body.sources[0], body.sources[0]],
        })
      ).status
    ).toBe(400);
    expect(
      (await api('tags/merge', { ...body, datasetId: 'old' })).status
    ).toBe(409);
    expect(
      (await api('tags/merge', { ...body, target: { id: b, version: 2 } }))
        .status
    ).toBe(409);
    expect((await catalog()).tags).toHaveLength(2);
    for (const path of ['taxonomy', 'categories', 'tags', 'tags/merge'])
      expect((await SELF.fetch(`https://moni.test/api/${path}`)).status).toBe(
        401
      );
  });
});
