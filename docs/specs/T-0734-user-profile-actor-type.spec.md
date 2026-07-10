# Spec · T-0734 — UI-created accounts are dead: KC 25 declarative profile drops `actor_type`

**Phase:** DIAGNOSE + BUILD · **Status:** ready · **Date:** 2026-07-10
**Class:** security P1, product-breaking. **Root class:** product-defect (config/infra).

## 1. Symptom

A human user created from the product UI ("Создать учётку" → `POST /api/users` →
`createHumanUser`, `src/keycloak/admin-port.ts`) cannot use the product at all:
`verifyClaims` (`src/http/auth.ts:302`) returns **401 on every request** because the
user's login token carries **no `actor_type` claim**.

Asymmetry: **seeded** fixture users (e-kravtsova …) work; **UI-created** users 401.

## 2. Root cause (confirmed LIVE against KC 25.0.6, realm `choros`, :8180)

Keycloak 25.0.6 ships the **declarative User Profile** GA with
`unmanagedAttributePolicy = DISABLED` by default. `config/keycloak/realm-choros.json`
had **no user-profile declaration**, so the default managed set is only
`username / email / firstName / lastName`. `actor_type` is therefore an *unmanaged*
attribute and KC **silently drops it** on every admin-REST write (`POST /admin/realms/<realm>/users`).

- `createHumanUser` sends `attributes.actor_type=["human"]` → KC returns **201** but the
  stored user has **`attributes: NONE`** (reproduced).
- The `actor-type-mapper` (`oidc-usermodel-attribute-mapper`) then has no attribute to
  read → token has no `actor_type` → `verifyClaims` 401 (reproduced: claim `<<MISSING>>`).
- **Seeded users escape** because realm-**import** writes attributes straight to the DB,
  bypassing profile validation (reproduced: seeded token `actor_type='human'`).

The protocol-mapper was never the problem — it is correct and shared; the attribute
simply never persists on the admin-REST path.

Corroborated by the T-0705 builder + judge (`T-0705.review.{md,json}`) and prior memory
(T-0638: realm-reimport wipes `actor_type`).

## 3. Fix

Declare `actor_type` as a **managed, admin-editable, options-validated** user-profile
attribute so the admin-REST write persists it, delivered via the **realm-import-native
`components` entry** (`org.keycloak.userprofile.UserProfileProvider` → provider
`declarative-user-profile`) in `config/keycloak/realm-choros.json` — the ONLY shape KC 25
`--import-realm` actually activates (empirically proven; a top-level `userProfile` key
fails import, a bare `kc.user.profile.config` realm attribute is ignored). See ADR §2 for
the rejected alternatives.

`actor_type` declaration:
- `permissions.edit = ["admin"]` — registrar (manage-users = admin context) persists it;
  a human can **never** set/change their own `actor_type` (no self-escalation).
- `validations.options = ["human","agent"]` — the value is pinned to the actor vocabulary
  (an invalid value is **rejected 400** `error-invalid-value`, not silently accepted).
- not `required`, `multivalued:false` — does not force `VERIFY_PROFILE` at login and does
  not interfere with `setUserEnabled` PUT `{enabled}` (which leaves `actor_type` intact).

`scripts/kc-dev-setup.sh` step 5 extracts the SAME embedded config and re-applies it via
`PUT /users/profile` so **persistent** stands (realm already imported before this fix;
`--import-realm` will not re-import into an existing realm) also get it reconciled.

## 4. Acceptance criteria (all proven live — see §6)

- **AC-1** UI-path admin-REST create → stored user retains `actor_type=["human"]`.
- **AC-2** That user's login token carries `actor_type="human"` → `verifyClaims` passes (no 401).
- **AC-3** (anti-case) an invalid `actor_type` (e.g. `superadmin`) is **rejected 400**.
- **AC-4** (regression) seeded users still carry `actor_type` in their token.
- **AC-5** (regression) `setUserEnabled` PUT `{enabled:false}` does not wipe `actor_type`.
- **AC-6** the exact committed `realm-choros.json` produces AC-1/AC-2 through the KC
  **import** deserializer (fresh-provision / CI `--import-realm` path).
- **AC-7** static fitness (`ci/checks/kc/user-profile-actor-type.sh`) fails the build if the
  declaration regresses; live fitness (`ci/checks/kc/ui-created-user-actor-type.sh`) proves
  the behavior end-to-end.

## 5. Out of scope (follow-up findings)

- `createHumanUser` sends no `firstName/lastName`; because those stay `required:[user]` in
  the profile (unchanged KC default), a UI-created user hits an interactive `VERIFY_PROFILE`
  step on **browser** login (not a 401; browser flow completes it). Separate UX/product task
  — the account should collect a display name. **Not** the `actor_type` 401.
- No change to `verifyClaims`, protocol-mappers, or the seeded/import path semantics.

## 6. Live proof

Recorded in `docs/live-proof/T-0734-user-profile-actor-type.live-proof.md`. Local KC :8180
(`t-0633-keycloak-1`, KC 25.0.6). Before: stored `attributes: NONE`, token claim
`<<MISSING>>`. After: stored `{"actor_type":["human"]}`, token claim `'human'`; invalid
value → 400; seeded regression green; `setUserEnabled` regression green; committed artifact
import path green.
