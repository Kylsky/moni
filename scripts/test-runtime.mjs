import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  convertV4MiniflareOptions,
  Miniflare,
  Response as WorkerResponse,
} from 'miniflare';

export async function createTestRuntime({
  ai = {
    AI_API_KEY: 'synthetic-fixture-not-a-secret',
    AI_BASE_URL: 'https://model.invalid/v1',
    AI_MODEL: 'synthetic-model',
  },
  provider,
  wechatSecret = '',
  persistencePath,
  access = {},
} = {}) {
  const issuer = 'https://moni-browser-test.cloudflareaccess.com';
  const keys = await generateKeyPair('RS256', { extractable: true });
  const publicKey = await exportJWK(keys.publicKey);
  const ownerToken = await new SignJWT({
    type: 'app',
    email: 'synthetic@example.invalid',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'browser-fixture' })
    .setIssuer(issuer)
    .setAudience('browser-fixture')
    .setSubject('synthetic-owner')
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(keys.privateKey);

  function modelStream(delta, finishReason) {
    const chunk = {
      id: 'synthetic-fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'synthetic-model',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    return new WorkerResponse(
      `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
      {
        headers: { 'Content-Type': 'text/event-stream' },
      }
    );
  }

  const workerRoot = resolve('dist/server');
  const workerModules = [
    'index.js',
    ...(await readdir(workerRoot, { recursive: true })).filter(
      (name) => name.endsWith('.js') && name !== 'index.js'
    ),
  ];
  const runtime = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: workerModules.map((name) => ({
        type: 'ESModule',
        path: resolve(workerRoot, name),
      })),
      modulesRoot: workerRoot,
      compatibilityDate: '2026-08-11',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      durableObjects: {
        CONVERSATIONS: { className: 'Conversation', useSQLite: true },
        WECHAT: { className: 'WechatBot', useSQLite: true },
      },
      bindings: {
        ACCESS_ISSUER: issuer,
        ACCESS_AUDIENCE: 'browser-fixture',
        OWNER_SUBJECT: 'synthetic-owner',
        WECHAT_SECRET: wechatSecret,
        CONFIG_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(4),
        ...ai,
        ...access,
      },
      outboundService: async (request) => {
        if (request.url === `${issuer}/cdn-cgi/access/certs`)
          return WorkerResponse.json({
            keys: [{ ...publicKey, kid: 'browser-fixture', alg: 'RS256' }],
          });
        if (provider) return provider(request);
        if (request.url === 'https://model.invalid/v1/chat/completions') {
          const input = await request.json();
          if (
            input.tools?.some(
              (tool) => tool.function.name === 'classify_draft_confirmation'
            )
          )
            return modelStream(
              {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: crypto.randomUUID(),
                    type: 'function',
                    function: {
                      name: 'classify_draft_confirmation',
                      arguments: JSON.stringify({ intent: 'other' }),
                    },
                  },
                ],
              },
              'tool_calls'
            );
          if (
            !input.tools?.some(
              (tool) => tool.function.name === 'preview_expense'
            )
          )
            return modelStream(
              {
                role: 'assistant',
                content: 'Saved synthetic conversation reply.',
              },
              'stop'
            );
          if (input.messages.at(-1)?.role === 'tool')
            return modelStream(
              {
                role: 'assistant',
                content:
                  'Verified synthetic lunch 35; note: s0-synthetic-note. Nothing was saved to the ledger.',
              },
              'stop'
            );
          return modelStream(
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'fixture-call',
                  type: 'function',
                  function: {
                    name: 'preview_expense',
                    arguments: JSON.stringify({
                      amount: 35,
                      note: 's0-synthetic-note',
                    }),
                  },
                },
              ],
            },
            'tool_calls'
          );
        }
        return new WorkerResponse(
          'External network disabled in browser fixture',
          {
            status: 502,
          }
        );
      },
    }),
    telemetry: { enabled: false },
    logRequests: false,
    ...(persistencePath
      ? { resourcePersistencePath: resolve(persistencePath) }
      : {}),
  });

  await runtime.ready;
  const db = await runtime.getD1Database('DB');
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS _moni_local_migrations(name TEXT PRIMARY KEY)'
    )
    .run();
  for (const migration of await readD1Migrations('./migrations')) {
    if (
      await db
        .prepare('SELECT 1 FROM _moni_local_migrations WHERE name=?')
        .bind(migration.name)
        .first()
    )
      continue;
    await db.batch([
      ...migration.queries.map((query) => db.prepare(query)),
      db
        .prepare('INSERT INTO _moni_local_migrations(name) VALUES (?)')
        .bind(migration.name),
    ]);
  }

  return { runtime, db, ownerToken };
}
