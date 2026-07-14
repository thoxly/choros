/**
 * src/vendor/issuance.ts — T-0242
 *
 * Producer-side vendor entitlement layer. Four pure functions over LicenseRecord
 * via an injectable LicenseStore port. Signing reuses canonicalPayloadBytes from
 * activation.ts (signer↔verifier hash identical bytes). Private key is NEVER read
 * here — it is passed as an argument; reading from file happens ONLY in the CLI
 * composition root (src/cli/issue-key.ts).
 *
 * This module lives in src/vendor/ (NOT src/core/). The src/core/ never imports this
 * file — FF-T127-1 enforces that one-way edge. Entitlement vocabulary stays in
 * src/vendor/ — FF-T127-4 holds. LicenseRecord is a VENDOR ledger, not a tenant
 * table — no migration under choros/migrations/, no entry in known_tenant_tables.txt
 * (FF-T242-4 enforces this).
 *
 * Zero runtime deps: only node:crypto (NF-4 / FF-T242-3).
 *
 * revoke ≠ halt (NF-1 / T-0127 red-line): revokeEntitlement sets status='revoked'
 * in the record only. Previously issued wire-keys live until not_after in autonomous
 * mode. signKey/refreshKey refuse on a revoked record.
 */

import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { randomUUID } from "node:crypto";
import {
  canonicalPayloadBytes,
  type ActivationKey,
  type EntitlementSet,
} from "./activation.js";

// ---------------------------------------------------------------------------
// Object model (§3 ADR)
// ---------------------------------------------------------------------------

/** Vendor plan specification — entitlement flags + label. */
export interface PlanSpec {
  /** Plan tier label, e.g. 'pilot' | 'pro'. */
  tier: string;
  /** Named entitlement flags for this plan. */
  entitlements: EntitlementSet;
}

/**
 * Vendor license record — single source of truth for a client circuit's entitlement.
 * This is a VENDOR-SIDE ledger, NOT a tenant table. It must NOT appear in
 * choros/migrations/ or known_tenant_tables.txt.
 */
export interface LicenseRecord {
  id: string;                      // UUID PK
  circuit_id: string;              // natural key (unique per circuit)
  status: "active" | "revoked";
  plan: PlanSpec;
  valid_from: string;              // RFC3339
  valid_until: string;            // RFC3339
  source: "pilot" | "billing" | "trial" | "saas";
  notes: string | null;
  issued_at: string;               // RFC3339, auto, immutable on re-issue
  last_signed: string | null;      // RFC3339, updated by signKey/refreshKey
  revoked_at: string | null;
  revoked_by: string | null;
}

/** Public contract with T-0244 — stable; store/now injected by composition root. */
export interface IssueParams {
  circuit_id: string;
  plan: PlanSpec;
  valid_from: string;              // RFC3339
  valid_until: string;            // RFC3339
  source: "pilot" | "billing" | "trial" | "saas";
  notes?: string;
}

// ---------------------------------------------------------------------------
// LicenseStore port (injectable — MVP: FileLicenseStore; Stage-2: own vendor DB)
// ---------------------------------------------------------------------------

/** Injectable port for vendor license persistence. NOT a tenant store. */
export interface LicenseStore {
  getByCircuit(circuit_id: string): LicenseRecord | null;
  /** Upsert by natural key circuit_id. Returns the persisted record. */
  upsert(rec: LicenseRecord): LicenseRecord;
}

// ---------------------------------------------------------------------------
// PlanSpec presets (F-7 ADR)
// ---------------------------------------------------------------------------

/** Pilot plan: updates + support; no agentic_ops. */
export const PILOT_PLAN: PlanSpec = {
  tier: "pilot",
  entitlements: {
    updates: true,
    agentic_ops: false,
    support: true,
    tier: "pilot",
  },
};

/** Pro plan: updates + agentic_ops + support. */
export const PRO_PLAN: PlanSpec = {
  tier: "pro",
  entitlements: {
    updates: true,
    agentic_ops: true,
    support: true,
    tier: "pro",
  },
};

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function toRFC3339(d: Date): string {
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Create or update a LicenseRecord for a circuit.
 *
 * 🔒 PUBLIC CONTRACT with T-0244 — stable:
 *   issueEntitlement({circuit_id, plan, valid_from, valid_until, source, notes?})
 *     -> LicenseRecord
 *
 * Idempotent by circuit_id (natural key): repeat call with same circuit_id updates
 * the record but preserves issued_at (NF-6 / AC-2).
 * Status of a new or re-issued record is always 'active' (AC-1).
 */
export function issueEntitlement(
  params: IssueParams,
  store: LicenseStore,
  now: Date,
): LicenseRecord {
  const existing = store.getByCircuit(params.circuit_id);

  if (existing) {
    // Upsert: update mutable fields, preserve issued_at (AC-2 / NF-6).
    const updated: LicenseRecord = {
      ...existing,
      plan: params.plan,
      valid_from: params.valid_from,
      valid_until: params.valid_until,
      source: params.source,
      notes: params.notes ?? null,
      status: "active",
    };
    return store.upsert(updated);
  }

  // First issue: generate new id, set issued_at to now (immutable henceforth).
  const rec: LicenseRecord = {
    id: randomUUID(),
    circuit_id: params.circuit_id,
    status: "active",
    plan: params.plan,
    valid_from: params.valid_from,
    valid_until: params.valid_until,
    source: params.source,
    notes: params.notes ?? null,
    issued_at: toRFC3339(now),
    last_signed: null,
    revoked_at: null,
    revoked_by: null,
  };
  return store.upsert(rec);
}

/**
 * Sign a LicenseRecord into a choros-key.v1 wire string.
 *
 * Reuses canonicalPayloadBytes from src/vendor/activation.ts so that the bytes
 * the signer hashes are IDENTICAL to the bytes the verifier hashes (AC-3).
 *
 * vendorPrivKeyPem — PEM bytes of the Ed25519 private key. Passed as argument;
 * NEVER read from file inside this function (NF-2).
 *
 * Throws if record.status === 'revoked' (AC-7).
 *
 * Returns wire string: "choros1.<b64url(payload)>.<b64url(sig)>"
 */
export function signKey(
  record: LicenseRecord,
  vendorPrivKeyPem: string | Buffer,
  _now: Date,
): string {
  if (record.status === "revoked") {
    throw new Error(
      `signKey: cannot sign revoked record for circuit_id=${record.circuit_id}`,
    );
  }

  // Build ActivationKey payload (§1.3 ADR).
  const key: ActivationKey = {
    key_version: "choros-key.v1",
    vendor: "choros",
    circuit_id: record.circuit_id,
    entitlements: record.plan.entitlements,
    issued_at: record.issued_at,
    not_before: record.valid_from,
    not_after: record.valid_until,
  };

  // Canonical bytes — SAME function the verifier uses (AC-3 / AC-4 / AC-5).
  const payloadBytes = canonicalPayloadBytes(key);

  // Ed25519 sign — node:crypto only (NF-4 / AC-15).
  const privKeyObj = createPrivateKey({
    key: Buffer.isBuffer(vendorPrivKeyPem)
      ? vendorPrivKeyPem
      : Buffer.from(vendorPrivKeyPem, "utf8"),
    format: "pem",
  });
  const sig = cryptoSign(null, payloadBytes, privKeyObj);

  // Wire: "choros1.<payload_b64url>.<sig_b64url>"
  return (
    "choros1." +
    payloadBytes.toString("base64url") +
    "." +
    sig.toString("base64url")
  );
}

/**
 * Refresh the wire key for an active circuit: load record, sign, update last_signed.
 *
 * Does NOT change plan, valid_from, valid_until (AC-6).
 * Throws if the record is not found or is revoked (AC-7).
 */
export function refreshKey(
  circuit_id: string,
  vendorPrivKeyPem: string | Buffer,
  store: LicenseStore,
  now: Date,
): string {
  const record = store.getByCircuit(circuit_id);
  if (!record) {
    throw new Error(`refreshKey: no record found for circuit_id=${circuit_id}`);
  }
  if (record.status === "revoked") {
    throw new Error(
      `refreshKey: cannot refresh revoked record for circuit_id=${circuit_id}`,
    );
  }

  const wire = signKey(record, vendorPrivKeyPem, now);

  // Update last_signed without changing other fields (AC-6).
  store.upsert({ ...record, last_signed: toRFC3339(now) });

  return wire;
}

/**
 * Revoke a circuit's entitlement.
 *
 * Sets status='revoked', revoked_at, revoked_by (AC-9).
 * DOES NOT send a kill-signal. DOES NOT invalidate previously issued wire-keys.
 * Physical wire-keys live until not_after in autonomous mode (NF-1 / AC-8).
 */
export function revokeEntitlement(
  circuit_id: string,
  revokedBy: string,
  store: LicenseStore,
  now: Date,
): LicenseRecord {
  const record = store.getByCircuit(circuit_id);
  if (!record) {
    throw new Error(
      `revokeEntitlement: no record found for circuit_id=${circuit_id}`,
    );
  }

  const revoked: LicenseRecord = {
    ...record,
    status: "revoked",
    revoked_at: toRFC3339(now),
    revoked_by: revokedBy,
  };
  return store.upsert(revoked);
}
