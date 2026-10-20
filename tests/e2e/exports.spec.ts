import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { startTestServer } from '../../scripts/local-test-server.mjs';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.afterEach(async () => fixture?.close());
test('downloads filtered CSV and private JSON, with visible retry errors, themes and both languages without AI', async ({
  page,
  request,
  isMobile,
}) => {
  fixture = await startTestServer(0, {
    ai: {},
    provider: async () => {
      throw new Error('AI and rates unavailable in export fixture');
    },
  });
  const command = () => ({
    datasetId: 'initial',
    operationId: crypto.randomUUID(),
  });
  const post = async (path: string, data: unknown) => {
    const result = await request.post(`${fixture.url}/api/${path}`, { data });
    expect(result.status()).toBe(200);
    return result.json();
  };
  await post('initialize', {
    ...command(),
    primaryCurrency: 'CNY',
    timeZone: 'Asia/Shanghai',
  });
  await post('entries', {
    ...command(),
    id: crypto.randomUUID(),
    kind: 'expense',
    name: '合成午餐',
    amount: '35',
    date: '2024-03-01',
    tags: ['午餐'],
    note: '肯德基, "合成备注"\nSecond line',
  });
  await post('entries', {
    ...command(),
    id: crypto.randomUUID(),
    kind: 'expense',
    name: 'Excluded promotion',
    amount: '20',
    currency: 'USD',
    date: '2024-03-02',
    conversion: { rate: '7.20' },
    confirmedBaseMinor: 14400,
    note: '',
  });
  const url = new URL(fixture.url);
  url.searchParams.set('view', 'entries');
  url.searchParams.set('filters', JSON.stringify({ keyword: '肯德基' }));
  await page.goto(url.toString());
  await expect(
    page.getByText('Matching entries: 1', { exact: true })
  ).toBeVisible();
  const button = page.getByRole('button', { name: 'Export CSV', exact: true });
  await page.route('**/api/exports/csv', async (route) =>
    route.fulfill({
      status: 413,
      contentType: 'application/json',
      body: '{"error":"export_too_large"}',
    })
  );
  await button.click();
  await expect(page.getByRole('alert')).toContainText('Nothing was truncated.');
  await page.unroute('**/api/exports/csv');
  const csvDownload = page.waitForEvent('download');
  await button.click();
  const csv = await csvDownload;
  expect(csv.suggestedFilename()).toBe('moni-entries.csv');
  const csvPath = await csv.path();
  expect(csvPath).not.toBeNull();
  const csvContent = await readFile(csvPath as string, 'utf8');
  expect(csvContent).toContain('肯德基, ""合成备注""\nSecond line');
  expect(csvContent).not.toContain('Excluded promotion');
  await page.goto(`${fixture.url}/?view=settings`);
  await page
    .getByRole('link', { name: 'Export and restore', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Export and restore', exact: true })
  ).toBeVisible();
  const download = page.getByRole('button', {
    name: 'Download complete backup',
    exact: true,
  });
  await page.route('**/api/exports/backup?*', async (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: '{"error":"export_changed"}',
    })
  );
  await download.click();
  await expect(page.getByRole('alert')).toContainText('The ledger changed');
  await page.unroute('**/api/exports/backup?*');
  const jsonDownload = page.waitForEvent('download');
  await download.click();
  const json = await jsonDownload;
  expect(json.suggestedFilename()).toBe('moni-backup.json');
  const jsonPath = await json.path();
  expect(jsonPath).not.toBeNull();
  const backup = JSON.parse(await readFile(jsonPath as string, 'utf8'));
  expect(backup.version).toBe(1);
  expect(backup.data.entries).toHaveLength(2);
  expect(
    backup.data.entries.find(
      (entry: { name: string }) => entry.name === '合成午餐'
    ).note
  ).toBe('肯德基, "合成备注"\nSecond line');
  await page.locator('[data-slot="app-language-trigger"]:visible').click();
  await page.locator('[data-app-language="zh"]').click();
  await expect(
    page.getByRole('button', { name: '下载完整备份', exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('密钥、登录身份与部署配置。', { exact: true })
  ).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  if (isMobile) await page.setViewportSize({ width: 320, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  expect(
    (
      await (
        await request.post(`${fixture.url}/api/entries/query`, { data: {} })
      ).json()
    ).total
  ).toBe(2);
});
