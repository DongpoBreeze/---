import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [aliasInput, command, ...args] = process.argv.slice(2);
if (!aliasInput || !command) throw new Error('Expected project root and an autolinking command.');
const aliasRoot = resolve(aliasInput);
const canonicalRoot = realpathSync(aliasRoot);
const result = spawnSync(command, args, { cwd: aliasRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (result.error || result.status !== 0) {
  process.stderr.write(result.stderr || `${result.error?.message || 'Autolinking command failed.'}\n`);
  process.exit(result.status || 1);
}

// Expo resolves junctions to real paths; keep native build paths on the ASCII alias.
function mapPaths(value) {
  if (typeof value === 'string') {
    for (const separator of ['\\', '/']) {
      const prefix = canonicalRoot.replaceAll('\\', separator);
      if (value === prefix || value.startsWith(`${prefix}${separator}`)) {
        return aliasRoot.replaceAll('\\', separator) + value.slice(prefix.length);
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(mapPaths);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapPaths(item)]));
  }
  return value;
}

process.stdout.write(JSON.stringify(mapPaths(JSON.parse(result.stdout))));
