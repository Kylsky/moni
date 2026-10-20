import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

let config = {};
try {
  config = parseEnv(await readFile('.dev.vars', 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const secrets = Object.entries(config).filter(([, value]) => value.length >= 8);
const findings = [];
const files = new Set(
  execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' }
  )
    .split('\0')
    .filter(Boolean)
);
for (const path of await readdir('dist', { recursive: true }))
  files.add(`dist/${path}`);
for (const file of files) {
  try {
    const content = await readFile(file);
    if (file.split('/').at(-1).startsWith('.dev.vars'))
      findings.push({ file, variable: 'private_configuration_file' });
    for (const [name, value] of secrets)
      if (content.includes(Buffer.from(value)))
        findings.push({ file, variable: name });
  } catch (error) {
    if (error.code !== 'EISDIR' && error.code !== 'ENOENT') throw error;
  }
}
if (findings.length) console.error(JSON.stringify({ findings }));
assert.equal(
  findings.length,
  0,
  'Private data found in public source or output'
);
console.log(
  'Private configuration absent from source, assets and build output.'
);
