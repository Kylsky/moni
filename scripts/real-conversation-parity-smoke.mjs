import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { Response as WorkerResponse } from 'miniflare';
import { createTestRuntime } from './test-runtime.mjs';

if (process.env.MONI_REAL_CONVERSATION_PARITY_SMOKE !== '1') {
  console.log(
    'Skipped: opt in with MONI_REAL_CONVERSATION_PARITY_SMOKE=1. Uses the real model and an ephemeral synthetic web ledger.'
  );
  process.exit(0);
}
process.umask(0o077);
let local;
let stage = 'private_configuration';
const verified = [];
const statuses = [];
let intentCalls = 0;
let modelCalls = 0;
try {
  execFileSync('git', ['check-ignore', '--quiet', '.dev.vars']);
  assert.equal(
    spawnSync('git', ['ls-files', '--error-unmatch', '.dev.vars'], {
      stdio: 'ignore',
    }).status,
    1
  );
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
  local = await createTestRuntime({
    ai,
    provider: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, endpoint.origin);
      assert.ok(url.pathname.endsWith('/chat/completions'));
      const body = await request.text();
      assert.ok(!body.includes(ai.AI_API_KEY));
      const input = JSON.parse(body);
      const classifier = input.tools?.some(
        (tool) => tool.function.name === 'classify_draft_confirmation'
      );
      if (classifier) intentCalls++;
      else modelCalls++;
      console.log(JSON.stringify({ progress: stage, modelCalls, intentCalls }));
      const response = await fetch(url, {
        method: 'POST',
        headers: request.headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(45000),
      });
      statuses.push(response.status);
      return new WorkerResponse(response.body, {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  const api = async (path, body) => {
    const response = await local.runtime.dispatchFetch(
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
  };
  const json = async (path, body) => (await api(path, body)).json();
  const command = () => ({
    datasetId: 'initial',
    operationId: crypto.randomUUID(),
  });
  await api('initialize', {
    ...command(),
    primaryCurrency: 'CNY',
    timeZone: 'Asia/Shanghai',
  });
  const threadId = crypto.randomUUID();
  await api('conversations', { ...command(), id: threadId });
  const drafts = async () => (await json(`drafts?threadId=${threadId}`)).items;
  const entries = () => json('entries/query', {});
  const visible = (items) => ({
    operationId: crypto.randomUUID(),
    drafts: items.map(({ id, version }) => ({ id, version })),
  });
  const say = async (name, text, review = null) => {
    stage = name;
    const current = await json(`conversations/${threadId}`);
    const response = await api('chat', {
      datasetId: 'initial',
      threadId,
      version: current.version,
      runId: crypto.randomUUID(),
      locale: 'zh',
      text,
      review,
    });
    const stream = await response.text();
    assert.ok(!stream.includes(ai.AI_API_KEY));
    assert.ok(stream.includes('RUN_FINISHED') && !stream.includes('RUN_ERROR'));
    const snapshot = await json(`chat?threadId=${threadId}`);
    assert.equal(snapshot.activeRun, null);
    assert.equal(snapshot.latestRun.status, 'completed');
    return snapshot;
  };
  const beforeEmpty = modelCalls;
  await say('empty_confirmation', '确认，记上吧。');
  assert.equal(modelCalls, beforeEmpty);
  assert.equal((await drafts()).length, 0);
  assert.equal((await entries()).total, 0);
  verified.push(stage);
  await say(
    'new_draft',
    '合成测试：今天在肯德基吃午餐花了35元人民币，备注“合成午餐”。请整理草稿，先不要入账。'
  );
  let pending = await drafts();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].totalBaseMinor, 3500);
  assert.equal((await entries()).total, 0);
  verified.push(stage);
  await say(
    'new_expense_with_pending',
    '再加一笔新的消费：今天买水花了9元人民币，备注“合成买水”。先不要入账。',
    visible(pending)
  );
  pending = await drafts();
  assert.equal(pending.length, 2);
  assert.equal((await entries()).total, 0);
  verified.push(stage);
  await say(
    'revise_existing',
    '刚才午餐那笔金额改成38元人民币，备注和其他内容不变。只修改现有午餐草稿，不新增，也不要入账。',
    visible(pending)
  );
  pending = await drafts();
  assert.equal(pending.length, 2);
  assert.deepEqual(
    pending.map((draft) => draft.totalBaseMinor).sort((a, b) => a - b),
    [900, 3800]
  );
  assert.equal((await entries()).total, 0);
  verified.push(stage);
  for (const [name, text] of [
    ['query_with_pending', '本月总支出多少？'],
    ['query_followup', '那上个月呢？'],
  ]) {
    const snapshot = await say(name, text, visible(pending));
    const result = snapshot.messages
      .flatMap((message) => message.parts)
      .filter(
        (part) => part.type === 'tool-call' && part.name === 'query_ledger'
      )
      .at(-1);
    const value =
      typeof result?.output === 'string'
        ? JSON.parse(result.output)
        : result?.output;
    assert.equal(value?.report.total, 0);
    assert.equal(
      value?.query.period.kind,
      name === 'query_followup' ? 'last_month' : 'this_month'
    );
    assert.equal((await drafts()).length, 2);
    assert.equal((await entries()).total, 0);
    verified.push(stage);
  }
  await say(
    'review_pending',
    '还有哪些没有入账？一起给我核对一下。',
    visible(pending)
  );
  assert.equal((await entries()).total, 0);
  verified.push(stage);
  const review = visible(await drafts());
  await say('natural_batch_confirmation', '都没问题，全部确认入账。', review);
  assert.equal((await entries()).total, 2);
  assert.equal((await entries()).totals.expense, 4700);
  verified.push(stage);
  await say('repeated_confirmation', '确认，都记上吧。', review);
  assert.equal((await entries()).total, 2);
  verified.push(stage);
  const beforeEmptyConfirmation = modelCalls;
  await say('repeated_confirmation_without_pending_cards', '确认啊');
  assert.equal(modelCalls, beforeEmptyConfirmation);
  assert.equal((await entries()).total, 2);
  verified.push(stage);
  const policy = await json('posting-policy');
  await api('posting-policy', {
    ...command(),
    version: policy.version,
    mode: 'automatic',
    confirmed: true,
  });
  const snapshot = await say(
    'automatic_mixed_query',
    '再记一笔今天合成咖啡12元人民币，备注“合成咖啡”，并且查询本月全部支出总额，要包含刚才这杯咖啡。'
  );
  assert.equal((await entries()).total, 3);
  assert.equal((await entries()).totals.expense, 5900);
  const parts = snapshot.messages
    .slice(
      snapshot.messages.findLastIndex((message) => message.role === 'user') + 1
    )
    .flatMap((message) => message.parts);
  const queries = parts
    .filter((part) => part.type === 'tool-call')
    .flatMap((part) => {
      let result;
      try {
        result =
          typeof part.output === 'string'
            ? JSON.parse(part.output)
            : part.output;
      } catch {
        return [];
      }
      return result?.type === 'ledger_query'
        ? [result]
        : result?.queryUpdates
          ? result.queryUpdates.flatMap((update) =>
              update.result ? [update.result] : []
            )
          : result?.queryResult
            ? [result.queryResult]
            : [];
    });
  assert.equal(queries.at(-1)?.report.totals.expense, 5900);
  verified.push(stage);
  const multiple = await say(
    'multiple_queries_and_posting',
    '先分别查本月全部支出和本月全部收入，用两次独立查询呈现两组结果。再新增一笔独立支出：今天合成水3元人民币，备注“合成多组统计”。记账后两组统计都要包含本次变化。'
  );
  const cards = new Map();
  const turn = multiple.messages.slice(
    multiple.messages.findLastIndex((message) => message.role === 'user') + 1
  );
  for (const part of turn.flatMap((message) => message.parts)) {
    if (part.type !== 'tool-call') continue;
    let value;
    try {
      value =
        typeof part.output === 'string' ? JSON.parse(part.output) : part.output;
    } catch {
      continue;
    }
    if (value?.type === 'ledger_query') cards.set(value.id, value);
    for (const update of value?.queryUpdates ?? [])
      cards.set(update.id, update.result);
  }
  assert.ok(
    [...cards.values()].some(
      (query) =>
        query?.query.scope === 'spending' &&
        query.report.totals.expense === 6200
    )
  );
  assert.ok(
    [...cards.values()].some(
      (query) =>
        query?.query.scope === 'income' && query.report.totals.income === 0
    )
  );
  assert.equal((await entries()).total, 4);
  assert.equal((await entries()).totals.expense, 6200);
  verified.push(stage);
  for (const [name, text] of [
    ['confirmation_after_queries', '确认，记上吧。'],
    ['ordinary_chat_after_posting', '谢谢，今天到这里。'],
    ['confirmation_after_unrelated_chat', '确认，记上吧。'],
  ]) {
    const before = modelCalls;
    await say(name, text);
    if (name !== 'ordinary_chat_after_posting')
      assert.equal(modelCalls, before);
    assert.equal((await entries()).total, 4);
    assert.equal((await entries()).totals.expense, 6200);
    assert.ok((await drafts()).every((draft) => draft.status === 'posted'));
    verified.push(stage);
  }
  console.log(
    JSON.stringify({
      result: 'passed',
      verified,
      modelCalls,
      intentCalls,
      statuses,
      storage: 'ephemeral_local',
      personalLedgerTouched: false,
    })
  );
} catch {
  console.error(
    JSON.stringify({
      result: 'failed',
      stage,
      verified,
      modelCalls,
      intentCalls,
      statuses,
      details: 'Redacted; no response bodies or private configuration logged.',
    })
  );
  process.exitCode = 1;
} finally {
  await local?.runtime.dispose();
}
