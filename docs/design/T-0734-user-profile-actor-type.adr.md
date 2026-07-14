# ADR · T-0734 — Declare `actor_type` as a managed user-profile attribute (KC 25 declarative profile)

**Phase:** DESIGN · **Status:** ready (no founder escalation) · **Date:** 2026-07-10
**Task:** T-0734 (security P1, product-breaking) — UI-created human accounts 401 on every
request because their login token carries no `actor_type` claim.
**Spec (input):** `docs/specs/T-0734-user-profile-actor-type.spec.md`.
**Supersedes the profile intent of:** `docs/design/T-0054-keycloak-compose.adr.md` (which
pinned `actor_type=human` on seeded users but never declared it in a user profile — invisible
until KC 25's declarative profile went GA-default).

> Infra/config ADR: it changes the committed realm import + the dev reconcile script + adds
> two fitness checks. No application (TS) code changes.

---

## 1. Context

KC 25.0.6 enables the **declarative User Profile** by default with
`unmanagedAttributePolicy = DISABLED`. Any attribute not declared in the profile is
**silently dropped on admin-REST writes**. `actor_type` was never declared, so
`createHumanUser` (admin `POST /users`) loses it → no token claim → `verifyClaims`
(`src/http/auth.ts:302`) 401s every request. Seeded users survive only because realm-import
writes attributes directly to the DB, bypassing profile validation. Confirmed live (spec §2).

## 2. Decision

Declare `actor_type` as a **managed** profile attribute:
`permissions.view=["admin","user"]`, `permissions.edit=["admin"]`,
`validations.options=["human","agent"]`, `multivalued:false`, not `required`.

Deliver it as the **realm-import-native component** in `config/keycloak/realm-choros.json`:

```
components → "org.keycloak.userprofile.UserProfileProvider" → [
  { providerId: "declarative-user-profile",
    config: { "kc.user.profile.config": [ "<stringified profile: default set + actor_type>" ] } }
]
```

The embedded profile re-declares the full KC-25 default managed set
(`username/email/firstName/lastName`, byte-for-byte, so their built-in behavior is
unchanged) and adds `actor_type`.

`scripts/kc-dev-setup.sh` step 5 extracts the SAME embedded config and re-applies it via
`PUT /admin/realms/<realm>/users/profile` for **persistent** stands (one source of truth,
no drift).

### 2.1 Why the component shape (mechanism selection — empirically decided)

`--import-realm` is the ONLY provisioning step in CI (`.github/workflows/ci.yml` `kc` job)
and on fresh stands; `kc-dev-setup.sh` runs only on persistent stands. So the profile MUST
apply through realm import. Probed all three shapes live against KC 25.0.6:

| Import shape                                        | Result                                  |
|-----------------------------------------------------|-----------------------------------------|
| top-level `"userProfile": {…}` key                  | import **400** — not a valid realm field |
| realm attribute `kc.user.profile.config` (string)   | import 201 but profile **NOT activated** |
| **`components.…UserProfileProvider` (this ADR)**     | profile **activated**, `actor_type` persists ✅ |

The task's suggested option (а) — a top-level `userProfile` key consumed only by
`kc-dev-setup.sh` — is **insufficient**: it never reaches CI / fresh-provision. The component
shape covers both paths.

## 3. Alternatives rejected

- **(б) Hardcode `actor_type` via a client-scope constant mapper.** Would stamp `human` on
  every `choros-api`/`choros-web` token regardless of the stored attribute — decouples the
  claim from the real per-user value, cannot represent a non-human on a human client, and is
  a security-semantic hack. The existing user-attribute mapper is already correct; the bug is
  attribute persistence, not mapping. Rejected.
- **(в) `unmanagedAttributePolicy: ENABLED`.** Least-change but weakest: lets **any**
  attribute pass unvalidated, so `actor_type` could be stamped with an arbitrary value by any
  admin-context writer. A declared attribute with an `options` validator both persists AND
  pins the value to `{human,agent}` (proven: invalid value → 400). Rejected in favor of the
  stricter declaration.
- **Top-level `userProfile` key + kc-dev-setup only (task option а).** Rejected per §2.1
  (does not apply on the import-only paths).

## 4. Security / anti-case

- `edit=["admin"]` only → a human cannot self-assign/escalate `actor_type`.
- `options=["human","agent"]` → an invalid `actor_type` is rejected **400
  `error-invalid-value`**, not silently coerced. This is the anti-case gate (spec AC-3).
- `not required` + `multivalued:false` → `setUserEnabled` PUT `{enabled}` leaves `actor_type`
  intact (proven AC-5) and login is not forced through `VERIFY_PROFILE` on account of it.

## 5. Recovery / operational note (realm-reimport hazard)

`--import-realm` imports **only into an empty realm**; it will NOT re-import into the existing
persistent-stand realm. To apply this fix on a persistent stand **without** wiping the volume,
run `bash scripts/kc-dev-setup.sh` (step 5 reconciles the profile via `PUT /users/profile`).
Do **NOT** delete + re-import the realm to force it: a full reimport recreates users and, per
memory (T-0638), can strip `actor_type` from existing users and reset fixture passwords
(then reconcile with `scripts/kc-reset-fixture-passwords.sh`). The reconcile path is
non-destructive and idempotent — prefer it.

## 6. Fitness

- **Static (always-on `fitness`):** `ci/checks/kc/user-profile-actor-type.sh` — parses the
  committed realm JSON and fails if `actor_type` is not declared admin-editable /
  not-user-editable / options=[human,agent]. Locks the exact regression.
- **Live (`fitness:kc`):** `ci/checks/kc/ui-created-user-actor-type.sh` — creates a user via
  the registrar admin-REST path, asserts the attribute persists and the token carries
  `actor_type` (the true behavioral proof).
