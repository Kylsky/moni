import { chat, createModel, maxIterations } from '@tanstack/ai';
import { openaiCompatible } from '@tanstack/ai-openai/compatible';
import { z } from 'zod';
import { type AiConfiguration, environmentAiConfiguration } from './ai-config';
import { HttpError } from './http';

const versionInput = z.object({ version: z.number().int().nonnegative() });
const configInput = versionInput
  .extend({
    apiKey: z.string().trim().max(8192),
    baseURL: z.string().trim().min(1).max(2048),
    model: z.string().trim().min(1).max(200),
    api: z.enum(['chat-completions', 'responses']).optional(),
  })
  .strict();
type Stored = { encrypted_value: string | null; version: number };
export type AiSettings = {
  configured: boolean;
  editable: boolean;
  unreadable: boolean;
  baseURL: string;
  model: string;
  api: AiConfiguration['api'];
  version: number;
};
const row = (env: Env) =>
  env.DB.prepare(
    "SELECT encrypted_value,version FROM service_configuration WHERE name='ai'"
  ).first<Stored>();
const editable = (env: Env) =>
  /^[a-f0-9]{64}$/i.test(env.CONFIG_ENCRYPTION_KEY ?? '');
async function key(env: Env) {
  if (!editable(env)) throw new HttpError(503, 'configuration_key_missing');
  return crypto.subtle.importKey(
    'raw',
    Uint8Array.from(
      (env.CONFIG_ENCRYPTION_KEY ?? '').match(/../g) ?? [],
      (pair) => Number.parseInt(pair, 16)
    ),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  );
}
const aad = new TextEncoder().encode('moni:ai-configuration:v1');
async function decode(
  env: Env,
  value: string
): Promise<AiConfiguration | null> {
  try {
    const [version, nonce, data, extra] = value.split('.');
    if (version !== 'v1' || !nonce || !data || extra) return null;
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        additionalData: aad,
        iv: Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0)),
      },
      await key(env),
      Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    );
    const result = configInput
      .omit({ version: true })
      .safeParse(JSON.parse(new TextDecoder().decode(plain)));
    if (!result.success) return null;
    const parsed = result.data;
    const config = environmentAiConfiguration({
      AI_API_KEY: parsed.apiKey,
      AI_BASE_URL: parsed.baseURL,
      AI_MODEL: parsed.model,
    });
    return config ? { ...config, api: parsed.api ?? 'chat-completions' } : null;
  } catch {
    return null;
  }
}
async function configuration(env: Env, stored: Stored | null) {
  // A cleared or unreadable web configuration must never revive an old environment key.
  return stored
    ? stored.encrypted_value
      ? decode(env, stored.encrypted_value)
      : null
    : environmentAiConfiguration(env);
}
export async function aiConfiguration(env: Env) {
  return configuration(env, await row(env));
}
export async function readAiSettings(env: Env): Promise<AiSettings> {
  const stored = await row(env);
  const config = await configuration(env, stored);
  return {
    configured: Boolean(config),
    editable: editable(env),
    unreadable: Boolean(stored?.encrypted_value && !config),
    baseURL: config?.baseURL ?? '',
    model: config?.model ?? '',
    api: config?.api ?? 'chat-completions',
    version: stored?.version ?? 0,
  };
}
async function candidate(env: Env, raw: unknown) {
  const input = configInput.safeParse(raw);
  if (!input.success) throw new HttpError(400, 'invalid_ai_configuration');
  const stored = await row(env);
  if ((stored?.version ?? 0) !== input.data.version)
    throw new HttpError(409, 'configuration_changed');
  const previous = await configuration(env, stored);
  const config = environmentAiConfiguration({
    AI_API_KEY: input.data.apiKey || previous?.apiKey || '',
    AI_BASE_URL: input.data.baseURL,
    AI_MODEL: input.data.model,
  });
  if (!config || /\s/u.test(config.apiKey))
    throw new HttpError(400, 'invalid_ai_configuration');
  if (
    !input.data.apiKey &&
    previous &&
    new URL(config.baseURL).origin !== new URL(previous.baseURL).origin
  )
    throw new HttpError(400, 'ai_key_required_for_new_host');
  return {
    config: {
      ...config,
      api: input.data.api ?? previous?.api ?? 'chat-completions',
    },
    version: input.data.version,
  };
}
async function write(env: Env, version: number, encrypted: string | null) {
  const result = await (version === 0
    ? env.DB.prepare(
        "INSERT INTO service_configuration(name,encrypted_value,version) VALUES ('ai',?,1) ON CONFLICT(name) DO NOTHING"
      ).bind(encrypted)
    : env.DB.prepare(
        "UPDATE service_configuration SET encrypted_value=?,version=version+1 WHERE name='ai' AND version=?"
      ).bind(encrypted, version)
  ).run();
  if (result.meta.changes !== 1)
    throw new HttpError(409, 'configuration_changed');
  return readAiSettings(env);
}
export async function saveAiSettings(env: Env, raw: unknown) {
  const { config, version } = await candidate(env, raw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    await key(env),
    new TextEncoder().encode(JSON.stringify(config))
  );
  const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  return write(
    env,
    version,
    `v1.${base64(iv)}.${base64(new Uint8Array(encrypted))}`
  );
}
export async function clearAiSettings(env: Env, raw: unknown) {
  const input = versionInput
    .extend({ confirmed: z.literal(true) })
    .strict()
    .safeParse(raw);
  if (!input.success) throw new HttpError(400, 'invalid_ai_configuration');
  return write(env, input.data.version, null);
}
export async function testAiSettings(env: Env, raw: unknown) {
  const { config } = await candidate(env, raw);
  for (const timeoutMs of [15000, 30000]) {
    const result = await connectionAttempt(config, timeoutMs);
    if (result === 'connected') return { connected: true };
    if (result === 'failed') break;
  }
  throw new HttpError(502, 'ai_connection_failed');
}

async function connectionAttempt(config: AiConfiguration, timeoutMs: number) {
  type Result = 'connected' | 'retry' | 'failed';
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<Result>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('retry');
    }, timeoutMs);
  });
  const consume = async (): Promise<Result> => {
    try {
      const provider = openaiCompatible({
        models: [
          createModel(config.model, {
            input: ['text'],
            features: ['streaming'],
            tools: [],
          }),
        ],
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        api: config.api,
        maxRetries: 0,
        timeout: timeoutMs,
      });
      let text = '';
      let finished = false;
      for await (const chunk of chat({
        adapter: provider(config.model),
        messages: [{ role: 'user', content: 'Reply only OK.' }],
        agentLoopStrategy: maxIterations(1),
        abortController: controller,
        debug: false,
      })) {
        if (chunk.type === 'RUN_ERROR')
          return [400, 401, 403, 404, 422].includes(
            Number(chunk.code ?? chunk.error?.code)
          )
            ? 'failed'
            : 'retry';
        if (chunk.type === 'TEXT_MESSAGE_CONTENT') text += chunk.delta;
        if (chunk.type === 'RUN_FINISHED') finished = true;
        if (text.length > 256) return 'failed';
      }
      return controller.signal.aborted
        ? 'retry'
        : finished && text.trim()
          ? 'connected'
          : 'failed';
    } catch {
      // Provider errors can contain request credentials; never log or return them.
      return 'retry';
    }
  };
  try {
    return await Promise.race([stopped, consume()]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
