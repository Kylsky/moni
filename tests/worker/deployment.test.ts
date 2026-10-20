import { applyD1Migrations, env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { deploymentSetupPage } from '../../src/lib/restricted-page';
import { handlePrivateApi } from '../../src/worker';

const unconfigured = () => ({
  ...env,
  ACCESS_ISSUER: '',
  ACCESS_AUDIENCE: '',
  OWNER_SUBJECT: '',
  AI_API_KEY: '',
  AI_BASE_URL: '',
  AI_MODEL: '',
  WECHAT_SECRET: '',
});

it('opens bilingual deployment guidance without AI, WeChat or identity secrets and keeps every business operation protected', async () => {
  const config = unconfigured();
  for (const [path, title] of [
    ['/', 'Welcome to Moni'],
    ['/zh', '欢迎使用 Moni'],
  ]) {
    const response = await deploymentSetupPage(
      new Request(`https://moni.test${path}`),
      config
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
    const html = await response.text();
    expect(html).toContain(`<h1>${title}</h1>`);
    expect(html).toContain('All traffic');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<form');
    expect(html).not.toContain(env.OWNER_SUBJECT);
    expect(html).not.toContain(env.AI_API_KEY);
    for (const api of [
      'status',
      'settings',
      'entries',
      'initialize',
      'wechat',
    ]) {
      const denied = await handlePrivateApi(
        new Request(`https://moni.test/api/${api}`),
        config
      );
      expect(denied.status).toBe(503);
      expect(await denied.json()).toEqual({ error: 'access_not_configured' });
    }
  }
});

it('does not report ready for an empty or partially migrated database and recovers after migrations', async () => {
  const config = { ...unconfigured(), DB: env.DB_UPGRADE };
  const request = new Request('https://moni.test/zh');
  expect((await deploymentSetupPage(request, config)).status).toBe(503);
  await applyD1Migrations(env.DB_UPGRADE, env.TEST_MIGRATIONS.slice(0, -1));
  const partial = await deploymentSetupPage(request, config);
  expect(partial.status).toBe(503);
  expect(await partial.text()).toContain('需要完成数据库绑定与迁移');
  await applyD1Migrations(env.DB_UPGRADE, env.TEST_MIGRATIONS);
  const ready = await deploymentSetupPage(request, config);
  expect(ready.status).toBe(200);
  expect(await ready.text()).toContain('账本存储：已就绪');
});

it('keeps setup guidance readable when a database or conversation binding is absent', async () => {
  for (const binding of ['DB', 'CONVERSATIONS'] as const) {
    const config = unconfigured();
    Reflect.deleteProperty(config, binding);
    const response = await deploymentSetupPage(
      new Request('https://moni.test/'),
      config
    );
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain('Finish deployment setup');
    expect(html).not.toContain('TypeError');
    expect(html).not.toContain('D1_ERROR');
  }
});

it('supports readiness HEAD requests without returning HTML or changing the ledger', async () => {
  const before = await env.DB.prepare('SELECT * FROM datasets').all();
  const response = await deploymentSetupPage(
    new Request('https://moni.test/', { method: 'HEAD' }),
    unconfigured()
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('');
  expect(
    (await env.DB.prepare('SELECT * FROM datasets').all()).results
  ).toEqual(before.results);
});
