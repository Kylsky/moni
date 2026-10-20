import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { Response as WorkerResponse } from 'miniflare';
import { createTestRuntime } from './test-runtime.mjs';

if (process.env.MONI_REAL_CHAT_SMOKE !== '1') {
  console.log(
    'Skipped: set MONI_REAL_CHAT_SMOKE=1 for private synthetic chat integration.'
  );
  process.exit(0);
}
let runtime;
let stage = 'private_configuration';
const providerStatuses = [];
const applicationStatuses = [];
let calls = 0;
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
      assert.equal(request.method, 'POST');
      const bytes = await request.arrayBuffer();
      const input = JSON.parse(new TextDecoder().decode(bytes));
      assert(
        (input.tools ?? []).every((tool) =>
          ['get_ledger_context', 'prepare_draft', 'query_ledger'].includes(
            tool.function.name
          )
        )
      );
      assert.ok(!JSON.stringify(input).includes(ai.AI_API_KEY));
      calls++;
      const response = await fetch(url, {
        method: 'POST',
        headers: request.headers,
        body: bytes,
        redirect: 'manual',
        signal: AbortSignal.timeout(60000),
      });
      providerStatuses.push(response.status);
      return new WorkerResponse(response.body, {
        status: response.status,
        headers: response.headers,
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
  async function api(path, body) {
    const response = await runtime.dispatchFetch(
      `https://moni.test/api/${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }
    );
    applicationStatuses.push({
      path: path.split('?')[0],
      status: response.status,
    });
    return response;
  }
  stage = 'initialize';
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
  const threadId = crypto.randomUUID();
  assert.equal(
    (await api('conversations', { ...command(), id: threadId })).status,
    200
  );
  const first = {
    datasetId: 'initial',
    threadId,
    version: 1,
    runId: crypto.randomUUID(),
    text: 'Synthetic integration only. Remember code SYNTH_MONI_1826. Do not create any ledger entry. Reply briefly.',
  };
  stage = 'first_real_turn';
  const response = await api('chat', first);
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.ok(stream.includes('RUN_FINISHED') && !stream.includes('RUN_ERROR'));
  assert.ok(!stream.includes(ai.AI_API_KEY));
  const events = stream
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  assert.ok(
    events.some((event) => event.type === 'TEXT_MESSAGE_CONTENT' && event.delta)
  );
  stage = 'persisted_history';
  const restored = await (await api(`chat?threadId=${threadId}`)).json();
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.conversation.version, 2);
  assert.equal(restored.activeRun, null);
  assert.equal(restored.runs.at(-1)?.status, 'completed');
  assert.equal((await api('chat', first)).status, 202);
  assert.equal(calls, 1);
  stage = 'real_followup';
  const followup = await api('chat', {
    ...first,
    version: 2,
    runId: crypto.randomUUID(),
    text: 'What synthetic code did I ask you to remember? Reply with that code only. Do not save any ledger entry.',
  });
  assert.equal(followup.status, 200);
  const second = await followup.text();
  assert.ok(second.includes('RUN_FINISHED') && !second.includes('RUN_ERROR'));
  const secondText = second
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
    .map((event) => event.delta ?? '')
    .join('');
  assert.ok(secondText.includes('SYNTH_MONI_1826'));
  assert.ok(!second.includes(ai.AI_API_KEY));
  stage = 'final_persistence';
  const complete = await (await api(`chat?threadId=${threadId}`)).json();
  assert.equal(complete.messages.length, 4);
  assert.equal(new Set(complete.messages.map((message) => message.id)).size, 4);
  assert.equal(complete.conversation.version, 3);
  assert.equal(complete.activeRun, null);
  assert.equal(calls, 2);
  assert.equal(
    await local.db
      .prepare('SELECT count(*) AS count FROM entries')
      .first('count'),
    0
  );
  console.log(
    JSON.stringify({
      result: 'passed',
      providerStatuses,
      applicationStatuses,
      verified: [
        'real_stream',
        'complete_parts',
        'followup_context',
        'accepted_no_replay',
        'no_formal_entries',
        'private_configuration',
      ],
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
      storage: 'ephemeral_local',
    })
  );
  process.exitCode = 1;
} finally {
  await runtime?.dispose();
}
