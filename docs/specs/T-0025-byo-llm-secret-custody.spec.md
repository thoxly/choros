# Spec · T-0025 — BYO-LLM Secret-Handle Custody

**Title:** E5.5 · `llm_secret_handle` lifecycle — opaque RL-3 handle; platform governs, client hosts; zero platform LLM dependency
**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-11
**Task:** E5.5 — BYO-LLM secret-handle custody. Lifecycle APIs (set/rotate/revoke) for the
`llm_secret_handle` column introduced by T-0020. The handle is an RL-3 opaque token: it references
a client-hosted credential — never a raw API key — satisfying the "platform governs, client hosts"
posture. Day-1 = handle write/read/delete path + shape validation; no LLM call ever originates
from the platform.

**Authoritative sources (do NOT re-open):**
- `playbooks/rbac-backlog.md#E5.5` (GT-1, founder-signed 2026-06-08) — canonical task definition,
  RL-3 citation, "platform governs, client hosts" posture, zero platform-LLM-dep invariant.
- `playbooks/rbac-discovery-phase1-hypothesis.md` §3 Q7 — "per-agent card adds … secret-handle (RL-3)".
- `playbooks/rbac-discovery-kickoff.md` §4.5 — "BYO-агенты, мы НЕ продаём LLM … «Платформа governs,
  клиент hosts». Скрытой LLM-зависимости в платформе нет."
- `docs/design/T-0020-agent-card.adr.md` §4.3 seam "T-0025 (column)" — "T-0025 owns create/rotate/
  revoke and the never-a-raw-key business rule."
- `docs/specs/T-0020-agent-card.spec.md` NF-3 + C-3 — `llm_secret_handle text NULL` is the column;
  T-0025 owns the lifecycle; a raw API key MUST NOT be stored; T-0020 does not DB-enforce this.

**Foundation (do NOT contradict):**
- `migrations/032_agent_card.sql` (T-0020) — `agent_card.llm_secret_handle text NULL` already
  exists. T-0025 does NOT add a column; it owns the write contract on that column.
- `docs/design/T-0013-tenant-isolation.adr.md` — all DB access under `SET LOCAL choros.tenant_id`,
  FORCE RLS, `choros_app` DML only.
- `docs/design/T-0020-agent-card.adr.md` §1.4 — `agent_card` is dormant day-1 (`grep -r agent_card
  src/` = 0). T-0025 breaks dormancy ONLY for the custody write/read path (the handle lifecycle
  endpoints). Dormancy of `autonomy_threshold`/`budget_policy_id` (runtime enforcement) is NOT
  broken by T-0025.
- `docs/design/T-0021-grant-resolver-pdp.adr.md` — the grant resolver is the data-access chokepoint;
  T-0025's write path operates through the provisioning/management-object grant (T-0042 owns the
  full provisioning flow; T-0025 owns only the secret-handle column lifecycle).

**Deps (must be done first):**
- T-0020 (E5.1) — `agent_card` table + `llm_secret_handle` column **[already in dev, migration 032]**

**Downstream consumers (not in scope here):**
- T-0045 (E5.10 / Stage-2) — egress enforcement at agent call-time uses the resolved credential.
- Stage-2 agent runtime — the actual LLM call uses the handle to retrieve the credential
  from the client-hosted location. NOT built here.

**Parallel scoped-out siblings (no overlap):**
- T-0041 (E4.8) — `egress_policy` axis: which data CLASSES may egress to which endpoint pattern.
  T-0025 = credential reference custody; T-0041 = data-class egress policy. Different tables,
  no coupling.
- T-0042 (E5.2) — agent provisioning "hire" flow. T-0025 only provides the handle lifecycle
  primitives that T-0042 MAY call when binding a secret at hire time.

---

## 0. What "secret-handle" means (one screen)

The `llm_secret_handle` column in `agent_card` stores an **opaque reference token** — not a
credential value. The token's format is a structured opaque string that tells the Stage-2 runtime
WHERE to retrieve the actual API key (e.g. `env://LLM_API_KEY`, `vault://secret/choros/agent/recon`,
or an equivalent client-managed scheme). The platform:

- stores the token string (opaque, platform-governs)
- never decodes, validates, or uses the token to make an LLM API call (client-hosts)
- never stores, logs, or transmits the actual credential value

This is the RL-3 "platform governs, client hosts" posture: the platform owns the handle
lifecycle (write, rotate, revoke), while the client owns the secret value and its storage location.

The handle string MUST be structured (not a raw API key) but its internal format is
validated as "not-a-raw-key" by shape heuristics (FR-5), not by parsing a specific scheme.
This keeps the platform LLM-vendor-agnostic.

---

## 1. Summary

Implement the lifecycle write/read/revoke path for `agent_card.llm_secret_handle`:
a `setSecretHandle` / `getSecretHandle` / `revokeSecretHandle` API surface (HTTP or
programmatic — architect decides). Each operation enforces: (a) the caller holds the
management grant for the agent's tenant scope; (b) the submitted handle value passes
RL-3 shape validation (not a raw API key); (c) the column is written/cleared under
tenant-RLS isolation. No LLM API call is ever made by the platform. No raw credential
is ever logged or returned in a response. Day-1: the handle is persisted and retrievable;
Stage-2 runtime (T-0045) resolves it at agent-call-time — out of scope here.

---

## 2. Functional Requirements

### FR-1 — Set handle operation

A `setSecretHandle(tenant_id, agent_employee_id, handle_value)` operation MUST:
1. Verify the caller holds the management grant for `mgmt_object:agent, update` scoped
   to the agent's org scope (same grant path as T-0042 provisioning; exact grant-check
   mechanism is architecture's decision — must use the grant resolver from T-0021).
2. Validate `handle_value` passes FR-5 (not-a-raw-key shape check).
3. Write `handle_value` into `agent_card.llm_secret_handle` for `(tenant_id, agent_employee_id)`.
4. Emit an audit event (`audit_event`) recording: actor, subject (agent_employee_id),
   operation `set_secret_handle`, timestamp — with NO inclusion of `handle_value` in
   the audit row (the handle value MUST NOT appear in audit).
5. Return success/failure; the response MUST NOT echo `handle_value`.

### FR-2 — Rotate handle operation

A `rotateSecretHandle(tenant_id, agent_employee_id, new_handle_value)` operation MUST:
1. Perform the same grant check as FR-1.
2. Validate `new_handle_value` passes FR-5.
3. Overwrite `agent_card.llm_secret_handle` atomically (UPDATE under RLS).
4. Emit an audit event for `rotate_secret_handle` (same rules as FR-1: no value in audit).
5. Return success/failure; response MUST NOT echo the new handle value.

### FR-3 — Revoke handle operation

A `revokeSecretHandle(tenant_id, agent_employee_id)` operation MUST:
1. Perform the same grant check as FR-1.
2. Set `agent_card.llm_secret_handle = NULL` for the specified agent.
3. Emit an audit event for `revoke_secret_handle`.
4. Return success/failure.

### FR-4 — Read handle status (not value)

A `getSecretHandleStatus(tenant_id, agent_employee_id)` operation MUST return whether
a handle is bound (`bound: true/false`) and, if bound, a **redacted summary** (e.g. scheme
prefix or first 8 chars + `...`), NOT the full handle value. The full `llm_secret_handle`
value MUST NOT be returned via any API endpoint to any caller. Reading the raw handle
from the DB for internal Stage-2 use (when resolving a credential) is a Stage-2 concern
and is out of scope here.

### FR-5 — RL-3 handle shape validation (not-a-raw-key guard)

The handle value accepted in FR-1 / FR-2 MUST be rejected if it resembles a raw API key.
Minimum rejection rules (implementation may be stricter):

| Rule | Example pattern rejected |
|---|---|
| Starts with known vendor key prefixes | `sk-`, `sk-proj-`, `xai-`, `AIza` |
| Is a 32+ hex-only string (matches bare hash/token patterns) | `abcdef1234567890abcdef1234567890ab` |
| Is a JWT (three Base64url segments separated by `.`) | `eyJhbGc...` |
| Is shorter than 8 characters | `abc` |

A value that passes this check is stored as-is. The check is a **safeguard** against
accidental raw-key submission, not a complete parser of all secret formats. The platform
does NOT validate that the handle resolves to a real credential (that is the client's
responsibility and Stage-2 concern).

### FR-6 — Zero platform LLM call

No code path in T-0025 (or any code path it introduces) MUST initiate an LLM API call.
The platform MUST be operable with zero LLM credentials configured: all 5 seeded dev
agents have `llm_secret_handle = NULL` (already true per migration 032 seed); null handle
means the agent's LLM capability is not configured (dormant). This is the RL-3 / "zero
platform LLM dep" invariant.

### FR-7 — Tenant isolation for all handle operations

All handle operations MUST execute under `SET LOCAL choros.tenant_id = $tenantId` within
a Postgres transaction, relying on FORCE RLS on `agent_card`. Cross-tenant handle writes
and reads MUST be impossible by construction (same isolation pattern as every T-0013 table).

### FR-8 — Dormancy boundary (no autonomy/budget side effects)

T-0025 breaks `agent_card` dormancy ONLY for the `llm_secret_handle` column. The
`autonomy_threshold` and `budget_policy_id` columns remain dormant (no enforcement path
is added by this task). The grant resolver (T-0021) and engine guard (T-0028) are NOT
modified by T-0025.

---

## 3. Non-Functional Requirements

### NF-1 — No raw credential ever leaves the platform

`handle_value` MUST NOT appear in:
- HTTP response bodies (any endpoint — set, rotate, status, or error)
- Application logs (`console.log`, audit event payload, structured log fields)
- Error messages (stack traces or validation error text MUST NOT echo the submitted value)

### NF-2 — No new LLM dependency introduced

T-0025 MUST NOT add any LLM SDK, LLM client library, or LLM API client to `package.json`
(dependencies or devDependencies). The platform's `node_modules` must remain LLM-free.

### NF-3 — `tsc --noEmit` green, no new lint violations

All new TypeScript code introduced by T-0025 must compile cleanly under the existing
`tsconfig.json` and pass the existing ESLint configuration.

### NF-4 — Audit event for every handle lifecycle operation

Every `setSecretHandle`, `rotateSecretHandle`, and `revokeSecretHandle` call MUST produce
an `audit_event` row (T-0016 append-only table, schema: `type, actor, subject, scope, via,
proposed_by, confirmed_by, tenant_seq, prev_state_hash`). The `type` field MUST be one of:
`set_llm_secret_handle`, `rotate_llm_secret_handle`, `revoke_llm_secret_handle`.
The `subject` MUST be the `agent_employee_id`. The handle value MUST NOT appear in any
field of the audit row.

### NF-5 — Migration seam

T-0025 does NOT add a migration (the `llm_secret_handle` column already exists from
migration 032). If a migration is needed for auxiliary schema (e.g. an index — architect
decides), migration 033 is available (unallocated as of 2026-06-11; T-0023 owns 034-035).
If T-0025 requires no migration, migration 033 remains available for future use.

### NF-6 — No changes to frozen files

T-0025 MUST NOT modify `src/core/object-handle.ts`, `src/core/grant-lattice.ts`, or any
file currently listed in `mutation-gateway-isolation.sh` FROZEN_EXPORTS without explicit
architect instruction. The handle lifecycle path MUST compose existing primitives.

---

## 4. Explicit Out of Scope

- Resolving the handle to an actual LLM API credential at agent call-time (Stage-2, T-0045).
- Making any LLM API call (zero platform LLM dep — see FR-6).
- Agent provisioning hire flow (T-0042 owns that; T-0025 provides primitives T-0042 may call).
- Autonomy threshold / budget enforcement (Stage-2, E5.7/E5.9).
- A2A call-graph breakers (Stage-2, E5.8).
- Data-egress policy enforcement (Stage-2, T-0045 / E5.10).
- The `egress_policy` table (T-0041).
- JWT → employee resolution (T-0060).
- Storage of the actual LLM API credential anywhere in the platform.
- Client-side secret management (Vault, env, secrets manager) — the client owns that.
- Validating that a stored handle actually resolves (the platform trusts the client's handle).
- UI for handle management (if there is a management UI, it is the frontend concern; this spec
  covers the API contract only).

---

## 5. Downstream frozen contracts (consumed by siblings)

### C-1 · T-0042 (agent provisioning)

When T-0042 hires an agent, it MAY call `setSecretHandle` to bind a handle at hire time.
It MUST pass a value that satisfies FR-5. If no handle is provided at hire time,
`llm_secret_handle` remains NULL (already the seeded state).

### C-2 · T-0045 (Stage-2 egress enforcement)

At Stage-2 agent call-time, T-0045 reads `agent_card.llm_secret_handle` directly from
the DB (it does NOT use the FR-4 status API). The value it reads is the opaque token;
T-0045 is responsible for resolving it to the actual credential in the client-hosted
environment. T-0025's RL-3 guard ensures the token is never a raw credential, so T-0045
can trust the column is "an opaque reference, not a secret value."

### C-3 · Audit consumers

Downstream audit readers MUST NOT expect `handle_value` in any audit field; they MUST
NOT assume the full handle value is recoverable from audit history. The audit trail records
THAT a handle lifecycle event occurred, not WHAT the handle value is.

---

## 6. Acceptance Criteria

| ID | Text | Verifiable as |
|---|---|---|
| AC-1 | `setSecretHandle(tenant, agentId, value)` with a valid handle value writes `llm_secret_handle` in `agent_card` for that agent and returns success; subsequent DB read confirms non-NULL value stored. | test |
| AC-2 | `setSecretHandle` called with a value starting with `sk-` is rejected with an error and `agent_card.llm_secret_handle` remains unchanged. | test |
| AC-3 | `setSecretHandle` called with a value starting with `sk-proj-` is rejected. | test |
| AC-4 | `setSecretHandle` called with a 32-character hex string is rejected (bare token heuristic). | test |
| AC-5 | `setSecretHandle` called with a well-formed JWT (`eyJ…`) is rejected. | test |
| AC-6 | `setSecretHandle` called with a value shorter than 8 characters is rejected. | test |
| AC-7 | `rotateSecretHandle(tenant, agentId, newValue)` overwrites the previous handle value atomically; the previous value is not readable after rotation. | test |
| AC-8 | `revokeSecretHandle(tenant, agentId)` sets `llm_secret_handle = NULL`; a subsequent status call returns `{bound: false}`. | test |
| AC-9 | `getSecretHandleStatus(tenant, agentId)` returns `{bound: true}` when a handle is set, and the full handle value is NOT present in the response object. | test |
| AC-10 | A cross-tenant `setSecretHandle` call (caller's tenant_id ≠ agent's tenant_id) is rejected; `agent_card` of the target tenant is unmodified. | test |
| AC-11 | Every `setSecretHandle` call (success and rejection) produces NO log line containing the submitted handle value (checked against stdout/stderr captured in test). | test |
| AC-12 | Every successful `setSecretHandle` call produces an `audit_event` row with `type = 'set_llm_secret_handle'`, `subject = agent_employee_id`; the audit row contains NO field with the handle value. | test |
| AC-13 | Every successful `rotateSecretHandle` call produces an `audit_event` row with `type = 'rotate_llm_secret_handle'`; no handle value in audit row. | test |
| AC-14 | Every successful `revokeSecretHandle` call produces an `audit_event` row with `type = 'revoke_llm_secret_handle'`. | test |
| AC-15 | `package.json` (dependencies + devDependencies) contains no LLM SDK or LLM API client package (e.g. `openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, `mistralai`). Verified by: `cat package.json | grep -E 'openai|anthropic|generative-ai|mistralai|cohere|groq'` returns empty. | fitness |
| AC-16 | `grep -r 'llm_secret_handle' src/` returns matches ONLY in files introduced or modified by T-0025 (no dormancy leak into unrelated modules). | fitness |
| AC-17 | `tsc --noEmit` and `eslint` are green after T-0025 changes. | fitness |
| AC-18 | `setSecretHandle` called without sufficient management grant (`mgmt_object:agent, update`) is rejected with an authorization error; `agent_card` is unchanged. | test |
| AC-19 | All 5 dev-seeded agents retain `llm_secret_handle = NULL` after T-0025 code is merged (no accidental seed mutation). | fitness |

---

## 7. BLOCKING questions

**None.** All design decisions are derivable from the founder-signed backlog (GT-1, 2026-06-08):
- "Never a raw key" invariant: RL-3 + T-0020 spec NF-3/C-3 (ratified, autonomous implementation).
- "Platform governs, client hosts" posture: kickoff §4.5 (signed by D-C / GT-1).
- Audit requirement: E2.8 audit floor (day-1, ratified).
- Handle shape validation rules: conservative implementation of RL-3; the exact heuristics are
  implementation detail (analyst range: reject obvious raw keys, not parse all possible schemes).
- Migration: no new column needed (032 already has `llm_secret_handle`); 033 reserved if index needed.
- Dormancy boundary: T-0020 spec FR-6 + NF-6 establishes the boundary; T-0025 breaks dormancy
  only for the custody write path (not runtime).

Status: **ready** — no founder escalation required.
