import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scriptDirectories = ['telegram', 'youtube'];
const scripts = [];

for (const directory of scriptDirectories) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.user.js')) {
      scripts.push(resolve(root, directory, entry.name));
    }
  }
}

if (!scripts.length) throw new Error('No userscripts were found.');

const identities = new Set();
for (const script of scripts.sort()) {
  const syntax = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
  if (syntax.status !== 0) {
    process.stderr.write(syntax.stderr || syntax.stdout);
    process.exitCode = 1;
    continue;
  }

  const source = await readFile(script, 'utf8');
  const metadata = source.match(
    /^\/\/ ==UserScript==\r?\n([\s\S]*?)^\/\/ ==\/UserScript==/m
  )?.[1];
  if (!metadata) throw new Error(`${script} has no valid userscript metadata block.`);

  const value = (key) => metadata.match(new RegExp(`^// @${key}\\s+(.+)$`, 'm'))?.[1].trim();
  for (const key of ['name', 'namespace', 'version', 'description', 'match', 'run-at', 'license']) {
    if (!value(key)) throw new Error(`${script} is missing @${key}.`);
  }

  const namespace = value('namespace');
  if (!namespace.startsWith('https://github.com/BreakZhu/web-audio-download-scripts/')) {
    throw new Error(`${script} still uses an obsolete @namespace.`);
  }

  const identity = `${namespace}\n${value('name')}`;
  if (identities.has(identity)) throw new Error(`${script} duplicates another userscript identity.`);
  identities.add(identity);
  console.log(`checked ${script.slice(root.length + 1)}`);
}

if (process.exitCode) process.exit(process.exitCode);
