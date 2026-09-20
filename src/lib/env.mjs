// Credentials, read from one place.
//
// A KEY=VALUE file at the project root, gitignored. Only variables that are not
// already set get filled, so an explicit shell export always wins over the
// file — which is what lets CI supply a key without editing anything.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './brand.mjs';

export const ENV_FILE = path.join(ROOT, '.env');

export function loadEnv(file = ENV_FILE) {
  if (!fs.existsSync(file)) return [];

  const loaded = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!key || !value) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
