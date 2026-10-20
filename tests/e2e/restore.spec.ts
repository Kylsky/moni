import { expect, test } from '@playwright/test';
import { startTestServer } from '../../scripts/local-test-server.mjs';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.afterEach(async () => fixture?.close());
test('validates uploaded backups, resumes preparation, previews replacement scope and cancels without changing current records', async ({
  page,
  request,
  isMobile,
}) => {
  fixture = await startTestServer(0, {
    ai: {},
    provider: async () => {
      throw new Error('External services disabled in restore fixture');
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
      kind: 'expense',
      name: '合成午餐',
      amount: '35',
      date: '2024-03-01',
      tags: ['午餐'],
      note: '合成肯德基备注',
      ...extra,
    });
    return id;
  };
  await entry();
  await entry({
    name: 'Synthetic promotion',
    currency: 'USD',
    amount: '20',
    conversion: { rate: '7.20' },
    confirmedBaseMinor: 14400,
    date: '2024-03-02',
    note: '',
  });
  const deleted = await entry({
    name: 'Synthetic trash',
    amount: '9',
    note: '回收站备注',
  });
  await post('entries/delete', {
    ...command(),
    id: deleted,
    version: 1,
    confirmed: true,
  });
  await post('conversations', { ...command(), id: crypto.randomUUID() });
  const backup = await (
    await request.get(`${fixture.url}/api/exports/backup?datasetId=initial`)
  ).json();
  await page.goto(`${fixture.url}/?view=settings&panel=backup`);
  const chooser = page.getByLabel('Choose JSON backup', { exact: true });
  await chooser.setInputFiles({
    name: 'invalid-utf8.json',
    mimeType: 'application/json',
    buffer: Buffer.from([0xc3, 0x28]),
  });
  await expect(page.getByRole('alert')).toContainText(
    'not a valid complete Moni JSON backup'
  );
  await chooser.setInputFiles({
    name: 'unsupported.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...backup, version: 999 })),
  });
  await expect(page.getByRole('alert')).toContainText('version is unsupported');
  let calls = 0;
  const operations: string[] = [];
  await page.route('**/api/restores/prepare', async (route) => {
    calls++;
    operations.push(route.request().postDataJSON().operationId);
    if (calls === 2)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"restore_prepare_failed"}',
      });
    else await route.continue();
  });
  await chooser.setInputFiles({
    name: 'synthetic-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.getByRole('alert')).toContainText(
    'Could not finish preparing this backup.'
  );
  await entry({ name: 'Written during preview', note: '预览期间现账可写' });
  await page
    .getByRole('button', { name: 'Retry preparation', exact: true })
    .click();
  await expect(
    page.getByText('Validation passed', { exact: true })
  ).toBeVisible();
  const preview = page.getByRole('region', {
    name: 'Backup preview',
    exact: true,
  });
  await expect(preview).toBeFocused();
  await expect(preview).toContainText('CNY, USD');
  await expect(preview).toContainText('2024-03-01 — 2024-03-02');
  await expect(preview).toContainText('Asia/Shanghai');
  await expect(
    page.getByText(
      'This replaces the whole ledger. Entries will not be merged.',
      { exact: true }
    )
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Confirm replacement', exact: true })
  ).toHaveCount(0);
  expect(new Set(operations).size).toBe(1);
  expect(
    (
      await (
        await request.post(`${fixture.url}/api/entries/query`, { data: {} })
      ).json()
    ).total
  ).toBe(3);
  await page.locator('[data-slot="app-language-trigger"]:visible').click();
  await page.locator('[data-app-language="zh"]').click();
  await expect(page.getByText('校验通过', { exact: true })).toBeVisible();
  await expect(
    page.getByText('synthetic-backup.json', { exact: true })
  ).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  if (isMobile) await page.setViewportSize({ width: 320, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  await page.route('**/api/restores/cancel', async (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"request_failed"}',
    })
  );
  await page.getByRole('button', { name: '取消恢复', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('尚未确认取消结果');
  await page.unroute('**/api/restores/cancel');
  await page.getByRole('button', { name: '取消恢复', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '备份文件预览', exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByLabel('选择 JSON 备份', { exact: true })
  ).toBeFocused();
  const current = await (
    await request.post(`${fixture.url}/api/entries/query`, { data: {} })
  ).json();
  expect(current.total).toBe(3);
  expect(
    current.items.find(
      (row: { name: string }) => row.name === 'Written during preview'
    ).note
  ).toBe('预览期间现账可写');
});
