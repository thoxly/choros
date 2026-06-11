# Spec · T-0141 — Демо-тенант на dev: витрина в кликабельном слайсе

**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-11
**Task:** SP-2 — Showcase tenant raised on dev; clickable slice shows its data;
X-Dev-User switches demo personas; seed reset restores the reference state.
**Authoritative source:** `playbooks/demo-stand.md` §SP-2 (founder frame 2026-06-11)
**Depends on:** T-0140 DONE — `seed/showcase/pack.json`, `seed/importer.ts`,
`seed/cli.ts`, `src/http/seed-write.ts` (5 new POST + 4 DELETE + 2 GET endpoints)
all merged to dev.

**Foundation (do NOT contradict):**
- I-1 (invariant): pack applied through public REST APIs only — enforced by T-0140.
- I-2: one source of truth for demo content — `seed/showcase/pack.json`.
- I-3: genesis-owner (`e-owner`, migration 026) is system bootstrap — never deleted.
- I-4: `seed apply` is idempotent; `seed reset` restores reference state.
- I-5: public demo stand is founder-gated (T-0142). This task targets **dev only**.
- Dev auth mode: `CHOROS_AUTH_MODE=dev` (default); `X-Dev-User` header identifies actor.

---

## 0. Context — what T-0140 delivered

T-0140 (DONE) produced:
1. **`seed/showcase/pack.json`** — authoritative showcase pack: 1 tenant (`showcase`),
   3 departments, 7 positions, 12 employees (7 human + 5 agent), 10 roles (8 + 2 system),
   8 rights_cards (display plane), 8 process_instances (display plane), role_assignments,
   grants.
2. **`seed/importer.ts`** + **`seed/cli.ts`** — HTTP-only importer; `seed apply / reset` CLI.
3. **`src/http/seed-write.ts`** — 5 POST (tenants/departments/positions/employees/roles),
   4 DELETE, 2 GET endpoints; genesis-owner gate; idempotent (409=no-op).

What T-0140 did NOT do (deliberately out of its scope, now relevant for T-0141):
- Did not run `seed apply` on the live dev DB (no tenant named `showcase` exists yet).
- Did not wire `GET /api/org`, `GET /api/users`, `GET /api/rights`, `GET /api/processes`
  to serve showcase-tenant data instead of the hardcoded `DEV_TENANT_ID` fallback
  (`a0000000-0000-0000-0000-000000000001`) or the in-memory seed.
- Did not add persona-switching UI or a reset button to the slice.

---

## 1. Summary

Apply the showcase seed-pack to the dev database; ensure all five screens of the
clickable slice (inbox, org, processes, audit, rights) show showcase data when any
demo persona is active; make X-Dev-User persona switching work on all screens; and
provide a documented one-command seed reset that restores the reference state.
The task is complete when the founder can open the dev URL, pick any persona, navigate
all five screens, and see the showcase company — without any stale mock data.

---

## 2. Functional Requirements

### FR-1 — Showcase tenant applied on dev DB

The `seed apply --tenant showcase --pack showcase` command must succeed against the
live dev database (post-migration state, `DEV_TENANT_ID` already in DB). After apply:
- A tenant row with `slug='showcase'` exists in `choros.tenant`.
- All showcase departments, positions, employees, roles, role_assignments, grants
  are present in their respective tables under the showcase tenant.

### FR-2 — `GET /api/org` serves showcase data for showcase personas

When a request to `GET /api/org` carries `X-Dev-User: <showcase-employee-slug>`,
the response MUST return the org tree from the showcase tenant (departments, positions,
employees from `seed/showcase/pack.json`) — NOT from `DEV_TENANT_ID` in-memory fallback
and not from another tenant.

> Design note (for architect/coder): today `GET /api/org` hard-codes `DEV_TENANT_ID`.
> The mechanism to scope it to the actor's tenant is an implementation concern;
> the spec requires the behaviour, not the implementation.

### FR-3 — `GET /api/users` returns showcase human employees

`GET /api/users` (used by the dev login screen) MUST return the 7 human employees
from the showcase pack as selectable users. This is the source for the login picker
from which the founder switches personas.

### FR-4 — Demo personas: the four required roles

The showcase login picker MUST surface at minimum four demo personas representing
the four archetypal roles in SP-2 (owner / manager / executor / agent).
Concretely, from `seed/showcase/pack.json`:

| Persona label    | Employee slug (kind) | Human / agent |
|---|---|---|
| Владелец тенанта | `e-owner` (genesis-owner, migration 026) | human |
| Руководитель     | one human with a management-level position | human |
| Исполнитель      | one human with a worker-level position | human |
| Агент            | one agent employee | agent |

The exact employee slugs for the last three are resolved from `seed/showcase/pack.json`
at implementation time (coder reads the pack). The login screen already fetches
`/api/users` which returns humans only; agent personas require an additional mechanism
(see FR-7).

### FR-5 — All five screens populated with showcase data

After logging in as any showcase human persona:
- **Inbox** (`GET /api/inbox`): inbox items are scoped to the showcase tenant and the
  active persona; the screen renders without error (empty inbox is acceptable).
- **Org** (`GET /api/org`): shows 3 departments, 7 positions, 12 employees from pack.
- **Processes** (`GET /api/processes`): shows 8 process instances from the pack's
  display plane (`process_instances`).
- **Audit** (`GET /api/audit`): shows audit events scoped to the showcase tenant;
  empty log is acceptable at first apply.
- **Rights** (`GET /api/rights`): shows 8 rights_cards from the pack's display plane.

### FR-6 — Persona switching: logout + re-login

Dev persona switching is the existing dev-login flow: clicking "Выйти" in the nav
footer clears the session, the login picker re-appears, and the user selects a new
persona. This works today for any employee in `GET /api/users`. No new UI widget is
required — the existing login screen satisfies this.

> Not-goal: an in-session "switch persona" dropdown (beyond the existing logout flow).

### FR-7 — Agent personas in login picker

The login screen currently calls `GET /api/users` which returns **human** employees
only (`listHumanEmployees` filter: `kind = 'human'`). Agent personas (e.g. `a-recon`,
`a-invoice`, `a-triage`) are not surfaced.

For the demo-stand showcase, the founder should be able to log in as an agent employee
to see how the UI looks from an agent's perspective. Two sub-options:

**Option A (minimal):** Do nothing — agents are not in the picker; the founder demos
only human personas. Acceptable for the gate.

**Option B (preferred):** Add agents to the login picker as a separate section or
label them visually. Requires `GET /api/users` to optionally include agents (behind a
query param or always), or a separate endpoint.

**This spec selects Option A** (minimal, gate-sufficient). If the founder wants agent
login for the demo, that is a product-direction call that belongs in this task's
acceptance notes (see AC-12). No new engineering required to meet the gate.

### FR-8 — Seed reset: one-command reference restore

Running `node seed/cli.js reset --tenant showcase --pack showcase` against the dev DB
MUST restore the showcase tenant to the reference state defined in
`seed/showcase/pack.json`:
- Extra entities added by clicking/API after `seed apply` are removed.
- Missing entities are re-applied.
- Genesis-owner (`e-owner`) and system roles (`tenant-owner`, `budget-approver`)
  are never deleted.

This command is the documented "return to reference" step for the founder and for CI.
The command already exists from T-0140; this task verifies it works end-to-end against
the live dev DB and documents the reset procedure.

### FR-9 — `GET /api/rights` serves showcase rights_cards (display plane)

After `seed apply`, `GET /api/rights` MUST return the 8 rights_cards from the pack's
display plane — the same cards previously served from the `RIGHTS_SEED` in-memory
constant. No DB writes are involved (display plane, I-1 exception per T-0140 ADR §2.4).

The mechanism: the `GET /api/rights` handler is updated to load and serve `rights_cards`
from the pack file when `DATABASE_URL` is set (pack-file-serve path from T-0140 ADR §2.2).
The in-memory `RIGHTS_SEED` fallback remains for the no-DB path.

### FR-10 — `GET /api/processes` serves showcase process_instances (display plane)

After `seed apply`, `GET /api/processes` MUST return the 8 process instances from
`seed/showcase/pack.json`'s `process_instances` section — identical behaviour to
the existing `PROCESSES_SEED` in-memory constant, but read from the single source.

---

## 3. Non-Functional Requirements

- NF-1: All five screens must render without JS errors in a Chromium browser against
  the dev stack (`PORT=8080 node dist/index.js`).
- NF-2: `seed apply --tenant showcase --pack showcase` completes in under 30 seconds
  on dev hardware.
- NF-3: `seed reset --tenant showcase` completes in under 60 seconds on dev hardware.
- NF-4: No showcase-tenant data is visible to the genesis-owner's hardcoded
  `DEV_TENANT_ID` (`a0000000-0000-0000-0000-000000000001`) tenant — no cross-tenant
  leakage (T-0013 tenant isolation invariant).
- NF-5: The dev login screen must list at minimum 6 human employees (the 7 humans in
  the showcase pack minus `e-owner` who has no position, or all 7 if position is null-OK).
- NF-6: Persona-switch round-trip (logout → pick new persona → navigate to org) takes
  under 3 seconds on dev hardware.

---

## 4. Out of Scope

1. Public demo stand deployment (T-0142, stage 2 — requires T-0060 Keycloak + founder
   server creds + DNS; not this task).
2. Scheduled `seed reset` cron (T-0142).
3. In-session "switch persona" dropdown widget (persona switching = existing logout flow).
4. Agent personas in the login picker (Option A selected — FR-7; escalation note in AC-12).
5. Removing in-memory `ORG_SEED` / `PROCESSES_SEED` / `RIGHTS_SEED` fallbacks from
   source files — they remain as no-DB fallbacks per T-0140 FR-5 / I-2.
6. Keycloak integration (T-0054/T-0060) — dev auth mode only.
7. Any change to `CHOROS_AUTH_MODE` from `dev`; this task runs in `dev` mode only.
8. Trial-tenant blank pack use (T-0142+).
9. New migration DDL — the showcase data lives in the seed pack, not migrations.
10. Flowable BPMN live process instances — process display is static display-plane data.

---

## 5. Acceptance Criteria

| ID | Text | Verifiable as |
|---|---|---|
| AC-1 | `seed apply --tenant showcase --pack showcase` on the dev DB exits 0 and `GET /api/tenants/showcase` returns `{ id: <uuid>, slug: "showcase" }` | test |
| AC-2 | After apply, `GET /api/org` with `X-Dev-User: e-kravtsova` (or any showcase human slug) returns exactly 3 departments from the showcase pack | test |
| AC-3 | After apply, `GET /api/org` response contains exactly 7 positions and 12 employees total (matching `seed/showcase/pack.json` counts) | test |
| AC-4 | After apply, `GET /api/users` returns ≥ 6 human employees with `id`, `name`, `position`, `department` fields; all returned IDs are valid showcase employee slugs | test |
| AC-5 | The dev login screen (`http://localhost:8080/`) shows a list of users populated from `GET /api/users`; clicking a user logs in and the shell renders with the user's name in the nav footer | manual |
| AC-6 | After logging in as any human showcase persona, navigating to `/org` renders 3 department cards without JS error | manual |
| AC-7 | After logging in as any human showcase persona, navigating to `/processes` renders 8 process-instance rows without JS error | manual |
| AC-8 | After logging in as any human showcase persona, navigating to `/rights` renders 8 role cards without JS error | manual |
| AC-9 | After logging in as any human showcase persona, navigating to `/audit` renders the audit log without JS error (empty is acceptable) | manual |
| AC-10 | After logging in as any human showcase persona, navigating to `/inbox` renders the inbox without JS error (empty is acceptable) | manual |
| AC-11 | `GET /api/rights` after apply returns a JSON array of exactly 8 role-card objects; each object has at minimum the fields `{ role_slug, name, grants }` | test |
| AC-12 | (Optional gate note) Agent personas are NOT in the `/api/users` response (Option A). If the founder requires agent-persona login for the demo, record as a blocking note before final gate sign-off; no code change required for the gate itself | manual |
| AC-13 | `GET /api/org` with `X-Dev-User: e-kravtsova` does NOT return data from `DEV_TENANT_ID` tenant (`a0000000-0000-0000-0000-000000000001`) — the response must reflect showcase-tenant data, not the dev-silo default | test |
| AC-14 | `seed reset --tenant showcase` after manually `POST /api/departments` adding an extra department returns exit 0 and a subsequent `GET /api/org` returns exactly 3 departments | test |
| AC-15 | `seed reset --tenant showcase` never deletes the `e-owner` employee row (query `choros.employee WHERE slug='e-owner'` still returns a row after reset) | test |
| AC-16 | Persona switch: logout (click "Выйти") → login picker shows user list → select a different persona → nav footer shows the new user's name | manual |
| AC-17 | The dev stack starts with a single command (`npm run start` or `PORT=8080 node dist/index.js`) and `seed apply` command is documented in the repo README or a runbook | manual |
| AC-18 | `GET /api/processes` after apply returns 8 process-instance objects; each has at minimum `{ id, name, status, progress }` fields | test |

---

## 6. Founder Acceptance Steps (gate for T-0142)

The task is ready for the founder's gate check when all manual ACs above pass on the
live dev environment (Tailscale `100.121.76.86:8080` or local `localhost:8080`).

**Reproducible walkthrough for the founder:**

```
Step 1 — Start the dev stack (if not running):
  cd /srv/choros   # (or local choros repo)
  docker compose up -d postgres
  DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
    npm run migrate
  PORT=8080 DATABASE_URL=... node dist/index.js

Step 2 — Apply showcase seed (idempotent — safe to re-run):
  node seed/cli.js apply --tenant showcase --pack showcase \
    --base-url http://localhost:8080

Step 3 — Open the browser:
  http://localhost:8080/

Step 4 — Login picker: choose one of these personas:
  - «Е. Ларина» (Финансовый директор) — high-privilege human
  - «А. Кравцова» (Контролёр расчётов) — mid-level human
  - «К. Орлов» (Линия поддержки L1) — worker-level human

Step 5 — Navigate all five screens:
  /org        → company org tree, 3 departments
  /processes  → 8 process instances in various statuses
  /rights     → 8 role cards
  /audit      → audit log (may be empty on first apply)
  /inbox      → task inbox (may be empty on first apply)

Step 6 — Switch persona: click «Выйти» → pick different user.

Step 7 — Seed reset (demonstrate idempotency):
  node seed/cli.js reset --tenant showcase --pack showcase \
    --base-url http://localhost:8080
  Refresh browser — org and rights still show showcase data.
```

**Gate outcome:** If the founder confirms the walkthrough is satisfactory, T-0141 moves
to DONE and T-0142 (stage 2, public stand) is unblocked.

---

## 7. Blocking Questions

None. All design decisions (tenant scoping mechanism, persona set, display-plane serving
from pack file, seed reset procedure, agent personas as Option A) are derivable from
the founder frame (`playbooks/demo-stand.md` §SP-2), the T-0140 ADR invariants, and the
existing codebase. Status: **ready**.
