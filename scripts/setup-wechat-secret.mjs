import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseEnv } from 'node:util';

execFileSync('git', ['check-ignore', '--quiet', '.dev.vars']);
assert.equal(
  spawnSync('git', ['ls-files', '--error-unmatch', '.dev.vars'], {
    stdio: 'ignore',
  }).status,
  1,
  'Private configuration must not be tracked'
);
const file = await open(
  '.dev.vars',
  constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
  0o600
);
try {
  const content = await file.readFile('utf8');
  const existing = parseEnv(content).WECHAT_SECRET;
  assert.ok(
    !existing || /^[a-f0-9]{64}$/i.test(existing),
    'Existing WECHAT_SECRET is invalid; no value was replaced'
  );
  if (!existing)
    await file.write(
      `${content.endsWith('\n') || !content ? '' : '\n'}WECHAT_SECRET="${randomBytes(32).toString('hex')}"\n`
    );
  await file.chmod(0o600);
} finally {
  await file.close();
}
console.log(
  'WeChat encryption secret ready in ignored private configuration. No secret was displayed.'
);
