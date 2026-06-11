# ADR · T-0025 — BYO-LLM Secret-Handle Custody (E5.5)

**Phase:** DESIGN. **Status:** `ready` (no founder gate — GT-1 signed E5.5 day-1, 2026-06-08).
**Machine contract:** `docs/design/T-0025.adr.contract.json` (schema `schemas/adr.schema.json`).
**Spec in:** `docs/specs/T-0025-byo-llm-secret-custody.spec.md` + `.spec.contract.json` (19 AC).
**Parallel sibling:** T-0039 (LLM-proposes-grants) — its `resolveSecret` injected port (ADR §2.2)
is **the consumer of this task's custody primitive**. §8 below defines the shared seam *as a
contract*, with zero same-file edits (FE-0006/0007).

---

## 0. One-paragraph decision

T-0025 adds the `llm_secret_handle` lifecycle as **two new, isolated files plus one pure validator** —
no edit to any frozen file, no edit to `grants.ts`. (1) A **pure, IO-free validator**
`src/core/secret-handle-validator.ts` exports `validateSecretHandleShape(value): SecretHandleVerdict`
encoding the RL-3 not-a-raw-key heuristics (FR-5) and `redactHandle(value): string` for the
status-summary (FR-4); it has zero `pg`/`fetch`/`http` imports so it is unit-testable and CI-frozen
as logic-only. (2) A **route module** `src/http/secret-handle.ts` exports
`registerSecretHandleRoutes(router, pool)` implementing `set`/`rotate`/`revoke`/`status` over
`agent_card.llm_secret_handle`, each: (a) authenticated via the existing `extractActor` + DEV_TENANT
seam, (b) authorized by reusing `loadAdminContext` and requiring a covering, confirmed, in-window,
delegable `mgmt_object:agent` grant with `operation:"update"` over the agent's org scope — **no new
authority logic, `scoped-admin.ts` untouched** (§4), (c) executed inside the **same `withTenantTx`
SET-LOCAL + FORCE-RLS pattern** as `grants.ts` (the helper is duplicated into the module by the same
"write-path needs own transaction" precedent, FR-7), and (d) audited through the **canonical**
`appendAuditEventInput` sink with an `AuditEventInput` whose `payload` and every field **never carries
the handle value** (NF-1/NF-4). The handle is stored **as-is** after passing the shape guard; the
platform never decodes it, never resolves it, never makes an LLM call (FR-6) — that resolution is the
**injected `resolveSecret` port** consumed by T-0039 and implemented for real at Stage-2 / T-0045
(§8). **No new table, no new migration** (column exists from `032`; no index needed day-1 — §6).

---

## 1. Context inherited (do not rebuild)

- `migrations/032_agent_card.sql` (T-0020) — `choros.agent_card(tenant_id, employee_id,
  employee_kind, kc_client_id, llm_endpoint, llm_model, llm_secret_handle text NULL,
  autonomy_threshold, budget_policy_id, escalation_rule_id, created_at, updated_at)`. PK
  `(tenant_id, employee_id)`. `ENABLE + FORCE ROW LEVEL SECURITY`, policy on
  `current_setting('choros.tenant_id', true)::uuid`, `GRANT … TO choros_app`. **All 5 dev-seeded
  agents have `llm_secret_handle = NULL`** (FR-6/AC-19). T-0025 adds NO column.
- `src/http/grants.ts` — the **pattern source** (NOT a file T-0025 edits):
  - `withTenantTx(pool, tenantId, fn)` (lines 112–134): `BEGIN; SET LOCAL choros.tenant_id='…';
    SET LOCAL search_path TO choros; … COMMIT/ROLLBACK`, with `assertUuidShape` defence-in-depth.
  - `extractActor(req)` (lines 978–986): reads `x-dev-user` header, `401 UNAUTHENTICATED` if absent.
  - `UUID_RE` / `assertUuidShape` (lines 103–110): UUID validation idiom.
  - `appendAuditEventInput(client, tenantId, input)` (lines 229–235): routes a pre-built
    `AuditEventInput` through the **single canonical** `makePgAuditWriter().appendAuditEvent` sink
    (NF-7 — no parallel audit path). T-0025 mirrors this one-liner.
  - `DEV_TENANT_ID`, `HttpError(status, code, message)`, `readJsonBody(req)`.
- `src/db/org.ts::loadAdminContext(pool, tenantId, actorEmployeeId, nowMs)` (lines 307+) — returns
  `AdminContext { isGenesisOwner, adminGrants: Grant[], adminOrgScope: ScopeElement }`: the confirmed,
  in-window, delegable `mgmt_object:*` grants reachable through the actor's assignments, plus the
  org ceiling. **The authority primitive T-0025 reuses verbatim** (FR-1.1 / AC-18).
- `src/core/scoped-admin.ts` — `MGMT_OBJECT_KINDS` already includes `"mgmt_object:agent"`;
  `validateAdminDelegation(admin, target, oracle)` and `isNarrowerOrEqual(a, b, oracle)` are exported,
  PURE. **Frozen by `scoped-admin-isolation.sh` (FF-11 / T-0029); untouched by T-0025 (NF-6).**
- `src/core/audit-grant-encoder.ts::AuditEventInput` — `{ id, type, actor, subject:string|null,
  scope:unknown|null, via:string|null, proposed_by:string|null, confirmed_by:string|null,
  payload:unknown, occurred_at:number }`. The contractual seam; T-0025 builds one of these directly
  (no encoder change — the handle ops are not grant rows). Precedent: `lifecycle-audit.ts` builds
  informational (non-grant) `AuditEventInput`s the same way.
- `src/db/audit-writer.ts::makePgAuditWriter().appendAuditEvent(tx, input)` — canonical, length-
  prefixed/JCS over all 14 fields, seed-head serialized. Reached only via `appendAuditEventInput`.
- `src/server.ts` — route registration site; T-0025 adds one `registerSecretHandleRoutes(router,
  grantsPool)` call alongside `registerGrantsRoutes` (§7).

---

## 2. Mechanism

### 2.1 Pure validator `src/core/secret-handle-validator.ts` (FR-5 / FR-4)

A **logic-only** module (zero IO imports) so the not-a-raw-key heuristic is unit-tested in isolation
and provably free of network/DB/LLM reach (FF-25-1):

```ts
export type SecretHandleVerdict =
  | { ok: true }
  | { ok: false; reason: SecretHandleRejectReason };

export type SecretHandleRejectReason =
  | "too_short"            // < 8 chars (FR-5 row 4)
  | "vendor_key_prefix"    // sk- | sk-proj- | xai- | AIza (FR-5 row 1)
  | "bare_hex_token"       // ^[0-9a-fA-F]{32,}$ (FR-5 row 2)
  | "jwt_shape";           // eyJ… three Base64url dot-segments (FR-5 row 3)

// PURE. No IO. Rejects values that resemble a raw API key. A passing value is
// stored AS-IS; this is a SAFEGUARD, not a parser of all secret schemes.
export function validateSecretHandleShape(value: string): SecretHandleVerdict;

// Redacted summary for FR-4 status (e.g. scheme prefix or first 8 chars + "…").
// NEVER returns the full value. Used ONLY by the status endpoint.
export function redactHandle(value: string): string;
```

**Rejection order (most-specific first; the reason string is part of the contract for tests):**

1. `value.length < 8` → `too_short` (AC-6).
2. starts with `sk-`, `sk-proj-`, `xai-`, or `AIza` → `vendor_key_prefix` (AC-2/AC-3). *(Note: `sk-proj-`
   is a prefix of `sk-` — both rejected by the `sk-` test; the rule list is the contract, the
   implementation may collapse them.)*
3. `/^[0-9a-fA-F]{32,}$/.test(value)` → `bare_hex_token` (AC-4). *(A 32-char hex string is rejected;
   the `{32,}` lower bound matches the spec's "32+ hex".)*
4. JWT shape: three non-empty Base64url segments separated by `.` **and** the first segment decodes/
   begins with the `eyJ` JOSE-header marker → `jwt_shape` (AC-5). The conservative test is
   `/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/` (signature segment may be empty for an
   unsigned JWT). A value that merely contains dots but is not `eyJ…`-shaped is **accepted** (handle
   schemes like `vault://secret/x.y` must survive — the guard targets JWTs, not all dotted strings).

The validator **does not** validate that the handle resolves to a real credential (out of scope §4).

### 2.2 Route module `src/http/secret-handle.ts` (FR-1/2/3/4/7/8)

A **separate module** exporting `registerSecretHandleRoutes(router: Router, pool: pg.Pool): void`.
Rationale (proportionality + frozen-file safety): the custody write path is the only code that
*writes* `llm_secret_handle`; isolating it keeps `grants.ts` (asserted by `grant-editor-isolation.sh`)
churn-free and makes the AC-16 dormancy-leak grep land on exactly two files. The module **duplicates**
the `withTenantTx` + `assertUuidShape` helper from `grants.ts` by the same explicit precedent the
codebase already accepts (`grants.ts` line 100 comment: *"mirrors src/db/org.ts — write-path needs
own transaction"*); the alternative — exporting `withTenantTx` from `grants.ts` — would mutate a
frozen public surface for no gain (§3, rejected).

**Routes (HTTP surface chosen — see §3 for why HTTP over programmatic-only):**

```
POST   /api/agents/:agentId/secret-handle          → setSecretHandle      (FR-1)
PUT    /api/agents/:agentId/secret-handle          → rotateSecretHandle   (FR-2)
DELETE /api/agents/:agentId/secret-handle          → revokeSecretHandle   (FR-3)
GET    /api/agents/:agentId/secret-handle/status   → getSecretHandleStatus(FR-4)
```

`:agentId` is the `agent_employee_id`. `tenant_id` is `DEV_TENANT_ID` (the dev seam — JWT→employee
tenant resolution is T-0060, out of scope; FR-7's RLS isolation holds regardless of how the tenant id
is sourced because every query runs under `SET LOCAL choros.tenant_id`).

**Common handler skeleton (per op):**

```
1. actor   = extractActor(req)                  // x-dev-user; 401 if absent
2. tenantId= DEV_TENANT_ID
3. assertUuidShape(agentId, "agentId")          // 400 on malformed path param
4. (set/rotate only) value = body.handle_value  // 400 VALIDATION if missing/non-string
5. (set/rotate only) verdict = validateSecretHandleShape(value)
       if !verdict.ok → throw HttpError(400, "INVALID_HANDLE", verdict.reason)   // NF-1: reason is a
                                                                                  // CODE, never the value
6. admin = loadAdminContext(pool, tenantId, actor, now)
   if !holdsAgentMgmtUpdate(admin, agentOrgScope) → throw HttpError(403, "ADMIN_GATE_REJECTED", …)  // §4
7. withTenantTx(pool, tenantId, async client => {
       // single transaction: UPDATE + audit (atomic — AC-7)
       const r = await client.query(
         `UPDATE choros.agent_card
             SET llm_secret_handle = $2, updated_at = $3
           WHERE tenant_id = current_setting('choros.tenant_id')::uuid
             AND employee_id = $1
         RETURNING employee_id`,                // $2 = value | NULL (revoke)
         [agentId, valueOrNull, now]);
       if (r.rowCount === 0) throw HttpError(404, "AGENT_NOT_FOUND", …);  // RLS makes cross-tenant
                                                                          // = 0 rows (AC-10)
       await appendAuditEventInput(client, tenantId, auditInput);        // §2.3
   })
8. respond 200 { ok: true }    // set/rotate/revoke: NO handle value echoed (NF-1)
   or  200 { bound: boolean, summary?: string }   // status (FR-4)
```

**Status read (FR-4 / AC-8/AC-9):** a `SELECT llm_secret_handle FROM choros.agent_card WHERE
employee_id=$1 …` under `withTenantTx`; the full value is consumed **server-side only** to compute
`bound = row.llm_secret_handle !== null` and, if bound, `summary = redactHandle(row.llm_secret_handle)`.
The full value is **never** placed in the response object (NF-1). `404` if no row (or cross-tenant).

### 2.3 Audit event (FR-1.4/2.4/3.3, NF-4, AC-12/13/14)

Each successful mutating op builds one `AuditEventInput` directly (no encoder — these are not grant
rows; precedent `lifecycle-audit.ts`) and appends via the canonical sink **inside the same
`withTenantTx`**:

```ts
const auditInput: AuditEventInput = {
  id: randomUUID(),
  type: AUDIT_TYPE,                 // "set_llm_secret_handle" | "rotate_llm_secret_handle"
                                    //  | "revoke_llm_secret_handle"   (NF-4 exact strings)
  actor,                           // authenticated actor (extractActor)
  subject: agentId,                // agent_employee_id (NF-4)
  scope: null,
  via: "secret-handle",
  proposed_by: null,
  confirmed_by: null,
  payload: { agentEmployeeId: agentId },   // NO handle value, NO redaction, NO endpoint (NF-1/NF-4)
  occurred_at: now,
};
```

The handle value (or any prefix of it) is **categorically absent** from every field — the payload
carries only the subject id, already present as `subject`. This is the design counterpart of AC-12's
"audit row contains NO field with the handle value": there is no code path that places the value into
the input, so no test can find it. The audit is in the **same transaction** as the UPDATE, so a
rolled-back write leaves no audit row and vice-versa (NF-4 "every successful call").

### 2.4 No-value-in-logs discipline (NF-1 / AC-11)

The module establishes one invariant: **the `handle_value` string binding is passed only to (a)
`validateSecretHandleShape`, (b) the parameterized SQL `$2` bind, and (c) `redactHandle` (status path
only).** It is never interpolated into a log line, an error `message`, or an audit field. Validation
failures throw `HttpError` with a **reason code** (`vendor_key_prefix`, `too_short`, …), never the
value. This is enforced by a static fitness grep (FF-25-4) over the two new files: no
`console.*`/`logger.*`/template-literal that includes the `handle_value`/`value`/`newHandle` binding,
and no `Error(`/`HttpError(` whose argument list contains that binding.

---

## 3. Rejected alternatives

| Option | Why not |
|---|---|
| **Append the lifecycle into `grants.ts`** (reuse its `withTenantTx`/`appendAuditEventInput` directly). | `grants.ts` structure is asserted by `grant-editor-isolation.sh`; adding routes/helpers churns a frozen surface for no architectural gain, and couples agent-card custody to the grant editor. Isolation (own module) is cleaner and matches the T-0039 precedent (`grant-propose.ts` is also a separate module). |
| **Export `withTenantTx` from `grants.ts` and import it.** | Promotes a private helper to a public-surface export → new compatibility contract + frozen-file edit. The helper is ~20 lines; duplicating it (the codebase's own stated "write-path needs own transaction" precedent) is proportional and avoids the frozen-surface mutation (rule §7). |
| **Programmatic-only API (no HTTP), called by T-0042.** | Spec FR-1 lets architecture choose; but the status read (FR-4) and the management UI seam (spec §4 "API contract only") need an HTTP surface, and T-0042's hire flow is itself HTTP. One HTTP surface that T-0042 calls in-process or over HTTP is simplest; programmatic-only would force a second adapter later. The route handlers stay thin (logic in the pure validator). |
| **Encrypt / hash the handle at rest.** | The handle is an **opaque reference, not a secret** (spec §0): the secret lives client-side. Encrypting a non-secret adds key-management surface and a crypto dep for zero threat reduction. The RL-3 posture is "never a raw key in the column", enforced by the shape guard, not by encryption. |
| **Add a CHECK constraint / DB trigger enforcing not-a-raw-key.** | The heuristic (vendor prefixes, JWT shape) is policy that evolves; encoding it in DDL makes it un-versioned and hard to test, and T-0020's DDL is deliberately narrow (032 comment). Validation belongs in the pure TS validator (testable, CI-frozen), not the schema. NF-5 / "no migration" preserved. |
| **Add an index on `llm_secret_handle` (migration 033).** | No query filters or joins on the handle value (lookups are by PK `(tenant_id, employee_id)`); an index buys nothing and would also index a sensitive-shaped column. Migration 033 stays unallocated (NF-5). |
| **Return the handle (or full prefix) in the status response for "confirm what I set".** | Violates NF-1 categorically. `redactHandle` (scheme prefix / first-8 + `…`) gives operator confidence without leaking the value (FR-4). |

---

## 4. Authority gate — reuse, no new logic (FR-1.1 / AC-18 / NF-6)

The management grant required by every mutating op is `mgmt_object:agent` / `operation:"update"`
covering the agent's org scope. T-0025 **does not add authority logic**: it calls the existing
`loadAdminContext` and applies a small **predicate over the returned `AdminContext`**, in the route
module (not in `scoped-admin.ts`):

```
holdsAgentMgmtUpdate(admin, agentOrgScope): boolean =
  admin.isGenesisOwner                                   // owner = un-parented root (FR-4 of T-0030)
  || admin.adminGrants.some(g =>
        g.resourceType === "mgmt_object:agent"
        && g.operation === "update"
        && g.delegable
        && isNarrowerOrEqual(agentOrgScope, g.scope, SEED_ORACLE));  // covers the agent's org reach
```

This **composes** the existing exported `isNarrowerOrEqual` (from `scoped-admin.ts`) and the
already-filtered `adminGrants` (confirmed, in-window, delegable, `mgmt_object:*`). It is *not* a new
delegation algebra: it is the read-side authority check (analogous to the grant-revoke gate at
`grants.ts:720` which similarly checks for covering `mgmt_object:grant` authority). `scoped-admin.ts`
and `grant-lattice.ts` stay byte-frozen (NF-6 / FF-11). A caller with no covering grant → `403
ADMIN_GATE_REJECTED`, `agent_card` unmodified (AC-18). **Day-1 agent-org-scope source:** the agent's
org scope is derived from the agent `employee` row's org placement within the same `withTenantTx`
read; if the org-scope lookup is a coder seam, the **contract** is "the mutating op MUST require a
covering `mgmt_object:agent`/`update` grant before any write" — the exact org-scope materialization
is a coder detail, the gate's existence is the invariant.

---

## 5. Tenant isolation (FR-7 / AC-10)

Every op runs inside `withTenantTx` → `SET LOCAL choros.tenant_id = '<uuid>'` and `agent_card` has
`FORCE ROW LEVEL SECURITY` with a policy keyed on `current_setting('choros.tenant_id', true)::uuid`.
A cross-tenant write therefore matches **zero rows** (`UPDATE … WHERE tenant_id = current_setting(...)
AND employee_id = $1` → `rowCount = 0` → `404`), and the target tenant's `agent_card` is structurally
unreachable (AC-10). No tenant id is ever taken from the request body; it is the SET-LOCAL GUC that
gates every row, exactly as every T-0013 table.

---

## 6. Migration / dormancy boundary (FR-8 / NF-5 / AC-16 / AC-19)

- **No migration.** The column exists (`032`). No index (rejected §3). Migration 033 stays
  unallocated (NF-5). `T-0023` keeps 034-035.
- **Dormancy broken ONLY for `llm_secret_handle`.** The new code references `agent_card` solely to
  read/write that column (and read the agent's org placement for the gate). `autonomy_threshold`,
  `budget_policy_id`, `escalation_rule_id` are **never** read or written by T-0025 — no enforcement
  path is added (FR-8). The grant resolver (T-0021) and engine guard (T-0028) are untouched.
- **AC-16 dormancy-leak grep:** `grep -rn 'llm_secret_handle' src/` returns matches ONLY in
  `src/http/secret-handle.ts` and (its test). The validator and audit input reference the *value*,
  never the *column name* — the column literal lives only in the route module's SQL. FF-25-3 asserts
  this set of files.
- **AC-19 seed invariant:** T-0025 ships no seed mutation; the `032` seed (all `NULL`) is unchanged.
  FF-25-5 greps the migration tree for any non-NULL `llm_secret_handle` literal in a seed `INSERT`
  (must be empty) and the seed assertion stays green.

---

## 7. Route registration / public surface (refactor-compat, rule §7)

T-0025 **adds** one export `registerSecretHandleRoutes` and **removes none**. Importer audit
(`grep -rn "secret-handle" src/`): zero existing importers (new module). `server.ts` gains one import
+ one call `registerSecretHandleRoutes(router, grantsPool)` placed alongside `registerGrantsRoutes`
(order irrelevant — the `/api/agents/:agentId/secret-handle*` paths are distinct literals not captured
by any grant route pattern). This is an **additive** edit to `server.ts` (not a frozen file); no
existing export signature, path, or module location changes, so no compatibility contract is broken.
`grants.ts`, `scoped-admin.ts`, `grant-lattice.ts`, `object-handle.ts` are **not imported-from in a
way that mutates them** — T-0025 imports the *existing* exports `loadAdminContext` (org.ts),
`isNarrowerOrEqual` (scoped-admin.ts), `AuditEventInput` (audit-grant-encoder.ts), `makePgAuditWriter`
(audit-writer.ts), `HttpError`/`readJsonBody`/`Router` (http utils) — all **kept as compatibility
contracts** (T-0025 is a new importer of each; none is renamed/removed by this task).

---

## 8. The custody seam for T-0039 (`resolveSecret` port — FE-0006/0007)

T-0039's `GrantProposeDeps.resolveSecret: (handle: string, ctx: { tenantId: string }) =>
Promise<string>` (its ADR §2.2) is **the port whose custody T-0025 owns**. The two tasks are
coupled by a **contract, not a shared file edit**:

- T-0039 writes `src/http/grant-propose.ts` and makes a one-line value edit in `grants.ts`
  (`proposed_by` bind, its §3). T-0025 writes `src/core/secret-handle-validator.ts` +
  `src/http/secret-handle.ts` + one additive `server.ts` line. **No file is edited by both** (no
  same-line, no same-file conflict). The grep `secret-handle` vs `grant-propose` partition the
  surfaces cleanly.
- **What T-0025 guarantees the port (the contract T-0039 codes against):**
  1. The value stored in `agent_card.llm_secret_handle` is, by construction (FR-5 guard), **an opaque
     reference token, never a raw API key** — so a resolver may safely treat it as "a handle to look
     up", not "a credential to use directly" (spec C-2).
  2. The handle lifecycle (set/rotate/revoke) is **audited and authority-gated**; the resolver does
     not re-check custody — it consumes the already-validated column.
  3. **Day-1 T-0025 does NOT implement `resolveSecret`** (no client-side secret retrieval — that is
     Stage-2 / T-0045, spec §4 out-of-scope). T-0025 defines and owns the **type seam**: a
     `SecretResolverPort` interface placed in `src/core/secret-handle-validator.ts` (the custody-
     owning module) that T-0039's `resolveSecret` field is **structurally compatible with**:
     ```ts
     // T-0025 owns this port TYPE (custody boundary). Stage-2/T-0045 supplies the impl.
     export interface SecretResolverPort {
       resolveSecret(handle: string, ctx: { tenantId: string }): Promise<string>;
     }
     ```
     T-0039 may import this type from the validator module (additive new export) OR keep its own
     structurally-identical inline type — **either satisfies the contract** (TS structural typing).
     The ADR fixes the signature as the single source of truth so the two tasks cannot drift
     (FE-0006/0007). T-0039's day-1 `resolveSecret` default (echo/identity stub, never logging the
     value) is **valid against this port**; the real RL-3 resolver lands at Stage-2 and is injected
     then. **T-0025 itself wires no resolver into any live path** (FR-6 — zero platform LLM call):
     the port type is *declared* for T-0039 to depend on, not *invoked* by T-0025.
- **No conflict to escalate.** The seam is a TS interface + a data-shape guarantee on the column;
  it requires no coordination beyond this ADR. If T-0039 lands first, it uses its inline type; when
  T-0025 lands, `SecretResolverPort` becomes the canonical export and T-0039 *may* migrate to it
  (compat: the inline type is structurally identical — no break).

---

## 9. Object model / contracts

See `T-0025.adr.contract.json` `object_model` + `contracts`. No new table, no migration. The only DB
write surface is `UPDATE choros.agent_card SET llm_secret_handle = $2` (set/rotate) / `= NULL`
(revoke), keyed by `(tenant_id via GUC, employee_id)`. The only new persisted *type* is the
`audit_event.type` vocabulary `{set,rotate,revoke}_llm_secret_handle` (NF-4) — no schema change
(`audit_event.type` is `text`).

---

## 10. Fitness functions

See contract `fitness_functions` (FF-25-1 … FF-25-7). Highlights: **FF-25-1** validator is IO-free
(no `pg`/`fetch`/`http`/`https`/`net`/`child_process` import — pure not-a-raw-key logic); **FF-25-2**
no LLM SDK in `package.json` (AC-15); **FF-25-3** `llm_secret_handle` referenced only in the T-0025
files (AC-16 dormancy boundary); **FF-25-4** handle value never in logs/errors/audit-payload (AC-11,
static grep over the two new files); **FF-25-5** seed unchanged, all agents `NULL` (AC-19); **FF-25-6**
`scoped-admin.ts` + `grant-lattice.ts` + `object-handle.ts` byte-unchanged vs merge-base (NF-6);
**FF-25-7** `tsc --noEmit` + eslint green (AC-17). The validator's reject rules (AC-2..AC-6) are
verified by unit tests, not fitness (they are behavioral test ACs).

---

## 11. Runtime target

`runtime_target = контейнер` — Choros dev stack on `/srv/choros` (homeserver-vm, T-0065). T-0025
requests **no external resource and no platform LLM credential** (FR-6): the platform stores an opaque
string and makes no outbound call. **No GT-4 provision.** Verifiable locally against the dev Postgres
(migration 032 already applied). No founder gate.

---

## 12. Escalation

**None.** Every decision is local and fully determined by the signed model: RL-3 "platform governs /
client hosts" (kickoff §4.5, GT-1), the not-a-raw-key invariant (T-0020 NF-3/C-3, ratified), the
audit floor (E2.8, day-1), and tenant-RLS (T-0013). The custody port for T-0039 (§8) is a contract,
not a product-direction or cross-vendor choice. No founder escalation required.

---

## 13. Seam resolution vs T-0042 (hire write-path) — ADR AMENDMENT (2026-06-11)

**Status of the conflict.** T-0042 (E5.2 agent provisioning) is **already merged to dev**. Its
`POST /api/agents/hire` route optionally accepts `llm_secret_handle` in the request body
(`src/http/agents.ts:215`), threads it through the pure plan builder
(`src/core/agent-hire.ts::buildAgentHirePlan`, field `llmSecretHandle`), and persists it via a raw
INSERT (`src/db/agent-provision.ts` — `agent_card … llm_secret_handle …`, `$7`). That INSERT runs
**without** `validateSecretHandleShape`: a raw `sk-…` key in the hire body reaches the column,
bypassing the RL-3 not-a-raw-key guard this task owns. T-0025 §6/AC-16 and **FF-25-3 as originally
written** (allow-pattern = files matching `secret-handle`) declare the column's *write* lifecycle the
exclusive province of the custody routes — so two facts collide: (a) a real RL-3 bypass exists in
merged code, and (b) the dormancy fitness would flag the hire-path reference as a leak. This section
resolves both. **No founder escalation:** the resolution stays strictly inside the signed E5.5 model
(RL-3 "platform governs the *handle*, client hosts the secret; no platform LLM dependency") — it
changes no product direction and crosses no red line. RL-3 is *strengthened* (a bypass is closed),
not re-scoped.

### 13.1 Decision — **Variant B (validated initial write at hire) + FF re-scope**

The custody **governance** (the not-a-raw-key shape guard and the audit vocabulary) is centralized in
**one** place — the pure `validateSecretHandleShape` validator and the
`set_llm_secret_handle` audit type — but it is permitted to have **two audited call-sites**: the
custody routes (set/rotate/revoke) and the **hire INSERT**. The hire route MAY write an initial
`llm_secret_handle` **iff** it (1) passes the value through the *same* pure
`validateSecretHandleShape` before the plan/INSERT, rejecting `400 INVALID_HANDLE(reason)` on
failure, and (2) emits the *same* canonical `set_llm_secret_handle` audit event (no handle value in
any field) in the hire transaction, alongside the existing `agent.hire` audit. Every **subsequent**
mutation of the column (UPDATE/SET to a non-NULL value, revoke-to-NULL) remains the **exclusive**
province of the T-0025 custody routes — the hire INSERT is the *only* sanctioned write outside them,
and only because it is validator-gated.

The invariant that RL-3 actually demands is **"no raw API key ever lands in
`agent_card.llm_secret_handle` un-validated, and every binding event is audited"** — *not* "exactly
one HTTP route may touch the column." Variant B satisfies the real invariant by moving the guard to
the value (the pure validator is the single point of governance), rather than to the route (a single
point of *plumbing*). The bypass is closed at the seam where the value enters, which is the correct
locus.

### 13.2 Why not Variant A (hire strips/rejects `llm_secret_handle`; handle is post-hire only)

Rejected. Variant A would force the hire route to **drop or 400** any `llm_secret_handle` in the
body, making agent-LLM setup a mandatory two-step flow (hire, then a separate custody call) and
requiring an **edit to merged T-0042 code that *removes* a field it deliberately declared**
(`spec §3 "Accepting them is autonomous; if omitted, persisted as NULL"`, ADR §3.1). Axes:
**custody integrity** — A gives "one route" but at the cost of an un-auditable *gap* (the field is
silently discarded), whereas B gives "one validator + two audited points," which is the stronger
custody property; **proportionality** — A's UX regression and merged-feature removal are
disproportionate to the threat, which B neutralizes additively; **blast-radius** — A deletes T-0042
behavior (regression risk against `FF-HIRE-5` integration expectations), B only *adds* a guard at the
existing write; **identity⊥rights (T-0042 §1.3)** — untouched by either (the validator/audit live on
the agent_card custody axis, never the rights layer); **UX** — A is strictly worse (two steps). The
only thing A buys is a literally-singular write route, which is a plumbing aesthetic, not a security
property. Variant B is chosen.

### 13.3 Fitness-function consequences (the part that must change to stay green)

**FF-25-3 (dormancy boundary) is amended, not weakened.** Its allow-set changes from "files matching
`secret-handle`" to an **explicit named allow-list** of the custody module **plus the three
T-0042 hire-path files** that legitimately reference the column. The check
(`ci/checks/secret-handle-isolation.sh`, the FF-25-3 block at lines 53–72) must treat as allowed:
`src/http/secret-handle.ts`, `src/core/secret-handle-validator.ts` (if/when it names the column),
`src/db/agent-provision.ts`, `src/core/agent-hire.ts`, `src/http/agents.ts` (+ their test files). Any
*other* file referencing `llm_secret_handle` is still a leak → fail. The dormancy guarantee for
`autonomy_threshold` / `budget_policy_id` / `escalation_rule_id` (the second half of the FF-25-3
block) is **unchanged** — those columns remain untouched by T-0025.

**NEW: FF-25-8 (write-path validator-gate).** Pins Variant B structurally: *every* code path that
writes a non-NULL `llm_secret_handle` (custody routes **and** the hire INSERT) must be reachable only
after a `validateSecretHandleShape` call; and **no** UPDATE/SET of `llm_secret_handle` to a non-NULL
value may exist **outside** `src/http/secret-handle.ts` (the hire path uses INSERT, not UPDATE — so
the "single SET/UPDATE route" property is preserved for mutation). Concretely the check asserts:
(a) `src/http/agents.ts` imports `validateSecretHandleShape` from
`../core/secret-handle-validator.js` AND calls it on the `llm_secret_handle` value before
`buildAgentHirePlan`; (b) `grep -rnE 'UPDATE[[:space:]]+choros\.agent_card[^;]*llm_secret_handle'
src/` (i.e. an UPDATE that sets the column) appears **only** in `src/http/secret-handle.ts` — an
INSERT in `agent-provision.ts` is allowed, a SET/UPDATE there is a fail; (c) `src/http/agents.ts`
emits the canonical `set_llm_secret_handle` audit type when (and only when) it writes a non-NULL
handle. This is the executable form of "one validator governs the value; UPDATE stays single-route;
the hire INSERT is the one validated exception."

**Unchanged:** FF-25-1/2/4/5/6/7 stand as written. The pure validator stays IO-free and is the
single shape authority; the hire path imports it (additive new importer — no validator change). The
`set_llm_secret_handle` audit type is now emitted from two sites but is still one canonical type
through the one `appendAuditEvent` sink (NF-7 holds).

### 13.4 Coder instruction (precise — files / lines / contracts; coder writes the code)

> Target branch: `task/T-0025`. T-0042 files are merged to dev; editing them here is **legal** — the
> edit flows through this branch and the dev→main gate. Treated as **compatibility contracts** below.

**(C-1) `src/http/agents.ts` — gate the hire-time handle through the custody validator.**
- Add import: `import { validateSecretHandleShape } from "../core/secret-handle-validator.js";`
- At **line 215** (`const llmSecretHandle = …`): after deriving `llmSecretHandle`, if it is
  non-NULL, run `const verdict = validateSecretHandleShape(llmSecretHandle); if (!verdict.ok) throw
  new HttpError(400, "INVALID_HANDLE", verdict.reason);` — **before** `buildAgentHirePlan` (line 239)
  and before the Keycloak call (line 256). Place it next to the other body-field validations
  (after line 216) so rejection precedes *all* side-effects (mirrors FF-HIRE-1 ordering).
  **NF-1: never put `llmSecretHandle` into the `HttpError` message — pass `verdict.reason` (a code).**
- In the hire transaction (Step 5, around line 268–273), **when `llmSecretHandle` is non-NULL**, emit
  an additional canonical custody audit event of type `"set_llm_secret_handle"` via the same
  `appendAuditEvent(tx, …)` sink, in the **same `withTenantTx`** as `insertAgentRows` and the existing
  `agent.hire` audit. Shape (no value in any field): `{ type: "set_llm_secret_handle", actor:
  actorId, subject: <new agent employee_id from the plan>, scope: null, via: "secret-handle",
  proposed_by: null, confirmed_by: null, payload: { agentEmployeeId: <new employee_id> },
  occurred_at: nowMs }`. (You may reuse the existing AuditEventInput builder idiom from the
  custody module §2.3, or inline an equivalent literal — it must be the **canonical** `appendAuditEvent`
  sink, not a parallel path.) When `llmSecretHandle` is NULL, emit **only** the existing `agent.hire`
  audit (no custody event for a NULL bind).

**(C-2) `src/core/agent-hire.ts` — no change required.** `buildAgentHirePlan` stays pure and may
keep `llmSecretHandle` in `AgentHireInput`/`AgentHirePlan` as-is; it now receives an
already-validated value. **Do not** add the validator import here (keep the core IO/policy-free; the
gate lives at the HTTP boundary, consistent with T-0042 §1 "thin route over pure core").

**(C-3) `src/db/agent-provision.ts` — no change required.** The INSERT keeps writing
`plan.agentCard.llmSecretHandle` at `$7`. **Do not** convert this INSERT into an UPDATE/SET path and
**do not** add any UPDATE of `llm_secret_handle` here (FF-25-8 (b) forbids a SET/UPDATE outside the
custody route). The value it inserts is now guaranteed validator-passed by C-1.

**(C-4) `src/core/secret-handle-validator.ts` — unchanged (new importer only).** It already exports
`validateSecretHandleShape`. C-1 is an additive new import site; the validator file itself is not
edited (FF-25-1 IO-purity preserved).

**(C-5) `ci/checks/secret-handle-isolation.sh` — amend FF-25-3 allow-list + add FF-25-8.**
- FF-25-3 block (lines 53–72): replace the single `ALLOWED_PATTERN="src/http/secret-handle"` /
  `*secret-handle*` test with an **explicit allow-set** of basenames/paths:
  `src/http/secret-handle.ts`, `src/core/secret-handle-validator.ts`, `src/db/agent-provision.ts`,
  `src/core/agent-hire.ts`, `src/http/agents.ts` (and their `*.test.ts` / `__tests__` siblings). A
  `llm_secret_handle` hit in any file **not** in that set → FAIL (unchanged failure semantics, wider
  allow-set). Keep the `autonomy_threshold|budget_policy_id|escalation_rule_id` sub-check untouched.
- Append a **FF-25-8** block: (a) assert `src/http/agents.ts` both imports
  `validateSecretHandleShape` and calls it (grep both tokens present); (b) assert
  `grep -rnE 'UPDATE[[:space:]]+choros\.agent_card[^;]*llm_secret_handle' src/ --include=*.ts`
  returns matches **only** in `src/http/secret-handle.ts` (any other file → FAIL); (c) assert
  `src/http/agents.ts` contains the literal `"set_llm_secret_handle"` (the custody audit emit). Wire
  it into the same `ERRORS` accumulator so it gates in `npm run fitness`.

**(C-6) Tests.** Extend the hire integration test (`src/__tests__/agent-hire.test.ts`, FF-HIRE-5):
add cases — hire with a raw `sk-…` `llm_secret_handle` → `400 INVALID_HANDLE` (`vendor_key_prefix`),
**zero** side-effects (no Keycloak client, no rows, no audit); hire with a valid opaque handle → 201,
column set to that value, **two** audit rows present (`agent.hire` + `set_llm_secret_handle`), neither
carrying the handle value; hire with NULL handle → 201, **one** audit row (`agent.hire` only). Keep
the existing custody-route tests unchanged.

**Out of scope / do-not-touch:** `scoped-admin.ts`, `grant-lattice.ts`, `grant-resolver.ts`,
`mcp-tool-registry.ts`, `object-handle.ts` stay byte-frozen (FF-25-6 / FF-HIRE-2/4). No migration.
T-0042's `identity⊥rights` (§1.3) is untouched — this amendment lives entirely on the custody axis.
