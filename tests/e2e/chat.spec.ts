import { expect, test } from '@playwright/test';
import { Response as WorkerResponse } from 'miniflare';
import { startTestServer } from '../../scripts/local-test-server.mjs';
import { syntheticOtherIntent } from './fixtures/intent';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
const command = () => ({
  datasetId: 'initial',
  operationId: crypto.randomUUID(),
});
test.afterEach(async () => {
  await fixture?.close();
});

test('pages full saved history on mobile and desktop without duplicate messages or replay', async ({
  page,
  request,
  isMobile,
}) => {
  fixture = await startTestServer();
  await request.post(`${fixture.url}/api/initialize`, {
    data: { ...command(), primaryCurrency: 'CNY', timeZone: 'Asia/Shanghai' },
  });
  const id = crypto.randomUUID();
  await request.post(`${fixture.url}/api/conversations`, {
    data: { ...command(), id },
  });
  const history = Array.from({ length: 120 }, (_, index) => ({
    id: `synthetic-page-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content:
      index === 0
        ? 'Oldest synthetic original note'
        : index === 119
          ? 'Latest synthetic saved answer'
          : `Synthetic saved row ${index}`,
  }));
  const db = await fixture.runtime.getD1Database('DB');
  await db
    .prepare(
      "INSERT INTO chat_messages(dataset_id,thread_id,position,message_json) SELECT 'initial',?,CAST(key AS INTEGER),value FROM json_each(?)"
    )
    .bind(id, JSON.stringify(history))
    .run();
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/chat')
      writes.push(r.url());
  });
  await page.goto(`${fixture.url}/?view=chat&thread=${id}`);
  const main = page.getByRole('main');
  const line = (text: string) =>
    main.getByRole('listitem').filter({ hasText: text });
  await expect(line('Latest synthetic saved answer')).toBeVisible();
  await expect(line('Oldest synthetic original note')).toHaveCount(0);
  await main
    .getByRole('button', { name: 'Load earlier messages', exact: true })
    .click();
  const older = main.getByRole('button', {
    name: 'Load earlier messages',
    exact: true,
  });
  await expect(line('Synthetic saved row 20')).toBeVisible();
  await older.focus();
  await page.keyboard.press('Enter');
  await expect(line('Oldest synthetic original note')).toBeVisible();
  await expect(
    main.getByRole('button', { name: 'Load earlier messages', exact: true })
  ).toHaveCount(0);
  await expect(
    main.getByRole('listitem').filter({
      hasText:
        /Oldest synthetic original note|Latest synthetic saved answer|Synthetic saved row/,
    })
  ).toHaveCount(120);
  expect(writes).toHaveLength(0);
  if (isMobile) await page.setViewportSize({ width: 320, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
});

test('chat sends only current input, restores full history across devices, and retains locale and theme without formal writes', async ({
  page,
  request,
  browser,
  isMobile,
}) => {
  fixture = await startTestServer();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  expect(
    (
      await request.post(`${fixture.url}/api/initialize`, {
        data: { ...command(), primaryCurrency: 'CNY', timeZone: 'UTC' },
      })
    ).status()
  ).toBe(200);
  const posted: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/chat')
      posted.push(JSON.parse(r.postData() ?? '{}'));
  });
  await page.goto(fixture.url);
  await page
    .getByLabel('Add an entry, or ask your ledger…', { exact: true })
    .fill('Synthetic remembered lunch note');
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true })
  ).toHaveCSS('background-color', 'rgb(255, 96, 56)');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page).toHaveURL(/thread=/);
  await expect(
    page
      .getByRole('main')
      .getByRole('listitem')
      .filter({ hasText: 'Saved synthetic conversation reply.' })
  ).toBeVisible();
  const address = page.url();
  expect(posted).toHaveLength(1);
  expect(Object.keys(posted[0]).sort()).toEqual([
    'datasetId',
    'locale',
    'review',
    'runId',
    'text',
    'threadId',
    'version',
  ]);
  expect(posted[0].review).toBeNull();
  expect(posted[0].locale).toBe('en');
  await page.reload();
  await expect(
    page
      .getByRole('main')
      .getByRole('listitem')
      .filter({ hasText: 'Synthetic remembered lunch note' })
  ).toBeVisible();
  await expect(
    page
      .getByRole('main')
      .getByRole('listitem')
      .filter({ hasText: 'Saved synthetic conversation reply.' })
  ).toBeVisible();
  expect(posted).toHaveLength(1);
  const other = await browser.newContext({ locale: 'en' });
  try {
    const second = await other.newPage();
    await second.goto(address);
    await expect(
      second
        .getByRole('main')
        .getByRole('listitem')
        .filter({ hasText: 'Synthetic remembered lunch note' })
    ).toBeVisible();
    await expect(
      second
        .getByRole('main')
        .getByRole('listitem')
        .filter({ hasText: 'Saved synthetic conversation reply.' })
    ).toBeVisible();
  } finally {
    await other.close();
  }
  await page
    .getByLabel('Add an entry, or ask your ledger…', { exact: true })
    .fill('Synthetic followup draft');
  await page.locator('[data-slot="app-language-trigger"]:visible').click();
  await page.locator('[data-app-language="zh"]').click();
  await expect(
    page.getByLabel('记一笔，或问问账本…', { exact: true })
  ).toHaveValue('Synthetic followup draft');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(
    page
      .getByRole('main')
      .getByRole('listitem')
      .filter({ hasText: 'Saved synthetic conversation reply.' })
  ).toHaveCount(2);
  await expect(
    page.getByLabel('记一笔，或问问账本…', { exact: true })
  ).toHaveValue('');
  expect(posted).toHaveLength(2);
  expect(posted[1].text).toBe('Synthetic followup draft');
  expect(posted[1].version).toBe(2);
  expect(posted[1].locale).toBe('zh');
  const data = await (
    await request.post(`${fixture.url}/api/entries/query`, { data: {} })
  ).json();
  expect(data.total).toBe(0);
  if (isMobile) await page.setViewportSize({ width: 320, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  expect(errors).toEqual([]);
});

test('restoring an active conversation shows busy and refreshes persisted output without replaying a model request', async ({
  page,
  request,
}) => {
  let modelCalls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture = await startTestServer(0, {
    provider: async (request) => {
      expect(new URL(request.url).origin).toBe('https://model.invalid');
      const intent = await syntheticOtherIntent(request);
      if (intent) return intent;
      modelCalls++;
      await gate;
      const chunk = {
        id: 'synthetic-busy',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'synthetic-model',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: 'Synthetic busy run completed.',
            },
            finish_reason: 'stop',
          },
        ],
      };
      return new WorkerResponse(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    },
  });
  expect(
    (
      await request.post(`${fixture.url}/api/initialize`, {
        data: { ...command(), primaryCurrency: 'CNY', timeZone: 'UTC' },
      })
    ).status()
  ).toBe(200);
  const id = crypto.randomUUID();
  expect(
    (
      await request.post(`${fixture.url}/api/conversations`, {
        data: { ...command(), id },
      })
    ).status()
  ).toBe(200);
  const response = await fixture.runtime.dispatchFetch(
    'https://moni.test/api/chat',
    {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': fixture.ownerToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        datasetId: 'initial',
        threadId: id,
        version: 1,
        runId: crypto.randomUUID(),
        text: 'Synthetic active input',
      }),
    }
  );
  const completion = response.text();
  try {
    expect(response.status).toBe(200);
    await page.goto(`${fixture.url}/?view=chat&thread=${id}`);
    await expect(
      page
        .getByRole('main')
        .getByRole('listitem')
        .filter({ hasText: 'Synthetic active input' })
    ).toBeVisible();
    await expect(page.getByText(/This conversation is busy/)).toBeVisible();
    await expect(
      page.getByLabel('Add an entry, or ask your ledger…', { exact: true })
    ).toBeDisabled();
    expect(modelCalls).toBe(1);
  } finally {
    release();
  }
  expect(await completion).toContain('RUN_FINISHED');
  await page
    .getByRole('button', { name: 'Refresh conversation history', exact: true })
    .click();
  await expect(
    page
      .getByRole('main')
      .getByRole('listitem')
      .filter({ hasText: 'Synthetic busy run completed.' })
  ).toBeVisible();
  await expect(
    page.getByLabel('Add an entry, or ask your ledger…', { exact: true })
  ).toBeEnabled();
  expect(modelCalls).toBe(1);
});

test('conversation management searches saved history, switches isolated threads and confirms deletion without touching ledger entries', async ({
  page,
  request,
  isMobile,
}) => {
  fixture = await startTestServer();
  await request.post(`${fixture.url}/api/initialize`, {
    data: { ...command(), primaryCurrency: 'CNY', timeZone: 'Asia/Shanghai' },
  });
  const id = crypto.randomUUID();
  await request.post(`${fixture.url}/api/conversations`, {
    data: { ...command(), id },
  });
  const response = await request.post(`${fixture.url}/api/chat`, {
    data: {
      datasetId: 'initial',
      threadId: id,
      version: 1,
      runId: crypto.randomUUID(),
      text: 'Synthetic KFC lunch 35 note',
    },
  });
  expect(await response.text()).toContain('RUN_FINISHED');
  const otherId = crypto.randomUUID();
  await request.post(`${fixture.url}/api/conversations`, {
    data: { ...command(), id: otherId },
  });
  await page.goto(`${fixture.url}/?view=chat&panel=conversations`);
  await expect(
    page.getByRole('heading', { name: 'Conversations', exact: true })
  ).toBeVisible();
  await page
    .getByRole('searchbox', { name: 'Search conversations' })
    .fill('KFC');
  await page
    .getByRole('button', { name: 'Search conversations', exact: true })
    .click();
  await expect(
    page
      .getByRole('main')
      .getByRole('link', { name: /Synthetic KFC lunch 35 note/ })
  ).toBeVisible();
  await expect(
    page
      .getByRole('main')
      .getByRole('list')
      .getByRole('link', { name: /^New chat/ })
  ).toHaveCount(0);
  await page
    .getByRole('main')
    .getByRole('link', { name: /Synthetic KFC lunch 35 note/ })
    .click();
  await expect(
    page
      .getByRole('main')
      .getByRole('listitem')
      .filter({ hasText: 'Synthetic KFC lunch 35 note' })
  ).toBeVisible();
  await page.getByRole('link', { name: 'Conversations', exact: true }).click();
  await page
    .getByRole('button', { name: /Delete conversation · Synthetic KFC/ })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Delete this conversation?' })
  ).toBeVisible();
  await expect(
    dialog.getByText(/posted entries and their notes are kept/)
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Keep', exact: true })
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole('button', { name: /Delete conversation · Synthetic KFC/ })
    .click();
  await dialog
    .getByRole('button', { name: 'Delete conversation', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(
    (await request.get(`${fixture.url}/api/chat?threadId=${id}`)).status()
  ).toBe(404);
  const list = await (
    await request.post(`${fixture.url}/api/conversations/query`, { data: {} })
  ).json();
  expect(list.items.map((item: { id: string }) => item.id)).toEqual([otherId]);
  expect(
    (
      await (
        await request.post(`${fixture.url}/api/entries/query`, { data: {} })
      ).json()
    ).total
  ).toBe(0);
  await page.getByRole('main').locator(`a[href*="thread=${otherId}"]`).click();
  await expect(
    page
      .getByRole('main')
      .getByRole('listitem')
      .filter({ hasText: 'Synthetic KFC lunch 35 note' })
  ).toHaveCount(0);
  await page.locator('[data-slot="app-language-trigger"]:visible').click();
  await page.locator('[data-app-language="zh"]').click();
  await page.getByRole('link', { name: '我的会话', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '我的会话', exact: true })
  ).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  if (isMobile) await page.setViewportSize({ width: 320, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
});

test('explicit stop and retry preserve one accepted user message across devices without automatic replay', async ({
  page,
  request,
}) => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture = await startTestServer(0, {
    provider: async (request) => {
      const intent = await syntheticOtherIntent(request);
      if (intent) return intent;
      calls++;
      if (calls === 1) await gate;
      return new WorkerResponse(
        `data: ${JSON.stringify({ id: 'synthetic-retry', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic explicit retry completed.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    },
  });
  await request.post(`${fixture.url}/api/initialize`, {
    data: { ...command(), primaryCurrency: 'CNY', timeZone: 'UTC' },
  });
  const id = crypto.randomUUID();
  await request.post(`${fixture.url}/api/conversations`, {
    data: { ...command(), id },
  });
  const active = await fixture.runtime.dispatchFetch(
    'https://moni.test/api/chat',
    {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': fixture.ownerToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        datasetId: 'initial',
        threadId: id,
        version: 1,
        runId: crypto.randomUUID(),
        text: 'Synthetic single accepted message',
      }),
    }
  );
  const completion = active.text();
  try {
    await page.goto(`${fixture.url}/?view=chat&thread=${id}`);
    await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
    await expect(
      page.getByText(
        'Reply stopped. Your input is saved. You can explicitly retry this message or send a new one.',
        { exact: true }
      )
    ).toBeVisible();
    expect(calls).toBe(1);
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Retry this message', exact: true })
    ).toBeVisible();
    expect(calls).toBe(1);
    await page
      .getByRole('button', { name: 'Retry this message', exact: true })
      .click();
    await expect(
      page
        .getByRole('main')
        .getByRole('listitem')
        .filter({ hasText: 'Synthetic explicit retry completed.' })
    ).toBeVisible();
    expect(calls).toBe(2);
    await expect(
      page
        .getByRole('main')
        .getByRole('listitem')
        .filter({ hasText: 'Synthetic single accepted message' })
    ).toHaveCount(1);
    const snapshot = await (
      await request.get(`${fixture.url}/api/chat?threadId=${id}`)
    ).json();
    expect(snapshot.messages).toHaveLength(2);
    expect(
      snapshot.messages.filter((item: { role: string }) => item.role === 'user')
    ).toHaveLength(1);
  } finally {
    release();
    await completion.catch(() => {});
  }
});
