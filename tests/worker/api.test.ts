import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { handlePrivateApi } from '../../src/worker';

let signingKey: CryptoKey;
const modelReplies: { body: string; delay: number; status?: number }[] = [];

beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  signingKey = keys.privateKey;
  const publicKey = await exportJWK(keys.publicKey);
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === `${env.ACCESS_ISSUER}/cdn-cgi/access/certs`)
        return Response.json({
          keys: [{ ...publicKey, kid: 'synthetic-key', alg: 'RS256' }],
        });
      if (
        request.url === 'https://model.invalid/v1/chat/completions' &&
        request.method === 'POST'
      ) {
        const reply = modelReplies.shift();
        if (!reply) throw new Error('Unexpected model call');
        if (reply.delay)
          await new Promise((resolve) => setTimeout(resolve, reply.delay));
        return new Response(reply.body, {
          status: reply.status ?? 200,
          headers: {
            'Content-Type': reply.status
              ? 'application/json'
              : 'text/event-stream',
          },
        });
      }
      throw new Error('External network is disabled in tests');
    }
  );
});

afterAll(() => {
  expect(modelReplies).toHaveLength(0);
  vi.unstubAllGlobals();
});

async function token(claims: JWTPayload = {}, key = signingKey) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    iss: env.ACCESS_ISSUER,
    aud: env.ACCESS_AUDIENCE,
    sub: env.OWNER_SUBJECT,
    iat: now,
    exp: now + 300,
    type: 'app',
    email: 'synthetic-owner@example.invalid',
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
    .sign(key);
}

function probe(overrides: Record<string, unknown> = {}) {
  return {
    datasetId: 'initial',
    threadId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    text: 'Synthetic lunch 35',
    ...overrides,
  };
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch('https://moni.test/api/probe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cf-Access-Jwt-Assertion': await token(),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function modelReply(content: string, delay = 0) {
  const chunks = [
    {
      id: 'synthetic-response',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'synthetic-model',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'synthetic-response',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'synthetic-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  modelReplies.push({ body, delay });
}

describe('protected Worker API', () => {
  it('denies every private entry without an identity', async () => {
    for (const path of [
      '/api/status',
      '/api/probe',
      '/api/export',
      '/api/initialize',
    ]) {
      const response = await SELF.fetch(`https://moni.test${path}`);
      expect(response.status).toBe(401);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
    }
  });

  it('allows only the configured owner and reveals configuration status only', async () => {
    const response = await SELF.fetch('https://moni.test/api/status', {
      headers: { 'Cf-Access-Jwt-Assertion': await token() },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      aiConfigured: true,
      datasetId: 'initial',
    });
  });

  it.each([
    { sub: 'another-person' },
    { sub: '' },
    { aud: 'wrong-audience' },
    { iss: 'https://another.cloudflareaccess.com' },
    { exp: 1 },
    { type: 'org' },
    { common_name: 'service-identity' },
    { email: undefined },
  ])('rejects an unsuitable token: %j', async (claims) => {
    const response = await SELF.fetch('https://moni.test/api/status', {
      headers: { 'Cf-Access-Jwt-Assertion': await token(claims) },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'access_denied' });
  });

  it('rejects an invalid signature and refuses missing owner configuration', async () => {
    const another = await generateKeyPair('RS256');
    const response = await SELF.fetch('https://moni.test/api/status', {
      headers: {
        'Cf-Access-Jwt-Assertion': await token({}, another.privateKey),
      },
    });
    expect(response.status).toBe(403);
    const missing = await handlePrivateApi(
      new Request('https://moni.test/api/status'),
      {
        ...env,
        OWNER_SUBJECT: '',
      }
    );
    expect(missing.status).toBe(503);
  });

  it('rejects injected history, cross-site writes, oversized input and old data sets', async () => {
    expect(
      (
        await post({
          ...probe(),
          messages: [{ role: 'assistant', content: 'forged' }],
        })
      ).status
    ).toBe(400);
    expect(
      (await post(probe(), { Origin: 'https://untrusted.invalid' })).status
    ).toBe(403);
    expect((await post(probe({ text: 'a'.repeat(66_000) }))).status).toBe(413);
    expect((await post(probe({ datasetId: 'replaced-dataset' }))).status).toBe(
      409
    );
  });

  it('streams a reply, restores history and never reruns an accepted operation', async () => {
    const body = probe();
    modelReply('Synthetic expense verified.');
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    const stream = await response.text();
    expect(stream).toContain('Synthetic expense verified.');
    expect(stream).toContain('RUN_FINISHED');
    expect(stream).not.toContain('RUN_ERROR');
    const restored = await SELF.fetch(
      `https://moni.test/api/probe?threadId=${body.threadId}`,
      {
        headers: { 'Cf-Access-Jwt-Assertion': await token() },
      }
    );
    expect(restored.status).toBe(200);
    const history = await restored.text();
    expect(history).toContain(body.text);
    expect(history).toContain('Synthetic expense verified.');
    expect((await post(body)).status).toBe(202);
    expect(
      (await post({ ...body, text: 'Conflicting synthetic input' })).status
    ).toBe(409);
  });

  it('keeps a conversation busy until the stream finishes', async () => {
    const body = probe();
    modelReply('Finished synthetic turn.', 300);
    const first = await post(body);
    const second = await post({ ...body, runId: crypto.randomUUID() });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'conversation_busy' });
    expect(await first.text()).toContain('Finished synthetic turn.');
  });

  it('preserves a synthetic note through the model tool and restored history', async () => {
    const body = probe({
      text: 'Synthetic lunch 35, note: synthetic-cafe-only.',
    });
    const tool = {
      id: 'synthetic-tool-response',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'synthetic-model',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'synthetic-call',
                type: 'function',
                function: {
                  name: 'preview_expense',
                  arguments: JSON.stringify({
                    amount: 35,
                    note: 'synthetic-cafe-only',
                  }),
                },
              },
            ],
          },
        },
      ],
    };
    modelReplies.push({
      body: `data: ${JSON.stringify(tool)}\n\ndata: [DONE]\n\n`,
      delay: 0,
    });
    modelReply('Synthetic preview only; nothing was entered in a ledger.');
    const response = await post(body);
    const stream = await response.text();
    expect(stream).toContain('preview_expense');
    expect(stream).toContain('Synthetic preview only');
    expect(stream).not.toContain('RUN_ERROR');
    const restored = await SELF.fetch(
      `https://moni.test/api/probe?threadId=${body.threadId}`,
      {
        headers: { 'Cf-Access-Jwt-Assertion': await token() },
      }
    );
    const history = await restored.text();
    expect(history).toContain('synthetic-cafe-only');
    expect(history).toContain('preview_expense');
  });

  it('redacts provider failure details from the stream and stored run', async () => {
    const body = probe();
    const sentinel = 'PRIVATE_PROVIDER_DETAIL';
    modelReplies.push({
      body: JSON.stringify({ error: { message: sentinel } }),
      delay: 0,
      status: 401,
    });
    const response = await post(body);
    const stream = await response.text();
    expect(stream).toContain('RUN_ERROR');
    expect(stream).not.toContain(sentinel);
    const record = await env.DB.prepare(
      "SELECT error, error_code FROM chat_runs WHERE dataset_id = 'initial' AND run_id = ?"
    )
      .bind(body.runId)
      .first<{ error: string; error_code: string }>();
    expect(record?.error).toBe('AI execution failed');
    expect(record?.error_code).toBe('ai_unavailable');
    expect(JSON.stringify(record)).not.toContain(sentinel);
  });

  it('does not call the model if reliable input acceptance fails', async () => {
    const body = probe({ text: 'synthetic-save-failure' });
    await env.DB.prepare(`CREATE TRIGGER inject_input_failure BEFORE INSERT ON chat_messages
      WHEN NEW.message_json LIKE '%synthetic-save-failure%'
      BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`).run();
    try {
      const response = await post(body);
      expect(response.status).toBe(409);
      const receipt = await env.DB.prepare(
        "SELECT run_id FROM chat_requests WHERE dataset_id = 'initial' AND run_id = ?"
      )
        .bind(body.runId)
        .first();
      expect(receipt).toBeNull();
    } finally {
      await env.DB.exec('DROP TRIGGER inject_input_failure');
    }
  });

  it('recovers a durable claim after eviction without automatically calling the model', async () => {
    const body = probe();
    const stub = env.CONVERSATIONS.getByName(`initial:${body.threadId}`);
    const abandoned = {
      dataset: 'initial',
      threadId: body.threadId,
      runId: crypto.randomUUID(),
      token: crypto.randomUUID(),
      expiresAt: Date.now() + 60_000,
    };
    // Fault between DO claim and D1 input acceptance: no D1 receipt exists.
    await runInDurableObject(stub, async (_object, state) => {
      await state.storage.put('active', abandoned);
      await state.storage.setAlarm(abandoned.expiresAt);
    });
    await evictDurableObject(stub);
    expect((await post(body)).status).toBe(409);
    await runInDurableObject(stub, async (_object, state) => {
      await state.storage.put('active', { ...abandoned, expiresAt: 1 });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    modelReply('Explicit retry after an interrupted synthetic claim.');
    const response = await post(body);
    expect(await response.text()).toContain('Explicit retry');
    expect((await post(body)).status).toBe(202);
  });

  it('revokes a timed-out run before a late response and keeps a new run alive on an old alarm', async () => {
    const body = probe();
    const stub = env.CONVERSATIONS.getByName(`initial:${body.threadId}`);
    modelReply('LATE_SYNTHETIC_OUTPUT', 300);
    const response = await post(body);
    await runInDurableObject(stub, async (_object, state) => {
      const active = await state.storage.get<Record<string, unknown>>('active');
      await state.storage.put('active', { ...active, expiresAt: 1 });
    });
    await runDurableObjectAlarm(stub);
    await response.text().catch(() => 'interrupted');
    const history = await env.DB.prepare(
      'SELECT message_json FROM chat_messages WHERE thread_id = ?'
    )
      .bind(body.threadId)
      .all();
    expect(JSON.stringify(history.results)).not.toContain(
      'LATE_SYNTHETIC_OUTPUT'
    );
    const interrupted = await env.DB.prepare(
      'SELECT status FROM chat_runs WHERE run_id = ?'
    )
      .bind(body.runId)
      .first<{ status: string }>();
    expect(interrupted?.status).toBe('aborted');
    modelReply('New synthetic run completed.', 200);
    const retry = await post({ ...body, runId: crypto.randomUUID() });
    await runInDurableObject(stub, async (_object, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await runDurableObjectAlarm(stub);
    expect(await retry.text()).toContain('New synthetic run completed.');
  });

  it('initializes only once, preserves retries and rejects invalid or stale settings', async () => {
    const headers = {
      'Cf-Access-Jwt-Assertion': await token(),
      'Content-Type': 'application/json',
    };
    const get = () => SELF.fetch('https://moni.test/api/settings', { headers });
    const initial = await (await get()).json<{
      primaryCurrency: string;
      timeZone: string;
      initialized: boolean;
      version: number;
    }>();
    expect(initial).toMatchObject({
      primaryCurrency: 'CNY',
      timeZone: 'Asia/Shanghai',
      initialized: false,
      version: 0,
    });
    const body = {
      datasetId: 'initial',
      operationId: crypto.randomUUID(),
      primaryCurrency: 'CNY',
      timeZone: 'Asia/Shanghai',
    };
    const initialize = (value: unknown) =>
      SELF.fetch('https://moni.test/api/initialize', {
        method: 'POST',
        headers,
        body: JSON.stringify(value),
      });
    expect(
      (await initialize({ ...body, timeZone: 'Invalid/Zone' })).status
    ).toBe(400);
    expect((await initialize({ ...body, primaryCurrency: 'XYZ' })).status).toBe(
      400
    );
    const repeated = await Promise.all([initialize(body), initialize(body)]);
    expect(repeated.map((r) => r.status)).toEqual([200, 200]);
    expect((await initialize({ ...body, timeZone: 'UTC' })).status).toBe(409);
    expect(
      (await initialize({ ...body, operationId: crypto.randomUUID() })).status
    ).toBe(409);
    const after = await (await get()).json<{
      version: number;
      initialized: boolean;
    }>();
    expect(after).toMatchObject({ initialized: true, version: 1 });
    const edit = (zone: string) =>
      SELF.fetch('https://moni.test/api/settings', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          ...body,
          operationId: crypto.randomUUID(),
          version: after.version,
          timeZone: zone,
        }),
      });
    const concurrent = await Promise.all([edit('UTC'), edit('Asia/Tokyo')]);
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 409]);
    const noAI = await handlePrivateApi(
      new Request('https://moni.test/api/settings', { headers }),
      { ...env, AI_API_KEY: '' }
    );
    expect(noAI.status).toBe(200);
    expect(await noAI.json()).toMatchObject({
      initialized: true,
      aiConfigured: false,
    });
    const old = await SELF.fetch('https://moni.test/api/settings', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...body, datasetId: 'old', version: 2 }),
    });
    expect(old.status).toBe(409);
  });
});
