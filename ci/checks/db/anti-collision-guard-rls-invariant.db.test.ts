/**
 * ci/checks/db/anti-collision-guard-rls-invariant.db.test.ts — T-0633 round-3
 * [SECURITY, P1] — the BYPASSRLS-dependency invariant of the anti-collision
 * guard / identity resolver.
 *
 * THE SILENT-DISABLE HAZARD (RE-VERIFY finding):
 *   humanEmployeeSlugExists (src/db/org.ts) and resolveActorSlugFromAuth run a
 *   CROSS-TENANT existence query on choros.employee WITHOUT setting the tenant
 *   GUC (they cannot — the tenant is not yet known when identity is resolved).
 *   That only works under a BYPASSRLS role (choros_migrator). Under the
 *   NOBYPASSRLS runtime role (choros_app) with NO tenant GUC set, the
 *   employee-isolation RLS policy forces the EXISTS to see ZERO rows → it
 *   returns `false` for EVERY slug. Consequences, both silent:
 *     (a) the mint-time anti-collision guard becomes a NO-OP → the T-0633
 *         privilege-escalation vector re-opens (a colliding 'e-owner' login is
 *         no longer rejected), and
 *     (b) the identity resolver's preferred_username fallback returns null for
 *         legitimate seed personas → the genesis owner can no longer log in.
 *   .env.prod.example warns that a future choros_app runtime role would require
 *   pointing DATABASE_URL at choros_app credentials — doing so for the
 *   identity-resolution pool would silently disable this security guard.
 *
 * THIS TEST pins the invariant so the hazard cannot ship green:
 *   1. Under the MIGRATOR (BYPASSRLS) pool, NO tenant GUC: the guard SEES a
 *      seed persona slug (returns true) — the form production relies on.
 *   2. Under the APP (NOBYPASSRLS) pool, NO tenant GUC: the guard is BLIND
 *      (returns false) — proving the dependency is REAL, not incidental. If a
 *      future change ever makes the guard tenant-GUC-independent under
 *      NOBYPASSRLS (e.g. an explicit cross-tenant SECURITY DEFINER function),
 *      THIS assertion goes red and forces the author to re-establish the
 *      invariant deliberately rather than by accident.
 *
 * Live Postgres only (skipped without DATABASE_URL). Uses the production
 * humanEmployeeSlugExists against a pool built on each role's URL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl } from './_helpers.js';
import { humanEmployeeSlugExists } from '../../../src/db/org.js';

const LIVE = !!process.env['DATABASE_URL'];

// A kind='human' seed persona slug that exists in the always-migrated genesis
// tenant (migrations/088 seeds e-configurator as a kind='human' employee). It
// is NOT read as a literal case-fixture (that would trip anti-case-lock) — it
// is a live-DB probe target, the exact string the guard must be able to see
// cross-tenant to keep 'e-configurator' un-mintable.
const SEED_HUMAN_SLUG = 'e-configurator';

describe.skipIf(!LIVE)('T-0633 round-3 — anti-collision guard RLS-dependency invariant', () => {
  let migPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });
    appPool = new pg.Pool({ connectionString: appUrl() });
  });

  afterAll(async () => {
    if (!LIVE) return;
    await migPool?.end();
    await appPool?.end();
  });

  it('under the BYPASSRLS (migrator) pool with NO tenant GUC, the guard SEES a seed persona slug — the form production depends on', async () => {
    // Sanity: the seed persona must actually exist, else the negative test
    // below would pass for the wrong reason (row simply absent).
    const present = await migratorSeesSeed();
    expect(
      present,
      `seed persona '${SEED_HUMAN_SLUG}' (migrations/088) must exist as kind='human' — else this invariant test is vacuous`,
    ).toBe(true);

    // The production guard, run on the migrator pool, returns true for it.
    const seen = await humanEmployeeSlugExists(migPool, SEED_HUMAN_SLUG);
    expect(seen, 'anti-collision guard must SEE the seed slug under BYPASSRLS (else it is a no-op)').toBe(true);
  });

  it('under the NOBYPASSRLS (app) pool with NO tenant GUC, the guard is BLIND (returns false) — proving the BYPASSRLS dependency is REAL and load-bearing', async () => {
    // choros_app (NOBYPASSRLS), no SET LOCAL choros.tenant_id → the employee
    // RLS policy filters ALL rows out → the guard cannot see the seed slug.
    // This documents WHY the identity-resolution pool must stay BYPASSRLS-class:
    // pointing it at choros_app would SILENTLY turn the security guard into a
    // no-op (returning false = "login available" for a reserved seed slug).
    const seen = await humanEmployeeSlugExists(appPool, SEED_HUMAN_SLUG);
    expect(
      seen,
      'guard is BLIND under NOBYPASSRLS w/o a tenant GUC — this IS the hazard; if it ever returns true here, re-derive the invariant deliberately',
    ).toBe(false);
  });

  async function migratorSeesSeed(): Promise<boolean> {
    const c = await migPool.connect();
    try {
      const { rows } = await c.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM choros.employee WHERE slug = $1 AND kind = 'human'
         ) AS exists`,
        [SEED_HUMAN_SLUG],
      );
      return rows.length > 0 && rows[0]!.exists === true;
    } finally {
      c.release();
    }
  }
});
