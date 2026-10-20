import { runInDurableObject, SELF } from 'cloudflare:test';
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
import { previousLedgerQuery } from '../../src/ledger/chat-query';
import {
  type parseQueryResult,
  parseQueryUpdates,
} from '../../src/ledger/chat-query-contract';
import { todayInZone } from '../../src/ledger/dates';
import { chatPersistence } from '../../src/lib/chat-persistence';
import { limits } from '../../src/lib/limits';

let signingKey: CryptoKey;
let datasetId: string;
let modelCalls = 0;
const summaryInputs: unknown[] = [];
let quoteCalls = 0;
let quoteStatus = 200;
let quoteWait: Promise<void> | undefined;
let intent = 'other';
let intentStatus = 200;
let extraIntentArguments: string | undefined;
let intentContext:
  | { reviewed: boolean; otherPendingDrafts: number }
  | undefined;
let intentWait: Promise<void> | undefined;
const replies: {
  before?: () => Promise<void>;
  name?: string;
  tool?:
    | Record<string, unknown>
    | ((input: {
        messages: { content?: unknown }[];
      }) => Record<string, unknown>);
  text?: string;
}[] = [];
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
          keys: [{ ...publicKey, kid: 'draft-fixture', alg: 'RS256' }],
        });
      const url = new URL(request.url);
      if (url.origin === 'https://api.frankfurter.dev') {
        quoteCalls++;
        if (quoteWait) await quoteWait;
        expect(request.method).toBe('GET');
        expect([...url.searchParams.keys()].sort()).toEqual([
          'base',
          'date',
          'quotes',
        ]);
        return Response.json(
          [
            {
              base: 'EUR',
              quote: 'USD',
              date: url.searchParams.get('date'),
              rate: 1.25,
            },
            {
              base: 'EUR',
              quote: 'CNY',
              date: url.searchParams.get('date'),
              rate: 9,
            },
          ],
          { status: quoteStatus }
        );
      }
      if (request.url !== 'https://model.invalid/v1/chat/completions')
        throw new Error('External service disabled');
      modelCalls++;
      const body = (await request.json()) as {
        tools?: { function: { name: string } }[];
        messages: { role?: string; content?: unknown }[];
      };
      if (
        body.messages.some(
          (message) =>
            message.role === 'system' &&
            String(message.content).startsWith('You summarize Moni')
        )
      ) {
        summaryInputs.push(body);
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic old conversation summary. Read ledger tools for current facts.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      const classifier = body.tools?.some(
        (tool) => tool.function.name === 'classify_draft_confirmation'
      );
      if (classifier)
        intentContext = JSON.parse(
          String(body.messages.at(-1)?.content)
        ).review;
      if (classifier && intentWait) await intentWait;
      if (classifier && intentStatus !== 200)
        return new Response(null, { status: intentStatus });
      const reply: (typeof replies)[number] | undefined = classifier
        ? { name: 'classify_draft_confirmation', tool: { intent } }
        : replies.shift();
      if (!reply) throw new Error('Unexpected model call');
      await reply.before?.();
      if (!classifier) {
        expect(
          body.tools?.some((tool) => tool.function.name === 'prepare_draft')
        ).toBe(true);
        expect(
          body.tools?.some((tool) =>
            /confirm|save_entry/.test(tool.function.name)
          )
        ).toBe(false);
      }
      const toolInput =
        typeof reply.tool === 'function' ? reply.tool(body) : reply.tool;
      const delta = toolInput
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: crypto.randomUUID(),
                type: 'function',
                function: {
                  name: reply.name ?? 'prepare_draft',
                  arguments: JSON.stringify(toolInput),
                },
              },
              ...(classifier && extraIntentArguments
                ? [
                    {
                      index: 1,
                      id: crypto.randomUUID(),
                      type: 'function',
                      function: {
                        name: 'classify_draft_confirmation',
                        arguments: extraIntentArguments,
                      },
                    },
                  ]
                : []),
            ],
          }
        : {
            role: 'assistant',
            content:
              reply.text ?? 'Synthetic draft prepared; review before posting.',
          };
      return new Response(
        `data: ${JSON.stringify({ id: 'synthetic-draft', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: reply.tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
  );
});
afterAll(() => vi.unstubAllGlobals());
const command = () => ({ datasetId, operationId: crypto.randomUUID() });
async function api(path: string, body?: unknown) {
  const token = await new SignJWT({
    type: 'app',
    email: 'synthetic@example.invalid',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'draft-fixture' })
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
beforeEach(async () => {
  await env.DB.exec('DROP TRIGGER IF EXISTS reject_web_tool_history');
  expect(replies).toHaveLength(0);
  modelCalls = 0;
  summaryInputs.length = 0;
  quoteCalls = 0;
  quoteStatus = 200;
  quoteWait = undefined;
  intent = 'other';
  intentStatus = 200;
  extraIntentArguments = undefined;
  intentContext = undefined;
  intentWait = undefined;
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
const item = (extra: Record<string, unknown> = {}) => ({
  itemId: null,
  kind: 'expense',
  name: '午餐',
  amount: '35',
  actualBaseAmount: null,
  currency: null,
  currencyAmbiguous: false,
  date: null,
  categoryId: 'expense-food',
  tags: ['午餐'],
  note: '在肯德基吃的',
  ...extra,
});
async function makeDraft(
  items: Record<string, unknown>[],
  text = '合成验收：午餐在肯德基吃的35，网站推广20美元。'
) {
  const threadId = crypto.randomUUID();
  expect(
    (await api('conversations', { ...command(), id: threadId })).status
  ).toBe(200);
  replies.push({ tool: { draftId: null, version: null, items } }, {});
  const stream = await api('chat', {
    datasetId,
    threadId,
    version: 1,
    runId: crypto.randomUUID(),
    text,
  });
  expect(stream.status).toBe(200);
  expect(await stream.text()).toContain('RUN_FINISHED');
  const result = (await (await api(`drafts?threadId=${threadId}`)).json()) as {
    items: Record<string, unknown>[];
  };
  expect(result.items).toHaveLength(1);
  return {
    threadId,
    draft: result.items[0] as {
      id: string;
      version: number;
      status: string;
      baseCurrency: string;
      items: Record<string, unknown>[];
      totalBaseMinor: number | null;
    },
  };
}
const entries = async () =>
  (await api('entries/query', {})).json() as Promise<{
    total: number;
    items: Record<string, unknown>[];
    totals: { expense: number };
  }>;

async function webSay(
  threadId: string,
  text: string,
  review: unknown = null,
  runId = crypto.randomUUID()
) {
  const conversation = await (await api(`conversations/${threadId}`)).json<{
    version: number;
  }>();
  const body = {
    datasetId,
    threadId,
    version: conversation.version,
    runId,
    text,
    review,
    locale: 'zh',
  };
  const response = await api('chat', body);
  const stream = await response.text();
  expect(response.status).toBe(200);
  expect(stream).toContain('RUN_FINISHED');
  return { body, stream };
}
const visible = (
  drafts: { id: string; version: number }[],
  excludedDraftIds: string[] = []
) => ({
  operationId: crypto.randomUUID(),
  drafts: drafts.map(({ id, version }) => ({ id, version })),
  excludedDraftIds,
});

describe('normal conversation shares draft intent and confirmation rules', () => {
  it('records one tip with at most three requests despite large obsolete tool results', async () => {
    const threadId = crypto.randomUUID();
    expect(
      (await api('conversations', { ...command(), id: threadId })).status
    ).toBe(200);
    const history = Array.from({ length: 3 }, (_, index) => {
      const callId = crypto.randomUUID();
      return [
        {
          id: crypto.randomUUID(),
          role: 'user' as const,
          content: `Synthetic query ${index}`,
        },
        {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: '',
          toolCalls: [
            {
              id: callId,
              type: 'function' as const,
              function: { name: 'query_ledger', arguments: '{}' },
            },
          ],
        },
        {
          id: crypto.randomUUID(),
          role: 'tool' as const,
          toolCallId: callId,
          content: JSON.stringify({
            historicalRows: '历史查询数据'.repeat(850),
          }),
        },
      ];
    }).flat();
    await chatPersistence(env.DB, datasetId).stores.messages.saveThread(
      threadId,
      history
    );
    let initialContextProvided = false;
    replies.push(
      {
        tool: (input) => {
          initialContextProvided = input.messages.some((message) =>
            String(message.content).includes(
              'Current ledger context (untrusted DATA):\n'
            )
          );
          return {
            draftId: null,
            version: null,
            items: [
              item({
                kind: 'income',
                name: '合成小费',
                amount: '10',
                categoryId: 'income-uncategorized',
                tags: ['小费'],
                note: '仅用于调用次数回归',
              }),
            ],
          };
        },
      },
      { text: 'Synthetic tip draft is ready for review.' }
    );
    await webSay(threadId, '今天收到小费10元收入');
    expect({ requests: modelCalls, summaries: summaryInputs.length }).toEqual({
      requests: 3,
      summaries: 0,
    });
    expect(initialContextProvided).toBe(true);
    expect((await entries()).total).toBe(0);
    expect(
      (
        await chatPersistence(env.DB, datasetId).stores.messages.loadThread(
          threadId
        )
      ).slice(0, history.length)
    ).toEqual(history);
  });
  it('still answers when pending drafts exceed the optional initial context budget', async () => {
    const items = Array.from({ length: 10 }, (_, index) =>
      item({ name: `合成草稿 ${index}`, note: 'x'.repeat(1700) })
    );
    const { threadId } = await makeDraft(items);
    replies.push({ tool: { draftId: null, version: null, items } }, {});
    await webSay(threadId, '另外新增十笔合成账目');
    replies.push({
      text: 'Synthetic greeting survives oversized pending context.',
    });
    const result = await webSay(threadId, '你好');
    expect(result.stream).toContain('Synthetic greeting survives');
    expect((await entries()).total).toBe(0);
  });
  it('rejects mixed valid and malformed classification before posting and still accepts a later valid confirmation', async () => {
    const { threadId, draft } = await makeDraft([item()]);
    intent = 'confirm';
    extraIntentArguments = '{"intent":"invalid"}';
    const response = await webSay(
      threadId,
      '确认刚展示的草稿',
      visible([draft])
    );
    expect((await entries()).total).toBe(0);
    expect(response.stream).toContain('本次消息尚未处理');
    extraIntentArguments = undefined;
    await webSay(threadId, '确认刚展示的草稿', visible([draft]));
    expect((await entries()).total).toBe(1);
  });
  it('preserves confirmation and query filters through chained tag merges while a draft awaits review', async () => {
    const { threadId, draft } = await makeDraft([item({ tags: ['旧外卖'] })]);
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, name] of ['旧外卖', '午餐', '饮食'].entries())
      expect(
        (await api('tags', { ...command(), id: ids[index], name })).status
      ).toBe(200);
    for (const [source, target] of [
      [ids[0], ids[1]],
      [ids[1], ids[2]],
    ]) {
      const { tags } = await (await api('taxonomy')).json<{
        tags: { id: string; version: number }[];
      }>();
      const ref = (id: string) => ({
        id,
        version: tags.find((tag) => tag.id === id)?.version,
      });
      expect(
        (
          await api('tags/merge', {
            ...command(),
            sources: [ref(source)],
            target: ref(target),
          })
        ).status
      ).toBe(200);
    }
    intent = 'confirm';
    await webSay(threadId, '确认刚展示的草稿', visible([draft]));
    const posted = await entries();
    expect(posted.total).toBe(1);
    expect(posted.totals.expense).toBe(3500);
    expect(posted.items[0].tags).toEqual([{ id: ids[2], name: '饮食' }]);
    intent = 'other';
    replies.push(
      {
        name: 'query_ledger',
        tool: {
          inheritPrevious: false,
          period: { kind: 'all_time' },
          scope: 'spending',
          filters: { tagIds: [ids[0]], requiredTagIds: [ids[0], ids[1]] },
          view: 'tags',
          interval: 'month',
        },
      },
      {}
    );
    await webSay(threadId, '按旧外卖和午餐标签统计', null);
    const latest = await previousLedgerQuery(env.DB, datasetId, threadId);
    expect(latest?.query.filters).toMatchObject({
      tagIds: [ids[2]],
      requiredTagIds: [ids[2]],
    });
    expect(latest?.report.totals.expense).toBe(3500);
    expect(latest?.report.groups).toMatchObject([
      { id: ids[2], name: '饮食', total: 1 },
    ]);
  });
  it('does not claim a first expense was saved when message recognition fails, and permits a later retry', async () => {
    const threadId = crypto.randomUUID();
    await api('conversations', { ...command(), id: threadId });
    intentStatus = 401;
    const result = await webSay(threadId, '合成午餐35元', null);
    expect(result.stream).toContain('本次消息尚未处理');
    expect(result.stream).not.toContain('草稿已保留');
    expect(modelCalls).toBe(1);
    expect(
      (
        await (
          await api(`drafts?threadId=${threadId}`)
        ).json<{ items: unknown[] }>()
      ).items
    ).toHaveLength(0);
    expect((await entries()).total).toBe(0);
    intentStatus = 200;
    replies.push(
      { tool: { draftId: null, version: null, items: [item()] } },
      {}
    );
    await webSay(threadId, '合成午餐35元', null);
    expect(
      (
        await (
          await api(`drafts?threadId=${threadId}`)
        ).json<{ items: unknown[] }>()
      ).items
    ).toHaveLength(1);
    expect((await entries()).total).toBe(0);
  });
  it.each([
    'confirm',
    'confirm_all',
  ] as const)('handles %s in an empty conversation without calling the bookkeeping agent', async (decision) => {
    const threadId = crypto.randomUUID();
    await api('conversations', { ...command(), id: threadId });
    intent = decision;
    replies.push(
      { tool: { draftId: null, version: null, items: [item()] } },
      {}
    );
    let reply: Awaited<ReturnType<typeof webSay>>;
    try {
      reply = await webSay(threadId, '确认入账', null);
    } finally {
      replies.length = 0;
    }
    expect(reply.stream).toContain('没有待确认草稿');
    expect(modelCalls).toBe(1);
    expect((await entries()).total).toBe(0);
  });
  it.each([
    ['posted', 'query'],
    ['posted', 'chat'],
    ['cancelled', 'query'],
    ['cancelled', 'chat'],
  ] as const)('never replays a %s expense after a %s detour and repeated approval', async (closed, topic) => {
    const { threadId, draft } = await makeDraft([item()]);
    expect(
      (
        await api(closed === 'posted' ? 'drafts/confirm' : 'drafts/cancel', {
          ...command(),
          id: draft.id,
          version: draft.version,
          confirmed: true,
        })
      ).status
    ).toBe(200);
    const policy = await (await api('posting-policy')).json<{
      version: number;
    }>();
    await api('posting-policy', {
      ...command(),
      version: policy.version,
      mode: 'automatic',
      confirmed: true,
    });
    intent = 'other';
    if (topic === 'query')
      replies.push({
        name: 'query_ledger',
        tool: {
          inheritPrevious: false,
          period: { kind: 'all_time' },
          scope: 'spending',
          filters: {},
          view: 'summary',
          interval: 'month',
        },
      });
    replies.push({ text: 'Synthetic neutral answer' });
    await webSay(
      threadId,
      topic === 'query' ? '看看总支出' : '谢谢，今天到这里',
      null
    );
    if (!threadId) throw new Error('Missing synthetic conversation');
    const messages = chatPersistence(env.DB, datasetId).stores.messages;
    const history = await messages.loadThread(threadId);
    if (topic === 'chat') {
      for (let index = 0; index < 64; index++)
        history.push({
          id: crypto.randomUUID(),
          role: index % 2 ? 'assistant' : 'user',
          content: `Synthetic unrelated turn ${index}`,
        });
      await messages.saveThread(threadId, history);
    }
    intent = 'confirm';
    intentContext = undefined;
    replies.push(
      { tool: { draftId: null, version: null, items: [item()] } },
      {}
    );
    let reply: Awaited<ReturnType<typeof webSay>>;
    try {
      reply = await webSay(threadId, '确认，记上吧', null);
    } finally {
      replies.length = 0;
    }
    expect(reply.stream).toContain('没有待确认草稿');
    expect(intentContext).toMatchObject({ reviewed: false });
    expect((await entries()).total).toBe(closed === 'posted' ? 1 : 0);
    const current = await (await api(`drafts?threadId=${threadId}`)).json<{
      items: unknown[];
    }>();
    expect(current.items).toHaveLength(1);
    expect(
      (await messages.loadThread(threadId)).slice(0, history.length)
    ).toEqual(history);
    intent = 'other';
    replies.push(
      {
        tool: {
          draftId: null,
          version: null,
          items: [item({ name: '新买水', amount: '9' })],
        },
      },
      {}
    );
    await webSay(threadId, '新增一笔独立消费，买水9元', null);
    expect((await entries()).total).toBe(closed === 'posted' ? 2 : 1);
    expect((await entries()).totals.expense).toBe(
      closed === 'posted' ? 4400 : 900
    );
  });
  it.each([
    ['decline', 1],
    ['revise', 1],
    ['decline', 2],
    ['revise', 2],
  ] as const)('reports existing postings rather than acting on a stale %s batch of %s drafts', async (decision, size) => {
    const { threadId, draft } = await makeDraft([item()]);
    if (size === 2) {
      replies.push(
        {
          tool: {
            draftId: null,
            version: null,
            items: [item({ name: '合成买水', amount: '9' })],
          },
        },
        {}
      );
      await webSay(threadId, '再记一笔买水9元', visible([draft]));
    }
    const current = await (await api(`drafts?threadId=${threadId}`)).json<{
      items: { id: string; version: number; status: string }[];
    }>();
    intent = decision;
    intentContext = undefined;
    const calls = modelCalls;
    replies.push({ text: 'Synthetic unchanged reply' });
    let release!: () => void;
    intentWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processing = webSay(
      threadId,
      decision === 'decline' ? '这几笔先别入账' : '把这几笔金额都改为20元',
      visible(current.items)
    );
    try {
      await vi.waitFor(() => expect(intentContext).toBeDefined());
      expect(
        (
          await api('drafts/confirm', {
            ...command(),
            id: current.items[0].id,
            version: current.items[0].version,
            confirmed: true,
          })
        ).status
      ).toBe(200);
    } finally {
      release();
    }
    let reply: Awaited<ReturnType<typeof webSay>>;
    try {
      reply = await processing;
    } finally {
      replies.length = 0;
    }
    expect(reply.stream).toContain('本次没有改动已入账账目');
    expect(modelCalls).toBe(calls + 1);
    expect((await entries()).total).toBe(1);
    const remaining = await (await api(`drafts?threadId=${threadId}`)).json<{
      items: { id: string; version: number; status: string }[];
    }>();
    expect(
      remaining.items.filter((draft) => draft.status === 'ready')
    ).toHaveLength(size - 1);
    if (size === 2) {
      intentWait = undefined;
      intent = 'confirm';
      const ready = visible(
        remaining.items.filter((draft) => draft.status === 'ready')
      );
      await webSay(threadId, '只确认还没入账的那份', ready);
      expect((await entries()).total).toBe(1);
      await webSay(threadId, '核对好了，确认', ready);
      expect((await entries()).total).toBe(2);
      expect((await entries()).totals.expense).toBe(4400);
    } else {
      intentWait = undefined;
      intent = 'confirm';
      intentContext = undefined;
      replies.push({ text: 'Synthetic replay should not run' });
      let repeated: Awaited<ReturnType<typeof webSay>>;
      try {
        repeated = await webSay(threadId, '确认啊', null);
      } finally {
        replies.length = 0;
      }
      expect(repeated.stream).toContain('没有待确认草稿');
      expect(intentContext).toMatchObject({ reviewed: false });
      expect((await entries()).total).toBe(1);
    }
  });
  it.each([
    'confirm_all',
    'review_pending',
    'decline',
    'unclear',
    'revise',
  ] as const)('keeps an empty review safe for %s after posting', async (decision) => {
    const { threadId, draft } = await makeDraft([item()]);
    intent = 'confirm';
    await webSay(threadId, '确认', visible([draft]));
    intent = decision;
    const calls = modelCalls;
    const reply = await webSay(threadId, decision, null);
    expect(reply.stream).toContain(
      decision === 'revise' ? '本次没有改动已入账账目' : '没有待确认草稿'
    );
    expect(modelCalls).toBe(calls + 1);
    expect((await entries()).total).toBe(1);
  });
  it('handles a repeated natural confirmation after the browser clears its pending cards without calling the ledger agent again', async () => {
    const { threadId, draft } = await makeDraft([item()]);
    intent = 'confirm';
    await webSay(threadId, '确认', visible([draft]));
    const calls = modelCalls;
    const reply = await webSay(threadId, '确认啊', null);
    expect(reply.stream).toContain('没有待确认草稿');
    expect(modelCalls).toBe(calls + 1);
    expect((await entries()).total).toBe(1);
  });
  it.each([
    ['query', false],
    ['decline', false],
    ['query', true],
    ['decline', true],
  ] as const)('requires a fresh review after %s with classifier failure=%s even if an acknowledgement is misclassified as confirmation', async (context, unavailable) => {
    const { threadId, draft } = await makeDraft([item()]);
    if (context === 'query') {
      replies.push(
        {
          name: 'query_ledger',
          tool: {
            inheritPrevious: false,
            period: { kind: 'all_time' },
            scope: 'spending',
            filters: {},
            view: 'summary',
            interval: 'week',
          },
        },
        {}
      );
      await webSay(threadId, '本月支出多少', visible([draft]));
    } else {
      intent = 'decline';
      await webSay(threadId, '先别入账', visible([draft]));
    }
    if (unavailable) {
      intentStatus = 403;
      await webSay(threadId, '服务恢复了吗', visible([draft]));
      expect((await entries()).total).toBe(0);
      intentStatus = 200;
    }
    intent = 'confirm';
    await webSay(threadId, '好的', visible([draft]));
    expect(intentContext?.reviewed).toBe(false);
    expect((await entries()).total).toBe(0);
    await webSay(threadId, '确认刚展示的草稿', visible([draft]));
    expect((await entries()).total).toBe(1);
  });
  it('keeps oversized batches unposted and directs the owner to individual confirmation buttons', async () => {
    const { threadId, draft } = await makeDraft(
      Array.from({ length: 20 }, (_, index) =>
        item({ name: `合成条目${index}` })
      )
    );
    replies.push(
      {
        tool: {
          draftId: null,
          version: null,
          items: [item({ name: '额外合成条目' })],
        },
      },
      {}
    );
    await webSay(threadId, '再加一笔', visible([draft]));
    const current = await (await api(`drafts?threadId=${threadId}`)).json<{
      items: (typeof draft)[];
    }>();
    intent = 'confirm_all';
    expect(
      (await webSay(threadId, '全部确认', visible(current.items))).stream
    ).toContain('逐份核对');
    expect((await entries()).total).toBe(0);
    expect(intentContext?.reviewed).toBe(false);
  });
  it('does not post if the owner cancels while the intent service is pending', async () => {
    const { threadId, draft } = await makeDraft([item()]);
    intent = 'confirm';
    let release!: () => void;
    intentWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runId = crypto.randomUUID();
    const conversation = await (await api(`conversations/${threadId}`)).json<{
      version: number;
    }>();
    const pending = api('chat', {
      datasetId,
      threadId,
      version: conversation.version,
      runId,
      text: '确认',
      review: visible([draft]),
      locale: 'zh',
    });
    try {
      await vi.waitFor(() => expect(intentContext).toBeDefined());
      const current = await (await api(`conversations/${threadId}`)).json<{
        version: number;
      }>();
      expect(
        (
          await api('conversations/cancel', {
            ...command(),
            id: threadId,
            version: current.version,
            runId,
            confirmed: true,
          })
        ).status
      ).toBe(200);
    } finally {
      release();
    }
    expect((await pending).status).toBe(503);
    expect((await entries()).total).toBe(0);
    expect(
      await (await api(`chat?threadId=${threadId}`)).json<{
        latestRun: { status: string };
        activeRun: unknown;
      }>()
    ).toMatchObject({ latestRun: { status: 'aborted' }, activeRun: null });
  });
  it('rolls back the whole natural batch if an item conflicts with a posted entry', async () => {
    const { threadId, draft } = await makeDraft([item()]);
    replies.push(
      {
        tool: {
          draftId: null,
          version: null,
          items: [item({ amount: '9', name: '买水' })],
        },
      },
      {}
    );
    await webSay(threadId, '再记买水9元', visible([draft]));
    const current = await (await api(`drafts?threadId=${threadId}`)).json<{
      items: (typeof draft)[];
    }>();
    await api('entries', {
      ...command(),
      id: current.items[1].items[0].id,
      kind: 'expense',
      name: '合成冲突原账',
      amount: '1',
      currency: 'CNY',
      note: '',
    });
    intent = 'confirm_all';
    expect(
      (await webSay(threadId, '全部确认', visible(current.items))).stream
    ).toContain('最新草稿');
    expect((await entries()).total).toBe(1);
    expect((await entries()).totals.expense).toBe(100);
    expect(
      (
        await (
          await api(`drafts?threadId=${threadId}`)
        ).json<{ items: (typeof draft)[] }>()
      ).items.every((draft) => draft.status === 'ready')
    ).toBe(true);
  });
  it('posts a displayed version on natural confirmation and persists both messages without duplicate posting on retries', async () => {
    const { threadId, draft } = await makeDraft([item()]);
    intent = 'confirm';
    const review = visible([draft]);
    const { body, stream } = await webSay(threadId, '没问题，记上吧', review);
    expect(stream).toContain('已入账');
    expect(intentContext?.reviewed).toBe(true);
    expect((await entries()).total).toBe(1);
    expect((await api('chat', body)).status).toBe(202);
    expect(
      (await api('chat', { ...body, review: visible([draft]) })).status
    ).toBe(409);
    expect((await webSay(threadId, '确认啊', review)).stream).toContain(
      '无需重复确认'
    );
    expect((await entries()).total).toBe(1);
    const snapshot = await (await api(`chat?threadId=${threadId}`)).json<{
      messages: { role: string; parts: { type: string; content?: string }[] }[];
      activeRun: unknown;
      latestRun: { status: string };
    }>();
    expect(snapshot.activeRun).toBeNull();
    expect(snapshot.latestRun.status).toBe('completed');
    expect(
      snapshot.messages.filter((message) => message.role === 'user')
    ).toHaveLength(3);
    expect(
      snapshot.messages.some((message) =>
        message.parts.some((part) => part.content?.includes('已入账'))
      )
    ).toBe(true);
  });
  it('does not post a confirmation sent before a draft was displayed', async () => {
    const { threadId, draft } = await makeDraft([item()]);
    intent = 'confirm';
    expect((await webSay(threadId, '确认')).stream).toContain('最新草稿');
    expect(intentContext?.reviewed).toBe(false);
    expect((await entries()).total).toBe(0);
    await webSay(threadId, '这次确认', visible([draft]));
    expect((await entries()).total).toBe(1);
  });
  it('routes approval mixed with an edit to the draft tool and requires another confirmation', async () => {
    const { threadId, draft } = await makeDraft([item()]);
    intent = 'revise';
    replies.push(
      {
        tool: {
          draftId: draft.id,
          version: draft.version,
          items: [item({ itemId: draft.items[0].id, amount: '20' })],
        },
      },
      {}
    );
    await webSay(threadId, '可以，但金额改成20', visible([draft]));
    expect((await entries()).total).toBe(0);
    const current = await (await api(`drafts?threadId=${threadId}`)).json<{
      items: (typeof draft)[];
    }>();
    expect(current.items[0].totalBaseMinor).toBe(2000);
    intent = 'confirm';
    await webSay(threadId, '确认', visible([draft]));
    expect((await entries()).total).toBe(0);
    await webSay(threadId, '确认20元', visible(current.items));
    expect((await entries()).items[0].baseMinor).toBe(2000);
  });
  it('keeps new expenses separate from an existing draft and batches only the reviewed complete drafts', async () => {
    const { threadId, draft } = await makeDraft([item()]);
    replies.push(
      {
        tool: {
          draftId: null,
          version: null,
          items: [item({ name: '买水', amount: '9' })],
        },
      },
      {}
    );
    await webSay(threadId, '再记一笔买水9元', visible([draft]));
    let current = await (await api(`drafts?threadId=${threadId}`)).json<{
      items: (typeof draft)[];
    }>();
    expect(current.items).toHaveLength(2);
    intent = 'confirm_all';
    expect(
      (await webSay(threadId, '全部确认', visible([draft]))).stream
    ).toContain('核对下方草稿');
    expect((await entries()).total).toBe(0);
    await webSay(threadId, '全部确认', visible(current.items));
    expect((await entries()).total).toBe(2);
    expect((await entries()).totals.expense).toBe(4400);
    current = await (await api(`drafts?threadId=${threadId}`)).json<{
      items: (typeof draft)[];
    }>();
    expect(current.items.every((item) => item.status === 'posted')).toBe(true);
  });
  it.each([
    'decline',
    'unclear',
    'review_pending',
  ] as const)('preserves drafts without posting for %s', async (decision) => {
    const { threadId, draft } = await makeDraft([item()]);
    intent = decision;
    await webSay(threadId, decision, visible([draft]));
    expect((await entries()).total).toBe(0);
    expect(
      (
        await (
          await api(`drafts?threadId=${threadId}`)
        ).json<{ items: (typeof draft)[] }>()
      ).items[0].status
    ).toBe('ready');
  });
  it('fails closed when intent classification fails', async () => {
    const { threadId, draft } = await makeDraft([item()]);
    intentStatus = 403;
    expect((await webSay(threadId, '确认', visible([draft]))).stream).toContain(
      '本次消息尚未处理'
    );
    expect((await entries()).total).toBe(0);
    intentStatus = 200;
    intent = 'confirm';
    await webSay(threadId, '确认刚才已展示的草稿', visible([draft]));
    expect((await entries()).total).toBe(1);
  });
  it('never confirms cancelled or foreign-conversation draft references', async () => {
    const first = await makeDraft([item()]);
    const second = await makeDraft([item()]);
    intent = 'confirm';
    await webSay(first.threadId, '确认', visible([second.draft]));
    expect((await entries()).total).toBe(0);
    await api('drafts/cancel', {
      ...command(),
      id: first.draft.id,
      version: first.draft.version,
      confirmed: true,
    });
    await webSay(first.threadId, '确认', visible([first.draft]));
    expect((await entries()).total).toBe(0);
  });
  it('does not post incomplete drafts or silently include a newly completed excluded draft', async () => {
    const { threadId, draft } = await makeDraft([item({ amount: null })]);
    intent = 'confirm';
    await webSay(threadId, '确认', visible([draft]));
    expect((await entries()).total).toBe(0);
    intent = 'other';
    replies.push(
      { tool: { draftId: null, version: null, items: [item()] } },
      {}
    );
    await webSay(threadId, '新记午餐35元', null);
    const current = await (await api(`drafts?threadId=${threadId}`)).json<{
      items: (typeof draft)[];
    }>();
    const ready = current.items.filter((item) => item.status === 'ready');
    intent = 'confirm_all';
    await webSay(threadId, '全部确认', visible(ready, [draft.id]));
    expect((await entries()).total).toBe(1);
    expect(
      (
        await (
          await api(`drafts?threadId=${threadId}`)
        ).json<{ items: (typeof draft)[] }>()
      ).items.find((item) => item.id === draft.id)?.status
    ).toBe('needs_details');
  });
});

describe('AI drafts through protected chat and explicit owner commands', () => {
  it('keeps an unrelated read-only failed turn retryable despite older financial receipts in the same conversation', async () => {
    const { threadId } = await makeDraft([item()]);
    const current = await (await api(`conversations/${threadId}`)).json<{
      version: number;
    }>();
    const runId = crypto.randomUUID();
    replies.push({
      before: async () => {
        throw new Error('Synthetic read-only provider failure');
      },
    });
    const response = await api('chat', {
      datasetId,
      threadId,
      version: current.version,
      runId,
      text: '合成只读问题',
    });
    await response.text().catch(() => {});
    const snapshot = await (await api(`chat?threadId=${threadId}`)).json<{
      latestRun: { retryable: boolean; ledgerSaved?: boolean };
      conversation: { version: number };
    }>();
    expect(snapshot.latestRun).toMatchObject({
      retryable: true,
      ledgerSaved: false,
    });
    replies.push({ text: 'Synthetic read-only reply' });
    const retry = await api('chat', {
      datasetId,
      threadId,
      version: snapshot.conversation.version,
      runId: crypto.randomUUID(),
      retryOf: runId,
      text: '合成只读问题',
    });
    expect(await retry.text()).toContain('RUN_FINISHED');
    expect(
      (
        await (
          await api(`drafts?threadId=${threadId}`)
        ).json<{ items: unknown[] }>()
      ).items
    ).toHaveLength(1);
    expect((await entries()).total).toBe(0);
  });
  it.each([
    'review',
    'automatic',
  ] as const)('does not offer or accept a model replay after %s financial writes survive a transcript failure', async (mode) => {
    await permission(mode);
    const threadId = crypto.randomUUID();
    await api('conversations', { ...command(), id: threadId });
    replies.push(
      { tool: { draftId: null, version: null, items: [item()] } },
      {
        before: () =>
          env.DB.exec(
            "CREATE TRIGGER reject_web_tool_history BEFORE INSERT ON chat_messages WHEN json_extract(NEW.message_json,'$.role')='tool' AND NEW.message_json LIKE '%draftId%' BEGIN SELECT RAISE(ABORT,'Synthetic transcript failure'); END;"
          ).then(() => {}),
        text: 'Synthetic financial operation completed',
      }
    );
    const runId = crypto.randomUUID();
    const response = await api('chat', {
      datasetId,
      threadId,
      version: 1,
      runId,
      text: '合成午餐35元',
    });
    await response.text().catch(() => {});
    await env.DB.exec('DROP TRIGGER reject_web_tool_history');
    const current = await (await api(`drafts?threadId=${threadId}`)).json<{
      items: { status: string }[];
    }>();
    expect(current.items).toHaveLength(1);
    expect(current.items[0].status).toBe(
      mode === 'automatic' ? 'posted' : 'ready'
    );
    const snapshot = await (await api(`chat?threadId=${threadId}`)).json<{
      latestRun: { status: string; retryable: boolean; ledgerSaved?: boolean };
      conversation: { version: number };
    }>();
    expect(snapshot.latestRun.status).toBe('failed');
    expect(snapshot.latestRun.retryable).toBe(false);
    expect(snapshot.latestRun.ledgerSaved).toBe(true);
    const calls = modelCalls;
    const retried = await api('chat', {
      datasetId,
      threadId,
      version: snapshot.conversation.version,
      runId: crypto.randomUUID(),
      retryOf: runId,
      text: '合成午餐35元',
    });
    await retried.text().catch(() => {});
    expect(retried.status).toBe(409);
    expect(modelCalls).toBe(calls);
    expect((await entries()).total).toBe(mode === 'automatic' ? 1 : 0);
  });
  it('keeps automatic posting successful when refreshing the same-turn query fails', async () => {
    await permission('automatic');
    const threadId = crypto.randomUUID();
    await api('conversations', { ...command(), id: threadId });
    let prepared: { status: string; queryUpdates?: unknown[] } | undefined;
    replies.push(
      {
        name: 'query_ledger',
        tool: {
          inheritPrevious: false,
          period: { kind: 'all_time' },
          scope: 'spending',
          filters: {},
          view: 'summary',
          interval: 'week',
        },
      },
      { tool: { draftId: null, version: null, items: [item()] } },
      {
        name: 'get_ledger_context',
        tool: (input) => {
          prepared = JSON.parse(String(input.messages.at(-1)?.content));
          return {};
        },
      },
      {}
    );
    let failures = 0;
    let restore!: () => void;
    await runInDurableObject(
      env.CONVERSATIONS.getByName(threadId),
      async (instance) => {
        const db = (instance as unknown as { env: Env }).env.DB;
        const original = db.prepare;
        const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
          if (modelCalls >= 2 && sql.startsWith('SELECT count(*) AS total,')) {
            failures++;
            throw new Error('Synthetic report read failure');
          }
          return original.call(db, sql);
        });
        restore = () => spy.mockRestore();
      }
    );
    try {
      const response = await api('chat', {
        datasetId,
        threadId,
        version: 1,
        runId: crypto.randomUUID(),
        text: '合成午餐35元和统计',
      });
      expect(await response.text()).toContain('RUN_FINISHED');
      expect(failures).toBe(1);
    } finally {
      restore();
    }
    expect(prepared?.status).toBe('posted');
    expect(parseQueryUpdates(prepared)).toEqual([
      { id: expect.any(String), result: null },
    ]);
    expect((await entries()).total).toBe(1);
    expect(
      (
        await (
          await api(`chat?threadId=${threadId}`)
        ).json<{ latestRun: { status: string } }>()
      ).latestRun.status
    ).toBe('completed');
  });
  it.each([
    null,
    0,
    1,
  ])('refreshes every same-turn query and retains the last filter when refresh %s fails', async (failedIndex) => {
    await permission('automatic');
    const threadId = crypto.randomUUID();
    await api('conversations', { ...command(), id: threadId });
    for (const scope of ['spending', 'income'])
      replies.push({
        name: 'query_ledger',
        tool: {
          inheritPrevious: false,
          period: { kind: 'all_time' },
          scope,
          filters: {},
          view: 'summary',
          interval: 'week',
        },
      });
    let refreshPhase = false;
    replies.push(
      {
        before: async () => {
          refreshPhase = true;
        },
        tool: { draftId: null, version: null, items: [item()] },
      },
      {}
    );
    let refreshIndex = 0;
    let restore!: () => void;
    await runInDurableObject(
      env.CONVERSATIONS.getByName(threadId),
      async (instance) => {
        const db = (instance as unknown as { env: Env }).env.DB;
        const original = db.prepare;
        const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
          if (
            refreshPhase &&
            sql.startsWith('SELECT count(*) AS total,') &&
            refreshIndex++ === failedIndex
          )
            throw new Error('Synthetic partial report failure');
          return original.call(db, sql);
        });
        restore = () => spy.mockRestore();
      }
    );
    try {
      await webSay(threadId, '先查全部支出和收入，再记午餐35元');
    } finally {
      restore();
    }
    const messages = await chatPersistence(
      env.DB,
      datasetId
    ).stores.messages.loadThread(threadId);
    const cards = new Map<string, ReturnType<typeof parseQueryResult>>();
    for (const message of messages) {
      if (message.role !== 'tool') continue;
      for (const update of parseQueryUpdates(message.content))
        cards.set(update.id, update.result);
    }
    expect(
      [...cards.values()].map((card) => [
        card?.query.scope,
        card?.report.totals.expense,
      ])
    ).toEqual([
      failedIndex === 0 ? [undefined, undefined] : ['spending', 3500],
      failedIndex === 1 ? [undefined, undefined] : ['income', 0],
    ]);
    expect(
      (await previousLedgerQuery(env.DB, datasetId, threadId))?.query.scope
    ).toBe('income');
    expect((await entries()).total).toBe(1);
  });
  it.each([
    'review',
    'automatic',
  ] as const)('refreshes a same-turn query after preparing a draft in %s mode', async (mode) => {
    await permission(mode);
    const threadId = crypto.randomUUID();
    await api('conversations', { ...command(), id: threadId });
    let prepared:
      | {
          status: string;
          totalBaseAmount?: string;
          queryUpdates?: {
            result: { report: { totals: { expense: string } } } | null;
          }[];
        }
      | undefined;
    replies.push(
      {
        name: 'query_ledger',
        tool: {
          inheritPrevious: false,
          period: { kind: 'all_time' },
          scope: 'spending',
          filters: {},
          view: 'summary',
          interval: 'week',
        },
      },
      { tool: { draftId: null, version: null, items: [item()] } },
      {
        tool: (input) => {
          prepared = JSON.parse(String(input.messages.at(-1)?.content));
          return {};
        },
        name: 'get_ledger_context',
      },
      {}
    );
    const response = await api('chat', {
      datasetId,
      threadId,
      version: 1,
      runId: crypto.randomUUID(),
      text: '合成午餐35元，再看看总支出。',
    });
    expect(await response.text()).toContain('RUN_FINISHED');
    expect(prepared?.status).toBe(mode === 'automatic' ? 'posted' : 'ready');
    expect(prepared?.totalBaseAmount).toBe('CNY 35.00');
    if (mode === 'automatic') {
      expect(prepared?.queryUpdates?.[0].result?.report.totals.expense).toBe(
        'CNY 35.00'
      );
      const history = await chatPersistence(
        env.DB,
        datasetId
      ).stores.messages.loadThread(threadId);
      const persisted = history
        .filter((message) => message.role === 'tool')
        .flatMap((message) => parseQueryUpdates(message.content));
      expect(persisted.at(-1)?.result?.report.totals.expense).toBe(3500);
    }
    expect((await entries()).total).toBe(mode === 'automatic' ? 1 : 0);
  });
  it('bounds combined refreshed reports and keeps a durable posting when not every result fits', async () => {
    await permission('automatic');
    const statements = [
      env.DB.prepare('UPDATE datasets SET currency_locked=1 WHERE id=?').bind(
        datasetId
      ),
    ];
    for (let index = 0; index < 45; index++) {
      const category = `synthetic-category-${index}`;
      statements.push(
        env.DB.prepare(
          "INSERT INTO categories(dataset_id,id,kind,name) VALUES (?,?,'expense',?)"
        ).bind(datasetId, category, `Synthetic category ${index}`),
        env.DB.prepare(
          "INSERT INTO entries(dataset_id,id,kind,name,entry_date,currency,original_minor,base_minor,category_id,note,created_at,updated_at) VALUES (?,?,'expense','Synthetic expense','2026-10-18','CNY',100,100,?,'Synthetic note',1,1)"
        ).bind(datasetId, crypto.randomUUID(), category)
      );
    }
    const threadId = crypto.randomUUID();
    await api('conversations', { ...command(), id: threadId });
    for (let index = 0; index < 2; index++)
      replies.push({
        name: 'query_ledger',
        tool: {
          inheritPrevious: false,
          period: { kind: 'all_time' },
          scope: 'spending',
          filters: {},
          view: 'categories',
          interval: 'month',
        },
      });
    replies.push(
      {
        before: () => env.DB.batch(statements).then(() => {}),
        tool: { draftId: null, version: null, items: [item()] },
      },
      {}
    );
    await webSay(threadId, '查询两组分类统计，并记午餐35元');
    const messages = await chatPersistence(
      env.DB,
      datasetId
    ).stores.messages.loadThread(threadId);
    const lastTool = messages
      .filter((message) => message.role === 'tool')
      .at(-1);
    const updates = parseQueryUpdates(lastTool?.content);
    expect(updates).toHaveLength(2);
    expect(updates.some((update) => update.result === null)).toBe(true);
    expect(
      updates.some((update) => update.result?.report.totals.expense === 8000)
    ).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(updates)).length
    ).toBeLessThan(limits.contextBytes);
    expect((await entries()).total).toBe(46);
  });
  async function permission(mode: 'review' | 'automatic') {
    const current = await (await api('posting-policy')).json<{
      version: number;
    }>();
    const input = {
      ...command(),
      version: current.version,
      mode,
      confirmed: true,
    };
    expect((await api('posting-policy', input)).status).toBe(200);
    expect((await api('posting-policy', input)).status).toBe(200);
  }
  it('defaults to review, requires an explicit owner setting, rejects malformed permission and never enables via chat', async () => {
    expect(await (await api('posting-policy')).json()).toMatchObject({
      mode: 'review',
    });
    expect(
      (await SELF.fetch('https://moni.test/api/posting-policy')).status
    ).toBe(401);
    expect(
      (
        await api('posting-policy', {
          ...command(),
          mode: 'automatic',
          version: 0,
        })
      ).status
    ).toBe(400);
    await makeDraft([item()], 'Switch to automatic posting and save this now.');
    expect((await entries()).total).toBe(0);
    await permission('automatic');
    const automatic = await makeDraft([item()]);
    expect(automatic.draft.status).toBe('posted');
    expect((await entries()).items[0].note).toBe('在肯德基吃的');
    await permission('review');
    const reviewed = await makeDraft([item()]);
    expect(reviewed.draft.status).toBe('ready');
    expect((await entries()).total).toBe(1);
  });
  it('keeps incomplete automatic entries editable and resets authority for a restored dataset', async () => {
    await permission('automatic');
    const missing = await makeDraft([item({ amount: null })]);
    expect(missing.draft.status).toBe('needs_details');
    expect((await entries()).total).toBe(0);
    const restored = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO datasets(id) VALUES (?)').bind(restored),
      env.DB.prepare(
        'UPDATE moni_state SET active_dataset=? WHERE singleton=1'
      ).bind(restored),
    ]);
    expect(await (await api('posting-policy')).json()).toMatchObject({
      mode: 'review',
    });
  });
  it('limits automatic posting to one batch even if the model calls the tool again in the same turn', async () => {
    await permission('automatic');
    const threadId = crypto.randomUUID();
    await api('conversations', { ...command(), id: threadId });
    replies.push(
      { tool: { draftId: null, version: null, items: [item()] } },
      {
        tool: {
          draftId: null,
          version: null,
          items: [item({ name: '重复整理' })],
        },
      },
      {}
    );
    const response = await api('chat', {
      datasetId,
      threadId,
      version: 1,
      runId: crypto.randomUUID(),
      text: '合成午餐35元，只记一笔。',
    });
    expect(await response.text()).toContain('RUN_FINISHED');
    expect((await entries()).total).toBe(1);
    expect(
      await (await api(`drafts?threadId=${threadId}`)).json()
    ).toMatchObject({ items: [{ status: 'posted' }] });
  });
  it('revokes automatic posting atomically when the owner changes permission while a quote is pending', async () => {
    await permission('automatic');
    let release!: () => void;
    quoteWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = makeDraft([item({ currency: 'USD', amount: '20' })]);
    await vi.waitFor(() => expect(quoteCalls).toBe(1));
    await permission('review');
    release();
    expect((await pending).draft.status).toBe('ready');
    expect((await entries()).total).toBe(0);
  });
  it('lets a model copy a current draft from ledger context into the update tool without translating field names', async () => {
    const { threadId, draft } = await makeDraft([item()]);
    const conversation = (await (
      await api(`conversations/${threadId}`)
    ).json()) as { version: number };
    replies.push(
      { name: 'get_ledger_context', tool: {} },
      {
        tool: (input) => {
          const context = JSON.parse(String(input.messages.at(-1)?.content));
          const current = context.drafts[0];
          return {
            ...current,
            items: current.items.map((row: Record<string, unknown>) => ({
              ...row,
              note: '在肯德基吃的，合成接口核对',
            })),
          };
        },
      },
      {}
    );
    const response = await api('chat', {
      datasetId,
      threadId,
      version: conversation.version,
      runId: crypto.randomUUID(),
      text: '合成接口核对：补充备注，其他不变。',
    });
    expect(await response.text()).toContain('RUN_FINISHED');
    const updated = (await (
      await api(`drafts?threadId=${threadId}`)
    ).json()) as { items: (typeof draft)[] };
    expect(updated.items[0]).toMatchObject({
      id: draft.id,
      version: draft.version + 1,
      totalBaseMinor: 3500,
    });
    expect(updated.items[0].items[0].note).toBe('在肯德基吃的，合成接口核对');
    expect((await entries()).total).toBe(0);
  });
  it('matches reordered foreign items by identity and retains actual/reference conversions across equivalent amount formatting', async () => {
    const { threadId, draft } = await makeDraft([
      item({
        name: '合成实际扣款',
        currency: 'USD',
        amount: '20',
        actualBaseAmount: '150',
        note: '独立实际结算备注',
      }),
      item({
        name: '合成参考报价',
        currency: 'USD',
        amount: '20',
        note: '独立参考备注',
      }),
    ]);
    expect(quoteCalls).toBe(1);
    expect(draft.totalBaseMinor).toBe(29400);
    const items = [...draft.items].reverse().map((row) => ({
      itemId: row.id,
      kind: row.kind,
      name: row.name,
      amount: '20.00',
      actualBaseAmount: null,
      currency: row.currency,
      currencyAmbiguous: false,
      date: row.date,
      categoryId: row.categoryId,
      tags: row.tags,
      note: `${row.note}，合成补充`,
    }));
    const conversation = (await (
      await api(`conversations/${threadId}`)
    ).json()) as { version: number };
    replies.push(
      { tool: { draftId: draft.id, version: draft.version, items } },
      {}
    );
    const response = await api('chat', {
      datasetId,
      threadId,
      version: conversation.version,
      runId: crypto.randomUUID(),
      text: '合成回归：反转展示顺序，只补充各自备注，金额保持20美元。',
    });
    expect(await response.text()).toContain('RUN_FINISHED');
    const updated = (await (
      await api(`drafts?threadId=${threadId}`)
    ).json()) as { items: (typeof draft)[] };
    expect(updated.items[0].items.map((row) => row.id)).toEqual(
      [...draft.items].reverse().map((row) => row.id)
    );
    for (const original of draft.items) {
      const revised = updated.items[0].items.find(
        (row) => row.id === original.id
      );
      expect(revised).toMatchObject({
        name: original.name,
        baseMinor: original.baseMinor,
        conversion: original.conversion,
        snapshot: original.snapshot,
        note: `${original.note}，合成补充`,
      });
    }
    expect(updated.items[0].totalBaseMinor).toBe(29400);
    expect(quoteCalls).toBe(1);
    expect((await entries()).total).toBe(0);
  });
  it('uses an explicitly stated actual settlement before a reference quote', async () => {
    const { draft } = await makeDraft([
      item({ currency: 'USD', amount: '20', actualBaseAmount: '150' }),
    ]);
    expect(draft.totalBaseMinor).toBe(15000);
    expect(draft.items[0].snapshot).toMatchObject({
      method: 'actual',
      source: 'actual',
    });
    expect(quoteCalls).toBe(0);
    expect(
      (
        await api('drafts/confirm', {
          ...command(),
          id: draft.id,
          version: draft.version,
          confirmed: true,
        })
      ).status
    ).toBe(200);
    expect((await entries()).items[0]).toMatchObject({
      originalMinor: 2000,
      baseMinor: 15000,
    });
  });

  it('rolls back every draft item and its status when a later entry collides', async () => {
    const { threadId, draft } = await makeDraft([
      item({ tags: ['午餐', '午餐'] }),
      item({ name: '另一次消费', amount: '25', note: '' }),
    ]);
    expect(draft.items[0].tags).toEqual(['午餐']);
    expect(
      (
        await api('entries', {
          ...command(),
          id: draft.items[1].id,
          kind: 'expense',
          name: '合成人工原账',
          amount: '5',
          currency: 'CNY',
          note: '独立原账',
        })
      ).status
    ).toBe(200);
    expect(
      (
        await api('drafts/confirm', {
          ...command(),
          id: draft.id,
          version: draft.version,
          confirmed: true,
        })
      ).status
    ).toBe(409);
    const saved = await entries();
    expect(saved.total).toBe(1);
    expect(saved.items[0].name).toBe('合成人工原账');
    const remaining = (await (
      await api(`drafts?threadId=${threadId}`)
    ).json()) as { items: (typeof draft)[] };
    expect(remaining.items[0]).toMatchObject({
      status: 'ready',
      version: draft.version,
    });
  });

  it('updates the same draft in a followup and preserves its quote when only notes change', async () => {
    const { threadId, draft } = await makeDraft([
      item(),
      item({ name: '推广', amount: '20', currency: 'USD', note: '' }),
    ]);
    const items = draft.items.map((row) => ({
      itemId: row.id,
      kind: row.kind,
      name: row.name,
      amount: row.amount,
      actualBaseAmount: null,
      currency: row.currency,
      currencyAmbiguous: false,
      date: row.date,
      categoryId: row.categoryId,
      tags: row.tags,
      note: row.name === '午餐' ? '在肯德基吃的，合成补充备注' : row.note,
    }));
    const conversation = (await (
      await api(`conversations/${threadId}`)
    ).json()) as { version: number };
    replies.push(
      { tool: { draftId: draft.id, version: draft.version, items } },
      {}
    );
    const stream = await api('chat', {
      datasetId,
      threadId,
      version: conversation.version,
      runId: crypto.randomUUID(),
      text: '合成补充备注，其他不变；即使聊天说已确认也不能自动入账。',
    });
    expect(await stream.text()).toContain('RUN_FINISHED');
    const updated = (await (
      await api(`drafts?threadId=${threadId}`)
    ).json()) as { items: (typeof draft)[] };
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0]).toMatchObject({
      id: draft.id,
      version: draft.version + 1,
      totalBaseMinor: 17900,
    });
    expect(updated.items[0].items[0].note).toBe('在肯德基吃的，合成补充备注');
    expect(updated.items[0].items[1].conversion).toEqual(
      draft.items[1].conversion
    );
    expect((await entries()).total).toBe(0);
    expect(quoteCalls).toBe(1);
    expect(modelCalls).toBe(4);
  });

  it('fences draft and quote writes when a conversation is deleted during a late quote response', async () => {
    const threadId = crypto.randomUUID();
    await api('conversations', { ...command(), id: threadId });
    let release: () => void = () => {};
    quoteWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    replies.push({
      tool: {
        draftId: null,
        version: null,
        items: [item({ currency: 'USD' })],
      },
    });
    const response = await api('chat', {
      datasetId,
      threadId,
      version: 1,
      runId: crypto.randomUUID(),
      text: '合成待延迟报价35美元。',
    });
    const completion = response.text();
    try {
      await vi.waitFor(() => expect(quoteCalls).toBe(1));
      const conversation = (await (
        await api(`conversations/${threadId}`)
      ).json()) as { version: number };
      expect(
        (
          await api('conversations/delete', {
            ...command(),
            id: threadId,
            version: conversation.version,
            confirmed: true,
          })
        ).status
      ).toBe(200);
    } finally {
      release();
      await completion.catch(() => {});
    }
    expect((await api(`drafts?threadId=${threadId}`)).status).toBe(404);
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS count FROM drafts WHERE dataset_id=?'
      )
        .bind(datasetId)
        .first('count')
    ).toBe(0);
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS count FROM fx_quotes WHERE dataset_id=?'
      )
        .bind(datasetId)
        .first('count')
    ).toBe(0);
    expect((await entries()).total).toBe(0);
    expect(modelCalls).toBe(1);
  });
  it('keeps independent notes and precise original currencies, defaults ledger date/currency, then atomically posts CNY179 once', async () => {
    const { draft } = await makeDraft([
      item(),
      item({
        name: '网站推广',
        amount: '20',
        currency: 'USD',
        categoryId: 'expense-other',
        tags: ['推广'],
        note: '',
      }),
    ]);
    expect(draft.status).toBe('ready');
    expect(draft.totalBaseMinor).toBe(17900);
    expect(draft.items[0]).toMatchObject({
      note: '在肯德基吃的',
      amount: '35',
      currency: 'CNY',
      date: todayInZone('Asia/Shanghai'),
      baseMinor: 3500,
    });
    expect(draft.items[1]).toMatchObject({
      note: '',
      amount: '20',
      currency: 'USD',
      baseMinor: 14400,
    });
    expect((await entries()).total).toBe(0);
    expect(quoteCalls).toBe(1);
    const confirmation = {
      ...command(),
      id: draft.id,
      version: draft.version,
      confirmed: true,
    };
    expect(
      (await api('drafts/confirm', { ...confirmation, confirmed: false }))
        .status
    ).toBe(400);
    const responses = await Promise.all([
      api('drafts/confirm', confirmation),
      api('drafts/confirm', confirmation),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(
      (
        await api('drafts/confirm', {
          ...confirmation,
          operationId: crypto.randomUUID(),
        })
      ).status
    ).toBe(409);
    const saved = await entries();
    expect(saved.total).toBe(2);
    expect(
      saved.items
        .map((row) => row.baseMinor)
        .sort((a, b) => Number(a) - Number(b))
    ).toEqual([3500, 14400]);
    expect(saved.items.find((row) => row.name === '午餐')?.note).toBe(
      '在肯德基吃的'
    );
    expect(saved.items.find((row) => row.name === '网站推广')?.note).toBe('');
    expect(quoteCalls).toBe(1);
    expect(modelCalls).toBe(2);
  });

  it('retains missing amounts and ambiguous currencies, allows editing, rejects old cards and keeps pending drafts out of statistics', async () => {
    const { draft } = await makeDraft([
      item({
        name: '鞋',
        amount: null,
        categoryId: 'expense-clothing',
        note: '',
      }),
      item({
        name: '含糊币种',
        amount: '20',
        currencyAmbiguous: true,
        note: '',
      }),
    ]);
    expect(draft.status).toBe('needs_details');
    expect(draft.totalBaseMinor).toBeNull();
    expect(
      (
        await api('drafts/confirm', {
          ...command(),
          id: draft.id,
          version: draft.version,
          confirmed: true,
        })
      ).status
    ).toBe(409);
    const save = {
      ...command(),
      id: draft.id,
      version: draft.version,
      items: draft.items.map((row, index) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        amount: index === 0 ? '88' : '20',
        date: row.date,
        currency: 'CNY',
        categoryId: row.categoryId,
        tags: row.tags,
        note: index === 0 ? '合成鞋子备注' : '',
        conversion: null,
      })),
    };
    expect((await api('drafts/save', save)).status).toBe(200);
    expect(
      (
        await api('drafts/confirm', {
          ...command(),
          id: draft.id,
          version: draft.version,
          confirmed: true,
        })
      ).status
    ).toBe(409);
    expect((await entries()).total).toBe(0);
    expect(
      (
        await api('drafts/confirm', {
          ...command(),
          id: draft.id,
          version: draft.version + 1,
          confirmed: true,
        })
      ).status
    ).toBe(200);
    expect((await entries()).total).toBe(2);
    expect((await entries()).items.find((row) => row.name === '鞋')?.note).toBe(
      '合成鞋子备注'
    );
  });

  it('preserves a foreign draft when quotes fail and accepts a reviewed manual rate without a new quote on note edits', async () => {
    quoteStatus = 503;
    const { threadId, draft } = await makeDraft([
      item({ currency: 'USD', amount: '20' }),
    ]);
    expect(draft.status).toBe('needs_details');
    expect(draft.items[0]).toMatchObject({
      amount: '20',
      note: '在肯德基吃的',
      baseMinor: null,
    });
    const fields = draft.items.map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      amount: row.amount,
      date: row.date,
      currency: row.currency,
      categoryId: row.categoryId,
      tags: row.tags,
      note: '人工核对的合成备注',
      conversion: { rate: '7.20' },
    }));
    expect(
      (
        await api('drafts/save', {
          ...command(),
          id: draft.id,
          version: draft.version,
          items: fields,
        })
      ).status
    ).toBe(200);
    const updated = (await (
      await api(`drafts?threadId=${threadId}`)
    ).json()) as { items: (typeof draft)[] };
    expect(updated.items[0].totalBaseMinor).toBe(14400);
    expect(
      (
        await api('drafts/confirm', {
          ...command(),
          id: draft.id,
          version: draft.version + 1,
          confirmed: true,
        })
      ).status
    ).toBe(200);
    expect((await entries()).items[0]).toMatchObject({
      note: '人工核对的合成备注',
      baseMinor: 14400,
    });
    expect(quoteCalls).toBe(1);
  });

  it('requires owner access and the active dataset, cancels explicitly, and rejects deleted conversation confirmation', async () => {
    const { threadId, draft } = await makeDraft([item()]);
    for (const path of [
      `drafts?threadId=${threadId}`,
      'drafts/save',
      'drafts/confirm',
      'drafts/cancel',
    ])
      expect(
        (
          await SELF.fetch(`https://moni.test/api/${path}`, {
            method: path.includes('?') ? 'GET' : 'POST',
          })
        ).status
      ).toBe(401);
    expect(
      (
        await api('drafts/confirm', {
          ...command(),
          datasetId: 'wrong',
          id: draft.id,
          version: draft.version,
          confirmed: true,
        })
      ).status
    ).toBe(409);
    const cancellation = {
      ...command(),
      id: draft.id,
      version: draft.version,
      confirmed: true,
    };
    expect((await api('drafts/cancel', cancellation)).status).toBe(200);
    expect((await api('drafts/cancel', cancellation)).status).toBe(200);
    expect(
      (
        await api('drafts/confirm', {
          ...command(),
          id: draft.id,
          version: draft.version + 1,
          confirmed: true,
        })
      ).status
    ).toBe(409);
    const other = await makeDraft([item()]);
    const conversation = (await (
      await api(`conversations/${other.threadId}`)
    ).json()) as { version: number };
    expect(
      (
        await api('conversations/delete', {
          ...command(),
          id: other.threadId,
          version: conversation.version,
          confirmed: true,
        })
      ).status
    ).toBe(200);
    expect(
      (
        await api('drafts/confirm', {
          ...command(),
          id: other.draft.id,
          version: other.draft.version,
          confirmed: true,
        })
      ).status
    ).toBe(409);
    expect((await entries()).total).toBe(0);
  });
});
