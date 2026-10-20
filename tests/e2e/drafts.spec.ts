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
const draftItem = (extra: Record<string, unknown> = {}) => ({
  itemId: null,
  kind: 'expense',
  name: '午餐',
  amount: '35',
  actualBaseAmount: null,
  currency: null,
  currencyAmbiguous: false,
  date: null,
  categoryId: 'expense-food',
  tags: ['午餐'],
  note: '在肯德基吃的',
  ...extra,
});
async function setup(items: Record<string, unknown>[], quoteStatus = 200) {
  let quoteCalls = 0;
  fixture = await startTestServer(0, {
    provider: async (request) => {
      const url = new URL(request.url);
      if (url.origin === 'https://api.frankfurter.dev') {
        quoteCalls++;
        return WorkerResponse.json(
          [
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
          ],
          { status: quoteStatus }
        );
      }
      expect(url.origin).toBe('https://model.invalid');
      const intent = await syntheticOtherIntent(request);
      if (intent) return intent;
      const input = (await request.json()) as { messages: { role: string }[] };
      const tool = input.messages.at(-1)?.role !== 'tool';
      const delta = tool
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
                    items,
                  }),
                },
              },
            ],
          }
        : {
            role: 'assistant',
            content: 'Synthetic drafts are ready for your review.',
          };
      return new WorkerResponse(
        `data: ${JSON.stringify({ id: 'synthetic-drafts', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    },
  });
  return () => quoteCalls;
}

test('draft review retains notes and quotes, preserves competing edits, and posts precisely once from two devices', async ({
  page,
  request,
  browser,
  isMobile,
}) => {
  const quotes = await setup([
    draftItem(),
    draftItem({
      name: '网站推广',
      amount: '20',
      currency: 'USD',
      categoryId: 'expense-other',
      tags: ['推广'],
      note: '',
    }),
  ]);
  await request.post(`${fixture.url}/api/initialize`, {
    data: { ...command(), primaryCurrency: 'CNY', timeZone: 'Asia/Shanghai' },
  });
  await page.goto(fixture.url);
  await page
    .getByLabel('Add an entry, or ask your ledger…', { exact: true })
    .fill('Synthetic lunch at KFC 35, promotion USD20.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const card = page.getByRole('article', {
    name: 'Entry draft · 2',
    exact: true,
  });
  await expect(
    card.getByRole('heading', { name: 'Review before posting · 2 entries' })
  ).toBeVisible();
  await expect(card.getByText(/179\.00/)).toBeVisible();
  expect(
    (
      await (
        await request.post(`${fixture.url}/api/entries/query`, { data: {} })
      ).json()
    ).total
  ).toBe(0);
  const secondContext = await browser.newContext({ locale: 'en' });
  try {
    const second = await secondContext.newPage();
    await second.goto(page.url());
    await second
      .getByRole('button', { name: 'Edit draft', exact: true })
      .click();
    const secondLunch = second.getByRole('group', {
      name: '1 · 午餐',
      exact: true,
    });
    await secondLunch
      .getByLabel('Note', { exact: true })
      .fill('Unsaved second-device synthetic note');
    await page
      .getByRole('button', { name: 'Edit draft item · 午餐', exact: true })
      .click();
    const lunch = page.getByRole('group', { name: '1 · 午餐', exact: true });
    await expect(lunch.getByLabel('Name', { exact: true })).toBeFocused();
    await lunch
      .getByLabel('Note', { exact: true })
      .fill('在肯德基吃的 · 合成修改备注');
    await lunch.getByLabel('Tags', { exact: true }).fill('午餐, 外卖');
    await page.locator('[data-slot="app-language-trigger"]:visible').click();
    await page.locator('[data-app-language="zh"]').click();
    await expect(lunch.getByLabel('备注', { exact: true })).toHaveValue(
      '在肯德基吃的 · 合成修改备注'
    );
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.locator('[data-slot="app-language-trigger"]:visible').click();
    await page.locator('[data-app-language="en"]').click();
    await page
      .getByRole('button', { name: 'Save draft for review', exact: true })
      .click();
    await expect(
      page.getByRole('group', { name: '1 · 午餐', exact: true })
    ).toHaveCount(0);
    await expect(card.getByText(/合成修改备注/)).toBeVisible();
    expect(quotes()).toBe(1);
    await second
      .getByRole('button', { name: 'Refresh drafts', exact: true })
      .click();
    await expect(secondLunch.getByLabel('Note', { exact: true })).toHaveValue(
      'Unsaved second-device synthetic note'
    );
    await second
      .getByRole('button', { name: 'Save draft for review', exact: true })
      .click();
    await expect(
      second
        .getByRole('alert')
        .filter({ hasText: 'Could not verify these changes.' })
    ).toBeVisible();
    await expect(secondLunch.getByLabel('Note', { exact: true })).toHaveValue(
      'Unsaved second-device synthetic note'
    );
    await second.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(second.getByText(/合成修改备注/)).toBeVisible();
    await second
      .getByRole('button', { name: 'Confirm and post', exact: true })
      .click();
    await expect(
      second.getByRole('heading', { name: 'Posted · 2 entries', exact: true })
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Confirm and post', exact: true })
      .click();
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'The result was not confirmed.' })
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Refresh drafts', exact: true })
      .click();
    await expect(
      card.getByRole('heading', { name: 'Posted · 2 entries', exact: true })
    ).toBeVisible();
    const saved = await (
      await request.post(`${fixture.url}/api/entries/query`, { data: {} })
    ).json();
    expect(saved.total).toBe(2);
    expect(
      saved.items.reduce(
        (sum: number, row: { baseMinor: number }) => sum + row.baseMinor,
        0
      )
    ).toBe(17900);
    expect(
      saved.items.find((row: { name: string }) => row.name === '午餐').note
    ).toBe('在肯德基吃的 · 合成修改备注');
    expect(
      saved.items.find((row: { name: string }) => row.name === '网站推广').note
    ).toBe('');
    if (isMobile) await page.setViewportSize({ width: 320, height: 700 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
  } finally {
    await secondContext.close();
  }
});

test('incomplete drafts keep missing amounts and failed quotes editable, then can be cancelled without posting', async ({
  page,
  request,
  isMobile,
}) => {
  await setup(
    [
      draftItem({
        name: '鞋',
        amount: null,
        categoryId: 'expense-clothing',
        tags: [],
        note: '',
      }),
      draftItem({
        name: '推广',
        amount: '20',
        currency: 'USD',
        categoryId: 'expense-other',
        tags: ['promotion', 'takeout'],
        note: 'Synthetic readable promotion note',
      }),
    ],
    503
  );
  await request.post(`${fixture.url}/api/initialize`, {
    data: { ...command(), primaryCurrency: 'CNY', timeZone: 'UTC' },
  });
  await page.goto(fixture.url);
  await page
    .getByLabel('Add an entry, or ask your ledger…', { exact: true })
    .fill(
      'Synthetic shoes without amount, USD20 promotion with quote unavailable.'
    );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const card = page.getByRole('article', {
    name: 'Entry draft · 2',
    exact: true,
  });
  await expect(
    card.getByRole('heading', {
      name: 'Needs details · 2 entries',
      exact: true,
    })
  ).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Confirm and post', exact: true })
  ).toBeDisabled();
  if (isMobile) {
    const note = card.getByText('Note：Synthetic readable promotion note', {
      exact: true,
    });
    await expect(note).toBeVisible();
    const box = await note.boundingBox();
    expect(box?.width).toBeGreaterThan(190);
  }
  await page.getByRole('button', { name: 'Edit draft', exact: true }).click();
  await page
    .getByRole('group', { name: '1 · 鞋', exact: true })
    .getByLabel('Amount', { exact: true })
    .fill('88');
  const promotion = page.getByRole('group', { name: '2 · 推广', exact: true });
  await promotion
    .getByRole('button', { name: 'Manual rate', exact: true })
    .click();
  await promotion.getByLabel(/Exchange rate/).fill('7.20');
  await page
    .getByRole('button', { name: 'Save draft for review', exact: true })
    .click();
  await expect(
    card.getByRole('heading', {
      name: 'Review before posting · 2 entries',
      exact: true,
    })
  ).toBeVisible();
  await expect(card.getByText(/232\.00/)).toBeVisible();
  await card.getByRole('button', { name: 'Cancel draft', exact: true }).click();
  await expect(
    card.getByRole('heading', { name: 'Cancelled · 2 entries', exact: true })
  ).toBeVisible();
  expect(
    (
      await (
        await request.post(`${fixture.url}/api/entries/query`, { data: {} })
      ).json()
    ).total
  ).toBe(0);
  if (isMobile) await page.setViewportSize({ width: 320, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
});
