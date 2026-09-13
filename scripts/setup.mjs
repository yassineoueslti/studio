/**
 * One-command first-time setup: create services/migration/.env from the
 * example and generate a real credential-encryption key into it.
 *
 * The documented setup was three manual steps -- copy a file, run `openssl rand
 * -base64 32`, paste the result into the right line of the right file. Each is
 * a place to go wrong, and the openssl step simply does not exist on a stock
 * Windows machine, which is where a good number of people start.
 *
 * Safe to re-run: an existing .env is never overwritten, because it holds
 * working credentials and a key that already encrypted data. Losing that key
 * means losing every credential encrypted with it.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const example = join(repoRoot, '.env.example');
const target = join(repoRoot, 'services', 'migration', '.env');

if (existsSync(target)) {
  console.log(`Already set up: ${target}`);
  console.log('Nothing changed. Delete that file first if you want to start over.');
  console.log('(It holds your encryption key -- anything already encrypted with it');
  console.log(' becomes unreadable once it is gone.)');
  process.exit(0);
}

if (!existsSync(example)) {
  console.error(`Cannot find ${example}. Run this from a complete checkout.`);
  process.exit(1);
}

copyFileSync(example, target);

// 32 bytes, because that is what AES-256-GCM takes and what config.ts checks
// for at startup.
const key = randomBytes(32).toString('base64');
const text = readFileSync(target, 'utf8');

if (!/^MIGRATION_SECRET_KEY=\s*$/m.test(text)) {
  console.error('.env.example no longer has an empty MIGRATION_SECRET_KEY line to fill in.');
  process.exit(1);
}

writeFileSync(target, text.replace(/^MIGRATION_SECRET_KEY=\s*$/m, `MIGRATION_SECRET_KEY=${key}`));

console.log('Created services/migration/.env');
console.log('Generated a 32-byte MIGRATION_SECRET_KEY.');
console.log('');
console.log('This file is git-ignored and must stay that way -- it holds secrets.');
console.log('');
console.log('Next:');
console.log('  docker compose up -d postgres');
console.log('  pnpm db:migrate');
console.log('  pnpm test');
