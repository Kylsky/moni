import { expect, test } from '@playwright/test';
import { Response as WorkerResponse } from 'miniflare';
import { startTestServer } from '../../scripts/local-test-server.mjs';
import { syntheticOtherIntent } from './fixtures/intent';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.afterEach(async () => fixture?.close());

test('dated query cards retain filters, separate currencies, survive reload, and expose exact details on both layouts', async ({
  page,
  request,
  isMobile,
}) => {
  const inputs: Record<string, unknown>[] = [];
  let calls = 0;
  fixture = await startTestServer(0, {
    provider: async (request) => {
      expect(new URL(request.url).origin).toBe('https://model.invalid');
      const intent = await syntheticOtherIntent(request);
      if (intent) return intent;
      const input = inputs.shift();
      calls++;
      const delta = input
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: crypto.randomUUID(),
                type: 'function',
                function: {
                  name: 'query_ledger',
                  arguments: JSON.stringify(input),
                },
              },
            ],
          }
        : {
            role: 'assistant',
            content:
              'See the dated ledger result below.\n\n## Query summary\n\n| Item | Amount |\n| --- | --- |\n| Lunch | **CNY 35.00** |\n\n- Read the **current** result.\n- [Unsafe link](javascript:alert(1))\n\n<script>window.moniMarkdownUnsafe=true</script>\n\n![Synthetic image](https://example.invalid/private-image.png)',
          };
      return new WorkerResponse(
        `data: ${JSON.stringify({ id: 'synthetic-query', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: input ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    },
  });
  const command = () => ({
    datasetId: 'initial',
    operationId: crypto.randomUUID(),
  });
  const post = async (path: string, data: unknown) => {
    const response = await request.post(`${fixture.url}/api/${path}`, { data });
    expect(response.status()).toBe(200);
    return response.json();
  };
  await post('initialize', {
    ...command(),
    primaryCurrency: 'CNY',
    timeZone: 'Asia/Shanghai',
  });
  const entry = async (extra: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    await post('entries', {
      ...command(),
      id,
      name: 'Synthetic lunch',
      kind: 'expense',
      amount: '35',
      currency: 'CNY',
      date: '2024-03-10',
      categoryId: 'expense-food',
      tags: ['Delivery'],
      note: 'Synthetic KFC note',
      ...extra,
    });
    return id;
  };
  await entry();
  const foreign = await entry({
    name: 'Synthetic foreign meal',
    amount: '20',
    currency: 'USD',
    conversion: { rate: '7.20' },
    confirmedBaseMinor: 14400,
    date: '2024-03-20',
    note: '',
  });
  await entry({ amount: '10', date: '2024-04-02', note: '' });
  await entry({ amount: '99', tags: ['Transport'], note: '' });
  await post('refunds', {
    ...command(),
    id: crypto.randomUUID(),
    expenseId: foreign,
    expenseVersion: 1,
    amount: '5',
    confirmedBaseMinor: 3600,
    date: '2024-04-03',
    note: 'Independent refund note',
  });
  const taxonomy = await (
    await request.get(`${fixture.url}/api/taxonomy`)
  ).json();
  const tagId = taxonomy.tags.find(
    (tag: { name: string }) => tag.name === 'Delivery'
  ).id;
  const base = {
    inheritPrevious: false,
    period: { kind: 'custom', from: '2024-03-01', to: '2024-04-30' },
    scope: 'spending',
    filters: { tagIds: [tagId] },
    view: 'summary',
    interval: 'month',
  };
  await page.goto(fixture.url);
  const results = page.getByRole('article', {
    name: 'Ledger query result',
    exact: true,
  });
  const ask = async (input: Record<string, unknown>, count: number) => {
    inputs.push(input);
    await page
      .getByLabel('Add an entry, or ask your ledger…', { exact: true })
      .fill('Synthetic query');
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(results).toHaveCount(count);
    await expect(
      page.getByLabel('Add an entry, or ask your ledger…', { exact: true })
    ).toBeEnabled();
    return results.nth(count - 1);
  };
  const first = await ask(base, 1);
  await expect(first.getByText('CN¥153.00', { exact: true })).toBeVisible();
  await expect(first.getByText('CN¥189.00', { exact: true })).toBeVisible();
  await expect(first.getByText('CN¥36.00', { exact: true })).toBeVisible();
  expect(
    await first.evaluate((card) => {
      const row = card.closest('li');
      return Boolean(
        row?.textContent?.includes('See the dated ledger result below.')
      );
    })
  ).toBe(true);
  const firstTurn = page.locator('li').filter({ has: first });
  await expect(
    firstTurn.getByRole('heading', { name: 'Query summary', exact: true })
  ).toBeVisible();
  await expect(firstTurn.getByRole('table')).toContainText('CNY 35.00');
  await expect(
    firstTurn.locator('strong').getByText('CNY 35.00')
  ).toBeVisible();
  await expect(
    firstTurn.getByText('Unsafe link', { exact: true })
  ).toBeVisible();
  await expect(firstTurn.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(firstTurn.locator('script')).toHaveCount(0);
  await expect(firstTurn.locator('img[src*="private-image"]')).toHaveCount(0);
  await expect(
    first.getByText('Any tag：Delivery', { exact: true })
  ).toBeVisible();
  await expect(
    first.getByText('2024-03-01 — 2024-04-30 · Asia/Shanghai')
  ).toBeVisible();
  const second = await ask(
    {
      ...base,
      inheritPrevious: true,
      period: { kind: 'month', month: '2024-03' },
      scope: null,
      filters: {},
      view: null,
      interval: null,
    },
    2
  );
  await expect(second.getByText('CN¥179.00', { exact: true })).toHaveCount(2);
  await expect(second.getByText('Any tag：Delivery')).toBeVisible();
  await page.reload();
  await expect(results).toHaveCount(2);
  await expect(
    page.getByRole('heading', { name: 'Query summary', exact: true })
  ).toHaveCount(2);
  expect(calls).toBe(4);
  const third = await ask({ ...base, filters: { currency: 'USD' } }, 3);
  await expect(third.getByText('CN¥108.00', { exact: true })).toBeVisible();
  await expect(third.getByText('$15.00', { exact: true })).toBeVisible();
  await expect(third.getByText('$20.00', { exact: true })).toBeVisible();
  await expect(third.getByText('$5.00', { exact: true })).toBeVisible();
  await page.locator('[data-slot="app-language-trigger"]:visible').click();
  await page.locator('[data-app-language="zh"]').click();
  await expect(
    page.getByRole('article', { name: '账本查询结果', exact: true })
  ).toHaveCount(3);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.locator('[data-slot="app-language-trigger"]:visible').click();
  await page.locator('[data-app-language="en"]').click();
  const fourth = await ask({ ...base, view: 'tags' }, 4);
  await expect(fourth.getByRole('table')).toContainText('Delivery');
  await expect(
    fourth.getByText(/An entry can appear in multiple tag groups/)
  ).toBeVisible();
  const fifth = await ask({ ...base, view: 'trend' }, 5);
  await expect(fifth.getByRole('table')).toContainText('2024-04-01');
  const sixth = await ask(
    { ...base, filters: { keyword: 'NoMatchingSyntheticNote' } },
    6
  );
  await expect(
    sixth.getByText(/This does not mean there was no actual spending/)
  ).toBeVisible();
  await expect(sixth.getByText('CN¥0.00', { exact: true })).toHaveCount(0);
  const seventh = await ask({ ...base, view: 'entries' }, 7);
  const details = seventh.getByRole('region', {
    name: 'Entry details',
    exact: true,
  });
  await expect(details).toContainText('Synthetic lunch');
  await expect(details).toContainText('Synthetic KFC note');
  await expect(details).toContainText('$20.00');
  await expect(details).toContainText('CN¥144.00');
  await page.reload();
  await expect(results).toHaveCount(7);
  await expect(
    results.last().getByRole('region', { name: 'Entry details', exact: true })
  ).toContainText('Synthetic KFC note');
  if (isMobile) await page.setViewportSize({ width: 320, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  await results
    .first()
    .getByRole('link', { name: 'View current details · 4', exact: true })
    .click();
  await expect(
    page.getByText('Matching entries: 4', { exact: true })
  ).toBeVisible();
  await expect(
    page
      .getByText('Synthetic KFC note', { exact: true })
      .filter({ visible: true })
  ).toBeVisible();
  if (isMobile)
    await page
      .getByRole('button', { name: 'More filters', exact: true })
      .click();
  await expect(
    page.getByRole('combobox', { name: 'Type', exact: true })
  ).toHaveText('Expenses and refunds');
});
