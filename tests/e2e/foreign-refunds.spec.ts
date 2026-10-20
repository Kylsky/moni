import { expect, test } from '@playwright/test';
import { startTestServer } from '../../scripts/local-test-server.mjs';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => {
  fixture = await startTestServer();
});
test.afterAll(async () => {
  await fixture?.close();
});
test('foreign refunds review original conversion and actual settlement without fetching another quote', async ({
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
  const expenseId = crypto.randomUUID();
  expect(
    (
      await request.post(`${fixture.url}/api/entries`, {
        data: {
          ...command(),
          id: expenseId,
          kind: 'expense',
          name: 'Synthetic USD campaign',
          amount: '100',
          currency: 'USD',
          date: '2026-09-20',
          conversion: { rate: '7.20' },
          confirmedBaseMinor: 72000,
        },
      })
    ).status()
  ).toBe(200);
  let quoteCalls = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/rates')) quoteCalls++;
  });
  await page.goto(`${fixture.url}/?view=entries&entry=${expenseId}`);
  await page.getByLabel('Refund amount', { exact: false }).fill('30');
  await page.getByLabel('Refund date', { exact: true }).fill('2026-10-18');
  await expect(page.getByText('CN¥216.00', { exact: true })).toBeVisible();
  await expect(
    page.getByText('1 USD ≈ 7.20 CNY', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(/Remaining after this refund:.*\$70.00/)
  ).toBeVisible();
  await page
    .getByLabel('Actual primary refund received', { exact: false })
    .fill('210.33');
  await page
    .getByLabel('Note', { exact: true })
    .fill('Synthetic actual receipt');
  await expect(page.getByText('CN¥210.33', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Confirm refund', exact: true })
    .click();
  await expect(
    page.getByText('Actual settlement provided by you', { exact: true })
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Original expense', exact: true })
    .click();
  await page.getByLabel('Refund amount', { exact: false }).fill('70');
  await expect(page.getByText('CN¥504.00', { exact: true })).toBeVisible();
  await page.getByLabel('Refund date', { exact: true }).fill('2026-10-19');
  await page
    .getByRole('button', { name: 'Confirm refund', exact: true })
    .click();
  await expect(
    page.getByText('Uses the original expense’s confirmed conversion', {
      exact: true,
    })
  ).toBeVisible();
  const result = await (
    await request.post(`${fixture.url}/api/entries/query`, {
      data: { currency: 'USD' },
    })
  ).json();
  expect(result.originalTotals.refund).toBe(10000);
  expect(result.totals).toEqual({
    income: 0,
    expense: 72000,
    refund: 71433,
    netExpense: 567,
  });
  await page.getByRole('button', { name: 'Edit entry', exact: true }).click();
  await expect(
    page.getByLabel('Actual primary refund received', { exact: false })
  ).toHaveValue('');
  await page
    .getByLabel('Note', { exact: true })
    .fill('Updated synthetic default refund');
  await page.locator('[data-slot="app-language-trigger"]:visible').click();
  await page.locator('[data-app-language="zh"]').click();
  await expect(page.getByText('¥504.00', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认退款', exact: true }).click();
  await expect(
    page.getByText('Updated synthetic default refund', { exact: true })
  ).toBeVisible();
  if (isMobile) {
    await page.setViewportSize({ width: 320, height: 700 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
  }
  expect(quoteCalls).toBe(0);
  expect(errors).toEqual([]);
});
