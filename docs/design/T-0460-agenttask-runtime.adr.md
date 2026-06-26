---
task_id: T-0460
status: ready
adr_artifact_path: docs/design/T-0460-agenttask-runtime.adr.md
---

# ADR T-0460 — agentTask живой (D8-R5): the runtime that executes an agent step

> DESIGN phase (architect). Implements `process-element-runtime.spec.md §3.6 (R5)`
> by **realising** `process-execution-model.spec.md §6 (D4)` for a *real authored*
> agentTask. Does NOT redesign D4, the dispatcher, the motor, the LLM port, or the
> auth model — those exist and are wired. This ADR closes the **one missing wire**:
> an authored agentTask must actually become a job on the `agent-step` topic so the
> already-built, already-wired dispatcher fires on it — dormant-safe, unit-testable,
> with live proof founder-gated.

---

## 0. TL;DR

The D4 runtime is **already built and wired**: `agent-dispatch-loop.ts` (T-0378/T-0392)
runs in the composition root (`main.ts`), assembles context (`agent-step-context.ts`),
runs the neutral motor (`run-agent-step.ts` reusing `classifyOutcome` + `LlmPort`),
and decomposes the outcome (`dispatch-outcome.ts` → `proceed`/`defer-to-human`/`fail-closed`).
The defer→human path is live: `agent.deferred` audit events surface in the inbox
«Эскалации» tab with an F5 prefilled draft (`deferred-inbox-store.ts` → `inbox.ts`).
The element-settings panel exists (`agent-task-panel.jsx` T-0461 + `choros-moddle-extension.js`).

**What is missing** is the seam between *authoring* and *runtime*: an authored
agentTask is a `serviceTask` carrying `choros:executorType="agent"` + `choros:agentRef`,
but at publish nothing converts it into a Flowable **external task** on the `agent-step`
topic, and nothing stamps the agent identity into the external-task variables the
dispatcher reads. So the bridge never enqueues an `agent-step` job and the dispatcher
never fires. This ADR adds **one pure publish-transform** (`mapAgentTaskToExternal`),
mirroring the existing `mapLanesToCandidateGroups` (T-0457) and `mapTimerEscalation`
(T-0458) transforms in `process-defs.ts`, plus the linter coherence + the bridge-topic
config. Everything downstream already runs.

---

## decision

**Realise agentTask execution by closing the authoring→runtime seam with a single
pure publish-transform, reusing the entire already-built D4 dispatcher unchanged.**

### The seam (where agentTask hooks in)

```
AUTHORING (exists)                 PUBLISH (the new wire)            RUNTIME (exists, wired)
agent-task-panel.jsx (T-0461)  →   process-defs.ts publish chain  →  Flowable deploy
  choros:executorType="agent"        mapAgentTaskToExternal(xml):       <serviceTask
  choros:agentRef=<AgentPublic.id>     serviceTask[executorType=agent]      flowable:type="external"
  choros:autonomyLevel                 → + flowable:type="external"          flowable:topic="agent-step"
  choros:agentReadsFields                + flowable:topic="agent-step"        ...>
  choros:agentWritesFields               + variables: agentRef→agentEmployeeId,
                                           roleId, fields                  │ engine creates ext-task
                                                                           ▼
                                  externalTaskBridge.ts (exists)  ← fetchAndLock("agent-step")
                                    jobStore.enqueue("agent-step", vars, task.id)
                                                                           │
                                                                           ▼
                                  agent-dispatch-loop.ts (exists, in main.ts)
                                    PostgresAgentJobFetcher → withTenantTx:
                                      assembleAgentStepContext  (grants-dao, mcp-tool-dao,
                                        role-criticality, agent_card llm_*/autonomy,
                                        instruction-store)  ← loads grants + LLM + objective
                                      runAgentStep            (gate B critical → defer;
                                        gate C budget; live-gate → LlmPort.complete;
                                        gate A autonomy_threshold + CONFIDENCE_FLOOR;
                                        classifyOutcome INV-DEFAULT)
                                      applyAgentOutcome:
                                        proceed → applyStepResult + agent.proceeded
                                                  + task_completed outbox + job.complete
                                        defer   → agent.deferred audit (= inbox task, F5 draft)
                                                  + task_completed outbox + job.complete
                                        fail    → agent.blocked audit + job.fail (no close)
                                                                           │
                                                                           ▼
                                  defer → deferred-inbox-store.ts → inbox.ts «Эскалации» tab
                                          (escalation form, prefilled with agentDraft)
```

**Job source = the existing Flowable external-task topic, via the existing bridge.**
NOT a new poller, NOT the keystone-as-only-source. The dispatcher already keys off
the **job topic** (`AGENT_TOPICS`, default `["agent-step"]`) — by design it does NOT
key off a BPMN attribute and does NOT collide with the `tel-intake` DMN-triage seam.
The only thing absent is that the publish step never stamps `flowable:type="external"
flowable:topic="agent-step"` onto an authored agent serviceTask, so Flowable never
surfaces it as an external task on that topic. `mapAgentTaskToExternal` supplies that.

**Grants + LLM + motor + threshold are loaded and gated by `assembleAgentStepContext`
+ `runAgentStep` exactly as already coded** — this ADR names them as REUSE, adds none:
- grants → tools: `resolveAgentToolset` over `makeDbGrantSource` (`grants-dao.ts`) + `makeDbMcpToolSource`.
- LLM connection: `readAgentCardLlmConfigById` (custody DAO, opaque `secret_handle_ref`) → injected `LlmPort`.
- precheck motor: `runAgentStep` → `classifyOutcome` (`agent-precheck-motor.ts`), neutral re-skin of `run-precheck.ts`.
- autonomy gate: `agent_card.autonomy_threshold` (per-agent) ∨ `DEFAULT_AUTONOMY_THRESHOLD` (tenant default in code), clamped to `MIN_AUTONOMY_THRESHOLD`; `confidence ≥ threshold` ⇒ self-close, else defer.
- criticality ceiling (F3): `roleCriticality` — critical step ⇒ ALWAYS defer, never spends an LLM call.

### Dormant-safe + LLM-port-injected (buildable-now vs founder-gated)

The runtime is **already dormant-safe**: `runDeps: { llm: dormantLlmPort, liveEnabled: false }`
in `buildAgentDispatchDeps`. With no LLM key, `runAgentStep` picks `dormantLlmPort`,
`complete()` throws `LlmDormantError`, `classifyOutcome` returns `defer-to-human`
(signal `dormant`) — the agentTask honestly defers to a human, ZERO LLM spend, no
crash. Going live is a config flip (`liveEnabled=true` + BYO `agent_card.llm_*`), no
code change (three-lock dormancy from `llm-port.ts`).

- **Buildable-now (this task):** the publish-transform + linter coherence + the
  threaded variables + UNIT tests proving the *whole weld* with `dormantLlmPort` and
  a `stub-llm-port` (proceed branch). No live LLM, no deploy. Provable in CI.
- **Founder-gated (separate, NOT this task):** "agentTask живой on the deployed
  stack with a REAL LLM" needs an LLM key + deploy GO. Captured as the deploy-acceptance
  journey AC-LIVE below — `needs_founder`, do not block the buildable slice.

### defer→human (escalation form) — pure reuse

Already built: `applyAgentOutcome`'s `defer-to-human` branch writes an `agent.deferred`
audit event (D-061, no new table — the event IS the inbox task), threading the agent's
draft (`agentDraft`, F5) via `planDeferTask` (`defer-inbox-producer.ts`). The inbox
read-projection (`deferred-inbox-store.ts` → `inbox.ts`, lines ~556-615) merges these
into the «Эскалации» tab additively, with `doubt_reason` and the prefilled draft so the
human reviewer accepts/edits/rejects rather than starting blank. **This ADR adds nothing
to the defer path** — it only ensures real agentTasks reach it.

### element-settings (additive)

`agentTask` already appears as a configurable element (`agent-task-panel.jsx` T-0461,
`choros-moddle-extension.js`): the author picks the agent (`choros:agentRef`), sets
autonomy, declares read/write fields. This ADR adds the **runtime consequence** of that
config: `mapAgentTaskToExternal` reads `choros:agentRef`/reads/writes at publish and
materialises the external-task topic + variables. Additive to the existing element-set
and to the publish transform chain — no panel change required for the runtime to fire.

---

## 1. The T-0432 dependency verdict — **INDEPENDENT (not blocked)**

T-0460 does **NOT** depend on T-0432 (engine-backed inbox redesign). Three reasons,
each verified against `dev`@632b920:

1. **The agentTask runtime never touches the userTask approve path.** T-0432's concern
   is that `inbox.ts` *approve* hard-codes status and `process-projection.ts` derives
   one waiting userTask per process. The agent dispatcher is a *separate* job-driven
   loop: bridge → `agent-step` job → dispatcher → `applyAgentOutcome` → `jobStore.complete`
   + `task_completed` outbox → `makeExternalTaskDeliver` → Flowable `completeTask`. It
   closes the engine step **through the engine** (the outbox→Flowable path), not through
   the inbox projection. The agent step closing has nothing to do with the userTask
   approve hard-code.

2. **The engine-drive concern that motivated T-0432 has been substantially superseded.**
   Since T-0432 was filed, T-0443 wired a real `FlowableClient` into the approve handler
   (resolve-by-`taskDefinitionKey` → `completeTask` → reconcile `isInstanceEnded`), and
   T-0456/T-0458/T-0459 extended the projection to concurrent tokens, timer-firing
   escalations, and message-catch parking — all reconcile-on-read from live engine state.
   The dispatcher's `proceed`/`defer` both emit `task_completed`, letting the engine route
   downstream exactly as the userTask path does.

3. **The defer→human surfacing is already live and orthogonal.** `agent.deferred` events
   project into the inbox via `deferred-inbox-store.ts` merged additively into `inbox.ts`
   — that read path does not go through the single-waiting-userTask projection T-0432
   would redesign.

**Conclusion:** the buildable agentTask runtime can be built **dormant-safe and
independently of T-0432**. The job source is the existing external-task bridge (a real
engine source), NOT the projection-only inbox. T-0432 remains a separate redesign of the
*human* approve/projection path and does not gate this work.

---

## 2. object_model

> No new tables, no new migration (D-061 / no-new-table). agentTask config rides on the
> existing BPMN process-def XML as `choros:*` moddle attributes (already declared in
> `choros-moddle-extension.js`); the runtime reads from existing tables.

```
object_model:
  - entity: AgentTaskBinding (authored, XML-resident — choros-moddle-extension.js, exists)
    fields:
      - { name: executorType,      type: "string ('agent')" }
      - { name: agentRef,          type: "string (AgentPublic.id)" }
      - { name: autonomyLevel,     type: "string (low|medium|high → threshold, optional)" }
      - { name: agentReadsFields,  type: "string (CSV of registry_def field keys)" }
      - { name: agentWritesFields, type: "string (CSV of registry_def field keys)" }
  - entity: AgentStepJobVariables (the external-task variables mapAgentTaskToExternal stamps; read by readJobVars/agent-step-context.ts, exists)
    fields:
      - { name: agentEmployeeId, type: "string (resolved from agentRef)" }
      - { name: roleId,          type: "string (the agent's role for this step)" }
      - { name: instanceId,      type: "string (Flowable process-instance id)" }
      - { name: procKey,         type: "string (process-definition key)" }
      - { name: fields,          type: "object (record-field snapshot for objective)" }
      - { name: __tenantId,      type: "string (threaded by the fetcher, exists)" }
  - entity: AgentDeferEvent (defer→human; audit_event type='agent.deferred', exists — D-061 no new table)
    fields:
      - { name: inbox_task_id, type: "uuid (== audit_event.id, self-referential)" }
      - { name: doubt_reason,  type: "string" }
      - { name: agent_draft,   type: "PrecheckAnswer | null (F5 prefilled escalation form)" }
      - { name: defer_role,    type: "string" }
```

---

## 3. contracts

```
contracts:
  - "mapAgentTaskToExternal(bpmnXml: string): string — PURE. Idempotent, additive. For each serviceTask with choros:executorType='agent': add flowable:type='external' + flowable:topic='agent-step' (configurable constant AGENT_STEP_TOPIC); leave already-external tasks and non-agent tasks unchanged; a diagram with no agent tasks returns unchanged. Mirrors mapLanesToCandidateGroups / mapTimerEscalation. Runs in the process-defs.ts publish chain BEFORE lint."
  - "Variable threading: mapAgentTaskToExternal stamps flowable:in/out (or extension fields) so the deployed external task carries agentEmployeeId (resolved from choros:agentRef), roleId, and the read/write field set — exactly the keys readJobVars/assembleAgentStepContext already read. agentRef→agentEmployeeId resolution uses the existing agent registry (AgentPublic.id → employee), NOT a new lookup table."
  - "bpmn-linter.ts coherence: an agent serviceTask (executorType='agent') MUST resolve to a known agentRef and MUST carry the agent-step external-task shape post-transform; violation type 'agent_task_incoherent' fails the publish lint (honest gate — mirrors gateway_rule_mismatch / parallel_gateway_imbalance / timer_malformed)."
  - "Bridge topic config: FLOWABLE_TOPICS (lifecycle bridge poll set) MUST include 'agent-step' so the bridge fetchAndLocks agent external tasks and enqueues them; AGENT_TOPICS (dispatcher) defaults to ['agent-step'] (exists). The two MUST agree on the topic constant AGENT_STEP_TOPIC."
  - "Dormant-safe invariant (REUSE, unchanged): with liveEnabled=false OR agent_card.llm_* NULL, runAgentStep uses dormantLlmPort → LlmDormantError → classifyOutcome → defer-to-human(signal=dormant). No crash, zero LLM spend, honest escalation. Live = config flip, no code change."
  - "No-duplication invariant: T-0460 adds ONLY the publish-transform + linter coherence + topic config + unit tests. It MUST NOT add a second dispatcher, a second motor, a second LLM port, or a new auth path. Worker-auth = T-0328 (resolveAgentSlugFromAuth) unchanged."
```

---

## fitness_functions

```
fitness_functions:
  - id: FF-R5-1
    rule: "mapAgentTaskToExternal is PURE (no pg/http/fetch/process.env/child_process), idempotent (f(f(x))==f(x)), and additive (agent serviceTask gains flowable:type='external'+flowable:topic=AGENT_STEP_TOPIC; non-agent tasks and already-external tasks unchanged; no-agent diagram returns byte-identical)."
    ci_check: "src/core/__tests__/agent-task-external-mapper.test.ts (unit, static-now) + no-env-in-core.sh covers the new core module."
  - id: FF-R5-2
    rule: "An authored agentTask, after the publish chain, produces an agent-step external task whose variables carry agentEmployeeId (resolved from choros:agentRef), roleId, instanceId, procKey, fields — the exact keys readJobVars/assembleAgentStepContext consume."
    ci_check: "src/core/__tests__/agent-task-external-mapper.test.ts asserts the stamped variable keys; src/runtime/agent-dispatch/__tests__ asserts assembleAgentStepContext reads them end-to-end on a synthetic job."
  - id: FF-R5-3
    rule: "Full weld, dormant: a synthetic agent-step job (liveEnabled=false) → assembleAgentStepContext → runAgentStep → applyAgentOutcome yields defer-to-human(signal=dormant), writes ONE agent.deferred audit event, enqueues task_completed, and completes the job — ZERO LLM call. Proven without a real LLM or deploy."
    ci_check: "src/runtime/agent-dispatch/__tests__/agent-step-weld.dormant.test.ts (in-memory jobStore/outbox/auditWriter, dormantLlmPort)."
  - id: FF-R5-4
    rule: "Full weld, live-stub proceed: with a stub-llm-port returning confidence ≥ threshold and a valid answer, the same weld yields proceed, writes a result-entity (applyStepResult) + agent.proceeded, and closes the step. Critical-role step ALWAYS defers (gate B) regardless of confidence — no LLM call."
    ci_check: "src/runtime/agent-dispatch/__tests__/agent-step-weld.live-stub.test.ts (stub-llm-port; asserts proceed result-entity AND criticality-defer)."
  - id: FF-R5-5
    rule: "Linter coherence: an agent serviceTask with an unknown/absent agentRef, or one that did not receive the agent-step external shape, fails publish lint (type='agent_task_incoherent'). A well-formed agent serviceTask passes."
    ci_check: "src/__tests__/bpmn-linter.agent-task.test.ts (positive + negative)."
  - id: FF-R5-6
    rule: "Topic agreement: FLOWABLE_TOPICS includes AGENT_STEP_TOPIC and AGENT_TOPICS defaults to [AGENT_STEP_TOPIC]; both reference the single exported constant (no string drift). The dispatcher topic must not be the tel-intake DMN seam."
    ci_check: "src/__tests__/agent-dispatch-wiring.test.ts extended (assert topic constant agreement) + grep guard that the literal 'agent-step' is sourced from AGENT_STEP_TOPIC."
  - id: FF-R5-7
    rule: "No duplication: no second agent dispatcher/motor/LLM-port/auth module is introduced; agent-dispatch-loop.ts, run-agent-step.ts, agent-precheck-motor.ts, llm-port.ts, and the T-0328 auth path remain the single sources."
    ci_check: "Review gate + existing llm-port-injectable.sh / legal-precheck-unpark-narrow.sh stay green (no new SDK import, no instruction-store import inside src/runtime/agent-dispatch/)."
  - id: FF-R5-8
    rule: "FOUNDER-GATED live proof (NOT buildable-now): agentTask живой on the deployed stack — a real authored process with an agent step, a real LLM key, runs end-to-end (proceed under threshold) or defers to a real human inbox. Requires LLM key + deploy GO."
    ci_check: "deploy-acceptance journey AC-LIVE — needs_founder; runs only on the deployed dev stack with an LLM key configured. Excluded from the buildable-now CI slice."
```

---

## traceability

```
traceability:
  - { ac: "Spec §3.6 R5: dispatcher loads grants+LLM+motor, autonomy gates self-close vs defer", covered_by: "REUSE agent-step-context.ts + run-agent-step.ts (no change); seam closed by mapAgentTaskToExternal — FF-R5-2/3/4" }
  - { ac: "Spec §6 D4: bridge job → AgentStepContext → motor → outcome decomposition", covered_by: "REUSE agent-dispatch-loop.ts + dispatch-outcome.ts (wired in main.ts); job now produced by FF-R5-1/2" }
  - { ac: "Spec §6/§9 F5: defer→human prefilled escalation form", covered_by: "REUSE planDeferTask + deferred-inbox-store.ts + inbox.ts «Эскалации» — FF-R5-3" }
  - { ac: "Spec §3.7 element-settings: agentTask configurable (agent, autonomy, fields)", covered_by: "REUSE agent-task-panel.jsx (T-0461) + choros-moddle-extension.js; runtime consequence = FF-R5-1" }
  - { ac: "Spec §3.6: worker-auth = T-0328 (do not redesign)", covered_by: "REUSE resolveAgentSlugFromAuth — FF-R5-7" }
  - { ac: "Dormant-safe + LLM-port-injected, no crash without key", covered_by: "REUSE dormantLlmPort three-lock — FF-R5-3" }
  - { ac: "Live deploy proof is founder-gated, separated cleanly", covered_by: "FF-R5-8 (needs_founder)" }
  - { ac: "INDEPENDENT of T-0432 (engine-backed inbox)", covered_by: "§1 verdict — job source is the external-task bridge, not the projection-only inbox" }
```

---

## 4. Scope, decomposition, build order

**The buildable-now slice is small** — the dispatcher, motor, port, auth, defer path,
composition-root wiring, and element-settings panel ALL exist. What's left is one pure
transform + its coherence guard + topic config + the weld tests. **Decompose into 3
sub-tasks** (the third is founder-gated and does NOT block):

1. **T-0460a — publish-transform + variable threading (the seam).** Add
   `src/core/agent-task-external-mapper.ts` (`mapAgentTaskToExternal`, PURE, mirrors
   `lane-role-mapper.ts`), export `AGENT_STEP_TOPIC` from one place, wire it into the
   `process-defs.ts` publish chain after `mapTimerEscalation` and before lint, and
   resolve `choros:agentRef → agentEmployeeId/roleId` from the existing agent registry.
   Stamp the external-task variables. Unit tests FF-R5-1/2. **Build first.**
2. **T-0460b — linter coherence + topic config + weld tests.** Extend `bpmn-linter.ts`
   with `agent_task_incoherent` (mirror the timer/parallel coherence). Ensure
   `FLOWABLE_TOPICS` includes `AGENT_STEP_TOPIC` (deploy config / `.env.example`) and the
   constant agrees with `AGENT_TOPICS`. Add the dormant + live-stub weld tests
   (FF-R5-3/4/5/6). **Build after 460a** (it lints/tests what 460a produces).
3. **T-0460c — [needs_founder] live deploy proof (AC-LIVE).** Author a process with a
   real agent step, configure an LLM key, deploy, run end-to-end. **Founder-gated; flag
   `needs_founder`; do NOT include in the buildable-now CI slice.**

Sub-tasks 460a + 460b are small enough to be a **single build task** if preferred
(one pure module + one linter clause + config + tests, ~one focused commit set). I
recommend keeping them as two for clean review boundaries, but they can collapse.

---

## 5. Snags flagged upfront (frozen-file / founder-gate)

- **No frozen-file collision.** The bpmn-linter frozen list (`bpmn-linter-isolation.sh`)
  freezes `object-handle.ts / grant-lattice.ts / types.ts / jobStore.ts` — none touched.
  `bpmn-linter.ts` itself is THAWABLE (extended by T-0436/T-0457/T-0458 coherence). The
  new `agent-task-external-mapper.ts` is a brand-new core module (additive). `process-defs.ts`
  is the live publish route, already extended by T-0457/T-0458 — additive transform-chain
  insertion, same pattern.
- **No new migration.** D-061 / no-new-table holds: config rides on existing `choros:*`
  moddle attributes; the runtime reads `agent_card`, grants, mcp_tool, audit_event — all
  existing. **No frozen-domain migration risk.**
- **Core-purity gates stay green.** The new mapper is PURE (covered by `no-env-in-core.sh`).
  `llm-port-injectable.sh` and `legal-precheck-unpark-narrow.sh` (FF-LP-4) stay green —
  this ADR adds NO SDK import and NO instruction-store import inside `src/runtime/agent-dispatch/`.
- **Worker-auth is settled (T-0328) — do not reopen.** `resolveAgentSlugFromAuth` /
  keycloak service-account is the agent identity. The dispatcher runs under the migrator
  pool with explicit `tenant_id = $N` predicates (BYPASSRLS-aware, already coded in
  `PostgresAgentJobFetcher`). No auth redesign.
- **Founder-gate: the live LLM proof only.** FF-R5-8 / T-0460c needs an LLM key + deploy
  GO. The buildable slice (460a+460b) proves the *whole weld* with `dormantLlmPort` +
  `stub-llm-port` in CI — no live key, no deploy. Marked `needs_founder` and excluded
  from the build-now CI gate so the runtime ships dormant-safe today and goes live on a
  config flip.

---

## rejected_alternatives

```
rejected_alternatives:
  - option: "Build a new agentTask poller/dispatcher that reads BPMN executorType directly from a process-instance scan (bypass the external-task bridge)."
    why_not: "Duplicates D4 (the dispatcher, fetcher, motor are built and wired in main.ts). The dispatcher INTENTIONALLY keys off the job topic, not a BPMN attribute, to avoid the tel-intake DMN seam collision (agent-dispatch-loop.ts §Topic-choice). A second source would fork the runtime and the idempotency/lock model."
  - option: "Block T-0460 on T-0432 (engine-backed inbox) first."
    why_not: "§1 verdict: the agent step closes through the engine via the outbox→Flowable completeTask path, not through the userTask approve hard-code T-0432 redesigns. The defer→human surfacing is already a live, additive audit-projection. T-0432's concern has been substantially superseded by T-0443/T-0456/T-0458/T-0459. Blocking would stall a shippable dormant-safe runtime on an unrelated redesign."
  - option: "Make the agentTask runtime live by default (configure a default LLM key in deploy)."
    why_not: "Violates BYO/PD-5 and the three-lock dormancy. Live must be a deliberate per-tenant config flip (agent_card.llm_* + liveEnabled). Day-1 dormant default = honest defer, zero spend, no surprise external calls. Live proof is founder-gated (FF-R5-8)."
  - option: "Generalise the motor / add a new LLM port for agent steps."
    why_not: "run-agent-step.ts is already the domain-neutral re-skin of run-precheck.ts and REUSES classifyOutcome + LlmPort verbatim. A new port/motor would duplicate the gate logic and break llm-port-injectable.sh / the D-139 reasoning-egress separation."
  - option: "Add a new per-element config table for agentTask settings."
    why_not: "D-061 no-new-table. agent-task-panel.jsx (T-0461) + choros-moddle-extension.js already persist config as choros:* XML attributes; the mapper reads them at publish. A side table would duplicate the authored source of truth and add a frozen-domain migration."
```

---

## escalation

None blocking the buildable slice. **One founder-gated item:** the live-deploy proof
(FF-R5-8 / T-0460c) needs an LLM key configured on the dev stack + a deploy GO — surface
it to the founder as the deploy-acceptance journey AC-LIVE after 460a/460b merge. The
buildable runtime (460a+460b) ships dormant-safe and unit-proven without it.
