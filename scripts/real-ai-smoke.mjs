import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { Response as WorkerResponse } from 'miniflare';
import { createTestRuntime } from './test-runtime.mjs';

if (process.env.MONI_REAL_AI_SMOKE !== '1') {
  console.log(
    'Skipped: set MONI_REAL_AI_SMOKE=1 for private synthetic AI integration.'
  );
  process.exit(0);
}

// Explicit opt-in only: synthetic data and ephemeral local storage, no raw errors.
let runtime;
let stage = 'private_configuration';
const providerStatuses = [];
const applicationStatuses = [];
const providerContentTypes = [];
const streamTypes = new Set();
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
  let calls = 0;
  stage = 'local_runtime';
  const local = await createTestRuntime({
    ai,
    provider: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, endpoint.origin);
      assert.equal(request.method, 'POST');
      assert.ok(url.pathname.endsWith('/chat/completions'));
      calls++;
      const response = await fetch(url, {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
      providerStatuses.push(response.status);
      providerContentTypes.push(
        response.headers.get('Content-Type')?.split(';')[0]
      );
      return new WorkerResponse(response.body, {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  runtime = local.runtime;
  const threadId = crypto.randomUUID();
  const headers = {
    'Content-Type': 'application/json',
    'Cf-Access-Jwt-Assertion': local.ownerToken,
  };
  async function turn(text) {
    const response = await runtime.dispatchFetch(
      'https://moni.test/api/probe',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          datasetId: 'initial',
          threadId,
          runId: crypto.randomUUID(),
          text,
        }),
      }
    );
    applicationStatuses.push(response.status);
    assert.equal(response.status, 200);
    const stream = await response.text();
    for (const match of stream.matchAll(/"type"\s*:\s*"([A-Z_]+)"/g))
      streamTypes.add(match[1]);
    assert.ok(stream.includes('RUN_FINISHED') && !stream.includes('RUN_ERROR'));
    assert.ok(!stream.includes(ai.AI_API_KEY));
    const events = stream
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)));
    return {
      stream,
      text: events
        .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
        .map((event) => event.delta ?? '')
        .join(''),
    };
  }
  stage = 'real_stream_and_tool';
  const first = await turn(
    'Synthetic test only: lunch amount 35, note s0-synthetic-note. Call preview_expense with those exact values, then describe the preview. Do not save a ledger entry.'
  );
  assert.ok(first.stream.includes('preview_expense'));
  stage = 'real_follow_up';
  const second = await turn(
    'Without calling a tool, repeat the exact note from my previous synthetic expense.'
  );
  assert.ok(second.text.includes('s0-synthetic-note'));
  stage = 'restore_and_storage';
  const restored = await runtime.dispatchFetch(
    `https://moni.test/api/probe?threadId=${threadId}`,
    { headers }
  );
  assert.equal(restored.status, 200);
  const history = await restored.text();
  assert.ok(history.includes('preview_expense'));
  assert.ok(history.includes('s0-synthetic-note'));
  assert.ok(!history.includes(ai.AI_API_KEY));
  const runs = await local.db
    .prepare('SELECT status FROM chat_runs WHERE thread_id = ?')
    .bind(threadId)
    .all();
  assert.equal(runs.results.length, 2);
  assert.ok(runs.results.every((run) => run.status === 'completed'));
  console.log(
    JSON.stringify({
      result: 'passed',
      realProviderRequests: calls,
      verified: [
        'owner_api',
        'stream',
        'tool',
        'note',
        'follow_up',
        'D1_restore',
        'DO',
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
      providerContentTypes,
      applicationStatuses,
      streamTypes: [...streamTypes],
    })
  );
  process.exitCode = 1;
} finally {
  await runtime?.dispose();
}
