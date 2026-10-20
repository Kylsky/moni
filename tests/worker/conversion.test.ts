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

const foreign = (extra: Record<string, unknown> = {}) => ({
  ...command(),
  id: crypto.randomUUID(),
  kind: 'expense',
  name: '合成美元推广',
  date: '2026-10-18',
  currency: 'USD',
  amount: '20',
  note: '合成独立备注',
  tags: ['推广'],
  conversion: { rate: '7.20', quoteDate: '2026-10-16' },
  confirmedBaseMinor: 14400,
  ...extra,
});
const rows = async () => (await api('entries/query', {})).json<EntryPage>();

describe('fixed manual conversion through protected ledger commands', () => {
  it('saves USD 20 at 7.20 as CNY 144 with immutable quote metadata and preserves it for metadata-only edits', async () => {
    const input = foreign();
    expect((await api('entries', input)).status).toBe(200);
    expect((await api('entries', input)).status).toBe(200);
    const first = (await rows()).items[0];
    expect(first).toMatchObject({
      originalMinor: 2000,
      baseMinor: 14400,
      currency: 'USD',
      conversion: {
        method: 'manual_rate',
        source: 'manual',
        baseCurrency: 'CNY',
        numerator: '720',
        denominator: '100',
        rate: '7.20',
        quoteDate: '2026-10-16',
      },
    });
    const edit = {
      ...input,
      operationId: crypto.randomUUID(),
      version: 1,
      note: '更新合成备注',
      tags: ['网站'],
      categoryId: 'expense-other',
      conversion: undefined,
      confirmedBaseMinor: undefined,
    };
    expect((await api('entries', edit, 'PUT')).status).toBe(200);
    expect((await api('entries', edit, 'PUT')).status).toBe(200);
    const changed = (await rows()).items[0];
    expect(changed.baseMinor).toBe(14400);
    expect(changed.conversion).toEqual(first.conversion);
    expect(changed.note).toBe('更新合成备注');
    const reprice = {
      ...input,
      version: 2,
      operationId: crypto.randomUUID(),
      conversion: { rate: '8', quoteDate: '2026-10-17' },
      confirmedBaseMinor: 16000,
    };
    expect((await api('entries', reprice, 'PUT')).status).toBe(200);
    expect((await api('entries', edit, 'PUT')).status).toBe(200);
    expect((await rows()).items[0].baseMinor).toBe(16000);
  });
  it('gives actual settlement priority and stores its exact rational basis', async () => {
    expect(
      (
        await api(
          'entries',
          foreign({
            conversion: { rate: '7.20', actualAmount: '143.31' },
            confirmedBaseMinor: 14331,
          })
        )
      ).status
    ).toBe(200);
    expect((await rows()).items[0]).toMatchObject({
      baseMinor: 14331,
      conversion: {
        method: 'actual',
        source: 'actual',
        numerator: '1433100',
        denominator: '200000',
        rate: null,
        quoteDate: null,
      },
    });
  });
  it('rounds half up once in the base minor unit, including zero/three-decimal original currencies and zero rounded base', async () => {
    for (const [currency, amount, rate, expected] of [
      ['USD', '0.01', '0.5', 1],
      ['JPY', '1', '0.045', 5],
      ['KWD', '0.001', '0.5', 0],
      ['USD', '90000000000.00', '0.000000000001', 9],
    ] as const) {
      const input = foreign({
        currency,
        amount,
        conversion: { rate },
        confirmedBaseMinor: expected,
      });
      expect((await api('entries', input)).status).toBe(200);
      const result = (await rows()).items.find((item) => item.id === input.id);
      expect(result?.baseMinor).toBe(expected);
    }
  });
  it('requires a valid basis and exact confirmation, rejects overflow/precision/future quotes, and cannot partly write', async () => {
    for (const extra of [
      { conversion: undefined },
      { confirmedBaseMinor: undefined },
      { confirmedBaseMinor: 14399 },
      { conversion: { rate: '0' } },
      { conversion: { rate: '7.1234567890123' } },
      { conversion: { rate: '1000000000' } },
      { conversion: { rate: '-7' } },
      { conversion: { rate: '1e2' } },
      { conversion: { rate: '7.2', quoteDate: '2026-10-19' } },
      { amount: '0.001' },
      { amount: '90000000000', conversion: { rate: '999999999' } },
      { conversion: { actualAmount: '0' } },
      { currency: 'XYZ' },
    ]) {
      const response = await api('entries', foreign(extra));
      expect([400, 409]).toContain(response.status);
    }
    expect((await rows()).items).toEqual([]);
    const valid = foreign();
    expect((await api('entries', valid)).status).toBe(200);
    const changed = {
      ...valid,
      operationId: crypto.randomUUID(),
      version: 1,
      date: '2026-10-17',
      conversion: undefined,
    };
    expect((await api('entries', changed, 'PUT')).status).toBe(400);
    expect((await rows()).items[0].date).toBe('2026-10-18');
  });
  it('keeps conversions after trash/restore and filters original currencies without mixing their amounts', async () => {
    const input = foreign();
    expect((await api('entries', input)).status).toBe(200);
    expect(
      (
        await api('entries', {
          ...command(),
          id: crypto.randomUUID(),
          kind: 'income',
          name: '合成人民币收入',
          amount: '35',
        })
      ).status
    ).toBe(200);
    const result = await (
      await api('entries/query', { currency: 'USD' })
    ).json<EntryPage>();
    expect(result.total).toBe(1);
    expect(result.items[0].originalMinor).toBe(2000);
    expect(result.totals).toMatchObject({
      expense: 14400,
      income: 0,
      netExpense: 14400,
    });
    expect(result.originalTotals).toMatchObject({ expense: 2000 });
    expect((await rows()).originalTotals).toBeNull();
    expect((await rows()).totals).toMatchObject({
      income: 3500,
      expense: 14400,
    });
    expect(
      (
        await api('entries/delete', {
          ...command(),
          id: input.id,
          version: 1,
          confirmed: true,
        })
      ).status
    ).toBe(200);
    expect(
      (
        await api('entries/restore', {
          ...command(),
          id: input.id,
          version: 2,
          confirmed: true,
        })
      ).status
    ).toBe(200);
    expect(
      (await rows()).items.find((item) => item.id === input.id)?.conversion
    ).toEqual(result.items[0].conversion);
  });
  it('rejects unsafe aggregate results before returning misleading totals', async () => {
    await env.DB.prepare(`WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<1001)
      INSERT INTO entries(dataset_id,id,kind,name,entry_date,currency,original_minor,base_minor,category_id,created_at,updated_at)
      SELECT ?, 'synthetic-'||x,'expense','合成边界账目','2026-10-18','CNY',9000000000000,9000000000000,'expense-food',1,1 FROM seq`)
      .bind(datasetId)
      .run();
    expect((await api('entries/query', {})).status).toBe(413);
  });
  it('retains omitted currency/date on metadata edits and explicitly confirms switching back to the primary currency', async () => {
    const input = foreign({ date: '2026-10-17' });
    expect((await api('entries', input)).status).toBe(200);
    const edit = {
      ...command(),
      id: input.id,
      version: 1,
      kind: 'expense',
      name: '合成美元推广',
      amount: '20',
      note: '仅修改备注',
    };
    expect((await api('entries', edit, 'PUT')).status).toBe(200);
    expect((await rows()).items[0]).toMatchObject({
      currency: 'USD',
      date: '2026-10-17',
      baseMinor: 14400,
    });
    const back = {
      ...edit,
      operationId: crypto.randomUUID(),
      version: 2,
      currency: 'CNY',
    };
    expect((await api('entries', back, 'PUT')).status).toBe(409);
    expect(
      (await api('entries', { ...back, confirmedBaseMinor: 2000 }, 'PUT'))
        .status
    ).toBe(200);
    expect((await rows()).items[0]).toMatchObject({
      currency: 'CNY',
      date: '2026-10-17',
      originalMinor: 2000,
      baseMinor: 2000,
      conversion: null,
    });
  });
});
