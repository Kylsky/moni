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
import type { LedgerSettings } from '../../src/ledger/settings';
import { handlePrivateApi } from '../../src/worker';

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
        keys: [{ ...publicKey, kid: 'entry-fixture', alg: 'RS256' }],
      });
    throw new Error(
      'AI and external services unavailable in manual ledger tests'
    );
  });
});
afterAll(() => vi.unstubAllGlobals());

async function api(path: string, body?: unknown, method = 'POST') {
  const token = await new SignJWT({
    type: 'app',
    email: 'synthetic@example.invalid',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'entry-fixture' })
    .setIssuer(env.ACCESS_ISSUER)
    .setAudience(env.ACCESS_AUDIENCE)
    .setSubject(env.OWNER_SUBJECT)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
  return SELF.fetch(`https://moni.test/api/${path}`, {
    method: body === undefined ? 'GET' : method,
    headers: {
      'Cf-Access-Jwt-Assertion': token,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function input(overrides: Record<string, unknown> = {}) {
  return {
    datasetId,
    operationId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    kind: 'expense',
    name: 'Synthetic lunch',
    date: '2026-10-18',
    amount: '35.00',
    currency: 'CNY',
    categoryId: 'expense-food',
    tags: ['午餐', '外卖'],
    note: '在合成咖啡店吃的',
    ...overrides,
  };
}
async function entries() {
  return (await api('entries')).json<Entry[]>();
}
async function settings() {
  return (await api('settings')).json<LedgerSettings>();
}

beforeEach(async () => {
  datasetId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO datasets(id) VALUES (?)').bind(datasetId),
    env.DB.prepare(
      `INSERT INTO categories(dataset_id, id, kind, name) SELECT ?, id, kind, name FROM categories WHERE dataset_id = 'initial'`
    ).bind(datasetId),
    env.DB.prepare(
      'UPDATE moni_state SET active_dataset = ? WHERE singleton = 1'
    ).bind(datasetId),
  ]);
  const result = await api('initialize', {
    datasetId,
    operationId: crypto.randomUUID(),
    primaryCurrency: 'CNY',
    timeZone: 'Asia/Shanghai',
  });
  expect(result.status).toBe(200);
});

describe('manual ledger through the protected D1 API', () => {
  it('accepts the maximum safe amount and rejects an empty detail identifier', async () => {
    expect(
      (await api('entries', input({ amount: '90000000000.00' }))).status
    ).toBe(200);
    expect((await entries())[0]).toMatchObject({
      originalMinor: 9_000_000_000_000,
      baseMinor: 9_000_000_000_000,
    });
    expect((await api('entries?id=')).status).toBe(400);
  });
  it('saves manually with AI unconfigured and the conversation binding unavailable', async () => {
    const identity = await new SignJWT({
      type: 'app',
      email: 'synthetic@example.invalid',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'entry-fixture' })
      .setIssuer(env.ACCESS_ISSUER)
      .setAudience(env.ACCESS_AUDIENCE)
      .setSubject(env.OWNER_SUBJECT)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signingKey);
    const response = await handlePrivateApi(
      new Request('https://moni.test/api/entries', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Jwt-Assertion': identity,
        },
        body: JSON.stringify(input()),
      }),
      { ...env, AI_API_KEY: '', CONVERSATIONS: undefined as never }
    );
    expect(response.status).toBe(200);
    expect(await entries()).toHaveLength(1);
  });
  it('saves actual income/expense details, independent notes and deduplicated tags', async () => {
    const expense = input({
      note: '<b>肯德基</b> & 合成账目',
      tags: ['午餐', 'Lunch', 'lunch'],
    });
    expect((await api('entries', expense)).status).toBe(200);
    const income = input({
      kind: 'income',
      categoryId: 'income-salary',
      amount: '9000',
      name: 'Synthetic salary',
      note: '',
      tags: [],
    });
    expect((await api('entries', income)).status).toBe(200);
    const list = await entries();
    expect(list).toHaveLength(2);
    const saved = list.find((entry) => entry.id === expense.id);
    expect(saved).toMatchObject({
      originalMinor: 3500,
      baseMinor: 3500,
      currency: 'CNY',
      note: expense.note,
      categoryName: '饮食',
      version: 1,
    });
    expect(saved?.tags).toHaveLength(2);
    const detail = await (await api(`entries?id=${expense.id}`)).json<
      Entry[]
    >();
    expect(detail).toEqual([saved]);
  });

  it('atomically accepts one concurrent operation and allows two genuine identical expenses', async () => {
    const body = input();
    const results = await Promise.all([
      api('entries', body),
      api('entries', body),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(await entries()).toHaveLength(1);
    expect(
      (await api('entries', { ...body, note: 'different content' })).status
    ).toBe(409);
    expect(
      (
        await api('entries', {
          ...body,
          id: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
        })
      ).status
    ).toBe(200);
    expect(await entries()).toHaveLength(2);
  });

  it('rejects invalid types, precision, ranges, dates, categories and oversize notes before saving', async () => {
    for (const override of [
      { amount: 35 },
      { amount: '0' },
      { amount: '-1' },
      { amount: '1e2' },
      { amount: '35.001' },
      { amount: '90000000000.01' },
      { date: '2026-02-30' },
      { date: '2025-02-29' },
      { date: '1899-12-31' },
      { name: '' },
      { note: 'a'.repeat(2001) },
      { tags: Array(11).fill('x') },
      { currency: 'USD' },
      { kind: 'refund' },
      { modelSQL: 'DROP TABLE entries' },
    ])
      expect((await api('entries', input(override))).status).toBe(400);
    expect(
      (await api('entries', input({ categoryId: 'income-salary' }))).status
    ).toBe(409);
    expect(await entries()).toEqual([]);
    expect((await settings()).currencyLocked).toBe(false);
  });

  it('uses optimistic editing and can clear a note and remove all tags', async () => {
    const body = input();
    await api('entries', body);
    const attempts = await Promise.all(
      ['one', 'two'].map((note) =>
        api(
          'entries',
          { ...body, operationId: crypto.randomUUID(), version: 1, note },
          'PUT'
        )
      )
    );
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = (await entries())[0];
    expect(winner.version).toBe(2);
    expect(['one', 'two']).toContain(winner.note);
    expect(
      (
        await api(
          'entries',
          {
            ...body,
            operationId: crypto.randomUUID(),
            version: 2,
            note: '',
            tags: [],
            amount: '36.02',
          },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect((await entries())[0]).toMatchObject({
      originalMinor: 3602,
      baseMinor: 3602,
      note: '',
      tags: [],
      version: 3,
    });
  });

  it('locks primary currency after the first entry and never reinterprets its date on timezone changes', async () => {
    await api('entries', input({ date: '2024-02-29' }));
    const state = await settings();
    expect(state.currencyLocked).toBe(true);
    const body = {
      datasetId,
      operationId: crypto.randomUUID(),
      version: state.version,
      primaryCurrency: 'USD',
      timeZone: 'UTC',
    };
    expect((await api('settings', body, 'PUT')).status).toBe(409);
    expect(
      (
        await api(
          'settings',
          { ...body, operationId: crypto.randomUUID(), primaryCurrency: 'CNY' },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect((await entries())[0].date).toBe('2024-02-29');
  });

  it.each([
    { currency: 'JPY', amount: '35', minor: 35, invalid: '35.1' },
    { currency: 'KWD', amount: '1.005', minor: 1005, invalid: '1.0005' },
  ])('preserves $currency integer precision', async ({
    currency,
    amount,
    minor,
    invalid,
  }) => {
    const state = await settings();
    expect(
      (
        await api(
          'settings',
          {
            datasetId,
            operationId: crypto.randomUUID(),
            version: state.version,
            primaryCurrency: currency,
            timeZone: state.timeZone,
          },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect(
      (await api('entries', input({ currency, amount: invalid }))).status
    ).toBe(400);
    expect((await api('entries', input({ currency, amount }))).status).toBe(
      200
    );
    expect((await entries())[0]).toMatchObject({
      currency,
      originalMinor: minor,
      baseMinor: minor,
    });
  });

  it('defaults the date in the ledger timezone at a UTC day boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T17:00:00Z'));
    try {
      const body = input();
      delete (body as Partial<typeof body>).date;
      expect((await api('entries', body)).status).toBe(200);
      expect((await entries())[0].date).toBe('2026-10-18');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rolls back an entry, its tags and its receipt when a late D1 statement fails, then retries safely', async () => {
    await env.DB.prepare(`CREATE TRIGGER inject_entry_failure BEFORE INSERT ON entry_tags
      WHEN EXISTS (SELECT 1 FROM entries e WHERE e.dataset_id = NEW.dataset_id AND e.id = NEW.entry_id AND e.name = 'synthetic-failure')
      BEGIN SELECT RAISE(ABORT, 'synthetic fault'); END;`).run();
    const body = input({ name: 'synthetic-failure', tags: ['atomic-only'] });
    try {
      expect((await api('entries', body)).status).toBe(409);
      expect(await entries()).toEqual([]);
      expect((await settings()).currencyLocked).toBe(false);
      const receipt = await env.DB.prepare(
        'SELECT operation_id FROM operation_receipts WHERE dataset_id = ? AND operation_id = ?'
      )
        .bind(datasetId, body.operationId)
        .first();
      expect(receipt).toBeNull();
      const tag = await env.DB.prepare(
        'SELECT id FROM tags WHERE dataset_id = ? AND name = ?'
      )
        .bind(datasetId, 'atomic-only')
        .first();
      expect(tag).toBeNull();
    } finally {
      await env.DB.exec('DROP TRIGGER inject_entry_failure');
    }
    expect((await api('entries', body)).status).toBe(200);
    expect(await entries()).toHaveLength(1);
  });

  it('rejects an old dataset request without exposing or mutating its entries', async () => {
    const body = input();
    await api('entries', body);
    await env.DB.prepare(
      "UPDATE moni_state SET active_dataset = 'initial' WHERE singleton = 1"
    ).run();
    expect(
      (
        await api(
          'entries',
          { ...body, operationId: crypto.randomUUID(), version: 1 },
          'PUT'
        )
      ).status
    ).toBe(409);
    expect((await api(`entries?id=${body.id}`)).status).toBe(404);
    expect(await entries()).toEqual([]);
  });
});
