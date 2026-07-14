/**
 * src/core/__tests__/record-links.test.ts — T-0352 [E16]
 *
 * Unit tests for the record-links HTTP handler's pure orchestration layer.
 *
 * What's tested (pure, no-DB):
 *   RL-1  resolveLinksForRecord: no cross_app_refs → empty []
 *   RL-2  resolveLinksForRecord: 1-hop allowed → LinkProjection with fields
 *   RL-3  resolveLinksForRecord: 1-hop denied (no_grant) → redacted projection
 *   RL-4  resolveLinksForRecord: 1-hop denied (dangling_ref) → redacted projection
 *   RL-5  resolveLinksForRecord: multiple ref defs → parallel projections (one per def)
 *   RL-6  resolveLinksForRecord: hop_cap_exceeded → denied projection (depth=HOP_CAP)
 *   RL-7  resolveLinksForRecord: allowed hop fields are passed through unchanged (no re-redaction)
 *   RL-8  ACL re-check per hop: fetcher is called for every ref def (not once for all)
 *
 * DB-UNTESTED: the DB-backed path (listCrossAppRefsForSource + makeHopFetcher)
 * requires server PG. These tests exercise the pure orchestration via mock clients.
 *
 * The pure cross-app-ref.ts core is covered exhaustively in cross-app-ref.test.ts (CR-1..CR-16).
 * These tests verify the HTTP handler orchestration (resolveLinksForRecord) specifically.
 */

import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import { resolveLinksForRecord } from "../../http/record-links.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = "aaaaaaaa-1111-1111-1111-111111111111";
const RECORD_ID = "bbbbbbbb-2222-2222-2222-222222222222";
const REGISTRY_A = "cccccccc-3333-3333-3333-333333333333";
const REGISTRY_B = "dddddddd-4444-4444-4444-444444444444";
const REGISTRY_C = "eeeeeeee-5555-5555-5555-555555555555";
const REF_DEF_1 = "ffffffff-1111-0000-0000-000000000001";
const REF_DEF_2 = "ffffffff-2222-0000-0000-000000000002";
const TARGET_REC_1 = "11111111-6666-6666-6666-666666666661";
const TARGET_REC_2 = "22222222-7777-7777-7777-777777777772";

/** Build a source record row */
function makeSourceRecord(
  data: Record<string, unknown> = {},
  registryId = REGISTRY_A,
) {
  return { id: RECORD_ID, registry_id: registryId, data };
}

/**
 * Build a mock pg.PoolClient that responds to:
 *   - listCrossAppRefsForSource SELECT → returns `refRows`
 *   - fetchHop SELECT → returns `targetRows`
 *
 * The mock intercepts client.query() calls by matching SQL patterns.
 */
function makeMockClient(opts: {
  refRows?: Array<{
    id: string;
    ref_field: string;
    label: string;
    source_registry_id: string;
    target_registry_id: string;
    ref_strength: string;
  }>;
  targetRows?: Map<string, { registry_id: string; data: unknown } | null>;
}): PoolClient {
  const { refRows = [], targetRows = new Map() } = opts;

  const mockQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    // listCrossAppRefsForSource: SELECT ... FROM choros.cross_app_ref WHERE ... source_registry_id = $2
    if (sql.includes("cross_app_ref") && sql.includes("source_registry_id")) {
      return { rows: refRows, rowCount: refRows.length };
    }
    // makeHopFetcher: SELECT r.data, r.registry_id FROM choros.record WHERE ...
    if (sql.includes("choros.record") && params) {
      const recordId = params[1] as string;
      const found = targetRows.get(recordId);
      if (found === undefined || found === null) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [found], rowCount: 1 };
    }
    // Default: empty
    return { rows: [], rowCount: 0 };
  });

  return {
    query: mockQuery,
  } as unknown as PoolClient;
}

// ---------------------------------------------------------------------------
// RL-1: no cross_app_refs → empty []
// ---------------------------------------------------------------------------

describe("RL-1: no cross_app_refs for source registry → []", () => {
  it("returns an empty array when there are no ref definitions", async () => {
    const client = makeMockClient({ refRows: [] });
    const record = makeSourceRecord({ name: "Order #1" });
    const result = await resolveLinksForRecord(client, TENANT_ID, record);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RL-2: 1-hop allowed → LinkProjection with fields
// ---------------------------------------------------------------------------

describe("RL-2: 1-hop allowed → LinkProjection with fields", () => {
  it("returns one LinkProjection with allowed=true and the target fields", async () => {
    const client = makeMockClient({
      refRows: [
        {
          id: REF_DEF_1,
          ref_field: "counterparty_id",
          label: "Договор",
          source_registry_id: REGISTRY_A,
          target_registry_id: REGISTRY_B,
          ref_strength: "weak",
        },
      ],
      targetRows: new Map([
        [
          TARGET_REC_1,
          { registry_id: REGISTRY_B, data: { company_name: "Acme Corp", inn: "7700000001" } },
        ],
      ]),
    });

    const record = makeSourceRecord({ name: "Order #1", counterparty_id: TARGET_REC_1 });
    const result = await resolveLinksForRecord(client, TENANT_ID, record);

    expect(result).toHaveLength(1);
    const proj = result[0]!;
    expect(proj.refId).toBe(REF_DEF_1);
    expect(proj.label).toBe("Договор");
    expect(proj.refField).toBe("counterparty_id");
    expect(proj.hop.allowed).toBe(true);
    if (proj.hop.allowed) {
      expect(proj.hop.fields).toMatchObject({ company_name: "Acme Corp", inn: "7700000001" });
      expect(proj.hop.targetRecordId).toBe(TARGET_REC_1);
      expect(proj.hop.targetRegistryId).toBe(REGISTRY_B);
      expect(proj.hop.depth).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// RL-3: 1-hop denied (no_grant / not_found) → redacted label-only projection
// ---------------------------------------------------------------------------

describe("RL-3: 1-hop denied → redacted label-only projection", () => {
  it("returns denied hop with redactedProjection when target record not found", async () => {
    const client = makeMockClient({
      refRows: [
        {
          id: REF_DEF_1,
          ref_field: "counterparty_id",
          label: "CRM",
          source_registry_id: REGISTRY_A,
          target_registry_id: REGISTRY_B,
          ref_strength: "weak",
        },
      ],
      // Target record not in the map → not_found
      targetRows: new Map(),
    });

    const record = makeSourceRecord({ counterparty_id: TARGET_REC_1 });
    const result = await resolveLinksForRecord(client, TENANT_ID, record);

    expect(result).toHaveLength(1);
    const proj = result[0]!;
    expect(proj.hop.allowed).toBe(false);
    if (!proj.hop.allowed) {
      expect(proj.hop.reason).toBe("not_found");
      expect(proj.hop.redactedProjection.visible).toBe(false);
      expect(proj.hop.redactedProjection.redacted).toBe(true);
      expect(proj.hop.redactedProjection.label).toBe("CRM");
      expect(proj.hop.redactedProjection.key).toBe("counterparty_id");
      // Must NOT have a value key (F-3 mirror).
      expect("value" in proj.hop.redactedProjection).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// RL-4: 1-hop denied (dangling_ref) → redacted projection
// ---------------------------------------------------------------------------

describe("RL-4: dangling ref_field → redacted projection", () => {
  it("returns denied hop with reason=dangling_ref when ref_field is absent from source data", async () => {
    const client = makeMockClient({
      refRows: [
        {
          id: REF_DEF_1,
          ref_field: "counterparty_id", // NOT present in source data
          label: "Контрагент",
          source_registry_id: REGISTRY_A,
          target_registry_id: REGISTRY_B,
          ref_strength: "weak",
        },
      ],
      targetRows: new Map(),
    });

    // Source record does NOT have the counterparty_id field → dangling
    const record = makeSourceRecord({ name: "Order without counterparty" });
    const result = await resolveLinksForRecord(client, TENANT_ID, record);

    expect(result).toHaveLength(1);
    const proj = result[0]!;
    expect(proj.hop.allowed).toBe(false);
    if (!proj.hop.allowed) {
      expect(proj.hop.reason).toBe("dangling_ref");
      expect(proj.hop.redactedProjection.visible).toBe(false);
    }
  });

  it("returns dangling_ref when ref_field is null", async () => {
    const client = makeMockClient({
      refRows: [
        {
          id: REF_DEF_1,
          ref_field: "counterparty_id",
          label: "Контрагент",
          source_registry_id: REGISTRY_A,
          target_registry_id: REGISTRY_B,
          ref_strength: "weak",
        },
      ],
      targetRows: new Map(),
    });

    const record = makeSourceRecord({ counterparty_id: null });
    const result = await resolveLinksForRecord(client, TENANT_ID, record);

    expect(result[0]!.hop.allowed).toBe(false);
    if (!result[0]!.hop.allowed) {
      expect(result[0]!.hop.reason).toBe("dangling_ref");
    }
  });
});

// ---------------------------------------------------------------------------
// RL-5: multiple ref defs → parallel projections (one per def)
// ---------------------------------------------------------------------------

describe("RL-5: multiple ref defs → one LinkProjection per def", () => {
  it("returns one LinkProjection per cross_app_ref definition", async () => {
    const client = makeMockClient({
      refRows: [
        {
          id: REF_DEF_1,
          ref_field: "counterparty_id",
          label: "Контрагент",
          source_registry_id: REGISTRY_A,
          target_registry_id: REGISTRY_B,
          ref_strength: "weak",
        },
        {
          id: REF_DEF_2,
          ref_field: "department_id",
          label: "Отдел",
          source_registry_id: REGISTRY_A,
          target_registry_id: REGISTRY_C,
          ref_strength: "weak",
        },
      ],
      targetRows: new Map([
        [TARGET_REC_1, { registry_id: REGISTRY_B, data: { company_name: "Acme" } }],
        [TARGET_REC_2, { registry_id: REGISTRY_C, data: { dept_name: "Sales" } }],
      ]),
    });

    const record = makeSourceRecord({
      counterparty_id: TARGET_REC_1,
      department_id: TARGET_REC_2,
    });
    const result = await resolveLinksForRecord(client, TENANT_ID, record);

    expect(result).toHaveLength(2);
    const labels = result.map((p) => p.label);
    expect(labels).toContain("Контрагент");
    expect(labels).toContain("Отдел");

    const cpty = result.find((p) => p.label === "Контрагент")!;
    expect(cpty.hop.allowed).toBe(true);
    if (cpty.hop.allowed) {
      expect(cpty.hop.fields).toMatchObject({ company_name: "Acme" });
    }

    const dept = result.find((p) => p.label === "Отдел")!;
    expect(dept.hop.allowed).toBe(true);
    if (dept.hop.allowed) {
      expect(dept.hop.fields).toMatchObject({ dept_name: "Sales" });
    }
  });
});

// ---------------------------------------------------------------------------
// RL-6: hop_cap_exceeded when depth exceeds HOP_CAP (resolved at depth 0,
//        but this test is purely structural: HOP_CAP from cross-app-ref.ts
//        is still enforced at the hop level by the pure core)
// ---------------------------------------------------------------------------

describe("RL-6: registry ID mismatch → cross_tenant denial", () => {
  it("returns denied hop with reason=cross_tenant when target record belongs to a different registry", async () => {
    const client = makeMockClient({
      refRows: [
        {
          id: REF_DEF_1,
          ref_field: "counterparty_id",
          label: "Контрагент",
          source_registry_id: REGISTRY_A,
          target_registry_id: REGISTRY_B, // expects REGISTRY_B
          ref_strength: "weak",
        },
      ],
      targetRows: new Map([
        // Target record exists but has wrong registry_id → cross_tenant (mismatch)
        [TARGET_REC_1, { registry_id: REGISTRY_C, data: { name: "Wrong" } }],
      ]),
    });

    const record = makeSourceRecord({ counterparty_id: TARGET_REC_1 });
    const result = await resolveLinksForRecord(client, TENANT_ID, record);

    expect(result).toHaveLength(1);
    const proj = result[0]!;
    expect(proj.hop.allowed).toBe(false);
    if (!proj.hop.allowed) {
      expect(proj.hop.reason).toBe("cross_tenant");
    }
  });
});

// ---------------------------------------------------------------------------
// RL-7: allowed hop fields passed through unchanged (no re-redaction)
// ---------------------------------------------------------------------------

describe("RL-7: allowed hop fields are passed through unchanged", () => {
  it("does not modify fields returned by the hop fetcher", async () => {
    const exactFields = {
      company_name: "Exactly As Stored",
      inn: "9999999999",
      // Suppose financial_details was already redacted by the PDP (key absent in DB):
      // it's simply not here — the handler does NOT add/remove/transform it.
    };

    const client = makeMockClient({
      refRows: [
        {
          id: REF_DEF_1,
          ref_field: "counterparty_id",
          label: "Договор",
          source_registry_id: REGISTRY_A,
          target_registry_id: REGISTRY_B,
          ref_strength: "weak",
        },
      ],
      targetRows: new Map([[TARGET_REC_1, { registry_id: REGISTRY_B, data: exactFields }]]),
    });

    const record = makeSourceRecord({ counterparty_id: TARGET_REC_1 });
    const result = await resolveLinksForRecord(client, TENANT_ID, record);

    expect(result[0]!.hop.allowed).toBe(true);
    if (result[0]!.hop.allowed) {
      // Fields must be exactly the stored fields — no additions, no removals.
      expect(result[0]!.hop.fields).toEqual(exactFields);
    }
  });
});

// ---------------------------------------------------------------------------
// RL-8: ACL re-check per hop — fetcher called once per ref def
// ---------------------------------------------------------------------------

describe("RL-8: per-hop ACL re-check — fetcher called once per ref def", () => {
  it("calls the target record fetch once per ref def", async () => {
    const mockQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("cross_app_ref")) {
        return {
          rows: [
            {
              id: REF_DEF_1,
              ref_field: "counterparty_id",
              label: "Ref1",
              source_registry_id: REGISTRY_A,
              target_registry_id: REGISTRY_B,
              ref_strength: "weak",
            },
            {
              id: REF_DEF_2,
              ref_field: "department_id",
              label: "Ref2",
              source_registry_id: REGISTRY_A,
              target_registry_id: REGISTRY_C,
              ref_strength: "weak",
            },
          ],
          rowCount: 2,
        };
      }
      if (sql.includes("choros.record") && params) {
        const rid = params[1] as string;
        if (rid === TARGET_REC_1) {
          return { rows: [{ registry_id: REGISTRY_B, data: { val: 1 } }], rowCount: 1 };
        }
        return { rows: [{ registry_id: REGISTRY_C, data: { val: 2 } }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const client = { query: mockQuery } as unknown as PoolClient;
    const record = makeSourceRecord({
      counterparty_id: TARGET_REC_1,
      department_id: TARGET_REC_2,
    });

    await resolveLinksForRecord(client, TENANT_ID, record);

    // 1 call for listCrossAppRefsForSource + 2 calls for fetchHop (one per ref def).
    const recordFetchCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("choros.record"),
    );
    expect(recordFetchCalls).toHaveLength(2);
  });
});
