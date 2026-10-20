import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Response as WorkerResponse } from 'miniflare';
import { createTestRuntime } from './test-runtime.mjs';

if (process.env.MONI_REAL_WECHAT_SMOKE !== '1') {
  console.log(
    'Skipped: set MONI_REAL_WECHAT_SMOKE=1 to request a real login QR challenge. This does not bind an account or send messages.'
  );
  process.exit(0);
}
const fixture = await createTestRuntime({
  ai: {},
  wechatSecret: randomBytes(32).toString('hex'),
  provider: async (request) => {
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://ilinkai.weixin.qq.com');
    assert.equal(url.pathname, '/ilink/bot/get_bot_qrcode');
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: await request.arrayBuffer(),
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    return new WorkerResponse(response.body, {
      status: response.status,
      headers: response.headers,
    });
  },
});
try {
  const headers = {
    'Cf-Access-Jwt-Assertion': fixture.ownerToken,
    'Content-Type': 'application/json',
  };
  const initialize = await fixture.runtime.dispatchFetch(
    'https://moni-smoke.invalid/api/initialize',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        datasetId: 'initial',
        operationId: crypto.randomUUID(),
        primaryCurrency: 'CNY',
        timeZone: 'Asia/Shanghai',
      }),
    }
  );
  assert.equal(initialize.status, 200);
  await initialize.body?.cancel();
  const response = await fixture.runtime.dispatchFetch(
    'https://moni-smoke.invalid/api/wechat/connect',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ datasetId: 'initial', locale: 'zh' }),
    }
  );
  assert.equal(
    response.status,
    200,
    'Real QR endpoint unavailable; no account was bound'
  );
  const status = await response.json();
  assert.equal(status.phase, 'waiting');
  assert.ok(status.qrContent && status.loginId);
  assert.equal(status.threadId, undefined);
  assert.equal(status.bot_token, undefined);
  console.log(
    'Real QR endpoint passed through the built Worker and installed SDK. Account binding, message reception, replies and cloud operation remain unverified. QR payload was not logged.'
  );
} finally {
  await fixture.runtime.dispose();
}
