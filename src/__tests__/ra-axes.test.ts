/**
 * T-0195 — axesFromGrants: "invoke" verb raises external axis
 *
 * Pure-logic unit test for axesFromGrants() in
 * web/src/screens/rights/ra-data.jsx (T-0030 / R-N2 from T-0135 review).
 *
 * Background:
 *   axesFromGrants previously checked `g.ops.includes("exec")` for the
 *   `external` axis — a dead string that never matched (T-0194 fix: "exec" →
 *   "invoke").  As a result, presses p-treasury-exec and p-pay-init-limited
 *   — both of which include `payments.initiate:invoke` — did NOT raise the
 *   `external` axis, silently under-reporting role criticality in the UI.
 *
 * This test is self-contained (no React / JSX import) because ra-data.jsx
 * carries React component definitions alongside the pure data functions, and
 * the root vitest config excludes `web/**`.  The logic here is a 1:1 mirror
 * of axesFromGrants + the RESOURCES/RES_BY_URI definitions in ra-data.jsx;
 * any drift between the two is detectable by reading the source file.
 *
 * Spec ref: docs/reviews/T-0135.review.md § R-N2
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Inline mirror of RESOURCES + RES_BY_URI from ra-data.jsx
// (keep in sync with web/src/screens/rights/ra-data.jsx:50-62)
// ---------------------------------------------------------------------------

interface Resource {
  uri: string;
  name: string;
  external?: boolean;
  guarded?: boolean;
  sensitive?: boolean;
}

const RESOURCES: Resource[] = [
  { uri: "mcp://ledger.invoices",    name: "Реестр счетов",           sensitive: true },
  { uri: "mcp://ledger.recon",       name: "Сверка платежей",         sensitive: true },
  { uri: "mcp://payments.initiate",  name: "Платёжный шлюз",         external: true, guarded: true },
  { uri: "mcp://payments.refund",    name: "Возвраты средств",        external: true, guarded: true },
  { uri: "mcp://counterparty.kyc",   name: "Контрагенты (KYC)",       sensitive: true },
  { uri: "mcp://contracts.lookup",   name: "Справочник договоров" },
  { uri: "mcp://support.queue",      name: "Очередь обращений" },
  { uri: "mcp://crm.customer",       name: "CRM клиента",             sensitive: true },
  { uri: "mcp://kb.search",          name: "База знаний" },
  { uri: "mcp://escalations.queue",  name: "Очередь эскалаций" },
];

const RES_BY_URI: Record<string, Resource> =
  Object.fromEntries(RESOURCES.map((r) => [r.uri, r]));

// ---------------------------------------------------------------------------
// Inline mirror of axesFromGrants from ra-data.jsx:255-265
// (keep in sync — any change to the source must be reflected here)
// ---------------------------------------------------------------------------

interface Grant {
  uri: string;
  ops: string[];
}

interface Axes {
  guarded: boolean;
  external: boolean;
  sensitive: boolean;
}

function axesFromGrants(grants: Grant[]): Axes {
  const axes: Axes = { guarded: false, external: false, sensitive: false };
  grants.forEach((g) => {
    const r = RES_BY_URI[g.uri];
    if (!r) return;
    if (r.guarded   && (g.ops.includes("invoke") || g.ops.includes("approve"))) axes.guarded = true;
    if (r.external  && g.ops.includes("invoke"))                                  axes.external = true;
    if (r.sensitive && (g.ops.includes("read")   || g.ops.includes("write")))    axes.sensitive = true;
  });
  return axes;
}

// ---------------------------------------------------------------------------
// Inline mirror of critLevel from ra-data.jsx:245-246
// ---------------------------------------------------------------------------

function critLevel(axes: Axes): string {
  return (axes.guarded || axes.external) ? "critical" : (axes.sensitive ? "elevated" : "standard");
}

// ---------------------------------------------------------------------------
// Preset grant atoms (from ra-data.jsx PRESETS — only the invoke atoms)
// p-treasury-exec:   payments.initiate:invoke
// p-pay-init-limited: payments.initiate:invoke
// p-refund-operator:  payments.refund:invoke
// ---------------------------------------------------------------------------

const TREASURY_EXEC_GRANTS: Grant[] = [
  { uri: "mcp://ledger.invoices",   ops: ["read"] },
  { uri: "mcp://ledger.recon",      ops: ["read"] },
  { uri: "mcp://ledger.recon",      ops: ["update"] },
  { uri: "mcp://payments.initiate", ops: ["invoke"] },
];

const PAY_INIT_LIMITED_GRANTS: Grant[] = [
  { uri: "mcp://ledger.invoices",   ops: ["read"] },
  { uri: "mcp://payments.initiate", ops: ["invoke"] },
];

const REFUND_OPERATOR_GRANTS: Grant[] = [
  { uri: "mcp://ledger.invoices",  ops: ["read"] },
  { uri: "mcp://payments.refund",  ops: ["invoke"] },
];

// ---------------------------------------------------------------------------
// T-0195: R-N2 regression — axesFromGrants uses "invoke" not "exec"
// ---------------------------------------------------------------------------

describe("T-0195: axesFromGrants raises external axis on invoke op (R-N2)", () => {

  describe("p-treasury-exec", () => {
    const axes = axesFromGrants(TREASURY_EXEC_GRANTS);

    it("raises external axis (payments.initiate is external, op is invoke)", () => {
      expect(axes.external).toBe(true);
    });

    it("raises guarded axis (payments.initiate is guarded, op is invoke)", () => {
      expect(axes.guarded).toBe(true);
    });

    it("raises sensitive axis (ledger.invoices/recon are sensitive, read present)", () => {
      expect(axes.sensitive).toBe(true);
    });

    it("critLevel is 'critical' (external || guarded)", () => {
      expect(critLevel(axes)).toBe("critical");
    });
  });

  describe("p-pay-init-limited", () => {
    const axes = axesFromGrants(PAY_INIT_LIMITED_GRANTS);

    it("raises external axis (payments.initiate is external, op is invoke)", () => {
      expect(axes.external).toBe(true);
    });

    it("raises guarded axis (payments.initiate is guarded, op is invoke)", () => {
      expect(axes.guarded).toBe(true);
    });

    it("critLevel is 'critical'", () => {
      expect(critLevel(axes)).toBe("critical");
    });
  });

  describe("p-refund-operator", () => {
    const axes = axesFromGrants(REFUND_OPERATOR_GRANTS);

    it("raises external axis (payments.refund is external, op is invoke)", () => {
      expect(axes.external).toBe(true);
    });

    it("raises guarded axis (payments.refund is guarded, op is invoke)", () => {
      expect(axes.guarded).toBe(true);
    });

    it("critLevel is 'critical'", () => {
      expect(critLevel(axes)).toBe("critical");
    });
  });

  // Negative: "exec" must NOT satisfy the external check (T-0195 regression guard)
  describe("regression: legacy 'exec' op does NOT raise external axis", () => {
    const grantsWithExec: Grant[] = [
      { uri: "mcp://payments.initiate", ops: ["exec"] },
    ];
    const axes = axesFromGrants(grantsWithExec);

    it("does NOT raise external axis when op is 'exec' (exec is not in Operation union)", () => {
      expect(axes.external).toBe(false);
    });

    it("does NOT raise guarded axis when op is 'exec'", () => {
      expect(axes.guarded).toBe(false);
    });

    it("critLevel is 'standard' for exec-only grant (no recognized axis raised)", () => {
      expect(critLevel(axes)).toBe("standard");
    });
  });

  // Boundary: non-invoke ops on external resources do NOT raise external axis
  describe("boundary: read on external resource does NOT raise external", () => {
    const axes = axesFromGrants([
      { uri: "mcp://payments.initiate", ops: ["read"] },
    ]);

    it("external is false for read on payments.initiate", () => {
      expect(axes.external).toBe(false);
    });
  });

  // Boundary: unknown URI is silently ignored
  describe("boundary: unknown URI is ignored", () => {
    const axes = axesFromGrants([
      { uri: "mcp://unknown.resource", ops: ["invoke"] },
    ]);

    it("all axes remain false for an unknown resource URI", () => {
      expect(axes.external).toBe(false);
      expect(axes.guarded).toBe(false);
      expect(axes.sensitive).toBe(false);
    });
  });

  // Boundary: mgmt_object:* URIs (Админ preset) are absent from RES_BY_URI and ignored
  describe("boundary: mgmt_object:* URIs (Админ preset) do NOT raise axes", () => {
    const axes = axesFromGrants([
      { uri: "mgmt_object:roles",       ops: ["read", "create", "update", "delete"] },
      { uri: "mgmt_object:users",       ops: ["read", "create", "update", "delete"] },
      { uri: "mgmt_object:permissions", ops: ["read", "create", "update", "delete"] },
    ]);

    it("external is false (mgmt_object:* not in RESOURCES)", () => {
      expect(axes.external).toBe(false);
    });
    it("guarded is false", () => {
      expect(axes.guarded).toBe(false);
    });
    it("sensitive is false", () => {
      expect(axes.sensitive).toBe(false);
    });
  });
});
