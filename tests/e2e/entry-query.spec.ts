import { expect, test } from '@playwright/test';
import { startTestServer } from '../../scripts/local-test-server.mjs';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => {
  fixture = await startTestServer();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('combined filters, paging, detail return and language changes retain the current query', async ({
  page,
  request,
  isMobile,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const command = () => ({
    datasetId: 'initial',
    operationId: crypto.randomUUID(),
  });
  expect(
    (
      await request.post(`${fixture.url}/api/initialize`, {
        data: {
          ...command(),
          primaryCurrency: 'CNY',
          timeZone: 'Asia/Shanghai',
        },
      })
    ).status()
  ).toBe(200);
  for (let index = 0; index < 25; index++)
    expect(
      (
        await request.post(`${fixture.url}/api/entries`, {
          data: {
            ...command(),
            id: crypto.randomUUID(),
            kind: 'expense',
            name: `Synthetic meal ${index}`,
            amount: '35',
            date: '2026-10-18',
            categoryId: 'expense-food',
            tags: index % 2 ? ['delivery'] : ['delivery', 'lunch'],
            note: index < 23 ? 'KFC synthetic' : 'Other synthetic',
          },
        })
      ).status()
    ).toBe(200);
  await page.goto(`${fixture.url}/?view=entries`);
  await page.getByLabel('Name or note keyword', { exact: true }).fill('KFC');
  await page.getByLabel('From date', { exact: true }).fill('2026-10-18');
  await page.getByLabel('Through date', { exact: true }).fill('2026-10-18');
  if (isMobile)
    await page
      .getByRole('button', { name: 'More filters', exact: true })
      .click();
  await page.getByRole('combobox', { name: 'Type', exact: true }).click();
  await page.getByRole('option', { name: 'Expense', exact: true }).click();
  await page.getByRole('combobox', { name: 'Category', exact: true }).click();
  await page.getByRole('option', { name: 'Food', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Original currency', exact: true })
    .click();
  await page.getByRole('option', { name: 'CNY', exact: true }).click();
  await page.getByText('Any selected tag (0)', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'delivery', exact: true }).check();
  await page.getByRole('checkbox', { name: 'lunch', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Any selected tag (2)', exact: true })
  ).toBeFocused();
  await page
    .getByRole('button', { name: 'Apply filters', exact: true })
    .click();
  await expect(
    page.getByText('Matching entries: 23', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: /^Synthetic meal / })
  ).toHaveCount(20);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: /^Synthetic meal / })
  ).toHaveCount(3);
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  const currentUrl = page.url();
  const name = await page
    .getByRole('heading', { name: /^Synthetic meal / })
    .first()
    .innerText();
  await page.getByRole('heading', { name, exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit entry', exact: true })
  ).toBeVisible();
  await page.locator('[data-slot="app-language-trigger"]:visible').click();
  await page.locator('[data-app-language="zh"]').click();
  await expect(
    page.getByRole('button', { name: '修改账目', exact: true })
  ).toBeVisible();
  await expect(page).toHaveURL(/filters=/);
  await page
    .getByRole('main')
    .getByRole('link', { name: '账目', exact: true })
    .click();
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  await expect(
    page.getByLabel('名称或备注关键词', { exact: true })
  ).toHaveValue('KFC');
  await expect(page.getByText('已应用筛选：', { exact: false })).toContainText(
    'delivery'
  );
  await page.getByRole('heading', { name, exact: true }).click();
  await page.getByRole('button', { name: '修改账目', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '修改账目', exact: true })
  ).toBeVisible();
  await page.getByLabel('备注', { exact: true }).fill('');
  await page.getByRole('button', { name: '保存账目', exact: true }).click();
  await expect(page.getByText('暂无备注', { exact: true })).toBeVisible();
  await page
    .getByRole('main')
    .getByRole('link', { name: '账目', exact: true })
    .click();
  await expect(page.getByText('匹配账目： 22', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
  await page
    .getByLabel('名称或备注关键词', { exact: true })
    .fill('No matching synthetic');
  await page.getByRole('button', { name: '应用筛选', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '未找到匹配账目', exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('请调整或清除筛选条件。没有匹配记录，不代表实际没有消费。', {
      exact: true,
    })
  ).toBeVisible();
  await page.route('**/api/entries/query', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"synthetic_failure"}',
    })
  );
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '未找到匹配账目', exact: true })
  ).toHaveCount(0);
  await page.unroute('**/api/entries/query');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('匹配账目： 25', { exact: true })).toBeVisible();
  await page.goto(currentUrl);
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  expect(errors).toEqual([]);
});
