import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { isDeepStrictEqual, parseEnv } from 'node:util';
import { Response as WorkerResponse } from 'miniflare';
import { createTestRuntime } from './test-runtime.mjs';

if (process.env.MONI_REAL_DRAFT_SMOKE !== '1') {
  console.log(
    'Skipped: set MONI_REAL_DRAFT_SMOKE=1 for private synthetic draft integration.'
  );
  process.exit(0);
}
let runtime;
let stage = 'private_configuration';
const providerStatuses = [];
const applicationStatuses = [];
let quoteCalls = 0;
let checks = {};
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
      if (url.origin === 'https://api.frankfurter.dev') {
        quoteCalls++;
        assert.equal(request.method, 'GET');
        assert.deepEqual([...url.searchParams.keys()].sort(), [
          'base',
          'date',
          'quotes',
        ]);
        return WorkerResponse.json([
          {
            base: 'EUR',
            quote: 'USD',
            rate: 1.25,
            date: url.searchParams.get('date'),
          },
          {
            base: 'EUR',
            quote: 'CNY',
            rate: 9,
            date: url.searchParams.get('date'),
          },
        ]);
      }
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
    applicationStatuses.push({
      path: path.split('?')[0],
      status: response.status,
    });
    return response;
  }
  async function readTrace(threadId, label, expected) {
    const trace = await (await api(`chat?threadId=${threadId}`)).json();
    const tools = trace.messages
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === 'tool-call')
      .map((part) => {
        let args = {};
        try {
          const value =
            typeof part.arguments === 'string'
              ? JSON.parse(part.arguments)
              : part.arguments;
          if (value && typeof value === 'object' && !Array.isArray(value))
            args = value;
        } catch {
          /* Shape only. */
        }
        const rows = Array.isArray(args.items) ? args.items : [];
        const output = JSON.stringify(part.output ?? null);
        return {
          name: [
            'get_ledger_context',
            'prepare_draft',
            'query_ledger',
          ].includes(part.name)
            ? part.name
            : 'unrecognized',
          state: [
            'input-streaming',
            'input-complete',
            'complete',
            'error',
          ].includes(part.state)
            ? part.state
            : 'other',
          argumentKeys: Object.keys(args).map((key) =>
            ['id', 'draftId', 'version', 'items'].includes(key) ? key : 'other'
          ),
          updating: Boolean(args.draftId),
          itemIdTypes: rows.map((row) => typeof row?.itemId),
          hasLegacyItemId: rows.some(
            (row) => row && typeof row === 'object' && 'id' in row
          ),
          correctDraft: expected ? args.draftId === expected.id : null,
          knownItemIds:
            expected && rows.length
              ? rows.every((row) =>
                  expected.items.some((item) => item.id === row.itemId)
                )
              : null,
          safeErrorCodes: [
            'invalid_draft',
            'invalid_draft_items',
            'draft_changed',
            'draft_closed',
            'invalid_category',
          ].filter((code) => output.includes(code)),
        };
      });
    const run = trace.latestRun;
    checks[label] = {
      status: [
        'running',
        'completed',
        'failed',
        'aborted',
        'interrupted',
      ].includes(run?.status)
        ? run.status
        : 'other',
      errorCode: [
        'ai_unavailable',
        'cancelled',
        'context_limit',
        'interrupted',
        'timed_out',
        'tool_limit',
        null,
      ].includes(run?.errorCode)
        ? run.errorCode
        : 'other',
      tools,
    };
    return tools;
  }
  stage = 'initialize';
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
  const first = {
    datasetId: 'initial',
    threadId,
    version: 1,
    runId: crypto.randomUUID(),
    text: '这是合成联调账目：今天午餐在肯德基吃的35元人民币，网站推广20美元，没有额外备注。请整理成一张两笔的可编辑草稿，保留午餐的肯德基细节，绝对不要正式入账。',
  };
  stage = 'real_draft_tools';
  const response = await api('chat', first);
  assert.equal(response.status, 200);
  const stream = await response.text();
  await readTrace(threadId, 'first');
  assert.ok(stream.includes('RUN_FINISHED') && !stream.includes('RUN_ERROR'));
  assert.ok(!stream.includes(ai.AI_API_KEY));
  assert.equal((await api('chat', first)).status, 202);
  stage = 'draft_note_and_conversion';
  const drafts = await (await api(`drafts?threadId=${threadId}`)).json();
  assert.equal(drafts.items.length, 1);
  const draft = drafts.items[0];
  assert.equal(draft.status, 'ready');
  assert.equal(draft.totalBaseMinor, 17900);
  assert.equal(draft.items.length, 2);
  const lunch = draft.items.find((item) => item.currency === 'CNY');
  const promotion = draft.items.find((item) => item.currency === 'USD');
  assert.equal(lunch.originalMinor, 3500);
  assert.ok(lunch.note.includes('肯德基'));
  assert.equal(promotion.originalMinor, 2000);
  assert.equal(promotion.baseMinor, 14400);
  assert.ok(!promotion.note.includes('肯德基'));
  assert.equal((await (await api('entries/query', {})).json()).total, 0);
  assert.equal(quoteCalls, 1);
  stage = 'real_followup_note_edit';
  const conversation = await (await api(`conversations/${threadId}`)).json();
  const followup = await api('chat', {
    ...first,
    runId: crypto.randomUUID(),
    version: conversation.version,
    text: '把刚才这一张草稿的午餐备注补上“SYNTH_NOTE_1826”，保留原有肯德基细节，其他金额、币种、类目、标签和推广备注保持不变。更新原草稿，仍然不要正式入账。',
  });
  assert.equal(followup.status, 200);
  const followupStream = await followup.text();
  const toolTrace = await readTrace(threadId, 'followup', draft);
  assert.ok(
    followupStream.includes('RUN_FINISHED') &&
      !followupStream.includes('RUN_ERROR')
  );
  assert.ok(!followupStream.includes(ai.AI_API_KEY));
  const updated = await (await api(`drafts?threadId=${threadId}`)).json();
  stage = 'followup_single_draft';
  assert.equal(updated.items.length, 1);
  const revised = updated.items[0];
  checks = {
    ...checks,
    toolTrace,
    sameDraftId: revised.id === draft.id,
    versionBefore: draft.version,
    versionAfter: revised.version,
    itemCount: revised.items.length,
  };
  stage = 'followup_identity';
  assert.equal(revised.id, draft.id);
  stage = 'followup_version';
  assert.equal(revised.version, draft.version + 1);
  stage = 'followup_amount';
  assert.equal(revised.totalBaseMinor, 17900);
  const revisedLunch = revised.items.find((item) => item.id === lunch.id);
  stage = 'followup_lunch_note';
  assert.ok(
    revisedLunch.note.includes('肯德基') &&
      revisedLunch.note.includes('SYNTH_NOTE_1826')
  );
  const revisedPromotion = revised.items.find(
    (item) => item.id === promotion.id
  );
  checks.promotionChangedFields = Object.keys(promotion).filter(
    (key) => !isDeepStrictEqual(revisedPromotion?.[key], promotion[key])
  );
  stage = 'followup_promotion_semantics';
  for (const key of [
    'id',
    'kind',
    'name',
    'currency',
    'date',
    'categoryId',
    'note',
    'conversion',
    'snapshot',
    'missing',
    'baseMinor',
    'originalMinor',
  ])
    assert.deepEqual(revisedPromotion?.[key], promotion[key]);
  assert.deepEqual(
    [...revisedPromotion.tags].sort(),
    [...promotion.tags].sort()
  );
  assert.equal(quoteCalls, 1);
  assert.equal((await (await api('entries/query', {})).json()).total, 0);
  stage = 'explicit_atomic_confirmation';
  assert.equal(
    (
      await api('drafts/confirm', {
        ...command(),
        id: revised.id,
        version: revised.version,
        confirmed: false,
      })
    ).status,
    400
  );
  const confirm = {
    ...command(),
    id: revised.id,
    version: revised.version,
    confirmed: true,
  };
  assert.equal((await api('drafts/confirm', confirm)).status, 200);
  assert.equal((await api('drafts/confirm', confirm)).status, 200);
  const entries = await (await api('entries/query', {})).json();
  assert.equal(entries.total, 2);
  assert.equal(
    entries.items.reduce((total, entry) => total + entry.baseMinor, 0),
    17900
  );
  assert.equal(
    entries.items.find((entry) => entry.id === lunch.id).note,
    revisedLunch.note
  );
  assert.equal(
    entries.items.find((entry) => entry.id === promotion.id).note,
    promotion.note
  );
  console.log(
    JSON.stringify({
      result: 'passed',
      providerStatuses,
      applicationStatuses,
      quoteSource: 'controlled_7_20',
      quoteCalls,
      verified: [
        'real_draft_tool',
        'real_followup_edit',
        'independent_notes',
        'fixed_conversion',
        'no_model_posting',
        'explicit_atomic_confirmation',
        'duplicate_once',
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
      checks,
      providerStatuses,
      applicationStatuses,
      quoteSource: 'controlled_7_20',
      quoteCalls,
      storage: 'ephemeral_local',
    })
  );
  process.exitCode = 1;
} finally {
  await runtime?.dispose();
}
