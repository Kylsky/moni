import { expect, test } from '@playwright/test';
import { Response as WorkerResponse } from 'miniflare';
import { startTestServer } from '../../scripts/local-test-server.mjs';
import { syntheticOtherIntent } from './fixtures/intent';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.afterEach(async () => {
  await fixture?.close();
});
test('owner configures AI after deploy, tests, updates without reentering the key and clears it', async ({
  page,
  request,
  isMobile,
}) => {
  let modelCalls = 0;
  fixture = await startTestServer(0, {
    ai: {},
    wechatSecret: '0123456789abcdef'.repeat(4),
    provider: async (req) => {
      if (
        ![
          'https://web-model.invalid/v1/chat/completions',
          'https://web-model.invalid/v1/responses',
        ].includes(req.url)
      )
        throw new Error('Unexpected outbound request');
      expect(req.headers.get('Authorization')).toBe(
        'Bearer synthetic-browser-ai-key'
      );
      modelCalls++;
      if (req.url.endsWith('/responses')) {
        const body = JSON.parse(await req.text());
        const output = body.tools?.some(
          (tool: { name: string }) =>
            tool.name === 'classify_draft_confirmation'
        )
          ? [
              {
                type: 'function_call',
                id: 'fc_synthetic',
                call_id: 'call_synthetic',
                name: 'classify_draft_confirmation',
                arguments: '{"intent":"other"}',
                status: 'completed',
              },
            ]
          : [
              {
                type: 'message',
                id: 'msg_synthetic',
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: 'Synthetic AI connection ready.',
                    annotations: [],
                  },
                ],
              },
            ];
        return new WorkerResponse(
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', model: 'synthetic-model', output } })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      const intent = await syntheticOtherIntent(req);
      if (intent) return intent;
      return new WorkerResponse(
        `data: ${JSON.stringify({ id: 'web-config', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic AI connection ready.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    },
  });
  await request.post(`${fixture.url}/api/initialize`, {
    data: {
      datasetId: 'initial',
      operationId: crypto.randomUUID(),
      primaryCurrency: 'CNY',
      timeZone: 'Asia/Shanghai',
    },
  });
  await page.goto(`${fixture.url}/?view=settings`);
  const card = page.getByRole('region', { name: 'AI assistant', exact: true });
  await expect(card.getByText('Not configured', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Connect WeChat', exact: true })
  ).toBeVisible();
  await card
    .getByLabel('Base URL', { exact: true })
    .fill('https://web-model.invalid/v1');
  await card.getByLabel('Model', { exact: true }).fill('synthetic-model');
  await card
    .getByLabel('API Key', { exact: true })
    .fill('synthetic-browser-ai-key');
  await card
    .getByRole('button', { name: 'Test connection', exact: true })
    .click();
  await expect(card.getByText(/Connection test passed/)).toBeVisible();
  expect(
    (await (await request.get(`${fixture.url}/api/ai`)).json()).configured
  ).toBe(false);
  expect(modelCalls).toBe(1);
  await card
    .getByLabel('API protocol', { exact: true })
    .selectOption('responses');
  await card
    .getByRole('button', { name: 'Test connection', exact: true })
    .click();
  await expect(card.getByText(/Connection test passed/)).toBeVisible();
  expect(modelCalls).toBe(2);
  await card
    .getByRole('button', { name: 'Save AI configuration', exact: true })
    .click();
  await expect(card.getByText(/AI configuration saved/)).toBeVisible();
  await expect(card.getByLabel('API Key', { exact: true })).toHaveValue('');
  const state = await request.get(`${fixture.url}/api/ai`);
  expect(await state.text()).not.toContain('synthetic-browser-ai-key');
  await page.reload();
  await expect(card.getByLabel('Model', { exact: true })).toHaveValue(
    'synthetic-model'
  );
  await expect(card.getByLabel('API protocol', { exact: true })).toHaveValue(
    'responses'
  );
  await card.screenshot({
    path: `docs/verification/screenshots/ai-settings-${isMobile ? 'mobile' : 'pc'}.png`,
  });
  await card
    .getByLabel('Base URL', { exact: true })
    .fill('https://other-provider.invalid/v1');
  await expect(card.getByLabel('API Key', { exact: true })).toHaveAttribute(
    'required',
    ''
  );
  await expect(
    card.getByRole('button', { name: 'Test connection', exact: true })
  ).toBeDisabled();
  await card
    .getByLabel('Base URL', { exact: true })
    .fill('https://web-model.invalid/v1');
  await card
    .getByLabel('Model', { exact: true })
    .fill('synthetic-updated-model');
  await card
    .getByRole('button', { name: 'Save AI configuration', exact: true })
    .click();
  await expect(card.getByText(/AI configuration saved/)).toBeVisible();
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await page
    .getByRole('textbox', {
      name: 'Add an entry, or ask your ledger…',
      exact: true,
    })
    .fill('Synthetic configuration smoke');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'Synthetic AI connection ready.' })
  ).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await card
    .getByRole('button', { name: 'Clear AI configuration', exact: true })
    .click();
  await card
    .getByRole('button', { name: 'Confirm clear', exact: true })
    .click();
  await expect(card.getByText(/AI configuration cleared/)).toBeVisible();
  await page.getByLabel('Language', { exact: true }).selectOption('zh');
  const zh = page.getByRole('region', { name: 'AI 助手', exact: true });
  await expect(
    zh.getByLabel('服务地址（Base URL）', { exact: true })
  ).toBeVisible();
  await page.locator('[data-slot="theme-switcher-trigger"]').click();
  await page.locator('[data-theme-option="dark"]').click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  expect(
    (await (await request.get(`${fixture.url}/api/settings`)).json())
      .aiConfigured
  ).toBe(false);
});
