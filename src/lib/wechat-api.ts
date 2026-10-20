import { ApiClient, type SendMessageReq } from 'wechat-ilink-client';
import { z } from 'zod';
import { HttpError } from './http';

// Protocol: Tencent/openclaw-weixin, commit 874637a0dbc24050f72d1385add4fc6170a2d726.
export const wechatOrigin = 'https://ilinkai.weixin.qq.com';
const channelVersion = '2.4.10';
const identifier = z.string().min(1).max(2048);
export const wechatMessage = z.object({
  message_id: identifier,
  create_time_ms: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .catch(undefined),
  from_user_id: identifier,
  to_user_id: z.string().max(2048).optional(),
  message_type: z.number(),
  message_state: z.number(),
  group_id: z.string().optional(),
  context_token: identifier.optional(),
  item_list: z
    .array(
      z.object({
        type: z.number(),
        text_item: z.object({ text: z.string().max(20000) }).optional(),
      })
    )
    .max(100),
});
export const updatesResponse = z.object({
  msgs: z.array(z.unknown()).max(100).default([]),
  get_updates_buf: z.string().max(100000).optional(),
});
export const qrResponse = z.object({
  qrcode: identifier,
  qrcode_img_content: z.string().min(1).max(4096),
});
export const loginResponse = z.object({
  status: z.enum([
    'wait',
    'scaned',
    'confirmed',
    'expired',
    'need_verifycode',
    'verify_code_blocked',
    'scaned_but_redirect',
    'binded_redirect',
  ]),
  bot_token: identifier.optional(),
  ilink_bot_id: identifier.optional(),
  ilink_user_id: identifier.optional(),
  baseurl: z.string().optional(),
  redirect_host: z.string().optional(),
});

export function safeWechatOrigin(raw: string) {
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(
      url.hostname === 'weixin.qq.com' ||
      url.hostname.endsWith('.weixin.qq.com')
    )
  )
    throw new HttpError(502, 'wechat_invalid_host');
  return url.origin;
}

export function parseWechatJson(text: string): unknown {
  // V8's reviver source preserves uint64 IDs; fail closed on older runtimes.
  return JSON.parse(text, (key, value, context?: { source?: string }) => {
    if (key !== 'message_id' || typeof value !== 'number') return value;
    if (context?.source && /^\d+$/.test(context.source)) return context.source;
    if (Number.isSafeInteger(value)) return String(value);
    throw new HttpError(502, 'wechat_invalid_message_id');
  });
}

export async function wechatApi(
  origin: string,
  path: string,
  body?: Record<string, unknown>,
  token?: string,
  timeout = 40000
): Promise<unknown> {
  const requested = new URL(`${safeWechatOrigin(origin)}/ilink/bot/${path}`);
  const api = new ApiClient({
    baseUrl: safeWechatOrigin(origin),
    token,
    channelVersion,
    fetch: async (input, init) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      );
      if (url.origin !== safeWechatOrigin(origin))
        throw new HttpError(502, 'wechat_invalid_host');
      const headers = new Headers(init?.headers);
      headers.delete('Content-Length');
      headers.set('iLink-App-Id', 'bot');
      headers.set('iLink-App-ClientVersion', String((2 << 16) | (4 << 8) | 10));
      let method = init?.method ?? 'GET';
      let payload = init?.body;
      // SDK 0.1.0 predates Tencent's POST QR endpoint and app headers.
      if (url.pathname.endsWith('/get_bot_qrcode')) {
        method = 'POST';
        payload = JSON.stringify({ local_token_list: [] });
        headers.set('Content-Type', 'application/json');
        headers.set('AuthorizationType', 'ilink_bot_token');
        headers.set(
          'X-WECHAT-UIN',
          btoa(String(crypto.getRandomValues(new Uint32Array(1))[0]))
        );
      }
      if (
        url.pathname.endsWith('/get_qrcode_status') &&
        requested.searchParams.has('verify_code')
      )
        url.searchParams.set(
          'verify_code',
          requested.searchParams.get('verify_code') ?? ''
        );
      if (token && typeof payload === 'string') {
        const json = JSON.parse(payload);
        if (json.base_info) json.base_info.bot_agent = 'Moni/0.1';
        payload = JSON.stringify(json);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const raw = await wechatTransport(url, {
          ...init,
          method,
          body: payload,
          headers,
          redirect: 'manual',
          signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            controller.signal,
          ]),
        });
        return Response.json(raw);
      } finally {
        clearTimeout(timer);
      }
    },
  });
  if (requested.pathname.endsWith('/get_bot_qrcode')) return api.getQRCode();
  if (requested.pathname.endsWith('/get_qrcode_status'))
    return api.pollQRCodeStatus(requested.searchParams.get('qrcode') ?? '');
  if (requested.pathname.endsWith('/getupdates'))
    return api.getUpdates(String(body?.get_updates_buf ?? ''), timeout);
  if (requested.pathname.endsWith('/sendmessage')) {
    await api.sendMessage(body as SendMessageReq);
    return { ret: 0 };
  }
  throw new HttpError(400, 'wechat_unknown_operation');
}

async function wechatTransport(url: URL, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    if (init.signal?.aborted && url.pathname.endsWith('/getupdates'))
      return { ret: 0, msgs: [] };
    if (init.signal?.aborted && url.pathname.endsWith('/get_qrcode_status'))
      return { status: 'wait' };
    throw new HttpError(502, 'wechat_unavailable');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(502, 'wechat_unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(502, 'wechat_invalid_response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 1024 * 1024) {
        await reader.cancel();
        throw new HttpError(502, 'wechat_response_limit');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  let raw: unknown;
  try {
    raw = parseWechatJson(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(502, 'wechat_invalid_response');
  }
  const result = z
    .object({ ret: z.number().optional(), errcode: z.number().optional() })
    .safeParse(raw);
  if (!result.success) throw new HttpError(502, 'wechat_invalid_response');
  if (result.data.ret === -14 || result.data.errcode === -14)
    throw new HttpError(409, 'wechat_reconnect_required');
  if (result.data.ret || result.data.errcode)
    throw new HttpError(502, 'wechat_service_error');
  return raw;
}

export function wechatConfigured(env: Env) {
  return /^[a-f0-9]{64}$/i.test(env.WECHAT_SECRET ?? '');
}

async function credentialKey(env: Env) {
  if (!wechatConfigured(env)) throw new HttpError(503, 'wechat_not_configured');
  const bytes = Uint8Array.from(
    (env.WECHAT_SECRET ?? '').match(/../g) ?? [],
    (pair) => Number.parseInt(pair, 16)
  );
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}
export async function sealWechat(env: Env, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await credentialKey(env),
    new TextEncoder().encode(JSON.stringify(value))
  );
  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(ciphertext)))}`;
}
export async function openWechat<T>(env: Env, value: string): Promise<T> {
  const [nonce, data] = value.split('.');
  try {
    const bytes = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0)),
      },
      await credentialKey(env),
      Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new HttpError(503, 'wechat_reconnect_required');
  }
}
