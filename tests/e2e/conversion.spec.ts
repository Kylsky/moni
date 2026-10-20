import { expect, test } from '@playwright/test';
import { startTestServer } from '../../scripts/local-test-server.mjs';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => {
  fixture = await startTestServer();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('manual foreign entry previews exact conversion, preserves metadata edits and accepts actual settlement', async ({
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
  expect(
    (
      await request.post(`${fixture.url}/api/entries`, {
        data: {
          ...command(),
          id: crypto.randomUUID(),
          kind: 'expense',
          name: 'Synthetic lunch',
          amount: '35',
        },
      })
    ).status()
  ).toBe(200);
  await page.goto(`${fixture.url}/?view=entries&entry=new`);
  await page
    .getByLabel('Name', { exact: true })
    .fill('Synthetic USD promotion');
  await page.getByLabel('Amount', { exact: true }).fill('20');
  await page
    .getByRole('combobox', { name: 'Entry currency', exact: true })
    .click();
  await page.getByRole('option', { name: 'USD', exact: true }).click();
  expect(
    await page
      .getByLabel('Amount', { exact: true })
      .evaluate((element) => element.getBoundingClientRect().width)
  ).toBeGreaterThanOrEqual(100);
  await page.getByLabel('Date', { exact: true }).fill('2026-10-18');
  await page
    .getByLabel('Note', { exact: true })
    .fill('Synthetic promotion note');
  await expect(
    page
      .getByRole('navigation')
      .getByRole('link', { name: 'Settings', exact: true })
  ).toBeInViewport();
  await page
    .getByRole('button', { name: 'Confirm and save', exact: true })
    .click();
  await expect(page.locator('#entry-error')).toBeVisible();
  expect(
    await (await request.get(`${fixture.url}/api/entries`)).json()
  ).toHaveLength(1);
  await page.getByRole('button', { name: 'Manual rate', exact: true }).click();
  await page.getByLabel('Exchange rate', { exact: false }).fill('7.20');
  await page
    .getByRole('combobox', { name: 'Entry currency', exact: true })
    .click();
  await page.getByRole('option', { name: 'EUR', exact: true }).click();
  await expect(page.getByLabel('Exchange rate', { exact: false })).toHaveValue(
    ''
  );
  await page
    .getByRole('combobox', { name: 'Entry currency', exact: true })
    .click();
  await page.getByRole('option', { name: 'USD', exact: true }).click();
  await page.getByLabel('Exchange rate', { exact: false }).fill('7.20');
  await page.getByLabel('Basis date', { exact: true }).fill('2026-10-16');
  await expect(page.getByText('CN¥144.00', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Confirm and save', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Synthetic USD promotion', exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('1 USD = 7.20 CNY · 2026-10-16', { exact: true })
  ).toBeVisible();
  const original = (
    await (await request.get(`${fixture.url}/api/entries`)).json()
  ).find((entry: { currency: string }) => entry.currency === 'USD');
  expect(original).toMatchObject({ originalMinor: 2000, baseMinor: 14400 });
  await page.getByRole('button', { name: 'Edit entry', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Edit entry', exact: true })
  ).toBeVisible();
  await page.getByLabel('Note', { exact: true }).fill('Updated synthetic note');
  await page
    .getByRole('button', { name: 'Confirm and save', exact: true })
    .click();
  const unchanged = (
    await (await request.get(`${fixture.url}/api/entries`)).json()
  ).find((entry: { currency: string }) => entry.currency === 'USD');
  expect(unchanged.conversion).toEqual(original.conversion);
  expect(unchanged.baseMinor).toBe(14400);
  await page
    .getByRole('main')
    .getByRole('link', { name: 'Entries', exact: true })
    .click();
  const totals = page.getByRole('region', {
    name: 'Totals for all matching entries',
    exact: true,
  });
  await expect(totals).toContainText('CN¥179.00');
  await page
    .getByRole('heading', { name: 'Synthetic USD promotion', exact: true })
    .click();
  await page.getByRole('button', { name: 'Edit entry', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Edit entry', exact: true })
  ).toBeVisible();
  await page.getByLabel('Amount', { exact: true }).fill('21');
  await expect(page.getByText('CN¥151.20', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Actual settlement', exact: true })
    .click();
  await page
    .getByLabel('Actual primary amount', { exact: false })
    .fill('150.33');
  await expect(page.getByText('CN¥150.33', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Confirm and save', exact: true })
    .click();
  await expect(
    page.getByText('Actual settlement provided by you', { exact: true })
  ).toBeVisible();
  const actual = (
    await (await request.get(`${fixture.url}/api/entries`)).json()
  ).find((entry: { currency: string }) => entry.currency === 'USD');
  expect(actual).toMatchObject({
    originalMinor: 2100,
    baseMinor: 15033,
    conversion: { method: 'actual', rate: null },
  });
  await page
    .getByRole('main')
    .getByRole('link', { name: 'Entries', exact: true })
    .click();
  if (isMobile)
    await page
      .getByRole('button', { name: 'More filters', exact: true })
      .click();
  await page
    .getByRole('combobox', { name: 'Original currency', exact: true })
    .click();
  await page.getByRole('option', { name: 'USD', exact: true }).click();

  await page
    .getByRole('button', { name: 'Apply filters', exact: true })
    .click();
  await expect(
    page.getByRole('region', {
      name: 'Totals for all matching entries',
      exact: true,
    })
  ).toContainText('CN¥150.33');
  await expect(
    page.getByRole('heading', {
      name: 'Original-currency totals · USD',
      exact: true,
    })
  ).toBeVisible();
  await page.locator('[data-slot="app-language-trigger"]:visible').click();
  await page.locator('[data-app-language="zh"]').click();
  await expect(
    page.getByRole('heading', { name: '原币合计 · USD', exact: true })
  ).toBeVisible();
  await page
    .getByRole('heading', { name: 'Synthetic USD promotion', exact: true })
    .click();
  await page.getByRole('button', { name: '修改账目', exact: true }).click();
  await page.getByRole('combobox', { name: '账目币种', exact: true }).click();
  await page.getByRole('option', { name: 'CNY', exact: true }).click();
  await expect(
    page.getByText('账目币种现与主币种一致，请核对金额后确认保存。', {
      exact: true,
    })
  ).toBeVisible();
  await page.getByRole('button', { name: '核对并保存', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Synthetic USD promotion', exact: true })
  ).toBeVisible();
  const primary = (
    await (await request.get(`${fixture.url}/api/entries`)).json()
  ).find((entry: { id: string }) => entry.id === original.id);
  expect(primary).toMatchObject({
    currency: 'CNY',
    originalMinor: 2100,
    baseMinor: 2100,
    conversion: null,
  });
  await page.setViewportSize({ width: 320, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  expect(errors).toEqual([]);
});
