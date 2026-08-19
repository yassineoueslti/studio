import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import type { AdapterCredentials } from '../adapters/types.js';

/**
 * Credential encryption at rest (Scope §46, Guide §19).
 *
 * AES-256-GCM: authenticated encryption, so a tampered ciphertext fails to
 * decrypt rather than yielding attacker-chosen plaintext. The auth tag is
 * stored beside the ciphertext.
 *
 * key_version is persisted with every row so a key rotation can re-wrap
 * existing credentials without a flag day (Scope §46: "credential rotation
 * capability").
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const CURRENT_KEY_VERSION = 1;

function resolveKey(): Buffer {
  const raw = config().MIGRATION_SECRET_KEY;
  if (!raw) {
    throw new Error(
      'MIGRATION_SECRET_KEY is not set. Source credentials cannot be encrypted at rest without it ' +
        '(Guide §19). Generate one with: openssl rand -base64 32',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.byteLength !== 32) {
    throw new Error(`MIGRATION_SECRET_KEY must decode to exactly 32 bytes, got ${key.byteLength}.`);
  }
  return key;
}

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export function seal(plaintext: string): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, resolveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: CURRENT_KEY_VERSION };
}

export function open(sealed: SealedSecret): string {
  const decipher = createDecipheriv(ALGORITHM, resolveKey(), sealed.iv);
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Persist a source credential. The plaintext is sealed before it reaches the
 * database and is never written anywhere else -- not to logs, not to an API
 * response, not into n8n workflow JSON (Scope §46).
 */
export async function storeCredential(input: {
  migrationSourceId: string;
  tenantId: string;
  credentialType: AdapterCredentials['type'];
  secret: AdapterCredentials;
  expiresAt?: Date | null;
}): Promise<string> {
  const sealed = seal(JSON.stringify(input.secret));
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO migration_credentials
       (migration_source_id, tenant_id, credential_type, ciphertext, iv, auth_tag, key_version, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      input.migrationSourceId, input.tenantId, input.credentialType,
      sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion, input.expiresAt ?? null,
    ],
  );
  return rows[0]?.id as string;
}

export async function loadCredential(tenantId: string, migrationSourceId: string): Promise<AdapterCredentials | null> {
  const { rows } = await getPool().query<{
    ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number; expires_at: Date | null;
  }>(
    `SELECT ciphertext, iv, auth_tag, key_version, expires_at
       FROM migration_credentials
      WHERE tenant_id = $1 AND migration_source_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, migrationSourceId],
  );

  const row = rows[0];
  if (!row) return null;

  const plaintext = open({
    ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyVersion: row.key_version,
  });
  return JSON.parse(plaintext) as AdapterCredentials;
}

/** Rotate to the current key version. Returns how many rows were re-wrapped. */
export async function rotateCredentials(tenantId: string): Promise<number> {
  const { rows } = await getPool().query<{
    id: string; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number;
  }>(
    'SELECT id, ciphertext, iv, auth_tag, key_version FROM migration_credentials WHERE tenant_id = $1 AND key_version < $2',
    [tenantId, CURRENT_KEY_VERSION],
  );

  let rotated = 0;
  for (const row of rows) {
    const plaintext = open({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyVersion: row.key_version });
    const resealed = seal(plaintext);
    await getPool().query(
      `UPDATE migration_credentials
          SET ciphertext = $2, iv = $3, auth_tag = $4, key_version = $5, rotated_at = now(), updated_at = now()
        WHERE id = $1`,
      [row.id, resealed.ciphertext, resealed.iv, resealed.authTag, resealed.keyVersion],
    );
    rotated += 1;
  }
  return rotated;
}

/** Constant-time comparison for API tokens, to avoid timing oracles. */
export function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.byteLength !== bufferB.byteLength) return false;
  return timingSafeEqual(bufferA, bufferB);
}
