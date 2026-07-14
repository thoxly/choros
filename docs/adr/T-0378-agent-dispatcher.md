# ADR — T-0378 [D4] Agent dispatcher (PD-2) — thin-slice design

> Status: DESIGN (architect, DESIGN phase). Scope: the THINNEST dispatcher loop
> that makes ONE agent-task execute end-to-end (bridge → motor → outcome → step
> closed in Flowable). Spec: `docs/specs/process-execution-model.spec.md` §6/§8/§9.
> Date 2026-06-22 · branch `task/T-0378`.

---

## 0. Executive verdict (read this first)

The gap is real and the reuse story is **mostly intact, with two load-bearing
exceptions**:

1. **There is NO production path today that completes an external task.** The
   bridge poll loop (`runBridgeOnce`) only ENQUEUES jobs into `choros.job`.
   The ONLY code that enqueues a `task_completed` outbox row is the throwaway
   `src/bridge-smoke-runner.ts`. So "the dispatcher reads the job → … → closes
   the step via the bridge's complete path" is **half built**: the *delivery*
   half (outbox → `makeExternalTaskDeliver` → `completeTask`) is live and
   proven; the *trigger* half (claim job → run agent → enqueue the
   `task_completed` row) does NOT exist. The dispatcher IS that trigger half.

2. **The motor is NOT readily generalizable as-is.** `agent-precheck-motor.ts`
   (the pure `classifyOutcome`) IS domain-neutral and reusable verbatim. But the
   *orchestrator* around it, `src/runtime/legal-precheck/run-precheck.ts`, is
   hard-wired to legal-precheck: it takes a `documentHandle` + `dealContext
   {amount,kind,direction}`, builds an `LlmRequest` shaped for contract review,
   reads `agent_instruction` (gated — see §9.G), and hard-defaults `deferRole =
   "fin-ctrl"`, `skill = "legal_precheck"`. Generalizing the **objective** axis
   (spec §9 item 2 / §10) is the single largest piece of new work.

**1-coder slice? — Yes, with a disciplined cut (see §11).** The proceed +
defer-to-human paths reuse `classifyOutcome`, `applyStepResult`, the audit
writer, `planDeferTask`, and the existing outbox→`completeTask` delivery. The
new code is a single loop module + a generalized objective assembler + one
audit-only fail-closed branch + one CI-gate allowlist tweak + one migration to
seed a live (or deliberately dormant) agent on the `tel-intake` topic. It is
**at the top end** of a single slice; if the objective generalization proves
deep, split per §11.

---

## 1. Reuse map (spec §9 "Переиспользуем" → concrete symbol)

| §9 reuse item | Concrete provider | State |
|---|---|---|
| **External-task bridge / poll** | `src/core/externalTaskBridge.ts` `runBridgeOnce`, `startBridgePollLoop` | LIVE — enqueues agent jobs into `choros.job` by topic |
| **JobStore (claim/lock/complete)** | `src/core/postgres/pgJobStore.ts` `fetchAndLock` (FOR UPDATE SKIP LOCKED), `complete`, `fail` | LIVE — exactly the claim/lock/idempotency primitive the dispatcher needs |
| **Outbox → complete step in engine** | `src/core/externalTaskBridge.ts` `makeExternalTaskDeliver` (`case "task_completed"`/`"task_failed"`), wired in `src/server/lifecycle-bridge.ts` `startLifecycleBridge` | LIVE — but the `task_completed` ROW PRODUCER is **MISSING** (only smoke-runner produces it) |
| **Motor outcome classifier** | `src/core/agent-precheck-motor.ts` `classifyOutcome` + `PrecheckOutcome` (`proceed`/`defer-to-human`/`fail-closed`) + `CONFIDENCE_FLOOR` | LIVE, PURE, domain-neutral — **reuse verbatim** |
| **Motor orchestration (IO)** | `src/runtime/legal-precheck/run-precheck.ts` `runLegalPrecheck` | EXISTS but **legal-precheck-specific** → generalize the objective axis (§9 item 2) |
| **LLM port (BYO, PD-5)** | `src/core/llm-port.ts` `LlmPort.complete/chat`, `dormantLlmPort`, `LlmDormantError` | LIVE — `agent_card.llm_*` drives live-vs-dormant |
| **Grants → tools (least privilege)** | `src/core/mcp-tool-registry.ts` `resolveAgentToolset(input, {grants, tools})` (query-over-grants, 0 roles → 0 tools) | LIVE, PURE — needs a `McpToolSource` DB DAO (MISSING, see §9.D) |
| **Grants DAO (role → executors / grants)** | `src/db/grants-dao.ts` `getGrantsForSubject`, `makeDbGrantSource`, `getRoleSlugsForActor` | LIVE — feeds both the PDP and `resolveAgentToolset` |
| **Criticality ceiling (gate B)** | `src/core/role-criticality.ts` `roleCriticality`/`combineCriticality` → `.level`, `RoleGrantSource` port | LIVE, PURE — "critical → always to human" is `level === "critical"` |
| **dual-control** | `src/core/dual-control.ts` (not modified by this slice) | LIVE — out of scope; agent is structurally never an approver (it holds no approve grant) |
| **PDP (resolveFor)** | `src/core/grant-resolver.ts` `resolveFor` | LIVE — single authority; reuse for the read gate |
| **Result-entity (F2)** | `src/db/step-applier.ts` `applyStepResult` (A-branch → «Согласование» record + `record.create` audit + `step_applied` outbox, all in caller tx) | LIVE — reuse for the `proceed` result-entity write |
| **Audit logger** | `src/db/audit-writer.ts` `makePgAuditWriter().appendAuditEvent` | LIVE — single canonical sink |
| **Defer → inbox task** | `src/core/defer-inbox-producer.ts` `planDeferTask` + the `agent.deferred` audit event (`run-precheck.ts` `deferredAuditEvent`); read-projection `src/db/deferred-inbox-store.ts` | LIVE — defer record == audit_event, NO new table (D-061) |
| **Substitution resolver** | `src/core/substitution.ts` `resolveSubstitution` | LIVE but **NOT wired into routing** → DEFER (§11, phase-1 work, T-0378-followup) |
| **Inbox** | `src/http/inbox.ts` (approve card-action) | LIVE — the defer path lands as a pool task via the `agent.deferred` projection; no inbox change needed |

---

## 2. The mechanism truth (correcting the task framing)

The task says the agent-task is "a green External/Service Task with
`choros:executorType="agent"`". That attribute is **a modeler/moddle concept**
(T-0099: `choros:executorType` round-trips in the bpmn-js editor) — it is NOT
present in the *deployed* runtime BPMN. The runtime contract is **topic-based**:

- `config/flowable/processes/tel-linear.bpmn20.xml` `task-triage` is
  `flowable:type="external" flowable:topic="tel-intake"` — this IS the agent
  step (comment: "Агентский шаг (a-intake, role-intake-agent)… agent_card DORMANT").
- The bridge polls topics from `FLOWABLE_TOPICS` and enqueues each external task
  as a `choros.job` row keyed by topic.

**Decision:** the dispatcher keys off the **job topic**, not a BPMN attribute.
An "agent topic" is one in a configured set of agent topics (env
`AGENT_TOPICS`, default `["tel-intake"]` for the keystone). Human/deterministic
external topics (e.g. `customer-onboarding-notify`, or the DMN-gated
`tel-intake` triage that `makeExternalTaskDeliver` already special-cases) stay
on the existing delivery path. **Risk note:** `tel-intake` is *currently* the
DMN-gateway triage seam in `makeExternalTaskDeliver` — see §9.F for the
collision and the resolution.

---

## 3. Thin slice — new code (files + responsibilities)

### NEW (small, glue)

**`src/runtime/agent-dispatch/run-agent-step.ts`** — the generalized motor
orchestrator (the de-legal-precheck'd sibling of `run-precheck.ts`).
- Input: `AgentStepContext` (§4). Output: `PrecheckOutcome` (reused union).
- Steps mirror `run-precheck.ts` but neutral: PDP read-gate via `resolveFor` →
  live-gate (`agent_card.llm_*` + `liveEnabled`) → build a **neutral**
  `LlmRequest` from the *objective* (NOT `documentHandle`/`dealContext`) → call
  `port.complete` → build `OutcomeSignals` (apply `autonomy_threshold` as gate A,
  `CONFIDENCE_FLOOR`) → `classifyOutcome`.
- For day-1 the neutral `LlmRequest` reuses the existing `LlmRequest` shape (it
  already carries `instruction` + `document` + `dealContext` + `answerForm`);
  the dispatcher fills `document` from the record-ref snapshot and `dealContext`
  from a neutral `{amount:0, kind:objective.kind, direction:""}` placeholder OR
  we widen `LlmRequest` minimally (see §10 Q3). PURE-core stays untouched.

**`src/runtime/agent-dispatch/agent-step-context.ts`** — the `AgentStepContext`
assembler (the part that turns a `choros.job` row into context).
- objective ← job `topic` + `variables` (the binding/form values captured at
  fetchAndLock) + the agent's published instruction (read via
  `agent-instruction-store.readPublished` — gated, §9.G).
- recordRef ← `resolveInstanceTargetOnClient(client, tenantId, instanceId)`
  (`InstanceTargetRef.primaryRecordId` / `registryId`).
- tools ← `resolveAgentToolset({tenantId, employeeId, nowMs}, {grants, tools})`.
- llm ← `agent_card.{llm_endpoint,llm_model,llm_secret_handle}`.
- autonomy ← `agent_card.autonomy_threshold` (tenant-default fallback in §9.A).
- criticalityCeiling ← `roleCriticality(roleGrantSource, tenantId, roleId, nowMs).level`.
- budget ← injected `BudgetPort` stub (see §3 DEFERRED — gate C is a stub
  returning `{exhausted:false}` for the keystone; real enforcement is phase-3).

**`src/runtime/agent-dispatch/dispatch-outcome.ts`** — outcome decomposition (the
load-bearing reuse weld). One function `applyAgentOutcome(client, ctx, outcome)`
run inside ONE caller tenant tx:
- `proceed` → `applyStepResult(...)` (result-entity F2) **⊕** an
  `agent.proceeded` audit event **⊕** enqueue a `task_completed` outbox row
  (`aggregateKind:"job"`, `aggregateId: jobId`, `eventType:"task_completed"`,
  `payload:{workerId, variables}`, `idempotencyKey: "complete:"+jobId`) **⊕**
  `jobStore.complete(workerId, jobId, payload)` — exactly the smoke-runner's
  Step-3 shape, but in production. The bridge's existing delivery loop then calls
  `completeTask` in Flowable and fires the lifecycle audit.
- `defer-to-human` → write the `agent.deferred` audit event (reuse
  `deferredAuditEvent` shape from `run-precheck.ts`, lifted into a shared helper)
  + `jobStore.complete` is **NOT** called (the engine step stays open until the
  human approves via the inbox). Day-1: the agent job is `fail`'d back with
  `retries=0` → it parks as a FAILED job (no engine close); the human picks up
  the deferred task from the inbox projection and the human approve path closes
  the step. *(See §10 Q4 — the exact "how does a human approve an external-task
  step" wiring is the subtlest open question.)*
- `fail-closed` → write `agent.blocked` audit event + `jobStore.fail(...,
  retries)` (bridge retry policy). At minimum this slice **audits** fail-closed.

**`src/server/agent-dispatch-loop.ts`** — the poll scheduler (mirror
`startBridgePollLoop`). `startAgentDispatchLoop(deps)`:
- `setInterval` → `runAgentDispatchOnce(jobStore, agentTopics, workerId, ...)`.
- per pass: `jobStore.fetchAndLock(workerId, AGENT_TOPICS, max, lockMs)` →
  for each job, open a tenant tx, assemble context, run motor, apply outcome.
- Degraded-safe: no `AGENT_TOPICS` or no deps → no-op handle (mirror
  `noopHandle()` in lifecycle-bridge). Wired in the composition root ALONGSIDE
  `startLifecycleBridge` (NOT inside `createServer`, per the lockReclaimer FF-9
  pattern).

**`src/db/mcp-tool-dao.ts`** (MISSING piece, §9.D) — `McpToolSource` impl:
`listTools(tenantId)` over `choros.mcp_tool` (RLS-scoped). Needed for
`resolveAgentToolset`. Small. *(If `mcp_tool` is unseeded for the keystone agent,
the toolset is empty — acceptable: the keystone agent does pure reasoning, no
tool calls. See §10 Q1.)*

**Migration `migrations/0NN_agent_dispatch_seed.sql`** — additive: ensure the
`tel-intake` topic's agent (a-intake / role-intake-agent) has an `agent_card`
row and either (a) a real `llm_*` config for a LIVE keystone, or (b) stays
dormant so the keystone proves the `defer-to-human` (dormant) path end-to-end
without a paid LLM. **Recommended day-1: dormant** → the keystone proves the
full weld (job claimed → motor runs → dormant → `agent.deferred` → human inbox →
approve → step closes) with ZERO LLM spend, exactly the s37/s38 honest-gate
discipline. The LIVE proceed path is then a follow-up flip of `llm_*` (RL-3
secret handle) — no code change.

**`ci/checks/agent-instruction-runtime-dormant.sh`** — additive allowlist edit
(§9.G): add `src/runtime/agent-dispatch/` to `ALLOWED_RE`. This is a **founder-
class frozen-check touch** (per memory s28/s29/s32 discipline) — flag for the
auto-additive sanction path (catalog-bound + additive + meta-gate-accept).

### DEFERRED (explicitly, with follow-up task names)

| Deferred | Why | Follow-up |
|---|---|---|
| Substitution wiring into routing (§9 item 5, §4.3) | not needed for ONE agent-task to run; the agent IS the resolved executor | **T-0378-F1** (phase-1 human-side, per spec §11) |
| Fallback→owner branch + configurable executor (§9 item 3, §4.4) | human-step concern; the agent step's executor is the topic's agent | **T-0378-F1** |
| SLA escalation (§4.5) | phase-3 | **T-0378-F3** |
| Real budget enforcement gate C (§9 item 7) | day-1 a `{exhausted:false}` stub; the gate is WIRED, the meter is stubbed | **T-0378-F3** |
| Per-tool-call audit trail (§8 "каждый вызов инструмента") | keystone agent has empty toolset (dormant); no tool calls to audit yet | **T-0378-F2** (lands with live toolset) |
| Escalation UI polish / prefilled form (F5) | the deferred task already surfaces in the inbox with `doubt_reason`; the rich prefilled draft form is polish | **T-0378-F3** |
| LIVE `proceed` with a paid LLM | dormant keystone proves the weld; flip `llm_*` after | follow-up flip, no code |

---

## 4. Contracts

### `AgentStepContext` (TS interface)

```ts
/** Assembled from one agent-topic choros.job row, inside the tenant tx. */
export interface AgentStepContext {
  readonly tenantId: string;
  /** choros.job.id — the dedup/idempotency subject for complete/fail. */
  readonly jobId: string;
  /** Flowable external-task id (== job.idempotency_key) — the engine close key. */
  readonly externalTaskId: string;
  /** Flowable process-instance id (from job.variables / resolver correlation). */
  readonly instanceId: string;
  /** Process-definition key, e.g. "telLinear". */
  readonly procKey: string;
  /** The agent employee acting on this step (kind='agent'); the motor's subject. */
  readonly agentEmployeeId: string;
  /** The role the agent holds for this step (for criticality + toolset). */
  readonly roleId: string;

  /** OBJECTIVE — domain-neutral (replaces documentHandle+dealContext). */
  readonly objective: {
    /** Structured step intent (the binding/form fields, F1). */
    readonly fields: Record<string, unknown>;
    /** Optional NL objective compiled by the configurator (F1). */
    readonly prompt?: string;
    /** Published agent instruction text (read via the gated DAO). */
    readonly instruction: string;
    /** Answer-form code (from agent_instruction.answerForm). */
    readonly answerForm: string;
  };

  /** RECORD REF — the entity(ies) the step operates over (process references). */
  readonly recordRef: {
    readonly registryId: string;
    readonly applicationId: string;
    readonly primaryRecordId?: string;
    /** Visible field snapshot (from resolveFor read-gate). */
    readonly snapshot: Record<string, unknown>;
  };

  /** TOOLS — grants→MCP tools (least privilege; may be empty). */
  readonly tools: readonly McpToolRow[];

  /** LLM — BYO config (PD-5); nulls ⇒ dormant. */
  readonly llm: {
    readonly endpoint: string | null;
    readonly model: string | null;
    readonly secretHandle: string | null;
  };

  /** AUTONOMY — gate A threshold (tenant-default + agent override). */
  readonly autonomyThreshold: number | null;
  /** GATE B — the agent's criticality ceiling. "critical" ⇒ always defer. */
  readonly criticalityLevel: "routine" | "critical";
  /** GATE C — budget snapshot (day-1 stub). */
  readonly budget: { readonly exhausted: boolean };

  readonly nowMs: number;
}
```

### Data flow (dispatcher ↔ motor ↔ outcome)

```
agent-dispatch-loop (setInterval)
  └─ jobStore.fetchAndLock(workerId, AGENT_TOPICS) → Job[]
       └─ for each Job:  withTenantTx(tenantId):
            assembleAgentStepContext(client, job) ─────────► AgentStepContext
                 (resolveFor read-gate, readPublished instr,
                  resolveInstanceTargetOnClient, resolveAgentToolset,
                  loadAgentCard, roleCriticality)
            ── gate B short-circuit: criticalityLevel==='critical' ──┐
            ── gate C short-circuit: budget.exhausted ───────────────┤ (force defer)
            runAgentStep(client, deps, ctx) ─────────► PrecheckOutcome
                 (live-gate → port.complete → OutcomeSignals(gate A) → classifyOutcome)
            applyAgentOutcome(client, ctx, outcome):
                 proceed         → applyStepResult ⊕ agent.proceeded audit
                                   ⊕ enqueue task_completed outbox ⊕ jobStore.complete
                 defer-to-human  → agent.deferred audit ⊕ jobStore.fail(retries=0)
                                   (human inbox picks it up; human approve closes step)
                 fail-closed     → agent.blocked audit ⊕ jobStore.fail(retries)
       (COMMIT — atomic per job; rollback undoes record + audit + outbox together)
  ↓ (out-of-band)
outbox dispatcher (startLifecycleBridge) → makeExternalTaskDeliver
  → completeTask(externalTaskId) in Flowable → lifecycle audit (task.completed)
```

**Gate ordering decision (spec §6 A∧B∧C):** B and C are evaluated by the
dispatcher BEFORE invoking the motor (a `critical` step or an exhausted budget
forces `defer-to-human` without spending an LLM call). A is the motor's internal
confidence/threshold gate via `OutcomeSignals.thresholdFailed`. This keeps the
"critical → always to human" (F3) and "budget → defer" guarantees independent of
the LLM, which is the fail-closed-correct ordering.

---

## 5. Idempotency story (re-runs after lock-expiry stay safe)

The dispatcher inherits the JobStore + outbox idempotency primitives — no new
algebra:

1. **Job lock.** `fetchAndLock` (FOR UPDATE SKIP LOCKED) gives exactly one worker
   the LOCKED job. A second dispatcher pass SKIPs it. On lock expiry,
   `fetchAndLock`'s `state='LOCKED' AND lock_expiry <= now` clause re-acquires it
   → re-run. **The whole context-assemble + motor + outcome runs inside ONE
   tenant tx that ends with `jobStore.complete`/`fail`** — so a crash before
   COMMIT leaves the job LOCKED (reclaimed on expiry) with ZERO side effects
   (record/audit/outbox all rolled back).

2. **complete()/fail() ownership gate.** `pgJobStore.complete` re-checks
   `lock_owner == workerId AND lock_expiry > now` atomically; a re-run by a NEW
   owner whose predecessor already COMPLETED gets `NOT_LOCKED` (harmless).

3. **Outbox replay guard.** The `task_completed` row uses
   `idempotencyKey: "complete:"+jobId` → `ON CONFLICT DO NOTHING`. A re-run that
   re-enqueues the same key is a no-op. `applyStepResult`'s `step_applied` outbox
   uses `step_applied:${instanceId}:${taskId}` (here `taskId == jobId`) — same
   guard. The `record` INSERT carries a server-minted id; the at-most-once close
   is enforced by the outbox UNIQUE + the job state machine.

4. **Flowable completeTask idempotency.** `makeExternalTaskDeliver` already maps
   `NOT_FOUND` → `idempotentSuccess:true` (already completed externally).

**Net:** a lock-expiry re-run either (a) finds the job already COMPLETED and is a
no-op, or (b) re-runs the motor and re-applies — and every effect is guarded by a
UNIQUE key, so the worst case is one duplicate LLM call (cost, not corruption).
The motor itself is deterministic given identical inputs (PURE `classifyOutcome`).

---

## 6. Test plan

### Unit-level (no live infra) — the bulk

- **`classifyOutcome` reuse** — already covered by
  `agent-precheck-motor.test.ts`; add cases exercising the dispatcher's gate-B/C
  short-circuit producing `defer-to-human` (pure, table-driven).
- **`assembleAgentStepContext`** — inject in-memory `GrantSource` /
  `McpToolSource` / a fake `client` (query stub) → assert objective/recordRef/
  tools/llm/autonomy/criticality assembled correctly; 0-grants ⇒ empty toolset
  (AC: `resolveAgentToolset` 0 roles → 0 tools).
- **`applyAgentOutcome` branch logic** — with a stub `OutboxEnqueuePort` + stub
  `jobStore` + in-memory audit writer:
  - proceed → asserts `applyStepResult` called, `agent.proceeded` appended,
    `task_completed` enqueued with `complete:<jobId>` key, `jobStore.complete`
    called.
  - defer → asserts `agent.deferred` appended, `jobStore.complete` NOT called,
    `jobStore.fail(retries=0)` called.
  - fail-closed → asserts `agent.blocked` appended, `jobStore.fail` called.
- **`runAgentDispatchOnce`** — with `InMemoryJobStore` seeded with one agent-topic
  job + `dormantLlmPort` → asserts the job is consumed and lands a
  `defer-to-human` (dormant) outcome (the keystone happy-path WITHOUT a network).
- **Dispatch loop lifecycle** — injectable `setIntervalFn` (mirror existing
  bridge tests): start → one pass → stop; no unhandled rejection after stop.
- **Idempotency** — run `applyAgentOutcome` twice with the same jobId against the
  same in-memory outbox → second `task_completed` enqueue is deduped.

### Needs live-DB (fitness:db on the server, per memory: run targeted against
`choros_migrator@100.121.76.86:55432`, NOT the Mac)

- **`mcp-tool-dao.listTools`** RLS-scoped read.
- **`assembleAgentStepContext` end-to-end** against a seeded tenant (real
  `agent_card`, `grant`, `role_assignment`, `mcp_tool`, `process_app_binding`).
- **The atomic-tx invariant** — force `applyStepResult` to throw (no
  «Согласование» registry) → assert ROLLBACK leaves zero record + zero audit +
  zero outbox (the T-0335 fitness pattern).

### Needs live Flowable (deploy-acceptance, founder deploy GO)

- **The keystone end-to-end**: start a `telLinear` instance → triage external
  task enqueued → dispatcher claims it → dormant → `agent.deferred` → the task
  appears in the human inbox → human approve → step closes in Flowable → instance
  advances. This is the honest-gate proof; per memory it can only be taken on the
  live dev stack (`:3000`), and the LIVE proceed variant requires the `llm_*`
  flip.

---

## 7. Open questions (§10) with recommended answers

**Q1 — Exact grants→MCP-tools mapping.**
*Answer:* use `resolveAgentToolset` verbatim (query-over-grants); add the missing
`McpToolSource` DB DAO (`mcp-tool-dao.ts`). For the keystone, the dormant agent
has an empty/unseeded toolset → empty toolset is fine (pure reasoning). Per-tool
audit is deferred to T-0378-F2 (lands with a live toolset).

**Q2 — Generalizing the motor (objective domain-neutral).**
*Answer:* keep `agent-precheck-motor.ts` (PURE classifier) untouched; write a
NEW neutral orchestrator `run-agent-step.ts` rather than mutating
`run-precheck.ts` (which stays the legal-precheck skill path, with its narrow
gate allowlist intact). The neutral orchestrator builds the `LlmRequest` from
`AgentStepContext.objective` instead of `documentHandle`/`dealContext`. This is
ADDITIVE — it does not destabilize the existing legal-precheck path or its 4
dedicated CI gates.

**Q3 — `LlmRequest` shape for a neutral step.**
*Answer:* day-1, reuse the existing `LlmRequest` (it already has
`instruction`+`document`+`answerForm`), filling `document` with the record-ref
snapshot JSON and passing a neutral `dealContext` placeholder. If that feels
dishonest, widen `LlmRequest` minimally with an optional
`objectiveFields?: Record<string,unknown>` (additive, PURE-core safe). Recommend
the additive optional field — cleaner and keeps `precheck-no-network-in-core.sh`
green.

**Q4 — Does `resolveSubstitution` already run in inbox routing? / how does a
human approve an EXTERNAL-task step after a defer?**
*Answer (substitution):* NO — `resolveSubstitution` is built but NOT wired into
inbox routing (confirmed: no call-site in `src/http/inbox.ts`). DEFER to
T-0378-F1. *Answer (the subtle one):* the human approve path
(`POST /api/inbox/:id/action`) today closes a **userTask** step via the
`task.approved` projection — NOT a Flowable external task. After an agent defer,
the open step is the **external** `tel-intake` task. The cleanest day-1 cut: the
defer DOES NOT leave the external task open — instead the dispatcher `complete`s
the external task with a variable signalling "deferred" so the engine routes to a
**human userTask** (the «Согласование» step already exists downstream), and the
human approves THAT. i.e. **the agent step always closes; the defer materializes
as the next human step.** This matches the BPMN (triage external → gateway →
human approve) and avoids inventing an external-task human-completion path. This
is the recommended answer and the single most important design call to validate
with the coder/founder. *(If instead defer must hold the SAME step open for a
human, that is a bigger change — external-task human completion — and the slice
must split, see §11.)*

**Q5 — Standard «исход агента» entity form (F2).**
*Answer:* reuse `applyStepResult`'s A-branch → a «Согласование» record whose
`formData` is the agent outcome: `{decision: answer.summary, confidence,
red_flags: answer.redFlags, reasoning_ref, decided_by: agentEmployeeId,
source: "agent"}`. No new registry; the existing approvals registry + cross-app
ref is the standard form (consistent with the human approve outcome shape).

---

## 8. Risk — where the reuse breaks down and the slice balloons (honest)

1. **Motor generalization depth (MEDIUM-HIGH).** If the neutral objective needs
   real configurator compilation (F1: structured fields + NL → a compiled
   prompt) rather than "pass the instruction + snapshot through", that is its own
   task. *Mitigation:* day-1 the objective is `instruction + record snapshot`
   (no compiler) — honest and small. If the founder wants the F1 compiler now,
   split it out (T-0378-A).

2. **The defer↔external-task-close question (Q4) is load-bearing (HIGH).** If the
   answer is "agent step always closes, defer = route to a downstream human step"
   → thin (recommended). If "defer must hold the external task open for a human"
   → we must build external-task human completion (a new inbox capability), which
   doubles the slice. **This MUST be settled before coding.**

3. **`tel-intake` topic collision (MEDIUM).** `makeExternalTaskDeliver` already
   special-cases `tel-intake` (DMN gateway `evaluateGatewayAtTriage` at the
   *complete* seam). If the dispatcher claims `tel-intake` jobs and completes them
   via its own outbox row, the DMN late-compute MUST still run. *Mitigation:* the
   dispatcher's `task_completed` payload flows through the SAME
   `makeExternalTaskDeliver` (which still runs `evaluateGatewayAtTriage` for
   `tel-intake`) — so the DMN seam is preserved as long as the dispatcher does
   NOT bypass the outbox. Use a DISTINCT keystone topic if any doubt (seed a new
   agent serviceTask topic rather than reusing the DMN triage topic). Recommend a
   dedicated keystone agent topic to avoid the collision entirely.

4. **CI frozen-gate touch (LOW-MEDIUM, process).** Editing
   `agent-instruction-runtime-dormant.sh`'s allowlist is a founder-class frozen
   check. Per memory (s28/s29/s32) this needs the auto-additive sanction
   discipline (catalog-bound + additive + meta-gate-accept) or it blocks the
   merge. *Mitigation:* if we instead place the dispatcher under
   `src/runtime/legal-precheck/` we avoid the edit — but that is a lie (it is not
   legal-precheck). Better: take the additive allowlist edit with the sanction.

5. **`opus background agents drop connection on long tasks` (process, per
   memory).** Build with commit-early discipline; the slice's file count (~6) is
   within one coder's reach but is at the upper bound.

---

## 9. Detailed reuse findings (file:line evidence)

- **A. autonomy threshold** — `agent_card.autonomy_threshold` exists
  (`migrations/032_agent_card.sql:50`), seeds are NULL (dormant,
  `:88-92`). Read at `run-precheck.ts:401-405` as gate A. Tenant-default
  fallback is NOT yet stored → day-1 hardcode a const default (e.g. 0.85) when
  NULL, documented; the per-tenant default column is phase-3.
- **B. criticality ceiling** — `role-criticality.ts:112-120` `criticalityLevel`,
  `:138-174` `combineCriticality`, `:84-86` `RoleGrantSource` port. `.level ===
  "critical"` ⇒ force defer (F3).
- **C. budget** — NO `instance_budget` table yet (`migrations/032` line 28 notes
  it is deferred to T-0023, which has not landed). Gate C is a STUB this slice.
- **D. grants→tools** — `mcp-tool-registry.ts:178-199` `resolveAgentToolset`
  needs a `McpToolSource`; only an in-memory stub exists. **MISSING:**
  `src/db/mcp-tool-dao.ts` (small RLS read over `choros.mcp_tool`).
- **E. result-entity / audit / step-close** — `step-applier.ts:270-431`
  `applyStepResult` (reuse for proceed); `audit-writer.ts` `appendAuditEvent`;
  the outbox→`completeTask` delivery `externalTaskBridge.ts:287-375`.
- **F. `task_completed` producer MISSING** — only `bridge-smoke-runner.ts:213-223`
  produces it. The dispatcher's `dispatch-outcome.ts` is the production producer
  (shape copied from the smoke runner). `tel-intake` DMN collision:
  `externalTaskBridge.ts:311-363`.
- **G. dormant gate** — `ci/checks/agent-instruction-runtime-dormant.sh`:
  `RUNTIME_PATHS` includes `src/worker` + `src/core/engine` (a dispatcher there
  reading `agent_instruction` FAILS); `ALLOWED_RE` permits only
  `src/runtime/legal-precheck/`. **Placement decision: `src/runtime/agent-dispatch/`
  + additive `ALLOWED_RE` entry.**
- **H. job claim/lock/complete** — `pgJobStore.ts:223-258` `fetchAndLock`,
  `:285-338` `complete`, `:343-396` `fail`. Idempotent enqueue `:88-142`.
- **I. record ref** — `process-instance-resolver.ts` `resolveInstanceTargetOnClient`
  (`:218`), `InstanceTargetRef.primaryRecordId` (`:116`).
- **J. defer→inbox** — `defer-inbox-producer.ts:61-94` `planDeferTask`; the
  `agent.deferred` audit event `run-precheck.ts:146-181`; read-projection
  `src/db/deferred-inbox-store.ts`. NO new table (D-061).

---

## 10. Recommended task split (the architect's call)

**This is a 1-coder slice IF Q4 resolves to "agent step always closes; defer
routes to the next human step" AND the keystone runs DORMANT (no live LLM).**
That cut is: `dispatch-outcome.ts` + `run-agent-step.ts` (objective = instruction
+ snapshot, no F1 compiler) + `agent-step-context.ts` + `agent-dispatch-loop.ts`
+ `mcp-tool-dao.ts` + the seed migration + the CI allowlist edit. Proceed path is
provable in unit + (dormant) on the live stack; the LIVE proceed is a later
`llm_*` flip.

**Split it into two tasks IF** either (a) Q4 needs external-task human
completion (defer holds the same step open), or (b) the founder wants the F1
objective compiler now:

- **T-0378 (keystone, this slice):** dispatcher loop + outcome decomposition +
  context assembler (objective = instruction + snapshot) + `mcp-tool-dao` + seed
  + CI allowlist. Proves: agent job claimed → motor → dormant `defer` → human
  inbox → approve → step closes; AND proceed path unit-proven, dormant-proven.
- **T-0378-A (objective generalization / F1 compiler):** structured-fields + NL
  → compiled objective; widen `LlmRequest`. Only if the keystone's
  "instruction + snapshot" objective is judged too thin.
- **T-0378-F1/F2/F3:** substitution wiring, per-tool audit + live toolset,
  budget enforcement + SLA + prefilled escalation form (spec §11 phases 1/3).

---

## 11. One-line summary for the loop

Build `src/runtime/agent-dispatch/` (loop + context + outcome) that claims
agent-topic `choros.job` rows via the existing `pgJobStore.fetchAndLock`, runs a
NEW domain-neutral orchestrator around the REUSED PURE `classifyOutcome`, and
decomposes the outcome by REUSING `applyStepResult` (proceed F2) + the
`agent.deferred`/`agent.blocked` audit events + the existing outbox→`completeTask`
delivery — keystone runs DORMANT (zero LLM) to prove the full weld, with the LIVE
proceed path a later `llm_*` flip.
