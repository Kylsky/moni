import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { expect, it } from 'vitest';

const scripts = JSON.parse(await readFile('package.json', 'utf8')).scripts;

it('does not ask deploy-button users for any secrets and keeps the local template blank', async () => {
  for (const filename of ['.dev.vars.example', '.env.example'])
    await expect(readFile(filename)).rejects.toMatchObject({ code: 'ENOENT' });
  const template = parseEnv(
    await readFile('config/local.vars.example', 'utf8')
  );
  expect(Object.keys(template)).toContain('AI_API_KEY');
  expect(Object.keys(template)).toContain('OWNER_SUBJECT');
  expect(Object.values(template).every((value) => value === '')).toBe(true);
});

it.each([
  false,
  true,
])('runs remote migrations by binding before upload and stops on migration failure: %s', async (fail) => {
  const directory = await mkdtemp(join(tmpdir(), 'moni-deploy-command-'));
  try {
    const executable = join(directory, 'wrangler');
    const logfile = join(directory, 'calls.jsonl');
    await writeFile(
      executable,
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.MONI_TEST_LOG, JSON.stringify(args) + '\\n');
if (process.env.MONI_TEST_FAIL === '1' && args.includes('migrations')) process.exit(2);
if (args.join(' ') === 'secret list') process.stdout.write(JSON.stringify([{name:'CONFIG_ENCRYPTION_KEY'},{name:'WECHAT_SECRET'}]));
`
    );
    await chmod(executable, 0o700);
    await symlink(process.execPath, join(directory, 'node'));
    const result = spawnSync('/bin/sh', ['-c', scripts.deploy], {
      env: {
        AI_API_KEY: '',
        AI_BASE_URL: '',
        AI_MODEL: '',
        ACCESS_ISSUER: '',
        ACCESS_AUDIENCE: '',
        OWNER_SUBJECT: '',
        WECHAT_SECRET: '',
        CONFIG_ENCRYPTION_KEY: '',
        PATH: directory,
        MONI_TEST_LOG: logfile,
        MONI_TEST_FAIL: fail ? '1' : '0',
      },
    });
    expect(result.status, result.stderr.toString()).toBe(fail ? 2 : 0);
    const calls = (await readFile(logfile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ['d1', 'migrations', 'apply', 'DB', '--remote'],
      ...(fail ? [] : [['deploy'], ['secret', 'list']]),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
