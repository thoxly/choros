# ADR-T0610 — invoke-путь переезжает на единый grant-resolver

Status: ready
Task: T-0610 (security-debt/bug — столп 4, агенты/сотрудники с правами)
Base: dev@1e52cd7, branch `task/T-0610-invoke-grant-resolver`

## 1. Problem

`src/http/invoke.ts::loadCallerInvokeGrants` (lines 261-307) is a SECOND
grant-resolution path, parallel to the single canonical resolver
`getGrantsForSubject` (`src/db/grants-dao.ts:208`) that every other PDP
consumer in the codebase uses (`records.ts`, `org.ts`, `inbox.ts`,
`capability-grants-dao.ts`, `sandbox-gate-dao.ts`, `registry-digest-dao.ts`,
`role-grant-dao.ts`).

Found by the T-0605 security review (`docs/review/T-0605.review.json`, finding
**F-1**, `src/http/invoke.ts :261-290`, severity info/out-of-scope —
pre-existing, not a T-0605 regression):

The inline query:

```sql
SELECT g.id, g.role_id, g.resource_type, g.resource_facet,
       g.operation, g.scope, g."constraint", g.delegable,
       g.granted_by, g.valid_from, g.valid_until, g.created_at
   FROM choros."grant" g
   JOIN choros.role_assignment ra
     ON ra.tenant_id = g.tenant_id AND ra.role_id = g.role_id
  WHERE g.tenant_id = $1
    AND ra.employee_id = $2
    AND g.operation = 'invoke'
```

has exactly one filter — `g.operation = 'invoke'`. It has NO assignment-active
predicate (no `confirmed_by`, no window, no T-0605 canonical
`confirmed2_by IS NOT NULL OR proposed_by IS NULL`) and NO grant-active
predicate (no `confirmed_by`, no window, and — the sharpest gap — no T-0397
`criticalGrantPredicate` + `confirmed2_by` dual-control gate). Since
`resource_type='effect_resource' AND operation='invoke'` is itself axis-b of
the critical-grant classification (`grants-dao.ts:143`), essentially every
invoke-grant is "critical" by construction, yet this path grants PDP-activity
to a semi-confirmed (one-approver) invoke-grant and to an unconfirmed/expired
role assignment. Dual-control is silently bypassed for the one surface
(agent-invoke) whose whole purpose is guarding an external effect.

## 2. Decision

**Replace the inline SQL in `loadCallerInvokeGrants` with a call to
`getGrantsForSubject(pool, tenantId, callerId, nowMs)`, then filter the
returned `Grant[]` to `operation === 'invoke'`.** This mirrors the exact
pattern every other consumer already uses (e.g.
`src/db/capability-grants-dao.ts`: `getGrantsForSubject` → predicate filter in
TS), and needs zero new SQL, zero new predicate logic, zero migration.

### 2.1 Signature

```ts
async function loadCallerInvokeGrants(
  pool: pg.Pool,
  tenantId: string,
  callerId: string,
  nowMs: number,
): Promise<Grant[]> {
  const grants = await getGrantsForSubject(pool, tenantId, callerId, nowMs);
  return grants.filter((g) => g.operation === "invoke");
}
```

Change from the current signature: the first parameter becomes `pool: pg.Pool`
instead of `client: pg.PoolClient`, and a `nowMs: number` parameter is added
(previously the caller's tx client carried no notion of "now" into this
function — `nowMs` already exists in both call sites as a local `const`). This
is a deliberate, NOT byte-compatible change to a `function` that is not
exported (module-private) — no external caller depends on its old shape,
verified by `grep -rn loadCallerInvokeGrants src/` returning only the
definition and the two call sites inside this same file.

### 2.2 Why `pool`, not the outer `withTenantTx` client

`getGrantsForSubject` (like every one of its other call sites: `server.ts`,
`capability-grants-dao.ts`, `sandbox-gate-dao.ts`, `registry-digest-dao.ts`,
`role-grant-dao.ts`) always takes a `pg.Pool` and opens its OWN
`withTenantReadTx` (`BEGIN; SET LOCAL choros.tenant_id; ... COMMIT`) — it is
never handed an existing client/transaction. This is the established
composition pattern in the codebase: the grant-read is a self-contained,
independently-scoped read transaction, decoupled from whatever write
transaction the calling route may be inside. `registerInvokeRoutes` already
receives `pool: pg.Pool` as a parameter (used to construct `withTenantTx`), so
it is passed straight through to the new `loadCallerInvokeGrants` call — no new
dependency, no plumbing.

The two call sites (`POST /api/invoke/request`, `POST /api/invoke/command`)
currently call `loadCallerInvokeGrants(client, tenantId, callerId)` from
INSIDE their `withTenantTx` callback. After this change they call
`loadCallerInvokeGrants(pool, tenantId, callerId, nowMs)` — `pool` is the
outer closure variable already in scope (the route's own top-level parameter),
not `client`. The rest of the callback (agent-card load, role-assignment load,
`coversInvoke`, the INSERT, the audit write) keeps using `client` exactly as
before — those reads/writes still need to be inside the write transaction; only
the grant RESOLUTION moves to its own read-only transaction, matching how
`records.ts`'s `resolveFieldVisibility`/`resolveReadVisibility` and `org.ts`'s
capability-token check already call `getGrantsForSubject(pool, ...)` from
inside handlers that also run their own separate `withTenantTx`.

### 2.3 What happens to the legacy inline query

Deleted entirely — not kept behind a flag, not left commented out. The
function body becomes the two-line delegation in §2.1. `getGrantsForSubject`
is imported from `../db/grants-dao.js` (mirrors every other `src/http/*.ts`
consumer's import path).

### 2.4 `coversInvoke` — untouched

`coversInvoke` (the role/scope-match predicate: `operation==='invoke'`,
`isEffective`, `resource_facet.agent_role_id` match, `isNarrowerOrEqual` scope
containment) is orthogonal to this change. It receives the SAME `Grant` shape
regardless of which query produced it — its logic does not change and its
existing unit tests (`invoke-grant.test.ts`) keep passing unmodified. The fix
only changes which grants make it into the array `coversInvoke` is asked to
scan; a grant that was PDP-inactive (unconfirmed assignment / semi-confirmed
critical grant) simply no longer appears in that array — `coversInvoke.find()`
then correctly finds nothing and the route 403s (NF-4 fail-closed, unchanged).

## 3. Rejected alternatives

| option | why not |
|--------|---------|
| Re-derive the T-0605 canonical assignment predicate + T-0397 `criticalGrantPredicate` inline in `invoke.ts`'s own SQL (patch the existing query with the extra WHERE clauses) | Recreates a SECOND copy of the exact predicate `getGrantsForSubject` already owns — the precise class of drift (two interpretations of the same authority rule) that caused the T-0605 self-lock bug in the first place. `criticalGrantPredicate` is a hand-built SQL fragment (`grants-dao.ts:117-159`) covering 4 escalation axes with JSONB clearance-marker parsing; duplicating it in `invoke.ts` means EVERY future change to the criticality classification (there have been several: T-0397's original axes a/b, the B1 axis-c/Q-2 fix, T-0605's assignment-predicate collapse) would need a second edit here, with no fitness check forcing the two copies to match. The task's own directive is explicit: "свести invoke-путь к ЕДИНОМУ grant-resolver". |
| Call `makeDbGrantSource(pool).getGrants({tenantId, subjectId: callerId}, nowMs)` (the `GrantSource`/`ResolveSubject` wrapper) instead of `getGrantsForSubject` directly | Functionally identical (`makeDbGrantSource` is a 1-line adapter calling `getGrantsForSubject` with the same args) but adds an indirection (`ResolveSubject` object construction) with no benefit here — invoke.ts already has `tenantId`/`callerId` as plain strings, and every other DIRECT consumer (capability-grants-dao.ts, sandbox-gate-dao.ts, registry-digest-dao.ts, role-grant-dao.ts, records.ts, org.ts, server.ts) calls `getGrantsForSubject` directly, not through the `GrantSource` wrapper (that wrapper exists for `resolveFor`'s `ResolverDeps.grants` injection point, a different composition seam invoke.ts does not use). Direct call matches the dominant convention. |
| Route invoke authorization through `resolveFor` (the full ObjectHandle/ResourceRef PDP in `grant-resolver.ts`) instead of a raw `Grant[]` + `coversInvoke` | `resolveFor` is built around `ObjectHandle`/`ResourceRef`/field-visibility projection for RECORD-shaped resources (read/approve/transition on a data row). Agent-invoke authorization is a role+org-scope match against an `agent_role_id` facet, not a record read/write — `coversInvoke` is the right-shaped predicate for that (already reviewed and accepted under T-0024, unchanged by this task). Migrating invoke onto `resolveFor` would be a much larger, riskier rewrite of a working, task-scoped predicate for no closed gap — `coversInvoke` was never the security hole; `loadCallerInvokeGrants`'s SOURCE of grants was. |
| Leave `loadCallerInvokeGrants` as-is and only add a NEW fitness check flagging it as a known-accepted risk | Does not close F-1 — the task requires the fix, not just documentation. A frozen static check that only asserts "yes, this hole still exists" would contradict "свести invoke-путь к ЕДИНОМУ grant-resolver". |

## 4. Object model / contracts

No schema change, no migration.

- `src/http/invoke.ts` — `loadCallerInvokeGrants` rewritten per §2.1 (module-
  private function, both call sites in `registerInvokeRoutes` updated to pass
  `pool`/`nowMs` instead of `client`). New import:
  `import { getGrantsForSubject } from "../db/grants-dao.js";`. Everything
  else in the file (types, `coversInvoke`, `extractCallerId`,
  `resolveInvokeTenant`, `loadAgentCard`, `loadActiveRoleAssignment`, the audit
  seam, route bodies apart from the one call-site line) is UNCHANGED.
- `src/db/grants-dao.ts` — UNCHANGED (no diff; `getGrantsForSubject` is
  consumed, not modified — this is the whole point of the fix).
- Tests: `src/__tests__/invoke-grant.test.ts`,
  `src/__tests__/invoke-caller-spoof.adversarial.test.ts` — unchanged, must
  stay green (they exercise `coversInvoke`/audit/caller-identity, none of
  which change shape).
- New: `ci/checks/db/invoke-grant-resolver.db.test.ts` — live-Postgres probe
  (see §5) proving AC-2/AC-3 against the REAL `loadCallerInvokeGrants` +
  `getGrantsForSubject` SQL, mirroring the `rights-eligibility-sew.db.test.ts` /
  `grants-dao-dual-control.db.test.ts` fixture pattern (fresh per-suite tenant,
  `uuid()`-suffixed fixture values, no case literals).

## 5. Fitness functions

| id | rule | ci_check |
|----|------|----------|
| FF-610-SINGLE-RESOLVER | `loadCallerInvokeGrants` contains no `JOIN choros.role_assignment` / no bare `FROM choros."grant"` — it calls `getGrantsForSubject` and filters in TS. Static grep over `src/http/invoke.ts`. | new check in `ci/checks/invoke-grant-isolation.sh` (additive IG-7) |
| FF-610-ASSIGNMENT-GATE | a caller with an UNCONFIRMED (`confirmed_by IS NULL`) or EXPIRED role assignment gets ZERO invoke-grants for that role, even though the raw `grant`/`role_assignment` rows exist. Live PG. | `npm run fitness:db` (new db test) |
| FF-610-DUAL-CONTROL | a critical invoke-grant (`resource_type='effect_resource'`, `operation='invoke'`) with `confirmed2_by IS NULL` (one approver) is EXCLUDED from `loadCallerInvokeGrants`'s result — `coversInvoke` never sees it, so `POST /api/invoke/request|command` 403s. The SAME grant with `confirmed2_by` set (two approvers) IS included and the route proceeds to 201/202. Live PG. | `npm run fitness:db` (new db test) |
| FF-610-REGRESSION | existing invoke-grant unit tests (`invoke-grant.test.ts`, `invoke-caller-spoof.adversarial.test.ts`) pass unmodified — `coversInvoke`/audit/caller-identity logic is untouched. | `npx vitest run` |
| FF-IG-5 (inherited, unchanged rule, re-verified) | invoke.ts still has no parallel-authority token (`_acl`, `field_visibility`, `record_rights`) — the fix makes this MORE true (one fewer bespoke authority path), not less. | `ci/checks/invoke-grant-isolation.sh` |
| FF-IG-6 (inherited, unchanged) | audit still goes through the canonical seam only — untouched by this change. | `ci/checks/invoke-grant-isolation.sh` |
| FF-R6 / grant-resolver-isolation (inherited, unchanged) | `src/core/grant-resolver.ts` is not touched by this task at all — check stays green trivially (no diff to that file). | `ci/checks/grant-resolver-isolation.sh` |
| dual-control-isolation (inherited, unchanged) | `src/core/dual-control.ts` / `src/http/grants.ts` write-path untouched — this task is entirely on the READ side (invoke.ts consuming the existing read-gate), no migration, no write-path change. | `ci/checks/dual-control-isolation.sh` |

### 5.1 On strengthening `invoke-grant-isolation.sh` / `grant-resolver-isolation.sh`

`grant-resolver-isolation.sh` asserts properties of `src/core/grant-resolver.ts`
specifically (purity, no forbidden imports, frozen exports) — this task does
not touch that file, so no change is needed there; it stays green because
there is no diff to check.

`invoke-grant-isolation.sh` DOES check `src/http/invoke.ts` (IG-1..IG-6) but
had no rule yet asserting invoke.ts uses the SHARED resolver rather than its
own SQL — that is exactly the gap this task closes. **IG-7 is added** (see
§5 FF-610-SINGLE-RESOLVER): a static grep asserting `invoke.ts` contains
`getGrantsForSubject` and does NOT contain a `JOIN.*role_assignment` /ORed with
a bare `FROM choros."grant"` outside of a comment. This is additive (new
check inside the existing script, existing IG-1..IG-6 untouched byte-for-byte
apart from appending the new section) — no existing frozen gate is edited or
weakened, per the task's ban on touching frozen checks.

`dual-control-isolation.sh` scope is `dual-control.ts` + `grants.ts` write path
— unrelated to invoke.ts's READ-side fix; left untouched (task explicitly says
additive-only, and there is nothing to add there for this change: the
write-path dual-control machinery this task now correctly RESPECTS on read was
already pinned by `grants-dao-dual-control.db.test.ts`).

## 6. Traceability

| AC (spec) | covered by |
|-----------|-----------|
| AC-1 (calls getGrantsForSubject, no inline JOIN) | §2.1/§2.3 rewrite + FF-610-SINGLE-RESOLVER static check |
| AC-2 (unconfirmed/expired assignment excluded) | §2 delegation to getGrantsForSubject step 2 (T-0605 canon) + FF-610-ASSIGNMENT-GATE db test |
| AC-3 (grant-level dual-control honored) | §2 delegation to getGrantsForSubject step 3 (T-0397 criticalGrantPredicate) + FF-610-DUAL-CONTROL db test |
| AC-4 (existing unit tests pass unmodified) | §4 — coversInvoke/audit files untouched; FF-610-REGRESSION |
| AC-5 (invoke-grant-isolation.sh green) | §5.1 — IG-1..IG-6 unaffected, IG-7 additive and green post-fix |
| AC-6 (new/strengthened static check) | §5.1 IG-7 |
| AC-7 (tsc/eslint/vitest green) | standard gate, no special design needed |
| AC-8 (fitness:db green incl. new test) | §4 new `invoke-grant-resolver.db.test.ts` |
| AC-9 (anti-case-lock green) | no role-slug/business literal introduced — all fixture slugs `uuid()`-suffixed, mirrors T-0605's db test discipline |

## 7. Risks / compatibility

- **Behavioral tightening, not loosening**: the only rows that change PDP-status
  are ones the OLD inline query incorrectly treated as active
  (unconfirmed/expired assignment; semi-confirmed critical invoke-grant). No
  row that was correctly active before becomes inactive — `getGrantsForSubject`
  is a strict narrowing of "any `operation='invoke'` row", never a widening. A
  legitimate agent-invoke setup (routine assignment fully confirmed, invoke-
  grant fully confirmed incl. second approver where critical) is unaffected.
- **Dual-control now REQUIRED for invoke**: any tenant/seed that minted an
  invoke-grant with only ONE approver will find that grant stops working after
  this fix (by design — this is the exact bug being closed). Recon: `grep -rn
  "operation.*'invoke'\|'invoke'.*operation" migrations/ ci/ src/db/seed*`
  should be checked at BUILD time for any seed/migration that inserts an
  invoke-grant with `confirmed2_by IS NULL` — if found, it is a seed hygiene
  issue to flag (FINDINGS), not a reason to weaken the fix (T-0397's dual-
  control is deliberate policy for exactly this axis).
- **Two DB round-trips instead of one per invoke call**: `loadCallerInvokeGrants`
  now opens its own `withTenantReadTx` (BEGIN/COMMIT) SEPARATE from the outer
  `withTenantTx` write transaction, exactly like `records.ts`'s field-
  visibility/read-visibility resolvers already do inside their own handlers.
  This is a minor latency cost (one extra connection acquire+round-trip),
  accepted as the established, safe pattern rather than trying to thread a
  read through an unrelated write transaction's client.
- **No migration** — both predicates already exist and apply to
  already-existing `role_assignment`/`grant` rows; nothing about the DATA
  changes, only which SQL reads it.
