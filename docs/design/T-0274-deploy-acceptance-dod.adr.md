# ADR T-0274 — Anchor the factory's Definition-of-Done on deploy-acceptance journeys

- **task_id:** T-0274
- **status:** ready
- **role:** DESIGN (architect)
- **supersedes/extends:** D-056 (integration-honest gate), ADR T-0278 (deploy-acceptance
  ТЭЛ gate), D-053 (auto-merge to dev), D-062 (UX honest-gate informational→required pattern)

---

## Context

The founder ratified this as a **hard barrier** ("ЖЁСТКИЙ барьер, решено",
`docs/founder-feed.md` 🟢 #2 / #3): an implementation task must NOT be marked **done**
until its **browser-journey is green on the DEPLOYED container** — not merely "PR merged /
CI green on branch". This is the product-level antidote to the recurring root failure
"agents say done but there is no working product" (the ТЭЛ form leaked exactly this way:
unit-green on a branch, dead on the deployed витрина).

### What already exists (the substrate this ADR wires together)

1. **A data-driven deploy-acceptance journey runner (T-0257).**
   `e2e/journeys/runner.ts` executes a `Journey` (an ordered list of declarative steps:
   `login/goto/click/fill/expectVisible/expectText/expectCount/pollApi/apiCheck`) against
   the **deployed product** — the real built `web/dist` served by the real HTTP server,
   against live Postgres + Flowable, **no mocks** (FF-3 / NF1 / D-056). Journeys are
   discovered by glob (`e2e/journeys/loader.ts::discoverJourneyFiles` → `*.journey.ts`):
   adding a journey is dropping a file, zero runner-code change. Fail-honest: every
   assertion is a hard `expect`, `retries: 0`.

2. **A `deploy-acceptance` CI job (ADR T-0278 / T-0283).** `.github/workflows/ci.yml`
   already brings up Postgres + Flowable via compose, runs migrations, installs Playwright
   Chromium, and runs `npm run acceptance:tel` (the U1→U5 ТЭЛ click-through) against a
   live server built from the checkout. **It is currently `continue-on-error: true`
   (advisory).** It was flipped to required once (T-0284) then **reverted to informational**
   by the orchestrator with an explicit note: "the required-flip was an overstep — it is
   unproven in the GitHub runner and the founder-go gate for the E13 honest-gate plan
   (T-0274) is still pending. Keep non-blocking until validated in CI and the founder flips
   it under E13." **This ADR is that T-0274 decision.**

3. **Auto-deploy on push to dev (`deploy-dev` job).** Substantive jobs
   (`ci, db, kc, stack, flowable`) gate the Tailscale→SSH→rebuild deploy of the dev
   container. `deploy-acceptance` is deliberately **excluded from `deploy-dev.needs`** —
   it is informational, so today a non-clickable product still auto-deploys. That is
   precisely the leak.

4. **The factory DoD lives in Demiurge loop docs.** `release(done)` fires after green gates
   (`prompts/dev-loop.md` §Выход; `agents/orchestrator.md` rule 11; `agents/reviewer.md`,
   `agents/tester.md`). The honest-gate pattern (D-056) already states the invariant
   "green-on-branch == green-on-dev". `agents/*.md` and `prompts/dev-loop.md` are in the
   **free zone** (`constitution/zones.md` §2) but every edit to them is a **self-improvement**
   and is therefore a **GV-2 singleton** action (under `self_improve_lock`), never a
   parallel dev-loop task.

---

## Decision

Anchor the factory DoD on deploy-acceptance via **option (c): BOTH layers, mechanically
separated** — the choros CI **required check** is the hard barrier that mechanically
forbids "done"; the Demiurge loop-doc rule **encodes the policy** so the orchestrator/
reviewer never *try* to release(done) past a red (or absent) journey.

Concretely, five decisions:

### (1) WHERE the gate lives — **both**, with the enforcement teeth in choros CI

- **Mechanical teeth: a choros CI required-check job** (`deploy-acceptance`, already
  present) flipped from advisory to blocking, and made a **dependency of the dev integration
  itself** so a red journey blocks the merge/deploy that "done" rides on.
- **Policy encoding: a Demiurge loop-doc rule** (`prompts/dev-loop.md` gate table +
  `agents/orchestrator.md` MERGE rule + `agents/reviewer.md`/`tester.md`) that names the
  deploy-acceptance journey as a **mandatory gate for gated tasks** before `release(done)`.

**Why both, not one:** CI alone (option a) is the *only* thing that mechanically prevents
"done" — a doc rule is advisory to an LLM and can be rationalized past. But CI alone does
not teach the orchestrator *when* a task is gated vs exempt (scope predicate), so the loop
would either over-block backend tasks or skip the gate selectively. The doc rule (option b)
makes the predicate explicit and auditable; the CI check makes it un-bypassable. This is the
exact shape of D-062 (UX honest-gate): deterministic gate in CI is primary, the role docs
point at it. We reuse a proven pattern rather than invent one.

### (2) HOW it becomes a HARD barrier (not advisory)

The single mechanical enforcement point: **remove `continue-on-error: true` from the
`deploy-acceptance` job AND add `deploy-acceptance` to `deploy-dev.needs`.**

- Today `deploy-dev.needs = [ci, db, kc, stack, flowable]`. A red `deploy-acceptance` is
  invisible to the deploy. After the change, `deploy-dev.needs = [ci, db, kc, stack,
  flowable, deploy-acceptance]`: **a non-clickable product fails the merge-to-dev's deploy
  and the required-check set**, so "PR green / merged" can no longer coexist with "journey
  red". The DoD ("done" = green journey on the deployed container) is now a property the
  pipeline *cannot* violate, not a courtesy — "gate = removed possibility, not politeness"
  (orchestrator rule 3).
- The chicken-and-egg of D-056 (a gate that is red at the moment it becomes required would
  red-line dev) is handled exactly as T-0284 did: **the flip lands only when the named
  journey is already green in the GitHub runner** (validated by the BUILD task, not asserted
  by this ADR). Until then the job stays advisory. The flip is the last, separately-verified
  step.
- **Self-improve-lock interplay (founder's "строгость гейта" leash):** the *founder* is the
  one who declared this hard (founder-feed 🟢 #2). The choros-CI flip is a normal dev-loop
  change (free to build); but it operationalizes a **leash** decision (what the system counts
  as "done"), so the **Demiurge-side** rule that records the policy is GV-2/self-improve-locked
  (see §5). We do not let the system *loosen* this gate autonomously later — tightening is
  founder-applied (D-026/D-061 retro-learning).

### (3) SCOPE — which tasks the gate applies to (the predicate)

A task is **deploy-acceptance-gated** iff it satisfies the predicate:

> **GATED ⇔ the task touches `web/` (diff intersects `web/**`) OR the task declares/owns a
> journey (its branch adds or modifies an `e2e/journeys/*.journey.ts`).**
> **EXEMPT ⇔ pure-backend** (no `web/**` diff and no journey declared).

- A gated task **must** have at least one green `*.journey.ts` exercising its user-facing
  surface on the deployed container. The orchestrator, at SPEC/DESIGN of a UI-facing task,
  ensures a journey exists or is authored as part of the task (zero runner change — drop a
  file).
- An exempt (pure-backend) task is **never blocked by the absence of a journey** — it has no
  user-facing surface to click. It still rides the *existing* required jobs (`ci, db, kc,
  stack, flowable`); the suite of *already-merged* journeys still runs and must stay green
  (a backend change that breaks a clickable flow is caught), but a backend task is not
  required to *add* a journey.
- This mirrors the **UX_REVIEW conditional-phase predicate** verbatim (`agents/orchestrator.md`
  §"UX_REVIEW — условная фаза", `prompts/dev-loop.md`: "трогает `web/` ⇒ фаза; иначе
  пропускается, бэкенд не тормозит"). Reusing the same predicate keeps one mental model and
  avoids the failure mode of blocking legitimately-journey-less backend tasks forever.
- **Predicate is computed from the diff, deterministically** (the same `git diff
  <integration_branch>...<branch>` reviewer pre-check already uses for `ci/checks/`), so the
  classification is auditable, not an LLM judgment call.

### (4) TIMING vs deploy-GO — when does the gate run?

The gate runs **on every push to dev (and on PRs), in CI, against an ephemeral live stack
that CI itself stands up** — *not* gated behind a manual founder deploy-GO.

- **Reconciliation of the apparent conflict:** there are *two distinct things* the founder
  has historically gated behind deploy-GO, and conflating them is the trap:
  1. **Promotion `dev → main` and prod deploy** — founder-gated, irreversible, NOT this gate
     (GT-3/RL-1, unchanged; founder-feed 🟢 #1 "main не трогать").
  2. **Running journeys against the *homeserver* deployed dev container** (the founder's
     manual click-test on `100.121.76.86:3000`) — that is a *manual smoke*, and *that* is
     what "deploy-GO" historically meant for some tasks.
- This ADR's required gate is **neither**. It runs the journeys against a **fresh,
  CI-owned, deployed-equivalent stack** (the same compose Postgres+Flowable + built
  `web/dist` + real server the `deploy-acceptance` job already stands up). It is "the
  deployed container" in the sense that matters (real artifacts, no mocks, D-056) **without**
  depending on the homeserver or a human GO. So it can — and must — be **automatic on every
  dev push**: a gate the founder has to manually trigger is an advisory gate by another name,
  which is the exact leak being cured.
- **What stays founder-gated (flag this explicitly — it is the founder's, not the
  architect's):** (a) the *promotion* to main/prod is untouched; (b) the **founder's open
  question** in `docs/founder-feed.md` F7 — *"гонять эти journeys на каждом push в dev или
  только по твоему GO; делать ли клик-тест жёстким барьером"* — is the **строгость гейта**
  leash call. **The architect's recommendation is: every dev push, hard barrier.** But the
  *decision to flip required* and the *cadence* are the founder's leash (D-061): the BUILD
  task lands the wiring **advisory-first**, and the **required-flip is applied under the
  founder's GO** (founder-feed 🟢 #2 already says "СТРОИТЬ … принцип-поводок"). The architect
  decides the *mechanism* (CI-owned ephemeral stack, every-push); the founder owns the
  *moment the teeth bite* and the *cadence*. Do not flip required without that GO.
- **Optional second tier (recommended, founder-gated):** a separate, **non-required**,
  manually-or-nightly-triggered job that runs the full "build the WHOLE solution from UI"
  journeys (F7 acceptance-эталон) against the *homeserver* deployed dev. This is the
  founder's manual click-test, automated but kept advisory — it depends on the live
  homeserver + secrets and must not red-line dev on an infra hiccup (GV-5). Out of scope for
  the hard barrier; named here so the two tiers are not conflated.

### (5) SELF-IMPROVE FLAG (GV-2 singleton) — the critical split

**YES — implementing the Demiurge-side change requires `self_improve_lock`'d edits.**

The implementation splits cleanly into two principal-distinct halves:

- **(A) choros-side = NORMAL dev-loop.** Editing `.github/workflows/ci.yml`,
  `playwright.config.ts`, `package.json` scripts, `e2e/journeys/*`, `ci/checks/acceptance/*`
  is product-code in the **product worktree** (`task/T-0274` from `dev`). Built/reviewed/
  tested/auto-merged to dev by the ordinary parallel dev-loop (D-053). **No self-improve-lock.**

- **(B) Demiurge-side = SELF-IMPROVE SINGLETON.** Editing `prompts/dev-loop.md`,
  `agents/orchestrator.md`, `agents/reviewer.md`, `agents/tester.md` changes the **factory's
  own DoD/loop docs**. These live in the free zone (`constitution/zones.md` §2) so they are
  *writable* by the self-improvement principal — but per **GV-2** every such evolution edit
  is a **singleton under `self_improve_lock`** (compare-and-set), run alone when development
  has quieted (`agents/orchestrator.md` rule 4; `prompts/self-improve-loop.md`). It is **NOT**
  a parallel dev-loop task and **must not** be built by a product-coder in a choros worktree.
  `constitution/` is **never touched** (the DoD policy is doc/loop, not a red-line).

> **The split is load-bearing:** a single combined "task" that edits both choros CI and
> Demiurge loop docs would (i) violate GV-2 (loop-doc edit outside the singleton) and (ii)
> mix two principals' write-zones in one worktree. The BUILD must be two work items: a choros
> dev-loop task (A) and a self-improve-loop iteration (B), sequenced — (A) lands and is
> proven green, then (B) records the policy pointing at the now-green gate. Recording a
> policy that points at a not-yet-green gate would make the loop docs lie (D-056 honesty).

---

## Rejected alternatives

(see `rejected_alternatives` in the handoff JSON below)

---

## Implementation plan (minimal, reversible) — split A / B

### (A) choros-side — normal dev-loop, in `task/T-0274` worktree from `dev`

| File | Change (shape) | Reversible? |
|---|---|---|
| `.github/workflows/ci.yml` (`deploy-acceptance` job) | (i) **Advisory-first**: keep `continue-on-error: true` while wiring; run `npm run acceptance` (declarative journeys, not only `acceptance:tel`) so EVERY `*.journey.ts` is exercised. (ii) **Then, under founder-GO**: delete `continue-on-error: true`. | Re-add one line. |
| `.github/workflows/ci.yml` (`deploy-dev` job) | Add `deploy-acceptance` to `needs: [ci, db, kc, stack, flowable, deploy-acceptance]` so a red journey blocks the dev deploy. Applied together with the `continue-on-error` removal (under founder-GO). | Remove from `needs`. |
| `package.json` | Confirm `acceptance` (declarative, all journeys) is the job's command; keep `acceptance:tel` as the back-compat reference. No new script needed. | n/a |
| `e2e/journeys/*.journey.ts` | For each NEW gated (web-touching) task going forward, author/extend a journey (zero runner change — drop a file). For T-0274 itself: confirm the existing ТЭЛ + constructor journeys discover and run under `npm run acceptance`. | Delete file. |
| `ci/checks/acceptance/deploy-acceptance-required.sh` (NEW, optional hardening) | A static fitness check asserting `deploy-acceptance` job has **no** `continue-on-error: true` AND is in `deploy-dev.needs` (so the barrier can't be silently re-loosened by a future diff). `+ --self-test`. Add to `npm run fitness`. | Delete + drop from `fitness`. |

**Scope-predicate enforcement (choros side, lightweight):** the gate is *blanket* in CI
(every dev push runs all journeys). The **per-task** predicate ("does THIS task need a
journey") is enforced by the orchestrator/reviewer (B), not by a new choros check — keeping
choros CI changes minimal. (A future hardening could add a reviewer-side check "web-touching
diff ⇒ a journey covers it", but it is not required for the barrier and is deliberately
deferred.)

### (B) Demiurge-side — SELF-IMPROVE SINGLETON, under `self_improve_lock`

| File | Change (shape) |
|---|---|
| `prompts/dev-loop.md` | In the phase table, add to the `PR→dev` gate row: for a **gated** task (touches `web/` OR declares a journey), `release(done)` additionally requires **deploy-acceptance journey green on the deployed-equivalent stack** (the choros `deploy-acceptance` required check), not only branch-green. Add a §"Deploy-acceptance DoD" paragraph stating the predicate (mirror UX_REVIEW conditional-phase wording) and the exempt path for pure-backend. Add to §Правила стыков as an extension of rule 5 (D-056). |
| `agents/orchestrator.md` | In the MERGE/auto-merge rule (rule 11 / §Маршрутизация), add: auto-merge to dev of a **gated** task additionally requires the deploy-acceptance required check green; a gated task with no green journey ⇒ NOT done (return to BUILD to author/fix the journey), never `release(done)`. Note that *flipping the gate's strictness* is a leash (founder-applied), not orchestrator-self-applied. |
| `agents/reviewer.md` | Add to the algorithm: for a web-touching diff, confirm a covering `*.journey.ts` exists and is referenced; absence ⇒ `changes_requested` (acceptance-coverage gap). |
| `agents/tester.md` | Add: for a gated (UI) task, the deploy-acceptance journey is part of the **deterministic** set (like the G1–G7 UX gate already is); red journey ⇒ `verdict: fail`. |
| `docs/decisions.md` | New decision entry (e.g. **D-063**) recording "DoD anchored on deploy-acceptance journeys; gated⇔web/-touching; CI-owned ephemeral deployed stack; every dev push; founder owns the required-flip & cadence". |
| `docs/founder-feed.md` | Move the principle from 🟢 (#2/#3) to 📐 **Принципы** after the required-flip lands (as the founder instructed: "перенести в полку 📐 после реализации"). This is a leash/feed edit (D-061) — applied with the Demiurge-side iteration. |

**Reversibility of B:** all edits are git-versioned free-zone text; revert restores the prior
DoD. `constitution/` untouched.

### Sequencing

1. (A) advisory-first wiring lands on dev, journeys discovered + green in the GitHub runner
   (validated by BUILD/TEST — this ADR does not assert it green).
2. Founder GO on строгость (founder-feed 🟢 #2 already grants "СТРОИТЬ"; confirm the
   every-push cadence + required-flip).
3. (A) required-flip (`continue-on-error` removed + added to `deploy-dev.needs`) — under GO.
4. (B) self-improve-locked loop-doc + D-063 + founder-feed 📐 move, pointing at the
   now-green required gate.

---

## Fitness functions

| id | rule | ci_check |
|---|---|---|
| FF-T0274-1 | The `deploy-acceptance` job runs the declarative journey suite (`npm run acceptance`, all `*.journey.ts`) against a live no-mock stack (Postgres+Flowable+built `web/dist`), not a mocked one. | `ci/checks/acceptance/no-mock-stack.sh` (existing) + workflow asserts `npm run acceptance` |
| FF-T0274-2 | Once flipped, `deploy-acceptance` has NO `continue-on-error: true` AND is a member of `deploy-dev.needs` — a red journey blocks the dev deploy (hard barrier). | NEW `ci/checks/acceptance/deploy-acceptance-required.sh` (+ `--self-test`) |
| FF-T0274-3 | Journey discovery is isolated to this checkout's `e2e/` and excludes stale worktree dirs (deterministic gate, D-056). | `ci/checks/acceptance/e2e-scope.sh` (existing) |
| FF-T0274-4 | Journeys are fail-honest: every step a hard assertion, `retries: 0`, no mock-masking. | `ci/checks/acceptance/fail-honest.sh` (existing) |
| FF-T0274-5 | Scope predicate is exempt-safe: a pure-backend task (no `web/**` diff, no journey) is NOT blocked by journey absence. | Demiurge-side: `prompts/dev-loop.md` + `agents/orchestrator.md` rule (self-improve-locked); reviewer pre-check on diff scope |
| FF-T0274-6 | The required-flip & cadence are founder-applied (leash, D-061), not orchestrator-self-loosened. | `docs/decisions.md` D-063 + `docs/founder-feed.md` 📐 (founder-applied) |

---

## Traceability

| acceptance criterion | covered_by |
|---|---|
| Task not "done" until browser-journey green on deployed container | FF-T0274-1, FF-T0274-2 (required check blocks merge/deploy) |
| Hard barrier, not advisory | FF-T0274-2 (`continue-on-error` removed + in `deploy-dev.needs`) |
| Backend-only tasks not blocked forever | FF-T0274-5 (gated⇔web/-touching predicate; exempt path) |
| Runs against deployed (no mocks) | FF-T0274-1 (`no-mock-stack.sh`), D-056 deployed-equivalent stack |
| Self-improve split honored (GV-2) | §5 / plan split A (dev-loop) vs B (self_improve_lock) |
| Founder owns строгость/cadence | FF-T0274-6, §4 reconciliation |

---

## Handoff (adr.schema.json)

```json
{
  "task_id": "T-0274",
  "status": "ready",
  "decision": "Anchor the factory DoD on deploy-acceptance journeys via BOTH a choros CI required-check (the hard barrier) and a Demiurge loop-doc policy rule (the predicate). Flip the existing `deploy-acceptance` job from advisory (`continue-on-error: true`) to required AND add it to `deploy-dev.needs`, so a red browser-journey on a deployed-equivalent (no-mock) stack blocks the dev merge/deploy that 'done' rides on. Scope is gated⇔(diff touches `web/**` OR declares an `e2e/journeys/*.journey.ts`); pure-backend tasks are exempt and never blocked by journey absence (mirrors the UX_REVIEW conditional-phase predicate). The gate runs on every dev push in CI against a CI-owned ephemeral stack (NOT behind a manual deploy-GO) — manual deploy-GO stays only for dev→main promotion and the optional homeserver smoke. Implementation splits by principal: (A) choros CI/journey wiring = normal dev-loop; (B) Demiurge loop-doc edits (prompts/dev-loop.md, agents/orchestrator.md|reviewer.md|tester.md) = GV-2 self-improve singleton under self_improve_lock. The required-flip moment and cadence are the founder's leash (строгость гейта, D-061); land advisory-first, flip required under founder GO.",
  "rejected_alternatives": [
    {"option": "(a) CI required-check only", "why_not": "Mechanically prevents 'done' but never teaches the orchestrator the gated-vs-exempt predicate; the loop would over-block backend tasks or skip the gate ad-hoc. No auditable policy."},
    {"option": "(b) Demiurge orchestrator rule only (no CI teeth)", "why_not": "A doc rule is advisory to an LLM — rationalizable past, exactly the current leak. Without a required GitHub check, 'PR green/merged' can still coexist with 'journey red'. Violates 'gate = removed possibility, not politeness'."},
    {"option": "Gate behind manual founder deploy-GO per task", "why_not": "A gate a human must trigger is an advisory gate by another name — the precise leak (the founder's current manual click-test is advisory and that is how ТЭЛ leaked). Conflates two distinct things the founder gates: dev→main promotion (kept founder-gated) vs running journeys (must be automatic)."},
    {"option": "Gate ALL tasks (no scope predicate)", "why_not": "Blocks legitimately journey-less pure-backend tasks forever — a known failure mode. Backend has no user-facing surface to click."},
    {"option": "Run journeys only against the homeserver deployed dev", "why_not": "Couples the required gate to live homeserver + secrets + a human; an infra hiccup would red-line dev (violates GV-5). The CI-owned ephemeral stack is deployed-equivalent (real artifacts, no mocks, D-056) without that fragility. Homeserver smoke kept as an optional non-required second tier."},
    {"option": "Build choros + Demiurge changes as one task", "why_not": "Violates GV-2 (loop-doc evolution edit must be a self_improve_lock singleton, not a parallel dev-loop task) and mixes two principals' write-zones in one worktree."}
  ],
  "fitness_functions": [
    {"id": "FF-T0274-1", "rule": "deploy-acceptance runs the declarative journey suite (npm run acceptance, all *.journey.ts) against a live no-mock stack.", "ci_check": "ci/checks/acceptance/no-mock-stack.sh + workflow asserts npm run acceptance"},
    {"id": "FF-T0274-2", "rule": "Once flipped: deploy-acceptance has no continue-on-error AND is in deploy-dev.needs (hard barrier).", "ci_check": "ci/checks/acceptance/deploy-acceptance-required.sh (NEW, + --self-test)"},
    {"id": "FF-T0274-3", "rule": "Journey discovery isolated to this checkout's e2e/, excludes stale worktrees (deterministic, D-056).", "ci_check": "ci/checks/acceptance/e2e-scope.sh"},
    {"id": "FF-T0274-4", "rule": "Journeys fail-honest: hard assertions, retries:0, no mock-masking.", "ci_check": "ci/checks/acceptance/fail-honest.sh"},
    {"id": "FF-T0274-5", "rule": "Scope predicate exempt-safe: pure-backend task not blocked by journey absence.", "ci_check": "prompts/dev-loop.md + agents/orchestrator.md predicate rule (self-improve-locked); reviewer diff-scope pre-check"},
    {"id": "FF-T0274-6", "rule": "Required-flip & cadence founder-applied (leash, D-061), not orchestrator-self-loosened.", "ci_check": "docs/decisions.md D-063 + docs/founder-feed.md 📐 (founder-applied)"}
  ],
  "traceability": [
    {"ac": "Task not done until browser-journey green on deployed container", "covered_by": "FF-T0274-1, FF-T0274-2"},
    {"ac": "Hard barrier not advisory", "covered_by": "FF-T0274-2"},
    {"ac": "Backend-only tasks not blocked forever", "covered_by": "FF-T0274-5"},
    {"ac": "Runs against deployed no-mock stack", "covered_by": "FF-T0274-1"},
    {"ac": "Self-improve split honored (GV-2)", "covered_by": "plan split A/B"},
    {"ac": "Founder owns строгость/cadence", "covered_by": "FF-T0274-6"}
  ],
  "adr_artifact_path": "docs/design/T-0274-deploy-acceptance-dod.adr.md",
  "escalation": "Founder leash call (строгость гейта, founder-feed F7): cadence = every dev push vs only on deploy-GO, and the moment of the required-flip. Architect recommends every-push + hard barrier; founder GO already granted in principle (founder-feed 🟢 #2 'СТРОИТЬ'), confirm cadence before flipping required."
}
```
