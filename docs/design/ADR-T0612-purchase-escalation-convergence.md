# ADR-T0612 — purchaseApproval zombie-instance fix: non-interrupting timer convergence

Status: ready
Task: T-0612 (bug — столпы 1/3, движок/бесшовность; defect is in a BPMN
CASE MODEL, not the platform, per D-064 anti-case boundary)
Base: dev@1e52cd7, branch `task/T-0612-purchase-zombie-esc`

## 1. Problem

Live acceptance (2026-07-01/07-02, session memory
`choros-acceptance-2026-07-01-zakupki.md`) proved the "Закупки" (purchase
approval) case's BPMN process end-to-end, including: "boundary-таймер PT2M
реально сработал (non-interrupting эскалация)". This phrasing — a
non-interrupting boundary timer that fired successfully — is exactly the
authored shape that produces a live defect: **the process instance never
completes when the finance director approves BEFORE the deadline fires.**

Concretely, in the `purchaseApproval` process:

- `task-fin` ("Согласование финдиректора") is guarded by a boundary timer,
  `PT2M`, authored with `cancelActivity="false"` — **non-interrupting**. BPMN
  2.0's own default when `cancelActivity` is absent is `"true"`
  (interrupting) — `src/core/bpmn-linter.ts:568` already documents this. A
  non-interrupting boundary timer in this model is therefore a **deliberate,
  explicit** authoring choice, not an accidental omission.
- The timer's escalation branch flows to `task-esc` ("Эскалация: финдир
  молчит"), which flows to **its own, separate endEvent** — never
  reconnecting to the main flow's endEvent ("Заказ размещён").
- When `task-fin` completes NORMALLY (the finance director approves within
  the 2-minute window — the common, happy-path outcome), Flowable routes the
  main token to "Заказ размещён". But `cancelActivity="false"` means the
  boundary timer is **not cancelled** by the guarded task completing — it
  remains armed until it either fires or the process ends. Since BPMN only
  completes a process instance when **every** token (including an
  armed-but-unfired non-interrupting boundary event) has resolved, and this
  boundary event has no path to resolution once its guarded task has already
  finished, **the instance never ends**: `act_hi_procinst.end_time` stays
  `NULL` forever, even though the product-visible outcome had already
  appeared to the user.

This is a genuine zombie instance: invisible in the product (the founder sees
"Заказ размещён" and believes the case is closed), but the underlying engine
row never resolves — a live landmine for anything that later queries
"instances still running" (metrics, cleanup jobs, audits).

### 1.1 Where does this model live? (исход а/б)

Repo-wide investigation (direct grep across every `.xml`/`.ts`/`.mjs`/`.json`
in the tree, cross-checked by a dedicated research pass) found:

- **No `.bpmn`/`.bpmn20.xml` file, seed pack, or TS template string anywhere
  in the repository** defines or embeds `purchaseApproval`. The only repo
  hits are descriptive **code comments** citing it as an example of an
  already-observed live instance: `src/http/processes.ts:226`,
  `src/http/records.ts:1018`, `src/http/process-projection.ts:161`,
  `migrations/121_process_app_binding_submit_task_key.sql`.
- The canvas modeler (`web/src/canvas/bpmn-palette-provider.js`,
  `timer-deadline-panel.jsx`) **never sets `cancelActivity`** and exposes
  **no UI control** for interrupting/non-interrupting at all — the timer
  properties panel offers exactly three configs (deadline kind, deadline
  value, escalation target). Since bpmn-js's own default for a
  canvas-dropped boundary event is `cancelActivity="true"`, a
  **non-interrupting** boundary timer could only reach a live model via
  hand-authored/imported XML, not via the canvas.
- Session memory confirms this directly: "BPMN авторится XML-ом и заливается
  POST /api/process-defs → /publish (**НЕ мышью по канвасу**)."

**Conclusion: исход (б).** `purchaseApproval` is tenant-only state — it
exists solely as a deployed process definition on the live dev Flowable
instance (tenant ООО Аксон), never committed to the choros repository in any
form. There is no seed/fixture to "fix in place"; the fix is a **corrected
replacement artifact**, ready for the LIVE_PROOF phase to publish over the
existing definition on the live stand.

## 2. Decision

### D1 — Keep `cancelActivity="false"` (escalation is a reminder, not a takeover)

**Considered and rejected: flip to `cancelActivity="true"`** (interrupting).
This would trivially fix the zombie (only one token ever live on the
boundary), but it changes the *business semantics* of the escalation: an
interrupting timer **cancels `task-fin` the instant it fires** — the finance
director's in-progress approval would be yanked away and replaced by the
escalation task the moment the clock runs out, even if the director was
mid-review. Per the case's own naming ("Эскалация: **финдир молчит**" — "the
finance director is silent") and the general shape of an SLA-reminder
pattern (mirrors `docs/specs/process-element-runtime.spec.md §3.4`'s
framing: "таймаут шага/ожидания → эскалация (руководитель/овнер) с
предзаполненной формой" — an escalation is a notification/reminder to a
supervisory pool, not a redefinition of who holds approval authority), the
correct semantics are: **the escalation is a non-critical nudge to the
owner/manager pool. The finance director's authority to approve is never
revoked by the clock.** This means `cancelActivity="false"` is the CORRECT
choice for this case — the defect was never the non-interrupting choice
itself, only the missing convergence.

### D2 — Converging `exclusiveGateway`, not a `terminate` end event

**Considered and rejected: `terminateEndEvent` on the main path.** A
terminate end event force-kills every other active token in the process
instance the instant it is reached — this WOULD end the instance
immediately when `task-fin` completes, but it does so by **violently
cancelling** the still-armed boundary timer, which is semantically the same
outcome as making the timer interrupting from the opposite direction (kill
the timer instead of kill the task) — and it forecloses any future extension
of this process with additional truly-parallel branches that should keep
running after this slice resolves (out of scope today, but a `terminate`
event is a foot-gun for exactly that future case). It also reads as
"abort/cancel" semantically to anyone modeling the process later, which
contradicts D1's "escalation is a reminder" framing.

**Decision: an `exclusiveGateway` (`gw-fin-converge`) that BOTH the finance
director's normal completion (`task-fin` → `gw-fin-converge`) and the
escalation task's completion (`task-esc` → `gw-fin-converge`) flow into,
before the single shared endEvent** ("Заказ размещён"). This is the standard
BPMN idiom for "whichever of these mutually-exclusive-in-practice paths
finishes, drive the process forward" — Flowable's `exclusiveGateway`
requires only ONE incoming token to fire its outgoing flow (unlike a
`parallelGateway`/AND-join, which would wait for BOTH branches and could
itself dangle if the timer never fires). Net effect:

- Timer never fires (happy path): `task-fin` completes →
  `gw-fin-converge` fires immediately → "Заказ размещён". The boundary
  timer's un-fired token is retired the instant the process reaches its end
  (BPMN engines discard any still-armed boundary event attached to a
  completed/superseded scope once the containing process instance
  concludes) — no zombie.
- Timer fires (financial director genuinely unresponsive): `task-esc`
  surfaces, gets completed by the owner pool → `gw-fin-converge` fires →
  "Заказ размещён". `task-fin` remains an open task in the inbox
  independently (non-interrupting — the director can still act on it later
  if desired; out of scope for this fix to adjudicate what happens to a
  stale `task-fin` after escalation resolves the instance — that is a
  product-policy question for a future task, not a structural defect).

### D3 — Close the platform gap that let this ship: linter convergence check

The defect passed every existing publish-time gate. `checkTimerCoherence`
(T-0458) validates timer body well-formedness, boundary-attach, and
"dangling" (0 outgoing flows) — but explicitly treats `cancelActivity` as
**"Informational for the message"** only (doc-comment,
`src/core/bpmn-linter.ts:1086`), never enforcing anything about it. The
`checkParallelGatewayCoherence` (T-0456) doc-comment goes further and
**names this exact class of gap outright**: "Note on whole-process balance
... a full reachability/path analysis is out of v1 scope."

This task closes the **narrow, tractable, high-value slice** of that
documented gap: **non-interrupting boundary timers specifically** — the
shape that produced a real, live product defect — get a forward-reachability
check (`checkTimerEscalationConvergence`, new `LintViolationType
"timer_escalation_no_convergence"`). An interrupting timer, or the timer
attribute absent (BPMN default = interrupting), is never flagged — the
convergence question only exists when the guarded task's completion and the
escalation branch can BOTH resolve independently, which is precisely what
non-interrupting means.

**Rejected: a fully general reachability/balance linter for every
gateway/timer shape.** T-0456 already scoped this out for good reason (a
general "does every path reach a common end" analysis has to reason about
loops, multiple valid ends, sub-processes, and other topologies this v1
engine does not yet support — scope creep well beyond this bug). The
targeted, scoped check this task adds is deliberately narrow: it activates
ONLY for the one shape (`boundaryEvent` + `cancelActivity="false"`) that has
a concrete, proven failure mode, keeping the false-positive surface minimal
while closing the exact gap that shipped a live defect.

### D4 — Spec gap: `process-element-runtime.spec.md §3.4` said nothing about convergence

§3.4 (R3, timer/deadline + escalation) describes only "срок (длительность/
дата) + действие при срабатывании (кому эскалация)" — no mention of
convergence or interrupting semantics. This is a genuine spec gap (not just
an implementation oversight) that let a structurally-incomplete pattern look
fully specified. This ADR is the record of the missing requirement; a
follow-up spec-doc edit to add an explicit convergence clause to §3.4 is
named in FRICTION/pr-handoff for whoever owns spec maintenance (out of this
task's own diff scope — `process-element-runtime.spec.md` is a shared,
multi-task-owned file and this ADR is the authoritative decision record for
the requirement in the meantime).

## 3. Rejected alternatives (summary table)

| option | why not |
|--------|---------|
| Flip to `cancelActivity="true"` (interrupting) | Fixes the zombie but changes business semantics: the escalation would CANCEL the finance director's in-progress approval the instant the clock runs out, contradicting "эскалация — напоминание, не отмена" (D1). |
| `terminateEndEvent` on the main path | Force-kills the still-armed timer via violent instance-termination — same "cancel" semantics as flipping cancelActivity, from the opposite direction; also forecloses future genuinely-parallel branches in this process shape. |
| Parallel (AND) join instead of exclusiveGateway | Would need BOTH task-fin AND task-esc to complete before advancing — but task-esc only ever fires if the timer actually fires; on the happy path (timer never fires) an AND-join would dangle forever, reproducing the exact zombie this task fixes, just moved to a different node. |
| Leave cancelActivity absent (rely on BPMN default = interrupting) rather than explicit `="false"` | Considered as a minimal diff, but silently relying on an absent-attribute default is exactly the kind of implicit-semantics authoring that made the original defect hard to spot; the fix artifact keeps `cancelActivity="false"` EXPLICIT so a future reader immediately sees the deliberate choice and its now-enforced convergence obligation. |
| General reachability/balance linter for all gateway/timer shapes | Out of v1 scope per T-0456's own note; scope creep with a much larger false-positive/edge-case surface (loops, sub-processes, multiple valid ends) than this task's proven, narrow failure mode justifies. |

## 4. Object model / contracts

No schema change, no migration, no runtime dependency added.

- `src/core/bpmn-linter.ts`:
  - NEW `LintViolationType` union member: `"timer_escalation_no_convergence"`.
  - NEW collection state in `lintBpmn`: `flowEdges: Array<{source,target}>`
    (paired sequenceFlow refs — additive alongside the existing parallel
    `allFlowSourceRefs`/`allFlowTargetRefs` arrays) and `endEventIds:
    Set<string>` (every `<endEvent id=...>` seen).
  - NEW pure functions: `reachableSet(startIds, edges): Set<string>` (BFS
    helper) and `checkTimerEscalationConvergence(timers, flowEdges,
    endEventIds, violations): void`.
  - Invocation: one new call inside the existing `if (timerEvents.length >
    0)` block in `lintBpmn`, right after the existing `checkTimerCoherence`
    call — no change to any existing check's inputs or behaviour.
- `docs/design/T-0612-purchaseApproval-fixed.bpmn20.xml.txt` — NEW. The
  corrected finance-approval + escalation SLICE (see file header for full
  scope notes and splice-point guidance for LIVE_PROOF).
- `ci/checks/flowable/purchase-approval-convergence-smoke.sh` — NEW,
  standalone (not wired into any `package.json` script). Deploys the fixed
  slice, completes `task-fin` before the timer fires, asserts the instance
  reaches `endTime != null`.
- `src/__tests__/bpmn-linter.test.ts` — additive test blocks only (6 new
  tests under two new `describe` blocks); zero change to any existing test.

## 5. Fitness functions

| id | rule | ci_check |
|----|------|----------|
| T-0612-CONVERGE-FAIL | reconstructed original defective shape (non-interrupting timer, disconnected escalation end) fails `lintBpmn` with `timer_escalation_no_convergence` | `npx vitest run src/__tests__/bpmn-linter.test.ts` |
| T-0612-CONVERGE-OK | fixed shape (converging gateway) and the trivial same-endEvent-id shape both pass `lintBpmn` cleanly | `npx vitest run src/__tests__/bpmn-linter.test.ts` |
| T-0612-INTERRUPT-SKIP | interrupting timer (explicit `="true"` or attribute absent) with the SAME disconnected-end shape is never flagged | `npx vitest run src/__tests__/bpmn-linter.test.ts` |
| T-0612-INTERMEDIATE-SKIP | intermediate (non-boundary) timer is never subject to this check | `npx vitest run src/__tests__/bpmn-linter.test.ts` |
| T-0612-FIX-ARTIFACT-CLEAN | `docs/design/T-0612-purchaseApproval-fixed.bpmn20.xml.txt` lints with zero violations | manual `lintBpmn` invocation (documented in pr-handoff) |
| FF-5/FF-6/FF-9 (inherited) | `bpmn-linter.ts` stays zero-dep, frozen files untouched | `ci/checks/bpmn-linter-isolation.sh` |
| FF-G1/G2/G6 (inherited) | mutation-gateway isolation invariants hold | `ci/checks/mutation-gateway-isolation.sh` |
| D-064 anti-case (inherited) | zero case-specific literal added under `src/` | `ci/checks/anti-case-lock.sh` |
| T-0612-LIVE (deferred) | the fixed slice, deployed to a real Flowable, ends its instance when `task-fin` completes before the PT2M deadline | `ci/checks/flowable/purchase-approval-convergence-smoke.sh` (not run this session — see FRICTION) |

## 6. Traceability

| AC (task) | covered by |
|-----------|-----------|
| interrupting vs non-interrupting vs join-gateway decision, with business-semantics reasoning | §2 D1/D2 |
| model lives in tenant data, not repo (исход а/б) | §1.1 |
| twin-defect search (other models with the same pattern) | FINDINGS in pr-handoff — only `seed/vendor-crm/processes/customer-onboarding.bpmn` exists in-repo, strictly linear, no boundary events at all — no twin found |
| linter closes the gap that let this ship | §2 D3, §4 |
| spec gap named | §2 D4 |
| fix artifact ready for LIVE_PROOF | §1.1, §4, `docs/design/T-0612-purchaseApproval-fixed.bpmn20.xml.txt` |

## 7. Runtime target

Local (linter is pure, zero-IO — runs anywhere). Live-proof deferred to a
Flowable-reachable environment (dev stand or a future session with
uncontended `:8082`/`:55432`) — see FRICTION in pr-handoff for why this
session could not run it live.

---

## 8. T-0661 addendum — the SECOND completion order (concurrent-token hang)

Task: T-0661 (bug — столпы 1/3, движок/бесшовность; defect is in the same
BPMN CASE MODEL, a continuation of T-0612's convergence work). Base:
dev@6613c6a7, branch `task/T-0661`. **DESIGN only** — BUILD + live-proof
happen once the stand is reachable again (stand unreachable this session).

### 8.1 What T-0612's §2 D2 actually covered — and the gap it left

§2 D2 fixed the completion order where the **timer NEVER fires**: the finance
director approves within PT2M, one token flows `task-fin → gw-fin-converge →
end`, the instance completes, and the still-armed-but-unfired boundary timer
is discarded with the scope. That fix is **correct for that order** and the
LIVE_PROOF Case A (smoke script) proves it.

The **open order** T-0661 addresses is the one where the **timer HAS ALREADY
FIRED**. A non-interrupting (`cancelActivity="false"`) boundary event, when it
fires, **spawns a second, independent concurrent token** at the boundary,
flowing to `task-esc` — while the original token stays on `task-fin`. Now
**both userTasks are open at once**. Completing `task-fin` sends its token
through `gw-fin-converge` to the shared `endEvent`, where **that one token is
consumed** — but `task-esc`'s token is still parked. BPMN completes an
instance only when **every** token is consumed, so **the instance hangs**
until `task-esc` is ALSO completed. The symmetric order (complete `task-esc`
first, leave `task-fin` parked) hangs identically.

**Root cause — a factual error in §2 D2's rationale.** D2 (and the fix
artifact's header, now corrected) asserted that a converging `exclusiveGateway`
"fires on the FIRST arrival and discards the token from whichever branch
arrives later." **This is not how Flowable/BPMN converging exclusive gateways
behave.** A converging (merging) exclusive gateway is an **uncontrolled merge**:
it routes **each** incoming token through its outgoing flow **independently** —
it never discards a "later" token, because there is no join/wait/merge of
tokens at an XOR-merge. So when two concurrent tokens exist (post-fire), the
gateway passes both through separately, each to the `endEvent`, and only the
consumption of the SECOND one ends the instance. The D2 shape therefore
resolves the *never-fires* order but **cannot resolve the *already-fired*
order** — a plain converging-gateway + none-`endEvent` has no mechanism to
extinguish a second concurrent token.

### 8.2 D5 — "согласование добивает процесс": first resolution cancels the other, scope-locally

**Decision.** The ratified user expectation (столп 1/3, session memory
`choros-product-direction-tel` / the founder's framing "согласование добивает
процесс") is: whichever of the two racing tasks resolves **first** — the
director approving `task-fin`, or the owner handling the escalation `task-esc`
— **completes the slice and cancels the other, now-moot task.** The escalation
is a reminder; once **either** party decides, the decision is made and the
other open task must disappear (not linger as a stale zombie task — the exact
bad-UX class T-0612 set out to kill).

Resolving a second concurrent token requires **active token cancellation**,
which no plain gateway/none-end can do. The BPMN-native, deterministic
mechanism is a **terminate end event** — but scoped so it does **not** end
unrelated parallel work. Therefore:

> **The fin-approval race is enclosed in an embedded `subProcess`
> (`sub-fin-approval`). Inside it: `task-fin` carries the unchanged
> non-interrupting boundary timer escalating to `task-esc`; BOTH tasks
> converge into the existing `exclusiveGateway gw-fin-converge`; the gateway
> flows to a `terminateEndEvent` (`sub-end-terminate`) with `terminateAll`
> left at its default `false` → SCOPE-LOCAL. The sub-process has one outgoing
> flow to the shared top-level `endEvent` "Заказ размещён".**

Behaviour, all orders deterministic and clean:

- **Timer never fires** (T-0612 Case A, preserved): `task-fin` done → gateway →
  scope-terminate ends the sub-process (armed timer discarded with the scope) →
  sub-process completes → main flow → "Заказ размещён". ✓
- **Timer fired, `task-fin` completed first**: `task-fin` token → gateway →
  scope-terminate → **kills the parked `task-esc` token** within the
  sub-process → sub-process completes → "Заказ размещён". ✓ («добивает»)
- **Timer fired, `task-esc` completed first** (owner steps in for the silent
  director): `task-esc` token → gateway → scope-terminate → **kills the parked
  `task-fin` token** → sub-process completes → "Заказ размещён". ✓ (symmetric)

`cancelActivity="false"` is **unchanged** — §2 D1's business semantics hold
(the escalation never revokes the director's authority; it is simply moot once
either party decides). This **supersedes** §2 D2's out-of-scope hand-wave that
"`task-fin` remains an open task in the inbox independently after escalation" —
under D5 the losing task is deterministically cancelled, which is the correct
"добивает" semantic, not left dangling.

**Why scope-local (sub-process) terminate, not top-level terminate.** §2 D2
rejected a *top-level* `terminateEndEvent` because it force-kills the whole
instance, foreclosing genuinely-parallel top-level branches (the full case
branches on `${amount>500000}` upstream). D5 keeps that objection satisfied:
`terminateAll="false"` inside an embedded sub-process terminates **only that
sub-process's executions** — exactly the two racing tasks and nothing else —
then the sub-process completes normally and its outgoing flow continues the
main process. Terminate is used **where it is the correct idiom** (cancel the
losing racer) and **confined** to where it is safe. This reuses the existing
convergence gateway; the only added structure is the sub-process wrapper + its
none-start + the scope-local terminate.

### 8.3 Rejected alternatives (T-0661)

| option | why not |
|--------|---------|
| **Interrupting when approved in time** (flip `cancelActivity` to `true`, or retroactively make the fired timer interrupting) | Reintroduces the §2 D1 rejection: an interrupting timer CANCELS `task-fin` the instant it fires, yanking the director's in-progress approval. And an already-FIRED non-interrupting timer cannot be retroactively made interrupting — the second token already exists. Wrong semantics + not mechanically possible for the fired case. |
| **Top-level `terminateEndEvent`** (converging gateway → top-level terminate, no sub-process) | Minimal diff and works TODAY (this slice has no sibling top-level branch), but re-opens §2 D2's foreclosure foot-gun: once spliced into the full case (which DOES branch upstream), a top-level terminate would kill unrelated parallel branches. D5's sub-process scoping gets the same cancellation without the foot-gun. Acceptable ONLY if a future author can prove the slice is the entire process with zero parallel branches — not a safe default. |
| **Signal throw/catch cancel** (`task-fin` completion throws a signal; `task-esc` has an interrupting boundary signal catch, and vice-versa) | Achieves cancel-on-first without terminate, but adds four elements (two throws + two boundary catches), and Flowable signals are broadcast/global-scoped by default (cross-instance / cross-tenant leakage risk unless carefully scoped). Heavier and more error-prone than a scope-local terminate for the same outcome. |
| **Runtime task-pairing hook** (engine-drive reconcile in `inbox.ts` auto-cancels the sibling task when one of a pair completes) | A **bespoke special-case**: it hard-codes a "these two tasks are a pair" convention outside the BPMN model, invisible to anyone reading the process, and duplicates the engine's own token-cancellation machinery in application code. The task brief explicitly prefers a deterministic fix that **reuses existing convergence machinery, not a bespoke special-case**. Rejected. |
| **"Require both to complete" (accept the hang, make it legible only)** — option 3 in the brief | Contradicts the ratified "добивает" expectation and re-creates the stale-zombie-task UX T-0612 fought. A reminder that the director must ALSO still close after the owner already decided is not the case's intent ("финдир молчит" — the escalation is a fallback for silence, not a co-signature). Rejected as the *default*; the linter still lets an author OPT IN explicitly if a genuine double-close is ever wanted (§8.5, escape hatch) — but silence must never ship it. |

### 8.4 D6 — the linter GREEN-LIGHTS the hanging shape today (false negative to close)

`checkTimerEscalationConvergence` (§2 D3) checks only that the escalation
branch **reconnects** to the guarded task's downstream path before its own end.
The D2 shape (`exclusiveGateway → plain endEvent`) **satisfies** that — so the
linter **passes the very shape §8.1 shows still hangs** when the timer fires.
That is a false negative: convergence-of-flow is necessary but **not
sufficient**; the convergence must also be able to **resolve the second
concurrent token** a non-interrupting timer creates.

**Decision.** Extend the check with a second, tighter obligation for
non-interrupting boundary timers: **after** confirming flow convergence, verify
that a **scope-terminating construct** (a `terminateEndEvent`) is **reachable**
from the escalation branch. Only a terminate can extinguish the second token.
A convergence that reaches merely a none-`endEvent` is flagged with a NEW,
distinct violation type so the two failure modes are legible:

- `timer_escalation_no_convergence` (existing) — branch never rejoins at all.
- `timer_escalation_unresolved_concurrency` (**new**) — branch rejoins, but no
  `terminateEndEvent` is reachable, so the fired-timer's concurrent token can
  never be extinguished → the "both tasks open" hang.

This stays inside §2 D3's discipline: narrow (only non-interrupting boundary
timers — the one shape with a proven live failure), reusing the existing
`reachableSet` BFS, no general reachability/balance analysis.

### 8.5 BUILD-spec (T-0661) — exact changes, NOT implemented this session

1. **`docs/design/T-0612-purchaseApproval-fixed.bpmn20.xml.txt`** — **DONE this
   session** (design artifact, not product code): rewritten to the D5 encoding
   (embedded `sub-fin-approval` sub-process; `task-fin` + non-interrupting
   `bnd-fin-timeout` → `task-esc`; both → `gw-fin-converge` →
   `sub-end-terminate` `<terminateEventDefinition/>` scope-local; sub-process →
   top-level `end-order-placed`). Node ids `task-fin`/`task-esc`/`purchaseApproval`
   preserved so the smoke script's `taskDefinitionKey`/process-key queries still
   resolve.

2. **`src/core/bpmn-linter.ts`** (BUILD — spec only):
   - Add `LintViolationType` union member `"timer_escalation_unresolved_concurrency"`
     (additive, mirrors the T-0612 `"timer_escalation_no_convergence"` addition).
   - In `lintBpmn`'s token walk, collect a `terminateEndEventIds: Set<string>`:
     when inside an `<endEvent>` element, if a `<terminateEventDefinition>` child
     open/self-close tag is seen, add that endEvent's id (mirror the existing
     `endEventIds` collection and the `inTimerBodyChild` child-tracking pattern
     at lines ~404/417/700-840). No new pass — folds into the existing walk.
   - Extend `checkTimerEscalationConvergence(timers, flowEdges, endEventIds,
     terminateEndEventIds, violations)` (add the one param): after the existing
     loop sets `converged === true` for a non-interrupting boundary timer,
     compute `escReach = reachableSet([escalationTarget], flowEdges)` and, if
     **no** id in `escReach` is in `terminateEndEventIds`, push a
     `timer_escalation_unresolved_concurrency` violation (message: names the
     boundary id + `attachedToRef`; explains the fired-timer concurrent-token
     hang; prescribes the fix — "route the convergence into a scope-local
     `terminateEndEvent` (e.g. inside an embedded sub-process) so the first
     resolution cancels the other racing task"). The two violation types are
     mutually exclusive per timer (no-convergence OR unresolved-concurrency OR
     clean). Reuse `reachableSet` — no new traversal helper.
   - Update the call site (line ~961) to pass `terminateEndEventIds`.
   - **No mapper change** — `mapTimerEscalation` (`timer-escalation-mapper.ts`)
     is id/string-keyed and scope-agnostic; it wires `candidateGroups` onto
     `task-esc` and leaves `bnd-fin-timeout`'s explicit `<timeDuration>` body
     untouched exactly as before, regardless of the sub-process nesting.
     Verified against the mapper source (buildTimerTargets scans all
     sequenceFlows flat; injectCandidateGroupsOnTask matches by userTask id).

3. **`src/__tests__/bpmn-linter.test.ts`** (BUILD — spec only): additive blocks
   only (mirror the existing T-0612 `describe` blocks; zero change to existing
   tests). See §8.6 fitness rows for the exact cases.

4. **`ci/checks/flowable/purchase-approval-convergence-smoke.sh`** (BUILD — spec
   only): extend from Case-A-only to prove all three orders. Add a
   `FIN_DEADLINE` env override (default `PT2M`) so LIVE_PROOF can deploy a
   `PT5S` variant, wait for `task-esc` to surface, then assert instance-ENDED
   after completing (i) `task-fin` first and (ii) — a second instance —
   `task-esc` first. Its current header comment already concedes Case B was
   never actually live-proven (deferred to the unit linter) — T-0661 closes
   that hole for real.

### 8.6 Fitness functions (T-0661)

| id | rule | ci_check |
|----|------|----------|
| T-0661-UNRESOLVED-FAIL | the D2 shape (non-interrupting timer, escalation → `exclusiveGateway` → **plain** `endEvent`) — i.e. the *old* "fixed" shape — now fails `lintBpmn` with `timer_escalation_unresolved_concurrency` | `npx vitest run src/__tests__/bpmn-linter.test.ts` |
| T-0661-TERMINATE-OK | the D5 shape (converging gateway → scope-local `terminateEndEvent`, in a sub-process) passes `lintBpmn` cleanly (no `no_convergence`, no `unresolved_concurrency`) | `npx vitest run src/__tests__/bpmn-linter.test.ts` |
| T-0661-NOCONV-STILL-FAIL | the original fully-disconnected escalation-own-end shape still fails with `timer_escalation_no_convergence` (existing T-0612 rule un-regressed) | `npx vitest run src/__tests__/bpmn-linter.test.ts` |
| T-0661-INTERRUPT-SKIP | an interrupting timer (`="true"` or attribute absent) with a convergence-to-plain-end shape is **never** flagged by the new rule (no second token exists) | `npx vitest run src/__tests__/bpmn-linter.test.ts` |
| T-0661-FIX-ARTIFACT-CLEAN | `docs/design/T-0612-purchaseApproval-fixed.bpmn20.xml.txt` (D5 encoding) lints with zero violations | manual `lintBpmn` invocation (pr-handoff) |
| T-0661-MAPPER-UNCHANGED | `mapTimerEscalation` on the D5 artifact still injects `flowable:candidateGroups="role-owner"` on `task-esc` and leaves `bnd-fin-timeout`'s body untouched (idempotent, scope-agnostic) | `npx vitest run src/__tests__/timer-escalation-mapper.test.ts` |
| **T-0661-LIVE-A** (deferred) | timer never fires: complete `task-fin` before deadline → instance `end_time != null` | `ci/checks/flowable/purchase-approval-convergence-smoke.sh` |
| **T-0661-LIVE-B** (deferred) | timer FIRED (PT5S variant), then complete `task-fin` while `task-esc` is ALSO open → instance `end_time != null` (parked `task-esc` cancelled by scope-terminate) | `purchase-approval-convergence-smoke.sh` (FIN_DEADLINE=PT5S) |
| **T-0661-LIVE-C** (deferred) | timer FIRED, then complete `task-esc` first while `task-fin` is ALSO open → instance `end_time != null` (symmetric; parked `task-fin` cancelled) | `purchase-approval-convergence-smoke.sh` (FIN_DEADLINE=PT5S) |
| FF-5/FF-6/FF-9 (inherited) | `bpmn-linter.ts` stays zero-dep, frozen files untouched | `ci/checks/bpmn-linter-isolation.sh` |
| D-064 anti-case (inherited) | zero case-specific literal added under `src/` (the sub-process/terminate is generic structure; no `purchaseApproval`/`task-fin` literal in `src/`) | `ci/checks/anti-case-lock.sh` |

### 8.7 Traceability (T-0661)

| AC (task) | covered by |
|-----------|-----------|
| decide the semantics for the concurrent (both-open) case | §8.2 D5 |
| which candidate (interrupting / auto-extinguish / require-both) + rationale + rejected | §8.2 (chosen: auto-extinguish via scope-local terminate = candidate 2, encoded structurally) + §8.3 |
| Flowable join semantics vs token model | §8.1 (uncontrolled XOR-merge passes each token independently; §2 D2's "discards later token" claim corrected) |
| authoring-time vs runtime fix | §8.2 (authoring-time: model shape) + §8.4 D6 (authoring-time: linter) — runtime task-pairing explicitly rejected §8.3 |
| deterministic + reuses convergence machinery, not bespoke | §8.2 (reuses `gw-fin-converge`; only adds sub-process + scope-terminate; terminate is native engine cancellation, not app-code pairing) |
| both completion orders cleanly finish the instance | §8.6 T-0661-LIVE-A/B/C |
