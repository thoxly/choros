// T-0192 · shared migrations-hash helper
//
// Computes SHA-256 over sorted migration filenames+contents → first 8 hex chars.
// Used by:
//   ci/checks/db/globalSetup.ts   (vitest globalSetup)
//   scripts/db-setup-template.ts  (npm run fitness:db:setup-template)
//   scripts/db-cleanup-orphans.ts (npm run fitness:db:cleanup-orphans)
//
// Only Node builtins (node:crypto, node:fs, node:path) — no production deps.
// FF-T147-3 contract: globalSetup.ts must not import src/ modules; this file
// satisfies that constraint (zero src/ imports).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Compute SHA-256 over sorted migration filenames+contents → first 8 hex chars.
 *
 * The hash is deterministic across machines and checkouts:
 * - Only ASCII filenames (pattern ^\d{3,}_[A-Za-z0-9_]+\.sql$) → locale-independent sort.
 * - Hash covers both filename and content → rename or edit changes the hash.
 *
 * Known limitation: 8 hex chars = 32-bit address space; birthday-problem collision
 * probability for 10 branches ≈ 1.2×10⁻⁸ (negligible for MVP team size).
 * If two branches have different migration sets but collide on hash, they will share
 * a template with the wrong schema — tests will fail clearly (FK/type errors).
 */
export function computeMigrationsHash(repoRoot: string): string {
  const migrationsDir = join(repoRoot, 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{3,}_[A-Za-z0-9_]+\.sql$/.test(f))
    .sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update(readFileSync(join(migrationsDir, f)));
  }
  return h.digest('hex').slice(0, 8);
}
