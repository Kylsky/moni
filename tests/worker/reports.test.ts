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
import { resolveDatePeriod, trendEnd } from '../../src/ledger/dates';
import type { EntryPage } from '../../src/ledger/entry-query';
import type { Report } from '../../src/ledger/reports';

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
        keys: [{ ...publicKey, kid: 'reports-fixture', alg: 'RS256' }],
      });
    throw new Error('External services disabled in reports tests');
  });
});
afterAll(() => vi.unstubAllGlobals());
async function api(path: string, body?: unknown, method = 'POST') {
  const token = await new SignJWT({
    type: 'app',
    email: 'synthetic@example.invalid',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'reports-fixture' })
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
const command = () => ({ datasetId, operationId: crypto.randomUUID() });
beforeEach(async () => {
  datasetId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO datasets(id) VALUES (?)').bind(datasetId),
    env.DB.prepare(
      "INSERT INTO categories(dataset_id,id,kind,name,default_key) SELECT ?,id,kind,name,default_key FROM categories WHERE dataset_id = 'initial'"
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
async function create(fields: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const response = await api('entries', {
    ...command(),
    id,
    kind: 'expense',
    name: 'Synthetic report entry',
    amount: '100',
    date: '2024-03-10',
    tags: ['Delivery', 'Lunch'],
    categoryId: 'expense-food',
    ...fields,
  });
  expect(response.status).toBe(200);
  return id;
}
async function refund(id: string, fields: Record<string, unknown> = {}) {
  const refundId = crypto.randomUUID();
  expect(
    (
      await api('refunds', {
        ...command(),
        id: refundId,
        expenseId: id,
        expenseVersion: 1,
        amount: '30',
        date: '2024-04-02',
        confirmedBaseMinor: 3000,
        ...fields,
      })
    ).status
  ).toBe(200);
  return refundId;
}
const range = { from: '2024-03-01', to: '2024-04-30' };
async function report(extra: Record<string, unknown> = {}) {
  const response = await api('reports/query', { filters: range, ...extra });
  expect(response.status).toBe(200);
  return response.json<Report>();
}
const entries = async (filters: unknown) =>
  (await api('entries/query', filters)).json<EntryPage>();

describe('protected shared financial reports', () => {
  it('counts fixed primary amounts, separate dated refunds, categories and inclusive weekly drilldowns from the same filters', async () => {
    const id = await create();
    await refund(id);
    await create({
      kind: 'income',
      amount: '500',
      categoryId: 'income-salary',
      date: '2024-03-01',
      tags: [],
    });
    const data = await report();
    expect(data.totals).toEqual({
      income: 50000,
      expense: 10000,
      refund: 3000,
      netExpense: 7000,
    });
    expect(data.counts).toEqual({ income: 1, expense: 1, refund: 1 });
    expect(data.total).toBe(3);
    expect(
      data.groups.find((g) => g.id === 'expense-food')?.totals.refund
    ).toBe(3000);
    const april = await report({
      filters: { from: '2024-04-01', to: '2024-04-30' },
    });
    expect(april.totals).toEqual({
      income: 0,
      expense: 0,
      refund: 3000,
      netExpense: -3000,
    });
    expect(april.trend[0]).toMatchObject({
      from: '2024-04-01',
      to: '2024-04-07',
    });
    for (const item of [...data.groups, ...data.trend]) {
      const detail = await entries(item.filters);
      expect(detail.totals).toEqual(item.totals);
      expect(detail.total).toBe(item.total);
    }
    expect(
      (await report({ interval: 'month' })).trend.map((b) => [b.from, b.to])
    ).toEqual([
      ['2024-03-01', '2024-03-31'],
      ['2024-04-01', '2024-04-30'],
    ]);
    expect(
      (
        await report({
          filters: { from: '2024-03-10', to: '2024-03-10' },
          interval: 'day',
        })
      ).trend[0]
    ).toMatchObject({ from: '2024-03-10', to: '2024-03-10' });
  });

  it('keeps USD original totals and actual refund differences without fetching AI or quotes', async () => {
    const id = await create({
      currency: 'USD',
      conversion: { rate: '7.20' },
      confirmedBaseMinor: 72000,
    });
    await refund(id, { actualAmount: '210.33', confirmedBaseMinor: 21033 });
    await create({ amount: '20', tags: [] });
    const data = await report({ filters: { ...range, currency: 'USD' } });
    expect(data.total).toBe(2);
    expect(data.originalTotals).toEqual({
      income: 0,
      expense: 10000,
      refund: 3000,
      netExpense: 7000,
    });
    expect(data.totals).toEqual({
      income: 0,
      expense: 72000,
      refund: 21033,
      netExpense: 50967,
    });
    expect(data.groups[0].originalTotals).toEqual(data.originalTotals);
    expect((await entries(data.filters)).totals).toEqual(data.totals);
  });

  it('keeps tag groups nonadditive while preserving the original any-tag predicate in every drilldown', async () => {
    const a = await create({ tags: ['A', 'C'] });
    await create({ tags: ['B', 'C'] });
    await create({ tags: ['C'] });
    await create({ tags: [] });
    const all = await report({ groupBy: 'tag' });
    expect(all.total).toBe(4);
    expect(all.groups.find((g) => g.id === null)?.total).toBe(1);
    const tagA = (await entries({})).items
      .find((e) => e.id === a)
      ?.tags.find((t) => t.name === 'A');
    if (!tagA) throw new Error('Missing synthetic tag');
    const selected = await report({
      groupBy: 'tag',
      filters: { ...range, tagIds: [tagA.id] },
    });
    expect(selected.total).toBe(1);
    expect(selected.totals.expense).toBe(10000);
    expect(selected.groups.map((g) => g.name).sort()).toEqual(['A', 'C']);
    for (const group of selected.groups) {
      expect((await entries(group.filters)).total).toBe(1);
      expect((await entries(group.filters)).totals).toEqual(group.totals);
    }
    const narrowed = await report({
      groupBy: 'tag',
      filters: { ...range, requiredTagIds: [tagA.id] },
    });
    for (const group of narrowed.groups)
      expect((await entries(group.filters)).total).toBe(1);
    for (const group of all.groups)
      expect((await entries(group.filters)).total).toBe(group.total);
  });

  it('reflects original category/tag edits, trash, restore and active dataset changes without a stale report cache', async () => {
    const id = await create();
    const refundId = await refund(id);
    const first = await report();
    expect(
      (
        await api(
          'entries',
          {
            ...command(),
            id,
            version: 1,
            kind: 'expense',
            name: 'Updated synthetic',
            amount: '100',
            categoryId: 'expense-other',
            tags: ['New tag'],
            note: 'Find this synthetic note',
          },
          'PUT'
        )
      ).status
    ).toBe(200);
    const updated = await report();
    expect(updated.revision).toBeGreaterThan(first.revision);
    expect(updated.groups.find((g) => g.id === 'expense-other')?.total).toBe(2);
    expect(
      (await report({ groupBy: 'tag' })).groups.map((g) => g.name)
    ).toEqual(['New tag']);
    expect(
      (await report({ filters: { ...range, keyword: 'Find this' } })).total
    ).toBe(1);
    expect(
      (
        await api('entries/delete', {
          ...command(),
          id: refundId,
          version: 1,
          confirmed: true,
        })
      ).status
    ).toBe(200);
    expect((await report()).totals.refund).toBe(0);
    expect(
      (
        await api('entries/restore', {
          ...command(),
          id: refundId,
          version: 2,
          confirmed: true,
        })
      ).status
    ).toBe(200);
    expect((await report()).totals.refund).toBe(3000);
    await env.DB.prepare(
      "UPDATE moni_state SET active_dataset = 'initial' WHERE singleton = 1"
    ).run();
    expect((await report()).total).toBe(0);
  });

  it('resolves explicit relative periods and caps the current calendar month at ledger today', async () => {
    await create({ date: '2024-02-29' });
    const month = await report({
      filters: {},
      period: { kind: 'month', month: '2024-02' },
    });
    expect(month.filters).toMatchObject({
      from: '2024-02-01',
      to: '2024-02-29',
    });
    const current = await report({ filters: {} });
    expect(current.timeZone).toBe('Asia/Shanghai');
    expect(current.filters.from?.slice(0, 7)).toBe(
      current.filters.to?.slice(0, 7)
    );
    expect(current.primaryCurrency).toBe('CNY');
  });

  it('rejects unsafe aggregates, invalid or executable input and unauthenticated access', async () => {
    for (const body of [
      { sql: 'select *' },
      { filters: { from: '2024-02-30' } },
      { filters: { from: '2024-04-01', to: '2024-03-01' } },
      { filters: range, period: { kind: 'rolling_months', months: 3 } },
      { period: { kind: 'month', month: '2024-13' } },
      { period: { kind: 'complete_months', months: 0 } },
      { groupBy: 'note' },
      { interval: 'hour' },
      { filters: { untagged: 'true' } },
    ])
      expect((await api('reports/query', body)).status).toBe(400);
    expect(
      (
        await SELF.fetch('https://moni.test/api/reports/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status
    ).toBe(401);
    const id = await create();
    // A large synthetic historical dataset must fail explicitly instead of rounding totals.
    for (let batch = 0; batch < 11; batch++) {
      await env.DB.batch(
        Array.from({ length: 100 }, () =>
          env.DB.prepare(
            'INSERT INTO entries(dataset_id,id,kind,name,entry_date,currency,original_minor,base_minor,category_id,note,version,created_at,updated_at,deleted_at,conversion_json) SELECT dataset_id,?,kind,name,entry_date,currency,9000000000000,9000000000000,category_id,note,version,created_at,updated_at,deleted_at,conversion_json FROM entries WHERE dataset_id = ? AND id = ?'
          ).bind(crypto.randomUUID(), datasetId, id)
        )
      );
    }
    expect((await api('reports/query', { filters: range })).status).toBe(413);
  });
});

describe('ledger date windows', () => {
  it('clamps rolling month ends across leap years and separates complete calendar months', () => {
    const period = { kind: 'rolling_months' as const, months: 1 };
    expect(
      resolveDatePeriod(period, 'UTC', new Date('2024-03-31T12:00:00Z'))
    ).toEqual({ from: '2024-02-29', to: '2024-03-31' });
    expect(
      resolveDatePeriod(period, 'UTC', new Date('2023-03-31T12:00:00Z'))
    ).toEqual({ from: '2023-02-28', to: '2023-03-31' });
    expect(
      resolveDatePeriod(
        { kind: 'rolling_months', months: 3 },
        'Asia/Shanghai',
        new Date('2026-10-16T16:00:00Z')
      )
    ).toEqual({ from: '2026-07-17', to: '2026-10-17' });
    expect(
      resolveDatePeriod(
        { kind: 'complete_months', months: 3 },
        'Asia/Shanghai',
        new Date('2026-10-16T16:00:00Z')
      )
    ).toEqual({ from: '2026-07-01', to: '2026-09-30' });
  });
  it('uses the ledger local date at midnight and DST boundaries, and clips upper-bound trend dates', () => {
    const period = { kind: 'month' as const, month: '2024-02' };
    expect(
      resolveDatePeriod(
        period,
        'America/Los_Angeles',
        new Date('2024-03-01T00:30:00Z')
      ).to
    ).toBe('2024-02-29');
    expect(
      resolveDatePeriod(
        { kind: 'month', month: '2024-03' },
        'America/Los_Angeles',
        new Date('2024-03-10T10:01:00Z')
      ).to
    ).toBe('2024-03-10');
    expect(
      resolveDatePeriod(
        { kind: 'complete_months', months: 1 },
        'UTC',
        new Date('2024-01-31T12:00:00Z')
      )
    ).toEqual({ from: '2023-12-01', to: '2023-12-31' });
    expect(trendEnd('9999-12-27', 'week')).toBe('9999-12-31');
  });
});
