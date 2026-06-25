/**
 * src/__tests__/agent-taxonomy-093.test.ts — T-0473 (E-AGENTS L1)
 *
 * Two layers, both no-DB:
 *
 *  (1) Static shape assertions on migration 093 (mirrors the
 *      agent-card-kc-client-id-global-unique.test.ts strategy): read the SQL and
 *      assert the structure of the agent_type discriminator + the employee_id /
 *      partial-FK decoupling. The CI db job applies the migration against live
 *      Postgres and exercises the runtime behavior (org-less insert allowed,
 *      bad-kind rejected) in ci/checks/db; these static checks guard the
 *      migration's SHAPE so it can never silently regress to a no-op.
 *
 *  (2) serializeAgent unit behavior: org-attached vs org-less agents map to the
 *      right public shape (id addressing, has_org_place, agent_type, kc_client_id
 *      fallback for slug/display_name).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { serializeAgent } from "../http/agents-list.js";

const MIGRATION_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../migrations/093_agent_taxonomy_employee_nullable.sql",
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

describe("T-0473 migration 093 — agent_type taxonomy + employee_id NULLable", () => {
  it("migration file exists", () => {
    expect(fs.existsSync(MIGRATION_PATH), `expected ${MIGRATION_PATH} to exist`).toBe(true);
  });

  it("adds agent_type NOT NULL DEFAULT 'workforce' with a CHECK over the 3 types", () => {
    const body = sqlBody(readMigration());
    expect(body).toMatch(/ADD COLUMN IF NOT EXISTS agent_type text NOT NULL DEFAULT 'workforce'/i);
    expect(body).toContain("agent_card_agent_type_chk");
    expect(body).toMatch(/agent_type IN \('workforce', 'system', 'assistant'\)/);
  });

  it("backfills the platform seeds (config/implementation/docs) to 'system'", () => {
    const body = sqlBody(readMigration());
    expect(body).toMatch(/SET agent_type = 'system'/);
    expect(body).toContain("'agent-config'");
    expect(body).toContain("'agent-implementation'");
    expect(body).toContain("'agent-docs-author'");
  });

  it("makes employee_id (and its discriminator) NULLable", () => {
    const body = sqlBody(readMigration());
    expect(body).toMatch(/ALTER COLUMN employee_id\s+DROP NOT NULL/i);
    expect(body).toMatch(/ALTER COLUMN employee_kind\s+DROP NOT NULL/i);
  });

  it("keeps the FK a partial discriminator — kind='agent' enforced ONLY when employee_id is set", () => {
    const body = sqlBody(readMigration());
    // The composite employee FK is NOT dropped (it stays MATCH SIMPLE = skipped on
    // NULL employee_id), and the relaxed CHECK permits a NULL employee_kind.
    expect(body).not.toMatch(/DROP CONSTRAINT agent_card_employee_fk/i);
    expect(body).toMatch(/employee_kind IS NULL OR employee_kind = 'agent'/);
    // employee_id and employee_kind move together (pair invariant).
    expect(body).toMatch(/\(employee_id IS NULL\) = \(employee_kind IS NULL\)/);
  });

  it("re-keys to a surrogate (tenant_id, id) so the registry id is org-independent", () => {
    const body = sqlBody(readMigration());
    expect(body).toMatch(/ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid\(\)/i);
    expect(body).toMatch(/PRIMARY KEY \(tenant_id, id\)/i);
    // and preserves "at most one card per employee" via a partial unique.
    expect(body).toMatch(/agent_card_tenant_employee_uq/);
    expect(body).toMatch(/WHERE employee_id IS NOT NULL/);
  });

  it("is the next free migration slot (093) and adds no new relation", () => {
    const body = sqlBody(readMigration());
    expect(path.basename(MIGRATION_PATH)).toMatch(/^093_/);
    expect(body).not.toMatch(/CREATE TABLE/i);
  });
});

describe("T-0473 serializeAgent — org-attached vs org-less", () => {
  const base = {
    kc_client_id: "agent-config",
    llm_endpoint: null,
    llm_model: null,
    llm_secret_handle: null,
    position_title: null,
    department_name: null,
  };

  it("addresses a workforce (org-attached) agent by employee_id", () => {
    const out = serializeAgent({
      ...base,
      agent_card_id: "card-uuid-1",
      employee_id: "emp-uuid-1",
      agent_type: "workforce",
      slug: "recon-bot",
      display_name: "Сверка-агент",
      kc_client_id: "agent-recon",
      position_title: "Контролёр",
      department_name: "Финансы",
    });
    expect(out.id).toBe("emp-uuid-1"); // employee_id, not the surrogate
    expect(out.has_org_place).toBe(true);
    expect(out.agent_type).toBe("workforce");
    expect(out.position).toBe("Контролёр");
    expect(out.department).toBe("Финансы");
  });

  it("addresses an org-less (system/assistant) agent by its surrogate id, falls back to kc_client_id", () => {
    const out = serializeAgent({
      ...base,
      agent_card_id: "card-uuid-2",
      employee_id: null,
      agent_type: "assistant",
      slug: null,
      display_name: null,
      kc_client_id: "tenant-assistant",
    });
    expect(out.id).toBe("card-uuid-2"); // surrogate, since no employee_id
    expect(out.has_org_place).toBe(false);
    expect(out.agent_type).toBe("assistant");
    expect(out.slug).toBe("tenant-assistant"); // kc_client_id fallback
    expect(out.display_name).toBe("tenant-assistant");
    expect(out.position).toBeNull();
    expect(out.department).toBeNull();
  });

  it("never leaks the raw secret handle — only llm_bound", () => {
    const out = serializeAgent({
      ...base,
      agent_card_id: "card-uuid-3",
      employee_id: "emp-uuid-3",
      agent_type: "workforce",
      slug: "x",
      display_name: "X",
      llm_secret_handle: "vault://secret/should-never-appear",
    });
    expect(out.llm_bound).toBe(true);
    expect(JSON.stringify(out)).not.toContain("should-never-appear");
  });
});
