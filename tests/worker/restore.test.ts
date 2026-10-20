import { SELF } from 'cloudflare:test';
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
import { backupSelections } from '../../src/ledger/exports';

let signingKey: CryptoKey;
let datasetId: string;
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
      const body = (await request.json()) as { messages: { role: string }[] };
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
  method = 'POST'
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
  return SELF.fetch(`https://moni.test/api/${path}`, {
    method: body === undefined ? 'GET' : method,
    headers: {
      'Cf-Access-Jwt-Assertion': token,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(async () => {
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
async function jobRow(id: string) {
  const row = await env.DB.prepare(
    'SELECT * FROM restore_preparations WHERE id=?'
  )
    .bind(id)
    .first<{
      target_dataset: string;
      progress: number;
      status: string;
      digest: string;
    }>();
  expect(row).not.toBeNull();
  return row as NonNullable<typeof row>;
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

describe('validated nonactive restore preparation', () => {
  it('stages and seals a full business snapshot while the current ledger remains writable and independent', async () => {
    const { content, lunch } = await fixtureBackup();
    const assistant = content.data.messages.find(
      (row) => row.message.role === 'assistant'
    );
    if (!assistant) throw new Error('Synthetic assistant missing');
    assistant.message.thinking = [
      {
        content: 'Synthetic reasoning',
        signature: 'synthetic-signature',
        redacted: false,
      },
    ];
    assistant.message.metadata = { synthetic: true };
    const input = { ...command(), backup: content };
    const first = await api('restores/prepare', input);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { status: string }).status).toBe('loading');
    expect(
      (
        await api(
          'entries',
          { ...lunch, ...command(), version: 1, note: '现账预览期间继续写入' },
          {},
          'PUT'
        )
      ).status
    ).toBe(200);
    const result = await complete(input);
    expect(result.progress).toBe(result.total);
    expect(result.summary).toMatchObject({
      entries: 3,
      trash: 1,
      refunds: 1,
      tags: 1,
      aliases: 1,
      conversations: 1,
      drafts: 1,
      primaryCurrency: 'CNY',
      timeZone: 'Asia/Shanghai',
      currencies: ['CNY', 'USD'],
      from: '2024-03-10',
      to: '2024-04-02',
    });
    const job = await jobRow(input.operationId);
    expect(job.target_dataset).not.toBe(datasetId);
    expect(
      await env.DB.prepare(
        'SELECT active_dataset FROM moni_state WHERE singleton=1'
      ).first<string>('active_dataset')
    ).toBe(datasetId);
    const active = (await (await api('entries/query', {})).json()) as {
      total: number;
      items: { id: string; note: string }[];
    };
    expect(active.total).toBe(3);
    expect(active.items.find((row) => row.id === lunch.id)?.note).toBe(
      '现账预览期间继续写入'
    );
    const staged = await env.DB.batch<{ item: string }>(
      backupSelections(job.target_dataset).map(({ sql, values = [] }) =>
        env.DB.prepare(sql).bind(...values)
      )
    );
    expect(
      staged[2].results
        .map(({ item }) => JSON.parse(item))
        .find((row) => row.id === lunch.id).note
    ).toBe('合成肯德基备注');
    expect(
      staged[6].results
        .map(({ item }) => JSON.parse(item))
        .find(
          (row) =>
            row.position === assistant.position &&
            row.threadId === assistant.threadId
        ).message.thinking
    ).toEqual(assistant.message.thinking);
    expect((await api('restores/prepare', input)).status).toBe(200);
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS count FROM entries WHERE dataset_id=?'
      )
        .bind(job.target_dataset)
        .first<number>('count')
    ).toBe(4);
  });

  it('rejects malformed, overprecise, inconsistent, unsupported and broken-reference files before any staging write', async () => {
    const { content } = await fixtureBackup();
    const cases: ((value: LedgerBackup) => void)[] = [
      (value) => {
        (value as { version: number }).version = 2;
      },
      (value) => {
        value.data.entries[0].originalMinor = 1.5;
      },
      (value) => {
        value.data.entries[0].note = 'x'.repeat(2001);
      },
      (value) => {
        value.data.entries[0].baseMinor += 1;
      },
      (value) => {
        value.data.entries[0].categoryId = 'missing';
      },
      (value) => {
        value.data.entries.push(structuredClone(value.data.entries[0]));
      },
      (value) => {
        value.data.tags[0].mergedInto = value.data.tags[0].id;
      },
      (value) => {
        const refund = value.data.entries.find((row) => row.kind === 'refund');
        if (!refund) throw new Error('Synthetic refund missing');
        refund.originalMinor = 2100;
      },
      (value) => {
        value.data.messages[0].position = 900;
      },
      (value) => {
        (value.data.messages[0].message as Record<string, unknown>).createdAt =
          123;
      },
      (value) => {
        (
          value.data.messages[0].message as Record<string, unknown>
        ).structuredOutput = 3;
      },
      (value) => {
        value.data.drafts[0].totalBaseMinor = 1;
      },
      (value) => {
        value.settings.currencyLocked = false;
      },
      (value) => {
        const foreign = value.data.entries.find(
          (row) => row.currency === 'USD' && row.kind === 'expense'
        );
        if (!foreign?.conversion)
          throw new Error('Synthetic conversion missing');
        foreign.conversion.numerator = '0';
      },
    ];
    for (const mutate of cases) {
      const invalid = structuredClone(content);
      mutate(invalid);
      const response = await api('restores/prepare', {
        ...command(),
        backup: invalid,
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(
        /^backup_/
      );
    }
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS count FROM restore_preparations WHERE source_dataset=?'
      )
        .bind(datasetId)
        .first<number>('count')
    ).toBe(0);
    expect(
      ((await (await api('entries/query', {})).json()) as { total: number })
        .total
    ).toBe(3);
  });

  it('deduplicates concurrent batches, binds every retry to the same digest, and cancels only inactive staging', async () => {
    const { content } = await fixtureBackup();
    const input = { ...command(), backup: content };
    const responses = await Promise.all([
      api('restores/prepare', input),
      api('restores/prepare', input),
    ]);
    for (const response of responses) expect(response.status).toBe(200);
    const altered = structuredClone(content);
    altered.data.entries[0].note = 'Different content';
    const mismatch = await api('restores/prepare', {
      ...input,
      backup: altered,
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({ error: 'restore_content_changed' });
    const job = await jobRow(input.operationId);
    expect(job.status).toBe('loading');
    const cancellation = { ...command(), id: input.operationId };
    expect((await api('restores/cancel', cancellation)).status).toBe(200);
    expect((await api('restores/cancel', cancellation)).status).toBe(200);
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM datasets WHERE id=?')
        .bind(job.target_dataset)
        .first<number>('count')
    ).toBe(0);
    expect((await api('restores/prepare', input)).status).toBe(409);
    expect(
      ((await (await api('entries/query', {})).json()) as { total: number })
        .total
    ).toBe(3);
    const other = { ...command(), backup: content };
    await complete(other);
    await env.DB.prepare(
      'UPDATE restore_preparations SET target_dataset=? WHERE id=?'
    )
      .bind(datasetId, other.operationId)
      .run();
    expect(
      (await api('restores/cancel', { ...command(), id: other.operationId }))
        .status
    ).toBe(409);
    expect(
      ((await (await api('entries/query', {})).json()) as { total: number })
        .total
    ).toBe(3);
  });

  it('rolls back a failing staging batch and resumes the same preparation after a transient D1 failure', async () => {
    const { content } = await fixtureBackup();
    content.data.entries[0].name = 'Synthetic failpoint';
    await env.DB.exec(
      "CREATE TRIGGER synthetic_restore_failure BEFORE INSERT ON entries WHEN NEW.dataset_id<>(SELECT active_dataset FROM moni_state WHERE singleton=1) AND NEW.name='Synthetic failpoint' BEGIN SELECT RAISE(ABORT,'synthetic staging failure'); END"
    );
    const input = { ...command(), backup: content };
    try {
      expect((await api('restores/prepare', input)).status).toBe(503);
      const job = await jobRow(input.operationId);
      expect(job.progress).toBeGreaterThan(0);
      expect(
        await env.DB.prepare(
          'SELECT count(*) AS count FROM entries WHERE dataset_id=?'
        )
          .bind(job.target_dataset)
          .first<number>('count')
      ).toBe(0);
      expect(
        ((await (await api('entries/query', {})).json()) as { total: number })
          .total
      ).toBe(3);
    } finally {
      await env.DB.exec('DROP TRIGGER synthetic_restore_failure');
    }
    const result = await complete(input);
    expect(result.status).toBe('sealed');
    expect(
      ((await (await api('entries/query', {})).json()) as { total: number })
        .total
    ).toBe(3);
  });

  it('refuses to seal corrupted staging, cleans expired datasets and rejects late preparation requests', async () => {
    const { content } = await fixtureBackup();
    const input = { ...command(), backup: content };
    expect((await api('restores/prepare', input)).status).toBe(200);
    const job = await jobRow(input.operationId);
    await env.DB.prepare(
      "UPDATE entries SET note='Corrupted staging' WHERE dataset_id=?"
    )
      .bind(job.target_dataset)
      .run();
    let response = await api('restores/prepare', input);
    for (let index = 0; index < 10 && response.status === 200; index++)
      response = await api('restores/prepare', input);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'restore_staging_failed' });
    expect((await jobRow(input.operationId)).status).toBe('failed');
    await env.DB.prepare(
      'UPDATE restore_preparations SET expires_at=0 WHERE id=?'
    )
      .bind(input.operationId)
      .run();
    await complete({ ...command(), backup: content });
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM datasets WHERE id=?')
        .bind(job.target_dataset)
        .first<number>('count')
    ).toBe(0);
    expect((await api('restores/prepare', input)).status).toBe(409);
    expect(
      ((await (await api('entries/query', {})).json()) as { total: number })
        .total
    ).toBe(3);
  });

  it('preserves a deleted foreign refund after its original expense legally changes currency and kind', async () => {
    const foreign = await entry({
      currency: 'USD',
      amount: '20',
      conversion: { rate: '7.20' },
      confirmedBaseMinor: 14400,
      note: '原消费备注',
    });
    const refundId = crypto.randomUUID();
    await api('refunds', {
      ...command(),
      id: refundId,
      expenseId: foreign.id,
      expenseVersion: 1,
      amount: '5',
      date: '2024-04-02',
      confirmedBaseMinor: 3600,
      note: '历史独立退款备注',
    });
    expect(
      (
        await api('entries/delete', {
          ...command(),
          id: refundId,
          version: 1,
          confirmed: true,
        })
      ).status
    ).toBe(200);
    expect(
      (
        await api(
          'entries',
          {
            ...foreign,
            ...command(),
            kind: 'income',
            categoryId: 'income-other',
            amount: '100',
            currency: 'CNY',
            conversion: undefined,
            confirmedBaseMinor: 10000,
            version: 1,
          },
          {},
          'PUT'
        )
      ).status
    ).toBe(200);
    const content = (await (await backup()).json()) as LedgerBackup;
    const input = { ...command(), backup: content };
    expect((await complete(input)).status).toBe('sealed');
    const job = await jobRow(input.operationId);
    const refund = await env.DB.prepare(
      'SELECT currency,original_minor,base_minor,note,deleted_at FROM entries WHERE dataset_id=? AND id=?'
    )
      .bind(job.target_dataset, refundId)
      .first();
    expect(refund).toMatchObject({
      currency: 'USD',
      original_minor: 500,
      base_minor: 3600,
      note: '历史独立退款备注',
      deleted_at: expect.any(Number),
    });
    expect(
      (
        (await (await api('entries/query', {})).json()) as {
          items: { kind: string; baseMinor: number }[];
        }
      ).items[0]
    ).toMatchObject({ kind: 'income', baseMinor: 10000 });
  });

  it('bounds upload size and rejects unauthenticated or stale preparation without changing active records', async () => {
    expect(
      (
        await SELF.fetch('https://moni.test/api/restores/prepare', {
          method: 'POST',
        })
      ).status
    ).toBe(401);
    const content = (await (await backup()).json()) as LedgerBackup;
    expect(
      (
        await api('restores/prepare', {
          ...command(),
          datasetId: 'old',
          backup: content,
        })
      ).status
    ).toBe(409);
    const oversized = { ...content, padding: 'x'.repeat(11 * 1024 * 1024) };
    expect(
      (await api('restores/prepare', { ...command(), backup: oversized }))
        .status
    ).toBe(413);
    const tooMany = structuredClone(content);
    tooMany.data.entryTags = Array.from({ length: 100001 }, () => ({
      entryId: '10000000-0000-4000-8000-000000000001',
      tagId: '10000000-0000-4000-8000-000000000002',
    }));
    expect(
      (await api('restores/prepare', { ...command(), backup: tooMany })).status
    ).toBe(413);
    expect(
      ((await (await api('entries/query', {})).json()) as { total: number })
        .total
    ).toBe(0);
  });

  it('preserves zero-decimal and three-decimal currencies, zero base rounding and partial-refund tails', async () => {
    await entry({
      currency: 'JPY',
      amount: '1',
      conversion: { rate: '0.001' },
      confirmedBaseMinor: 0,
      note: '零位精度',
    });
    await entry({
      currency: 'BHD',
      amount: '0.001',
      conversion: { rate: '20' },
      confirmedBaseMinor: 2,
      note: '三位精度',
    });
    const foreign = await entry({
      currency: 'USD',
      amount: '0.03',
      conversion: { actualAmount: '0.02' },
      confirmedBaseMinor: 2,
      note: '尾差原消费',
    });
    for (const baseMinor of [1, 1, 0])
      expect(
        (
          await api('refunds', {
            ...command(),
            id: crypto.randomUUID(),
            expenseId: foreign.id,
            expenseVersion: 1,
            amount: '0.01',
            date: '2024-04-02',
            confirmedBaseMinor: baseMinor,
            note: '独立尾差备注',
          })
        ).status
      ).toBe(200);
    const content = (await (await backup()).json()) as LedgerBackup;
    const input = { ...command(), backup: content };
    const prepared = await complete(input);
    expect(prepared.summary.currencies).toEqual(['BHD', 'JPY', 'USD']);
    const job = await jobRow(input.operationId);
    const rows = (
      await env.DB.prepare(
        'SELECT currency,original_minor,base_minor,note FROM entries WHERE dataset_id=?'
      )
        .bind(job.target_dataset)
        .all<{
          currency: string;
          original_minor: number;
          base_minor: number;
          note: string;
        }>()
    ).results;
    expect(rows.find((row) => row.currency === 'JPY')).toMatchObject({
      original_minor: 1,
      base_minor: 0,
      note: '零位精度',
    });
    expect(rows.find((row) => row.currency === 'BHD')).toMatchObject({
      original_minor: 1,
      base_minor: 2,
      note: '三位精度',
    });
    expect(
      rows
        .filter((row) => row.note === '独立尾差备注')
        .map((row) => row.base_minor)
        .sort()
    ).toEqual([0, 1, 1]);
  });
});
