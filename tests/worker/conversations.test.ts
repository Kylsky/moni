import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { LedgerConversation } from '../../src/ledger/conversations';
import { chatPersistence } from '../../src/lib/chat-persistence';
import { handlePrivateApi } from '../../src/worker';

let signingKey: CryptoKey;
let datasetId: string;
const replies: {
  text: string;
  delay?: number;
  status?: number;
  wait?: Promise<void>;
}[] = [];
const providerInputs: Record<string, unknown>[] = [];
const summaries: unknown[] = [];
let summaryGate: Promise<void> | undefined;
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
          keys: [{ ...publicKey, kid: 'conversation-fixture', alg: 'RS256' }],
        });
      if (request.url !== 'https://model.invalid/v1/chat/completions')
        throw new Error('External services disabled in conversation tests');
      const json = (await request.json()) as {
        messages: { role: string; content: string }[];
      };
      if (
        json.messages.some(
          (m) =>
            m.role === 'system' && m.content.startsWith('You summarize Moni')
        )
      ) {
        summaries.push(json);
        if (summaryGate) await summaryGate;
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic history summary.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      providerInputs.push(json);
      const reply = replies.shift();
      if (!reply) throw new Error('Unexpected model call');
      if (reply.wait) await reply.wait;
      if (reply.delay)
        await new Promise((resolve) => setTimeout(resolve, reply.delay));
      if (reply.status)
        return Response.json(
          { error: { message: reply.text } },
          { status: reply.status }
        );
      return new Response(
        `data: ${JSON.stringify({ id: 'synthetic-response', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'synthetic-response', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
  );
});
afterAll(() => {
  expect(replies).toHaveLength(0);
  vi.unstubAllGlobals();
});
async function api(path: string, body?: unknown) {
  const token = await new SignJWT({
    type: 'app',
    email: 'synthetic@example.invalid',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'conversation-fixture' })
    .setIssuer(env.ACCESS_ISSUER)
    .setAudience(env.ACCESS_AUDIENCE)
    .setSubject(env.OWNER_SUBJECT)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
  return SELF.fetch(`https://moni.test/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Cf-Access-Jwt-Assertion': token,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const command = () => ({ datasetId, operationId: crypto.randomUUID() });
beforeEach(async () => {
  expect(replies).toHaveLength(0);
  providerInputs.length = 0;
  summaries.length = 0;
  summaryGate = undefined;
  datasetId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO datasets(id) VALUES (?)').bind(datasetId),
    env.DB.prepare(
      'UPDATE moni_state SET active_dataset = ? WHERE singleton = 1'
    ).bind(datasetId),
  ]);
});
async function create() {
  const id = crypto.randomUUID();
  const body = { ...command(), id };
  expect((await api('conversations', body)).status).toBe(200);
  expect((await api('conversations', body)).status).toBe(200);
  return id;
}
const turn = (
  threadId: string,
  version = 1,
  extra: Record<string, unknown> = {}
) => ({
  datasetId,
  threadId,
  runId: crypto.randomUUID(),
  version,
  text: 'Synthetic conversation input',
  ...extra,
});
async function metadata(id: string) {
  return (await api(`conversations/${id}`)).json<LedgerConversation>();
}

describe('formal protected conversation lifecycle', () => {
  it('fences late summaries and subsequent model calls when deletion notification fails', async () => {
    const id = await create();
    await chatPersistence(env.DB, datasetId).stores.messages.saveThread(
      id,
      Array.from({ length: 100 }, (_, index) => ({
        id: crypto.randomUUID(),
        role: 'user' as const,
        content: `Synthetic ${index} ${'历史'.repeat(500)}`,
      }))
    );
    let release!: () => void;
    summaryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const response = await api('chat', turn(id));
    const completion = response.text().catch(() => 'interrupted');
    try {
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      const token = await new SignJWT({
        type: 'app',
        email: 'synthetic@example.invalid',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'conversation-fixture' })
        .setIssuer(env.ACCESS_ISSUER)
        .setAudience(env.ACCESS_AUDIENCE)
        .setSubject(env.OWNER_SUBJECT)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signingKey);
      const result = await handlePrivateApi(
        new Request('https://moni.test/api/conversations/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Jwt-Assertion': token,
          },
          body: JSON.stringify({
            ...command(),
            id,
            version: 2,
            confirmed: true,
          }),
        }),
        {
          ...env,
          CONVERSATIONS: new Proxy(env.CONVERSATIONS, {
            get(target, property) {
              if (property === 'getByName')
                return () => {
                  throw new Error('Synthetic notification failure');
                };
              return Reflect.get(target, property, target);
            },
          }),
        }
      );
      expect(result.status).toBe(200);
    } finally {
      release();
    }
    await completion;
    expect(summaries).toHaveLength(1);
    expect(providerInputs).toHaveLength(0);
    expect(
      await chatPersistence(env.DB, datasetId).stores.metadata.get(
        '@tanstack/ai-compaction',
        id
      )
    ).toBeNull();
    expect(
      await chatPersistence(env.DB, datasetId).stores.messages.loadThread(id)
    ).toEqual([]);
  });
  it('reliably accepts current input, persists streamed parts and runs, and reloads server history for a followup', async () => {
    const id = await create();
    const first = turn(id);
    const before = await env.DB.prepare(
      'SELECT revision FROM moni_state WHERE singleton = 1'
    ).first<number>('revision');
    replies.push({ text: 'Synthetic response one.' });
    const response = await api('chat', first);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('RUN_FINISHED');
    expect(providerInputs).toHaveLength(1);
    expect(
      (providerInputs[0].tools as { function: { name: string } }[])
        .map((tool) => tool.function.name)
        .sort()
    ).toEqual(['get_ledger_context', 'prepare_draft', 'query_ledger']);
    const receipt = await env.DB.prepare(
      'SELECT user_message_id FROM chat_requests WHERE dataset_id = ? AND run_id = ?'
    )
      .bind(datasetId, first.runId)
      .first<{ user_message_id: string }>();
    expect(receipt?.user_message_id).not.toBe(first.runId);
    const restored = await (await api(`chat?threadId=${id}`)).json<{
      conversation: LedgerConversation;
      messages: unknown[];
      activeRun: unknown;
      runs: { status: string }[];
    }>();
    expect(restored.conversation.version).toBe(2);
    expect(JSON.stringify(restored.messages)).toContain(first.text);
    expect(JSON.stringify(restored.messages)).toContain(
      'Synthetic response one.'
    );
    expect(restored.activeRun).toBeNull();
    expect(restored.runs.at(-1)?.status).toBe('completed');
    replies.push({ text: 'Synthetic response two.' });
    expect(
      await (
        await api('chat', turn(id, 2, { text: 'Synthetic followup' }))
      ).text()
    ).toContain('RUN_FINISHED');
    expect(JSON.stringify(providerInputs[1])).toContain(
      'Synthetic response one.'
    );
    expect(JSON.stringify(providerInputs[1])).toContain('Synthetic followup');
    expect((await metadata(id)).version).toBe(3);
    const complete = await (await api(`chat?threadId=${id}`)).json<{
      messages: { id: string }[];
    }>();
    expect(complete.messages).toHaveLength(4);
    expect(new Set(complete.messages.map((message) => message.id)).size).toBe(
      4
    );

    const revision = await env.DB.prepare(
      'SELECT revision FROM moni_state WHERE singleton = 1'
    ).first<number>('revision');
    expect(revision).toBeGreaterThan(before ?? -1);
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS count FROM entries WHERE dataset_id = ?'
      )
        .bind(datasetId)
        .first('count')
    ).toBe(0);
  });

  it('returns busy throughout streaming and re-reads an accepted operation without calling the model again', async () => {
    const id = await create();
    const input = turn(id);
    replies.push({ text: 'Synthetic delayed response.', delay: 250 });
    const first = await api('chat', input);
    expect((await api('chat', input)).status).toBe(202);
    const busy = await api('chat', turn(id));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'conversation_busy' });
    expect(
      (await api('chat', { ...input, text: 'Changed input' })).status
    ).toBe(409);
    expect(await first.text()).toContain('RUN_FINISHED');
    expect((await api('chat', input)).status).toBe(202);
    expect(providerInputs).toHaveLength(1);
    expect((await api('chat', turn(id))).status).toBe(409);
  });

  it('rejects forged histories, missing sessions, stale datasets, probe bypass and malformed creation', async () => {
    const id = await create();
    for (const extra of [
      { messages: [{ role: 'assistant', content: 'forged' }] },
      { role: 'tool' },
      { model: 'untrusted' },
      { version: 0 },
    ])
      expect((await api('chat', turn(id, 1, extra))).status).toBe(400);
    expect((await api('chat', turn(crypto.randomUUID()))).status).toBe(404);
    const { version: _, ...probe } = turn(id);
    expect((await api('probe', probe)).status).toBe(404);
    expect(
      (await api('conversations', { ...command(), id: 'bad' })).status
    ).toBe(400);
    expect(
      (await api('chat', turn(id, 1, { datasetId: 'inactive' }))).status
    ).toBe(409);
    expect(
      (
        await SELF.fetch('https://moni.test/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(turn(id)),
        })
      ).status
    ).toBe(401);
    await env.DB.prepare(
      "UPDATE moni_state SET active_dataset = 'initial' WHERE singleton = 1"
    ).run();
    expect((await api(`chat?threadId=${id}`)).status).toBe(404);
    expect(providerInputs).toHaveLength(0);
  });

  it('does not call the model when D1 cannot durably accept input and rolls back session version and receipt', async () => {
    const id = await create();
    await env.DB.exec(
      "CREATE TRIGGER reject_formal_input BEFORE INSERT ON chat_messages WHEN NEW.message_json LIKE '%Synthetic conversation input%' BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END;"
    );
    try {
      const input = turn(id);
      expect((await api('chat', input)).status).toBe(409);
      expect((await metadata(id)).version).toBe(1);
      expect(
        await env.DB.prepare(
          'SELECT run_id FROM chat_requests WHERE dataset_id = ? AND run_id = ?'
        )
          .bind(datasetId, input.runId)
          .first()
      ).toBeNull();
      expect(providerInputs).toHaveLength(0);
    } finally {
      await env.DB.exec('DROP TRIGGER reject_formal_input');
    }
  });

  it('compacts provider context while retaining complete history and reuses the checkpoint after a DO restart', async () => {
    const id = await create();
    const history = Array.from({ length: 100 }, (_, index) => ({
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: `Synthetic history ${index} ${'历史'.repeat(300)}`,
    }));
    await chatPersistence(env.DB, datasetId).stores.messages.saveThread(
      id,
      history
    );
    replies.push({ text: 'Synthetic after compaction.' });
    const response = await api('chat', turn(id));
    expect(response.status).toBe(200);
    await response.text();
    expect(summaries.length).toBeGreaterThan(0);
    expect(JSON.stringify(providerInputs[0])).toContain(
      'untrusted-conversation-summary'
    );
    expect((providerInputs[0].messages as unknown[]).length).toBeLessThan(40);
    expect(
      (
        await chatPersistence(env.DB, datasetId).stores.messages.loadThread(id)
      ).slice(0, 100)
    ).toEqual(history);
    const checkpoint = await chatPersistence(
      env.DB,
      datasetId
    ).stores.metadata.get('@tanstack/ai-compaction', id);
    expect(checkpoint).not.toBeNull();
    const count = summaries.length;
    await evictDurableObject(env.CONVERSATIONS.getByName(`${datasetId}:${id}`));
    replies.push({ text: 'Same conversation after restart.' });
    const next = await api('chat', turn(id, 2));
    expect(next.status).toBe(200);
    await next.text();
    expect(summaries).toHaveLength(count);
    expect(
      (await chatPersistence(env.DB, datasetId).stores.messages.loadThread(id))
        .length
    ).toBe(104);
    const restoredIds: string[] = [];
    let cursor: string | undefined;
    do {
      const snapshot = await (
        await api(
          `chat?threadId=${id}${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`
        )
      ).json<{
        messages: { id: string }[];
        page: { truncated: boolean; cursor?: string };
      }>();
      restoredIds.unshift(...snapshot.messages.map((message) => message.id));
      cursor = snapshot.page.truncated ? snapshot.page.cursor : undefined;
    } while (cursor);
    expect(restoredIds).toHaveLength(104);
    expect(new Set(restoredIds).size).toBe(104);
    expect(restoredIds.slice(0, 100)).toEqual(
      history.map((message) => message.id)
    );
    expect((await api(`chat?threadId=${id}&limit=invalid`)).status).toBe(400);
    expect(
      (
        await api('conversations/delete', {
          ...command(),
          id,
          version: 3,
          confirmed: true,
        })
      ).status
    ).toBe(200);
    expect(
      await chatPersistence(env.DB, datasetId).stores.metadata.get(
        '@tanstack/ai-compaction',
        id
      )
    ).toBeNull();
  });

  it('revokes late output on timeout, redacts errors and rejects version/deletion changes in every persistence write', async () => {
    const id = await create();
    const input = turn(id);
    replies.push({ text: 'LATE_FORMAL_OUTPUT', delay: 250 });
    const response = await api('chat', input);
    const stub = env.CONVERSATIONS.getByName(`${datasetId}:${id}`);
    await runInDurableObject(stub, async (_object, state) => {
      const active = await state.storage.get<Record<string, unknown>>('active');
      await state.storage.put('active', { ...active, expiresAt: 1 });
    });
    await runDurableObjectAlarm(stub);
    await response.text().catch(() => 'interrupted');
    expect(
      JSON.stringify(
        await chatPersistence(env.DB, datasetId).stores.messages.loadThread(id)
      )
    ).not.toContain('LATE_FORMAL_OUTPUT');
    const next = turn(id, 2);
    replies.push({ text: 'PRIVATE_PROVIDER_DETAIL', status: 401 });
    expect(await (await api('chat', next)).text()).not.toContain(
      'PRIVATE_PROVIDER_DETAIL'
    );
    const permit = {
      threadId: id,
      runId: crypto.randomUUID(),
      token: crypto.randomUUID(),
      conversationVersion: 3,
    };
    await env.DB.prepare(
      'INSERT INTO chat_permits(dataset_id,thread_id,run_id,token,expires_at) VALUES (?,?,?,?,?)'
    )
      .bind(datasetId, id, permit.runId, permit.token, Date.now() + 60000)
      .run();
    const writer = chatPersistence(env.DB, datasetId, permit);
    await env.DB.prepare(
      'UPDATE conversations SET deleted_at = ? WHERE dataset_id = ? AND id = ?'
    )
      .bind(Date.now(), datasetId, id)
      .run();
    await expect(writer.stores.messages.saveThread(id, [])).rejects.toThrow();
    await env.DB.prepare(
      'DELETE FROM conversations WHERE dataset_id = ? AND id = ?'
    )
      .bind(datasetId, id)
      .run();
    await expect(writer.stores.messages.saveThread(id, [])).rejects.toThrow();
    await expect(
      writer.stores.runs.update('another-run', { status: 'completed' })
    ).rejects.toThrow();
  });
});

async function abandoned(id: string, storage: boolean, permission: boolean) {
  const input = turn(id);
  const userId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + 60000;
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(input.text)
      )
    ),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE conversations SET version = 2 WHERE dataset_id = ? AND id = ?'
    ).bind(datasetId, id),
    env.DB.prepare(
      'INSERT INTO chat_messages(dataset_id,thread_id,position,message_json) VALUES (?,?,0,?)'
    ).bind(
      datasetId,
      id,
      JSON.stringify({ id: userId, role: 'user', content: input.text })
    ),
    env.DB.prepare(
      "INSERT INTO chat_runs(dataset_id,thread_id,run_id,status,started_at) VALUES (?,?,?,'running',?)"
    ).bind(datasetId, id, input.runId, Date.now()),
    env.DB.prepare(
      'INSERT INTO chat_requests(dataset_id,thread_id,run_id,input_hash,accepted_at,user_message_id) VALUES (?,?,?,?,?,?)'
    ).bind(datasetId, id, input.runId, hash, Date.now(), userId),
    ...(permission
      ? [
          env.DB.prepare(
            'INSERT INTO chat_permits(dataset_id,thread_id,run_id,token,expires_at) VALUES (?,?,?,?,?)'
          ).bind(datasetId, id, input.runId, token, expiresAt),
        ]
      : []),
  ]);
  const stub = env.CONVERSATIONS.getByName(`${datasetId}:${id}`);
  if (storage)
    await runInDurableObject(stub, async (_object, state) => {
      await state.storage.put('active', {
        dataset: datasetId,
        threadId: id,
        runId: input.runId,
        token,
        expiresAt,
        conversationVersion: 2,
      });
      await state.storage.setAlarm(expiresAt);
    });
  if (storage) await evictDurableObject(stub);
  return input;
}

describe('conversation management and interrupted execution', () => {
  it('keeps independent contexts and pages searchable actual history with literal conditions', async () => {
    const first = await create();
    const second = await create();
    replies.push({ text: 'Synthetic reply A 100%_off' });
    await (
      await api('chat', turn(first, 1, { text: 'Synthetic topic A' }))
    ).text();
    replies.push({ text: 'Synthetic reply B' });
    await (
      await api('chat', turn(second, 1, { text: 'Synthetic topic B' }))
    ).text();
    expect(JSON.stringify(providerInputs[1])).not.toContain(
      'Synthetic topic A'
    );
    const list = await (
      await api('conversations/query', { pageSize: 1 })
    ).json<{
      items: { id: string; preview: string }[];
      total: number;
      pageCount: number;
    }>();
    expect(list.total).toBe(2);
    expect(list.pageCount).toBe(2);
    expect(list.items).toHaveLength(1);
    const matches = await (
      await api('conversations/query', { keyword: '100%_' })
    ).json<{ items: { id: string; preview: string }[] }>();
    expect(matches.items.map((item) => item.id)).toEqual([first]);
    expect(matches.items[0].preview).toBe('Synthetic reply A 100%_off');
    const injected = await (
      await api('conversations/query', { keyword: "' OR 1=1 --" })
    ).json<{ total: number }>();
    expect(injected.total).toBe(0);
    expect((await metadata(first)).title).toBe('Synthetic topic A');
    expect((await api('conversations/query', { page: 0 })).status).toBe(400);
  });

  it('deletes history and fences a late real DO even when notification fails, retaining posted notes', async () => {
    await env.DB.prepare(
      "INSERT INTO categories(dataset_id,id,kind,name,default_key) SELECT ?,id,kind,name,default_key FROM categories WHERE dataset_id = 'initial'"
    )
      .bind(datasetId)
      .run();
    expect(
      (
        await api('initialize', {
          ...command(),
          primaryCurrency: 'CNY',
          timeZone: 'UTC',
        })
      ).status
    ).toBe(200);
    const entryId = crypto.randomUUID();
    expect(
      (
        await api('entries', {
          ...command(),
          id: entryId,
          name: 'Independent synthetic meal',
          kind: 'expense',
          amount: '35',
          date: '2026-10-18',
          note: 'Independent KFC note',
        })
      ).status
    ).toBe(200);
    const id = await create();
    const input = turn(id);
    let release = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    replies.push({ text: 'LATE_DELETED_OUTPUT', wait });
    const response = await api('chat', input);
    const completion = response.text().catch(() => 'interrupted');
    await vi.waitFor(() => expect(providerInputs).toHaveLength(1));
    const body = { ...command(), id, version: 2, confirmed: true };
    try {
      const token = await new SignJWT({
        type: 'app',
        email: 'synthetic@example.invalid',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'conversation-fixture' })
        .setIssuer(env.ACCESS_ISSUER)
        .setAudience(env.ACCESS_AUDIENCE)
        .setSubject(env.OWNER_SUBJECT)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signingKey);
      const result = await handlePrivateApi(
        new Request('https://moni.test/api/conversations/delete', {
          method: 'POST',
          headers: {
            'Cf-Access-Jwt-Assertion': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
        {
          ...env,
          CONVERSATIONS: {
            getByName: () => ({
              cancelRun: async () => {
                throw new Error('Synthetic notification failure');
              },
            }),
          } as unknown as Env['CONVERSATIONS'],
        }
      );
      expect(result.status).toBe(200);
      expect((await api(`chat?threadId=${id}`)).status).toBe(404);
      expect((await api('conversations/delete', body)).status).toBe(200);
    } finally {
      release();
    }
    await completion;
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS count FROM chat_messages WHERE dataset_id = ? AND thread_id = ?'
      )
        .bind(datasetId, id)
        .first('count')
    ).toBe(0);
    expect((await api('conversations', { ...command(), id })).status).toBe(409);
    const original = await (await api(`entries?id=${entryId}`)).json<
      { note: string }[]
    >();
    expect(original[0].note).toBe('Independent KFC note');
    expect(providerInputs).toHaveLength(1);
  });

  it('cancels exactly one run; repeated cancel, an old alarm and late output cannot end the new run', async () => {
    const id = await create();
    const first = turn(id);
    let releaseFirst = () => {};
    const waitFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    replies.push({ text: 'LATE_CANCELLED_OUTPUT', wait: waitFirst });
    const response = await api('chat', first);
    const completion = response.text().catch(() => 'interrupted');
    await vi.waitFor(() => expect(providerInputs).toHaveLength(1));
    const cancel = {
      ...command(),
      id,
      version: 2,
      runId: first.runId,
      confirmed: true,
    };
    expect((await api('conversations/cancel', cancel)).status).toBe(200);
    expect((await metadata(id)).version).toBe(3);
    let releaseSecond = () => {};
    const waitSecond = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const next = turn(id, 3, { text: 'Explicit new synthetic input' });
    replies.push({ text: 'New run survives.', wait: waitSecond });
    const newer = await api('chat', next);
    const newerCompletion = newer.text();
    try {
      await vi.waitFor(() => expect(providerInputs).toHaveLength(2));
      expect((await api('conversations/cancel', cancel)).status).toBe(200);
      const stub = env.CONVERSATIONS.getByName(`${datasetId}:${id}`);
      await runInDurableObject(stub, async (_object, state) => {
        await state.storage.setAlarm(Date.now() + 1000);
      });
      await runDurableObjectAlarm(stub);
      releaseFirst();
      await completion;
      const state = await (await api(`chat?threadId=${id}`)).json<{
        activeRun: { runId: string } | null;
      }>();
      expect(state.activeRun?.runId).toBe(next.runId);
    } finally {
      releaseFirst();
      releaseSecond();
    }
    expect(await newerCompletion).toContain('RUN_FINISHED');
    const history = await chatPersistence(
      env.DB,
      datasetId
    ).stores.messages.loadThread(id);
    expect(JSON.stringify(history)).not.toContain('LATE_CANCELLED_OUTPUT');
    expect(JSON.stringify(history)).toContain('New run survives.');
    expect(providerInputs).toHaveLength(2);
  });

  it.each([
    [true, true],
    [false, true],
    [false, false],
  ])('reconciles abandoned DO/D1 state (%s/%s) without replay and retries the original input once', async (storage, permission) => {
    const id = await create();
    const input = await abandoned(id, storage, permission);
    const first = await (await api(`chat?threadId=${id}`)).json<{
      activeRun: unknown;
      latestRun: { status: string; retryable: boolean };
      messages: unknown[];
    }>();
    expect(first.activeRun).toBeNull();
    expect(first.latestRun).toMatchObject({
      status: 'aborted',
      retryable: true,
    });
    expect(first.messages).toHaveLength(1);
    expect(providerInputs).toHaveLength(0);
    expect((await api('chat', input)).status).toBe(202);
    const retry = {
      ...input,
      runId: crypto.randomUUID(),
      version: 2,
      retryOf: input.runId,
    };
    replies.push({ text: 'Explicit retry completed.' });
    expect(await (await api('chat', retry)).text()).toContain('RUN_FINISHED');
    const restored = await (await api(`chat?threadId=${id}`)).json<{
      messages: { role: string }[];
      latestRun: { status: string; retryable: boolean };
    }>();
    expect(
      restored.messages.filter((message) => message.role === 'user')
    ).toHaveLength(1);
    expect(restored.messages).toHaveLength(2);
    expect(restored.latestRun).toMatchObject({
      status: 'completed',
      retryable: false,
    });
    expect((await api('chat', retry)).status).toBe(202);
    expect(providerInputs).toHaveLength(1);
    expect(
      (await api('chat', { ...retry, runId: crypto.randomUUID(), version: 3 }))
        .status
    ).toBe(409);
  });

  it('releases a DO-only abandoned reservation without inventing an input receipt', async () => {
    const id = await create();
    const stub = env.CONVERSATIONS.getByName(`${datasetId}:${id}`);
    await runInDurableObject(stub, async (_object, state) => {
      await state.storage.put('active', {
        dataset: datasetId,
        threadId: id,
        runId: crypto.randomUUID(),
        token: crypto.randomUUID(),
        expiresAt: Date.now() + 60000,
        conversationVersion: 2,
      });
    });
    await evictDurableObject(stub);
    const result = await (await api(`chat?threadId=${id}`)).json<{
      latestRun: unknown;
      messages: unknown[];
    }>();
    expect(result.latestRun).toBeNull();
    expect(result.messages).toEqual([]);
    expect(providerInputs).toHaveLength(0);
    replies.push({ text: 'New explicit input after reservation recovery.' });
    expect(await (await api('chat', turn(id))).text()).toContain(
      'RUN_FINISHED'
    );
  });

  it('re-reads reliable acceptance when DO alarm storage fails after the D1 commit', async () => {
    const id = await create();
    const stub = env.CONVERSATIONS.getByName(`${datasetId}:${id}`);
    let restoreAlarm = () => {};
    await runInDurableObject(stub, async (_object, state) => {
      const original = state.storage.setAlarm.bind(state.storage);
      let calls = 0;
      const spy = vi
        .spyOn(state.storage, 'setAlarm')
        .mockImplementation(async (time, options) => {
          if (++calls === 2)
            throw new Error('Synthetic post-acceptance DO failure');
          await original(time, options);
        });
      restoreAlarm = () => spy.mockRestore();
    });
    const input = turn(id);
    try {
      expect((await api('chat', input)).status).toBe(202);
    } finally {
      restoreAlarm();
    }
    expect(providerInputs).toHaveLength(0);
    const result = await (await api(`chat?threadId=${id}`)).json<{
      latestRun: { status: string; retryable: boolean };
      messages: unknown[];
    }>();
    expect(result.latestRun).toMatchObject({
      status: 'aborted',
      retryable: true,
    });
    expect(result.messages).toHaveLength(1);
    expect((await api('chat', input)).status).toBe(202);
    expect(providerInputs).toHaveLength(0);
  });

  it('reports a saved reply after uncertain terminal state without truncating it or replaying the provider', async () => {
    const id = await create();
    const input = turn(id);
    replies.push({ text: 'This reply was already durably saved.' });
    await (await api('chat', input)).text();
    await env.DB.prepare(
      "UPDATE chat_runs SET status = 'failed',error_code = 'ai_unavailable' WHERE dataset_id = ? AND run_id = ?"
    )
      .bind(datasetId, input.runId)
      .run();
    const result = await (await api(`chat?threadId=${id}`)).json<{
      latestRun: { retryable: boolean };
      messages: unknown[];
    }>();
    expect(result.latestRun.retryable).toBe(false);
    expect(result.messages).toHaveLength(2);
    expect(
      (await api('chat', turn(id, 2, { retryOf: input.runId }))).status
    ).toBe(409);
    expect(providerInputs).toHaveLength(1);
    expect(
      await chatPersistence(env.DB, datasetId).stores.messages.loadThread(id)
    ).toHaveLength(2);
  });
});
