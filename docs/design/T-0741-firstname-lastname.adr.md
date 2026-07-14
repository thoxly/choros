# ADR · T-0741 — Derive KC firstName/lastName from the already-collected display name

**Phase:** DESIGN · **Status:** ready (no founder escalation) · **Date:** 2026-07-10
**Task:** T-0741 (UX/product P1, follow-up on T-0734) — a UI-created account cannot obtain a
login token until an interactive profile-update step fills in firstName/lastName; a direct grant
on such an account fails outright.
**Spec (input):** `docs/specs/T-0741-firstname-lastname.spec.md`.
**Companion:** T-0734 (`docs/design/T-0734-user-profile-actor-type.adr.md`) — that task fixed
`actor_type` persistence (401 on every request); this task closes the SAME family's remaining
§5 "out of scope" finding (a UI-created account is still not login-ready on first use).

---

## 1. Context

`createHumanUser` (`src/keycloak/admin-port.ts`) sends
`username/email/enabled/emailVerified/attributes.actor_type/credentials` to KC's admin-REST
`POST /users` — never `firstName`/`lastName`. `config/keycloak/realm-choros.json`'s declarative
user profile (added by T-0734, but this pair predates it — see T-0054) keeps those two
`required.roles:["user"]`, the unmodified KC-25 default set.

Live reproduction (`t-0633-keycloak-1`, 2026-07-10) shows this is **not** a cosmetic gap:

```
# user created WITHOUT firstName/lastName
POST /admin/realms/choros/users -> 201
POST /realms/choros/protocol/openid-connect/token grant_type=password
  -> 400 {"error":"invalid_grant","error_description":"Account is not fully set up"}

# SAME creation WITH firstName/lastName present
POST /admin/realms/choros/users -> 201
POST /realms/choros/protocol/openid-connect/token grant_type=password
  -> 200 {"access_token": "...", ...}
```

Direct grant (used by every fitness/live-proof script and — per T-0734's `ROPC` verification
pattern — the same code path a real token request exercises) hard-fails without those fields.
The browser (authorization-code) flow is more forgiving (an interactive "Update profile" screen
completes it), but either way a UI-created account is not immediately usable.

## 2. Decision

Reuse the display name the "Создать учётку" form (`web/src/screens/screen-users.jsx`) **already
collects** (`display_name`, a required field since T-0583) instead of adding a second
firstName/lastName entry pair to the form.

1. `KcHumanUserSpec` (`src/keycloak/admin-port.ts`) gains one optional field: `displayName?:
   string`.
2. `createHumanUser`'s live adapter (`makeHttpKeycloakAdminPort`'s sibling
   `makeHttpKeycloakUserPort`) splits it via `splitDisplayName()` (same file, exported for unit
   tests) and includes `firstName`/`lastName` in the KC payload IFF `displayName` is present and
   non-blank. Absent/blank → **no change** to the payload shape (back-compat for
   `register.ts`'s call site, which does not pass it — see §3).
3. `src/http/user-mgmt.ts`'s `POST /api/users` handler passes `displayName: display_name` (the
   validated field it already has in scope) on its `kc.createHumanUser` call. One line.
4. `screen-users.jsx`'s "Отображаемое имя" field gets an explanatory hint ("имя и фамилия — так
   учётка сразу готова ко входу…") and its placeholder is corrected from `"Иванов Иван"`
   (surname-first, which would misfeed `splitDisplayName`'s firstName-first convention) to
   `"Иван Петров"` (firstName-first, matching both the split convention AND this codebase's own
   seed-data convention — see §2.1).

### 2.1 Split convention — why firstName-first

No structured first/last-name storage exists anywhere in this schema (`employee` has only
`display_name text NOT NULL`, migration 016) — a free-text split is inherently a heuristic, not a
guaranteed-correct parse. The convention is anchored on this codebase's OWN precedent rather than
invented fresh: `migrations/016_employee.sql`'s seed employees pair a KC `firstName`/`lastName`
with a matching `employee.display_name` —

```
e-kravtsova: KC firstName="А." lastName="Кравцова"   ↔ display_name="А. Кравцова"
e-petrov:    KC firstName="И." lastName="Петров"     ↔ display_name="И. Петров"
```

i.e. `display_name`'s FIRST token is `firstName`, the remainder is `lastName`. `splitDisplayName`
matches this exactly: first whitespace-separated token → firstName, remainder (rejoined) →
lastName.

**Known limitation (accepted, not solved):** a free-text "display name" field cannot losslessly
encode which token is a legal first name vs. a legal surname — a name given in the opposite order
(surname-first) or with more than two components (patronymic, double surname) will land in
firstName/lastName cells KC treats as opaque strings and this product never re-displays
separately (only `employee.display_name`, the ORIGINAL string, is shown anywhere in the product
UI — `AccountRow` in `screen-users.jsx` renders `account.display_name` directly, never KC's
firstName/lastName). The split's ONLY purpose is satisfying KC's required-attribute
completeness check, not producing a canonically correct firstName/lastName pair for KC's own
account console. This is why the fix is safe even though the split is a heuristic: no code path
in this product reads KC's firstName/lastName back out and displays it as ground truth.

### 2.2 Single-token names — duplicate, don't leave blank

A one-word display name (e.g. a mononym, or an owner who just types "Admin") has no second token
to assign to `lastName`. Leaving it blank re-introduces the exact "Account is not fully set up"
gap this task closes (KC requires BOTH fields independently non-empty). Duplicating the single
token into both fields keeps both non-empty without inventing a value — the accepted trade-off
given `employee.display_name` (the string actually shown everywhere) is unaffected.

## 3. Alternatives rejected

- **(a) Add separate "Имя"/"Фамилия" fields to the create-account form**, dropping
  `display_name` (or deriving it FROM firstName+lastName instead). Rejected: strictly MORE
  typing for the owner (two fields instead of one) for a value (`employee.display_name`, the
  single column that actually renders everywhere in this product) that already exists and reads
  fine as free text — Russian ФИО conventions do not cleanly decompose into two Western-style
  fields anyway (patronymic, initials-only, single-name display preferences). The task's own
  framing ("меньше UX-трения = лучше, не заставлять вводить второй раз") rules this out directly.
- **(b) Add firstName/lastName fields ADDITIONALLY (keep display_name too)**. Rejected for the
  same reason, softened: still adds typing for a value this product never displays separately
  from `display_name` (§2.1) — pure cost, no product-visible benefit over the split.
  `register.ts`'s parallel gap (§4 of the spec, out of scope) would need the identical two new
  fields on ITS form too (self-registration's org-signup screen) for consistency, compounding the
  cost across two forms for a KC-internal requirement the product does not otherwise care about.
- **(c) Relax the KC declarative profile's `required` constraint on firstName/lastName** (mirror
  T-0734's `actor_type` treatment — declare them optional). Rejected: unlike `actor_type`
  (a purely internal claim, never surfaced to KC's own UI), firstName/lastName are KC's own
  profile-completeness primitives baked into its auth flows (direct grant's "Account is not fully
  set up" check, the browser VERIFY_PROFILE/update-profile screen) — loosening them changes KC's
  behavior for EVERY realm client, not just this product's admin-create path, and does not
  address the actual friction (the FIELD is still empty, just no longer enforced — a worse UX,
  not a better one, since KC's own account console would then show a genuinely blank name).
  Populating the fields (this ADR's choice) is strictly more correct than disabling the check.

## 4. Security / anti-case

- No new authority surface: `displayName` flows through the SAME `POST /api/users` request body
  field (`display_name`) already gated by `authorizeOrgWrite` + `assertOrgObjectAuthority`
  (T-0469) before `validateCreateBody` even runs — this task adds no new input, only reuses an
  already-validated one.
- `splitDisplayName` is a pure string function — no injection surface (KC's own admin-REST JSON
  body construction is unchanged elsewhere; firstName/lastName are ordinary JSON string values,
  same as `username`/`email` already are).
- Anti-case (spec AC-3): `register.ts`'s self-registration call site is verified to remain
  byte-identical (no `firstName`/`lastName` keys at all) — a regression here would silently start
  sending an email address as both KC name fields, which this ADR explicitly rejects (§3(c)
  discussion of what NOT to do with register.ts).

## 5. Fitness

- **Unit** (`src/__tests__/admin-port.test.ts`): `splitDisplayName` cases (two-token, one-token
  duplication, irregular whitespace, empty) + an HTTP-capture test proving the actual `POST
  /users` body carries `firstName`/`lastName` when `displayName` is set and omits them when it
  is not (regression guard for `register.ts`).
- **DB-live** (`ci/checks/db/user-mgmt.db.test.ts`, existing FF-583-1 test extended): asserts
  `InMemoryKeycloakUserPort`'s capture log recorded the `displayName` the real HTTP route forwarded
  — proves the `user-mgmt.ts` wiring, not just the port in isolation.
- **Live-KC** (manual, recorded in `docs/live-proof/T-0741-firstname-lastname.live-proof.md`):
  reproduces the RED (`invalid_grant "Account is not fully set up"`) and GREEN (token issued)
  states directly against `t-0633-keycloak-1`, matching T-0734's own proof methodology.
