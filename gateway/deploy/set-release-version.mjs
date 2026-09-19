import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [version, mode] = process.argv.slice(2);
if (!/^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(version ?? '')) throw new Error('Expected YYYY.MM.DD[.N]');
const root = new URL('../../', import.meta.url);
for (const name of ['burrow.mod.json', 'gateway/package.json', 'gateway/VERSION']) {
  const path = fileURLToPath(new URL(name, root));
  const raw = readFileSync(path, 'utf8');
  const json = name.endsWith('.json');
  const data = json ? JSON.parse(raw) : raw.trim();
  if (mode === '--check') {
    if ((json ? data.version : data) !== version) throw new Error(`${name}: release version mismatch`);
  } else {
    if (json) data.version = version;
    writeFileSync(path, json ? `${JSON.stringify(data, null, 2)}\n` : `${version}\n`);
  }
}
