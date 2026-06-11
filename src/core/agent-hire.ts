/**
 * src/core/agent-hire.ts — T-0042 (E5.2): Pure agent-hire core.
 *
 * PURE: no pg/fs/net/http import. All IO is behind injected interfaces.
 *
 * Exports:
 *   KeycloakAdminPort — the ONLY new IO boundary (NF-7 / ADR §3.2)
 *   KcClientSpec      — the spec passed to createServiceAccountClient
 *   deriveKcClientId  — deterministic clientId derivation (ADR §3.3)
 *   buildAgentHirePlan — pure plan builder (no auth / no IO)
 *   AgentHirePlan      — immutable plan consumed by HTTP + DAO
 *   AgentHireInput     — validated request shape
 *   AgentHireAuditEvent / encodeAgentHireAuditEvent — audit encoder seam
 *
 * Identity ⊥ rights: kc_client_id is an identity artifact; the rights layer
 * (grant-resolver, mcp-tool-registry) keys ONLY on employee_id (FR-4, AC-9).
 */

import { randomUUID } from "node:crypto";
import type { ScopeElement } from "./grant-lattice.js";
import type { AuditEventInput } from "./audit-grant-encoder.js";

// ---------------------------------------------------------------------------
// Keycloak Admin Port — the ONLY new IO boundary (NF-7, ADR §3.2)
// ---------------------------------------------------------------------------

/** Specification passed to the Keycloak Admin port when creating a new service account. */
export interface KcClientSpec {
  clientId: string;                      // = deriveKcClientId(slug)
  serviceAccountsEnabled: true;
  standardFlowEnabled: false;
  directAccessGrantsEnabled: false;      // client_credentials only (FR-3)
  actorType: "agent";                    // attribute on service-account user (FR-3)
  devSecret?: string;                    // dev only; prod secret founder-held (NF-6)
}

/**
 * The injected Keycloak Admin port interface.
 * The live HTTP adapter lives in src/keycloak/admin-port.ts.
 * The in-memory fake lives in src/keycloak/fake-admin-port.ts.
 * The pure core (this file) imports ONLY this interface.
 */
export interface KeycloakAdminPort {
  /** Create a confidential OIDC client with service accounts enabled. */
  createServiceAccountClient(spec: KcClientSpec): Promise<{ clientId: string }>;
  /** Best-effort orphan cleanup — called if DB commit fails after KC create (NF-4). */
  deleteClient(clientId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// deriveKcClientId — deterministic, pure (ADR §3.3)
// ---------------------------------------------------------------------------

const KC_ID_MAX_LEN = 100; // conservative Keycloak client-id length limit

/**
 * Derive a Keycloak clientId from an agent slug.
 * Rule: "agent-" + lowercase(slug) with non-[a-z0-9-] replaced by "-",
 * consecutive dashes collapsed, leading/trailing dashes trimmed, length-capped.
 * The result is always a valid Keycloak clientId. The DB UNIQUE constraint
 * on (tenant_id, kc_client_id) is the conflict enforcement seam.
 */
export function deriveKcClientId(slug: string): string {
  const normalized = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = `agent-${normalized || "unnamed"}`;
  return base.slice(0, KC_ID_MAX_LEN);
}

// ---------------------------------------------------------------------------
// AgentHireInput — validated request shape (ADR §3.3)
// ---------------------------------------------------------------------------

export interface AgentHireInput {
  tenantId: string;
  positionId: string;
  slug: string;
  displayName: string;
  llmEndpoint?: string | null;
  llmModel?: string | null;
  llmSecretHandle?: string | null;
  autonomyThreshold?: number | null;
  nowMs: number;
}

// ---------------------------------------------------------------------------
// AgentHirePlan — immutable plan produced by buildAgentHirePlan (ADR §3.3)
// ---------------------------------------------------------------------------

export interface AgentHirePlan {
  employee: {
    tenantId: string;
    id: string;          // new UUID
    positionId: string;
    kind: "agent";
    slug: string;
    displayName: string;
    createdAt: number;
    updatedAt: number;
  };
  agentCard: {
    tenantId: string;
    employeeId: string;
    employeeKind: "agent";
    kcClientId: string;
    llmEndpoint: string | null;
    llmModel: string | null;
    llmSecretHandle: string | null;
    autonomyThreshold: number | null;
    budgetPolicyId: null;
    escalationRuleId: null;
    createdAt: number;
    updatedAt: number;
  };
  kcSpec: KcClientSpec;
}

/**
 * buildAgentHirePlan — pure, no auth/IO.
 * Validates the request shape and produces the immutable plan.
 * The DB UNIQUE constraint is the conflict enforcement seam for kc_client_id.
 */
export function buildAgentHirePlan(input: AgentHireInput): AgentHirePlan {
  if (!input.tenantId) throw new Error("tenantId is required");
  if (!input.positionId) throw new Error("positionId is required");
  if (!input.slug) throw new Error("slug is required");
  if (!input.displayName) throw new Error("displayName is required");

  const employeeId = randomUUID();
  const kcClientId = deriveKcClientId(input.slug);
  const nowMs = input.nowMs;

  return {
    employee: {
      tenantId: input.tenantId,
      id: employeeId,
      positionId: input.positionId,
      kind: "agent",
      slug: input.slug,
      displayName: input.displayName,
      createdAt: nowMs,
      updatedAt: nowMs,
    },
    agentCard: {
      tenantId: input.tenantId,
      employeeId,
      employeeKind: "agent",
      kcClientId,
      llmEndpoint: input.llmEndpoint ?? null,
      llmModel: input.llmModel ?? null,
      llmSecretHandle: input.llmSecretHandle ?? null,
      autonomyThreshold: input.autonomyThreshold ?? null,
      budgetPolicyId: null,
      escalationRuleId: null,
      createdAt: nowMs,
      updatedAt: nowMs,
    },
    kcSpec: {
      clientId: kcClientId,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      actorType: "agent",
    },
  };
}

// ---------------------------------------------------------------------------
// AgentHireAuditEvent + encoder — hire audit seam (FR-6, ADR §3.3)
// ---------------------------------------------------------------------------

/** The hire audit event shape (maps to AuditEventInput type: "agent.hire"). */
export interface AgentHireAuditEvent {
  actor: string;           // caller's employee_id (FR-6)
  subject: string;         // new agent's employee_id
  capability: { resourceType: "mgmt_object:agent"; operation: "create" };
  scope: ScopeElement;     // admitting org-scope from the admin's covering grant
}

/**
 * Encode an AgentHireAuditEvent to AuditEventInput.
 * Called inside withTenantTx — the result is passed verbatim to appendAuditEvent.
 */
export function encodeAgentHireAuditEvent(
  e: AgentHireAuditEvent,
  nowMs: number,
  idOverride?: string,
): AuditEventInput {
  return {
    id: idOverride ?? randomUUID(),
    type: "agent.hire",
    actor: e.actor,
    subject: e.subject,
    scope: e.scope as unknown,
    via: null,
    proposed_by: null,
    confirmed_by: null,
    payload: {
      resourceType: e.capability.resourceType,
      operation: e.capability.operation,
    },
    occurred_at: nowMs,
  };
}
