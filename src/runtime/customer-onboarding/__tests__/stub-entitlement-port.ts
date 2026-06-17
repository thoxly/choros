/**
 * src/runtime/customer-onboarding/__tests__/stub-entitlement-port.ts — T-0244
 *
 * Deterministic test stub for EntitlementPort. Zero network, zero SDK.
 * Used in vitest integration tests for runIssueKey (FF-6).
 */

import type {
  EntitlementPort,
  IssueEntitlementInput,
  LicenseRecord,
} from "../entitlement-port.js";

export interface StubEntitlementPortOptions {
  /** If provided, stub will throw this error instead of returning a record. */
  error?: Error;
  /** Override the returned circuit_id (default: echoes input.circuit_id). */
  fixedCircuitId?: string;
  /** Override the returned issued_at (default: "2026-01-01T00:00:00.000Z"). */
  fixedIssuedAt?: string;
}

/**
 * Creates a deterministic stub EntitlementPort for tests.
 *
 * Success mode: returns a LicenseRecord with the given circuit_id and issued_at.
 * Error mode: throws the given error when issueEntitlement is called.
 */
export function makeStubEntitlementPort(
  opts: StubEntitlementPortOptions = {},
): EntitlementPort & { calls: IssueEntitlementInput[] } {
  const calls: IssueEntitlementInput[] = [];
  return {
    calls,
    async issueEntitlement(input: IssueEntitlementInput): Promise<LicenseRecord> {
      calls.push(input);
      if (opts.error) throw opts.error;
      return {
        circuit_id: opts.fixedCircuitId ?? input.circuit_id,
        issued_at: opts.fixedIssuedAt ?? "2026-01-01T00:00:00.000Z",
      };
    },
  };
}
