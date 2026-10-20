import { expect, test } from '@playwright/test';
import { startTestServer } from '../../scripts/local-test-server.mjs';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => {
  fixture = await startTestServer();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('trash confirmation, details, restore and failed permanent-delete retry reflect actual storage', async ({
  page,
  request,
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
  const id = crypto.randomUUID();
  expect(
    (
      await request.post(`${fixture.url}/api/entries`, {
        data: {
          ...command(),
          id,
          name: 'Synthetic lunch',
          kind: 'expense',
          amount: '35',
          date: '2026-10-18',
          tags: ['lunch'],
          note: 'Synthetic KFC note',
        },
      })
    ).status()
  ).toBe(200);
  await page.goto(`${fixture.url}/?view=entries&entry=${id}`);
  await page
    .getByRole('button', { name: 'Move to trash', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('Synthetic lunch');
  await expect(
    page.getByRole('button', { name: 'Keep', exact: true })
  ).toBeFocused();
  await page.keyboard.press('Escape');
  expect(
    await (await request.get(`${fixture.url}/api/entries`)).json()
  ).toHaveLength(1);
  await page
    .getByRole('button', { name: 'Move to trash', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Move to trash', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Your ledger is empty', exact: true })
  ).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Settings', exact: true })
    .click();
  await page.getByRole('link', { name: 'Trash', exact: true }).click();
  await page.getByText('Synthetic lunch', { exact: true }).click();
  await expect(
    page.getByText('Synthetic KFC note', { exact: true })
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Restore Synthetic lunch', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Trash is empty', exact: true })
  ).toBeVisible();
  const restored = (
    await (await request.get(`${fixture.url}/api/entries`)).json()
  )[0];
  expect(restored).toMatchObject({
    id,
    originalMinor: 3500,
    note: 'Synthetic KFC note',
    tags: [{ name: 'lunch', id: expect.any(String) }],
    version: 3,
  });
  expect(
    (
      await request.post(`${fixture.url}/api/entries/delete`, {
        data: { ...command(), id, version: 3, confirmed: true },
      })
    ).status()
  ).toBe(200);
  await page
    .getByRole('link', { name: 'Settings', exact: true })
    .first()
    .click();
  await page.locator('[data-slot="theme-switcher-trigger"]').click();
  await page.locator('[data-theme-option="dark"]').click();
  await page.getByLabel('Language', { exact: true }).selectOption('zh');
  await page.getByRole('link', { name: '回收站', exact: true }).click();
  await page
    .getByRole('button', { name: '彻底删除 Synthetic lunch', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('Synthetic lunch');
  await expect(page.getByRole('dialog')).toContainText('2026-10-18');
  await expect(page.getByRole('dialog')).toContainText('无法恢复');
  await page.getByRole('button', { name: '保留', exact: true }).click();
  expect(
    (
      await (
        await request.post(`${fixture.url}/api/trash/query`, { data: {} })
      ).json()
    ).total
  ).toBe(1);
  await page
    .getByRole('button', { name: '彻底删除 Synthetic lunch', exact: true })
    .click();
  await page.route('**/api/entries/purge', async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"synthetic_lost_response"}',
    });
  });
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '彻底删除', exact: true })
    .click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.unroute('**/api/entries/purge');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '彻底删除', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: '回收站为空', exact: true })
  ).toBeVisible();
  expect(
    (
      await (
        await request.post(`${fixture.url}/api/trash/query`, { data: {} })
      ).json()
    ).total
  ).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  expect(errors).toEqual([]);
});
