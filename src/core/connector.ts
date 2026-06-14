/**
 * src/core/connector.ts — T-0128 / T-0206
 *
 * Connector / integration entity — v1 STUB for future 1С / Active Directory /
 * email / generic-HTTP connectors. Data-model placeholder only; the per-connector
 * driver implementation is per-first-client and OUT OF SCOPE (Stage-2).
 *
 * DESIGN INVARIANTS (ADR docs/design/T-0128-connector-entity.adr.md §2/§4/§6):
 *  - Pure-core / no live effects (FF-CONN-2): NO pg/fs/net/http(s)/fetch/child_process
 *    imports. All IO behind injected ports (ConnectorWritePort, AuditWriter, clock).
 *  - One custody mechanism (FF-CONN-3): validateSecretHandleShape + redactHandle are
 *    IMPORTED from secret-handle-validator.ts, never redeclared (T-0025).
 *  - Audit without secret (FF-CONN-8): audit_event payload carries
 *    kind/display_name/status/backs_effect_resource_id — NEVER the secret_handle or any
 *    resolved secret.
 *  - One authority mechanism (FF-CONN-1): NO connector ACL / visibility surface. The
 *    right to INVOKE a connector is an `invoke` grant on an effect_resource (T-0034);
 *    `backsEffectResourceId` is a declarative logical link, NOT used in authz.
 *  - Closed-kind fail-closed (FF-CONN-5): isConnectorKind is the single source of truth
 *    for the kind set; an unknown kind is rejected with no write.
 *  - Seam without driver (FF-CONN-4): ConnectorSecretResolverPort / ConnectorDriverPort
 *    are TYPES only — day-1 there is NO class implementing ConnectorDriverPort and no
 *    real external call from any connector code-path.
 *
 * Semantic contract: docs/design/T-0128-connector-entity.adr.md §3/§4/§5.
 */

import { randomUUID } from "node:crypto";

// RL-3 custody — IMPORTED, NOT redeclared (T-0025 / FF-CONN-3)
import {
  validateSecretHandleShape,
  redactHandle,
  type SecretResolverPort,
} from "./secret-handle-validator.js";

// Audit types
import type { AuditWriter, PgClientLike } from "../db/audit-writer.js";
import type { AuditEventInput } from "./audit-grant-encoder.js";

// ---------------------------------------------------------------------------
// Closed kind / status axes (mirror EffectKind closed-set приём — T-0034)
// ---------------------------------------------------------------------------

/**
 * Closed connector-kind axis (FR-2 / AC-2). Adding a kind = migration CHECK + this
 * union. An unknown kind fails closed (no string cast widens it).
 */
export type ConnectorKind = "1c" | "ad_ldap" | "smtp" | "http_generic";

/** Total predicate over the closed kind set. */
export function isConnectorKind(v: unknown): v is ConnectorKind {
  return v === "1c" || v === "ad_ldap" || v === "smtp" || v === "http_generic";
}

/**
 * Declarative connector status (FR-4). Day-1 it is set by CRUD/admin, NEVER by a live
 * probe (a probe = an external call = an NF-2 violation). A connector is born 'disabled'.
 */
export type ConnectorStatus = "configured" | "disabled" | "error";

/** Total predicate over the closed status set. */
export function isConnectorStatus(v: unknown): v is ConnectorStatus {
  return v === "configured" || v === "disabled" || v === "error";
}

// ---------------------------------------------------------------------------
// Domain record — mirrors choros.connector (migration 054)
// ---------------------------------------------------------------------------

/** Domain record mirroring choros.connector (migration 054). */
export interface Connector {
  readonly tenantId: string;
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly displayName: string;
  /** Opaque jsonb config (host/port/db/realm/base_url). NEVER read in authz. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Opaque RL-3 handle (T-0025). NOT a raw secret. null = no secret bound yet. */
  readonly secretHandle: string | null;
  readonly status: ConnectorStatus;
  /** Declarative logical link to the effect_resource this connector backs (T-0034). */
  readonly backsEffectResourceId: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedBy: string;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Ports (IO behind injection — NF-5 / FF-CONN-2)
// ---------------------------------------------------------------------------

/**
 * Write port for choros.connector. Production impl = PgConnectorStore
 * (src/core/postgres/pgConnectorStore.ts, mirrors pgEmailConfigStore.ts). In tests: fake.
 * Caller MUST have SET choros.tenant_id GUC (RLS + FORCE enforce isolation).
 */
export interface ConnectorWritePort {
  insert(c: Connector): Promise<void>;
  update(c: Connector): Promise<void>;
  get(tenantId: string, id: string): Promise<Connector | null>;
  list(tenantId: string): Promise<Connector[]>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

/**
 * Seam #1 — secret resolver (Stage-2). Structurally compatible with T-0025
 * SecretResolverPort (compile-time _assert below). Day-1: NO production impl is wired
 * into any connector code-path.
 */
export interface ConnectorSecretResolverPort {
  resolveSecret(handle: string, ctx: { tenantId: string }): Promise<string>;
}

/** Request shape for a Stage-2 driver invocation (TYPE ONLY — no day-1 impl). */
export interface ConnectorInvokeRequest {
  readonly op: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** Result shape for a Stage-2 driver invocation (TYPE ONLY — no day-1 impl). */
export interface ConnectorInvokeResult {
  readonly ok: boolean;
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Seam #2 — driver port (Stage-2). Day-1 there is NO class implementing this port and
 * no real external call (FF-CONN-4). It exists only to fix the future driver shape.
 */
export interface ConnectorDriverPort {
  readonly kind: ConnectorKind;
  /** Stage-2 only. Day-1 there is NO class implementing this. */
  invoke(
    req: ConnectorInvokeRequest,
    ctx: { tenantId: string },
  ): Promise<ConnectorInvokeResult>;
}

// ---------------------------------------------------------------------------
// CRUD result + inputs
// ---------------------------------------------------------------------------

export type SetConnectorResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: string };

export interface SetConnectorInput {
  /** absent → create (new uuid); present → update existing. */
  readonly id?: string;
  /** validated by isConnectorKind → fail-closed on unknown kind. */
  readonly kind: ConnectorKind;
  readonly displayName: string;
  readonly config?: Record<string, unknown>;
  /** if present → validateSecretHandleShape BEFORE any write (RL-3 shape-guard). */
  readonly secretHandle?: string;
  /** declarative; default 'disabled' on create. */
  readonly status?: ConnectorStatus;
  readonly backsEffectResourceId?: string | null;
  /** actor performing the operation (for audit). */
  readonly actor: string;
}

interface ConnectorDeps {
  store: ConnectorWritePort;
  auditWriter: AuditWriter;
  tx: PgClientLike;
  clock: { now: () => number };
}

// ---------------------------------------------------------------------------
// Status view with REDACTED handle (never the raw handle — FF-CONN-3)
// ---------------------------------------------------------------------------

export interface ConnectorStatusView {
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly displayName: string;
  readonly config: Readonly<Record<string, unknown>>;
  /** redactHandle(secretHandle) | null if unbound — NEVER the raw handle. */
  readonly handleRedacted: string | null;
  readonly secretBound: boolean;
  readonly status: ConnectorStatus;
  readonly backsEffectResourceId: string | null;
  readonly updatedBy: string;
  readonly updatedAt: number;
}

function toStatusView(c: Connector): ConnectorStatusView {
  return {
    id: c.id,
    kind: c.kind,
    displayName: c.displayName,
    config: c.config,
    handleRedacted: c.secretHandle === null ? null : redactHandle(c.secretHandle),
    secretBound: c.secretHandle !== null,
    status: c.status,
    backsEffectResourceId: c.backsEffectResourceId,
    updatedBy: c.updatedBy,
    updatedAt: c.updatedAt,
  };
}

/**
 * Audit payload — config-only shape. The secret_handle and any resolved secret are
 * NEVER included (FF-CONN-8 / T-0025 NF-1).
 */
function connectorAuditPayload(c: Connector): Record<string, unknown> {
  return {
    kind: c.kind,
    display_name: c.displayName,
    status: c.status,
    backs_effect_resource_id: c.backsEffectResourceId,
    // secret_handle intentionally ABSENT — FF-CONN-8 / ADR §4.3
  };
}

async function emitAudit(
  deps: ConnectorDeps,
  type: string,
  tenantId: string,
  actor: string,
  subject: string,
  payload: Record<string, unknown>,
  now: number,
): Promise<void> {
  const auditInput: AuditEventInput = {
    id: randomUUID(),
    type,
    actor,
    subject,
    scope: null,
    via: null,
    proposed_by: null,
    confirmed_by: null,
    payload,
    occurred_at: now,
  };
  await deps.auditWriter.appendAuditEvent(deps.tx, auditInput);
}

// ---------------------------------------------------------------------------
// setConnector — create/update (shape-guard + write + audit)
// ---------------------------------------------------------------------------

/**
 * Create (no id) or update (id present) a connector.
 *
 * fail-closed (FF-CONN-5): unknown kind → {ok:false} with NO write.
 * RL-3 shape-guard (FF-CONN-3): if secretHandle is present it MUST pass
 *   validateSecretHandleShape BEFORE any write; a raw vendor key/JWT/bare-hex →
 *   {ok:false, reason} with NO write, NO audit.
 * Audit (FF-CONN-8): emits 'connector.set' with config-only payload (NO secret).
 */
export async function setConnector(
  deps: ConnectorDeps,
  tenantId: string,
  input: SetConnectorInput,
): Promise<SetConnectorResult> {
  // Fail-closed on unknown kind (defensive even though the type narrows it; an
  // untrusted HTTP boundary may pass a widened string).
  if (!isConnectorKind(input.kind)) {
    return { ok: false, reason: `unknown connector kind` };
  }
  if (input.status !== undefined && !isConnectorStatus(input.status)) {
    return { ok: false, reason: `unknown connector status` };
  }

  // RL-3 shape-guard BEFORE any write.
  if (input.secretHandle !== undefined) {
    const verdict = validateSecretHandleShape(input.secretHandle);
    if (!verdict.ok) {
      return { ok: false, reason: `secret_handle rejected: ${verdict.reason}` };
    }
  }

  const now = deps.clock.now();
  const isUpdate = input.id !== undefined;

  if (isUpdate) {
    const existing = await deps.store.get(tenantId, input.id as string);
    if (existing === null) {
      return { ok: false, reason: "not_found" };
    }
    const updated: Connector = {
      tenantId,
      id: existing.id,
      kind: input.kind,
      displayName: input.displayName,
      config: input.config ?? existing.config,
      // If secretHandle omitted on update, keep the existing handle (rotate via the
      // dedicated rotateConnectorSecret path); if provided, it already passed shape-guard.
      secretHandle: input.secretHandle ?? existing.secretHandle,
      status: input.status ?? existing.status,
      backsEffectResourceId:
        input.backsEffectResourceId !== undefined
          ? input.backsEffectResourceId
          : existing.backsEffectResourceId,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedBy: input.actor,
      updatedAt: now,
    };
    await deps.store.update(updated);
    await emitAudit(
      deps,
      "connector.set",
      tenantId,
      input.actor,
      updated.id,
      connectorAuditPayload(updated),
      now,
    );
    return { ok: true, id: updated.id };
  }

  const created: Connector = {
    tenantId,
    id: randomUUID(),
    kind: input.kind,
    displayName: input.displayName,
    config: input.config ?? {},
    secretHandle: input.secretHandle ?? null,
    status: input.status ?? "disabled",
    backsEffectResourceId: input.backsEffectResourceId ?? null,
    createdBy: input.actor,
    createdAt: now,
    updatedBy: input.actor,
    updatedAt: now,
  };
  await deps.store.insert(created);
  await emitAudit(
    deps,
    "connector.set",
    tenantId,
    input.actor,
    created.id,
    connectorAuditPayload(created),
    now,
  );
  return { ok: true, id: created.id };
}

// ---------------------------------------------------------------------------
// rotateConnectorSecret — rotate the secret (shape-guard + write + audit)
// ---------------------------------------------------------------------------

/**
 * Rotate the connector secret. The new handle MUST pass validateSecretHandleShape
 * BEFORE any write. Emits 'connector.rotate' (NO secret in payload). {ok:false,
 * reason:'not_found'} if the connector is absent.
 */
export async function rotateConnectorSecret(
  deps: ConnectorDeps,
  tenantId: string,
  id: string,
  newSecretHandle: string,
  actor: string,
): Promise<SetConnectorResult> {
  const verdict = validateSecretHandleShape(newSecretHandle);
  if (!verdict.ok) {
    return { ok: false, reason: `secret_handle rejected: ${verdict.reason}` };
  }

  const existing = await deps.store.get(tenantId, id);
  if (existing === null) {
    return { ok: false, reason: "not_found" };
  }

  const now = deps.clock.now();
  const rotated: Connector = {
    ...existing,
    secretHandle: newSecretHandle,
    updatedBy: actor,
    updatedAt: now,
  };
  await deps.store.update(rotated);
  await emitAudit(
    deps,
    "connector.rotate",
    tenantId,
    actor,
    rotated.id,
    connectorAuditPayload(rotated),
    now,
  );
  return { ok: true, id: rotated.id };
}

// ---------------------------------------------------------------------------
// revokeConnector — delete + audit
// ---------------------------------------------------------------------------

/**
 * Revoke (delete) a connector. Emits 'connector.revoke'. {ok:false,reason:'not_found'}
 * if the connector does not exist.
 */
export async function revokeConnector(
  deps: ConnectorDeps,
  tenantId: string,
  id: string,
  actor: string,
): Promise<SetConnectorResult> {
  const deleted = await deps.store.delete(tenantId, id);
  if (!deleted) {
    return { ok: false, reason: "not_found" };
  }
  const now = deps.clock.now();
  await emitAudit(
    deps,
    "connector.revoke",
    tenantId,
    actor,
    id,
    { /* only actor/tenant/subject in revoke — no config data needed */ },
    now,
  );
  return { ok: true, id };
}

// ---------------------------------------------------------------------------
// Read views (redacted handle — never the raw handle)
// ---------------------------------------------------------------------------

/** Status view for a single connector (REDACTED handle). null if absent. */
export async function getConnectorStatus(
  store: ConnectorWritePort,
  tenantId: string,
  id: string,
): Promise<ConnectorStatusView | null> {
  const c = await store.get(tenantId, id);
  if (c === null) return null;
  return toStatusView(c);
}

/** List all connectors for a tenant as status views (REDACTED handles). */
export async function listConnectors(
  store: ConnectorWritePort,
  tenantId: string,
): Promise<ConnectorStatusView[]> {
  const rows = await store.list(tenantId);
  return rows.map(toStatusView);
}

// ---------------------------------------------------------------------------
// Compile-time seam compatibility (FF-CONN-4)
// ---------------------------------------------------------------------------

// Verify ConnectorSecretResolverPort is structurally compatible with T-0025
// SecretResolverPort at compile time. This declaration is INTENTIONALLY unused — it
// is a compile-time type assertion only (mirrors notification-email.ts:453).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare function _assertConnResolverCompat(
  p: ConnectorSecretResolverPort,
): SecretResolverPort;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _connResolverCompatCheck: typeof _assertConnResolverCompat = (p) =>
  p as SecretResolverPort;
