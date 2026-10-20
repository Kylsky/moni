import { afterEach, expect, it, vi } from 'vitest';
import { conversationIntent } from '../../src/lib/conversation-intent';
import { wechatConfirmationIntent } from '../../src/lib/wechat-confirmation-intent';

vi.mock('../../src/lib/ai-settings', async () => {
  const { environmentAiConfiguration } = await import(
    '../../src/lib/ai-config'
  );
  return {
    aiConfiguration: async (env: Env) => environmentAiConfiguration(env),
  };
});

const env = {
  AI_API_KEY: 'synthetic-key-not-a-secret',
  AI_BASE_URL: 'https://model.invalid/v1',
  AI_MODEL: 'synthetic-model',
} as Env;
const review = {
  reviewed: true,
  reviewedDrafts: 2,
  otherPendingDrafts: 0,
  items: [
    {
      name: 'Synthetic lunch',
      amount: '35',
      currency: 'CNY',
      date: '2026-10-19',
    },
    {
      name: 'Synthetic train',
      amount: '8',
      currency: 'CNY',
      date: '2026-10-19',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('uses the same classifier for both channels and cancels without retrying when a web conversation is stopped', async () => {
  expect(wechatConfirmationIntent).toBe(conversationIntent);
  const provider = delayedProvider();
  const controller = new AbortController();
  const result = conversationIntent(env, '确认', review, controller.signal);
  await vi.advanceTimersByTimeAsync(1000);
  controller.abort();
  expect(await result).toBeNull();
  await vi.advanceTimersByTimeAsync(45000);
  expect(provider.fetcher).toHaveBeenCalledTimes(1);
});

function delayedProvider() {
  vi.useFakeTimers();
  let release!: (response: Response) => void;
  const fetcher = vi.fn(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        release = resolve;
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Synthetic timeout', 'AbortError')),
          { once: true }
        );
      })
  );
  vi.stubGlobal('fetch', fetcher);
  return {
    fetcher,
    complete: () =>
      release(
        new Response(
          `data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function', function: { name: 'classify_draft_confirmation', arguments: '{"intent":"confirm_all"}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
      ),
  };
}

it('returns a quick valid classification without another request', async () => {
  const provider = delayedProvider();
  const result = wechatConfirmationIntent(
    env,
    '都没问题，全部确认入账。',
    review
  );
  await vi.advanceTimersByTimeAsync(10000);
  provider.complete();
  expect(await result).toBe('confirm_all');
  expect(provider.fetcher).toHaveBeenCalledTimes(1);
});

it('allows the second classification 30 seconds without approving early', async () => {
  const provider = delayedProvider();
  let completed = false;
  const result = wechatConfirmationIntent(
    env,
    '都没问题，全部确认入账。',
    review
  ).then((value) => {
    completed = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(15000);
  expect(provider.fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(20000);
  expect(completed).toBe(false);
  provider.complete();
  expect(await result).toBe('confirm_all');
  expect(provider.fetcher).toHaveBeenCalledTimes(2);
});

it('stops after 15 plus 30 seconds without granting permission or making a third request', async () => {
  const provider = delayedProvider();
  let completed = false;
  const result = wechatConfirmationIntent(
    env,
    '都没问题，全部确认入账。',
    review
  ).then((value) => {
    completed = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(14999);
  expect(provider.fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(provider.fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(29999);
  expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBeNull();
  expect(provider.fetcher).toHaveBeenCalledTimes(2);
});

it('enforces both deadlines even when the provider never reacts to cancellation', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetcher);
  let finished = false;
  const result = conversationIntent(env, '具体的账目给我看一下', review).then(
    (value) => {
      finished = true;
      return value;
    }
  );
  await vi.advanceTimersByTimeAsync(15000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(30000);
  expect(finished).toBe(true);
  expect(await result).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('returns immediately on owner cancellation even if the provider ignores abort', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  let finished = false;
  const result = conversationIntent(
    env,
    '确认',
    review,
    controller.signal
  ).then((value) => {
    finished = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(1000);
  controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).toBe(true);
  expect(await result).toBeNull();
  await vi.advanceTimersByTimeAsync(45000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('ignores a late approval from an expired attempt while a fresh classification is running', async () => {
  vi.useFakeTimers();
  const releases: ((response: Response) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        })
    )
  );
  let finished = false;
  const result = conversationIntent(env, '具体账目', review).then((value) => {
    finished = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(15000);
  expect(releases).toHaveLength(2);
  const response = (value: string) =>
    new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: crypto.randomUUID(), type: 'function', function: { name: 'classify_draft_confirmation', arguments: JSON.stringify({ intent: value }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  releases[0](response('confirm'));
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).toBe(false);
  releases[1](response('other'));
  expect(await result).toBe('other');
});

it.each([
  ['conflicting decisions', ['{"intent":"confirm"}', '{"intent":"other"}']],
  ['invalid later decision', ['{"intent":"confirm"}', '{"intent":"invalid"}']],
  [
    'invalid later fields',
    ['{"intent":"confirm"}', '{"intent":"other","unexpected":true}'],
  ],
  ['malformed later arguments', ['{"intent":"confirm"}', '{']],
  ['invalid first decision', ['{"intent":"invalid"}', '{"intent":"confirm"}']],
] as const)('rejects an entire classification response with %s rather than approving from its valid fragment', async (_name, argumentsList) => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        `data: ${JSON.stringify({ id: 'synthetic-invalid-classification', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: argumentsList.map((argumentsText, index) => ({ index, id: `synthetic-call-${index}`, type: 'function', function: { name: 'classify_draft_confirmation', arguments: argumentsText } })) }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
  );
  vi.stubGlobal('fetch', fetcher);
  expect(await conversationIntent(env, '核对好了，确认', review)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('accepts one classification whose arguments arrive in several stream fragments', async () => {
  const deltas = [
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'synthetic-fragmented-call',
          type: 'function',
          function: { name: 'classify_draft_confirmation', arguments: '{"int' },
        },
      ],
    },
    { tool_calls: [{ index: 0, function: { arguments: 'ent":"con' } }] },
    { tool_calls: [{ index: 0, function: { arguments: 'firm"}' } }] },
  ];
  const fetcher = vi.fn(
    async () =>
      new Response(
        `${deltas.map((delta, index) => `data: ${JSON.stringify({ id: 'synthetic-fragmented', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: index === deltas.length - 1 ? 'tool_calls' : null }] })}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
  );
  vi.stubGlobal('fetch', fetcher);
  expect(await conversationIntent(env, '核对好了，确认', review)).toBe(
    'confirm'
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
