import {
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
import type { LedgerBackup } from '../../src/ledger/backup-contract';
import type { RestoreSessionView } from '../../src/ledger/restore-session';
import { chatPersistence } from '../../src/lib/chat-persistence';
import { handlePrivateApi } from '../../src/worker';

let signingKey: CryptoKey;
let datasetId: string;
let providerCalls = 0;
let lateGate: { started: () => void; until: Promise<void> } | null = null;
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
          keys: [{ ...publicKey, kid: 'export-fixture', alg: 'RS256' }],
        });
      if (request.url !== 'https://model.invalid/v1/chat/completions')
        throw new Error('External services disabled in export tests');
      providerCalls++;
      const body = (await request.json()) as {
        messages: { role: string; content?: string }[];
      };
      if (
        lateGate &&
        body.messages.at(-1)?.role !== 'tool' &&
        body.messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('SYNTHETIC_LATE_RESTORE')
        )
      ) {
        lateGate.started();
        await lateGate.until;
      }
      const tool = body.messages.at(-1)?.role !== 'tool';
      const delta = tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: crypto.randomUUID(),
                type: 'function',
                function: {
                  name: 'prepare_draft',
                  arguments: JSON.stringify({
                    draftId: null,
                    version: null,
                    items: [
                      {
                        itemId: null,
                        kind: 'expense',
                        name: '合成草稿',
                        amount: '8',
                        actualBaseAmount: null,
                        currency: null,
                        currencyAmbiguous: false,
                        date: null,
                        categoryId: 'expense-food',
                        tags: ['草稿'],
                        note: '独立合成草稿备注',
                      },
                    ],
                  }),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'Synthetic draft ready for review.' };
      return new Response(
        `data: ${JSON.stringify({ id: 'synthetic-export', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
  );
});
afterAll(() => vi.unstubAllGlobals());
const command = () => ({ datasetId, operationId: crypto.randomUUID() });
async function api(
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
  method = 'POST',
  overrideEnv?: Env
) {
  const token = await new SignJWT({
    type: 'app',
    email: 'synthetic@example.invalid',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'export-fixture' })
    .setIssuer(env.ACCESS_ISSUER)
    .setAudience(env.ACCESS_AUDIENCE)
    .setSubject(env.OWNER_SUBJECT)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
  const options = {
    method: body === undefined ? 'GET' : method,
    headers: {
      'Cf-Access-Jwt-Assertion': token,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const url = `https://moni.test/api/${path}`;
  return overrideEnv
    ? handlePrivateApi(new Request(url, options), overrideEnv)
    : SELF.fetch(url, options);
}
beforeEach(async () => {
  providerCalls = 0;
  lateGate = null;
  datasetId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO datasets(id) VALUES (?)').bind(datasetId),
    env.DB.prepare(
      "INSERT INTO categories(dataset_id,id,kind,name,default_key) SELECT ?,id,kind,name,default_key FROM categories WHERE dataset_id='initial'"
    ).bind(datasetId),
    env.DB.prepare(
      'UPDATE moni_state SET active_dataset=? WHERE singleton=1'
    ).bind(datasetId),
  ]);
  expect(
    (
      await api('initialize', {
        ...command(),
        primaryCurrency: 'CNY',
        timeZone: 'Asia/Shanghai',
      })
    ).status
  ).toBe(200);
});
async function entry(extra: Record<string, unknown> = {}) {
  const input = {
    ...command(),
    id: crypto.randomUUID(),
    kind: 'expense',
    name: 'Synthetic lunch',
    amount: '35',
    currency: 'CNY',
    date: '2024-03-10',
    categoryId: 'expense-food',
    tags: ['Delivery', 'Lunch'],
    note: '合成肯德基备注',
    ...extra,
  };
  expect((await api('entries', input)).status).toBe(200);
  return input;
}
const backup = () => api(`exports/backup?datasetId=${datasetId}`);

async function fixtureBackup() {
  const lunch = await entry();
  const foreign = await entry({
    name: 'Synthetic foreign',
    currency: 'USD',
    amount: '20',
    conversion: { rate: '7.20' },
    confirmedBaseMinor: 14400,
    note: '',
  });
  const refundId = crypto.randomUUID();
  expect(
    (
      await api('refunds', {
        ...command(),
        id: refundId,
        expenseId: foreign.id,
        expenseVersion: 1,
        amount: '5',
        date: '2024-04-02',
        confirmedBaseMinor: 3600,
        note: '独立退款备注',
      })
    ).status
  ).toBe(200);
  const deleted = await entry({ note: '回收站备注' });
  expect(
    (
      await api('entries/delete', {
        ...command(),
        id: deleted.id,
        version: 1,
        confirmed: true,
      })
    ).status
  ).toBe(200);
  const taxonomy = (await (await api('taxonomy')).json()) as {
    tags: { id: string; name: string; version: number }[];
  };
  const source = taxonomy.tags.find((tag) => tag.name === 'Lunch');
  const target = taxonomy.tags.find((tag) => tag.name === 'Delivery');
  expect(
    (
      await api('tags/merge', {
        ...command(),
        sources: [{ id: source?.id, version: source?.version }],
        target: { id: target?.id, version: target?.version },
      })
    ).status
  ).toBe(200);
  const threadId = crypto.randomUUID();
  await api('conversations', { ...command(), id: threadId });
  const response = await api('chat', {
    datasetId,
    threadId,
    version: 1,
    runId: crypto.randomUUID(),
    text: '合成恢复用例，请准备8元的合成草稿。',
  });
  expect(await response.text()).toContain('RUN_FINISHED');
  const content = (await (await backup()).json()) as LedgerBackup;
  return { content, lunch, foreign, refundId };
}
async function complete(input: {
  datasetId: string;
  operationId: string;
  backup: LedgerBackup;
}) {
  for (let count = 0; count < 100; count++) {
    const response = await api('restores/prepare', input);
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      status: string;
      summary: Record<string, unknown>;
      id: string;
      digest: string;
      progress: number;
      total: number;
    };
    if (result.status === 'sealed') return result;
    expect(result.status).toBe('loading');
  }
  throw new Error('Preparation did not converge');
}

async function begin(
  prepared: Awaited<ReturnType<typeof complete>>,
  operationId = crypto.randomUUID(),
  overrideEnv?: Env
) {
  const response = await api(
    'restores/begin',
    {
      ...command(),
      operationId,
      preparationId: prepared.id,
      digest: prepared.digest,
    },
    {},
    'POST',
    overrideEnv
  );
  expect(response.status).toBe(200);
  return (await response.json()) as RestoreSessionView;
}
async function currentBackup(session: RestoreSessionView) {
  const response = await api('restores/current-backup', {
    datasetId,
    id: session.id,
    token: session.token,
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    ),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
  expect(response.headers.get('X-Moni-Restore-Digest')).toBe(digest);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Content-Disposition')).toContain(
    'moni-current-before-restore.json'
  );
  expect(text.includes(session.token)).toBe(false);
  expect(text.includes('restore_sessions')).toBe(false);
  return {
    content: JSON.parse(text) as LedgerBackup,
    confirmation: {
      ...command(),
      id: session.id,
      token: session.token,
      digest: session.digest,
      backupDigest: digest,
      backupRevision: Number(response.headers.get('X-Moni-Revision')),
      savedBackup: true,
      confirmed: true,
    },
  };
}

describe('save-current-backup and atomic whole-ledger restoration', () => {
  it('exports and restores a single complete history beyond 1000 messages and 1 MiB without truncation', async () => {
    const { content } = await fixtureBackup();
    const threadId = content.data.conversations[0].id;
    const history = Array.from({ length: 1100 }, (_, index) => ({
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: `Synthetic restore history ${index} ${'x'.repeat(1000)}`,
    }));
    await chatPersistence(env.DB, datasetId).stores.messages.saveThread(
      threadId,
      history
    );
    const exported = await backup();
    expect(exported.status).toBe(200);
    const full = await exported.json<LedgerBackup>();
    expect(full.data.messages.map((row) => row.message)).toEqual(history);
    const prepared = await complete({ ...command(), backup: full });
    const session = await begin(prepared);
    const saved = await currentBackup(session);
    const response = await api('restores/commit', saved.confirmation);
    expect(response.status).toBe(200);
    const restored = await response.json<{ datasetId: string }>();
    expect(
      await chatPersistence(
        env.DB,
        restored.datasetId
      ).stores.messages.loadThread(threadId)
    ).toEqual(history);
    expect(
      await chatPersistence(env.DB, restored.datasetId).stores.metadata.get(
        '@tanstack/ai-compaction',
        threadId
      )
    ).toBeNull();
  });
  it('requires an issued current backup and explicit confirmation, restores business data and archives imported execution authority', async () => {
    const { content, lunch } = await fixtureBackup();
    const imported = structuredClone(content);
    imported.data.runs[0].status = 'running';
    imported.data.runs[0].finishedAt = null;
    const prepared = await complete({ ...command(), backup: imported });
    const session = await begin(prepared);
    const oldDataset = datasetId;
    const recovery = (await (await api('restores/current')).json()) as {
      recovery: {
        preview: { id: string };
        session: { id: string; token: string };
        expired: boolean;
      };
    };
    expect(recovery.recovery.preview.id).toBe(prepared.id);
    expect(recovery.recovery.session.id).toBe(session.id);
    expect(recovery.recovery.session.token === session.token).toBe(true);
    expect(recovery.recovery.expired).toBe(false);
    const calls = providerCalls;
    expect(
      (
        await api('entries', {
          ...lunch,
          ...command(),
          id: crypto.randomUUID(),
        })
      ).status
    ).toBe(423);
    const threadId = content.data.conversations[0].id;
    const thread = (await (await api(`conversations/${threadId}`)).json()) as {
      version: number;
    };
    expect(
      (
        await api('chat', {
          datasetId,
          threadId,
          version: thread.version,
          runId: crypto.randomUUID(),
          text: 'Frozen synthetic input',
        })
      ).status
    ).toBe(423);
    expect(providerCalls).toBe(calls);
    const missingBackup = {
      ...command(),
      id: session.id,
      token: session.token,
      digest: session.digest,
      backupDigest: 'a'.repeat(64),
      backupRevision: 0,
      savedBackup: true,
      confirmed: true,
    };
    expect((await api('restores/commit', missingBackup)).status).toBe(409);
    const saved = await currentBackup(session);
    expect(saved.content.data.entries).toEqual(content.data.entries);
    expect(
      (
        await api('restores/commit', {
          ...saved.confirmation,
          savedBackup: false,
        })
      ).status
    ).toBe(400);
    expect(
      (
        await api('restores/commit', {
          ...saved.confirmation,
          confirmed: false,
        })
      ).status
    ).toBe(400);
    expect(
      (
        await api('restores/commit', {
          ...saved.confirmation,
          backupRevision: saved.confirmation.backupRevision + 1,
        })
      ).status
    ).toBe(409);
    const response = await api('restores/commit', saved.confirmation);
    expect(response.status).toBe(200);
    const restored = (await response.json()) as {
      restored: boolean;
      datasetId: string;
    };
    expect(restored.restored).toBe(true);
    expect(restored.datasetId).not.toBe(oldDataset);
    expect(
      ((await (await api('restores/current')).json()) as { recovery: unknown })
        .recovery
    ).toBeNull();
    const after = (await (
      await api(`exports/backup?datasetId=${restored.datasetId}`)
    ).json()) as LedgerBackup;
    for (const key of [
      'entries',
      'categories',
      'tags',
      'entryTags',
      'refundLinks',
      'messages',
    ] as const)
      expect(after.data[key]).toEqual(content.data[key]);
    expect(after.settings).toEqual(content.settings);
    expect(after.data.drafts[0]).toMatchObject({
      status: 'cancelled',
      version: content.data.drafts[0].version + 1,
      items: content.data.drafts[0].items,
    });
    expect(after.data.runs[0]).toMatchObject({
      status: 'aborted',
      errorCode: 'interrupted',
    });
    const history = (await (await api(`chat?threadId=${threadId}`)).json()) as {
      latestRun: { status: string; retryable: boolean; errorCode: string };
    };
    expect(history.latestRun).toMatchObject({
      status: 'aborted',
      retryable: false,
      errorCode: 'interrupted',
    });
    expect(providerCalls).toBe(calls);
    for (const table of ['chat_permits', 'chat_requests', 'operation_receipts'])
      expect(
        await env.DB.prepare(
          `SELECT count(*) AS count FROM ${table} WHERE dataset_id=?`
        )
          .bind(restored.datasetId)
          .first<number>('count')
      ).toBe(0);
    expect(
      (
        await api(
          'entries',
          { ...lunch, ...command(), version: 1, note: 'Stale source edit' },
          {},
          'PUT'
        )
      ).status
    ).toBe(409);
    expect(
      (
        await api('drafts/confirm', {
          ...command(),
          id: content.data.drafts[0].id,
          version: content.data.drafts[0].version,
          confirmed: true,
        })
      ).status
    ).toBe(409);
    expect(
      (
        await api('drafts/confirm', {
          ...command(),
          datasetId: restored.datasetId,
          id: content.data.drafts[0].id,
          version: content.data.drafts[0].version,
          confirmed: true,
        })
      ).status
    ).toBe(409);
    expect(
      (
        await api('entries', {
          ...lunch,
          ...command(),
          datasetId: restored.datasetId,
          id: crypto.randomUUID(),
          name: 'New restored operation',
        })
      ).status
    ).toBe(200);
    expect((await api('restores/commit', saved.confirmation)).status).toBe(200);
    expect(
      (
        await api('restores/commit', {
          ...saved.confirmation,
          operationId: crypto.randomUUID(),
        })
      ).status
    ).toBe(409);
    expect(
      ((await (await api('entries/query', {})).json()) as { total: number })
        .total
    ).toBe(4);
    expect(
      (
        await api('restores/abort', {
          ...command(),
          id: session.id,
          token: session.token,
        })
      ).status
    ).toBe(409);
  });

  it('handles competing locks, cancellation, expiry and late release without clearing a newer restoration', async () => {
    const { content } = await fixtureBackup();
    const first = await complete({ ...command(), backup: content });
    const second = await complete({ ...command(), backup: content });
    const owner = await begin(first);
    expect(
      (
        await api('restores/begin', {
          ...command(),
          preparationId: second.id,
          digest: second.digest,
        })
      ).status
    ).toBe(423);
    const cancellation = { ...command(), id: owner.id, token: owner.token };
    expect((await api('restores/abort', cancellation)).status).toBe(200);
    expect((await api('restores/abort', cancellation)).status).toBe(200);
    await entry({ note: 'After cancellation' });
    const expiring = await begin(second);
    const saved = await currentBackup(expiring);
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE moni_state SET restore_expires_at=0 WHERE singleton=1'
      ),
      env.DB.prepare(
        'UPDATE restore_sessions SET expires_at=0 WHERE id=?'
      ).bind(expiring.id),
    ]);
    await entry({ note: 'After lock expiry' });
    expect(
      (
        (await (await api('restores/current')).json()) as {
          recovery: { expired: boolean };
        }
      ).recovery.expired
    ).toBe(true);
    expect((await api('restores/commit', saved.confirmation)).status).toBe(409);
    const current = await begin(second);
    expect(
      (
        await api('restores/abort', {
          ...command(),
          id: expiring.id,
          token: expiring.token,
        })
      ).status
    ).toBe(423);
    expect(
      (
        await api('entries', {
          ...command(),
          id: crypto.randomUUID(),
          kind: 'expense',
          name: 'Locked',
          amount: '1',
        })
      ).status
    ).toBe(423);
    expect(
      (
        await api('restores/abort', {
          ...command(),
          id: current.id,
          token: current.token,
        })
      ).status
    ).toBe(200);
    await entry({ note: 'New lock released' });
    expect(
      ((await (await api('entries/query', {})).json()) as { total: number })
        .total
    ).toBe(6);
  });

  it.each([
    'ABORT',
    'IGNORE',
  ])('rolls back the entire activation if the final pointer update raises %s, then safely retries', async (failure) => {
    const { content } = await fixtureBackup();
    content.data.runs[0].status = 'running';
    content.data.runs[0].finishedAt = null;
    const prepared = await complete({ ...command(), backup: content });
    const session = await begin(prepared);
    const saved = await currentBackup(session);
    const target = await env.DB.prepare(
      'SELECT target_dataset FROM restore_sessions WHERE id=?'
    )
      .bind(session.id)
      .first<string>('target_dataset');
    const action =
      failure === 'ABORT'
        ? "RAISE(ABORT,'synthetic pointer failure')"
        : 'RAISE(IGNORE)';
    await env.DB.exec(
      `CREATE TRIGGER synthetic_restore_switch BEFORE UPDATE OF active_dataset ON moni_state WHEN NEW.active_dataset<>OLD.active_dataset BEGIN SELECT ${action}; END`
    );
    try {
      expect((await api('restores/commit', saved.confirmation)).status).toBe(
        409
      );
      expect(
        await env.DB.prepare(
          'SELECT active_dataset FROM moni_state WHERE singleton=1'
        ).first<string>('active_dataset')
      ).toBe(datasetId);
      expect(
        await env.DB.prepare('SELECT status FROM drafts WHERE dataset_id=?')
          .bind(target)
          .first<string>('status')
      ).toBe('ready');
      expect(
        await env.DB.prepare('SELECT status FROM chat_runs WHERE dataset_id=?')
          .bind(target)
          .first<string>('status')
      ).toBe('running');
      expect(
        await env.DB.prepare('SELECT status FROM restore_sessions WHERE id=?')
          .bind(session.id)
          .first<string>('status')
      ).toBe('downloaded');
      expect(
        ((await (await api('entries/query', {})).json()) as { total: number })
          .total
      ).toBe(3);
    } finally {
      await env.DB.exec('DROP TRIGGER synthetic_restore_switch');
    }
    expect((await api('restores/commit', saved.confirmation)).status).toBe(200);
    expect(
      await env.DB.prepare(
        'SELECT active_dataset FROM moni_state WHERE singleton=1'
      ).first<string>('active_dataset')
    ).toBe(target);
  });

  it('rejects late model writes and old alarms after switching even when DO cancellation notification fails', async () => {
    const { content } = await fixtureBackup();
    const prepared = await complete({ ...command(), backup: content });
    const lateThread = crypto.randomUUID();
    const lateRun = crypto.randomUUID();
    await api('conversations', { ...command(), id: lateThread });
    let release = () => {};
    let started = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    lateGate = { started, until };
    const response = await api('chat', {
      datasetId,
      threadId: lateThread,
      version: 1,
      runId: lateRun,
      text: 'SYNTHETIC_LATE_RESTORE source reply',
    });
    const completion = response.text();
    await entered;
    const permit = await env.DB.prepare(
      'SELECT token FROM chat_permits WHERE dataset_id=? AND thread_id=?'
    )
      .bind(datasetId, lateThread)
      .first<{ token: string }>();
    if (!permit) throw new Error('Synthetic permit missing');
    const stale = chatPersistence(env.DB, datasetId, {
      threadId: lateThread,
      runId: lateRun,
      token: permit.token,
      conversationVersion: 2,
    });
    let notifications = 0;
    const brokenNotifications = {
      ...env,
      CONVERSATIONS: {
        getByName: () => ({
          cancelRun: async () => {
            notifications++;
            throw new Error('Synthetic notification failure');
          },
        }),
      } as unknown as Env['CONVERSATIONS'],
    };
    let restoredDataset = '';
    try {
      const session = await begin(
        prepared,
        crypto.randomUUID(),
        brokenNotifications
      );
      expect(notifications).toBe(1);
      const saved = await currentBackup(session);
      const commit = await api('restores/commit', saved.confirmation);
      expect(commit.status).toBe(200);
      restoredDataset = ((await commit.json()) as { datasetId: string })
        .datasetId;
      await expect(
        stale.stores.messages.saveThread(lateThread, [
          { role: 'assistant', content: 'Late stale output' },
        ])
      ).rejects.toThrow();
      await expect(
        chatPersistence(env.DB, datasetId).stores.messages.saveThread(
          lateThread,
          []
        )
      ).rejects.toThrow();
    } finally {
      release();
      lateGate = null;
    }
    await completion;
    expect((await api(`chat?threadId=${lateThread}`)).status).toBe(404);
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS count FROM chat_messages WHERE dataset_id=? AND thread_id=?'
      )
        .bind(restoredDataset, lateThread)
        .first<number>('count')
    ).toBe(0);
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS count FROM drafts WHERE dataset_id=? AND thread_id=?'
      )
        .bind(datasetId, lateThread)
        .first<number>('count')
    ).toBe(0);
    expect(
      ((await (await api('entries/query', {})).json()) as { total: number })
        .total
    ).toBe(3);

    await api('conversations', {
      ...command(),
      datasetId: restoredDataset,
      id: lateThread,
    });
    let releaseNew = () => {};
    let startedNew = () => {};
    const enteredNew = new Promise<void>((resolve) => {
      startedNew = resolve;
    });
    lateGate = {
      started: startedNew,
      until: new Promise<void>((resolve) => {
        releaseNew = resolve;
      }),
    };
    const newRun = crypto.randomUUID();
    const newResponse = await api('chat', {
      datasetId: restoredDataset,
      threadId: lateThread,
      version: 1,
      runId: newRun,
      text: 'SYNTHETIC_LATE_RESTORE target reply',
    });
    const newCompletion = newResponse.text();
    await enteredNew;
    try {
      const oldObject = env.CONVERSATIONS.getByName(
        `${datasetId}:${lateThread}`
      );
      await runInDurableObject(oldObject, async (_object, state) => {
        await state.storage.put('active', {
          dataset: datasetId,
          threadId: lateThread,
          runId: lateRun,
          token: permit.token,
          expiresAt: Date.now() - 1,
          conversationVersion: 2,
        });
        await state.storage.setAlarm(Date.now());
      });
      await runDurableObjectAlarm(oldObject);
      const current = (await (
        await api(`chat?threadId=${lateThread}`)
      ).json()) as {
        latestRun: { runId: string; status: string };
        coordinationBusy: boolean;
      };
      expect(current.latestRun).toMatchObject({
        runId: newRun,
        status: 'running',
      });
      expect(current.coordinationBusy).toBe(true);
    } finally {
      releaseNew();
      lateGate = null;
    }
    expect(await newCompletion).toContain('RUN_FINISHED');
    expect(
      ((await (await api('entries/query', {})).json()) as { total: number })
        .total
    ).toBe(3);
  });

  it('keeps the old dataset during the in-flight window, then retries bounded cleanup without affecting the restored ledger', async () => {
    const { content } = await fixtureBackup();
    const prepared = await complete({ ...command(), backup: content });
    const session = await begin(prepared);
    const saved = await currentBackup(session);
    const commit = await api('restores/commit', saved.confirmation);
    expect(commit.status).toBe(200);
    const target = ((await commit.json()) as { datasetId: string }).datasetId;
    expect((await api('settings')).status).toBe(200);
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM datasets WHERE id=?')
        .bind(datasetId)
        .first<number>('count')
    ).toBe(1);
    await env.DB.prepare(
      'UPDATE restore_sessions SET retire_after=0 WHERE id=?'
    )
      .bind(session.id)
      .run();
    await env.DB.exec(
      `CREATE TRIGGER synthetic_retired_cleanup BEFORE DELETE ON entries WHEN OLD.dataset_id='${datasetId}' BEGIN SELECT RAISE(ABORT,'synthetic cleanup failure'); END`
    );
    try {
      expect((await api('settings')).status).toBe(200);
      expect(
        await env.DB.prepare(
          'SELECT count(*) AS count FROM entries WHERE dataset_id=?'
        )
          .bind(datasetId)
          .first<number>('count')
      ).toBe(4);
    } finally {
      await env.DB.exec('DROP TRIGGER synthetic_retired_cleanup');
    }
    const current = (await (await api('entries/query', {})).json()) as {
      datasetId: string;
      total: number;
    };
    expect(current).toMatchObject({ datasetId: target, total: 3 });
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM datasets WHERE id=?')
        .bind(datasetId)
        .first<number>('count')
    ).toBe(0);
    for (const table of [
      'entries',
      'chat_messages',
      'chat_permits',
      'chat_requests',
      'chat_metadata',
      'operation_receipts',
      'drafts',
    ])
      expect(
        await env.DB.prepare(
          `SELECT count(*) AS count FROM ${table} WHERE dataset_id=?`
        )
          .bind(datasetId)
          .first<number>('count')
      ).toBe(0);
    expect((await api('restores/commit', saved.confirmation)).status).toBe(200);
    expect(
      (
        await api('entries', {
          ...command(),
          id: crypto.randomUUID(),
          kind: 'expense',
          name: 'Old request after cleanup',
          amount: '1',
        })
      ).status
    ).toBe(409);
    expect(
      ((await (await api('entries/query', {})).json()) as { total: number })
        .total
    ).toBe(3);
  });

  it('rejects forged session fields, missing identity, wrong file claims and a replaced backup receipt', async () => {
    expect(
      (
        await SELF.fetch('https://moni.test/api/restores/begin', {
          method: 'POST',
        })
      ).status
    ).toBe(401);
    const { content } = await fixtureBackup();
    const prepared = await complete({ ...command(), backup: content });
    expect(
      (
        await api('restores/begin', {
          ...command(),
          preparationId: prepared.id,
          digest: '0'.repeat(64),
        })
      ).status
    ).toBe(409);
    const session = await begin(prepared);
    expect(
      (
        await api('restores/current-backup', {
          datasetId,
          id: session.id,
          token: crypto.randomUUID(),
        })
      ).status
    ).toBe(409);
    const old = await currentBackup(session);
    await currentBackup(session);
    expect((await api('restores/commit', old.confirmation)).status).toBe(409);
    expect(
      ((await (await api('entries/query', {})).json()) as { total: number })
        .total
    ).toBe(3);
    expect(
      (
        await api('restores/abort', {
          ...command(),
          id: session.id,
          token: session.token,
        })
      ).status
    ).toBe(200);
  });
});
