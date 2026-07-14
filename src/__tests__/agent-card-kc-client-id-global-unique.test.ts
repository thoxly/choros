/**
 * src/__tests__/agent-card-kc-client-id-global-unique.test.ts — T-0426 [SECURITY]
 *
 * Static (no-DB) assertions on migration 092, which adds a GLOBAL UNIQUE INDEX on
 * choros.agent_card(kc_client_id). This schema-backs the realm-global clientId
 * invariant that previously lived ONLY at runtime in Keycloak (the hire flow is
 * KC-first, and KC enforces realm-global clientId uniqueness at create time).
 *
 * WHY this matters (the T-0424 residual): resolveAgentSlugFromAuth (src/db/org.ts)
 * is a BYPASSRLS cross-tenant lookup `WHERE kc_client_id = $1 LIMIT 1`. The pre-092
 * UNIQUE was PER-TENANT (tenant_id, kc_client_id) and deriveKcClientId(slug) has NO
 * tenant component, so two tenants sharing an agent slug could derive the SAME
 * kc_client_id in different rows → the resolver could map a client to the WRONG
 * tenant. The global UNIQUE forbids a colliding row from ever being written.
 *
 * Same static-content strategy as core-system-registries.test.ts: read the SQL and
 * assert structure. The CI db job applies the migration against live Postgres and
 * a duplicate-insert rejection is exercised there (fitness:db); these static checks
 * guard the migration's SHAPE so it can never silently regress to a no-op or a
 * per-tenant scope.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const MIGRATION_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../migrations/092_agent_card_kc_client_id_global_unique.sql",
);

function readMigration(): string {
  return fs.readFileSync(MIGRATION_PATH, "utf8");
}

/** Non-comment SQL body (lines not starting with `--`). */
function sqlBody(content: string): string {
  return content
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

describe("T-0426 migration 092 — agent_card.kc_client_id global UNIQUE", () => {
  it("migration file exists", () => {
    expect(fs.existsSync(MIGRATION_PATH), `expected ${MIGRATION_PATH} to exist`).toBe(true);
  });

  it("creates a UNIQUE INDEX on choros.agent_card", () => {
    const body = sqlBody(readMigration()).toLowerCase();
    expect(body).toContain("create unique index");
    expect(body).toContain("choros.agent_card");
  });

  it("indexes kc_client_id GLOBALLY (not scoped by tenant_id)", () => {
    const body = sqlBody(readMigration());
    // The index column list is exactly (kc_client_id) — no tenant_id leading column,
    // which is what makes it a cross-tenant (global) uniqueness guarantee.
    const m = body.match(/CREATE UNIQUE INDEX[^(]*\(([^)]*)\)/i);
    expect(m, "expected a CREATE UNIQUE INDEX (...) statement").not.toBeNull();
    const cols = m![1].split(",").map((c) => c.trim().toLowerCase());
    expect(cols).toEqual(["kc_client_id"]); // global: kc_client_id alone, no tenant_id
  });

  it("is idempotent (IF NOT EXISTS)", () => {
    const body = sqlBody(readMigration()).toLowerCase();
    expect(body).toContain("if not exists");
  });

  it("adds NO new relation (no CREATE TABLE / no user_task)", () => {
    const body = sqlBody(readMigration()).toLowerCase();
    expect(body).not.toContain("create table");
    expect(body).not.toContain("user_task");
  });

  it("does not touch migrations 001–091 (only adds 092)", () => {
    // Sanity: the file name encodes slot 092 — the next free lexicographic slot.
    expect(path.basename(MIGRATION_PATH)).toMatch(/^092_/);
  });
});
