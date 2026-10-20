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

const expense = (extra: Record<string, unknown> = {}) => ({
  ...command(),
  id: crypto.randomUUID(),
  kind: 'expense',
  name: '合成消费',
  amount: '200',
  date: '2026-09-20',
  categoryId: 'expense-food',
  tags: ['午餐', '外卖'],
  note: '合成原消费备注',
  ...extra,
});
const refund = (
  parent: ReturnType<typeof expense>,
  extra: Record<string, unknown> = {}
) => ({
  ...command(),
  id: crypto.randomUUID(),
  expenseId: parent.id,
  expenseVersion: 1,
  amount: '50',
  date: '2026-10-18',
  note: '合成退款备注',
  confirmedBaseMinor: 5000,
  ...extra,
});
const query = async (filters: Record<string, unknown> = {}) =>
  (await api('entries/query', filters)).json<EntryPage>();
const transition = (id: string, version: number, action: string) =>
  api(`entries/${action}`, { ...command(), id, version, confirmed: true });

describe('associated primary-currency refunds through protected commands', () => {
  it('keeps spending in September and reduces October spending on the refund date, without treating it as income', async () => {
    const parent = expense();
    expect((await api('entries', parent)).status).toBe(200);
    const input = refund(parent);
    expect((await api('refunds', input)).status).toBe(200);
    expect((await api('refunds', input)).status).toBe(200);
    expect((await api('refunds', { ...input, note: 'changed' })).status).toBe(
      409
    );
    const september = await query({ from: '2026-09-01', to: '2026-09-30' });
    expect(september.totals).toEqual({
      income: 0,
      expense: 20000,
      refund: 0,
      netExpense: 20000,
    });
    const october = await query({ from: '2026-10-01', to: '2026-10-31' });
    expect(october.totals).toEqual({
      income: 0,
      expense: 0,
      refund: 5000,
      netExpense: -5000,
    });
    expect(october.items[0]).toMatchObject({
      id: input.id,
      kind: 'refund',
      refundOf: parent.id,
      note: '合成退款备注',
      categoryId: 'expense-food',
      currency: 'CNY',
    });
    expect(october.items[0].tags.map((t) => t.name).sort()).toEqual([
      '午餐',
      '外卖',
    ]);
    expect((await query({ kind: 'refund' })).total).toBe(1);
    const related = await (await api(`refunds?expenseId=${parent.id}`)).json<
      EntryPage & { expense: { id: string } }
    >();
    expect(related.expense.id).toBe(parent.id);
    expect(related.originalTotals?.refund).toBe(5000);
  });
  it('atomically rejects excess and concurrent refunds without leaving orphan entries or partial receipts', async () => {
    const parent = expense();
    expect((await api('entries', parent)).status).toBe(200);
    const results = await Promise.all([
      api(
        'refunds',
        refund(parent, { amount: '150', confirmedBaseMinor: 15000 })
      ),
      api(
        'refunds',
        refund(parent, { amount: '150', confirmedBaseMinor: 15000 })
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await query()).totals.refund).toBe(15000);
    expect((await query()).total).toBe(2);
    const remain = refund(parent, {
      amount: '50.01',
      confirmedBaseMinor: 5001,
    });
    expect((await api('refunds', remain)).status).toBe(409);
    expect((await query({ kind: 'refund' })).total).toBe(1);
    expect(
      await env.DB.prepare(
        'SELECT count(*) FROM refund_links WHERE dataset_id=?'
      )
        .bind(datasetId)
        .first('count(*)')
    ).toBe(1);
  });
  it('protects a refund racing an original-amount reduction inside the same database write boundary', async () => {
    const parent = expense();
    expect((await api('entries', parent)).status).toBe(200);
    const results = await Promise.all([
      api(
        'refunds',
        refund(parent, { amount: '150', confirmedBaseMinor: 15000 })
      ),
      api(
        'entries',
        { ...parent, ...command(), version: 1, amount: '100' },
        'PUT'
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const result = await query();
    expect(result.totals.refund).toBeLessThanOrEqual(result.totals.expense);
    expect([10000, 20000]).toContain(result.totals.expense);
  });
  it('atomically protects a restored refund racing a newly registered full refund', async () => {
    const parent = expense();
    expect((await api('entries', parent)).status).toBe(200);
    const old = refund(parent);
    expect((await api('refunds', old)).status).toBe(200);
    expect((await transition(old.id, 1, 'delete')).status).toBe(200);
    const results = await Promise.all([
      transition(old.id, 2, 'restore'),
      api(
        'refunds',
        refund(parent, { amount: '200', confirmedBaseMinor: 20000 })
      ),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const result = await query({ kind: 'refund' });
    expect(result.total).toBe(1);
    expect([5000, 20000]).toContain(result.totals.refund);
  });
  it('prevents deleting, changing currency/kind, or reducing the original below active refunds, while allowing safe increases', async () => {
    const parent = expense();
    expect((await api('entries', parent)).status).toBe(200);
    expect((await api('refunds', refund(parent))).status).toBe(200);
    expect((await transition(parent.id, 1, 'delete')).status).toBe(409);
    for (const extra of [
      { amount: '49.99' },
      { kind: 'income', categoryId: 'income-other' },
      {
        currency: 'USD',
        conversion: { rate: '7.2' },
        confirmedBaseMinor: 144000,
      },
    ])
      expect(
        (
          await api(
            'entries',
            { ...parent, ...command(), version: 1, ...extra },
            'PUT'
          )
        ).status
      ).toBe(409);
    expect(
      (
        await api(
          'entries',
          { ...parent, ...command(), version: 1, amount: '300' },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect((await query()).totals.expense).toBe(30000);
  });
  it('edits refund amounts/dates/notes with version protection and cannot move the association or pass through the ordinary entry editor', async () => {
    const parent = expense();
    expect((await api('entries', parent)).status).toBe(200);
    const input = refund(parent);
    expect((await api('refunds', input)).status).toBe(200);
    const edit = {
      ...input,
      ...command(),
      version: 1,
      amount: '60',
      confirmedBaseMinor: 6000,
      date: '2026-10-19',
      note: '更新合成退款备注',
    };
    expect((await api('refunds', edit, 'PUT')).status).toBe(200);
    expect((await api('refunds', edit, 'PUT')).status).toBe(200);
    expect(
      (await api('refunds', { ...edit, ...command() }, 'PUT')).status
    ).toBe(409);
    expect(
      (
        await api(
          'entries',
          { ...parent, ...command(), id: input.id, version: 2 },
          'PUT'
        )
      ).status
    ).toBe(400);
    expect(
      (
        await api(
          'refunds',
          { ...edit, ...command(), version: 2, note: '', date: undefined },
          'PUT'
        )
      ).status
    ).toBe(200);
    const result = (await query({ kind: 'refund' })).items[0];
    expect(result).toMatchObject({
      originalMinor: 6000,
      date: '2026-10-19',
      note: '',
      version: 3,
      refundOf: parent.id,
    });
    const other = expense();
    expect((await api('entries', other)).status).toBe(200);
    expect(
      (
        await api(
          'refunds',
          { ...edit, ...command(), version: 3, expenseId: other.id },
          'PUT'
        )
      ).status
    ).toBe(409);
  });
  it('updates refund classification and tag filters with the original expense without duplicating totals or inheriting its note', async () => {
    const parent = expense();
    expect((await api('entries', parent)).status).toBe(200);
    expect((await api('refunds', refund(parent))).status).toBe(200);
    expect(
      (
        await api(
          'entries',
          {
            ...parent,
            ...command(),
            version: 1,
            categoryId: 'expense-sports',
            tags: ['网站', '推广'],
          },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect(
      (await query({ categoryId: 'expense-food', kind: 'refund' })).total
    ).toBe(0);
    const result = await query({
      categoryId: 'expense-sports',
      kind: 'refund',
    });
    expect(result.total).toBe(1);
    expect(result.items[0].tags.map((t) => t.name).sort()).toEqual([
      '推广',
      '网站',
    ]);
    const tagged = await query({
      tagIds: result.items[0].tags.map((t) => t.id),
    });
    expect(tagged.total).toBe(2);
    const catalog = await (await api('taxonomy')).json<{
      tags: { name: string; entryCount: number }[];
    }>();
    expect(catalog.tags.find((tag) => tag.name === '网站')?.entryCount).toBe(2);
    expect(tagged.totals).toEqual({
      income: 0,
      expense: 20000,
      refund: 5000,
      netExpense: 15000,
    });
    expect((await query({ keyword: '原消费备注', kind: 'refund' })).total).toBe(
      0
    );
    expect((await query({ keyword: '退款备注', kind: 'refund' })).total).toBe(
      1
    );
  });
  it('rechecks available balance and parent state on restore, and restricts purging a parent until its refund links are handled', async () => {
    const parent = expense();
    expect((await api('entries', parent)).status).toBe(200);
    const first = refund(parent);
    expect((await api('refunds', first)).status).toBe(200);
    expect((await transition(first.id, 1, 'delete')).status).toBe(200);
    const all = refund(parent, { amount: '200', confirmedBaseMinor: 20000 });
    expect((await api('refunds', all)).status).toBe(200);
    expect((await transition(first.id, 2, 'restore')).status).toBe(409);
    expect((await transition(all.id, 1, 'delete')).status).toBe(200);
    expect((await transition(all.id, 2, 'purge')).status).toBe(200);
    expect((await transition(first.id, 2, 'restore')).status).toBe(200);
    expect((await query()).totals.refund).toBe(5000);
    expect((await transition(first.id, 3, 'delete')).status).toBe(200);
    expect((await transition(parent.id, 1, 'delete')).status).toBe(200);
    expect((await transition(first.id, 4, 'restore')).status).toBe(409);
    expect((await transition(parent.id, 2, 'purge')).status).toBe(409);
    expect((await transition(parent.id, 2, 'restore')).status).toBe(200);
    expect((await transition(first.id, 4, 'restore')).status).toBe(200);
    expect((await transition(first.id, 5, 'delete')).status).toBe(200);
    expect((await transition(first.id, 6, 'purge')).status).toBe(200);
    expect((await transition(parent.id, 3, 'delete')).status).toBe(200);
    expect((await transition(parent.id, 4, 'purge')).status).toBe(200);
    expect((await query()).total).toBe(0);
  });
  it('does not restore an old-currency refund after the original changed currency, and keeps all failed commands atomic', async () => {
    const parent = expense();
    expect((await api('entries', parent)).status).toBe(200);
    const input = refund(parent);
    expect((await api('refunds', input)).status).toBe(200);
    expect((await transition(input.id, 1, 'delete')).status).toBe(200);
    expect(
      (
        await api(
          'entries',
          {
            ...parent,
            ...command(),
            version: 1,
            currency: 'USD',
            conversion: { rate: '7.2' },
            confirmedBaseMinor: 144000,
          },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect((await transition(input.id, 2, 'restore')).status).toBe(409);
    expect((await query({ kind: 'refund' })).total).toBe(0);
    expect(
      (
        await api(
          'entries',
          {
            ...parent,
            ...command(),
            version: 2,
            currency: 'CNY',
            confirmedBaseMinor: 20000,
          },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect((await transition(input.id, 2, 'restore')).status).toBe(200);
  });
  it('rejects invalid parents, missing confirmation, overprecision, extra client classification and stale datasets before mutation', async () => {
    const parent = expense();
    expect((await api('entries', parent)).status).toBe(200);
    for (const extra of [
      { amount: '0' },
      { amount: '-1' },
      { amount: '0.001' },
      { amount: '1e2' },
      { expenseId: crypto.randomUUID() },
      { confirmedBaseMinor: 5001 },
      { categoryId: 'expense-sports' },
      { note: 'x'.repeat(2001) },
      { datasetId: 'old-dataset' },
      { version: 1 },
    ])
      expect([400, 409]).toContain(
        (await api('refunds', refund(parent, extra))).status
      );
    const income = expense({ kind: 'income', categoryId: 'income-other' });
    expect((await api('entries', income)).status).toBe(200);
    expect((await api('refunds', refund(income))).status).toBe(409);
    expect((await query({ kind: 'refund' })).total).toBe(0);
    expect(
      (await SELF.fetch(`https://moni.test/api/refunds?expenseId=${parent.id}`))
        .status
    ).toBe(401);
  });
});
