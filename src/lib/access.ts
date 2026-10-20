import { createRemoteJWKSet, jwtVerify } from 'jose';

export class AccessError extends Error {
  constructor(
    public readonly status: 401 | 403 | 503,
    public readonly code: string
  ) {
    super(code);
  }
}

// This cache holds public verification keys, never identities or request state.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyAccess(
  request: Request,
  env: Env
): Promise<string> {
  if (!env.ACCESS_ISSUER || !env.ACCESS_AUDIENCE || !env.OWNER_SUBJECT)
    throw new AccessError(503, 'access_not_configured');
  let issuer: URL;
  try {
    issuer = new URL(env.ACCESS_ISSUER);
    if (
      issuer.protocol !== 'https:' ||
      !issuer.hostname.endsWith('.cloudflareaccess.com') ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      (issuer.pathname !== '/' && issuer.pathname !== '')
    )
      throw new Error('Invalid issuer');
  } catch {
    throw new AccessError(503, 'access_not_configured');
  }
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > 16_384)
    throw new AccessError(401, 'access_required');
  const origin = issuer.origin;
  let keys = keySets.get(origin);
  if (!keys) {
    keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', origin), {
      timeoutDuration: 5_000,
    });
    if (keySets.size >= 4) keySets.clear();
    keySets.set(origin, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer: origin,
      audience: env.ACCESS_AUDIENCE,
      requiredClaims: ['exp', 'iat', 'sub', 'iss', 'aud'],
      clockTolerance: 5,
    });
    if (
      payload.sub !== env.OWNER_SUBJECT ||
      !payload.sub ||
      payload.type !== 'app' ||
      typeof payload.email !== 'string' ||
      !payload.email ||
      'common_name' in payload ||
      'service_token_id' in payload
    )
      throw new Error('Owner identity required');
    return payload.sub;
  } catch {
    throw new AccessError(403, 'access_denied');
  }
}
