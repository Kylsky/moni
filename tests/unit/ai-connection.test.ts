import { afterEach, expect, it, vi } from 'vitest';
import { testAiSettings } from '../../src/lib/ai-settings';

const env = {
  DB: { prepare: () => ({ first: async () => null }) },
} as unknown as Env;
const config = {
  version: 0,
  apiKey: 'synthetic-connection-key',
  baseURL: 'https://model.invalid/v1',
  model: 'synthetic-model',
  api: 'responses',
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('retries a stuck read-only connection probe after 15 seconds and accepts a valid Responses reply', async () => {
  vi.useFakeTimers();
  let complete!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      })
  );
  vi.stubGlobal('fetch', fetcher);
  const result = testAiSettings(env, config);
  await vi.advanceTimersByTimeAsync(15000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  complete(
    new Response(
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', output: [{ type: 'message', id: 'msg_synthetic', role: 'assistant', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }] } })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  );
  expect(await result).toEqual({ connected: true });
});
it('ends a connection probe after 15 plus 30 seconds even if the transport ignores cancellation', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetcher);
  const result = testAiSettings(env, config).catch((error) => error);
  await vi.advanceTimersByTimeAsync(45000);
  expect(await result).toMatchObject({
    status: 502,
    code: 'ai_connection_failed',
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
