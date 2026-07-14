/**
 * T-0416 [D7-2-FU] — Unit tests for the three hardening items in step-applier.ts:
 *
 *   F1 — fail-CLOSED on a thrown DB load error (vs absent binding row)
 *   F2 — operator-visible warning when validation is skipped (no binding)
 *   F3 — form_key-aware binding selection for multi-form processes
 *
 * Architecture: unit-level — all DB interactions are stubbed via in-memory
 * query interceptors (same pattern as step-applier.test.ts). No live Postgres.
 *
 * Test matrix:
 *   T416-F1-1  DB error in binding load → validateAndFilterFormValues rejects (throws)
 *   T416-F1-2  DB error in binding load → 0 values written (fail-closed: no unvalidated INSERT)
 *   T416-F1-3  Absent binding (0 rows, no throw) → values still pass through (backward-compat)
 *   T416-F2-1  Absent binding → console.warn emitted with process_key
 *   T416-F2-2  Present binding → no console.warn emitted
 *   T416-F3-1  Multi-form process → correct binding selected for form_key A
 *   T416-F3-2  Multi-form process → correct binding selected for form_key B
 *   T416-F3-3  form_key not in binding → 0 rows → null (absent-binding backward-compat path)
 */

import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  validateAndFilterFormValues,
} from "../db/step-applier.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "44400416-4444-4444-4444-000000000001";
const PROC_KEY = "multi-form-process";

// ---------------------------------------------------------------------------
// Stub client builder
// ---------------------------------------------------------------------------

type QueryResponder = (sql: string, params: unknown[]) => { rows: unknown[] } | never;

function makeStubClient(responder: QueryResponder): PoolClient {
  return {
    query: async (sql: unknown, paramsArg?: unknown[]): Promise<{ rows: unknown[] }> => {
      const sqlText =
        typeof sql === "string" ? sql : ((sql as { text?: string }).text ?? "");
      const params = paramsArg ?? [];
      const upper = sqlText.trimStart().toUpperCase();
      // Absorb transaction-control and SET LOCAL statements
      if (
        upper.startsWith("BEGIN") ||
        upper.startsWith("COMMIT") ||
        upper.startsWith("ROLLBACK") ||
        upper.startsWith("SET LOCAL") ||
        upper.startsWith("SET SEARCH_PATH")
      ) {
        return { rows: [] };
      }
      return responder(sqlText, params);
    },
  } as unknown as PoolClient;
}

// ---------------------------------------------------------------------------
// F1 tests: fail-closed on DB error
// ---------------------------------------------------------------------------

describe("T-0416 F1: fail-closed on DB load error", () => {
  it("T416-F1-1: DB error in form_binding query → validateAndFilterFormValues throws", async () => {
    // The binding query should throw — F1 requires this to propagate, not be swallowed.
    const client = makeStubClient((sql) => {
      if (/FROM choros\.form_binding/i.test(sql)) {
        throw new Error("DB connection lost (simulated)");
      }
      // F3: process_app_binding for form_key lookup returns null form_key (no form_key set)
      if (/FROM choros\.process_app_binding/i.test(sql) && /SELECT form_key/i.test(sql)) {
        return { rows: [{ form_key: null }] };
      }
      // F3: process_app_binding for schema load
      if (/FROM choros\.process_app_binding/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    await expect(
      validateAndFilterFormValues(client, TENANT_ID, PROC_KEY, { fieldA: "value" }),
    ).rejects.toThrow("DB connection lost (simulated)");
  });

  it("T416-F1-2: DB error in form_binding query → caller sees rejection, no unvalidated write path", async () => {
    // Verify the thrown error propagates to the caller (the withTenantTx catches it,
    // rolling back any pending writes). We prove this by checking the promise rejects.
    let called = false;
    const client = makeStubClient((sql) => {
      if (/FROM choros\.form_binding/i.test(sql)) {
        called = true;
        throw new Error("transient DB error");
      }
      if (/FROM choros\.process_app_binding/i.test(sql) && /SELECT form_key/i.test(sql)) {
        return { rows: [{ form_key: null }] };
      }
      return { rows: [] };
    });

    const result = validateAndFilterFormValues(
      client,
      TENANT_ID,
      PROC_KEY,
      { criticalField: "secret" },
    );
    await expect(result).rejects.toThrow("transient DB error");
    expect(called).toBe(true);
  });

  it("T416-F1-3: absent binding (0 rows, no throw) → values pass through (backward-compat)", async () => {
    // A SUCCESSFUL query returning 0 rows is the "no binding" case — must NOT throw.
    const client = makeStubClient((sql) => {
      if (/FROM choros\.form_binding/i.test(sql)) {
        return { rows: [] }; // 0 rows: no binding authored
      }
      if (/FROM choros\.process_app_binding/i.test(sql) && /SELECT form_key/i.test(sql)) {
        return { rows: [{ form_key: null }] };
      }
      if (/FROM choros\.process_app_binding/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await validateAndFilterFormValues(
      client,
      TENANT_ID,
      PROC_KEY,
      { anyKey: "anyValue", anotherKey: 42 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues["anyKey"]).toBe("anyValue");
      expect(result.safeValues["anotherKey"]).toBe(42);
    }
  });
});

// ---------------------------------------------------------------------------
// F2 tests: observability warning when validation is skipped
// ---------------------------------------------------------------------------

describe("T-0416 F2: warning emitted when no binding found", () => {
  it("T416-F2-1: absent binding → console.warn emitted with process_key", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const client = makeStubClient((sql) => {
      if (/FROM choros\.form_binding/i.test(sql)) {
        return { rows: [] }; // no binding
      }
      if (/FROM choros\.process_app_binding/i.test(sql) && /SELECT form_key/i.test(sql)) {
        return { rows: [{ form_key: null }] };
      }
      if (/FROM choros\.process_app_binding/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    await validateAndFilterFormValues(client, TENANT_ID, PROC_KEY, { x: 1 });

    expect(warnSpy).toHaveBeenCalledOnce();
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain(PROC_KEY);
    expect(warnMsg).toContain("no form_binding found");

    warnSpy.mockRestore();
  });

  it("T416-F2-2: present binding → no console.warn emitted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const client = makeStubClient((sql) => {
      if (/FROM choros\.form_binding/i.test(sql)) {
        // Return a binding row — validation runs, no warning
        return {
          rows: [{ fields: [{ key: "fieldA", type: "text", required: false }] }],
        };
      }
      if (/FROM choros\.process_app_binding/i.test(sql) && /SELECT form_key/i.test(sql)) {
        return { rows: [{ form_key: null }] };
      }
      if (/FROM choros\.process_app_binding/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await validateAndFilterFormValues(
      client,
      TENANT_ID,
      PROC_KEY,
      { fieldA: "hello" },
    );
    expect(result.ok).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("T416-F2-1b: warning includes form_key label when formKey supplied and binding absent", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const client = makeStubClient((sql) => {
      if (/FROM choros\.form_binding/i.test(sql)) {
        return { rows: [] }; // no binding for this form_key
      }
      if (/FROM choros\.process_app_binding/i.test(sql) && /SELECT form_key/i.test(sql)) {
        return { rows: [{ form_key: "step-a-form" }] };
      }
      if (/FROM choros\.process_app_binding/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    await validateAndFilterFormValues(client, TENANT_ID, PROC_KEY, { x: 1 }, "step-a-form");

    expect(warnSpy).toHaveBeenCalledOnce();
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain(PROC_KEY);
    expect(warnMsg).toContain("step-a-form");

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// F3 tests: form_key-aware binding selection
// ---------------------------------------------------------------------------

describe("T-0416 F3: form_key-aware binding selection", () => {
  /**
   * Simulate a process with TWO form bindings:
   *   form_key = "approval-form"  → fields: [{ key: "approvalNote", type: "text" }]
   *   form_key = "rejection-form" → fields: [{ key: "rejectionReason", type: "text" }]
   *
   * The multi-form responder returns the correct binding based on the form_key
   * parameter in the query.
   */
  function makeMultiFormClient(callerFormKey?: string | null): {
    client: PoolClient;
    queriedFormKeys: string[];
  } {
    const queriedFormKeys: string[] = [];

    const BINDING_BY_FORM: Record<string, unknown[]> = {
      "approval-form": [{ key: "approvalNote", type: "text", required: false }],
      "rejection-form": [{ key: "rejectionReason", type: "text", required: false }],
    };

    const client = makeStubClient((sql, params) => {
      // F3 auto-resolution path: SELECT form_key FROM process_app_binding
      if (/FROM choros\.process_app_binding/i.test(sql) && /SELECT form_key/i.test(sql)) {
        // Return the caller-supplied form_key as if it were stored on the binding row.
        return { rows: [{ form_key: callerFormKey ?? null }] };
      }
      // schema load path: SELECT application_id FROM process_app_binding
      if (/FROM choros\.process_app_binding/i.test(sql)) {
        return { rows: [] };
      }
      // form_binding query — capture which form_key was used
      if (/FROM choros\.form_binding/i.test(sql)) {
        // The third param ($3) is form_key when the query uses AND form_key = $3
        const queriedKey = params[2];
        if (typeof queriedKey === "string") {
          queriedFormKeys.push(queriedKey);
          const fields = BINDING_BY_FORM[queriedKey];
          if (fields) {
            return { rows: [{ fields }] };
          }
          return { rows: [] }; // form_key not found
        }
        // No form_key param → unkeyed fallback → return both (take first by version desc)
        // In reality ORDER BY version DESC LIMIT 1 would return one; return "approval-form" arbitrarily.
        return { rows: [{ fields: BINDING_BY_FORM["approval-form"] }] };
      }
      return { rows: [] };
    });

    return { client, queriedFormKeys };
  }

  it("T416-F3-1: approval-form submit → approval-form binding fields used; rejectionReason rejected", async () => {
    // Caller passes formKey="approval-form" explicitly.
    const { client, queriedFormKeys } = makeMultiFormClient("approval-form");

    const result = await validateAndFilterFormValues(
      client,
      TENANT_ID,
      PROC_KEY,
      { approvalNote: "Looks good", rejectionReason: "NOT my field" },
      "approval-form",
    );

    // Validation ran against approval-form binding: approvalNote is valid, rejectionReason is not
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const unknownKeys = result.violations.filter((v) => v.type === "unknown_key").map((v) => v.key);
      expect(unknownKeys).toContain("rejectionReason");
      expect(unknownKeys).not.toContain("approvalNote");
    }
    // The form_key was threaded to the query
    expect(queriedFormKeys).toContain("approval-form");
  });

  it("T416-F3-2: rejection-form submit → rejection-form binding fields used; approvalNote rejected", async () => {
    const { client, queriedFormKeys } = makeMultiFormClient("rejection-form");

    const result = await validateAndFilterFormValues(
      client,
      TENANT_ID,
      PROC_KEY,
      { rejectionReason: "Not compliant", approvalNote: "NOT my field" },
      "rejection-form",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const unknownKeys = result.violations.filter((v) => v.type === "unknown_key").map((v) => v.key);
      expect(unknownKeys).toContain("approvalNote");
      expect(unknownKeys).not.toContain("rejectionReason");
    }
    expect(queriedFormKeys).toContain("rejection-form");
  });

  it("T416-F3-3: form_key present in process_app_binding but no matching form_binding row → absent-binding backward-compat path", async () => {
    // form_key is auto-resolved from process_app_binding but doesn't match any form_binding row.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { client } = makeMultiFormClient("unknown-form-key");

    const result = await validateAndFilterFormValues(
      client,
      TENANT_ID,
      PROC_KEY,
      { anyField: "anything" },
      "unknown-form-key",
    );

    // No binding row found for this form_key → backward-compat: values pass through
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safeValues["anyField"]).toBe("anything");
    }
    // Warning should be emitted (F2)
    expect(warnSpy).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });

  it("T416-F3-4: F3 auto-resolution from process_app_binding.form_key when caller passes no formKey", async () => {
    // No formKey supplied by caller, but process_app_binding has form_key="approval-form"
    // → should auto-resolve and use approval-form binding
    const { client, queriedFormKeys } = makeMultiFormClient("approval-form");

    const result = await validateAndFilterFormValues(
      client,
      TENANT_ID,
      PROC_KEY,
      // Only approvalNote is in approval-form; ghost is unknown
      { approvalNote: "ok", ghost: "intruder" },
      // No formKey supplied (undefined)
      undefined,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const unknownKeys = result.violations.map((v) => v.key);
      expect(unknownKeys).toContain("ghost");
    }
    // The auto-resolved form_key was used in the query
    expect(queriedFormKeys).toContain("approval-form");
  });
});
