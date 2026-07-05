/**
 * src/__tests__/form-document-ops-parity.test.ts  (T-0656)
 *
 * Runs the SHARED op vectors (src/core/__fixtures__/form-document-op-vectors.json)
 * through the SERVER ops (applyDocumentOp → src/core/form-document-ops.ts) and
 * asserts the documented results. The client JS ops assert the SAME fixture in
 * web/src/forms/form-document-ops-parity.test.js — so both tiers proving the same
 * fixture is mechanical proof the human canvas and the agent seam share ONE op
 * semantics (ADR-T0656 §4.2). Drift in either module → that tier goes red here.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyDocumentOp } from "../core/form-document-op-apply.js";
import { nodeAtPath, type FormDoc } from "../core/form-document-ops.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../core/__fixtures__/form-document-op-vectors.json"), "utf8"),
) as {
  baseDoc: FormDoc;
  vectors: Array<Record<string, unknown>>;
};

function childTypes(doc: FormDoc, path: number[]): string[] {
  const container = nodeAtPath(doc, path);
  const kids = (container?.children ?? []) as Array<{ type: string }>;
  return kids.map((n) => n.type);
}

function columnsFieldKeys(doc: FormDoc, path: number[] = [1]): string[] {
  const cols = nodeAtPath(doc, path);
  return ((cols?.children ?? []) as Array<{ fieldKey?: string }>).map((n) => n.fieldKey ?? "");
}

function tabFieldKeys(doc: FormDoc, tab: number): string[] {
  const tabs = nodeAtPath(doc, [2]);
  const kids = (tabs?.tabs?.[tab]?.children ?? []) as Array<{ fieldKey?: string }>;
  return kids.map((n) => n.fieldKey ?? "");
}

describe("form-document ops parity (server) — shared fixture", () => {
  for (const v of fixture.vectors) {
    it(String(v.name), () => {
      const before = JSON.stringify(fixture.baseDoc);
      const result = applyDocumentOp(fixture.baseDoc, v.op);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const doc = result.doc;

      // input never mutated
      expect(JSON.stringify(fixture.baseDoc)).toBe(before);

      if (v.expectedRootChildTypes) {
        expect(childTypes(doc, [])).toEqual(v.expectedRootChildTypes);
      }
      if (v.expectedColumnsFieldKeys) {
        expect(columnsFieldKeys(doc, (v.columnsPath as number[]) ?? [1])).toEqual(v.expectedColumnsFieldKeys);
      }
      if (v.expectedTab0FieldKeys) {
        expect(tabFieldKeys(doc, 0)).toEqual(v.expectedTab0FieldKeys);
      }
      if (v.expectedTab1FieldKeys) {
        expect(tabFieldKeys(doc, 1)).toEqual(v.expectedTab1FieldKeys);
      }
      if (v.expectedRootChild0Label !== undefined) {
        const n = nodeAtPath(doc, [0]) as { label?: string };
        expect(n.label).toBe(v.expectedRootChild0Label);
      }
      if (v.expectedMovedFieldKeyAtRootEnd !== undefined) {
        const rootKids = (doc.root.children ?? []) as Array<{ fieldKey?: string }>;
        expect(rootKids[rootKids.length - 1].fieldKey).toBe(v.expectedMovedFieldKeyAtRootEnd);
      }
    });
  }
});

describe("applyDocumentOp — closed vocabulary / fail-closed", () => {
  const doc = { root: { type: "section", children: [{ type: "divider" }] } };

  it("rejects an unknown op kind (400-shaped error, not a silent no-op)", () => {
    const r = applyDocumentOp(doc, { kind: "frobnicate", containerPath: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown op kind");
  });

  it("rejects insert with a non-path containerPath", () => {
    const r = applyDocumentOp(doc, { kind: "insert", containerPath: "root", node: { type: "divider" } });
    expect(r.ok).toBe(false);
  });

  it("rejects insert with a node missing a string type", () => {
    const r = applyDocumentOp(doc, { kind: "insert", containerPath: [], node: { foo: 1 } });
    expect(r.ok).toBe(false);
  });

  it("rejects update with a non-object patch", () => {
    const r = applyDocumentOp(doc, { kind: "update", containerPath: [], index: 0, patch: 42 });
    expect(r.ok).toBe(false);
  });

  it("rejects move with an empty fromPath", () => {
    const r = applyDocumentOp(doc, { kind: "move", fromPath: [], toPath: [0] });
    expect(r.ok).toBe(false);
  });

  it("rejects a doc without a root", () => {
    const r = applyDocumentOp({ notRoot: true }, { kind: "insert", containerPath: [], node: { type: "divider" } });
    expect(r.ok).toBe(false);
  });

  it("accepts a well-formed insert", () => {
    const r = applyDocumentOp(doc, { kind: "insert", containerPath: [], node: { type: "text", content: "hi" } });
    expect(r.ok).toBe(true);
  });
});
