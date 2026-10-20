import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { Response as WorkerResponse } from 'miniflare';
import { createTestRuntime } from './test-runtime.mjs';

if (process.env.MONI_REAL_WECHAT_CONVERSATION_SMOKE !== '1') {
  console.log(
    'Skipped: opt in with MONI_REAL_WECHAT_CONVERSATION_SMOKE=1. Uses a real model with synthetic WeChat transport and an isolated ephemeral ledger.'
  );
  process.exit(0);
}
process.umask(0o077);
let local;
let stage = 'private_configuration';
const statuses = [];
const replies = [];
const inbox = [];
const verified = [];
let cursor = 0;
let intentCalls = 0;
let modelCalls = 0;
let summaryCalls = 0;
let messageId = 0;
let lastToolResults = [];
let lastToolGroups = [];
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
    wechatSecret: randomBytes(32).toString('hex'),
    provider: async (request) => {
      const url = new URL(request.url);
      if (
        url.origin === endpoint.origin &&
        url.pathname.endsWith('/chat/completions') &&
        request.method === 'POST'
      ) {
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
          summaryCalls++;
        else if (
          input.tools?.some(
            (tool) => tool.function.name === 'classify_draft_confirmation'
          )
        )
          intentCalls++;
        else {
          modelCalls++;
          const turn = input.messages.slice(
            input.messages.findLastIndex((message) => message.role === 'user') +
              1
          );
          lastToolGroups = turn
            .filter((message) => message.role === 'assistant')
            .map((message) =>
              (message.tool_calls ?? [])
                .map((call) => call.function.name)
                .filter((name) =>
                  [
                    'get_ledger_context',
                    'prepare_draft',
                    'query_ledger',
                  ].includes(name)
                )
            )
            .filter((group) => group.length);
          lastToolResults = turn
            .filter((message) => message.role === 'tool')
            .flatMap((message) => {
              try {
                const result = JSON.parse(message.content);
                if (result.type === 'ledger_query')
                  return [
                    {
                      kind: 'query',
                      total: result.report.totals.netExpense,
                      matched: result.report.total,
                    },
                  ];
                if (result.draftId)
                  return [
                    {
                      kind: 'draft',
                      status: result.status,
                      total: result.totalBaseAmount,
                    },
                  ];
              } catch {
                /* Only synthetic structured financial results are recorded. */
              }
              return [];
            });
        }
        console.log(
          JSON.stringify({
            progress: stage,
            modelCalls,
            intentCalls,
            summaryCalls,
          })
        );
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
      }
      assert.equal(url.origin, 'https://ilinkai.weixin.qq.com');
      if (url.pathname.endsWith('/get_bot_qrcode'))
        return WorkerResponse.json({
          qrcode: 'synthetic-login',
          qrcode_img_content: 'https://weixin.qq.com/synthetic-login',
        });
      if (url.pathname.endsWith('/get_qrcode_status'))
        return WorkerResponse.json({
          status: 'confirmed',
          bot_token: 'synthetic-not-a-secret',
          ilink_bot_id: 'synthetic-bot',
          ilink_user_id: 'synthetic-user',
          baseurl: 'https://ilinkai.weixin.qq.com',
        });
      if (url.pathname.endsWith('/getupdates'))
        return WorkerResponse.json({
          ret: 0,
          msgs: inbox.splice(0),
          get_updates_buf: `synthetic-cursor-${cursor++}`,
        });
      assert.ok(url.pathname.endsWith('/sendmessage'));
      const { msg } = await request.json();
      const text = msg.item_list.map((item) => item.text_item.text).join('\n');
      assert.ok(!text.includes(ai.AI_API_KEY));
      replies.push(text);
      return WorkerResponse.json({ ret: 0 });
    },
  });
  async function api(path, body) {
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
    return response.json();
  }
  async function until(predicate) {
    const deadline = Date.now() + 90000;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline);
      await delay(100);
    }
  }
  function inbound(text) {
    return {
      message_id: `synthetic-${++messageId}`,
      create_time_ms: Date.now(),
      from_user_id: 'synthetic-user',
      to_user_id: 'synthetic-bot',
      message_type: 1,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
      context_token: 'synthetic-context-not-a-secret',
    };
  }
  async function send(text) {
    // Consent must be later than the preceding preview's acknowledged send tick.
    await delay(5);
    const count = replies.length;
    const message = inbound(text);
    inbox.push(message);
    await until(() => replies.length > count);
    return message;
  }
  stage = 'synthetic_channel';
  await api('initialize', {
    datasetId: 'initial',
    operationId: crypto.randomUUID(),
    primaryCurrency: 'CNY',
    timeZone: 'Asia/Shanghai',
  });
  const login = await api('wechat/connect', {
    datasetId: 'initial',
    locale: 'zh',
  });
  const channel = await api('wechat/check', {
    datasetId: 'initial',
    loginId: login.loginId,
  });
  assert.equal(channel.phase, 'connected');
  const threadId = channel.threadId;
  const entries = () => api('entries');
  const drafts = async () => (await api(`drafts?threadId=${threadId}`)).items;
  const editable = async () =>
    (await drafts()).filter((draft) =>
      ['ready', 'needs_details'].includes(draft.status)
    );
  async function scenario() {
    if (process.argv.includes('--details')) {
      const date = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      await api('entries', {
        datasetId: 'initial',
        operationId: crypto.randomUUID(),
        id: crypto.randomUUID(),
        kind: 'expense',
        name: '合成肯德基午餐',
        amount: '35',
        currency: 'CNY',
        date,
        categoryId: 'expense-food',
        tags: ['合成外卖'],
        note: '在肯德基吃的 · synthetic-details-only',
      });
      stage = 'summary_before_details';
      await send('看一下我今天花了多少钱');
      assert.ok(replies.at(-1).includes('35.00'));
      stage = 'posted_entry_details';
      await send('具体的账目给我看一下');
      assert.ok(!replies.at(-1).includes('没有待确认草稿'));
      assert.ok(replies.at(-1).includes('合成肯德基午餐'));
      assert.ok(replies.at(-1).includes('在肯德基吃的'));
      assert.equal((await entries()).length, 1);
      verified.push(stage);
      stage = 'explicit_empty_drafts';
      await send('还有哪些没入账的草稿');
      assert.ok(replies.at(-1).includes('没有待确认草稿'));
      verified.push(stage);
      stage = 'details_with_pending_draft';
      await send(
        '新增一笔合成车费8元人民币，备注 synthetic-pending-only，先作为待确认草稿。'
      );
      assert.equal((await editable()).length, 1);
      await send('列出今天已入账的具体账目和备注');
      assert.ok(replies.at(-1).includes('合成肯德基午餐'));
      assert.ok(replies.at(-1).includes('在肯德基吃的'));
      assert.equal((await entries()).length, 1);
      assert.equal((await editable()).length, 1);
      verified.push(stage);
      return;
    }
    if (process.argv.includes('--mixed')) {
      stage = 'empty_confirmation';
      const beforeEmpty = modelCalls;
      await send('确认，记上吧。');
      assert.equal(modelCalls, beforeEmpty);
      assert.equal((await entries()).length, 0);
      assert.equal((await drafts()).length, 0);
      assert.ok(replies.at(-1).includes('没有待确认草稿'));
      verified.push(stage);
      stage = 'mixed_review_and_query';
      await send(
        '2026年10月18日合成午餐35元人民币，备注 MONI_MIXED_1019。记下来，并查一下2026年10月18日备注包含 MONI_MIXED_1019 的已入账总支出。'
      );
      assert.equal((await entries()).length, 0);
      assert.equal((await editable()).length, 1);
      assert.ok(replies.at(-1).includes('已整理为草稿'));
      assert.ok(replies.at(-1).includes('35.00'));
      assert.ok(replies.at(-1).includes('📊 **'));
      assert.ok(replies.at(-1).includes('未找到匹配记录'));
      verified.push('mixed_review_and_query', 'draft_excluded_from_query');
      stage = 'mixed_natural_confirmation';
      await send('核对过了，这笔可以入账。');
      assert.equal((await entries()).length, 1);
      assert.equal((await editable()).length, 0);
      assert.ok(replies.at(-1).includes('已入账'));
      verified.push('mixed_natural_confirmation');
      const policy = await api('posting-policy');
      await api('posting-policy', {
        datasetId: 'initial',
        operationId: crypto.randomUUID(),
        version: policy.version,
        mode: 'automatic',
        confirmed: true,
      });
      stage = 'mixed_automatic_and_query';
      await send(
        '新增独立支出：2026年10月18日合成公交12元人民币，备注 MONI_MIXED_1019。先完成记账，再查一下2026年10月18日备注包含 MONI_MIXED_1019 的已入账总支出。'
      );
      assert.equal((await entries()).length, 2);
      assert.ok(replies.at(-1).includes('已入账'));
      assert.ok(replies.at(-1).includes('12.00'));
      assert.ok(replies.at(-1).includes('📊 **'));
      assert.ok(replies.at(-1).includes('47.00'));
      verified.push('mixed_automatic_and_query');
      stage = 'mixed_query_followup';
      await send('那按类目分一下，保留刚才的日期和备注筛选。');
      assert.ok(replies.at(-1).includes('📊 **'));
      assert.ok(replies.at(-1).includes('47.00'));
      assert.equal((await entries()).length, 2);
      assert.equal((await editable()).length, 0);
      verified.push('mixed_query_followup');
      for (const [name, text] of [
        ['confirmation_after_queries', '确认，记上吧。'],
        ['ordinary_chat_after_posting', '谢谢，今天到这里。'],
        ['confirmation_after_unrelated_chat', '确认，记上吧。'],
      ]) {
        stage = name;
        const before = modelCalls;
        await send(text);
        if (name !== 'ordinary_chat_after_posting') {
          assert.equal(modelCalls, before);
          assert.ok(replies.at(-1).includes('没有待确认草稿'));
        }
        const posted = await entries();
        assert.equal(posted.length, 2);
        assert.equal(
          posted.reduce((total, entry) => total + entry.baseMinor, 0),
          4700
        );
        assert.equal((await editable()).length, 0);
        verified.push(stage);
      }
      stage = 'multiple_queries_and_posting';
      await send(
        '先分别查询2026年10月18日备注包含 MONI_MIXED_1019 的全部支出和全部收入，用两次独立查询分别呈现两组统计。再新增一笔独立支出：2026年10月18日合成水5元人民币，备注 MONI_MIXED_1019。记账后两组统计都要包含本次变化。'
      );
      assert.equal((await entries()).length, 3);
      assert.equal((await editable()).length, 0);
      assert.ok(replies.at(-1).includes('已入账'));
      assert.ok(replies.at(-1).includes('净支出：¥52.00'));
      assert.ok(replies.at(-1).includes('未找到匹配记录'));
      assert.equal(replies.at(-1).match(/📊 \*\*/g)?.length, 2);
      verified.push('multiple_queries_and_posting');
      return;
    }
    stage = 'continuous_expenses';
    inbox.push(
      inbound(
        '2026年10月18日自动测试午餐花了11元人民币，备注 MONI_AUTO_1019_午餐。'
      ),
      inbound(
        '再新增一笔独立的支出：2026年10月18日自动测试地铁22元人民币，备注 MONI_AUTO_1019_地铁。'
      )
    );
    await until(
      async () => (await drafts()).length === 2 && replies.length >= 2
    );
    const pending = await drafts();
    assert.ok(pending.every((draft) => draft.status === 'ready'));
    assert.deepEqual(
      pending
        .flatMap((draft) => draft.items.map((item) => item.originalMinor))
        .sort(),
      [1100, 2200]
    );
    assert.ok(
      pending.every((draft) =>
        draft.items[0].note.startsWith('MONI_AUTO_1019_')
      )
    );
    assert.equal((await entries()).length, 0);
    stage = 'query_and_pending_reminder';
    await send('统计2026年10月18日备注包含 MONI_AUTO_1019 的已入账总支出。');
    assert.ok(replies.at(-1).includes('待确认草稿'));
    assert.ok(replies.at(-1).includes('不会计入统计'));
    assert.equal((await entries()).length, 0);
    stage = 'batch_review';
    await send('一起核对所有还没入账的草稿。');
    assert.ok(replies.at(-1).includes('批量核对'));
    assert.ok(replies.at(-1).includes('¥11.00'));
    assert.ok(replies.at(-1).includes('¥22.00'));
    assert.equal((await entries()).length, 0);
    stage = 'natural_batch_confirmation';
    const confirmation = await send('都没问题，全部确认入账。');
    assert.ok(replies.at(-1).includes('已入账'));
    assert.equal((await entries()).length, 2);
    assert.ok((await drafts()).every((draft) => draft.status === 'posted'));
    stage = 'duplicate_delivery';
    const callsBeforeReplay = intentCalls + modelCalls;
    const repliesBeforeReplay = replies.length;
    inbox.push(confirmation);
    await delay(2500);
    assert.equal(intentCalls + modelCalls, callsBeforeReplay);
    assert.equal(replies.length, repliesBeforeReplay);
    assert.equal((await entries()).length, 2);
    stage = 'repeated_confirmation';
    await send('确认，记上吧。');
    assert.equal((await entries()).length, 2);
    stage = 'continuous_queries';
    await send('统计2026年10月18日备注包含 MONI_AUTO_1019 的已入账总支出。');
    assert.ok(replies.at(-1).includes('33.00'));
    await send('那按类别分一下，其他条件保持刚才的。');
    assert.ok(replies.at(-1).includes('33.00'));
    const stored = await local.db
      .prepare(
        'SELECT message_json FROM chat_messages WHERE thread_id=? ORDER BY position'
      )
      .bind(threadId)
      .all();
    const queries = stored.results
      .map((row) => JSON.parse(row.message_json))
      .filter((message) => message.role === 'tool')
      .flatMap((message) => {
        try {
          const value = JSON.parse(message.content);
          return value.type === 'ledger_query' ? [value] : [];
        } catch {
          return [];
        }
      });
    assert.ok(queries.length >= 3);
    assert.equal(queries.at(-1).report.totals.netExpense, 3300);
    assert.equal(queries.at(-1).query.filters.keyword, 'MONI_AUTO_1019');
    assert.equal(queries.at(-1).query.view, 'categories');
    verified.push(
      'continuous_expenses',
      'editable_notes',
      'pending_reminder',
      'review_without_posting',
      'natural_batch_confirmation',
      'duplicate_delivery',
      'repeated_confirmation',
      'continuous_queries'
    );
    console.log(JSON.stringify({ progress: stage, verified: verified.length }));

    stage = 'refuse_and_revise';
    await send(
      '新增独立支出：2026年10月18日合成咖啡15元人民币，备注 MONI_AUTO_1019_咖啡。'
    );
    const coffee = (await editable())[0];
    assert.equal(coffee.items[0].originalMinor, 1500);
    await send('先别入账，我还要改一下。');
    assert.equal((await entries()).length, 2);
    assert.ok(!replies.at(-1).includes('待确认草稿'));
    await send(
      '把刚才咖啡改成16元，备注改为 MONI_AUTO_1019_修订，不改变其他草稿。'
    );
    let changed = (await editable())[0];
    assert.equal(changed.id, coffee.id);
    assert.ok(changed.version > coffee.version);
    assert.equal(changed.items[0].originalMinor, 1600);
    await send('可以，但金额改为17元。');
    changed = (await editable())[0];
    assert.equal(changed.id, coffee.id);
    assert.equal(changed.items[0].originalMinor, 1700);
    assert.equal((await entries()).length, 2);
    await send('备注改成 MONI_AUTO_1019_确认入账，仅修改备注，先不入账。');
    assert.ok((await editable())[0].items[0].note.includes('确认入账'));
    assert.equal((await entries()).length, 2);
    stage = 'posting_status_question';
    await send('确认了吗？');
    assert.equal((await entries()).length, 2);
    stage = 'confirmation_after_status_question';
    await send('确认');
    if ((await entries()).length === 2) {
      assert.ok(replies.at(-1).includes('17.00'));
      await send('没问题，记下来');
    }
    assert.equal((await entries()).length, 3);
    assert.equal(
      (await entries()).find((entry) => entry.note.includes('确认入账'))
        .baseMinor,
      1700
    );
    assert.equal((await editable()).length, 0);
    verified.push(
      'decline_without_nagging',
      'same_draft_revision',
      'approval_with_edit_does_not_post',
      'quoted_confirmation_in_note',
      'posting_question_does_not_confirm',
      'confirmation_after_posting_status_question'
    );
    console.log(JSON.stringify({ progress: stage, verified: verified.length }));

    stage = 'multi_item_actual_settlement';
    await send(
      '整理成一份新的两笔支出草稿，日期都为2026年10月18日：网站推广20美元，实际结算人民币144元，备注 MONI_AUTO_1019_推广；午饭35元人民币，备注 MONI_AUTO_1019_午饭。'
    );
    const mixed = (await editable())[0];
    assert.equal(mixed.status, 'ready');
    assert.equal(mixed.items.length, 2);
    assert.equal(mixed.totalBaseMinor, 17900);
    const foreign = mixed.items.find((item) => item.currency === 'USD');
    assert.equal(foreign.originalMinor, 2000);
    assert.equal(foreign.baseMinor, 14400);
    assert.equal(foreign.snapshot.method, 'actual');
    assert.ok(foreign.note.includes('MONI_AUTO_1019_推广'));
    assert.ok(
      mixed.items
        .find((item) => item.currency === 'CNY')
        .note.includes('MONI_AUTO_1019_午饭')
    );
    assert.equal((await entries()).length, 3);
    await send('都没问题，确认这份。');
    assert.equal((await entries()).length, 5);
    verified.push(
      'multi_item_draft',
      'actual_fx_settlement',
      'independent_notes'
    );

    stage = 'missing_amount_and_cancellation';
    await send(
      '新增一笔2026年10月18日合成超市买东西的支出，备注 MONI_AUTO_1019_缺金额，金额我还没说。'
    );
    assert.equal((await entries()).length, 5);
    assert.ok(
      (await editable()).every((draft) => draft.status === 'needs_details')
    );
    await send(
      '刚才合成超市那笔花了8元人民币，日期2026年10月18日，备注 MONI_AUTO_1019_补齐。'
    );
    const completed = (await editable())[0];
    assert.equal(completed.status, 'ready');
    assert.equal(completed.items[0].originalMinor, 800);
    await api('drafts/cancel', {
      datasetId: 'initial',
      operationId: crypto.randomUUID(),
      id: completed.id,
      version: completed.version,
      confirmed: true,
    });
    await send('确认');
    assert.equal((await entries()).length, 5);
    assert.equal((await editable()).length, 0);
    assert.equal(
      (await drafts()).find((draft) => draft.id === completed.id).status,
      'cancelled'
    );
    verified.push(
      'missing_amount',
      'amount_followup',
      'cancelled_draft_not_posted'
    );

    stage = 'automatic_permission';
    async function setMode(mode) {
      const policy = await api('posting-policy');
      await api('posting-policy', {
        datasetId: 'initial',
        operationId: crypto.randomUUID(),
        version: policy.version,
        mode,
        confirmed: true,
      });
    }
    await setMode('automatic');
    await send(
      '新增独立支出：2026年10月18日合成公交3元人民币，备注 MONI_AUTO_1019_自动公交。'
    );
    assert.equal((await entries()).length, 6);
    assert.ok(replies.at(-1).includes('已入账'));
    await send(
      '新增独立支出：2026年10月18日网站推广5美元，实际结算人民币36元，备注 MONI_AUTO_1019_自动外币。'
    );
    assert.equal((await entries()).length, 7);
    await send(
      '新增独立支出：2026年10月18日合成买菜，备注 MONI_AUTO_1019_金额未知，我还不知道花了多少钱。'
    );
    assert.equal((await entries()).length, 7);
    assert.ok(
      (await editable()).every((draft) => draft.status === 'needs_details')
    );
    await setMode('review');
    assert.equal((await api('posting-policy')).mode, 'review');
    assert.equal((await entries()).length, 7);
    verified.push(
      'automatic_cny_posting',
      'automatic_actual_fx_posting',
      'automatic_missing_amount_stays_unposted',
      'restore_review_permission'
    );
    console.log(JSON.stringify({ progress: stage, verified: verified.length }));

    stage = 'requery_after_deletion';
    const bus = (await entries()).find((entry) =>
      entry.note.includes('MONI_AUTO_1019_自动公交')
    );
    await api('entries/delete', {
      datasetId: 'initial',
      operationId: crypto.randomUUID(),
      id: bus.id,
      version: bus.version,
      confirmed: true,
    });
    await send('统计2026年10月18日备注包含 MONI_AUTO_1019 的已入账总支出。');
    assert.ok(replies.at(-1).includes('265.00'));
    await send('那只看美元，别的筛选条件保持刚才的。');
    assert.ok(replies.at(-1).includes('180.00'));
    assert.ok(replies.at(-1).includes('25.00'));
    assert.equal((await entries()).length, 6);
    verified.push(
      'requery_after_soft_delete',
      'currency_filter_followup',
      'original_and_base_totals_separate',
      'same_conversation'
    );
  }
  await scenario();
  assert.equal((await api('wechat')).threadId, threadId);
  assert.ok(statuses.every((status) => status === 200));
  console.log(
    JSON.stringify({
      result: 'passed',
      modelCalls,
      intentCalls,
      summaryCalls,
      statuses,
      replies: replies.length,
      verified,
      model: 'real',
      wechatTransport: 'synthetic',
      storage: 'isolated_ephemeral',
    })
  );
} catch {
  const observations = local
    ? await local.db
        .prepare(`SELECT
          (SELECT count(*) FROM entries WHERE deleted_at IS NULL) AS entries,
          (SELECT count(*) FROM drafts WHERE status='ready') AS readyDrafts,
          (SELECT count(*) FROM drafts WHERE status='needs_details') AS incompleteDrafts,
          (SELECT count(*) FROM chat_runs WHERE status='failed') AS failedRuns`)
        .first()
        .catch(() => null)
    : null;
  console.error(
    JSON.stringify({
      result: 'failed',
      stage,
      modelCalls,
      intentCalls,
      summaryCalls,
      statuses,
      replies: replies.length,
      verified,
      observations,
      lastToolGroups,
      lastToolResults,
      lastReply: {
        posted: Boolean(replies.at(-1)?.includes('已入账')),
        query: Boolean(replies.at(-1)?.includes('📊 **')),
        total47: Boolean(replies.at(-1)?.includes('47.00')),
        review17: Boolean(replies.at(-1)?.includes('17.00')),
        batch: Boolean(replies.at(-1)?.includes('批量核对')),
      },
      model: 'real',
      wechatTransport: 'synthetic',
      storage: 'isolated_ephemeral',
    })
  );
  process.exitCode = 1;
} finally {
  await local?.runtime.dispose();
}
