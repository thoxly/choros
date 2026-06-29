# ADR T-0432 — Inbox state-machine vs. Flowable: how the gateway-spawned 2nd task reaches the inbox

- **Status:** PROPOSED — awaiting founder GT-1 (direction choice). Non-additive, load-bearing.
- **Date:** 2026-06-29
- **Task:** T-0432 (`[NEEDS-DESIGN]`, opened by deploy-acceptance T-0273, CS-1 red)
- **depends_on:** T-0483 — **NOT a blocker** (see §7). T-0483 is the engine-readiness probe / compose-internal `flowable` hostname reachability; it is already merged and only affects *whether* the engine is reachable, not *how* the inbox reconciles with it.
- **Decides:** the resolution of the two-state-machine problem (inbox projection vs. live Flowable) for branching processes.
- **Author:** ARCHITECT (design only — no production code in this change)

---

## 1. Context — the recurring "two state machines" problem

CS-1 of the ТЭЛ scenario (`e2e/tel-linear.e2e.ts:490`, "amount=6_000_000 → on_create → DMN needs-approval → Доп.согласование") cannot go green on deploy. The task brief framed this as **structural**: after the human approves the base «Согласование» task, an exclusive gateway must route to a **second** user-task «Доп. согласование» (`task-extra-approve`), and that gateway-spawned task must appear in the approver pool.

The root cause, as originally diagnosed, was that the system runs **two independent state machines**:

1. **The inbox projection** (`src/http/process-projection.ts`) — folds `choros.audit_event` rows into waiting/done instance state. Historically it emitted **exactly one** waiting task per `process.started` event and hard-coded `done` on approve.
2. **The live Flowable engine** — owns the real BPMN token, the DMN gateway, and knows about the second task.

If the inbox is a *self-standing* machine that hard-codes one-task-then-done, a gateway's second task is **structurally impossible to surface** — there is no event that represents it.

### 1.1 CRITICAL FINDING — Option A is already largely built (T-0443 + T-0456)

Reading the actual code shows the brief's premise is **out of date**. The two cited "blocking" facts no longer hold:

- **inbox.ts approve does NOT hard-code `done`.** The approve handler (`src/http/inbox.ts` ~1142–1600) writes `task.approved`, then runs a **T-0443 engine-drive post-approve block** (lines ~1433–1600): it polls Flowable for the active user-task matching the approved `taskDefKey`, calls `completeUserTask(engineTaskId)`, then **reconciles against the live engine token set**:
  - if `isInstanceEnded()` → emits `instance.ended` (the engine-gated `done` signal), or
  - if the engine has more tokens → emits a **`process.next_task`** audit event for **each** live engine user-task not yet on screen (the T-0456 loop, lines ~1518–1585, which explicitly handles AND-splits / multiple concurrent tasks).
- **process-projection.ts does NOT cap at one task per instance.** It defines `appendNextTaskEvent` (`process.next_task`, lines ~525–596) and folds those rows in `readEvents`/`listInstanceInboxTasks`/`listInstanceProjections` (lines ~654–920). A `process.next_task` row surfaces a post-gateway pool task; the base task is hidden once `task.approved` exists for it; the instance stays `waiting` (not `done`) while any `next_task` is pending (Fix D, lines ~755–797).

In other words, **the inbox is already a projection of live engine state for the approve path** (Option A). The `task-extra-approve` gateway branch is the canonical example the T-0443/T-0456 code was written for, and `tel-linear.e2e.ts:518` polls for exactly that second task.

So the live question for T-0432 is **not** "design A vs. B from scratch" — it is:

> **Why is CS-1 still red despite the engine-drive existing, and what is the minimal, durable design that closes it without regressing the already-green linear path (T-0443)?**

The engine-drive is **best-effort, fire-and-forget** (`void (async () => { … })()`, lines ~1446+), gated on `writeDepsFlowable` being wired, and depends on the lifecycle bridge actually polling `tel-intake` so the DMN triage variable (`approvalRequired`) gets injected. The remaining gaps are about **reliability and wiring**, not about a missing state-machine concept.

---

## 2. The decision — A vs. B

### Option A — Engine-backed inbox (inbox = projection of live Flowable state)

Approve → `completeUserTask` in Flowable → the bridge/engine-drive reads the new live token set and surfaces every next task (gateway-spawned included) back into the inbox via `process.next_task`. The inbox is **not** an authoritative state machine; Flowable owns branching, the inbox mirrors it.

**This is the path already chosen and substantially implemented by T-0443 / T-0456 / T-0458 / T-0459.** Choosing A here means **"harden and finish the existing T-0443 engine-drive,"** not "build A."

Files in play (for the harden-A build task that would follow this ADR):
- `src/http/inbox.ts` (~1433–1600) — the engine-drive block: make it reliable rather than fire-and-forget best-effort.
- `src/http/process-projection.ts` — `appendNextTaskEvent`, `readEvents`, `listInstanceInboxTasks`, `listInstanceProjections` (already model gateways/multi-task; no schema change needed).
- `src/core/externalTaskBridge.ts` (~311, `tel-intake` topic) — the DMN triage seam that injects `approvalRequired` so the gateway routes deterministically.
- `src/server/lifecycle-bridge.ts` (~247–282) — bridge gating on `FLOWABLE_BASE_URL` / `FLOWABLE_TOPICS`.
- `docker-compose.prod.yml` — the **server config gap** (see §6).

**Trade-offs**
- **Consistency of the two machines:** HIGH. Flowable is the single source of branching truth; the inbox can never disagree with the engine about which tasks are live. The "two machines" problem is dissolved by making one (inbox) strictly downstream of the other (engine).
- **Complexity:** the reconcile logic already exists but is subtle (poll-for-task, dedup by `taskDefKey`, AND-split fan-out, `instance.ended` gating). The hardening work is in **delivery semantics** (see below), not new concepts.
- **Latency:** approve returns 200 immediately; the second task appears after the async engine-drive completes (poll up to ~10s for the triage external task, then `completeUserTask` + reconcile). CS-1's `waitForInstanceTask` polls, so the latency is acceptable *if* the engine-drive runs to completion. **Risk: today it is `void`-fired and swallows all errors to `console.warn`** — if the process crashes/restarts, or the bridge hasn't injected `approvalRequired` yet, the second task is silently never emitted. This is the prime suspect for CS-1 flakiness.
- **Testability on deploy-acceptance:** GOOD once reliable — CS-1 is a live-stack journey and the engine-drive is exactly what it exercises. But the current fire-and-forget design makes it **flaky** (timing-dependent), which is *worse* than red: a flaky green erodes the honest-gate.
- **Reversibility:** the design is already shipped and other features (T-0458 timer escalation, T-0459 message-catch) **reuse the same `process.next_task` reconcile**. Reverting A would regress four delivered features. A is effectively load-bearing already.
- **Risk to the green linear path (T-0443):** LOW if we *extend/harden* rather than rewrite. The linear path and the gateway path share the same reconcile loop; the gateway is just "engine has >1 remaining token" vs. "engine has 0 (ended)."

### Option B — Projection extension (inbox models gateways itself, no per-step engine round-trip)

Extend `process-projection.ts` to model the gateway/branching in the audit-event fold itself: on approve of the base task, the projection reads the DMN/threshold result from the record payload (the `amount` and the gateway condition are knowable without Flowable) and **emits the second `process.next_task` directly**, without `completeUserTask` / engine poll. Flowable becomes optional for branching; the projection is the authoritative branch evaluator.

Files in play:
- `src/http/process-projection.ts` — add gateway-evaluation logic to the approve-time fold (needs the BPMN/DMN gateway definition + the record's gating field, e.g. `amount`).
- `src/http/inbox.ts` — emit `process.next_task` synchronously inside the approve tx based on the projection's own gateway eval (drop the engine round-trip).
- The DMN/gateway evaluator (`evaluateGatewayAtTriage`, currently in the bridge seam) would need a second home callable from the projection.

**Trade-offs**
- **Consistency of the two machines:** LOW / NEGATIVE. This **re-introduces** the second state machine the project has been trying to eliminate. The inbox would now have its *own* opinion about branching that can drift from Flowable's actual token state — exactly the failure mode memory flags repeatedly ("inbox-projection ≠ Flowable = 2 machines"). For any element the projection does *not* model (timer boundary, message catch, parallel join, sub-process), the two diverge.
- **Complexity:** re-implementing BPMN gateway/DMN semantics inside the projection duplicates Flowable. Each new authored element (already growing: T-0458 timers, T-0459 messages) must be re-modeled in the projection too. Combinatorial maintenance.
- **Latency:** BETTER — second task appears synchronously at approve, no 10s engine poll.
- **Testability:** the projection-only path is unit-testable without a live engine (a plus). But deploy-acceptance CS-1 still needs the *engine* to agree, so a projection that "passes" without Flowable gives a **false green** on the live stack — the engine's real token could be elsewhere.
- **Reversibility:** B would orphan the substantial T-0443/T-0456/T-0458/T-0459 engine-drive investment and the `instance.ended` engine-gating. High sunk-cost to reverse.
- **Risk to green linear path:** MEDIUM-HIGH — rewiring approve to a projection-authoritative model touches the shared approve tx that T-0443 made green.

---

## 3. Recommendation — **Option A, as "harden the existing T-0443 engine-drive"**

**Recommend A.** The architecture is already A; the project has committed to "Flowable owns branching, inbox projects it" across four delivered features. B would re-fork the state machine the team spent T-0443/T-0456 eliminating, and would produce live-stack false-greens (projection agreeing with itself while the engine token sits elsewhere). The doctrine in memory is explicit and repeated: **two machines must be reconciled by reading live engine state, never by the inbox guessing.**

The reason CS-1 is red is **not** a missing design — it is that the engine-drive is **best-effort/fire-and-forget and timing-dependent**, plus a **server config gap** (§6). The durable fix is to make the post-approve engine reconcile **reliable and idempotent**, not to give the inbox its own branching brain.

### 3.1 What the follow-up build task should change (recommended A, scoped)

1. **Make the engine-drive durable, not `void`-fired.** Today `src/http/inbox.ts` runs the reconcile as `void (async()=>{…})()` and swallows errors. Move it to an **idempotent, retryable reconcile** that survives a process restart — e.g. enqueue a reconcile job (reuse the outbox/job machinery the bridge already has) rather than an in-request floating promise. The reconcile is already idempotent on read (dedup by `taskDefKey` + `alreadyProjectedDefKeys`), so it is safe to re-run.
2. **Reconcile-on-read as the safety net.** T-0458 already added `reconcileInstanceTimers` in `GET /api/inbox`. Generalize that: on inbox read, if an instance has a committed `task.approved` but no `instance.ended` and no pending `process.next_task`, re-poll the engine and emit missing `next_task` rows. This makes CS-1 self-heal even if the post-approve async lost the race — and removes the flakiness that makes a live-stack green untrustworthy.
3. **Confirm the DMN triage seam fires before the gateway is read.** `externalTaskBridge.ts:311` injects `approvalRequired` at `tel-intake`; the engine-drive must not `completeUserTask` until that variable is set, or the gateway routes to the wrong branch. The existing ~10s poll covers the common case; the reconcile-on-read net (point 2) covers the slow case.
4. **Close the prod config gap (§6).**

### 3.2 How this closes CS-1 (`tel-linear.e2e.ts:490`)

CS-1's assertions map 1:1 onto the hardened A:
- line 507 `waitForInstanceTask` (base «Согласование») — surfaced by `process.started` projection (already works).
- line 513 `claimAndApproveTask` — approve writes `task.approved` + runs engine-drive.
- line 518 `waitForInstanceTask` (second «Доп. согласование») — surfaced by the `process.next_task` the engine-drive emits after `completeUserTask` + gateway routes to `task-extra-approve`. **With the reconcile-on-read net, the test's poll will eventually see it even under a lost async race** — turning a flaky/red CS-1 into a deterministic green.
- line 524 `extraTaskId !== taskId` — `process.next_task` carries a fresh UUID (`randomUUID()` in inbox.ts ~1564 / `inboxTaskId` in `appendNextTaskEvent`). Holds.
- lines 526–559 (CS-3 cross_app_ref) — orthogonal; satisfied by `applyStepResult` at approve.

---

## 4. Consequences

- **Positive:** one source of branching truth (Flowable); no projection drift; the T-0458 timer and T-0459 message features keep working unchanged (they reuse the same reconcile); CS-1 becomes deterministic; the honest-gate stays honest (no projection-only false-green).
- **Negative / accepted:** the second task is eventually-consistent (async), not synchronous; we accept ~sub-second-to-10s latency for it, mitigated by reconcile-on-read. The reconcile logic stays subtle and must be covered by a live-DB/live-engine test (CS-1 itself is that test).
- **Rejected B's only real win** (synchronous latency, engine-free unit testability) is not worth re-forking the state machine; engine-free testing is already available at the *projection* unit level without making the projection authoritative.

### 4.1 Migration / rollout sketch (for the build task, NOT this ADR)

1. No DB migration — the event model (`process.started`, `task.approved`, `process.next_task`, `instance.ended`) already covers gateways. **Additive only.**
2. Convert the post-approve `void` engine-drive into an enqueued idempotent reconcile (reuse job/outbox); keep the synchronous best-effort path as a fast-path optimization.
3. Add reconcile-on-read in `GET /api/inbox` for "approved-but-not-ended-and-no-pending-next-task" instances.
4. Fix prod compose (§6).
5. Validate with CS-1 on the live ephemeral stack (deploy-acceptance), run several times to confirm it is **deterministically** green (flaky-green is a fail).

---

## 5. Open questions for the founder (real decisions, not impl details)

1. **GT-1 direction (the load-bearing call):** confirm **A — engine-backed inbox, harden existing T-0443** over **B — projection-authoritative branching**. Recommended: **A.** This is the non-additive choice the task gates on; everything else follows from it.
2. **Eventual-consistency of the gateway-spawned task is acceptable** (second task appears async, not in the approve response)? A implies yes. If the product requires the second task *in the approve 200 response* synchronously, that pushes toward a hybrid (engine-drive synchronous-await before responding) at the cost of approve latency / engine-availability coupling — a different trade.
3. **Authoritative-branching-without-Flowable is explicitly out of scope?** Confirm that "the engine owns branching" remains doctrine (consistent with PD-22). If the founder wants the inbox to ever route without Flowable, that is a separate, larger decision (own-BPMN, previously parked post-clients).

---

## 6. Server config gap — FLOWABLE_TOPICS (separate, small fix)

Named explicitly per the task. The bridge polls only the topics in `FLOWABLE_TOPICS` (`lifecycle-bridge.ts:271`); without `tel-intake` it never fetches the triage external task, so `approvalRequired` is never injected and the gateway can't route → CS-1 dead in the water regardless of the A/B choice.

**Current state (verified in this worktree):**
- `docker-compose.yml` (dev) — **ALREADY FIXED**: line 204 sets `FLOWABLE_TOPICS: ${FLOWABLE_TOPICS:-tel-intake,agent-step}` and line 194 sets `FLOWABLE_BASE_URL`. So the gap the task described (deployed compose sets BASE_URL but not TOPICS → bridge polls 0 topics) is **closed on dev** (likely landed via T-0347 / T-0460 after the T-0273 run that opened this task).
- `docker-compose.prod.yml` — **STILL HAS THE GAP**: it sets neither `FLOWABLE_BASE_URL` nor `FLOWABLE_TOPICS`. On a prod deploy the bridge degrades to a no-op handle (`lifecycle-bridge.ts:248`) → no triage, no engine-drive, branching dead.

**Recommended small fix (build task):** add `FLOWABLE_BASE_URL` + `FLOWABLE_TOPICS: tel-intake,agent-step` (+ admin creds, already required) to `docker-compose.prod.yml`, mirroring the dev compose. One-line-class change, no design risk, independent of the A/B decision — can land immediately.

---

## 7. Dependency T-0483 — status: NOT a blocker

T-0483 is the **engine-readiness probe / compose-internal `flowable` hostname reachability** work (`src/server.ts:480–490`, `src/core/flowable-client.ts` `pingEngine`, `src/bridge-runner.ts:42`). It is **already merged** (present in src with passing tests `flowable-error-http.test.ts`, `binding-trigger.unit.test.ts`). It affects *whether* the app can reach Flowable and surfaces a typed 503 `ENGINE_UNAVAILABLE` when it can't — it does **not** constrain *how* the inbox reconciles with engine state. The recommended Option A depends on the engine being reachable (which T-0483 makes observable/robust), so T-0483 is **complementary and enabling**, not blocking. The design proceeds.

---

## 8. Boundaries

This ADR is design-only. No `inbox.ts` / `process-projection.ts` production code is changed here — those edits are a **separate build task** to be claimed after the founder signs the A/B direction (GT-1). The prod-compose `FLOWABLE_TOPICS` fix (§6) is a standalone small build item that can proceed independently.
