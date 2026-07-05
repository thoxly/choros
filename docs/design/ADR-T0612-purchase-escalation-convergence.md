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
