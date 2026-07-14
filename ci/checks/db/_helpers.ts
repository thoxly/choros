// Shared helpers for the T-0053 live Postgres probes (run only in the `db` CI
// job and locally against the compose Postgres). Zero-dep beyond `pg`.
//
// DATABASE_URL resolves to choros_migrator (owner/DDL/runner). The app role
// (choros_app) URL is derived by swapping the user/password — or supplied
// explicitly via APP_DATABASE_URL.

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { Client } = pg;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

export const KNOWN_TENANT_TABLES: string[] = readFileSync(
  join(REPO_ROOT, 'ci', 'checks', 'known_tenant_tables.txt'),
  'utf8',
)
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

export function migratorUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set (must resolve to choros_migrator)');
  return url;
}

/** Derive the choros_app connection URL from the migrator URL (swap creds). */
export function appUrl(): string {
  if (process.env.APP_DATABASE_URL) return process.env.APP_DATABASE_URL;
  const u = new URL(migratorUrl());
  u.username = 'choros_app';
  u.password = process.env.CHOROS_APP_PASSWORD || 'choros_app_dev_pw';
  return u.toString();
}

export async function withClient<T>(
  url: string,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SET search_path TO choros;');
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Two stable tenant UUIDs for cross-tenant tests. */
export const TENANT_A = '11111111-1111-1111-1111-111111111111';
export const TENANT_B = '22222222-2222-2222-2222-222222222222';

/** A fresh random uuid (for row ids in seeds). */
export function uuid(): string {
  return crypto.randomUUID();
}
