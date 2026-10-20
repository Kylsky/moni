import assert from 'node:assert/strict';
import { Response as WorkerResponse } from 'miniflare';
import { createTestRuntime } from './test-runtime.mjs';

// Public quotes only; never load private configuration or forward owner credentials.
if (process.env.MONI_REAL_FX_SMOKE !== '1') {
  console.log(
    'Skipped: set MONI_REAL_FX_SMOKE=1 to request real public ECB quotes.'
  );
  process.exit(0);
}

let runtime;
let stage = 'local_runtime';
const providerStatuses = [];
const applicationStatuses = [];
const verified = [];
try {
  const local = await createTestRuntime({
    ai: {},
    provider: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://api.frankfurter.dev');
      assert.equal(url.pathname, '/v2/providers/ecb/rates');
      assert.equal(request.method, 'GET');
      assert.equal(url.searchParams.get('base'), 'EUR');
      assert.deepEqual([...url.searchParams.keys()].sort(), [
        'base',
        'date',
        'quotes',
      ]);
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      providerStatuses.push({
        date: url.searchParams.get('date'),
        status: response.status,
      });
      return new WorkerResponse(response.body, {
        status: response.status,
        headers: { 'Content-Type': response.headers.get('Content-Type') ?? '' },
      });
    },
  });
  runtime = local.runtime;
  const headers = {
    'Content-Type': 'application/json',
    'Cf-Access-Jwt-Assertion': local.ownerToken,
  };
  const command = () => ({
    datasetId: 'initial',
    operationId: crypto.randomUUID(),
  });
  async function api(path, body, method = 'POST') {
    const response = await runtime.dispatchFetch(
      `https://moni.test/api/${path}`,
      {
        headers,
        method: body === undefined ? 'GET' : method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }
    );
    applicationStatuses.push({ path, status: response.status });
    return response;
  }
  assert.equal(
    (
      await runtime.dispatchFetch('https://moni.test/api/rates/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...command(),
          currency: 'USD',
          date: '2024-05-15',
        }),
      })
    ).status,
    401
  );
  assert.equal(providerStatuses.length, 0);
  assert.equal(
    (
      await api('initialize', {
        ...command(),
        primaryCurrency: 'CNY',
        timeZone: 'UTC',
      })
    ).status,
    200
  );
  verified.push('owner_protection');

  async function quote(date, currency = 'USD') {
    return api('rates/preview', { ...command(), currency, date });
  }
  stage = 'real_workday_quote';
  const workday = await quote('2024-05-15');
  if (!workday.ok) {
    assert.equal(workday.status, 502);
    assert.equal((await api('entries')).status, 200);
    const entries = await local.db
      .prepare('SELECT count(*) AS count FROM entries')
      .first('count');
    assert.equal(entries, 0);
    assert.equal(
      await local.db
        .prepare('SELECT count(*) AS count FROM fx_quotes')
        .first('count'),
      0
    );
    assert.equal(
      (
        await api('entries', {
          ...command(),
          id: crypto.randomUUID(),
          kind: 'expense',
          name: 'Synthetic FX fallback',
          amount: '20',
          currency: 'USD',
          date: '2024-05-15',
          conversion: { rate: '7.20' },
          confirmedBaseMinor: 14400,
          note: 'Synthetic note retained after quote failure',
        })
      ).status,
      200
    );
    verified.push('failure_without_partial_entry', 'manual_fallback');
    throw new Error('real_quote_unavailable');
  }
  const first = await workday.json();
  assert.equal(first.currency, 'USD');
  assert.equal(first.baseCurrency, 'CNY');
  assert.equal(first.date, '2024-05-15');
  assert.equal(first.snapshot.baseCurrency, 'CNY');
  assert.equal(first.snapshot.source, 'ECB');
  assert.equal(first.snapshot.method, 'reference');
  assert.equal(first.snapshot.quoteDate, '2024-05-15');
  const numerator = BigInt(first.snapshot.numerator);
  const denominator = BigInt(first.snapshot.denominator);
  const confirmedBaseMinor = Number(
    (2000n * numerator * 2n + denominator) / (2n * denominator)
  );
  const id = crypto.randomUUID();
  assert.equal(
    (
      await api('entries', {
        ...command(),
        id,
        kind: 'expense',
        name: 'Synthetic real FX check',
        amount: '20',
        currency: 'USD',
        date: '2024-05-15',
        conversion: { quoteId: first.id },
        confirmedBaseMinor,
        note: 'Synthetic FX note',
      })
    ).status,
    200
  );
  const calls = providerStatuses.length;
  assert.equal(
    (
      await api(
        'entries',
        {
          ...command(),
          id,
          version: 1,
          kind: 'expense',
          name: 'Synthetic real FX check',
          amount: '20',
          note: 'Updated synthetic FX note',
        },
        'PUT'
      )
    ).status,
    200
  );
  const stored = (await (await api(`entries?id=${id}`)).json())[0];
  assert.equal(providerStatuses.length, calls);
  assert.deepEqual(stored.conversion, first.snapshot);
  assert.equal(stored.currency, 'USD');
  assert.equal(stored.originalMinor, 2000);
  assert.equal(stored.note, 'Updated synthetic FX note');
  assert.equal(stored.baseMinor, confirmedBaseMinor);
  verified.push(
    'real_workday',
    'reference_confirmation',
    'fixed_conversion',
    'note_edit_without_quote'
  );

  for (const [date, expectedDate] of [
    ['2024-05-19', '2024-05-17'],
    ['2024-01-01', '2023-12-29'],
  ]) {
    stage = `non_quote_day_${date}`;
    const response = await quote(date);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.date, date);
    assert.equal(result.snapshot.quoteDate, expectedDate);
    assert.equal(result.snapshot.source, 'ECB');
  }
  verified.push('weekend', 'holiday');
  stage = 'missing_quote';
  const missing = await quote('2024-05-15', 'BHD');
  assert.ok([424, 502].includes(missing.status));
  assert.ok([200, 404, 422].includes(providerStatuses.at(-1)?.status));
  assert.equal(
    await local.db
      .prepare('SELECT count(*) AS count FROM entries')
      .first('count'),
    1
  );
  assert.equal(
    await local.db
      .prepare('SELECT count(*) AS count FROM fx_quotes')
      .first('count'),
    3
  );
  verified.push('missing_pair');
  console.log(
    JSON.stringify({
      result: 'passed',
      providerStatuses,
      applicationStatuses,
      verified,
      storage: 'ephemeral_local',
    })
  );
} catch {
  console.error(
    JSON.stringify({
      result: 'failed',
      stage,
      providerStatuses,
      applicationStatuses,
      verified,
      storage: 'ephemeral_local',
    })
  );
  process.exitCode = 1;
} finally {
  await runtime?.dispose();
}
