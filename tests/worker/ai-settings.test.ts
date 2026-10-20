import { env } from 'cloudflare:workers';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { aiConfiguration } from '../../src/lib/ai-settings';
import { conversationIntent } from '../../src/lib/conversation-intent';
import { handlePrivateApi } from '../../src/worker';

let signingKey: CryptoKey;
let providerStatus = 200;
let queryResponses = false;
const calls: { url: string; authorization: string | null; body: string }[] = [];
const noAi = { ...env, AI_API_KEY: '', AI_BASE_URL: '', AI_MODEL: '' };
const syntheticKey = 'synthetic-web-key-not-a-real-secret';
const values = {
  version: 0,
  baseURL: 'https://web-model.invalid/v1',
  model: 'web-model',
  apiKey: syntheticKey,
};
beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  signingKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === `${env.ACCESS_ISSUER}/cdn-cgi/access/certs`)
        return Response.json({
          keys: [{ ...jwk, kid: 'ai-settings-key', alg: 'RS256' }],
        });
      const text = await request.text();
      calls.push({
        url: request.url,
        authorization: request.headers.get('Authorization'),
        body: text,
      });
      if (providerStatus !== 200)
        return new Response(`Provider echoed ${syntheticKey}`, {
          status: providerStatus,
        });
      if (request.url.endsWith('/responses')) {
        const body = JSON.parse(text);
        const current = body.input.slice(
          body.input.findLastIndex(
            (item: { role?: string }) => item.role === 'user'
          ) + 1
        );
        const output = body.tools?.some(
          (tool: { name: string }) =>
            tool.name === 'classify_draft_confirmation'
        )
          ? [
              {
                type: 'function_call',
                id: 'fc_synthetic',
                call_id: 'call_synthetic',
                name: 'classify_draft_confirmation',
                arguments: '{"intent":"other"}',
                status: 'completed',
              },
            ]
          : queryResponses &&
              !current.some(
                (item: { type: string }) => item.type === 'function_call_output'
              )
            ? [
                {
                  type: 'function_call',
                  id: 'fc_query_synthetic',
                  call_id: 'call_query_synthetic',
                  name: 'query_ledger',
                  arguments: JSON.stringify({
                    inheritPrevious: false,
                    period: { kind: 'all_time' },
                    scope: 'spending',
                    filters: {},
                    view: 'entries',
                    interval: 'day',
                  }),
                  status: 'completed',
                },
              ]
            : [
                {
                  type: 'message',
                  id: 'msg_synthetic',
                  role: 'assistant',
                  status: 'completed',
                  content: [
                    { type: 'output_text', text: 'OK', annotations: [] },
                  ],
                },
              ];
        return new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', model: 'web-model', output } })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      return new Response(
        `data: ${JSON.stringify({ id: 'config-probe', object: 'chat.completion.chunk', created: 1, model: 'web-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
  );
});
afterAll(() => vi.unstubAllGlobals());
async function api(
  path = 'ai',
  body?: unknown,
  method = 'GET',
  runtime = noAi,
  subject = env.OWNER_SUBJECT
) {
  const token = await new SignJWT({
    type: 'app',
    email: 'synthetic@example.invalid',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'ai-settings-key' })
    .setIssuer(env.ACCESS_ISSUER)
    .setAudience(env.ACCESS_AUDIENCE)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
  return handlePrivateApi(
    new Request(`https://moni.test/api/${path}`, {
      method,
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    runtime
  );
}
describe('owner-managed AI configuration', () => {
  it('requires owner identity and rejects cross-origin configuration writes', async () => {
    expect(
      (await handlePrivateApi(new Request('https://moni.test/api/ai'), env))
        .status
    ).toBe(401);
    expect((await api('ai', values, 'PUT', noAi, 'other-owner')).status).toBe(
      403
    );
    const token = await new SignJWT({
      type: 'app',
      email: 'synthetic@example.invalid',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'ai-settings-key' })
      .setIssuer(env.ACCESS_ISSUER)
      .setAudience(env.ACCESS_AUDIENCE)
      .setSubject(env.OWNER_SUBJECT)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signingKey);
    const response = await handlePrivateApi(
      new Request('https://moni.test/api/ai', {
        method: 'PUT',
        headers: {
          'Cf-Access-Jwt-Assertion': token,
          'Content-Type': 'application/json',
          Origin: 'https://other.invalid',
        },
        body: JSON.stringify(values),
      }),
      noAi
    );
    expect(response.status).toBe(403);
    expect(await aiConfiguration(noAi)).toBeNull();
  });
  it('encrypts a web key, returns metadata only, and excludes it from backups', async () => {
    expect(await (await api()).json()).toMatchObject({
      configured: false,
      editable: true,
      version: 0,
    });
    const response = await api('ai', values, 'PUT');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.text();
    expect(body).not.toContain(syntheticKey);
    expect(JSON.parse(body)).toMatchObject({
      configured: true,
      version: 1,
      model: 'web-model',
    });
    const row = await env.DB.prepare(
      "SELECT encrypted_value FROM service_configuration WHERE name='ai'"
    ).first<string>('encrypted_value');
    expect(row).toMatch(/^v1\./);
    expect(row).not.toContain(syntheticKey);
    expect(row).not.toContain('web-model');
    expect(await aiConfiguration(noAi)).toEqual({
      apiKey: syntheticKey,
      baseURL: values.baseURL,
      model: values.model,
      api: 'chat-completions',
    });
    const backup = await api('exports/backup?datasetId=initial');
    expect(backup.status).toBe(200);
    expect(await backup.text()).not.toMatch(
      /service_configuration|synthetic-web-key|web-model/
    );
  });
  it('retains the key on blank input and rejects stale concurrent changes', async () => {
    const response = await api(
      'ai',
      { ...values, apiKey: '', version: 1, model: 'updated-model' },
      'PUT'
    );
    expect(response.status).toBe(200);
    expect(await aiConfiguration(noAi)).toMatchObject({
      apiKey: syntheticKey,
      model: 'updated-model',
    });
    expect((await api('ai', { ...values, version: 1 }, 'PUT')).status).toBe(
      409
    );
    expect(await aiConfiguration(noAi)).toMatchObject({
      model: 'updated-model',
    });
  });
  it('tests synthetic text through TanStack without saving or touching ledger data', async () => {
    const before = calls.length;
    for (const [path, method] of [
      ['ai', 'PUT'],
      ['ai/test', 'POST'],
    ])
      expect(
        (
          await api(
            path,
            {
              ...values,
              baseURL: 'https://other-provider.invalid/v1',
              apiKey: '',
              version: 2,
            },
            method
          )
        ).status
      ).toBe(400);
    expect(calls).toHaveLength(before);
    const response = await api(
      'ai/test',
      { ...values, apiKey: '', version: 2 },
      'POST'
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: true });
    expect(calls.at(-1)).toMatchObject({
      url: 'https://web-model.invalid/v1/chat/completions',
      authorization: `Bearer ${syntheticKey}`,
    });
    expect(calls.at(-1)?.body).toContain('Reply only OK.');
    expect(await (await api()).json()).toMatchObject({
      version: 2,
      model: 'updated-model',
    });
    expect(
      (
        await env.DB.prepare('SELECT count(*) AS n FROM entries').first<{
          n: number;
        }>()
      )?.n
    ).toBe(0);
    providerStatus = 401;
    const failed = await api('ai/test', { ...values, version: 2 }, 'POST');
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(syntheticKey);
    providerStatus = 200;
  });
  it('uses web credentials for ordinary and WeChat-shared intent calls, never an old env key', async () => {
    expect(await aiConfiguration(env)).toMatchObject({
      apiKey: syntheticKey,
      model: 'updated-model',
    });
    const status = await api('status');
    expect(await status.json()).toMatchObject({ aiConfigured: true });
    const ordinary = await api(
      'probe',
      {
        datasetId: 'initial',
        threadId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        text: 'Synthetic web configuration check',
      },
      'POST'
    );
    expect(ordinary.status).toBe(200);
    expect(await ordinary.text()).toContain('RUN_FINISHED');
    expect(calls.at(-1)?.authorization).toBe(`Bearer ${syntheticKey}`);
    const corrupt = { ...env, CONFIG_ENCRYPTION_KEY: 'f'.repeat(64) };
    expect(await aiConfiguration(corrupt)).toBeNull();
    expect(
      await (await api('ai', undefined, 'GET', corrupt)).json()
    ).toMatchObject({ configured: false, unreadable: true });
  });
  it('clears configuration without reviving an environment key or removing ledger records', async () => {
    expect(
      (await api('ai', { version: 2, confirmed: true }, 'DELETE', env)).status
    ).toBe(200);
    expect(await aiConfiguration(env)).toBeNull();
    expect(await (await api()).json()).toMatchObject({
      configured: false,
      baseURL: '',
      model: '',
      version: 3,
    });
    expect(
      (await api('ai', { ...values, apiKey: '', version: 3 }, 'PUT')).status
    ).toBe(400);
    expect(
      (
        await api('ai', { ...values, version: 3 }, 'PUT', {
          ...noAi,
          CONFIG_ENCRYPTION_KEY: '',
        })
      ).status
    ).toBe(503);
  });
  it.each([
    'http://provider.invalid',
    'https://user:pass@provider.invalid',
    'https://provider.invalid?key=secret',
    'https://provider.invalid#fragment',
  ])('rejects unsafe provider URL %s', async (baseURL) => {
    expect(
      (await api('ai', { ...values, version: 3, baseURL }, 'PUT')).status
    ).toBe(400);
  });
  it('uses an encrypted Responses selection for the probe, shared classifier and persisted chat', async () => {
    const version = (await (await api()).json<{ version: number }>()).version;
    expect(
      (await api('ai', { ...values, version, api: 'responses' }, 'PUT')).status
    ).toBe(200);
    expect(await (await api()).json()).toMatchObject({
      api: 'responses',
      version: version + 1,
    });
    const before = calls.length;
    const response = await api(
      'ai/test',
      { ...values, version: version + 1, apiKey: '', api: 'responses' },
      'POST'
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: true });
    expect(
      (
        await api(
          'ai/test',
          { ...values, version: version + 1, apiKey: '' },
          'POST'
        )
      ).status
    ).toBe(200);
    expect(
      await conversationIntent(noAi, '今天花了多少钱？', {
        reviewed: false,
        otherPendingDrafts: 0,
        items: [],
      })
    ).toBe('other');
    const threadId = crypto.randomUUID();
    const chat = await api(
      'probe',
      {
        datasetId: 'initial',
        threadId,
        runId: crypto.randomUUID(),
        text: 'Synthetic Responses check',
      },
      'POST'
    );
    expect(chat.status).toBe(200);
    expect(await chat.text()).toContain('OK');
    const history = await api(`probe?threadId=${threadId}`);
    expect(await history.text()).toContain('OK');
    expect(
      calls
        .slice(before)
        .every((call) => call.url === `${values.baseURL}/responses`)
    ).toBe(true);
    expect(
      calls
        .slice(before)
        .every((call) => call.authorization === `Bearer ${syntheticKey}`)
    ).toBe(true);
    const payload = JSON.parse(calls[before].body);
    expect(payload.input).toBeDefined();
    expect(payload.messages).toBeUndefined();
    expect(await aiConfiguration(noAi)).toMatchObject({
      api: 'responses',
      apiKey: syntheticKey,
    });
    const command = () => ({
      datasetId: 'initial',
      operationId: crypto.randomUUID(),
    });
    expect(
      (
        await api(
          'initialize',
          { ...command(), primaryCurrency: 'CNY', timeZone: 'Asia/Shanghai' },
          'POST'
        )
      ).status
    ).toBe(200);
    const formalId = crypto.randomUUID();
    expect(
      (await api('conversations', { ...command(), id: formalId }, 'POST'))
        .status
    ).toBe(200);
    expect(
      (
        await api(
          'entries',
          {
            ...command(),
            id: crypto.randomUUID(),
            kind: 'expense',
            name: 'Synthetic Responses lunch',
            amount: '35',
            currency: 'CNY',
            date: '2026-10-19',
            categoryId: 'expense-food',
            tags: [],
            note: 'Synthetic note',
          },
          'POST'
        )
      ).status
    ).toBe(200);
    queryResponses = true;
    try {
      const formal = await api(
        'chat',
        {
          datasetId: 'initial',
          threadId: formalId,
          version: 1,
          runId: crypto.randomUUID(),
          text: '合成测试：查看全部账目明细',
        },
        'POST'
      );
      expect(formal.status).toBe(200);
      const stream = await formal.text();
      expect(stream).toContain('query_ledger');
      expect(stream).toContain('Synthetic Responses lunch');
      expect(stream).toContain('Synthetic note');
      expect(stream).toContain('RUN_FINISHED');
      expect(stream).not.toContain('暂时未完成');
      expect(
        calls
          .slice(before)
          .every((call) => call.url === `${values.baseURL}/responses`)
      ).toBe(true);
      expect(calls.at(-1)?.body).toContain('CNY 35.00');
      expect(
        (
          await (
            await api('entries/query', {}, 'POST')
          ).json<{ total: number }>()
        ).total
      ).toBe(1);
    } finally {
      queryResponses = false;
    }
  });
});
