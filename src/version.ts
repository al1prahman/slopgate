import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from package.json at import time — the version lives in exactly
// one place. (It used to be a hardcoded literal "kept in sync at release
// time"; 1.0.0 shipped with a stale 0.1.0 baked in, which is how that goes.)
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
  version: string;
};

export const SLOPGATE_VERSION: string = pkg.version;
