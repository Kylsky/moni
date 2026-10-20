import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const blank = {
  AI_API_KEY: '',
  AI_BASE_URL: '',
  AI_MODEL: '',
  ACCESS_ISSUER: '',
  ACCESS_AUDIENCE: '',
  OWNER_SUBJECT: '',
  CONFIG_ENCRYPTION_KEY: '',
  WECHAT_SECRET: '',
};

it.each([
  [[]],
  [['WECHAT_SECRET']],
  [['CONFIG_ENCRYPTION_KEY', 'WECHAT_SECRET']],
])('generates only missing deployment secrets and never logs values: %j', async (existing) => {
  const directory = await mkdtemp(join(tmpdir(), 'moni-secret-bootstrap-'));
  try {
    const executable = join(directory, 'wrangler');
    const logfile = join(directory, 'calls.jsonl');
    await writeFile(
      executable,
      `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (process.env.WRANGLER_LOG_SANITIZE !== 'true') process.exit(5);
const entry = { args };
if (args[1] === 'list') process.stdout.write(process.env.MONI_TEST_EXISTING);
if (args[1] === 'bulk') {
  const body = JSON.parse(fs.readFileSync(0,'utf8'));
  entry.keys = Object.keys(body);
  entry.valid = Object.values(body).every(x=>/^[a-f0-9]{64}$/.test(x));
}
fs.appendFileSync(process.env.MONI_TEST_LOG,JSON.stringify(entry)+'\\n');
`
    );
    await chmod(executable, 0o700);
    const result = spawnSync(
      process.execPath,
      ['scripts/bootstrap-deployment-secrets.mjs', '--env', 'preview'],
      {
        env: {
          ...blank,
          WRANGLER_LOG_SANITIZE: 'false',
          PATH: directory,
          MONI_TEST_LOG: logfile,
          MONI_TEST_EXISTING: JSON.stringify(
            existing.map((name) => ({ name }))
          ),
        },
        encoding: 'utf8',
      }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toMatch(/[a-f0-9]{64}/);
    const calls = (await readFile(logfile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls[0].args).toEqual(['secret', 'list', '--env', 'preview']);
    const missing = ['CONFIG_ENCRYPTION_KEY', 'WECHAT_SECRET'].filter(
      (name) => !existing.includes(name)
    );
    expect(calls).toHaveLength(missing.length ? 2 : 1);
    if (missing.length)
      expect(calls[1]).toEqual({
        args: ['secret', 'bulk', '--env', 'preview'],
        keys: missing,
        valid: true,
      });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('fails without generating or rotating secrets when the existing list is unreadable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moni-secret-failure-'));
  try {
    const executable = join(directory, 'wrangler');
    await writeFile(
      executable,
      `#!${process.execPath}
if(process.argv.includes('bulk')) process.exit(99);
process.stdout.write('not-json-with-sensitive-output');
`
    );
    await chmod(executable, 0o700);
    const result = spawnSync(
      process.execPath,
      ['scripts/bootstrap-deployment-secrets.mjs'],
      { env: { ...blank, PATH: directory }, encoding: 'utf8' }
    );
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(
      'not-json-with-sensitive-output'
    );
    expect(result.stderr).toContain('retry');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
