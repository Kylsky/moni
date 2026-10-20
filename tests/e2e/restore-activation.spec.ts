import { readFile } from 'node:fs/promises';
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { startTestServer } from '../../scripts/local-test-server.mjs';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.afterEach(async () => fixture?.close());
const command = () => ({
  datasetId: 'initial',
  operationId: crypto.randomUUID(),
});
async function entry(
  request: APIRequestContext,
  extra: Record<string, unknown> = {}
) {
  const result = await request.post(`${fixture.url}/api/entries`, {
    data: {
      ...command(),
      id: crypto.randomUUID(),
      kind: 'expense',
      name: '合成午餐',
      amount: '35',
      date: '2024-03-01',
      tags: ['午餐'],
      note: '肯德基 · 合成恢复原账',
      ...extra,
    },
  });
  expect(result.status()).toBe(200);
  return result.json();
}
async function setup(page: Page, request: APIRequestContext) {
  fixture = await startTestServer(0, {
    ai: {},
    provider: async () => {
      throw new Error('External services disabled for restore acceptance');
    },
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
  await entry(request);
  await entry(request, {
    name: 'Synthetic USD promotion',
    currency: 'USD',
    amount: '20',
    conversion: { rate: '7.20' },
    confirmedBaseMinor: 14400,
    note: '',
  });
  const deleted = crypto.randomUUID();
  await entry(request, {
    id: deleted,
    name: 'Synthetic trash',
    note: '独立回收站备注',
  });
  expect(
    (
      await request.post(`${fixture.url}/api/entries/delete`, {
        data: { ...command(), id: deleted, version: 1, confirmed: true },
      })
    ).status()
  ).toBe(200);
  const backup = await (
    await request.get(`${fixture.url}/api/exports/backup?datasetId=initial`)
  ).json();
  await entry(request, {
    name: 'Current-only synthetic',
    amount: '50',
    note: '只在现账的合成备注',
  });
  await page.goto(`${fixture.url}/?view=settings&panel=backup`);
  await page.getByLabel('Choose JSON backup', { exact: true }).setInputFiles({
    name: 'synthetic-restore.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(
    page.getByText('Validation passed', { exact: true })
  ).toBeVisible();
  return backup;
}
async function downloadCurrent(page: Page) {
  const pending = page.waitForEvent('download');
  await page
    .getByRole('button', {
      name: 'Download current ledger backup',
      exact: true,
    })
    .click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('moni-current-before-restore.json');
  const path = await download.path();
  if (!path) throw new Error('Synthetic current backup not downloaded');
  return JSON.parse(await readFile(path, 'utf8'));
}

test('saves the frozen current ledger, restores from a recovered session, and retries one explicit confirmation without partial replacement', async ({
  page,
  request,
  isMobile,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const target = await setup(page, request);
  await page
    .getByRole('button', {
      name: 'Save current backup and continue',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Save your current ledger first',
      exact: true,
    })
  ).toBeVisible();
  await expect(
    page.getByLabel(
      'I have saved the current ledger backup I just downloaded.',
      { exact: true }
    )
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Review replacement', exact: true })
  ).toBeDisabled();
  expect(
    (
      await request.post(`${fixture.url}/api/entries`, {
        data: {
          ...command(),
          id: crypto.randomUUID(),
          kind: 'expense',
          name: 'Frozen',
          amount: '1',
        },
      })
    ).status()
  ).toBe(423);
  await page.reload();
  await expect(
    page.getByRole('heading', {
      name: 'Save your current ledger first',
      exact: true,
    })
  ).toBeVisible();
  await expect(
    page.getByLabel(
      'I have saved the current ledger backup I just downloaded.',
      { exact: true }
    )
  ).not.toBeChecked();
  const current = await downloadCurrent(page);
  expect(current.data.entries).toHaveLength(4);
  expect(
    current.data.entries.find(
      (row: { name: string }) => row.name === 'Current-only synthetic'
    ).note
  ).toBe('只在现账的合成备注');
  expect(target.data.entries).toHaveLength(3);
  const saved = page.getByLabel(
    'I have saved the current ledger backup I just downloaded.',
    { exact: true }
  );
  await expect(saved).toBeEnabled();
  await saved.check();
  await page.locator('[data-slot="app-language-trigger"]:visible').click();
  await page.locator('[data-app-language="zh"]').click();
  await expect(
    page.getByLabel('我已保存刚下载的当前账本备份。', { exact: true })
  ).toBeChecked();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  if (isMobile) await page.setViewportSize({ width: 320, height: 700 });
  await page.getByRole('button', { name: '继续确认替换', exact: true }).click();
  let dialog = page.getByRole('dialog', {
    name: '替换当前账本？',
    exact: true,
  });
  await expect(
    dialog.getByRole('button', { name: '返回核对', exact: true })
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '继续确认替换', exact: true })
  ).toBeFocused();
  await page.getByRole('button', { name: '继续确认替换', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '替换当前账本？', exact: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  const submissions: Record<string, unknown>[] = [];
  await page.route('**/api/restores/commit', async (route) => {
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"synthetic_switch_failure"}',
      });
    else await route.continue();
  });
  await dialog
    .getByRole('button', { name: '确认替换账本', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText('尚未确认替换结果');
  expect(
    (
      await (
        await request.post(`${fixture.url}/api/entries/query`, { data: {} })
      ).json()
    ).total
  ).toBe(3);
  await dialog
    .getByRole('button', { name: '确认替换账本', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: '账目', exact: true })
  ).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[0].operationId === submissions[1].operationId).toBe(true);
  const restored = await (
    await request.post(`${fixture.url}/api/entries/query`, { data: {} })
  ).json();
  expect(restored.datasetId).not.toBe('initial');
  expect(restored.total).toBe(2);
  expect(restored.totals.netExpense).toBe(17900);
  await expect(
    page
      .getByText('肯德基 · 合成恢复原账', { exact: true })
      .filter({ visible: true })
  ).toBeVisible();
  await expect(
    page.getByText('Current-only synthetic', { exact: true })
  ).toHaveCount(0);
  expect(
    (
      await request.post(`${fixture.url}/api/restores/commit`, {
        data: submissions[1],
      })
    ).status()
  ).toBe(200);
  expect(
    (
      await (
        await request.post(`${fixture.url}/api/entries/query`, { data: {} })
      ).json()
    ).total
  ).toBe(2);
  expect(
    (
      await request.post(`${fixture.url}/api/entries`, {
        data: {
          ...command(),
          id: crypto.randomUUID(),
          kind: 'expense',
          name: 'Stale device',
          amount: '1',
        },
      })
    ).status()
  ).toBe(409);
  expect(errors).toEqual([]);
});

test('recovers an expired pause, requires a newly saved current backup, and cancels without replacing records', async ({
  page,
  request,
}) => {
  await setup(page, request);
  await page
    .getByRole('button', {
      name: 'Save current backup and continue',
      exact: true,
    })
    .click();
  await downloadCurrent(page);
  await page
    .getByLabel('I have saved the current ledger backup I just downloaded.', {
      exact: true,
    })
    .check();
  const db = await fixture.runtime.getD1Database('DB');
  await db.batch([
    db.prepare('UPDATE moni_state SET restore_expires_at=0 WHERE singleton=1'),
    db.prepare(
      "UPDATE restore_sessions SET expires_at=0 WHERE source_dataset='initial' AND status IN ('locked','downloaded')"
    ),
  ]);
  await entry(request, {
    name: 'After expiry',
    amount: '5',
    note: '过期后仍可记账',
  });
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('The pause expired');
  await page
    .getByRole('button', {
      name: 'Save current backup and continue',
      exact: true,
    })
    .click();
  const checkbox = page.getByLabel(
    'I have saved the current ledger backup I just downloaded.',
    { exact: true }
  );
  await expect(checkbox).toBeDisabled();
  await expect(checkbox).not.toBeChecked();
  const latest = await downloadCurrent(page);
  expect(latest.data.entries).toHaveLength(5);
  expect(
    latest.data.entries.find(
      (row: { name: string }) => row.name === 'After expiry'
    ).note
  ).toBe('过期后仍可记账');
  await expect(checkbox).not.toBeChecked();
  await page
    .getByRole('button', { name: 'Cancel restore', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Backup preview', exact: true })
  ).toHaveCount(0);
  const current = await (
    await request.post(`${fixture.url}/api/entries/query`, { data: {} })
  ).json();
  expect(current.datasetId).toBe('initial');
  expect(current.total).toBe(4);
  await entry(request, { name: 'After recovered cancellation', amount: '1' });
});

test('can cancel a pause whose successful begin response was lost without leaving the ledger locked', async ({
  page,
  request,
}) => {
  await setup(page, request);
  await page.route('**/api/restores/begin', async (route) => {
    const actual = await route.fetch();
    expect(actual.status()).toBe(200);
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"synthetic_lost_begin_response"}',
    });
  });
  await page
    .getByRole('button', {
      name: 'Save current backup and continue',
      exact: true,
    })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'The restore session was not confirmed.'
  );
  await page
    .getByRole('button', { name: 'Cancel restore', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Backup preview', exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByLabel('Choose JSON backup', { exact: true })
  ).toBeFocused();
  expect(
    (
      await (
        await request.post(`${fixture.url}/api/entries/query`, { data: {} })
      ).json()
    ).total
  ).toBe(3);
  await entry(request, {
    name: 'After lost-response cancellation',
    amount: '1',
  });
});
