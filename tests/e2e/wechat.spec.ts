import { expect, test } from '@playwright/test';
import { Response as WorkerResponse } from 'miniflare';
import { startTestServer } from '../../scripts/local-test-server.mjs';
import { syntheticOtherIntent } from './fixtures/intent';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.afterEach(async () => {
  await fixture?.close();
});
const command = () => ({
  datasetId: 'initial',
  operationId: crypto.randomUUID(),
});

test('disabled WeChat keeps the normal settings usable in both languages and themes', async ({
  page,
  request,
}) => {
  fixture = await startTestServer();
  await request.post(`${fixture.url}/api/initialize`, {
    data: { ...command(), primaryCurrency: 'CNY', timeZone: 'Asia/Shanghai' },
  });
  await page.goto(`${fixture.url}/?view=settings`);
  const permission = page.getByRole('form', {
    name: 'Posting permission',
    exact: true,
  });
  await expect(
    permission.getByRole('radio', { name: /Ask me to confirm/ })
  ).toBeChecked();
  await permission.getByRole('radio', { name: /Post directly/ }).check();
  await permission
    .getByRole('button', { name: 'Save posting permission' })
    .click();
  await expect(permission.getByRole('status')).toHaveText('Settings saved.');
  await page.reload();
  await expect(
    permission.getByRole('radio', { name: /Post directly/ })
  ).toBeChecked();
  await permission.getByRole('radio', { name: /Ask me to confirm/ }).focus();
  await page.keyboard.press('Space');
  await permission
    .getByRole('button', { name: 'Save posting permission' })
    .click();
  await expect(permission.getByRole('status')).toHaveText('Settings saved.');
  const card = page.getByRole('region', { name: 'WeChat entry', exact: true });
  await expect(card.getByText(/has not been enabled/)).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Connect WeChat', exact: true })
  ).toHaveCount(0);
  await page.getByLabel('Language', { exact: true }).selectOption('zh');
  await expect(
    page
      .getByRole('region', { name: '微信入口', exact: true })
      .getByText(/尚未启用/)
  ).toBeVisible();
  await page.locator('[data-slot="theme-switcher-trigger"]').click();
  await page.locator('[data-theme-option="dark"]').click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

test('owner scans, verifies, reviews a WeChat draft on the web, starts a fresh thread and disconnects', async ({
  page,
  request,
}, testInfo) => {
  let verified = false;
  let delivered = false;
  let modelCalls = 0;
  const sent: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  fixture = await startTestServer(0, {
    wechatSecret: '0123456789abcdef'.repeat(4),
    provider: async (req) => {
      const url = new URL(req.url);
      if (url.pathname.includes('/get_bot_qrcode'))
        return WorkerResponse.json({
          qrcode: 'synthetic-ui-qr',
          qrcode_img_content: 'https://weixin.qq.com/synthetic-ui-qr',
        });
      if (url.pathname.includes('/get_qrcode_status')) {
        if (url.searchParams.get('verify_code') === '123456') verified = true;
        return WorkerResponse.json(
          verified
            ? {
                status: 'confirmed',
                bot_token: 'synthetic-ui-token',
                ilink_bot_id: 'synthetic-ui-bot',
                ilink_user_id: 'synthetic-ui-owner',
                baseurl: 'https://ilinkai.weixin.qq.com',
              }
            : { status: 'need_verifycode' }
        );
      }
      if (url.pathname.endsWith('/getupdates')) {
        const msgs = !delivered
          ? [
              {
                message_id: '18446744073709551614',
                from_user_id: 'synthetic-ui-owner',
                to_user_id: 'synthetic-ui-bot',
                message_type: 1,
                message_state: 2,
                context_token: 'synthetic-ui-context',
                item_list: [
                  { type: 1, text_item: { text: 'Synthetic KFC lunch 35' } },
                ],
              },
            ]
          : [];
        delivered = true;
        if (!msgs.length)
          await new Promise((resolve) => setTimeout(resolve, 100));
        return WorkerResponse.json({
          ret: 0,
          msgs,
          get_updates_buf: 'synthetic-ui-cursor',
        });
      }
      if (url.pathname.endsWith('/sendmessage')) {
        const body = (await req.json()) as {
          msg: { item_list: { text_item: { text: string } }[] };
        };
        sent.push(body.msg.item_list[0].text_item.text);
        return WorkerResponse.json({ ret: 0 });
      }
      if (url.origin === 'https://model.invalid') {
        const intent = await syntheticOtherIntent(req);
        if (intent) return intent;
        modelCalls++;
        const input = (await req.json()) as { messages: { role: string }[] };
        const isTool = input.messages.at(-1)?.role !== 'tool';
        const delta = isTool
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: crypto.randomUUID(),
                  type: 'function',
                  function: {
                    name: 'prepare_draft',
                    arguments: JSON.stringify({
                      draftId: null,
                      version: null,
                      items: [
                        {
                          itemId: null,
                          kind: 'expense',
                          name: 'KFC lunch',
                          amount: '35',
                          actualBaseAmount: null,
                          currency: 'CNY',
                          currencyAmbiguous: false,
                          date: '2026-10-18',
                          categoryId: 'expense-food',
                          tags: [],
                          note: 'Synthetic KFC note',
                        },
                      ],
                    }),
                  },
                },
              ],
            }
          : {
              role: 'assistant',
              content: 'Synthetic WeChat draft saved for review.',
            };
        return new WorkerResponse(
          `data: ${JSON.stringify({ id: 'synthetic-ui', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: isTool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      return new WorkerResponse('External network disabled', { status: 502 });
    },
  });
  await request.post(`${fixture.url}/api/initialize`, {
    data: { ...command(), primaryCurrency: 'CNY', timeZone: 'Asia/Shanghai' },
  });
  await page.goto(`${fixture.url}/?view=settings`);
  const card = page.getByRole('region', { name: 'WeChat entry', exact: true });
  await card
    .getByRole('button', { name: 'Connect WeChat', exact: true })
    .click();
  await expect(card.getByAltText('WeChat ClawBot login QR code')).toBeVisible();
  await expect(card.getByLabel('Phone verification code')).toBeVisible();
  await card.getByLabel('Phone verification code').fill('123456');
  await card.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(
    card.getByText('Connected to your WeChat', { exact: true })
  ).toBeVisible();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toContain('Draft prepared — not posted');
  expect(
    (
      await (
        await request.post(`${fixture.url}/api/entries/query`, { data: {} })
      ).json()
    ).total
  ).toBe(0);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: testInfo.outputPath('wechat-settings.png'),
    fullPage: true,
  });
  await card
    .getByRole('link', { name: 'Open WeChat conversation', exact: true })
    .click();
  await expect(page.getByText(/This is a WeChat conversation/)).toBeVisible();
  await expect(
    page.getByLabel('Add an entry, or ask your ledger…', { exact: true })
  ).toBeHidden();
  const draft = page.getByRole('article', {
    name: 'Entry draft · 1',
    exact: true,
  });
  await expect(draft.getByText(/Synthetic KFC note/)).toBeVisible();
  await draft
    .getByRole('button', { name: 'Confirm and post', exact: true })
    .click();
  await expect(
    draft.getByRole('heading', { name: 'Posted · 1 entries', exact: true })
  ).toBeVisible();
  expect(
    (
      await (
        await request.post(`${fixture.url}/api/entries/query`, { data: {} })
      ).json()
    ).total
  ).toBe(1);
  expect(modelCalls).toBe(2);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await card
    .getByRole('button', { name: 'New WeChat conversation', exact: true })
    .click();
  await card
    .getByRole('button', { name: 'Start new conversation', exact: true })
    .click();
  await expect(
    card.getByText('Connected to your WeChat', { exact: true })
  ).toBeVisible();
  const conversations = await (
    await request.post(`${fixture.url}/api/conversations/query`, { data: {} })
  ).json();
  expect(
    conversations.items.filter(
      (item: { source: string }) => item.source === 'wechat'
    )
  ).toHaveLength(2);
  await card
    .getByRole('button', { name: 'Disconnect WeChat', exact: true })
    .click();
  await card
    .getByRole('button', { name: 'Confirm disconnect', exact: true })
    .click();
  await expect(
    card.getByText('WeChat is not connected.', { exact: true })
  ).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Connect WeChat', exact: true })
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
