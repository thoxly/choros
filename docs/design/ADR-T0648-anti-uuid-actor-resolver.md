# ADR-T0648 — batch actor-display resolver + ActorChip/RecordRef + anti-UUID gate

Status: ready
Task: T-0648 (W4-UX / столп 4 — «агенты видимы как сотрудники»)
Base: dev@46a6c7c, branch `task/T-0648-anti-uuid-actor-resolver`
Spec source: docs/design/ux-study-2026-07-05.md §3, §6

## 1. Problem

Every reader that surfaces an "actor" (who claimed a task, who acted in the
audit log, who was granted a role, who completed a BPMN step, who ranks in
"top executors" analytics) stored/streamed an opaque identifier — an employee
SLUG (the common case) or, for legacy/unresolved paths, a raw Keycloak `sub`
UUID or a fixed system pseudo-actor string (`control-plane`, `policy-sync`).
Each reader independently re-derived (or failed to derive) a human-readable
name, so a bare UUID/slug leaked into the UI as if it were content
("Исполнитель: 3462410f-…"). Столп 4 ("agents are visible as employees with
rights") is invisible when the on-screen text for an agent-driven step is
indistinguishable from a bug.

Confirmed leak sites (file:line, dev@46a6c7c):
- `src/http/inbox.ts:787,876` (pre-fix) — `execName: claim.claimedBy` verbatim
  in the defer and instance item-building blocks (the seed block already had
  a partial fix via a manual `claimerNames` map — inconsistent across the
  three blocks).
- `src/http/audit.ts` / `src/db/audit-read-dao.ts` — `AuditLogItem.actor` is
  the raw `audit_event.actor` column, un-resolved.
- `src/http/grant-trail.ts` / `src/db/audit-grant-trail.ts` — `GrantTrailRow.
  actor`/`.subject` raw strings; the frontend (`ra-grant-trail.jsx`)
  additionally HARDCODED `{ type: "human", name: r.actor }` regardless of the
  real actor kind (a service/automation actor like `policy-sync` would have
  rendered with a human glyph).
- `src/db/operational-analytics-dao.ts` `loadActorWorkload` — `top_actors[].
  actor` raw.
- `src/http/processes.ts` `fetchInstanceHistoryDetail` — `completedBy:
  a.assignee` (raw Flowable/employee-slug assignee), rendered bare in
  `screen-process-instance.jsx`'s `HistoryStepRow`.
- `screen-process-instance.jsx` — "запись-источник" rendered `<MonoId>
  {instance.recordId}</MonoId>` — a bare id with no title, no link.

## 2. Decision — one generic batch resolver + two display primitives, not 13 point-fixes

### 2.1 Backend: `src/db/actor-resolver.ts` — `batchResolveActors`

```ts
batchResolveActors(pool, tenantId, ids: string[]): Promise<Map<string, ResolvedActor>>
```

- **ONE query per call**, regardless of batch size: `SELECT slug, id::text,
  display_name, kind, deactivated_at FROM choros.employee WHERE tenant_id = $1
  AND (slug = ANY($2::text[]) OR id::text = ANY($2::text[]))`. Matches by
  SLUG (the common shape) OR by raw `id` (a few older write paths stored the
  employee UUID instead) in the SAME query, so callers never need to know
  which shape they hold. Mirrors the "distinct-set → one query → build a Map"
  shape already established by `resolveExecutorFallbackBatch` (src/http/
  inbox.ts, T-0380).
- **Type taxonomy**: `choros.employee.kind` is a closed 2-value CHECK
  (`human`|`agent` — migration 016; "service workers (s-ledger, s-ocr) map to
  kind='agent'" by the migration's own comment — there is no 3rd DB value).
  The resolver widens this to a 3-value DISPLAY type (`ActorKind = "human" |
  "agent" | "service"`) via `displayTypeFor(kind, slug)`: an agent-kind
  employee whose slug matches a service naming convention (prefix `s-`,
  `svc-`, `system-`; suffix `-sync`, `-gateway`, `-bridge` — the SAME
  convention the dev-seed fixtures already use) renders with the distinct
  service glyph. This is DISPLAY-ONLY — it never writes back to `kind` and
  never feeds authorization.
- **Agents resolve from the SAME table, no join to `agent_card`** —
  `agent_card` carries no name/title column of its own (it is a per-agent
  CONFIG row: kc_client_id, LLM wiring, keyed by `employee_id`); the
  human-readable name always lives on the joined `employee.display_name` row,
  identically to a human. So "the agent registry" IS `choros.employee WHERE
  kind='agent'` — no second lookup needed.
- **Unresolved ids are not an error.** An id matching no employee row (an
  unresolvable KC sub, a system pseudo-actor, a stale slug) is simply ABSENT
  from the returned Map. `resolveActorDisplay(map, id)` is the convenience
  fallback accessor: `{ id, name: id, type: "service", resolved: false }` —
  the raw id becomes the honest displayed name (D2 honest-empty: never
  invent a false human/agent identity for an unverified actor), never a
  crash, never a blank.
- **Degrade-on-error is the CALLER's responsibility** (try/catch around
  `batchResolveActors`, falling back to an empty Map) — matches this
  repo's established convention (every read-projection call site degrades
  individually; see `audit-grant-trail.ts`'s own withTenant, `operational-
  analytics-dao.ts`).

### 2.2 Frontend primitives (`web/src/components/components.jsx`)

- **`asRenderableText(value)`** — React-error-#31 hardening: coerces any
  value that might accidentally be an actor OBJECT (e.g. a caller passing the
  whole `{type,name}` shape instead of `.name`) into a safe string
  (`.name` if present, else `JSON.stringify`, never throws). Every place a
  bare `{name}`-shaped JSX slot exists now runs through this guard.
- **`ActorChip({type, name, id, showId, bare})`** — the single primitive for
  rendering ANY actor (human/agent/service): glyph by type (reuses
  `ExecutorBadge`/`ExecGlyph` — not duplicated) + human-readable name in the
  MAIN text + the raw id ONLY as a `title` tooltip (and, with `showId=true`,
  a separate `<MonoId>` chip) — never the bare id in the flowing text.
- **`RecordRef({recordId, appId, headers, fetchImpl})`** — lazily resolves a
  record's title via `GET /api/records/:id` and renders it as a link to the
  record (`/apps/:appId/records/:id`); on load failure or missing label,
  falls back to a `<MonoId>` chip (never a bare unlabeled id, never a
  crash — honest degrade).

### 2.3 Wired call sites (readers)

| Reader | File | Fix |
|---|---|---|
| inbox `claimedBy` (all 3 item blocks: seed/defer/instance) | `src/http/inbox.ts` `findInboxItems` | one `batchResolveActors` call over the DISTINCT set of `claimStateMap` claimers per request; `execType`/`execName` now come from the resolved shape, `execSlug` carries the raw id additively |
| audit log `actor` | `src/http/audit.ts` `handleGetAuditLog` | batch-resolves the page's distinct actors, attaches `actorDisplay` additively (raw `actor` untouched for back-compat) |
| grant-trail `actor`/`subject` | `src/http/grant-trail.ts` `attachResolvedActors` | batch-resolves both columns' distinct values, attaches `actorResolved`/`subjectResolved` additively |
| analytics `top_actors` | `src/http/operational-analytics.ts` `handleGet` | batch-resolves distinct `top_actors[].actor`, attaches `actorResolved` additively |
| process-instance history `completedBy` | `src/http/processes.ts` `fetchInstanceHistoryDetail` via injected `ActorsDisplayResolver` (ports-and-adapters: `processes.ts` stays pg/db-import-free, FF-DISPLAY-4-style isolation — the resolver is injected through `StartInstanceDeps.resolveActorsDisplay`, wired in `src/server.ts` to `batchResolveActors`) | attaches `completedByName` per history step, one query per request regardless of step count |

Frontend consumers: `screen-audit.jsx` (`AuditEventRow`), `screen-process-
instance.jsx` (`HistoryRow`, `HistoryStepRow`, record-source →
`<RecordRef>`), `screen-inbox.jsx` (taken/pool executor badge → `ActorChip`),
`screen-operational-analytics.jsx` (`TopActorsTable`), `ra-grant-trail.jsx`
(`apiRowToDisplay` — see §3, the P1 fix).

## 3. P1 — `/rights/trail` (grant-trail screen)

**Finding, re-verified against this branch's HEAD**: the exact React #31
white-screen crash described in the UX study (an actor OBJECT rendered as a
bare JSX child) does **not** reproduce from `ra-grant-trail.jsx`'s current
code shape as of dev@46a6c7c — `apiRowToDisplay` already built
`actorDisplay`/`subjectDisplay` as `{type, name}` OBJECTS and the table
already passed them to `ExecutorBadge` via PROPS (`type={r.actor.type}
name={r.actor.name}`), not as a bare child — passing an object as a prop
value is legal React; only rendering an object directly as `{obj}` inside
JSX (a bare child) triggers #31. This suggests the crash was fixed by an
intervening commit between the UX-study snapshot (`dev@a4a7e0e`) and this
task's base (`dev@46a6c7c`) — no git history for `ra-grant-trail.jsx` shows a
dedicated fix commit, so most likely T-0547's DataTable migration
incidentally corrected the render path while migrating markup.

**The REAL defect that remained** (and is fixed by this task): the actor/
subject type was HARDCODED to `"human"` regardless of the ACTUAL actor kind
— `const actorDisplay = { type: "human", name: r.actor }` unconditionally. A
service/automation pseudo-actor (`policy-sync`, `control-plane`) or an agent
grantor would have rendered with the WRONG glyph (a human icon on a
non-human actor) — a real semantic bug, not a crash, but squarely inside
this task's столп-4 mandate ("agents/services visible as what they are").

**Fix**: `GET /api/grant-trail` now attaches `actorResolved`/`subjectResolved`
(§2.3 table) via the SAME `batchResolveActors`; `apiRowToDisplay` prefers
those over the hardcoded literal, falling back to an honest `{type:
"service", name: r.actor, resolved: false}` (never fabricating `"human"`)
when the backend could not resolve the actor. `ActorChip` replaces
`ExecutorBadge` in the table body (same underlying glyph, now the sanctioned
primitive with tooltip/technical-id support). `asRenderableText` hardening in
`components.jsx` additionally makes the WHOLE component tree crash-proof
against any FUTURE caller that passes an actor object where a string is
expected (regression guard for the #31 defect CLASS, even though this
specific screen was already clear of it).

## 4. Anti-recidivism gate — `ci/checks/ux/anti-uuid-actor-render.sh`

A repo-wide (not diff-scoped — this is a recidivism LOCK, not a migration-debt
tracker) static scan of `web/src/screens/**/*.jsx` for the EXACT defect class
this task fixed: a bare JSX-child render of a raw identifier field (`.actor`,
`.claimedBy`, `.completedBy`, `.assignee`, `.recordId`, `.execSlug`) NOT
wrapped by one of the sanctioned display primitives (`ActorChip`, `RecordRef`,
`MonoId`, `Mono`, `ExecutorBadge`, `AuditEvent`) on the same line. Comment-
scoped (a line's comment is stripped before matching) and prop-position-aware
(`>{expr}` — the JSX-child signature — vs `propName={expr}`, which is exactly
how these raw fields correctly reach the primitives today and must NOT be
flagged).

**Mode: REQUIRED (exit 1 on any hit)**, unlike the sibling G5/G6 UX gates
(which stay informational while pre-existing debt is paid down) — this
pattern was FULLY fixed by T-0648; any new occurrence is unambiguously a
regression, not accumulating debt.

**Mutation-tested** (not just self-test-synthetic): reverting `screen-
audit.jsx`'s `AuditEventRow` to its pre-fix shape (`<span>{ev.actor}</span>`)
in a scratch copy and pointing the gate at it reproduces exactly the flagged
line the gate is designed to catch — proving the detector fires on the REAL
historical regression pattern, not only a synthetic fixture.

## 5. What was deliberately NOT built (scope cut, see task report)

- A full JSX/AST-based static analyzer (the gate is a targeted regex scan,
  documented as such in its own header — broader coverage would require a
  real parser this repo's zero-dep bash fitness tier does not have).
- Sidebar/view-primitive/identity-hub/move-API work from the wider UX study
  (§1, §4, §5, §6.3-6.6, §7) — out of this task's explicit W4-UX slice
  (actor-resolver + ActorChip/RecordRef + rights-trail fix + anti-UUID gate).
- A "service" DB-level kind — deliberately kept DISPLAY-ONLY (naming
  convention heuristic), matching the schema's real 2-value CHECK constraint;
  introducing a 3rd DB value was explicitly out of scope (would require a
  migration + touches the closed-set CHECK, a different task's blast radius).

## 6. Anti-case discipline (D-064)

The resolver is fully GENERIC — it queries `choros.employee` by whatever ids
the caller passes, with zero hardcoded tenant/case names. Test fixtures use
generic names (`e-fixture-actor`, `Т. Фикстурин`) rather than case-specific
seed personas; two test-fixture uses of `e-orlov` were caught by `ci/checks/
anti-case-lock.sh` during this task's own gate run and renamed to
`e-fixture-assignee` before landing (see task report FRICTION).
