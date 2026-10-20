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
import { csvCell } from '../../src/ledger/exports';

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
function parseCsv(content: string) {
  const values = [...content.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n)/g)].map(
    (match) => match[1].replaceAll('""', '"')
  );
  const width = 21;
  return Array.from({ length: values.length / width }, (_, index) =>
    values.slice(index * width, (index + 1) * width)
  );
}

describe('private consistent CSV and full JSON downloads', () => {
  it('escapes spreadsheet formulas including whitespace/control prefixes without corrupting ordinary CSV text', () => {
    for (const formula of [
      '=1+1',
      '+SUM(A1)',
      '-1+2',
      '@SUM(A1)',
      ' \t=1',
      '\u0001=1',
      '\nplain',
    ])
      expect(csvCell(formula)).toBe(`"'${formula}"`);
    expect(csvCell('中英文, "quote"\r\nnext')).toBe(
      '"中英文, ""quote""\r\nnext"'
    );
    expect(csvCell('')).toBe('""');
  });

  it('exports all matching records through the shared filters, notes, fixed conversions and refund occurrence rules', async () => {
    await entry({ note: ' =SUM(1,2)\n中英 "备注"' });
    const foreign = await entry({
      name: 'Synthetic USD',
      currency: 'USD',
      amount: '20',
      conversion: { rate: '7.20' },
      confirmedBaseMinor: 14400,
      date: '2024-03-20',
      note: '',
    });
    await entry({ amount: '99', tags: ['Transport'], note: 'Excluded note' });
    const deleted = await entry({ amount: '9', note: 'Trash note' });
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
    expect(
      (
        await api('refunds', {
          ...command(),
          id: crypto.randomUUID(),
          expenseId: foreign.id,
          expenseVersion: 1,
          amount: '5',
          date: '2024-04-02',
          note: '独立退款备注',
          confirmedBaseMinor: 3600,
        })
      ).status
    ).toBe(200);
    const taxonomy = (await (await api('taxonomy')).json()) as {
      tags: { id: string; name: string }[];
    };
    const filters = {
      from: '2024-03-01',
      to: '2024-04-30',
      tagIds: taxonomy.tags
        .filter((tag) => ['Delivery', 'Lunch'].includes(tag.name))
        .map((tag) => tag.id),
      page: 2,
      pageSize: 1,
    };
    const response = await api('exports/csv', { datasetId, filters });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    const content = await response.text();
    const rows = parseCsv(content);
    expect(rows).toHaveLength(4);
    const [header, ...data] = rows;
    const mapped = data.map((row) =>
      Object.fromEntries(header.map((name, index) => [name, row[index]]))
    );
    expect(mapped.find((row) => row.name === 'Synthetic lunch')?.note).toBe(
      '\' =SUM(1,2)\n中英 "备注"'
    );
    expect(mapped.find((row) => row.id === foreign.id)).toMatchObject({
      note: '',
      original_currency: 'USD',
      original_amount: '20.00',
      primary_currency: 'CNY',
      primary_amount: '144.00',
      conversion_source: 'manual',
      conversion_rate: '7.20',
      quote_date: '2024-03-20',
    });
    expect(mapped.find((row) => row.type === 'refund')).toMatchObject({
      date: '2024-04-02',
      original_currency: 'USD',
      original_amount: '5.00',
      primary_amount: '36.00',
      refund_of: foreign.id,
      note: '独立退款备注',
    });
    expect(new Set(mapped.map((row) => row.id)).size).toBe(3);
    expect(
      mapped.every(
        (row) => row.ledger_revision === response.headers.get('X-Moni-Revision')
      )
    ).toBe(true);
    const noteOnly = await api('exports/csv', {
      datasetId,
      filters: { keyword: '肯德基' },
    });
    expect(parseCsv(await noteOnly.text())).toHaveLength(1);
    const refunds = await api('exports/csv', {
      datasetId,
      filters: { kind: 'refund', from: '2024-04-01' },
    });
    expect(parseCsv(await refunds.text())).toHaveLength(2);
  });

  it('backs up trash, aliases, all conversation/tool messages and drafts while excluding identities and execution authority', async () => {
    const empty = await entry({ note: '' });
    const trashed = await entry({ note: '回收站备注' });
    await api('entries/delete', {
      ...command(),
      id: trashed.id,
      version: 1,
      confirmed: true,
    });
    const foreign = await entry({
      currency: 'USD',
      amount: '20',
      conversion: { rate: '7.20' },
      confirmedBaseMinor: 14400,
      note: '外币备注',
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
    const taxonomy = (await (await api('taxonomy')).json()) as {
      tags: { id: string; name: string; version: number }[];
    };
    const from = taxonomy.tags.find((tag) => tag.name === 'Lunch');
    const to = taxonomy.tags.find((tag) => tag.name === 'Delivery');
    expect(
      (
        await api('tags/merge', {
          ...command(),
          sources: [{ id: from?.id, version: from?.version }],
          target: { id: to?.id, version: to?.version },
        })
      ).status
    ).toBe(200);
    for (let index = 0; index < 2; index++) {
      const id = crypto.randomUUID();
      expect((await api('conversations', { ...command(), id })).status).toBe(
        200
      );
      const response = await api('chat', {
        datasetId,
        threadId: id,
        version: 1,
        runId: crypto.randomUUID(),
        text: '合成备份会话，请准备一笔8元的合成草稿，备注独立合成草稿备注。',
      });
      expect(await response.text()).toContain('RUN_FINISHED');
    }
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE chat_runs SET sandbox_key='SYNTHETIC_EXECUTION_SECRET',driver_epoch=42 WHERE dataset_id=?"
      ).bind(datasetId),
      env.DB.prepare(
        "INSERT INTO chat_metadata(dataset_id,namespace,key,value_json,revision) VALUES (?,'coordination','lease','\"SYNTHETIC_METADATA_SECRET\"','1')"
      ).bind(datasetId),
    ]);
    const response = await backup();
    expect(response.status).toBe(200);
    const content = await response.text();
    const result = JSON.parse(content);
    expect(result).toMatchObject({
      format: 'moni',
      version: 1,
      settings: {
        primaryCurrency: 'CNY',
        timeZone: 'Asia/Shanghai',
        initialized: true,
        currencyLocked: true,
      },
    });
    expect(result.data.entries).toHaveLength(4);
    expect(
      result.data.entries.find((row: { id: string }) => row.id === trashed.id)
    ).toMatchObject({ note: '回收站备注', deletedAt: expect.any(Number) });
    expect(
      result.data.entries.find((row: { id: string }) => row.id === empty.id)
        .note
    ).toBe('');
    expect(
      result.data.entries.find((row: { id: string }) => row.id === foreign.id)
    ).toMatchObject({
      currency: 'USD',
      originalMinor: 2000,
      baseMinor: 14400,
      note: '外币备注',
      conversion: {
        method: 'manual_rate',
        rate: '7.20',
        source: 'manual',
        baseCurrency: 'CNY',
      },
    });
    expect(result.data.refundLinks).toEqual([
      {
        expenseId: foreign.id,
        refundId,
        defaultBaseMinor: 3600,
        actualOverride: 0,
      },
    ]);
    expect(
      result.data.tags.find((row: { id: string }) => row.id === from?.id)
        .mergedInto
    ).toBe(to?.id);
    expect(result.data.conversations).toHaveLength(2);
    expect(result.data.runs).toHaveLength(2);
    expect(
      result.data.messages.some(
        (row: { message: { role: string } }) => row.message.role === 'tool'
      )
    ).toBe(true);
    expect(result.data.drafts).toHaveLength(2);
    expect(result.data.drafts[0].items[0].note).toBe('独立合成草稿备注');
    expect(result.revision).toBe(
      Number(response.headers.get('X-Moni-Revision'))
    );
    for (const secret of [
      'SYNTHETIC_EXECUTION_SECRET',
      'SYNTHETIC_METADATA_SECRET',
      env.OWNER_SUBJECT,
      env.AI_API_KEY,
      env.ACCESS_ISSUER,
      'sandboxKey',
      'driverEpoch',
      'chat_permits',
      'operation_receipts',
      'input_hash',
    ])
      if (secret) expect(content.includes(secret)).toBe(false);
    expect(Object.keys(result.data).sort()).toEqual(
      [
        'categories',
        'tags',
        'entries',
        'entryTags',
        'refundLinks',
        'conversations',
        'messages',
        'runs',
        'interrupts',
        'drafts',
      ].sort()
    );
  });

  it('returns a consistent revision or a retry error during concurrent edits, never a mixed snapshot', async () => {
    const original = await entry({ note: 'round-0' });
    const baseline = (await (await backup()).json()) as { revision: number };
    const updates = async () => {
      for (let index = 1; index <= 10; index++)
        expect(
          (
            await api(
              'entries',
              {
                ...original,
                ...command(),
                version: index,
                note: `round-${index}`,
              },
              {},
              'PUT'
            )
          ).status
        ).toBe(200);
    };
    const reads = async () => {
      for (let index = 0; index < 12; index++) {
        const response = await backup();
        expect([200, 409]).toContain(response.status);
        if (response.status === 200) {
          const result = (await response.json()) as {
            revision: number;
            data: { entries: { version: number; note: string }[] };
          };
          const row = result.data.entries[0];
          expect(row.note).toBe(`round-${row.version - 1}`);
          expect(result.revision).toBe(baseline.revision + row.version - 1);
        }
      }
    };
    await Promise.all([updates(), reads()]);
    const final = (await (await backup()).json()) as {
      data: { entries: { note: string }[] };
    };
    expect(final.data.entries[0].note).toBe('round-10');
  });

  it('rejects oversized files, invalid filters, stale datasets, missing identity and cross-site downloads', async () => {
    expect(
      (await SELF.fetch('https://moni.test/api/exports/backup')).status
    ).toBe(401);
    expect(
      (
        await api('exports/csv', {
          datasetId,
          filters: { sql: 'SELECT * FROM entries' },
        })
      ).status
    ).toBe(400);
    expect(
      (await api('exports/csv', { datasetId: 'old', filters: {} })).status
    ).toBe(409);
    expect((await api('exports/backup?datasetId=old')).status).toBe(409);
    expect(
      (
        await api(
          'exports/csv',
          { datasetId, filters: {} },
          { Origin: 'https://untrusted.invalid' }
        )
      ).status
    ).toBe(403);
    const thread = crypto.randomUUID();
    await api('conversations', { ...command(), id: thread });
    await env.DB.prepare(
      "WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM seq WHERE n<2999) INSERT INTO chat_messages(dataset_id,thread_id,position,message_json) SELECT ?,?,n,json_object('role','user','content',?) FROM seq"
    )
      .bind(datasetId, thread, 'x'.repeat(4000))
      .run();
    const response = await backup();
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'export_too_large' });
    expect(
      ((await (await api('entries/query', {})).json()) as { total: number })
        .total
    ).toBe(0);
  });
});
