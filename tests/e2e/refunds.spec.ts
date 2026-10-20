import { expect, test } from '@playwright/test';
import { startTestServer } from '../../scripts/local-test-server.mjs';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => {
  fixture = await startTestServer();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('associated refunds keep their note, review the remaining balance, retry safely, and open from the original expense', async ({
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
          name: 'Synthetic September expense',
          amount: '200',
          date: '2026-09-20',
          categoryId: 'expense-food',
          tags: ['Synthetic delivery'],
          note: 'Original synthetic note',
        },
      })
    ).status()
  ).toBe(200);
  await page.goto(`${fixture.url}/?view=entries&entry=${expenseId}`);
  await expect(
    page.getByRole('heading', { name: 'Related refunds', exact: true })
  ).toBeVisible();
  await page.getByLabel('Refund amount', { exact: false }).fill('201');
  await page
    .getByRole('button', { name: 'Confirm refund', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('within the available');
  expect(
    (
      await (
        await request.post(`${fixture.url}/api/entries/query`, {
          data: { kind: 'refund' },
        })
      ).json()
    ).total
  ).toBe(0);
  await page.getByLabel('Refund amount', { exact: false }).fill('50');
  await page.getByLabel('Refund date', { exact: true }).fill('2026-10-18');
  await page.getByLabel('Note', { exact: true }).fill('Synthetic refund note');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.getByLabel('Note', { exact: true })).toHaveValue(
    'Synthetic refund note'
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(page.getByText('CN¥50.00', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Remaining after this refund:.*CN¥150.00/)
  ).toBeVisible();
  if (isMobile) {
    const [cancel, confirm] = await Promise.all([
      page.getByRole('button', { name: 'Cancel', exact: true }).boundingBox(),
      page
        .getByRole('button', { name: 'Confirm refund', exact: true })
        .boundingBox(),
    ]);
    expect(
      Math.abs((cancel?.y ?? 0) - (confirm?.y ?? 100))
    ).toBeLessThanOrEqual(3);
  }
  await page.route(
    '**/api/refunds',
    (route) =>
      route.fulfill({ status: 503, json: { error: 'synthetic_failure' } }),
    { times: 1 }
  );
  await page
    .getByRole('button', { name: 'Confirm refund', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('not saved');
  await expect(page.getByLabel('Note', { exact: true })).toHaveValue(
    'Synthetic refund note'
  );
  await page
    .getByRole('button', { name: 'Confirm refund', exact: true })
    .click();
  await expect(page.getByText('Refund', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Synthetic refund note', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('Synthetic delivery', { exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit entry', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Edit refund', exact: true })
  ).toBeVisible();
  await page.getByLabel('Refund amount', { exact: false }).fill('60');
  await page
    .getByLabel('Note', { exact: true })
    .fill('Updated synthetic refund note');
  await page.locator('[data-slot="app-language-trigger"]:visible').click();
  await page.locator('[data-app-language="zh"]').click();
  await expect(page.getByLabel('退款金额', { exact: false })).toHaveValue('60');
  await page.getByRole('button', { name: '确认退款', exact: true }).click();
  await expect(
    page.getByText('Updated synthetic refund note', { exact: true })
  ).toBeVisible();
  await page.getByRole('link', { name: '原消费', exact: true }).click();
  await expect(
    page.getByText('已退款 · ¥60.00', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('可退： ¥140.00 · 本次退款后剩余： ¥140.00', { exact: true })
  ).toBeVisible();
  const result = await (
    await request.post(`${fixture.url}/api/entries/query`, {
      data: { kind: 'refund' },
    })
  ).json();
  expect(result.total).toBe(1);
  expect(result.items[0]).toMatchObject({
    refundOf: expenseId,
    originalMinor: 6000,
    baseMinor: 6000,
    note: 'Updated synthetic refund note',
  });
  const october = await (
    await request.post(`${fixture.url}/api/entries/query`, {
      data: { from: '2026-10-01', to: '2026-10-31' },
    })
  ).json();
  expect(october.totals).toEqual({
    income: 0,
    expense: 0,
    refund: 6000,
    netExpense: -6000,
  });
  if (isMobile) {
    await page.setViewportSize({ width: 320, height: 700 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
  }
  expect(errors).toEqual([]);
});
