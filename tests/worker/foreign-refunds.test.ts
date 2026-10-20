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
import type { EntryPage } from '../../src/ledger/entry-query';
import type { RefundPage } from '../../src/ledger/refunds';

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

const original = async (extra: Record<string, unknown> = {}) => {
  const input = {
    ...command(),
    id: crypto.randomUUID(),
    kind: 'expense',
    name: '合成外币消费',
    currency: 'USD',
    amount: '100',
    date: '2026-09-20',
    categoryId: 'expense-other',
    tags: ['合成推广'],
    note: '合成独立备注',
    conversion: { rate: '7.20' },
    confirmedBaseMinor: 72000,
    ...extra,
  };
  expect((await api('entries', input)).status).toBe(200);
  return input;
};
const inputFor = (
  parent: Awaited<ReturnType<typeof original>>,
  amount: string,
  base: number,
  extra: Record<string, unknown> = {}
) => ({
  ...command(),
  id: crypto.randomUUID(),
  expenseId: parent.id,
  expenseVersion: 1,
  amount,
  date: '2026-10-18',
  confirmedBaseMinor: base,
  note: '合成外币退款备注',
  ...extra,
});
const related = async (parent: Awaited<ReturnType<typeof original>>) =>
  (await api(`refunds?expenseId=${parent.id}`)).json<RefundPage>();
const record = async (id: string) =>
  (await (await api(`entries?id=${id}`)).json<Entry[]>())[0];
const transition = (id: string, version: number, action: string) =>
  api(`entries/${action}`, { ...command(), id, version, confirmed: true });
const save = async (input: ReturnType<typeof inputFor>) => {
  expect((await api('refunds', input)).status).toBe(200);
  return input;
};

describe('foreign refund conversion and allocation through protected commands', () => {
  it('uses the original USD 100 at 7.20 basis for USD 30, without requesting a new quote', async () => {
    const parent = await original();
    const input = await save(inputFor(parent, '30', 21600));
    const row = await record(input.id);
    expect(row).toMatchObject({
      originalMinor: 3000,
      baseMinor: 21600,
      refundDefaultMinor: 21600,
      refundActual: false,
      conversion: {
        method: 'manual_rate',
        rate: '7.20',
        quoteDate: '2026-09-20',
      },
    });
    const data = await related(parent);
    expect(data.originalTotals?.refund).toBe(3000);
    expect(data.totals.refund).toBe(21600);
    expect(data.defaultRefundedMinor).toBe(21600);
  });
  it('allocates final tails exactly across zero/two/three-decimal and extreme original amounts, including zero converted refunds', async () => {
    for (const [currency, amount, rate, base, part, parts] of [
      ['USD', '3', '0.333333333333', 100, '1', [33, 33, 34]],
      ['USD', '0.03', '0.5', 2, '0.01', [1, 1, 0]],
      ['JPY', '3', '0.005', 2, '1', [1, 1, 0]],
      ['KWD', '0.003', '5', 2, '0.001', [1, 1, 0]],
      ['JPY', '1', '0.000001', 0, '1', [0]],
      ['USD', '90000000000', '0.000000000001', 9, '45000000000', [5, 4]],
    ] as const) {
      const parent = await original({
        currency,
        amount,
        conversion: { rate },
        confirmedBaseMinor: base,
      });
      for (const value of parts) await save(inputFor(parent, part, value));
      const data = await related(parent);
      expect(data.totals.refund).toBe(base);
      expect(data.defaultRefundedMinor).toBe(base);
      expect(data.originalTotals?.refund).toBe(data.expense.originalMinor);
      expect((await api('refunds', inputFor(parent, part, 0))).status).toBe(
        409
      );
    }
  });
  it('preserves actual settlement variance when the remaining original amount is fully refunded by default', async () => {
    const parent = await original();
    const actual = await save(
      inputFor(parent, '30', 21033, { actualAmount: '210.33' })
    );
    expect(await record(actual.id)).toMatchObject({
      baseMinor: 21033,
      refundDefaultMinor: 21600,
      refundActual: true,
      conversion: { method: 'actual', source: 'actual' },
    });
    await save(inputFor(parent, '70', 50400));
    const data = await related(parent);
    expect(data.totals).toMatchObject({ refund: 71433 });
    expect(data.defaultRefundedMinor).toBe(72000);
    const all = await (await api('entries/query', {})).json<EntryPage>();
    expect(all.totals.netExpense).toBe(567);
    expect(
      (
        await api(
          'refunds',
          {
            ...actual,
            ...command(),
            version: 1,
            actualAmount: '210.33',
            note: '仅改实际退款备注',
          },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect((await record(actual.id)).baseMinor).toBe(21033);
    const high = await original();
    await save(inputFor(high, '100', 80000, { actualAmount: '800' }));
    expect((await related(high)).totals.refund).toBe(80000);
  });
  it('uses the primary currency’s zero/three-decimal precision for final allocations', async () => {
    for (const [primary, currency, amount, rate, part] of [
      ['JPY', 'USD', '0.03', '50', '0.01'],
      ['KWD', 'JPY', '3', '0.0005', '1'],
    ] as const) {
      datasetId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO datasets(id) VALUES (?)').bind(datasetId),
        env.DB.prepare(
          "INSERT INTO categories(dataset_id,id,kind,name,default_key) SELECT ?,id,kind,name,default_key FROM categories WHERE dataset_id='initial'"
        ).bind(datasetId),
        env.DB.prepare(
          'UPDATE moni_state SET active_dataset=? WHERE singleton=1'
        ).bind(datasetId),
      ]);
      expect(
        (
          await api('initialize', {
            ...command(),
            primaryCurrency: primary,
            timeZone: 'UTC',
          })
        ).status
      ).toBe(200);
      const parent = await original({
        currency,
        amount,
        conversion: { rate },
        confirmedBaseMinor: 2,
      });
      for (const value of [1, 1, 0]) await save(inputFor(parent, part, value));
      const data = await related(parent);
      expect(data.primaryCurrency).toBe(primary);
      expect(data.totals.refund).toBe(2);
    }
  });
  it('does not recalculate a frozen tail on note/date edits after another partial refund was deleted', async () => {
    const parent = await original({
      amount: '0.03',
      conversion: { rate: '0.5' },
      confirmedBaseMinor: 2,
    });
    const first = await save(inputFor(parent, '0.01', 1));
    await save(inputFor(parent, '0.01', 1));
    const tail = await save(inputFor(parent, '0.01', 0));
    expect((await transition(first.id, 1, 'delete')).status).toBe(200);
    expect(
      (
        await api(
          'refunds',
          {
            ...tail,
            ...command(),
            version: 1,
            date: '2026-10-19',
            note: '保留零分尾差',
          },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect(await record(tail.id)).toMatchObject({
      baseMinor: 0,
      refundDefaultMinor: 0,
      date: '2026-10-19',
      note: '保留零分尾差',
    });
    expect((await transition(first.id, 2, 'restore')).status).toBe(200);
    expect((await related(parent)).totals.refund).toBe(2);
  });
  it('requires a fresh confirmation when adding or clearing an actual settlement override on an existing refund', async () => {
    const parent = await original();
    const input = await save(inputFor(parent, '30', 21600));
    const actual = {
      ...input,
      ...command(),
      version: 1,
      actualAmount: '210.33',
      confirmedBaseMinor: 21033,
    };
    expect((await api('refunds', actual, 'PUT')).status).toBe(200);
    expect(await record(input.id)).toMatchObject({
      baseMinor: 21033,
      refundActual: true,
      refundDefaultMinor: 21600,
    });
    const clear = {
      ...input,
      ...command(),
      version: 2,
      confirmedBaseMinor: 21033,
    };
    expect((await api('refunds', clear, 'PUT')).status).toBe(409);
    expect(
      (
        await api(
          'refunds',
          { ...clear, ...command(), confirmedBaseMinor: 21600 },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect(await record(input.id)).toMatchObject({
      baseMinor: 21600,
      refundActual: false,
      conversion: { method: 'manual_rate', rate: '7.20' },
    });
    expect((await api('refunds', input)).status).toBe(200);
    expect((await related(parent)).total).toBe(1);
  });
  it('uses current remaining allocations after deletions and rejects restores that would break a full default conversion', async () => {
    const parent = await original({
      amount: '0.03',
      conversion: { rate: '0.5' },
      confirmedBaseMinor: 2,
    });
    const first = await save(inputFor(parent, '0.01', 1));
    await save(inputFor(parent, '0.01', 1));
    const oldTail = await save(inputFor(parent, '0.01', 0));
    expect((await transition(oldTail.id, 1, 'delete')).status).toBe(200);
    await save(inputFor(parent, '0.01', 0));
    expect((await transition(first.id, 1, 'delete')).status).toBe(200);
    expect((await transition(oldTail.id, 2, 'restore')).status).toBe(409);
    await save(inputFor(parent, '0.01', 1));
    expect((await related(parent)).totals.refund).toBe(2);
    const over = await original({
      amount: '0.03',
      conversion: { rate: '0.5' },
      confirmedBaseMinor: 2,
    });
    await save(inputFor(over, '0.01', 1));
    const deleted = await save(inputFor(over, '0.01', 1));
    const zero = await save(inputFor(over, '0.01', 0));
    expect((await transition(deleted.id, 1, 'delete')).status).toBe(200);
    await save(inputFor(over, '0.01', 1));
    expect((await transition(zero.id, 1, 'delete')).status).toBe(200);
    expect((await transition(deleted.id, 2, 'restore')).status).toBe(409);
    expect((await related(over)).totals.refund).toBe(2);
  });
  it('preserves existing conversions on metadata edits and guards original repricing against allocated/default full refunds', async () => {
    const parent = await original();
    const input = await save(inputFor(parent, '30', 21600));
    expect(
      (
        await api(
          'entries',
          {
            ...parent,
            ...command(),
            version: 1,
            conversion: { rate: '8' },
            confirmedBaseMinor: 80000,
          },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect(
      (
        await api(
          'refunds',
          {
            ...input,
            ...command(),
            expenseVersion: 2,
            version: 1,
            note: '原消费改价后仅改备注',
          },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect(await record(input.id)).toMatchObject({
      baseMinor: 21600,
      conversion: { rate: '7.20' },
    });
    expect(
      (
        await api(
          'entries',
          {
            ...parent,
            ...command(),
            version: 2,
            conversion: { rate: '1' },
            confirmedBaseMinor: 10000,
          },
          'PUT'
        )
      ).status
    ).toBe(409);
    expect(
      (
        await api(
          'entries',
          {
            ...parent,
            ...command(),
            version: 2,
            amount: '30',
            conversion: { rate: '8' },
            confirmedBaseMinor: 24000,
          },
          'PUT'
        )
      ).status
    ).toBe(409);
    await save(inputFor(parent, '70', 58400, { expenseVersion: 2 }));
    expect((await related(parent)).totals.refund).toBe(80000);
    expect(
      (
        await api(
          'entries',
          {
            ...parent,
            ...command(),
            version: 2,
            conversion: { rate: '9' },
            confirmedBaseMinor: 90000,
          },
          'PUT'
        )
      ).status
    ).toBe(409);
  });
  it('rejects stale tail confirmations, invalid actual amounts and incompatible precision without partial writes', async () => {
    const parent = await original({
      amount: '0.03',
      conversion: { rate: '0.5' },
      confirmedBaseMinor: 2,
    });
    await save(inputFor(parent, '0.01', 1));
    await save(inputFor(parent, '0.01', 1));
    expect((await api('refunds', inputFor(parent, '0.01', 1))).status).toBe(
      409
    );
    const data = await related(parent);
    expect(data.total).toBe(2);
    expect(data.totals.refund).toBe(2);
    for (const actualAmount of ['0', '-1', '0.001', '1e2', '90000000000.01'])
      expect([400, 409]).toContain(
        (await api('refunds', inputFor(parent, '0.01', 1, { actualAmount })))
          .status
      );
    await save(inputFor(parent, '0.01', 0));
  });
  it('keeps concurrent partial refunds within both original and default conversion budgets', async () => {
    const parent = await original({
      amount: '0.03',
      conversion: { rate: '0.5' },
      confirmedBaseMinor: 2,
    });
    const inputs = [inputFor(parent, '0.01', 1), inputFor(parent, '0.01', 1)];
    const results = await Promise.all(
      inputs.map((input) => api('refunds', input))
    );
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => [200, 409].includes(r.status))).toBe(true);
    for (let i = 0; i < results.length; i++)
      if (results[i].status !== 200) await save({ ...inputs[i], ...command() });
    const tail = await save(inputFor(parent, '0.01', 0));
    expect((await related(parent)).totals.refund).toBe(2);
    expect((await transition(tail.id, 1, 'delete')).status).toBe(200);
    expect((await transition(tail.id, 2, 'restore')).status).toBe(200);
    expect((await related(parent)).totals.refund).toBe(2);
  });
});
