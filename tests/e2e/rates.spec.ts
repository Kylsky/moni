import { expect, test } from '@playwright/test';
import { Response } from 'miniflare';
import { startTestServer } from '../../scripts/local-test-server.mjs';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
let available = true;
let rate = 9;
let calls = 0;
test.beforeAll(async () => {
  fixture = await startTestServer(0, {
    provider: async (request) => {
      if (new URL(request.url).origin !== 'https://api.frankfurter.dev')
        return new Response(null, { status: 502 });
      calls++;
      if (!available) return new Response(null, { status: 503 });
      return Response.json([
        { date: '2024-05-17', base: 'EUR', quote: 'USD', rate: 1.25 },
        { date: '2024-05-17', base: 'EUR', quote: 'CNY', rate },
      ]);
    },
  });
});
test.afterAll(async () => {
  await fixture?.close();
});

test('historical reference previews both dates, freezes its basis and keeps inputs when the provider fails', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  expect(
    (
      await request.post(`${fixture.url}/api/initialize`, {
        data: {
          datasetId: 'initial',
          operationId: crypto.randomUUID(),
          primaryCurrency: 'CNY',
          timeZone: 'Asia/Shanghai',
        },
      })
    ).status()
  ).toBe(200);
  await page.goto(`${fixture.url}/?view=entries&entry=new`);
  await page
    .getByLabel('Name', { exact: true })
    .fill('Synthetic historical promotion');
  await page.getByLabel('Date', { exact: true }).fill('2024-05-19');
  await page.getByLabel('Amount', { exact: true }).fill('20');
  await page
    .getByLabel('Note', { exact: true })
    .fill('Synthetic historical note');
  await page
    .getByRole('combobox', { name: 'Entry currency', exact: true })
    .click();
  await page.getByRole('option', { name: 'USD', exact: true }).click();
  await expect(page.getByText('CN¥144.00', { exact: true })).toBeVisible();
  await expect(
    page.getByText('1 USD ≈ 7.2 CNY · Actual quotation date：2024-05-17', {
      exact: true,
    })
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Confirm and save', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Synthetic historical promotion',
      exact: true,
    })
  ).toBeVisible();
  await expect(
    page.getByText('ECB via Frankfurter · reference rate', { exact: true })
  ).toBeVisible();
  const count = calls;
  rate = 10;
  await page.getByRole('button', { name: 'Edit entry', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Edit entry', exact: true })
  ).toBeVisible();
  await page
    .getByLabel('Note', { exact: true })
    .fill('Updated synthetic historical note');
  await expect(page.getByText('CN¥144.00', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Confirm and save', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Synthetic historical promotion',
      exact: true,
    })
  ).toBeVisible();
  expect(calls).toBe(count);
  await page.getByRole('button', { name: 'Edit entry', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Edit entry', exact: true })
  ).toBeVisible();
  await page.getByLabel('Amount', { exact: true }).fill('21');
  await expect(page.getByText('CN¥168.00', { exact: true })).toBeVisible();
  available = false;
  await page
    .getByRole('button', { name: 'Refresh quote', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('No usable quote');
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('21');
  await expect(page.getByLabel('Note', { exact: true })).toHaveValue(
    'Updated synthetic historical note'
  );
  await page.getByRole('button', { name: 'Manual rate', exact: true }).click();
  await page.getByLabel('Exchange rate', { exact: false }).fill('7.20');
  await expect(page.getByText('CN¥151.20', { exact: true })).toBeVisible();
  await page.locator('[data-slot="app-language-trigger"]:visible').click();
  await page.locator('[data-app-language="zh"]').click();
  await expect(
    page.getByRole('button', { name: '参考汇率', exact: true })
  ).toBeVisible();
  for (const name of ['参考汇率', '手填汇率', '实际结算']) {
    const box = await page
      .getByRole('button', { name, exact: true })
      .boundingBox();
    expect(box?.height).toBeLessThanOrEqual(56);
  }
  await page.getByRole('button', { name: '核对并保存', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Synthetic historical promotion',
      exact: true,
    })
  ).toBeVisible();
  const entries = await (
    await request.get(`${fixture.url}/api/entries`)
  ).json();
  expect(entries[0]).toMatchObject({
    originalMinor: 2100,
    baseMinor: 15120,
    conversion: { method: 'manual_rate' },
  });
  await page.setViewportSize({ width: 320, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  expect(errors).toEqual([]);
});
