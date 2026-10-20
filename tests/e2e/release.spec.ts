import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { Response as WorkerResponse } from 'miniflare';
import { startTestServer } from '../../scripts/local-test-server.mjs';

const fixtures: Awaited<ReturnType<typeof startTestServer>>[] = [];
test.afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
const command = () => ({
  datasetId: 'initial',
  operationId: crypto.randomUUID(),
});

test('separate Worker instances isolate equal ledger, conversation and run IDs and deny every unauthenticated application entry', async () => {
  test.setTimeout(60_000);
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  expect(config.name).not.toBe(config.env.preview.name);
  expect(config.d1_databases[0].database_name).not.toBe(
    config.env.preview.d1_databases[0].database_name
  );
  for (const candidate of [config, config.env.preview]) {
    expect(candidate.workers_dev).toBe(true);
    expect(candidate.d1_databases[0].remote).not.toBe(true);
    expect(candidate.durable_objects.bindings[0].script_name).toBeUndefined();
    expect(candidate.account_id).toBeUndefined();
    expect(candidate.routes).toBeUndefined();
  }
  const entryId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const labels = ['Synthetic production', 'Synthetic preview'];
  for (const label of labels) {
    const fixture = await startTestServer(0, {
      provider: async () =>
        new WorkerResponse(
          `data: ${JSON.stringify({
            id: 'synthetic-isolation',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'synthetic-model',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: label },
                finish_reason: 'stop',
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } }
        ),
    });
    fixtures.push(fixture);
    const api = async (path: string, data: unknown) => {
      const response = await fixture.runtime.dispatchFetch(
        `https://moni.test/api/${path}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Jwt-Assertion': fixture.ownerToken,
          },
          body: JSON.stringify(data),
        }
      );
      expect(response.status, path).toBe(200);
      return response;
    };
    await api('initialize', {
      ...command(),
      primaryCurrency: 'CNY',
      timeZone: 'Asia/Shanghai',
    });
    await api('entries', {
      ...command(),
      id: entryId,
      kind: 'expense',
      name: label,
      amount: '35',
      note: `${label} note`,
    });
    await api('conversations', { ...command(), id: threadId });
    expect(
      await (
        await api('chat', {
          datasetId: 'initial',
          threadId,
          runId,
          version: 1,
          text: label,
        })
      ).text()
    ).toContain('RUN_FINISHED');
  }
  const apiPaths = [
    ...new Set(
      (await readFile('src/worker.ts', 'utf8')).match(/\/api\/[a-z/-]+/g)
    ),
  ];
  expect(apiPaths.length).toBeGreaterThan(25);
  for (const [index, fixture] of fixtures.entries()) {
    const label = labels[index];
    const other = labels[1 - index];
    const headers = { 'Cf-Access-Jwt-Assertion': fixture.ownerToken };
    const records = await fixture.runtime.dispatchFetch(
      'https://moni.test/api/entries',
      { headers }
    );
    const entries = (await records.json()) as {
      id: string;
      name: string;
      note: string;
    }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: entryId,
      name: label,
      note: `${label} note`,
    });
    const history = await fixture.runtime.dispatchFetch(
      `https://moni.test/api/chat?threadId=${threadId}`,
      { headers }
    );
    const text = await history.text();
    expect(text).toContain(label);
    expect(text).not.toContain(other);
    expect(history.headers.get('Cache-Control')).toContain('no-store');
    const wrongIdentity = await fixture.runtime.dispatchFetch(
      'https://moni.test/api/entries',
      {
        headers: { 'Cf-Access-Jwt-Assertion': fixtures[1 - index].ownerToken },
      }
    );
    expect(wrongIdentity.status).toBe(403);
    await Promise.all(
      ['/', '/zh', '/verify', '/_serverFn/unknown', ...apiPaths].map(
        async (path) => {
          const response = await fixture.runtime.dispatchFetch(
            `https://alternate-entry.invalid${path}`
          );
          expect(response.status, path).toBe(401);
          expect(response.headers.get('Cache-Control')).toContain('no-store');
          expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
          const body = await response.text();
          expect(body).not.toContain(label);
          expect(body).not.toContain('synthetic-fixture-not-a-secret');
        }
      )
    );
  }
});

test('a fresh owner can initialize, manually book foreign spending, filter notes, read reports and back up with AI absent', async ({
  page,
  isMobile,
}) => {
  const calls: string[] = [];
  const fixture = await startTestServer(0, {
    ai: {},
    provider: async (request) => {
      calls.push(new URL(request.url).origin);
      throw new Error('No external services in manual release acceptance');
    },
  });
  fixtures.push(fixture);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(fixture.url);
  await expect(page.getByText('Not configured', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Create ledger', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'What would you like to record today?',
      exact: true,
    })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true })
  ).toBeDisabled();
  await page.setViewportSize(
    isMobile ? { width: 390, height: 844 } : { width: 1440, height: 1024 }
  );
  await page.screenshot({
    path: `docs/verification/screenshots/s6-ai-unconfigured-${isMobile ? 'mobile' : 'pc'}.png`,
  });
  await page.getByRole('link', { name: 'Manual entry', exact: true }).click();
  await page
    .getByLabel('Name', { exact: true })
    .fill('Synthetic independent promotion');
  await page.getByLabel('Amount', { exact: true }).fill('20');
  await page
    .getByRole('combobox', { name: 'Entry currency', exact: true })
    .click();
  await page.getByRole('option', { name: 'USD', exact: true }).click();
  await page.getByRole('button', { name: 'Manual rate', exact: true }).click();
  await page.getByLabel('Exchange rate', { exact: false }).fill('7.20');
  await page.getByLabel('Note', { exact: true }).fill('Synthetic KFC keyword');
  await page
    .getByRole('button', { name: 'Confirm and save', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Synthetic independent promotion',
      exact: true,
    })
  ).toBeVisible();
  const url = new URL(fixture.url);
  url.searchParams.set('view', 'entries');
  url.searchParams.set('filters', JSON.stringify({ keyword: 'KFC' }));
  await page.goto(url.toString());
  await expect(
    page.getByText('Matching entries: 1', { exact: true })
  ).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Reports', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Reports', exact: true })
  ).toBeVisible();
  await expect(
    page
      .getByRole('region', {
        name: 'Totals for all matching entries',
        exact: true,
      })
      .getByText('CN¥144.00', { exact: true })
      .first()
  ).toBeVisible();
  await page.goto(`${fixture.url}/?view=settings&panel=backup`);
  const pending = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download complete backup', exact: true })
    .click();
  const backupPath = await (await pending).path();
  if (!backupPath) throw new Error('Expected private backup download');
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  expect(backup.data.entries[0]).toMatchObject({
    originalMinor: 2000,
    baseMinor: 14400,
    note: 'Synthetic KFC keyword',
  });
  expect(
    calls.every((origin) => origin === 'https://api.frankfurter.dev')
  ).toBe(true);
  expect(errors).toEqual([]);
});

test('an unauthenticated browser receives only the bilingual restricted view, public setup guidance and a verification retry', async ({
  page,
  isMobile,
}) => {
  const fixture = await startTestServer(0, { ai: {} });
  fixtures.push(fixture);
  await page.route(`${fixture.url}/`, async (route) => {
    const response = await fixture.runtime.dispatchFetch('https://moni.test/', {
      headers: { 'Accept-Language': 'zh-CN' },
    });
    expect(response.status).toBe(401);
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  await page.setViewportSize(
    isMobile ? { width: 390, height: 844 } : { width: 1440, height: 1024 }
  );
  await page.emulateMedia({ colorScheme: 'light' });
  const response = await page.goto(fixture.url);
  expect(response?.status()).toBe(401);
  await expect(
    page.getByRole('heading', { name: '访问受限', exact: true })
  ).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: '重新验证访问', exact: true })
  ).toHaveAttribute('href', '/');
  await page.screenshot({
    path: `docs/verification/screenshots/s6-restricted-${isMobile ? 'mobile' : 'pc'}.png`,
  });
  await page.getByText('查看配置说明', { exact: true }).click();
  await expect(page.getByText(/无需在网页输入密钥或认领账本/)).toBeVisible();
  await expect(page.locator('input')).toHaveCount(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('img.dark')).toBeVisible();
  await expect(page.locator('img.light')).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
});

test('a new deployment opens setup before secrets are configured and never exposes or initializes a ledger', async ({
  page,
  isMobile,
}) => {
  const fixture = await startTestServer(0, {
    ai: {},
    access: { ACCESS_ISSUER: '', ACCESS_AUDIENCE: '', OWNER_SUBJECT: '' },
    provider: async () => {
      throw new Error('Deployment setup must not contact external services');
    },
  });
  fixtures.push(fixture);
  for (const [path, title] of [
    ['/', 'Welcome to Moni'],
    ['/zh', '欢迎使用 Moni'],
  ]) {
    await page.setViewportSize(
      isMobile ? { width: 390, height: 844 } : { width: 1440, height: 1024 }
    );
    await page.emulateMedia({ colorScheme: 'light' });
    const response = await page.goto(`${fixture.url}${path}`);
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole('heading', { level: 1, name: title })
    ).toBeVisible();
    await expect(page.getByRole('list')).toHaveCount(2);
    if (path === '/zh')
      await page.screenshot({
        path: `.wrangler/deployment-review/setup-${isMobile ? 'mobile' : 'pc'}.png`,
        fullPage: true,
      });
    await expect(page.locator('form, input, textarea')).toHaveCount(0);
    await page
      .getByRole('link', { name: /Verify access again|重新验证访问/ })
      .click();
    await expect(
      page.getByRole('heading', { level: 1, name: title })
    ).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator(`img.${theme}`)).toBeVisible();
      await page.setViewportSize({ width: 320, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).toBe(true);
    }
  }
  for (const path of ['/api/settings', '/api/entries', '/api/wechat']) {
    const response = await page.request.get(`${fixture.url}${path}`);
    expect(response.status()).toBe(503);
    expect(await response.json()).toEqual({ error: 'access_not_configured' });
  }
  for (const path of ['/verify', '/_serverFn/unknown']) {
    const response = await page.request.get(`${fixture.url}${path}`);
    expect(response.status()).toBe(503);
    expect(await response.text()).not.toContain('Welcome to Moni');
  }
  expect((await page.request.post(fixture.url)).status()).toBe(503);
  const head = await page.request.head(fixture.url);
  expect(head.status()).toBe(200);
  expect(await head.text()).toBe('');
  expect(
    (
      await page.request.post(`${fixture.url}/api/initialize`, {
        data: command(),
      })
    ).status()
  ).toBe(503);
  const db = await fixture.runtime.getD1Database('DB');
  expect(await db.prepare('SELECT initialized FROM datasets').first()).toEqual({
    initialized: 0,
  });
});
