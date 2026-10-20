import type { Miniflare, Request, Response } from 'miniflare';

export function startTestServer(
  port?: number,
  options?: {
    ai?: { AI_API_KEY?: string; AI_BASE_URL?: string; AI_MODEL?: string };
    provider?: (request: Request) => Promise<Response>;
    wechatSecret?: string;
    access?: {
      ACCESS_ISSUER?: string;
      ACCESS_AUDIENCE?: string;
      OWNER_SUBJECT?: string;
    };
  }
): Promise<{
  url: string;
  close: () => Promise<void>;
  runtime: Miniflare;
  ownerToken: string;
}>;
