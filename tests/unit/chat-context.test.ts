import {
  type ChatMiddleware,
  chat,
  createModel,
  type ModelMessage,
  maxIterations,
} from '@tanstack/ai';
import { openaiCompatible } from '@tanstack/ai-openai/compatible';
import { afterEach, expect, it, vi } from 'vitest';
import { aiConfiguration } from '../../src/lib/ai-settings';
import { conversationContext } from '../../src/lib/chat-context';

vi.mock('../../src/lib/ai-settings', async () => {
  const { environmentAiConfiguration } = await import(
    '../../src/lib/ai-config'
  );
  return {
    aiConfiguration: vi.fn(async (env: Env) => environmentAiConfiguration(env)),
  };
});

const env = {
  AI_API_KEY: 'synthetic-key-not-a-secret',
  AI_BASE_URL: 'https://model.invalid/v1',
  AI_MODEL: 'synthetic-model',
} as Env;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(aiConfiguration).mockClear();
});
async function run(
  messages: ModelMessage[],
  middleware: ChatMiddleware = conversationContext(
    env,
    new AbortController().signal,
    async () => {}
  )
) {
  const provider = openaiCompatible({
    models: [
      createModel('synthetic-model', {
        input: ['text'],
        features: ['streaming'],
        tools: [],
      }),
    ],
    apiKey: env.AI_API_KEY,
    baseURL: env.AI_BASE_URL,
    maxRetries: 0,
  });
  let text = '';
  for await (const chunk of chat({
    adapter: provider('synthetic-model'),
    messages,
    debug: false,
    agentLoopStrategy: maxIterations(1),
    middleware: [middleware],
  }))
    if (chunk.type === 'TEXT_MESSAGE_CONTENT') text += chunk.delta;
  return text;
}

it('times out summary after 15 seconds and continues with the intact current turn in a safe window', async () => {
  vi.useFakeTimers();
  const requests: { messages: { role: string; content: string }[] }[] = [];
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body));
    requests.push(input);
    if (
      input.messages.some(
        (message: { role: string; content: string }) =>
          message.role === 'system' &&
          message.content.startsWith('You summarize Moni')
      )
    )
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Synthetic timeout', 'AbortError')),
          { once: true }
        )
      );
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic bounded reply' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  });
  const history: ModelMessage[] = [
    ...Array.from({ length: 100 }, (_, index) => ({
      role: 'user' as const,
      content: `Synthetic ${index} ${'旧内容'.repeat(200)}`,
    })),
    { role: 'user', content: 'Current synthetic input' },
  ];
  const result = run(history);
  await vi.advanceTimersByTimeAsync(14999);
  expect(requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe('Synthetic bounded reply');
  expect(requests).toHaveLength(2);
  expect(requests[1].messages.at(-1)?.content).toBe('Current synthetic input');
  expect(JSON.stringify(requests[1])).toContain('temporarily unavailable');
  expect(history).toHaveLength(101);
});

it('rejects an oversized current turn before any model or summary request', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(
    run([{ role: 'user', content: 'x'.repeat(40000) }])
  ).rejects.toThrow('context_limit');
  expect(fetcher).not.toHaveBeenCalled();
});

it('uses the saved Responses protocol for automatic summaries and preserves full history', async () => {
  const config = await aiConfiguration(env);
  if (!config) throw new Error('Synthetic configuration missing');
  vi.mocked(aiConfiguration).mockResolvedValueOnce({
    ...config,
    api: 'responses',
  });
  const paths: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    paths.push(String(url));
    if (String(url).endsWith('/responses')) {
      expect(JSON.parse(String(init?.body)).input).toBeDefined();
      return new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_summary', status: 'completed', output: [{ type: 'message', id: 'msg_summary', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic Responses memory.', annotations: [] }] }] } })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
    expect(String(init?.body)).toContain('Synthetic Responses memory.');
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Synthetic answer' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  });
  const history: ModelMessage[] = [
    ...Array.from({ length: 100 }, () => ({
      role: 'user' as const,
      content: 'Synthetic history '.repeat(100),
    })),
    { role: 'user', content: 'Current synthetic input' },
  ];
  expect(await run(history)).toBe('Synthetic answer');
  expect(paths).toContain('https://model.invalid/v1/responses');
  expect(history).toHaveLength(101);
});

it('does not repeat a failed summary during the same run and allows a fresh run to try again', async () => {
  vi.useFakeTimers();
  let summaries = 0;
  let answers = 0;
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body));
    if (
      input.messages.some(
        (message: { role: string; content: string }) =>
          message.role === 'system' &&
          message.content.startsWith('You summarize Moni')
      )
    ) {
      summaries++;
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Synthetic timeout', 'AbortError')),
          { once: true }
        )
      );
    }
    answers++;
    expect(input.messages.at(-1).content).toBe('Keep the current input intact');
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic answer' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  });
  const history: ModelMessage[] = [
    ...Array.from({ length: 100 }, () => ({
      role: 'user' as const,
      content: 'Synthetic history '.repeat(100),
    })),
    { role: 'user', content: 'Keep the current input intact' },
  ];
  const middleware = conversationContext(
    env,
    new AbortController().signal,
    async () => {}
  );
  const first = run(history, middleware);
  await vi.advanceTimersByTimeAsync(15000);
  expect(await first).toBe('Synthetic answer');
  expect(summaries).toBe(1);
  const nextStep = run(history, middleware);
  await vi.advanceTimersByTimeAsync(1);
  try {
    expect(summaries).toBe(1);
    expect(answers).toBe(2);
  } finally {
    await vi.advanceTimersByTimeAsync(15000);
    await nextStep;
  }
  const fresh = run(history);
  await vi.advanceTimersByTimeAsync(15000);
  expect(await fresh).toBe('Synthetic answer');
  expect(summaries).toBe(2);
  expect(answers).toBe(3);
  expect(history).toHaveLength(101);
});
