import { expect, test } from '@playwright/test';
import { startTestServer } from '../../scripts/local-test-server.mjs';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => {
  fixture = await startTestServer();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('private synthetic conversation streams, preserves its note and survives reload', async ({
  page,
}) => {
  await page.goto(`${fixture.url}/verify`);
  await expect(
    page.getByRole('heading', { name: 'Private connection check' })
  ).toBeVisible();
  await page
    .getByLabel('Try a synthetic expense, with a note…')
    .fill('Synthetic lunch 35; note: s0-synthetic-note');
  await page.getByRole('button', { name: 'Send example' }).click();
  const reply =
    'Verified synthetic lunch 35; note: s0-synthetic-note. Nothing was saved to the ledger.';
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  const url = page.url();
  await page.reload();
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  expect(page.url()).toBe(url);
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(
    page.getByRole('heading', { name: "Let's try a small example" })
  ).toBeVisible();
  await expect(page.getByText(reply, { exact: true })).toHaveCount(0);
  await page.getByLabel('Language').selectOption('zh');
  await expect(
    page.getByRole('heading', { name: '私密连接验证' })
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
