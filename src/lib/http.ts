import { limits } from './limits';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string
  ) {
    super(code);
  }
}

export function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Vary', 'Cookie, Cf-Access-Jwt-Assertion');
  return new Response(response.body, { status: response.status, headers });
}

export async function readJson(
  request: Request,
  maxBytes: number = limits.requestBytes
): Promise<unknown> {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin)
    throw new HttpError(403, 'origin_denied');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site')
    throw new HttpError(403, 'origin_denied');
  if (!request.headers.get('Content-Type')?.startsWith('application/json'))
    throw new HttpError(415, 'json_required');
  if (!request.body) throw new HttpError(400, 'body_required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, 'request_too_large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}
