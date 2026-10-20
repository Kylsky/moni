import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// Run after deploy: Wrangler resolves the same generated config and target environment.
try {
  const args = process.argv.slice(2);
  const existing = JSON.parse(
    execFileSync('wrangler', ['secret', 'list', ...args], {
      encoding: 'utf8',
      env: { ...process.env, WRANGLER_LOG_SANITIZE: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  if (
    !Array.isArray(existing) ||
    existing.some((item) => typeof item.name !== 'string')
  )
    throw new Error('Invalid secret listing');
  const names = new Set(existing.map((item) => item.name));
  const missing = Object.fromEntries(
    ['CONFIG_ENCRYPTION_KEY', 'WECHAT_SECRET']
      .filter((name) => !names.has(name))
      .map((name) => [name, randomBytes(32).toString('hex')])
  );
  if (Object.keys(missing).length)
    execFileSync('wrangler', ['secret', 'bulk', ...args], {
      input: JSON.stringify(missing),
      env: { ...process.env, WRANGLER_LOG_SANITIZE: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  console.log('Deployment encryption keys ready; existing secrets preserved.');
} catch {
  console.error(
    'Deployment encryption setup failed. Check Worker permissions and retry; do not rotate existing keys.'
  );
  process.exitCode = 1;
}
