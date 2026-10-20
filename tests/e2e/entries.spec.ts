import { expect, test } from '@playwright/test';
import { startTestServer } from '../../scripts/local-test-server.mjs';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => {
  fixture = await startTestServer();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('manual entries preserve notes, edit actual records, lock currency and retry a failed save', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const initialized = await request.post(`${fixture.url}/api/initialize`, {
    data: {
      datasetId: 'initial',
      operationId: crypto.randomUUID(),
      primaryCurrency: 'CNY',
      timeZone: 'Asia/Shanghai',
    },
  });
  expect(initialized.status()).toBe(200);
  await page.goto(fixture.url);
  await page.getByRole('link', { name: 'Manual entry', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Synthetic lunch');
  await page.getByLabel('Amount', { exact: true }).fill('35.001');
  await page.getByLabel('Date', { exact: true }).fill('2026-10-18');
  await page.getByRole('combobox', { name: 'Category', exact: true }).click();
  await page.getByRole('option', { name: 'Food', exact: true }).click();
  await page.getByRole('button', { name: 'Expense', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Category', exact: true })
  ).toContainText('Food');
  await page.getByLabel('Tags', { exact: true }).fill('lunch, takeout');
  await page
    .getByLabel('Note', { exact: true })
    .fill('<b>KFC</b> synthetic meal');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByLabel('Amount', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true'
  );
  await expect(page.getByLabel('Note', { exact: true })).toHaveValue(
    '<b>KFC</b> synthetic meal'
  );
  await page.getByLabel('Amount', { exact: true }).fill('35');
  await page.getByLabel('Note', { exact: true }).fill('n'.repeat(2001));
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByLabel('Note', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Note', { exact: true })).toHaveValue(
    'n'.repeat(2001)
  );
  expect(
    await (await request.get(`${fixture.url}/api/entries`)).json()
  ).toEqual([]);
  await page
    .getByLabel('Note', { exact: true })
    .fill('<b>KFC</b> synthetic meal');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Synthetic lunch', exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('<b>KFC</b> synthetic meal', { exact: true })
  ).toBeVisible();
  await expect(page.locator('main b')).toHaveCount(0);
  await expect(page).toHaveURL(/entry=[0-9a-f-]+/);
  await page.reload();
  await expect(
    page.getByText('<b>KFC</b> synthetic meal', { exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit entry', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Edit entry', exact: true })
  ).toBeVisible();
  await page.getByLabel('Amount', { exact: true }).fill('36.02');
  await page.getByLabel('Note', { exact: true }).fill('');
  await page.getByLabel('Tags', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByText('No note', { exact: true })).toBeVisible();
  const state = await (await request.get(`${fixture.url}/api/entries`)).json();
  expect(state).toHaveLength(1);
  expect(state[0]).toMatchObject({
    originalMinor: 3602,
    baseMinor: 3602,
    note: '',
    tags: [],
    version: 2,
  });
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Settings', exact: true })
    .click();
  await expect(
    page.getByLabel('Primary currency', { exact: true })
  ).toBeDisabled();
  await page.locator('[data-slot="theme-switcher-trigger"]').click();
  await page.locator('[data-theme-option="dark"]').click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByLabel('Language', { exact: true }).selectOption('zh');
  await page
    .getByRole('navigation')
    .getByRole('link', { name: '账目', exact: true })
    .click();
  await page.getByRole('button', { name: '手动记账', exact: true }).click();
  await page.getByRole('button', { name: '收入', exact: true }).click();
  await page.getByLabel('金额', { exact: true }).fill('9000');
  await page.getByLabel('名称', { exact: true }).fill('Synthetic salary');
  await page.getByRole('combobox', { name: '类目', exact: true }).click();
  await page.getByRole('option', { name: '工资', exact: true }).click();
  await page.getByRole('button', { name: '保存账目', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Synthetic salary', exact: true })
  ).toBeVisible();
  await expect(page.getByText('工资', { exact: true })).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: '账目', exact: true })
    .click();
  await page.getByRole('button', { name: '手动记账', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('Synthetic retry');
  await page.getByLabel('金额', { exact: true }).fill('12.50');
  await page
    .getByLabel('备注', { exact: true })
    .fill('Preserved after a network failure');
  await page.route('**/api/entries', async (route) => {
    if (route.request().method() === 'POST')
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"synthetic_unavailable"}',
      });
    else await route.continue();
  });
  await page.getByRole('button', { name: '保存账目', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('输入已保留');
  await expect(page.getByLabel('备注', { exact: true })).toHaveValue(
    'Preserved after a network failure'
  );
  await page.unroute('**/api/entries');
  await page.getByRole('button', { name: '保存账目', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Synthetic retry', exact: true })
  ).toBeVisible();
  const final = await (await request.get(`${fixture.url}/api/entries`)).json();
  expect(final).toHaveLength(3);
  expect(
    final.find((entry: { name: string }) => entry.name === 'Synthetic retry')
  ).toMatchObject({
    originalMinor: 1250,
    note: 'Preserved after a network failure',
  });
  await page.setViewportSize({ width: 320, height: 700 });
  const maximumName = `Synthetic ${'W'.repeat(100)}`;
  const maximum = await request.post(`${fixture.url}/api/entries`, {
    data: {
      datasetId: 'initial',
      operationId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      kind: 'expense',
      name: maximumName,
      amount: '90000000000.00',
      currency: 'CNY',
      date: '2026-10-18',
      tags: ['W'.repeat(30)],
    },
  });
  expect(maximum.status()).toBe(200);
  await page
    .getByRole('navigation')
    .getByRole('link', { name: '账目', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: maximumName })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  await page.getByRole('heading', { name: maximumName }).click();
  await expect(
    page.getByRole('button', { name: '修改账目', exact: true })
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  expect(errors).toEqual([]);
});
