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
import type { ReferenceQuote } from '../../src/ledger/reference-conversion';

let quoteRows: unknown;
let providerStatus = 200;
let calls: { url: string; init?: RequestInit }[] = [];
let signingKey: CryptoKey;
let datasetId: string;
beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  signingKey = keys.privateKey;
  const publicKey = await exportJWK(keys.publicKey);
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (
        String(input instanceof Request ? input.url : input) ===
        `${env.ACCESS_ISSUER}/cdn-cgi/access/certs`
      )
        return Response.json({
          keys: [{ ...publicKey, kid: 'taxonomy-fixture', alg: 'RS256' }],
        });
      calls.push({
        url: String(input instanceof Request ? input.url : input),
        init,
      });
      return Response.json(quoteRows, { status: providerStatus });
    }
  );
});
afterAll(() => vi.unstubAllGlobals());
async function api(
  path: string,
  body?: unknown,
  method = 'POST',
  headers: Record<string, string> = {}
) {
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
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const command = () => ({ datasetId, operationId: crypto.randomUUID() });
beforeEach(async () => {
  calls = [];
  providerStatus = 200;
  quoteRows = [
    { date: '2024-05-17', base: 'EUR', quote: 'USD', rate: 1.25 },
    { date: '2024-05-17', base: 'EUR', quote: 'CNY', rate: 9 },
  ];
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

const preview = (extra: Record<string, unknown> = {}) =>
  api('rates/preview', {
    ...command(),
    currency: 'USD',
    date: '2024-05-19',
    ...extra,
  });
const foreign = (
  quote: ReferenceQuote,
  extra: Record<string, unknown> = {}
) => ({
  ...command(),
  id: crypto.randomUUID(),
  kind: 'expense',
  name: '合成推广',
  amount: '20',
  currency: 'USD',
  date: '2024-05-19',
  note: '合成独立备注不得发给报价商',
  conversion: { quoteId: quote.id },
  confirmedBaseMinor: 14400,
  ...extra,
});
const rows = async () => (await api('entries/query', {})).json<EntryPage>();

describe('ECB reference quotes through protected ledger commands', () => {
  it('fetches only the two raw ECB legs for the occurrence date and freezes the earlier quotation date', async () => {
    const quote = await (await preview()).json<ReferenceQuote>();
    expect(quote.snapshot).toMatchObject({
      method: 'reference',
      source: 'ECB',
      quoteDate: '2024-05-17',
      rate: '7.2',
    });
    expect(quote.date).toBe('2024-05-19');
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe(
      'https://api.frankfurter.dev/v2/providers/ecb/rates'
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      base: 'EUR',
      quotes: 'USD,CNY',
      date: '2024-05-19',
    });
    expect(calls[0].init).toMatchObject({
      headers: { Accept: 'application/json' },
      redirect: 'manual',
    });
    expect(calls[0].init?.body).toBeUndefined();
    expect((await api('entries', foreign(quote))).status).toBe(200);
    expect((await rows()).items[0]).toMatchObject({
      originalMinor: 2000,
      baseMinor: 14400,
      date: '2024-05-19',
      conversion: quote.snapshot,
    });
  });
  it('replays the same quote operation without network requests and never revalues history on a new quote or metadata edit', async () => {
    const operationId = crypto.randomUUID();
    const quote = await (await preview({ operationId })).json<ReferenceQuote>();
    const input = foreign(quote);
    expect((await api('entries', input)).status).toBe(200);
    quoteRows = [
      { date: '2024-05-17', base: 'EUR', quote: 'USD', rate: 1.25 },
      { date: '2024-05-17', base: 'EUR', quote: 'CNY', rate: 10 },
    ];
    expect(await (await preview({ operationId })).json()).toEqual(quote);
    expect(calls).toHaveLength(1);
    expect((await preview({ operationId, date: '2024-05-18' })).status).toBe(
      409
    );
    const next = await (await preview()).json<ReferenceQuote>();
    expect(next.snapshot.rate).toBe('8');
    expect((await rows()).items[0].baseMinor).toBe(14400);
    expect(
      (
        await api(
          'entries',
          {
            ...input,
            ...command(),
            version: 1,
            conversion: undefined,
            note: '仅更新备注',
          },
          'PUT'
        )
      ).status
    ).toBe(200);
    expect(calls).toHaveLength(2);
    expect((await rows()).items[0].conversion).toEqual(quote.snapshot);
  });
  it('uses the exact native-leg ratio before one final money rounding, with EUR in either direction', async () => {
    quoteRows = [
      { date: '2024-05-17', base: 'EUR', quote: 'USD', rate: 3 },
      { date: '2024-05-17', base: 'EUR', quote: 'CNY', rate: 1 },
    ];
    const quote = await (await preview()).json<ReferenceQuote>();
    expect(quote.snapshot.rate).toBe('0.333333333333');
    expect(
      (
        await api(
          'entries',
          foreign(quote, {
            amount: '90000000000',
            confirmedBaseMinor: 3000000000000,
          })
        )
      ).status
    ).toBe(200);
    quoteRows = [{ date: '2024-05-17', base: 'EUR', quote: 'CNY', rate: 9 }];
    const euro = await (
      await preview({ currency: 'EUR' })
    ).json<ReferenceQuote>();
    expect(euro.snapshot.rate).toBe('9');
    expect(
      (
        await api(
          'entries',
          foreign(euro, { currency: 'EUR', confirmedBaseMinor: 18000 })
        )
      ).status
    ).toBe(200);
    // A separate empty dataset allows EUR as the primary currency.
    datasetId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO datasets(id) VALUES (?)').bind(datasetId),
      env.DB.prepare(
        'UPDATE moni_state SET active_dataset = ? WHERE singleton = 1'
      ).bind(datasetId),
    ]);
    expect(
      (
        await api('initialize', {
          ...command(),
          primaryCurrency: 'EUR',
          timeZone: 'UTC',
        })
      ).status
    ).toBe(200);
    quoteRows = [{ date: '2024-05-17', base: 'EUR', quote: 'USD', rate: 1.25 }];
    const reverse = await (await preview()).json<ReferenceQuote>();
    expect(reverse.snapshot.rate).toBe('0.8');
  });
  it('rejects future, mixed-date, missing, malformed, oversized and unavailable responses without writing formal entries', async () => {
    for (const response of [
      [],
      [{ date: '2024-05-17', base: 'EUR', quote: 'USD', rate: 1.25 }],
      [
        { date: '2024-05-20', base: 'EUR', quote: 'USD', rate: 1.25 },
        { date: '2024-05-20', base: 'EUR', quote: 'CNY', rate: 9 },
      ],
      [
        { date: '2024-05-17', base: 'EUR', quote: 'USD', rate: 1.25 },
        { date: '2024-05-16', base: 'EUR', quote: 'CNY', rate: 9 },
      ],
      [
        { date: '2024-05-17', base: 'USD', quote: 'USD', rate: 1.25 },
        { date: '2024-05-17', base: 'EUR', quote: 'CNY', rate: 9 },
      ],
      [
        { date: '2024-05-17', base: 'EUR', quote: 'USD', rate: 0 },
        { date: '2024-05-17', base: 'EUR', quote: 'CNY', rate: 9 },
      ],
      'x'.repeat(33000),
    ]) {
      quoteRows = response;
      expect([424, 502]).toContain((await preview()).status);
    }
    providerStatus = 403;
    expect((await preview()).status).toBe(502);
    providerStatus = 302;
    expect((await preview()).status).toBe(502);
    providerStatus = 200;
    quoteRows = [
      { date: '2024-04-01', base: 'EUR', quote: 'USD', rate: 1.25 },
      { date: '2024-04-01', base: 'EUR', quote: 'CNY', rate: 9 },
    ];
    expect((await preview()).status).toBe(424);
    expect((await rows()).items).toEqual([]);
    const count = calls.length;
    expect((await preview({ date: '2099-01-01' })).status).toBe(400);
    expect((await preview({ currency: 'CNY' })).status).toBe(400);
    expect(
      (await preview({ url: 'https://untrusted.invalid', note: '不得发送' }))
        .status
    ).toBe(400);
    expect(calls).toHaveLength(count);
  });
  it('binds server-issued evidence to the current dataset, currency and date, and requires confirmation', async () => {
    const quote = await (await preview()).json<ReferenceQuote>();
    for (const extra of [
      { date: '2024-05-18' },
      { currency: 'JPY' },
      { confirmedBaseMinor: 14401 },
      { conversion: { quoteId: crypto.randomUUID() } },
      { conversion: { rate: '7.2', source: 'ECB' } },
    ])
      expect([400, 409]).toContain(
        (await api('entries', foreign(quote, extra))).status
      );
    expect((await rows()).items).toEqual([]);
    const old = foreign(quote);
    const nextDataset = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO datasets(id) VALUES (?)').bind(nextDataset),
      env.DB.prepare(
        'UPDATE moni_state SET active_dataset=? WHERE singleton=1'
      ).bind(nextDataset),
    ]);
    expect((await api('entries', old)).status).toBe(409);
    expect(
      (
        await api('rates/preview', {
          datasetId: nextDataset,
          operationId: crypto.randomUUID(),
          currency: 'USD',
          date: '2024-05-19',
        })
      ).status
    ).toBe(409);
  });
  it('gives explicit actual settlement priority even when reference evidence is unavailable', async () => {
    const quote = await (await preview()).json<ReferenceQuote>();
    expect(
      (
        await api(
          'entries',
          foreign(quote, {
            conversion: {
              quoteId: crypto.randomUUID(),
              actualAmount: '143.31',
            },
            confirmedBaseMinor: 14331,
          })
        )
      ).status
    ).toBe(200);
    expect((await rows()).items[0]).toMatchObject({
      baseMinor: 14331,
      conversion: { method: 'actual', source: 'actual' },
    });
  });
  it('checks Access and same-origin write protection before contacting the provider', async () => {
    const input = { ...command(), currency: 'USD', date: '2024-05-19' };
    expect(
      (
        await SELF.fetch('https://moni.test/api/rates/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        })
      ).status
    ).toBe(401);
    expect(
      (
        await api('rates/preview', input, 'POST', {
          Origin: 'https://untrusted.invalid',
        })
      ).status
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
