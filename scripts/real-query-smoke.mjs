import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { Response as WorkerResponse } from 'miniflare';
import { createTestRuntime } from './test-runtime.mjs';

if (process.env.MONI_REAL_QUERY_SMOKE !== '1') {
  console.log(
    'Skipped: set MONI_REAL_QUERY_SMOKE=1 for private synthetic query integration.'
  );
  process.exit(0);
}
let runtime;
let stage = 'private_configuration';
const providerStatuses = [];
const checks = [];
try {
  execFileSync('git', ['check-ignore', '--quiet', '.dev.vars']);
  assert.equal((await stat('.dev.vars')).mode & 0o077, 0);
  const config = parseEnv(await readFile('.dev.vars', 'utf8'));
  const ai = Object.fromEntries(
    ['AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL'].map((name) => {
      assert.ok(config[name]);
      return [name, config[name]];
    })
  );
  const endpoint = new URL(ai.AI_BASE_URL);
  assert.equal(endpoint.protocol, 'https:');
  assert.ok(!endpoint.username && !endpoint.password);
  const local = await createTestRuntime({
    ai,
    provider: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, endpoint.origin);
      assert.ok(url.pathname.endsWith('/chat/completions'));
      const bytes = await request.arrayBuffer();
      const input = JSON.parse(new TextDecoder().decode(bytes));
      assert.ok(
        (input.tools ?? []).every((tool) =>
          ['get_ledger_context', 'prepare_draft', 'query_ledger'].includes(
            tool.function.name
          )
        )
      );
      assert.ok(!JSON.stringify(input).includes(ai.AI_API_KEY));
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: request.headers,
          body: bytes,
          redirect: 'manual',
          signal: AbortSignal.timeout(60000),
        });
      } catch {
        throw new Error('Real provider unavailable');
      }
      providerStatuses.push(response.status);
      if (!response.ok)
        return WorkerResponse.json(
          { error: { message: 'Real provider rejected request' } },
          { status: response.status }
        );
      return new WorkerResponse(response.body, {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  runtime = local.runtime;
  const command = () => ({
    datasetId: 'initial',
    operationId: crypto.randomUUID(),
  });
  async function api(path, body) {
    const response = await runtime.dispatchFetch(
      `https://moni.test/api/${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Jwt-Assertion': local.ownerToken,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }
    );
    assert.equal(response.status, 200);
    return response;
  }
  stage = 'synthetic_seed';
  await api('initialize', {
    ...command(),
    primaryCurrency: 'CNY',
    timeZone: 'Asia/Shanghai',
  });
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (name) => parts.find((item) => item.type === name).value;
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  const previous = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const month = previous.toISOString().slice(0, 7);
  async function entry(extra = {}) {
    const id = crypto.randomUUID();
    await api('entries', {
      ...command(),
      id,
      kind: 'expense',
      name: '合成外卖餐',
      amount: '35',
      currency: 'CNY',
      date: `${month}-01`,
      categoryId: 'expense-food',
      tags: ['外卖'],
      note: '合成肯德基备注',
      ...extra,
    });
    return id;
  }
  await entry();
  const foreign = await entry({
    amount: '20',
    currency: 'USD',
    conversion: { rate: '7.20' },
    confirmedBaseMinor: 14400,
    date: `${month}-02`,
    note: '',
  });
  await entry({ amount: '10', date: today, note: '' });
  await entry({ amount: '99', tags: ['交通'], note: '' });
  await entry({
    kind: 'income',
    amount: '100',
    categoryId: 'income-other',
    note: '',
  });
  await entry({ amount: '500', date: '1900-01-01', note: '' });
  await api('refunds', {
    ...command(),
    id: crypto.randomUUID(),
    expenseId: foreign,
    expenseVersion: 1,
    amount: '5',
    date: today,
    confirmedBaseMinor: 3600,
    note: '合成独立退款备注',
  });
  const taxonomy = await (await api('taxonomy')).json();
  const tagId = taxonomy.tags.find((tag) => tag.name === '外卖').id;
  const threadId = crypto.randomUUID();
  await api('conversations', { ...command(), id: threadId });
  async function ask(text, expectedCount) {
    const thread = await (await api(`conversations/${threadId}`)).json();
    const response = await api('chat', {
      datasetId: 'initial',
      threadId,
      version: thread.version,
      runId: crypto.randomUUID(),
      text,
    });
    const stream = await response.text();
    assert.ok(stream.includes('RUN_FINISHED') && !stream.includes('RUN_ERROR'));
    assert.ok(!stream.includes(ai.AI_API_KEY));
    const trace = await (await api(`chat?threadId=${threadId}`)).json();
    const results = trace.messages
      .flatMap((message) => message.parts ?? [])
      .filter(
        (part) => part.type === 'tool-call' && part.name === 'query_ledger'
      )
      .flatMap((part) => {
        try {
          const output =
            typeof part.output === 'string'
              ? JSON.parse(part.output)
              : part.output;
          return output?.type === 'ledger_query' ? [output] : [];
        } catch {
          return [];
        }
      });
    assert.equal(results.length, expectedCount);
    return results.at(-1);
  }
  stage = 'real_rolling_query';
  const first = await ask(
    '最近3个月我在外卖花了多少钱？请按账本已有的外卖标签查账，列出支出、退款和净支出。',
    1
  );
  assert.deepEqual(first.report.totals, {
    income: 0,
    expense: 18900,
    refund: 3600,
    netExpense: 15300,
  });
  assert.equal(first.report.total, 4);
  assert.equal(first.report.filters.to, today);
  assert.ok(
    (
      first.report.filters.tagIds ?? first.report.filters.requiredTagIds
    ).includes(tagId)
  );
  checks.push('real_rolling_query');
  stage = 'real_previous_month_followup';
  const second = await ask('那上个月呢？', 2);
  assert.deepEqual(second.report.totals, {
    income: 0,
    expense: 17900,
    refund: 0,
    netExpense: 17900,
  });
  assert.equal(second.report.total, 2);
  assert.equal(second.report.filters.from, `${month}-01`);
  assert.ok(
    (
      second.report.filters.tagIds ?? second.report.filters.requiredTagIds
    ).includes(tagId)
  );
  checks.push('real_followup_inherits_tag');
  stage = 'real_usd_followup';
  const third = await ask(
    '还是外卖，改为全部时间，只看美元，原币与主币种分别列出。',
    3
  );
  assert.deepEqual(third.report.totals, {
    income: 0,
    expense: 14400,
    refund: 3600,
    netExpense: 10800,
  });
  assert.deepEqual(third.report.originalTotals, {
    income: 0,
    expense: 2000,
    refund: 500,
    netExpense: 1500,
  });
  assert.equal(third.report.filters.currency, 'USD');
  const details = await (
    await api('entries/query', third.report.filters)
  ).json();
  assert.deepEqual(details.totals, third.report.totals);
  assert.equal((await (await api('entries/query', {})).json()).total, 7);
  checks.push(
    'real_original_and_base_currencies',
    'exact_detail_filters',
    'read_only'
  );
  console.log(
    JSON.stringify({
      result: 'passed',
      providerStatuses,
      checks,
      storage: 'ephemeral_local',
      rates: 'fixed_synthetic_no_network',
    })
  );
} catch {
  console.error(
    JSON.stringify({
      result: 'failed',
      stage,
      providerStatuses,
      checks,
      storage: 'ephemeral_local',
    })
  );
  process.exitCode = 1;
} finally {
  await runtime?.dispose();
}
