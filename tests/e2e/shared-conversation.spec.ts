import { expect, test } from '@playwright/test';
import { Response as WorkerResponse } from 'miniflare';
import { startTestServer } from '../../scripts/local-test-server.mjs';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.afterEach(async () => fixture?.close());
const command = () => ({
  datasetId: 'initial',
  operationId: crypto.randomUUID(),
});
const item = (name = 'Synthetic lunch', amount = '35') => ({
  itemId: null,
  kind: 'expense',
  name,
  amount,
  currency: null,
  currencyAmbiguous: false,
  actualBaseAmount: null,
  date: null,
  categoryId: 'expense-food',
  tags: [],
  note: 'Synthetic independent note',
});
const query = {
  inheritPrevious: false,
  period: { kind: 'all_time' },
  scope: 'spending',
  filters: {},
  view: 'summary',
  interval: 'week',
};

async function setup() {
  let intent = 'other';
  let mainCalls = 0;
  let failTranscript = false;
  const replies: { name: string; input: unknown }[] = [];
  fixture = await startTestServer(0, {
    provider: async (request) => {
      const body = (await request.json()) as {
        tools?: { function: { name: string } }[];
      };
      const classifier = body.tools?.some(
        (tool) => tool.function.name === 'classify_draft_confirmation'
      );
      if (!classifier) mainCalls++;
      const tool = classifier
        ? { name: 'classify_draft_confirmation', input: { intent } }
        : replies.shift();
      if (!classifier && !tool && failTranscript) {
        failTranscript = false;
        const db = await fixture.runtime.getD1Database('DB');
        await db.exec(
          "CREATE TRIGGER reject_web_tool_history BEFORE INSERT ON chat_messages WHEN json_extract(NEW.message_json,'$.role')='tool' AND NEW.message_json LIKE '%draftId%' BEGIN SELECT RAISE(ABORT,'Synthetic transcript failure'); END;"
        );
      }
      const delta = tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: crypto.randomUUID(),
                type: 'function',
                function: {
                  name: tool.name,
                  arguments: JSON.stringify(tool.input),
                },
              },
            ],
          }
        : {
            role: 'assistant',
            content: 'See the current drafts and result below.',
          };
      return new WorkerResponse(
        `data: ${JSON.stringify({ id: 'synthetic-shared', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    },
  });
  return {
    replies,
    mainCalls: () => mainCalls,
    failTranscript: () => {
      failTranscript = true;
    },
    classify: (value: string) => {
      intent = value;
    },
  };
}

test('normal chat supports consecutive drafts, reminders, natural batch confirmation and current query cards on both layouts', async ({
  page,
  request,
  isMobile,
}) => {
  const model = await setup();
  await request.post(`${fixture.url}/api/initialize`, {
    data: { ...command(), primaryCurrency: 'CNY', timeZone: 'Asia/Shanghai' },
  });
  await page.goto(fixture.url);
  const input = page.locator('#chat-input');
  const send = async (text: string) => {
    await input.fill(text);
    await page
      .getByRole('button', { name: /^(Send message|发送消息)$/ })
      .click();
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('');
  };
  model.replies.push({
    name: 'prepare_draft',
    input: { draftId: null, version: null, items: [item()] },
  });
  await send('Synthetic lunch35');
  const cards = page.getByRole('article', {
    name: 'Entry draft · 1',
    exact: true,
  });
  await expect(cards).toHaveCount(1);
  model.replies.push({
    name: 'prepare_draft',
    input: {
      draftId: null,
      version: null,
      items: [item('Synthetic water', '9')],
    },
  });
  await send('Another expense water9');
  await expect(cards).toHaveCount(2);
  await expect(
    page.getByText(
      'These drafts in this conversation are not posted or included in statistics. Tell me if you would like to review them together.',
      { exact: true }
    )
  ).toBeVisible();
  await page.locator('[data-slot="app-language-trigger"]:visible').click();
  await page.locator('[data-app-language="zh"]').click();
  model.classify('confirm_all');
  await send('都没问题，全部确认入账');
  await expect(
    page.getByRole('listitem').filter({ hasText: '已入账 · 2 笔' })
  ).toBeVisible();
  await page.locator('[data-slot="app-language-trigger"]:visible').click();
  await page.locator('[data-app-language="en"]').click();
  await expect(cards.filter({ hasText: 'Posted' })).toHaveCount(2);
  const entries = await (
    await request.post(`${fixture.url}/api/entries/query`, { data: {} })
  ).json();
  expect(entries.total).toBe(2);
  expect(entries.totals.expense).toBe(4400);
  const calls = model.mainCalls();
  model.classify('confirm');
  await send('确认啊');
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'There are no pending drafts in this conversation.' })
  ).toBeVisible();
  expect(model.mainCalls()).toBe(calls);
  model.classify('other');
  model.replies.push({ name: 'query_ledger', input: query });
  await send('Show current spending');
  const result = page.getByRole('article', {
    name: 'Ledger query result',
    exact: true,
  });
  await expect(result).toHaveCount(1);
  await expect(result).toContainText('CN¥44.00');
  for (const text of ['Confirm again', 'Confirm after a chat detour']) {
    if (text === 'Confirm after a chat detour') {
      model.classify('other');
      await send('Thank you');
    }
    const callsAfterChat = model.mainCalls();
    model.classify('confirm');
    await send(text);
    await expect(
      page.getByRole('listitem').filter({
        hasText: 'There are no pending drafts in this conversation.',
      })
    ).toHaveCount(text === 'Confirm again' ? 2 : 3);
    expect(model.mainCalls()).toBe(callsAfterChat);
    expect(
      (
        await (
          await request.post(`${fixture.url}/api/entries/query`, { data: {} })
        ).json()
      ).total
    ).toBe(2);
  }
  await page.reload();
  await expect(cards.filter({ hasText: 'Posted' })).toHaveCount(2);
  await expect(result).toHaveCount(1);
  await expect(result).toContainText('CN¥44.00');
  if (isMobile) await page.setViewportSize({ width: 320, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
});

test('an empty conversation cannot post a bare confirmation and can still accept a new expense on both layouts', async ({
  page,
  request,
}) => {
  const model = await setup();
  await request.post(`${fixture.url}/api/initialize`, {
    data: { ...command(), primaryCurrency: 'CNY', timeZone: 'Asia/Shanghai' },
  });
  await page.goto(fixture.url);
  const input = page.locator('#chat-input');
  model.classify('confirm');
  await input.fill('Confirm and post');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toBeEnabled();
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'There are no pending drafts in this conversation.' })
  ).toHaveCount(1);
  expect(model.mainCalls()).toBe(0);
  model.classify('other');
  model.replies.push({
    name: 'prepare_draft',
    input: { draftId: null, version: null, items: [item()] },
  });
  await input.fill('A new lunch35');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toBeEnabled();
  await expect(
    page.getByRole('article', { name: 'Entry draft · 1', exact: true })
  ).toHaveCount(1);
  expect(
    (
      await (
        await request.post(`${fixture.url}/api/entries/query`, { data: {} })
      ).json()
    ).total
  ).toBe(0);
});

test('normal draft review warns about possible duplicate items and explicitly excludes incomplete drafts on both layouts', async ({
  page,
  request,
}) => {
  const model = await setup();
  await request.post(`${fixture.url}/api/initialize`, {
    data: { ...command(), primaryCurrency: 'CNY', timeZone: 'Asia/Shanghai' },
  });
  const threadId = crypto.randomUUID();
  await request.post(`${fixture.url}/api/conversations`, {
    data: { ...command(), id: threadId },
  });
  for (const items of [
    [item(), item('Another same-day meal', '35.00')],
    [{ ...item('Unknown amount'), amount: null }],
  ]) {
    const current = await (
      await request.get(`${fixture.url}/api/conversations/${threadId}`)
    ).json();
    model.replies.push({
      name: 'prepare_draft',
      input: { draftId: null, version: null, items },
    });
    const response = await request.post(`${fixture.url}/api/chat`, {
      data: {
        datasetId: 'initial',
        threadId,
        version: current.version,
        runId: crypto.randomUUID(),
        text: 'Synthetic new independent items',
      },
    });
    expect(await response.text()).toContain('RUN_FINISHED');
  }
  await page.goto(`${fixture.url}/?view=chat&thread=${threadId}`);
  await expect(
    page.getByText(
      'Some entries have the same date, currency and amount and may be duplicates. Check them and tell me first if changes are needed.',
      { exact: true }
    )
  ).toBeVisible();
  await expect(
    page.getByText('2 pending drafts · 3 entries', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(
      'Incomplete drafts cannot be posted. Complete their details first; other complete drafts can be confirmed separately.',
      { exact: true }
    )
  ).toBeVisible();
  model.classify('confirm_all');
  await page.locator('#chat-input').fill('Confirm all');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('#chat-input')).toBeEnabled();
  await expect(
    page.getByRole('article', { name: 'Entry draft · 2', exact: true })
  ).toContainText('Posted');
  const result = await (
    await request.post(`${fixture.url}/api/entries/query`, { data: {} })
  ).json();
  expect(result.total).toBe(2);
  expect(result.totals.expense).toBe(7000);
  await expect(
    page.getByRole('article', { name: 'Entry draft · 1', exact: true })
  ).toContainText('Needs details');
});

test('a stale batch reports a competing posting and re-reviews only the remainder on both layouts', async ({
  page,
  request,
}) => {
  const model = await setup();
  await request.post(`${fixture.url}/api/initialize`, {
    data: { ...command(), primaryCurrency: 'CNY', timeZone: 'Asia/Shanghai' },
  });
  await page.goto(fixture.url);
  const input = page.locator('#chat-input');
  const send = async (text: string) => {
    await input.fill(text);
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(input).toBeEnabled();
  };
  const cards = page.getByRole('article', {
    name: 'Entry draft · 1',
    exact: true,
  });
  for (const [index, name] of [
    'Synthetic lunch',
    'Synthetic water',
  ].entries()) {
    model.replies.push({
      name: 'prepare_draft',
      input: {
        draftId: null,
        version: null,
        items: [item(name, index === 0 ? '35' : '9')],
      },
    });
    await send(name);
    await expect(cards).toHaveCount(index + 1);
  }
  const threadId = new URL(page.url()).searchParams.get('thread');
  expect(threadId).toBeTruthy();
  const drafts = await (
    await request.get(`${fixture.url}/api/drafts?threadId=${threadId}`)
  ).json();
  const calls = model.mainCalls();
  model.classify('decline');
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/chat', async (route) => {
    entered();
    await gate;
    await route.continue();
  });
  try {
    await input.fill('Do not post these drafts yet');
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await pending;
    expect(
      (
        await request.post(`${fixture.url}/api/drafts/confirm`, {
          data: {
            ...command(),
            id: drafts.items[0].id,
            version: drafts.items[0].version,
            confirmed: true,
          },
        })
      ).status()
    ).toBe(200);
  } finally {
    release();
  }
  await expect(input).toBeEnabled();
  await page.unroute('**/api/chat');
  await expect(
    page.getByRole('listitem').filter({
      hasText:
        'Some selected entries are already posted. No posted entries were changed, and any remaining drafts are kept. Edit or undo posted entries in Entries.',
    })
  ).toBeVisible();
  await expect(
    cards.filter({
      has: page.getByRole('heading', {
        name: 'Posted · 1 entries',
        exact: true,
      }),
    })
  ).toHaveCount(1);
  expect(model.mainCalls()).toBe(calls);
  const entries = async () =>
    (
      await request.post(`${fixture.url}/api/entries/query`, { data: {} })
    ).json();
  expect((await entries()).total).toBe(1);
  model.classify('confirm');
  await send('Confirm only the remaining draft');
  expect((await entries()).total).toBe(1);
  await send('I checked it, confirm');
  await expect(
    cards.filter({
      has: page.getByRole('heading', {
        name: 'Posted · 1 entries',
        exact: true,
      }),
    })
  ).toHaveCount(2);
  expect((await entries()).total).toBe(2);
  expect((await entries()).totals.expense).toBe(4400);
  await page.reload();
  await expect(
    cards.filter({
      has: page.getByRole('heading', {
        name: 'Posted · 1 entries',
        exact: true,
      }),
    })
  ).toHaveCount(2);
  expect((await entries()).total).toBe(2);
});

test('same-turn automatic posting replaces every earlier query card and survives reload on both layouts', async ({
  page,
  request,
}) => {
  const model = await setup();
  await request.post(`${fixture.url}/api/initialize`, {
    data: { ...command(), primaryCurrency: 'CNY', timeZone: 'Asia/Shanghai' },
  });
  const policy = await (
    await request.get(`${fixture.url}/api/posting-policy`)
  ).json();
  await request.post(`${fixture.url}/api/posting-policy`, {
    data: {
      ...command(),
      version: policy.version,
      mode: 'automatic',
      confirmed: true,
    },
  });
  model.replies.push(
    { name: 'query_ledger', input: query },
    { name: 'query_ledger', input: { ...query, scope: 'income' } },
    {
      name: 'prepare_draft',
      input: { draftId: null, version: null, items: [item()] },
    }
  );
  await page.goto(fixture.url);
  const input = page.getByLabel('Add an entry, or ask your ledger…', {
    exact: true,
  });
  await input.fill('Synthetic lunch35 and current total');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toBeEnabled();
  const result = page.getByRole('article', {
    name: 'Ledger query result',
    exact: true,
  });
  await expect(result).toHaveCount(2);
  await expect(result.nth(0)).toContainText('CN¥35.00');
  await expect(result.nth(1)).toContainText('Income');
  await page.reload();
  await expect(result).toHaveCount(2);
  await expect(result.nth(0)).toContainText('CN¥35.00');
  await expect(result.nth(1)).toContainText('Income');
  const entries = await (
    await request.post(`${fixture.url}/api/entries/query`, { data: {} })
  ).json();
  expect(entries.total).toBe(1);
});

test('a saved automatic entry survives transcript failure with a clear receipt and no unsafe retry on both layouts', async ({
  page,
  request,
}) => {
  const model = await setup();
  await request.post(`${fixture.url}/api/initialize`, {
    data: { ...command(), primaryCurrency: 'CNY', timeZone: 'Asia/Shanghai' },
  });
  const policy = await (
    await request.get(`${fixture.url}/api/posting-policy`)
  ).json();
  await request.post(`${fixture.url}/api/posting-policy`, {
    data: {
      ...command(),
      version: policy.version,
      mode: 'automatic',
      confirmed: true,
    },
  });
  model.replies.push(
    { name: 'query_ledger', input: query },
    {
      name: 'prepare_draft',
      input: { draftId: null, version: null, items: [item()] },
    }
  );
  model.failTranscript();
  await page.goto(fixture.url);
  await page.locator('#chat-input').fill('Synthetic lunch35 and statistics');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const notice = page.getByText(
    'This reply did not finish, but the ledger changes were saved. Review the drafts or posted entries below; this bookkeeping step will not be replayed.',
    { exact: true }
  );
  await expect(notice).toBeVisible();
  await expect(
    page.getByRole('article', { name: 'Entry draft · 1', exact: true })
  ).toContainText('Posted');
  await expect(
    page.getByRole('button', { name: 'Retry this message', exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByRole('article', { name: 'Ledger query result', exact: true })
  ).toHaveCount(0);
  const calls = model.mainCalls();
  await page.reload();
  await expect(notice).toBeVisible();
  expect(model.mainCalls()).toBe(calls);
  const entries = await (
    await request.post(`${fixture.url}/api/entries/query`, { data: {} })
  ).json();
  expect(entries.total).toBe(1);
  expect(entries.totals.expense).toBe(3500);
});
