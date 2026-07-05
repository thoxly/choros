/**
 * src/__tests__/process-catalog-view.test.ts — T-0270
 *
 * Unit tests for the pure catalog view logic (src/core/process-catalog-view.ts).
 * No DB, no I/O — exercises the honesty core: a definition appears ONLY if it has a
 * real source (modeler row or real instance), nothing fabricated, empty→empty.
 */

import { describe, it, expect } from "vitest";
import {
  buildCatalogDefinitions,
  serializeInstance,
  fallbackDefinitionName,
  type ProcessDefRow,
  type ProjectionLike,
} from "../core/process-catalog-view.js";

function def(partial: Partial<ProcessDefRow> & { process_key: string }): ProcessDefRow {
  return {
    name: partial.name ?? partial.process_key,
    version: partial.version ?? 1,
    status: partial.status ?? "draft",
    deployment_id: partial.deployment_id ?? null,
    updated_at: partial.updated_at ?? 0,
    process_key: partial.process_key,
  };
}

function proj(partial: Partial<ProjectionLike> & { inst: string; procKey: string }): ProjectionLike {
  return {
    role: partial.role ?? "role-approver",
    step: partial.step ?? "Согласование",
    status: partial.status ?? "waiting",
    startedAt: partial.startedAt ?? 1000,
    inst: partial.inst,
    procKey: partial.procKey,
  };
}

describe("buildCatalogDefinitions — honesty core", () => {
  it("empty inputs → empty output (graceful-empty, no fabrication)", () => {
    expect(buildCatalogDefinitions([], [])).toEqual([]);
  });

  it("surfaces a modeler definition with its status/version + zero instances", () => {
    const out = buildCatalogDefinitions(
      [def({ process_key: "purchase-approval", name: "Согласование закупки", status: "published", version: 3 })],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      process_key: "purchase-approval",
      name: "Согласование закупки",
      source: "modeler",
      status: "published",
      version: 3,
      instance_count: 0,
    });
  });

  it("surfaces an engine-only key (Flowable-deployed telLinear, no modeler row) from REAL instances", () => {
    const out = buildCatalogDefinitions(
      [],
      [proj({ inst: "flw-1", procKey: "telLinear" }), proj({ inst: "flw-2", procKey: "telLinear" })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      process_key: "telLinear",
      // T-0616 [F-2]: no modeler row → the honest fallback is the key itself,
      // not the special-cased case-literal display name.
      name: "telLinear",
      source: "engine",
      status: "deployed",
      version: null,
      instance_count: 2,
    });
  });

  it("a modeler row takes precedence over the engine source for the same key, but keeps the real instance count", () => {
    const out = buildCatalogDefinitions(
      [def({ process_key: "telLinear", name: "Modeler ТЭЛ", status: "draft", version: 1 })],
      [proj({ inst: "flw-1", procKey: "telLinear" })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      process_key: "telLinear",
      name: "Modeler ТЭЛ",
      source: "modeler",
      instance_count: 1,
    });
  });

  it("returns a deterministic order sorted by process_key", () => {
    const out = buildCatalogDefinitions(
      [def({ process_key: "zeta" }), def({ process_key: "alpha" })],
      [proj({ inst: "i1", procKey: "mid" })],
    );
    expect(out.map((d) => d.process_key)).toEqual(["alpha", "mid", "zeta"]);
  });
});

describe("serializeInstance", () => {
  it("maps a projection to the catalog instance wire shape", () => {
    const out = serializeInstance(
      proj({ inst: "flw-9", procKey: "telLinear", status: "done", step: "Завершено", role: "role-approver", startedAt: 42 }),
    );
    expect(out).toEqual({
      inst: "flw-9",
      process_key: "telLinear",
      status: "done",
      step: "Завершено",
      role: "role-approver",
      started_at: 42,
    });
  });
});

describe("fallbackDefinitionName", () => {
  // T-0616 [F-2, D-064 анти-кейс fix]: this used to special-case "telLinear" to
  // the display literal "Канонический линейный ТЭЛ" (a micro-case-hardcode —
  // review T-0614 F-2). Removed: EVERY key, including "telLinear", now echoes
  // back honestly — no key gets a borrowed display name it did not earn from a
  // real choros.process_definition row.
  it("echoes the key back verbatim for ANY unnamed process, no key special-cased", () => {
    expect(fallbackDefinitionName("telLinear")).toBe("telLinear");
    expect(fallbackDefinitionName("some-other")).toBe("some-other");
  });
});
