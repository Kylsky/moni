import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { Response as WorkerResponse } from 'miniflare';
import { createTestRuntime } from './test-runtime.mjs';

if (process.env.MONI_REAL_CONTEXT_SMOKE !== '1') {
  console.log(
    'Skipped: set MONI_REAL_CONTEXT_SMOKE=1 for private synthetic compaction integration.'
  );
  process.exit(0);
}
process.umask(0o077);
let local;
let directory;
let stage = 'private_configuration';
let summaries = 0;
let modelCalls = 0;
const statuses = [];
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
  directory = await mkdtemp(join(tmpdir(), 'moni-synthetic-context-'));
  const options = {
    ai,
    persistencePath: directory,
    provider: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, endpoint.origin);
      assert.ok(url.pathname.endsWith('/chat/completions'));
      const body = await request.text();
      assert.ok(!body.includes(ai.AI_API_KEY));
      const input = JSON.parse(body);
      if (
        input.messages.some(
          (message) =>
            message.role === 'system' &&
            message.content.startsWith('You summarize Moni')
        )
      )
        summaries++;
      else modelCalls++;
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
  };
  local = await createTestRuntime(options);
  async function api(path, body) {
    return local.runtime.dispatchFetch(`https://moni.test/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cf-Access-Jwt-Assertion': local.ownerToken,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const command = () => ({
    datasetId: 'initial',
    operationId: crypto.randomUUID(),
  });
  stage = 'synthetic_history';
  assert.equal(
    (
      await api('initialize', {
        ...command(),
        primaryCurrency: 'CNY',
        timeZone: 'Asia/Shanghai',
      })
    ).status,
    200
  );
  const threadId = crypto.randomUUID();
  assert.equal(
    (await api('conversations', { ...command(), id: threadId })).status,
    200
  );
  const code = 'MONI_COMPACT_6284';
  const history = Array.from({ length: 80 }, (_, index) => ({
    id: crypto.randomUUID(),
    role: 'user',
    content:
      index === 0
        ? `This is synthetic integration data. Remember that my fictional project code is ${code}. Do not create ledger entries. Preserve this reference when summarizing.`
        : `Synthetic non-financial context ${index}. ${'This is synthetic padding for a long conversation, with no additional facts or ledger actions. '.repeat(4)}`,
  }));
  await local.db
    .prepare(
      "INSERT INTO chat_messages(dataset_id,thread_id,position,message_json) SELECT 'initial',?,CAST(key AS INTEGER),value FROM json_each(?)"
    )
    .bind(threadId, JSON.stringify(history))
    .run();
  const input = {
    datasetId: 'initial',
    threadId,
    version: 1,
    runId: crypto.randomUUID(),
    text: 'What fictional project code did I ask you to remember? Reply with the code only. Do not use ledger tools or create drafts.',
  };
  stage = 'real_summary_and_answer';
  async function answer(body) {
    stage = 'model_stream';
    const response = await api('chat', body);
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.ok(stream.includes('RUN_FINISHED') && !stream.includes('RUN_ERROR'));
    assert.ok(!stream.includes(ai.AI_API_KEY));
    const text = stream
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => event.delta ?? '')
      .join('');
    stage = 'answer_reference';
    assert.ok(text.includes(code));
  }
  await answer(input);
  stage = 'summary_checkpoint';
  assert.ok(summaries > 0);
  const checkpoint = await local.db
    .prepare(
      "SELECT value_json FROM chat_metadata WHERE dataset_id='initial' AND namespace='@tanstack/ai-compaction' AND key=?"
    )
    .bind(threadId)
    .first('value_json');
  assert.ok(checkpoint);
  assert.ok(checkpoint.includes(code));
  const firstCount = summaries;
  const calls = modelCalls;
  assert.equal((await api('chat', input)).status, 202);
  assert.equal(modelCalls, calls);
  stage = 'restart_and_same_conversation';
  await local.runtime.dispose();
  local = await createTestRuntime(options);
  await answer({
    ...input,
    version: 2,
    runId: crypto.randomUUID(),
    text: 'Repeat that fictional project code only. No ledger tools or drafts.',
  });
  assert.equal(summaries, firstCount);
  const rows = await local.db
    .prepare(
      "SELECT message_json FROM chat_messages WHERE dataset_id='initial' AND thread_id=? ORDER BY position"
    )
    .bind(threadId)
    .all();
  assert.equal(rows.results.length, history.length + 4);
  assert.deepEqual(
    rows.results
      .slice(0, history.length)
      .map((row) => JSON.parse(row.message_json)),
    history
  );
  assert.equal(
    await local.db
      .prepare('SELECT count(*) AS count FROM entries')
      .first('count'),
    0
  );
  assert.equal(
    await local.db
      .prepare('SELECT count(*) AS count FROM drafts')
      .first('count'),
    0
  );
  const page = await (await api(`chat?threadId=${threadId}`)).json();
  assert.equal(page.conversation.id, threadId);
  assert.equal(page.conversation.version, 3);
  assert.equal(page.page.truncated, true);
  console.log(
    JSON.stringify({
      result: 'passed',
      summaries,
      modelCalls,
      statuses,
      verified: [
        'real_summary',
        'summary_reference_recall',
        'same_conversation',
        'full_history_retained',
        'checkpoint_after_restart',
        'no_replay',
        'no_ledger_or_draft_writes',
        'paged_history',
      ],
      storage: 'isolated_synthetic_temporary',
    })
  );
} catch {
  console.error(
    JSON.stringify({
      result: 'failed',
      stage,
      summaries,
      modelCalls,
      statuses,
      storage: 'isolated_synthetic_temporary',
    })
  );
  process.exitCode = 1;
} finally {
  await local?.runtime.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
}
