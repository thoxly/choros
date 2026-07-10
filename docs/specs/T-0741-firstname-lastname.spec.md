# Spec · T-0741 — UI-created accounts trip an extra "Account is not fully set up" gap: no firstName/lastName

**Phase:** DIAGNOSE + BUILD · **Status:** ready · **Date:** 2026-07-10
**Class:** UX/product P1 (follow-up on T-0734). **Root class:** product-defect (missing fields on a KC admin-create call).

## 1. Symptom

`createHumanUser` (`src/keycloak/admin-port.ts`, called from the "Создать учётку" form —
`POST /api/users`, `src/http/user-mgmt.ts`) sends `username/email/password/attributes.actor_type`
but **no `firstName`/`lastName`**. `config/keycloak/realm-choros.json`'s declarative user
profile keeps `firstName`/`lastName` `required.roles:["user"]` — the unmodified KC-25 default,
untouched by T-0734 (T-0734 only added the `actor_type` attribute declaration).

T-0734 §5 flagged this as an "out of scope" follow-up, describing it as "an interactive
`VERIFY_PROFILE` step on browser login (not a 401)". **This task's own live reproduction found
the gap is stricter than that description**: a **direct grant** (`grant_type=password`) against
a user created without firstName/lastName is rejected outright —
`400 invalid_grant "Account is not fully set up"` — no token is issued at all on that path (see
§3). The browser (authorization-code) flow degrades more gracefully (an interactive
update-profile screen the user can complete), but either way the UI-created account is not
login-ready on first use.

## 2. Root cause

`createHumanUser`'s Keycloak admin-REST payload never included `firstName`/`lastName`. KC 25's
declarative user profile enforces `required.roles:["user"]` for those two attributes at
profile-completeness checks that both grant types consult before issuing a token — a gap that
is invisible in this codebase's existing tests because none of them assert on token issuance for
a freshly UI-created user (all unit/db tests use `InMemoryKeycloakUserPort`, which does not model
KC's profile-completeness gate at all).

## 3. Fix

`createHumanUser` (`KcHumanUserSpec.displayName`, optional) now derives `firstName`/`lastName`
from the caller's free-text display name via `splitDisplayName()` (same file) and includes them
in the KC create payload whenever a non-blank `displayName` is provided.

**No new form field.** `POST /api/users`'s "Создать учётку" form (`screen-users.jsx`) already
collects `display_name` (a required field, "Отображаемое имя") — `user-mgmt.ts` now forwards it
as `displayName` to `kc.createHumanUser`. Less UX friction than adding a second name-entry step:
the owner never types a name twice.

`splitDisplayName(displayName)` convention (matches this codebase's own seed data —
`migrations/016_employee.sql`: `e-petrov` → KC `firstName="И." lastName="Петров"`,
`employee.display_name="И. Петров"`):
- **FIRST** whitespace-separated token → `firstName`.
- **REMAINDER** (rejoined with single spaces) → `lastName`.
- **Single-token name** (no space) → duplicated into BOTH fields (KC requires each
  independently non-empty; a blank `lastName` still trips the same gap).
- **Empty/whitespace-only** → `{firstName:"", lastName:""}` (defensive; `user-mgmt.ts`'s
  `validateCreateBody` already rejects an empty `display_name` upstream, so this should not be
  reachable from the product's own flow).
- No transliteration, no case-folding, no script assumption — Cyrillic/Latin/mixed pass through
  unchanged. KC's own `person-name-prohibited-characters` validator is the authority on legal
  characters, not this function (an illegal character surfaces as KC's own 400, unchanged).

**Deliberate scope boundary:** `src/core/register.ts` (self-registration, `POST /api/register`)
is UNCHANGED — it does not pass `displayName` to `createHumanUser`. Self-registration's own
`display_name` is literally the normalized email address (no real name is ever collected on that
form), so splitting it would produce nonsense (`firstName="user@company.ru"`,
`lastName="user@company.ru"`). `KcHumanUserSpec.displayName` is optional and back-compat: an
absent/blank value means `createHumanUser` sends no `firstName`/`lastName` at all — IDENTICAL
wire shape to before this fix. Self-registration therefore keeps its own (pre-existing, wider)
version of this same gap — flagged as a separate follow-up, not fixed here (T-0741 is scoped to
the admin-created-account path per its own task description).

## 4. Acceptance criteria

- **AC-1** `createHumanUser({..., displayName:"Иван Петров"})` sends KC
  `firstName:"Иван", lastName:"Петров"`.
- **AC-2** A single-token `displayName` (e.g. `"Мадонна"`) sends `firstName:"Мадонна",
  lastName:"Мадонна"` (both non-empty, no gap).
- **AC-3** `createHumanUser` called WITHOUT `displayName` (or with an empty one) sends NEITHER
  `firstName` NOR `lastName` — byte-identical to the pre-T-0741 payload (regression guard for
  `register.ts`'s call site).
- **AC-4** (anti-case) a display name with irregular whitespace (leading/trailing/double spaces)
  normalizes correctly — no leading/trailing space leaks into either KC field.
- **AC-5** (live) creating a user via the registrar admin-REST path WITH firstName/lastName
  derived this way, then requesting a direct-grant token for that user, succeeds (issues an
  `access_token`) — where the SAME creation without those fields fails
  `400 invalid_grant "Account is not fully set up"` (proven live, §5 below — this is the
  behavioral proof the gap is closed, not just that the payload shape changed).
- **AC-6** `POST /api/users` (the real HTTP route) forwards the request's `display_name` as
  `displayName` to `kc.createHumanUser` — proven via `InMemoryKeycloakUserPort`'s capture log in
  the existing live-Postgres DB test suite (`ci/checks/db/user-mgmt.db.test.ts`).

## 5. Live proof

Recorded in `docs/live-proof/T-0741-firstname-lastname.live-proof.md`. Local KC 25.0.6
(`t-0633-keycloak-1`, :8180, same image as T-0734's proof). Product dev stand not reachable from
this worktree at proof time (offline) — see that doc §4 for the deferred UI/browser-flow leg of
the live-proof plan.

## 6. Out of scope (follow-up findings)

- `src/core/register.ts` (self-registration) has the SAME underlying gap (no firstName/lastName
  sent) but with no real name to derive them from at all — its `display_name` is the email.
  Left unresolved; flagged for a separate task (not part of T-0734's or T-0741's stated scope).
- No change to `verifyClaims`, `actor_type` handling, or the T-0734 declarative-profile
  component — this task only adds two additional fields to an existing admin-REST payload.
