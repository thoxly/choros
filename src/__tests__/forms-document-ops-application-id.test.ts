/**
 * src/__tests__/forms-document-ops-application-id.test.ts  (T-0725)
 *
 * N-1 from the T-0711 review (non-blocking finding): POST /api/forms/document-ops
 * accepted an optional `applicationId` pin (T-0711), but a caller that skipped it
 * on a process bound to 2+ applications silently got the T-0711 deterministic
 * fallback (oldest binding) — possibly the WRONG schema, with no signal. The
 * human path (FormDesigner) never hits this: its "Приложение" picker always
 * threads `selectedAppId` (T-0711 review §1(a)). An agent driver has no picker,
 * so the asymmetry was real. Fix (this task):
 *   (1) the route's own documented contract now explicitly names `applicationId`
 *       as an accepted field (see the header JSDoc "Route:" block) — mirrors how
 *       T-0700 declared `targetRegistrySlug` on TOOL_AUTHOR_BINDING's schema so
 *       an agent driver could discover the parameter exists at all;
 *   (2) a genuinely ambiguous process (2+ process_app_binding rows) WITHOUT a
 *       pin now fails closed with 422 AMBIGUOUS_APPLICATION (honest "ask", not a
 *       silent guess) — a SINGLE-binding process without a pin is UNCHANGED
 *       (still resolves via the T-0711 fallback, still 200).
 *
 * Covers:
 *   AC-a/b: applicationId IS accepted and actually selects the pinned binding's
 *           schema (pin=B saves a B-only field; pin=A on the SAME field → 409
 *           WRONG_FLOOR) — reuses classifyLayoutSave/T-0711, no new resolver.
 *   AC-c:   no pin + 2 bindings → 422 AMBIGUOUS_APPLICATION, naming both
 *           candidates; the UPDATE never runs (no silent write against a
 *           guessed schema).
 *   AC-d:   no pin + exactly 1 binding → 200 (T-0711 fallback unaffected).
 *
 * Harness mirrors forms-document-ops-wire.test.ts (T-0656): a stub pg.Pool
 * replays the layout SELECT/UPDATE + the live-schema/candidate-listing queries
 * the route needs, keyed off SQL-text pattern matching. No real DB.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerFormDocumentOpsRoute } from "../http/forms-document-ops.js";
import type { FormDoc } from "../core/form-document-ops.js";

const DEV_TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const APP_A = "b0000000-0000-0000-0000-0000000000aa";
const APP_B = "b0000000-0000-0000-0000-0000000000bb";
const PROCESS_KEY = "t0725-multi-app-proc";
const STEP_KEY = "t0725-multi-app-form";

/** A layout with zero children — Floor-1 safe against ANY live schema
 *  regardless of which binding resolves (R-4 references zero field keys). */
const NEUTRAL_LAYOUT: FormDoc = {
  schemaVersion: 1,
  source: {},
  root: { type: "section", children: [] },
};

interface Binding {
  applicationId: string;
  slug: string;
  displayName: string;
  schemaKeys: string[];
}

/** Stub pg.Pool modeling a process bound to `bindings.length` applications,
 *  each with its OWN live schema (schemaKeys). Mirrors real SQL semantics:
 *    - listProcessAppBindingCandidates: returns ALL bindings (ORDER BY as if
 *      created_at ASC — bindings[] order IS the fallback order).
 *    - resolveLiveRecordSchema step 1 (classifyLayoutSave path): honors the
 *      3rd bind param (pinned applicationId) when present, else falls back to
 *      bindings[0] (oldest) — same contract as live-form-schema.ts's SQL.
 */
function makeMultiBindingPool(opts: {
  bindings: Binding[];
  layout: unknown;
  captured?: { layout?: unknown; version?: number; updateCalled?: boolean };
}): pg.Pool {
  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [] };
      const t = text.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/i.test(t)) return { rows: [] };
      if (text.includes("role_assignment")) return { rows: [{ cnt: 1 }] };

      // getBindingLayout: SELECT id, ..., layout, version FROM form_binding
      if (text.includes("FROM choros.form_binding") && text.includes("SELECT")) {
        if (opts.layout === null) return { rows: [] };
        return { rows: [{ id: "row1", process_key: PROCESS_KEY, form_key: STEP_KEY, layout: opts.layout, version: 3 }] };
      }

      // T-0725 listProcessAppBindingCandidates: joins choros.application —
      // the ONE query among the process_app_binding-referencing set that does.
      if (text.includes("process_app_binding") && text.includes("choros.application")) {
        return {
          rows: opts.bindings.map((b) => ({
            application_id: b.applicationId,
            slug: b.slug,
            display_name: b.displayName,
          })),
        };
      }

      // classifyLayoutSave → resolveLiveRecordSchema step 1: process_app_binding,
      // no application JOIN. Honor the pin ($3) if present, else oldest (bindings[0]).
      if (text.includes("process_app_binding")) {
        const pin = params?.[2] as string | null | undefined;
        const picked = pin ? opts.bindings.find((b) => b.applicationId === pin) : opts.bindings[0];
        if (!picked) return { rows: [] };
        return { rows: [{ application_id: picked.applicationId, target_registry_slug: null }] };
      }

      // classifyLayoutSave step 2: registry_def → record_schema. The 2nd bind
      // param is the resolved application_id from step 1 above.
      if (text.includes("registry_def")) {
        const resolvedAppId = params?.[1] as string | undefined;
        const binding = opts.bindings.find((b) => b.applicationId === resolvedAppId);
        if (!binding) return { rows: [] };
        const properties: Record<string, unknown> = {};
        for (const k of binding.schemaKeys) properties[k] = { type: "string" };
        return { rows: [{ record_schema: { properties } }] };
      }

      // UPDATE form_binding SET layout=..., version=...
      if (text.includes("UPDATE choros.form_binding")) {
        if (opts.captured) {
          opts.captured.updateCalled = true;
          opts.captured.layout = params?.[0] ? JSON.parse(params[0] as string) : undefined;
          opts.captured.version = params?.[1] as number;
        }
        return { rows: [] };
      }

      return { rows: [] };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

async function startServer(pool: pg.Pool): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerFormDocumentOpsRoute(router, pool, {
    pool,
    resolveActorTenant: async () => DEV_TENANT_ID,
  });
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((e?: Error) => (e ? reject(e) : resolve()))),
  };
}

async function postOp(port: number, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/forms/document-ops",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "x-dev-user": "alice",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: data }); }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const TWO_BINDINGS: Binding[] = [
  { applicationId: APP_A, slug: "t0725-app-alpha", displayName: "T0725 Alpha", schemaKeys: ["alpha_only"] },
  { applicationId: APP_B, slug: "t0725-app-beta", displayName: "T0725 Beta", schemaKeys: ["beta_only"] },
];

describe("POST /api/forms/document-ops — applicationId parity (T-0725, N-1)", () => {
  it("AC-a/b: pin=B + a B-only field → 200 (schema resolves against the PINNED binding)", async () => {
    const captured: { layout?: unknown; version?: number; updateCalled?: boolean } = {};
    const srv = await startServer(makeMultiBindingPool({ bindings: TWO_BINDINGS, layout: NEUTRAL_LAYOUT, captured }));
    try {
      const res = await postOp(srv.port, {
        processKey: PROCESS_KEY, stepKey: STEP_KEY, applicationId: APP_B,
        op: { kind: "insert", containerPath: [], node: { type: "field", fieldKey: "beta_only", widget: "text" } },
      });
      expect(res.status, `expected 200, got: ${JSON.stringify(res.body)}`).toBe(200);
      expect(captured.updateCalled).toBe(true);
    } finally { await srv.close(); }
  });

  it("AC-a/b: pin=A + the SAME B-only field → 409 WRONG_FLOOR (pin actually changes which schema validates — reuses T-0711)", async () => {
    const srv = await startServer(makeMultiBindingPool({ bindings: TWO_BINDINGS, layout: NEUTRAL_LAYOUT }));
    try {
      const res = await postOp(srv.port, {
        processKey: PROCESS_KEY, stepKey: STEP_KEY, applicationId: APP_A,
        op: { kind: "insert", containerPath: [], node: { type: "field", fieldKey: "beta_only", widget: "text" } },
      });
      expect(res.status).toBe(409);
      const env = res.body as { error?: { code?: string } };
      expect(env.error?.code).toBe("WRONG_FLOOR");
    } finally { await srv.close(); }
  });

  it("AC-c: NO pin + 2 bindings → 422 AMBIGUOUS_APPLICATION naming both candidates, NOT a silent fallback save", async () => {
    const captured: { layout?: unknown; version?: number; updateCalled?: boolean } = {};
    const srv = await startServer(makeMultiBindingPool({ bindings: TWO_BINDINGS, layout: NEUTRAL_LAYOUT, captured }));
    try {
      const res = await postOp(srv.port, {
        processKey: PROCESS_KEY, stepKey: STEP_KEY,
        op: { kind: "insert", containerPath: [], node: { type: "divider" } },
      });
      expect(res.status, `expected 422, got: ${JSON.stringify(res.body)}`).toBe(422);
      const env = res.body as { error?: { code?: string; message?: string } };
      expect(env.error?.code).toBe("AMBIGUOUS_APPLICATION");
      // Machine-readable code above; human-hint message names BOTH candidates
      // (id present so a driver can retry with the right pin without re-querying).
      expect(env.error?.message).toContain(APP_A);
      expect(env.error?.message).toContain(APP_B);
      // No silent guess: the UPDATE must never have run.
      expect(captured.updateCalled).toBeUndefined();
    } finally { await srv.close(); }
  });

  it("AC-d: NO pin + exactly ONE binding → 200 (T-0711 fallback unaffected — single-binding not broken)", async () => {
    const srv = await startServer(makeMultiBindingPool({ bindings: [TWO_BINDINGS[0]!], layout: NEUTRAL_LAYOUT }));
    try {
      const res = await postOp(srv.port, {
        processKey: PROCESS_KEY, stepKey: STEP_KEY,
        op: { kind: "insert", containerPath: [], node: { type: "divider" } },
      });
      expect(res.status, `expected 200, got: ${JSON.stringify(res.body)}`).toBe(200);
    } finally { await srv.close(); }
  });

  it("AC-d: NO pin + ZERO bindings → unaffected by the ambiguity gate (still 409 WRONG_FLOOR via the existing fail-closed live-schema check, not 422)", async () => {
    const srv = await startServer(makeMultiBindingPool({ bindings: [], layout: NEUTRAL_LAYOUT }));
    try {
      const res = await postOp(srv.port, {
        processKey: PROCESS_KEY, stepKey: STEP_KEY,
        op: { kind: "insert", containerPath: [], node: { type: "divider" } },
      });
      // candidates.length is 0 (not >1) → the T-0725 gate is a no-op; the
      // PRE-EXISTING fail-closed path (no live schema resolvable) still fires.
      expect(res.status).toBe(409);
      const env = res.body as { error?: { code?: string } };
      expect(env.error?.code).toBe("WRONG_FLOOR");
    } finally { await srv.close(); }
  });
});
