/**
 * src/__tests__/slug-resolver-determinism.test.ts — T-0657 (audit, столп 5)
 *
 * Regression guard for the T-0657 audit (T-0657.spec.md), a T-0611 follow-up.
 *
 * THE AUDIT'S FINDING: every row-picking slug lookup in non-test src/ is already
 * deterministic — because its WHERE predicate is a superset of the table's UNIQUE
 * key (so `LIMIT 1` can only ever match one row), OR because the one genuinely
 * area-uncovered case is handled explicitly. There were NO undetected
 * nondeterministic resolvers to fix (contra the "~10 files" hypothesis).
 *
 * The ONLY two row-picking resolvers whose search AREA is NOT covered by a UNIQUE
 * key are the BYPASSRLS cross-tenant identity bridges in src/db/org.ts:
 *   - resolveActorTenant     — `WHERE e.slug = $1` (no tenant scope; employee slug
 *                               is only UNIQUE within a tenant, so cross-tenant it
 *                               can match many rows under dev-DB pollution).
 *   - resolveAgentSlugFromAuth — `WHERE ac.kc_client_id = $1` (global; backed by a
 *                               UNIQUE INDEX since migration 092/T-0426, but the
 *                               resolver keeps a belt-and-braces tie-break so a
 *                               future scheme regression degrades to STABLE, not
 *                               random, cross-tenant resolution).
 *
 * Both already carry a deterministic `ORDER BY … LIMIT 1`. This static (no-DB)
 * test PINS that tie-break in source so a future edit that drops it — re-opening
 * the exact nondeterminism T-0611 diagnosed for a different resolver — fails a
 * cheap assertion instead of shipping an intermittent cross-tenant mis-route.
 *
 * Same static-content strategy as agent-card-kc-client-id-global-unique.test.ts
 * (T-0426) and core-system-registries.test.ts: read the .ts source and assert the
 * SQL SHAPE, guarding the invariant against a silent regression to a no-op.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ORG_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../db/org.ts",
);

function readOrg(): string {
  return fs.readFileSync(ORG_PATH, "utf8");
}

/**
 * Slice the body of an `export async function <name>(` … matching the balanced
 * brace depth from the opening `{`. Good enough for a single top-level function
 * (org.ts functions are top-level, not nested), and robust to line-number drift.
 */
function functionBody(source: string, name: string): string {
  const sig = `export async function ${name}(`;
  const start = source.indexOf(sig);
  if (start === -1) throw new Error(`function ${name} not found in org.ts`);
  // Walk the parameter list to its balanced closing `)` — the parameter types
  // may themselves contain `{ … }` object literals, so we cannot just take the
  // first `{` after the signature. The body brace is the first `{` AFTER the
  // param-list `)` (skipping the `: ReturnType` annotation, which for these
  // functions is a `Promise<…>` with no brace).
  const parenOpen = start + sig.length - 1;
  let pdepth = 0;
  let paramClose = -1;
  for (let i = parenOpen; i < source.length; i++) {
    if (source[i] === "(") pdepth++;
    else if (source[i] === ")") {
      pdepth--;
      if (pdepth === 0) {
        paramClose = i;
        break;
      }
    }
  }
  if (paramClose === -1) throw new Error(`no param-list close for ${name}`);
  const openBrace = source.indexOf("{", paramClose);
  if (openBrace === -1) throw new Error(`no body brace for ${name}`);
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(openBrace, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** Collapse whitespace so multi-line SQL is matchable as one string. */
function flat(s: string): string {
  return s.replace(/\s+/g, " ").toLowerCase();
}

describe("T-0657 — cross-tenant slug resolvers keep a deterministic tie-break", () => {
  it("org.ts source exists", () => {
    expect(fs.existsSync(ORG_PATH), `expected ${ORG_PATH} to exist`).toBe(true);
  });

  describe("resolveActorTenant (employee slug, no tenant scope)", () => {
    const body = () => flat(functionBody(readOrg(), "resolveActorTenant"));

    it("still looks up employee by slug", () => {
      expect(body()).toContain("from choros.employee");
      expect(body()).toContain("where e.slug = $1");
    });

    it("orders deterministically before LIMIT 1 (no arbitrary first-row pick)", () => {
      const b = body();
      expect(b, "resolveActorTenant lost its ORDER BY — nondeterministic slug pick reopened").toContain(
        "order by",
      );
      expect(b).toContain("limit 1");
      // The tie-break is demo-tenant-first then recency; assert both legs survive
      // so a partial deletion (e.g. dropping created_at) is also caught.
      expect(b).toContain("case when t.slug = $2");
      expect(b).toContain("e.created_at desc");
      // ORDER BY must precede LIMIT (a LIMIT 1 without a preceding ORDER BY is the
      // nondeterministic shape this guard forbids).
      expect(b.indexOf("order by")).toBeLessThan(b.indexOf("limit 1"));
    });
  });

  describe("resolveAgentSlugFromAuth (kc_client_id, global)", () => {
    const body = () => flat(functionBody(readOrg(), "resolveAgentSlugFromAuth"));

    it("still resolves via kc_client_id + kind='agent'", () => {
      const b = body();
      expect(b).toContain("where ac.kc_client_id = $1");
      expect(b).toContain("e.kind = 'agent'");
    });

    it("orders deterministically before LIMIT 1 (belt-and-braces over UNIQUE(kc_client_id))", () => {
      const b = body();
      expect(b, "resolveAgentSlugFromAuth lost its ORDER BY — stable cross-tenant tie-break reopened").toContain(
        "order by ac.tenant_id, ac.employee_id",
      );
      expect(b).toContain("limit 1");
      expect(b.indexOf("order by")).toBeLessThan(b.indexOf("limit 1"));
    });
  });
});
