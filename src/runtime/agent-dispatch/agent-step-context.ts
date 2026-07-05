/**
 * src/runtime/agent-dispatch/agent-step-context.ts — T-0378 [D4] (PD-2 dispatcher).
 *
 * Assembles ONE `AgentStepContext` from a claimed agent-topic `choros.job` row,
 * inside the caller's already-open tenant tx. This is the de-legal-precheck'd
 * sibling of run-precheck.ts's inline context reads — domain-NEUTRAL: the objective
 * replaces `documentHandle` + `dealContext`.
 *
 * PLACEMENT (FF-COMP-6 / FF-LP-4): this module does NOT import from the
 * instruction store directly. Instead, the instruction read is abstracted
 * behind the `InstructionSource` DI port (see AssembleDeps). The concrete
 * implementation (which calls the real readPublished DAO) is wired at the
 * composition root (src/server/agent-dispatch-loop.ts) — outside
 * src/runtime/agent-dispatch/ — so FF-LP-4 (legal-precheck-unpark-narrow.sh)
 * passes WITHOUT any frozen-check allowlist edit.
 *
 * Reuse map (ADR §1 / §9):
 *   - InstructionSource       — DI port for published competence instruction (composition root).
 *   - resolveInstanceTargetOnClient — record ref (registry/app/primaryRecordId).
 *   - resolveAgentToolset + McpToolSource — grants→tools (least privilege, may be []).
 *   - roleCriticality(RoleGrantSource) — gate B ceiling (critical → always defer).
 *   - agent_card (llm_* + autonomy_threshold) — BYO LLM config (PD-5) + gate A.
 *
 * The assembler does NOT decide the outcome (that is run-agent-step + classifyOutcome)
 * and does NOT call the LLM. It is pure DB-read assembly under one tx.
 */

import type { PgClientLike } from "../../db/audit-writer.js";
import type pg from "pg";
import type { Job } from "../../core/types.js";
import { resolveInstanceTargetOnClient } from "../../db/process-instance-resolver.js";
import {
  resolveAgentToolset,
  type McpToolRow,
  type McpToolSource,
} from "../../core/mcp-tool-registry.js";
import type { GrantSource } from "../../core/grant-resolver.js";
import {
  roleCriticality,
  type RoleGrantSource,
  type RoleCriticalityLevel,
} from "../../core/role-criticality.js";
import { readStepDef, compileObjective } from "./objective-compiler.js";
import { readAgentCardLlmConfigById } from "../../db/agent-provision.js";

// Re-export for callers that need the step-def types and compiler directly.
export type { BpmnStepDef, CompiledObjective } from "./objective-compiler.js";
export { readStepDef, compileObjective } from "./objective-compiler.js";

// ---------------------------------------------------------------------------
// AgentStepContext — the assembled per-job context (ADR §4).
// ---------------------------------------------------------------------------

/** Assembled from one agent-topic choros.job row, inside the tenant tx. */
export interface AgentStepContext {
  readonly tenantId: string;
  /** choros.job.id — the dedup/idempotency subject for complete/fail. */
  readonly jobId: string;
  /** Flowable external-task id (== job.idempotency_key) — the engine close key. */
  readonly externalTaskId: string;
  /** Flowable process-instance id (from job.variables correlation). */
  readonly instanceId: string;
  /** Process-definition key, e.g. "telLinear". */
  readonly procKey: string;
  /** The agent employee acting on this step (kind='agent'); the motor's subject. */
  readonly agentEmployeeId: string;
  /** The role the agent holds for this step (for criticality + toolset). */
  readonly roleId: string;

  /** OBJECTIVE — domain-neutral (replaces documentHandle + dealContext). */
  readonly objective: {
    /** Structured step intent (the binding/form fields, F1). */
    readonly fields: Record<string, unknown>;
    /**
     * Compiled neutral prompt (T-0379 F1 objective compiler).
     * Always present (non-empty string): step name + declared inputs/outputs +
     * configurator NL hint + published instruction text, folded by compileObjective.
     * The motor (run-agent-step.ts) includes this as the `document` block in the
     * neutral LlmRequest when calling the LLM.
     */
    readonly prompt: string;
    /** Published competence instruction text (from the instruction store via DI port); "" when absent. */
    readonly instruction: string;
    /** Answer-form code (from the published instruction row; "agent_step_v1" default). */
    readonly answerForm: string;
    /** Whether a published instruction was found (absent ⇒ defer, ADR §4). */
    readonly hasInstruction: boolean;
  };

  /** RECORD REF — the entity(ies) the step operates over (process references). */
  readonly recordRef: {
    readonly resolved: boolean;
    readonly registryId: string | null;
    readonly applicationId: string | null;
    readonly primaryRecordId: string | null;
    /** Visible field snapshot (from the binding/job variables, day-1). */
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

  /** AUTONOMY — gate A threshold (agent override; null ⇒ tenant default). */
  readonly autonomyThreshold: number | null;
  /** GATE B — the agent's criticality ceiling. "critical" ⇒ always defer (F3). */
  readonly criticalityLevel: RoleCriticalityLevel;
  /** GATE C — budget snapshot (day-1 stub; real meter is T-0378-F3). */
  readonly budget: { readonly exhausted: boolean };

  readonly nowMs: number;
}

// ---------------------------------------------------------------------------
// agent_card LLM config (PD-5 BYO + gate A).
//
// CUSTODY (FF-25-3): this module does NOT name the secret-handle column.
// The read is routed through the allow-listed custody DAO
// (readAgentCardLlmConfigById in src/db/agent-provision.ts), which aliases the
// handle column to the neutral OPAQUE field `secret_handle_ref`. The assembler
// only ever sees that opaque reference (and threads it onto llm.secretHandle
// for the injected LlmPort) — the raw column name lives ONLY in the allow-set,
// keeping the custody surface auditable.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Budget port — gate C is a stub day-1 (the gate is WIRED, the meter is stubbed).
// Real instance-budget enforcement is T-0378-F3 (no instance_budget table yet,
// migrations/032 notes it deferred to T-0023).
// ---------------------------------------------------------------------------

export interface BudgetPort {
  snapshot(args: {
    readonly tenantId: string;
    readonly instanceId: string;
    readonly agentEmployeeId: string;
    readonly nowMs: number;
  }): Promise<{ readonly exhausted: boolean }>;
}

/** Day-1 stub: never exhausted. T-0378-F3 replaces with the real meter. */
export const stubBudgetPort: BudgetPort = {
  async snapshot(): Promise<{ readonly exhausted: boolean }> {
    return { exhausted: false };
  },
};

// ---------------------------------------------------------------------------
// InstructionSource — DI port for published competence instruction reads.
//
// The concrete impl (calls the real readPublished DAO) is wired at the
// composition root (src/server/agent-dispatch-loop.ts) so this runtime dir
// does NOT import from the store directly (FF-LP-4 / T-0233).
// ---------------------------------------------------------------------------

/** Minimal published-instruction shape the assembler needs from the port. */
export interface PublishedInstructionResult {
  readonly instructionText: string;
  readonly answerForm: string | null;
}

export interface InstructionSource {
  /**
   * Read the published instruction for an agent. Returns null when absent
   * (missing instruction → hasInstruction=false → motor defers, ADR §4).
   */
  readPublished(
    tx: PgClientLike,
    employeeId: string,
  ): Promise<PublishedInstructionResult | null>;
}

// ---------------------------------------------------------------------------
// AssembleDeps — injected ports for static-now unit testing.
// ---------------------------------------------------------------------------

export interface AssembleDeps {
  /** Grant source for resolveAgentToolset (agent's grants → tools). */
  readonly grants: GrantSource;
  /** Tool source for resolveAgentToolset (tenant's mcp_tool set). */
  readonly tools: McpToolSource;
  /** Role grant source for roleCriticality (gate B ceiling). */
  readonly roleGrants: RoleGrantSource;
  /** Budget port (gate C); default stubBudgetPort. */
  readonly budget?: BudgetPort;
  /** Instruction source port — reads the published competence text (FF-LP-4). */
  readonly instruction: InstructionSource;
}

/**
 * The agent-topic job carries correlation variables set by the bridge enqueue.
 * The dispatcher reads the agent identity + step intent from these. Day-1 we read
 * a conservative set; missing fields degrade to safe defaults (which steer the
 * motor toward defer, never proceed).
 *
 * T-0677 (upstream fix for T-0534/T-0638): instanceId/procKey now prefer the
 * AUTHORITATIVE job.instanceId / job.processDefId columns (choros.job.instance_id
 * / process_def_id, migration 111) — captured directly from the Flowable engine's
 * ExternalTask wire shape at enqueue time (externalTaskBridge.ts), now threaded
 * through fetchAndLock/rowToJob (pgJobStore.ts, agent-dispatch-loop.ts) onto the
 * Job object. The `variables` lookup (business/process variables, best-effort
 * conventional key names) is now only a FALLBACK for legacy jobs enqueued before
 * this column existed, or jobs whose enqueue path never captured process scope.
 * Previously this function read ONLY from `variables`, which the live agent
 * dispatch path never populates with an `instanceId`/`processInstanceId` key
 * (those are Flowable engine metadata, not BPMN business variables) — so every
 * fresh agentTask job produced instanceId="" here, making T-0638's defer-resolve
 * fix inert (empty payload.instance_id → deferred-inbox-store.ts's null-coalesce
 * → 404 DEFER_NOT_ROUTABLE).
 */
function readJobVars(job: Job): {
  instanceId: string;
  procKey: string;
  agentEmployeeId: string;
  roleId: string;
  externalTaskId: string;
  fields: Record<string, unknown>;
} {
  const v = job.variables ?? {};
  const str = (k: string): string =>
    typeof v[k] === "string" ? (v[k] as string) : "";
  // externalTaskId == job idempotency key (bridge sets it). When the variable is
  // absent we leave it "" — the close path uses the job id as the aggregate id and
  // the engine maps NOT_FOUND → idempotent success, so a missing ext-task id is safe.
  return {
    instanceId:
      (typeof job.instanceId === "string" && job.instanceId.trim() !== ""
        ? job.instanceId.trim()
        : "") ||
      str("instanceId") ||
      str("processInstanceId") ||
      str("inst"),
    procKey:
      (typeof job.processDefId === "string" && job.processDefId.trim() !== ""
        ? job.processDefId.trim()
        : "") ||
      str("procKey") ||
      str("processKey") ||
      str("proc_key"),
    agentEmployeeId:
      str("agentEmployeeId") || str("agent_employee_id") || str("executorId"),
    roleId: str("roleId") || str("role_id"),
    externalTaskId: str("externalTaskId") || str("external_task_id"),
    fields:
      typeof v["fields"] === "object" && v["fields"] !== null
        ? (v["fields"] as Record<string, unknown>)
        : {},
  };
}

// ---------------------------------------------------------------------------
// assembleAgentStepContext — turn one job row into an AgentStepContext.
// ---------------------------------------------------------------------------

/**
 * Assemble the context for a claimed agent-topic job. Runs on the caller's open
 * tenant-scoped tx (RLS active). Pure DB-read assembly — no LLM call, no outcome
 * decision, no write. Missing reads degrade conservatively (empty instruction →
 * hasInstruction=false → the motor defers; unresolved record ref → resolved=false).
 *
 * @param client  caller's open pg client (tenant GUC set; UUID validated upstream).
 * @param job     the claimed choros.job row (from fetchAndLock).
 * @param deps    injected ports (grants/tools/roleGrants/budget).
 * @param nowMs   server clock for criticality + budget windows.
 */
export async function assembleAgentStepContext(
  client: pg.PoolClient,
  job: Job,
  deps: AssembleDeps,
  nowMs: number,
): Promise<AgentStepContext> {
  const tx = client as unknown as PgClientLike;
  const tenantId = currentTenantId(job);
  const v = readJobVars(job);
  const budget = deps.budget ?? stubBudgetPort;

  // --- Objective: published competence text (via InstructionSource DI port). ---
  const instr =
    v.agentEmployeeId !== "" ? await deps.instruction.readPublished(tx, v.agentEmployeeId) : null;

  // --- F1 Objective compiler: structured step def + NL instruction → compiled prompt. ---
  // readStepDef extracts the BPMN step definition from job.variables (step name, declared
  // inputs/outputs, configurator NL hint, field values). compileObjective folds these +
  // the published instruction text into a single neutral prompt string (T-0379).
  const stepDef = readStepDef(job.variables ?? {}, job.topic, v.procKey);
  const compiledObj = compileObjective(stepDef, instr);

  // --- Record ref: resolve the instance's target registry/app/primary record. ---
  const target =
    v.instanceId !== ""
      ? await resolveInstanceTargetOnClient(client, tenantId, v.instanceId)
      : ({ kind: "unresolved", reason: "invalid_input", detail: "no instanceId" } as const);

  const procKey =
    v.procKey !== ""
      ? v.procKey
      : target.kind === "resolved"
        ? target.processKey
        : "";

  // --- Tools: grants→MCP tools (least privilege; 0 grants → 0 tools). ---
  const tools =
    v.agentEmployeeId !== ""
      ? await resolveAgentToolset(
          { tenantId, employeeId: v.agentEmployeeId, nowMs },
          { grants: deps.grants, tools: deps.tools },
        )
      : [];

  // --- LLM config + autonomy (gate A) from agent_card. ---
  const card =
    v.agentEmployeeId !== ""
      ? await readAgentCardLlmConfigById(tx, tenantId, v.agentEmployeeId)
      : null;

  // --- Gate B: criticality ceiling for the agent's role. ---
  // When the role is unknown we leave criticality "routine" (the role has no grants
  // → not critical). roleCriticality on an empty role yields "routine".
  const criticality =
    v.roleId !== ""
      ? await roleCriticality(deps.roleGrants, tenantId, v.roleId, nowMs)
      : { approve_or_transition: false, external_invoke: false, sensitive_read: false, level: "routine" as RoleCriticalityLevel };

  // --- Gate C: budget snapshot (day-1 stub). ---
  const budgetSnapshot = await budget.snapshot({
    tenantId,
    instanceId: v.instanceId,
    agentEmployeeId: v.agentEmployeeId,
    nowMs,
  });

  return {
    tenantId,
    jobId: job.id,
    externalTaskId: v.externalTaskId,
    instanceId: v.instanceId,
    procKey,
    agentEmployeeId: v.agentEmployeeId,
    roleId: v.roleId,
    objective: {
      fields: v.fields,
      // F1 compiler output: compiled neutral prompt (step name + inputs + NL hint +
      // instruction text folded into a single LLM-ready string, T-0379).
      prompt: compiledObj.prompt,
      instruction: instr?.instructionText ?? "",
      // answerForm from the compiled objective (sourced from published instruction
      // or "agent_step_v1" default — same semantics as before, threaded via compiler).
      answerForm: compiledObj.answerForm,
      hasInstruction: instr != null,
    },
    recordRef: {
      resolved: target.kind === "resolved",
      registryId: target.kind === "resolved" ? target.registryId : null,
      applicationId: target.kind === "resolved" ? target.applicationId : null,
      primaryRecordId:
        target.kind === "resolved" ? (target.primaryRecordId ?? null) : null,
      snapshot: v.fields,
    },
    tools,
    llm: {
      endpoint: card?.llm_endpoint ?? null,
      model: card?.llm_model ?? null,
      // Opaque RL-3 reference (aliased from the handle column by the custody DAO);
      // null ⇒ dormant. Never logged/audited — threaded only to the injected LlmPort.
      secretHandle: card?.secret_handle_ref ?? null,
    },
    autonomyThreshold: card?.autonomy_threshold ?? null,
    criticalityLevel: criticality.level,
    budget: budgetSnapshot,
    nowMs,
  };
}

/**
 * The tenant id for a job. The dispatcher loop sets the GUC from the bridge-discovered
 * tenant (the job row's tenant_id), and threads it onto the job variables under
 * `__tenantId` so the assembler does not need a second DB read. Falls back to a
 * variable lookup for robustness.
 */
function currentTenantId(job: Job): string {
  const v = job.variables ?? {};
  const t = v["__tenantId"] ?? v["tenantId"] ?? v["tenant_id"];
  if (typeof t === "string" && t.length > 0) return t;
  throw new Error(
    `assembleAgentStepContext: job ${job.id} has no __tenantId in variables — ` +
      `the dispatch loop must thread the tenant onto job.variables before assembly`,
  );
}
