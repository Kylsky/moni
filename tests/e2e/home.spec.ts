import { expect, test } from '@playwright/test';
import { startTestServer } from '../../scripts/local-test-server.mjs';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => {
  fixture = await startTestServer();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('owner initializes an empty private ledger and keeps language, navigation and theme', async ({
  page,
  isMobile,
}) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (event) => {
    if (event.type() === 'error') browserErrors.push(event.text());
  });
  await page.goto(fixture.url);
  await expect(
    page.getByRole('heading', { name: 'Create your private ledger' })
  ).toBeVisible();
  await expect(page.getByLabel('Primary currency')).toHaveValue('CNY');
  await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Shanghai');
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await page.getByLabel('Language', { exact: true }).selectOption('zh');
  await expect(
    page.getByRole('heading', { name: '建立你的私人账本' })
  ).toBeVisible();
  await page.getByLabel('主币种', { exact: true }).selectOption('USD');
  await page.getByLabel('时区', { exact: true }).selectOption('UTC');
  await page.getByRole('button', { name: '创建账本' }).click();
  await expect(
    page.getByRole('heading', { name: '今天想记点什么？' })
  ).toBeVisible();
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('button', { name: '午饭35，网站推广20美元', exact: true })
  ).toBeInViewport({ ratio: 1 });
  await expect(
    page.getByRole('button', { name: '最近3个月外卖花了多少钱', exact: true })
  ).toBeInViewport({ ratio: 1 });
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    'noindex, nofollow'
  );
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('主币种', { exact: true })).toHaveValue('USD');
  await expect(page.getByLabel('时区', { exact: true })).toHaveValue('UTC');
  await page.getByLabel('时区', { exact: true }).selectOption('Asia/Tokyo');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('设置已保存。')).toBeVisible();
  const theme = page.locator('[data-slot="theme-switcher-trigger"]');
  await theme.click();
  await page.locator('[data-theme-option="dark"]').click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByLabel('语言', { exact: true }).selectOption('en');
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true })
  ).toBeVisible();
  await expect(page).toHaveURL(/view=settings/);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Tokyo');
  await expect(page.getByText('Configured', { exact: true })).toBeVisible();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute(
    'type',
    'password'
  );
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(page.locator('body')).not.toContainText(
    'synthetic-fixture-not-a-secret'
  );
  await page.getByLabel('Language', { exact: true }).selectOption('browser');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await theme.click();
  await page.locator('[data-theme-option="system"]').click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('link', { name: 'Entries', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Your ledger is empty' })
  ).toBeVisible();
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Reports', exact: true })
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(
    page.getByRole('link', { name: 'Settings', exact: true })
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe(
    'BODY'
  );

  for (const path of [
    '/',
    '/verify',
    '/_serverFn/synthetic',
    '/api/initialize',
    '/api/probe',
    '/api/settings',
    '/api/export',
    '/assets/%2F..%2F_serverFn/synthetic',
  ]) {
    const response = await fixture.runtime.dispatchFetch(
      `https://moni.test${path}`,
      { headers: { 'Accept-Language': 'zh-CN' } }
    );
    expect(response.status, path).toBe(401);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
    const body = await response.text();
    if (!path.startsWith('/api/')) {
      expect(body).toContain('访问受限');
      expect(body).not.toContain('<nav');
      expect(body).not.toContain('创建账本');
    }
  }
  const robots = await fixture.runtime.dispatchFetch(
    'https://moni.test/robots.txt'
  );
  expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
  const sitemap = await fixture.runtime.dispatchFetch(
    'https://moni.test/sitemap.xml'
  );
  expect(await sitemap.text()).not.toContain('<loc>');
  await page.goto(`${fixture.url}/zh`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(
    page.getByRole('heading', { name: '今天想记点什么？' })
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});
