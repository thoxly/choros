/**
 * src/http/process-start.ts
 *
 * T-0280 (ADR T-0278 §B) — start-instance write-path for process instances.
 *
 * Owns the FROZEN contract (ADR §2.2 — seam B↔C↔E):
 *   POST /api/processes/start
 *   Headers: x-dev-user (actor), x-tenant-id (tenant scope)
 *   Body:    { processKey: string, variables?: Record<string, unknown> }
 *   201 { instanceId, processKey, tenantId }
 *   400 VALIDATION       — processKey empty / body not object / tenantId not UUID
 *   401 UNAUTHENTICATED  — no x-dev-user
 *   403 NOT_ELIGIBLE     — actor not entitled to start a process in this tenant (PDP)
 *   503 ENGINE_UNAVAILABLE — engine unreachable/slow (T-0483; transient, retry)
 *   502 UNKNOWN          — other engine failure (typed via flowableErrorToHttp)
 *
 * Why this is its OWN module (not inline in processes.ts):
 *   FF-DISPLAY-4 (ci/checks/demo/pack-serve-no-write.sh) forbids src/http/processes.ts
 *   from importing `pg` or `src/db/*` — it is the read-only display plane. The start
 *   write-path REQUIRES the withTenantTx + RLS pattern (which needs pg). ADR §3
 *   explicitly sanctions extracting the engine-write seam into a dedicated module so
 *   processes.ts stays display-plane-pure while the route is still registered through
 *   registerProcessesRoutes. The FROZEN seam is the REST shape, not the file layout.
 *
 * Tenant-scoping (AC-9 / NF4 — the Враг target):
 *   The actor's REAL tenant is resolved from the dev-user slug (resolveActorTenant).
 *   A cross-tenant start — x-tenant-id naming a tenant the actor does NOT belong to —
 *   is rejected with 403 NOT_ELIGIBLE BEFORE the engine is touched: no instance is
 *   created in a foreign tenant. The engine call then runs inside withTenantTx under
 *   SET LOCAL choros.tenant_id (FORCE RLS), exactly as process-defs.ts, so any
 *   tenant-bound projection write (task D's §2.3 seam) is scoped to the actor tenant.
 *
 * FlowableClient + pool are injected from the composition root (src/server.ts);
 * NO env reads here (NF-1, no-env-in-core / FF). The actor→tenant resolver is also
 * injected so the unit suite can exercise the route without a live Postgres.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { HttpError, readJsonBody, type RouteHandler } from "./router.js";
import { DEV_USER_HEADER } from "./auth.js";
import { flowableErrorToHttp, type FlowableClient, type ActiveUserTask } from "../core/flowable-client.js";
import { appendProcessStarted } from "./process-projection.js";
import type { PgClientLike } from "../db/audit-writer.js";
import { preComputeGatewayVariable } from "../core/dmn-gateway.js";
import { decideDraftVisibility } from "../core/sandbox-gate.js";
import { resolveActorPrivilege, type ActorPrivilege } from "../db/sandbox-gate-dao.js";
// T-0636 (F5): stamp the owning tenant onto the process instance as a launch
// variable so the external-task bridge can resolve tenancy for a bare Flowable
// ExternalTask BEFORE it is written to choros.job (see externalTaskBridge.ts
// doc-comment on CHOROS_TENANT_VAR for the full rationale).
import { CHOROS_TENANT_VAR } from "../core/externalTaskBridge.js";

// ---------------------------------------------------------------------------
// UUID guard — same shape as process-defs.ts withTenantTx
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Header extraction — mirrors process-defs.ts dosly
// ---------------------------------------------------------------------------

function extractActor(req: IncomingMessage): string {
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

function extractTenantId(req: IncomingMessage): string {
  let tenantId = req.headers["x-tenant-id"];
  if (Array.isArray(tenantId)) tenantId = tenantId[0];
  if (!tenantId || typeof tenantId !== "string") {
    throw new HttpError(400, "VALIDATION", "missing x-tenant-id header");
  }
  return tenantId;
}

// ---------------------------------------------------------------------------
// withTenantTx — same RLS pattern as process-defs.ts (FORCE RLS via SET LOCAL).
// The engine call runs INSIDE this transaction so the start (and any tenant-bound
// projection write added by task D's §2.3 seam) is scoped to the actor's tenant.
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new HttpError(400, "VALIDATION", "tenantId must be a valid UUID");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Injected deps
// ---------------------------------------------------------------------------

/**
 * Resolve the tenant the actor (dev-user slug) actually belongs to.
 * Production binding = resolveActorTenant(getOrgPool(), slug) from src/db/org.ts;
 * injected so the unit suite can stub the membership check without a live DB.
 */
export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

/**
 * T-0558 (sandbox gate): resolve the caller's sandbox-gate privilege. Production
 * binding = resolveActorPrivilege(pool, tenantId, actorSlug) from
 * src/db/sandbox-gate-dao.ts (tenant-scoped, fail-closed). OPTIONAL on
 * StartInstanceDeps — when absent the handler falls back to the REAL
 * resolveActorPrivilege against `pool`; injected only so the unit suite can exercise
 * the privileged-dry-run vs. unprivileged-refuse branches without a live DB.
 */
export type ActorPrivilegeResolver = (
  actorSlug: string,
  tenantId: string,
  nowMs: number,
) => Promise<ActorPrivilege>;

export interface StartInstanceDeps {
  pool: pg.Pool;
  flowable: FlowableClient;
  resolveActorTenant: ActorTenantResolver;
  /**
   * T-0558 (sandbox gate): OPTIONAL privilege resolver (see {@link ActorPrivilegeResolver}).
   * When absent, the start handler uses the REAL resolveActorPrivilege against `pool`.
   */
  resolveSandboxPrivilege?: ActorPrivilegeResolver;
  /**
   * T-0558 (sandbox gate): OPTIONAL sandbox-state resolver for a process key. Returns
   * the process definition's published-state and the tier of the bound application(s),
   * tenant-scoped. When absent, the handler runs the REAL DB lookup against `pool`.
   * Injected so unit tests can drive the refuse / allow branches without a live DB.
   */
  resolveProcessSandboxState?: ProcessSandboxStateResolver;
}

/**
 * T-0558: the sandbox-relevant state of a process key, used to decide whether a start
 * may proceed for a non-privileged caller.
 *
 * @property hasDefinitionRow   true iff at least one process_definition row exists for
 *                              the key in this tenant. When false the key is a legacy /
 *                              directly-deployed engine process with no authored
 *                              definition — the definition-published gate does not apply.
 * @property definitionPublished true iff a PUBLISHED process_definition row exists for
 *                              the key. Only meaningful when hasDefinitionRow is true.
 * @property boundAppDraft       true iff the process is bound (process_app_binding) to at
 *                              least one application that is still in the DRAFT tier.
 */
export interface ProcessSandboxState {
  hasDefinitionRow: boolean;
  definitionPublished: boolean;
  boundAppDraft: boolean;
}

export type ProcessSandboxStateResolver = (
  tenantId: string,
  processKey: string,
) => Promise<ProcessSandboxState>;

/**
 * Resolve the sandbox state of `processKey` in `tenantId` against the live DB.
 *
 * Tenant-scoped: opens its OWN short tenant-scoped RLS tx (SET LOCAL choros.tenant_id +
 * explicit WHERE guard) — it never broadens the tenant scope. Read-only; commits/rolls
 * back cleanly. This runs BEFORE the engine is touched so a refused start creates no
 * instance.
 */
export async function resolveProcessSandboxStateDb(
  pool: pg.Pool,
  tenantId: string,
  processKey: string,
): Promise<ProcessSandboxState> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");

    const defRes = await client.query<{ has_row: boolean; has_published: boolean }>(
      `SELECT
         count(*) > 0                       AS has_row,
         bool_or(status = 'published')      AS has_published
       FROM choros.process_definition
       WHERE tenant_id = $1 AND process_key = $2`,
      [tenantId, processKey],
    );

    // Is the process bound to any application still in the DRAFT tier?
    const appRes = await client.query<{ draft_bound: boolean }>(
      `SELECT bool_or(a.tier = 'draft') AS draft_bound
         FROM choros.process_app_binding b
         JOIN choros.application a
           ON a.tenant_id = b.tenant_id AND a.id = b.application_id
        WHERE b.tenant_id = $1 AND b.process_key = $2`,
      [tenantId, processKey],
    );

    await client.query("COMMIT");

    const defRow = defRes.rows[0];
    const appRow = appRes.rows[0];
    return {
      hasDefinitionRow: defRow?.has_row === true,
      definitionPublished: defRow?.has_published === true,
      boundAppDraft: appRow?.draft_bound === true,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Handler factory — the POST /api/processes/start handler.
// ---------------------------------------------------------------------------

export function makeStartInstanceHandler(deps: StartInstanceDeps): RouteHandler {
  const { pool, flowable, resolveActorTenant, resolveSandboxPrivilege, resolveProcessSandboxState } = deps;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 1. Auth gate (401)
    const actor = extractActor(req);

    // 2. Tenant scope header (400 if absent)
    const tenantId = extractTenantId(req);

    // 3. Body validation (400)
    const rawBody = await readJsonBody(req);
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;

    const processKey = body["processKey"];
    if (typeof processKey !== "string" || !processKey.trim()) {
      throw new HttpError(400, "VALIDATION", "processKey must be a non-empty string");
    }

    let variables: Record<string, unknown> | undefined;
    const rawVars = body["variables"];
    if (rawVars !== undefined) {
      if (rawVars === null || typeof rawVars !== "object" || Array.isArray(rawVars)) {
        throw new HttpError(400, "VALIDATION", "variables must be an object when present");
      }
      variables = rawVars as Record<string, unknown>;
    }

    // 4. Tenant-scoping authorization (AC-9 / NF4 — the Враг target).
    //    The actor may only start a process in the tenant they belong to. A
    //    cross-tenant x-tenant-id is rejected BEFORE the engine is touched, so no
    //    instance is created in a foreign tenant.
    const actorTenant = await resolveActorTenant(actor);
    if (actorTenant !== tenantId) {
      throw new HttpError(
        403,
        "NOT_ELIGIBLE",
        "actor is not entitled to start a process in this tenant",
      );
    }

    // 4b. SANDBOX GATE (T-0558): refuse — BEFORE the engine is touched — to start a
    //     process whose authored definition is NOT published, OR that is bound to an
    //     application still in the DRAFT (sandbox) tier. A PRIVILEGED caller (owner /
    //     admin / authoring_draft grant) is EXEMPT: they may dry-run a sandbox process.
    //     The privilege + sandbox-state lookups are tenant-scoped + fail-closed; an
    //     UNPRIVILEGED caller who would be refused gets a clear 409 SANDBOX_NOT_RUNNABLE
    //     and no instance is created. Legacy/directly-deployed processes (no
    //     process_definition row) are NOT blocked by the definition-published check —
    //     only the bound-draft-application check applies to them.
    const sandboxState = resolveProcessSandboxState
      ? await resolveProcessSandboxState(tenantId, processKey)
      : await resolveProcessSandboxStateDb(pool, tenantId, processKey);

    const definitionIsDraft =
      sandboxState.hasDefinitionRow && !sandboxState.definitionPublished;
    const wouldRunSandbox = definitionIsDraft || sandboxState.boundAppDraft;

    if (wouldRunSandbox) {
      const priv: ActorPrivilege = resolveSandboxPrivilege
        ? await resolveSandboxPrivilege(actor, tenantId, Date.now())
        : await resolveActorPrivilege(pool, tenantId, actor, Date.now());
      // decideDraftVisibility codifies the privileged-sees-draft rule (fail-closed):
      // artifactTier "draft" → visible ONLY to owner/admin OR authoring_draft holder.
      const decision = decideDraftVisibility({ artifactTier: "draft", actor: priv });
      if (!decision.visible) {
        const reason = definitionIsDraft
          ? "process definition is not published (still in sandbox)"
          : "the bound application is still in sandbox (draft)";
        throw new HttpError(
          409,
          "SANDBOX_NOT_RUNNABLE",
          `cannot start a sandbox process: ${reason}`,
        );
      }
    }

    // 5. Engine call inside the tenant-scoped transaction (RLS via SET LOCAL).
    //    withTenantTx validates the UUID shape (→ 400) before opening the tx.
    //
    //    T-0282 (ADR §2.3 — seam B↔D, owned by D): the start CONSCIOUSLY did not
    //    emit a projection event in B; D dotyaguet that emission here. After a
    //    successful engine start, append the `process.started` audit_event in the
    //    SAME tenant-scoped tx (so the projection write is atomic with the start and
    //    RLS-isolated). This makes the instance visible on the same processes/inbox
    //    screens (audit_event-backed projection, NOT a live-Flowable query). The
    //    FROZEN REST response shape (§2.2) is unchanged — only a projection write is
    //    added. The append is best-effort within the tx: an engine start with no
    //    projection write is still a real instance, so a projection failure must NOT
    //    turn a created instance into a 502 — it degrades to "started but unprojected"
    //    rather than rolling back the (already engine-side) start.
    const startResult = await withTenantTx(pool, tenantId, async (client) => {
      // T-0439: pre-compute DMN gateway routing variable at launch.
      // Evaluates the published rule table (if any) for this process and injects
      // the routing variable + version pins into the startInstance variables map
      // so the exclusiveGateway in authored processes can route at start time.
      // Degrades gracefully: no published rule table → no injection, no throw.
      //
      // SAVEPOINT isolation: preComputeGatewayVariable writes an audit event
      // (emitGatewayEvaluated → appendAuditEvent) on this same client.  A DB
      // error inside that INSERT would leave the outer tx in an aborted state
      // (25P02) even though the JS catch swallows the JS error, causing every
      // subsequent query to fail.  Wrapping in a SAVEPOINT ensures that on any
      // DB error the tx is rolled back only to the savepoint — the outer tx
      // remains clean and launch proceeds with the original variables.
      // Same idiom as proc_proj SAVEPOINT in records.ts.
      let launchVariables = variables;
      await client.query('SAVEPOINT dmn_precompute');
      try {
        const dmnResult = await preComputeGatewayVariable(client, {
          tenantId,
          instanceId: `launch-${processKey}-${Date.now()}`, // synthetic id for audit event
          processKey,
          procDefId: processKey,
          actor,
          nowMs: Date.now(),
          bindings: variables ?? {},
          gatewayId: `gw-${processKey}`, // generic gateway id for audit event
        });
        if (dmnResult.gatewayVar !== null) {
          launchVariables = {
            ...(variables ?? {}),
            [dmnResult.gatewayVar.name]: dmnResult.gatewayVar.value,
            ...dmnResult.versionVars,
          };
        } else if (Object.keys(dmnResult.versionVars).length > 0) {
          launchVariables = { ...(variables ?? {}), ...dmnResult.versionVars };
        }
        await client.query('RELEASE SAVEPOINT dmn_precompute');
      } catch (dmnErr) {
        // Non-fatal: a DMN evaluation failure must NOT block the process launch.
        // Roll back to the savepoint so the tx is clean, then proceed with
        // the original variables (gateway falls through to default flow).
        await client.query('ROLLBACK TO SAVEPOINT dmn_precompute');
        console.warn(
          `[process-start dmn-precompute] non-fatal DMN pre-compute error for process ` +
            `${processKey}:`,
          dmnErr,
        );
      }

      // T-0636 (F5): stamp choros_tenantId onto the launch variables — tenantId is
      // already in scope (withTenantTx argument). This is a plain string value,
      // trivially passes assertVariableValue's guard (string → ok) on both the
      // outgoing startInstance guard and the bridge's incoming read.
      const stampedLaunchVariables = { ...(launchVariables ?? {}), [CHOROS_TENANT_VAR]: tenantId };

      const result = await flowable.startInstance(processKey, stampedLaunchVariables);
      if (result.ok) {
        // T-0575 [W1/деТЭЛ] BUG-015: resolve the REAL waiting user-task's
        // candidateGroups[0]/name from the live engine BEFORE the projection
        // write, so the base process.started task carries this process's OWN
        // role/label instead of the process-agnostic ТЭЛ constant. Best-effort:
        // an engine read failure degrades to the named config-primitive fallback
        // (resolveDefaultApproverRole/Step/TaskName) — never blocks the start.
        // The full task list is kept (not just the first) so the task-submit
        // auto-complete lookup below preserves its original `.find()` semantics
        // (single getActiveUserTasks round-trip, reused for both purposes).
        let activeTasks: readonly ActiveUserTask[] = [];
        try {
          const tasksResult = await flowable.getActiveUserTasks(result.instanceId);
          if (tasksResult.ok) {
            activeTasks = tasksResult.tasks;
          } else {
            console.warn(
              `[process-start T-0443] getActiveUserTasks failed for instance ` +
                `${result.instanceId}: ${tasksResult.code} (non-fatal)`,
            );
          }
        } catch {
          // Best-effort: engine read failure → fall back to config-primitive defaults.
        }
        const firstActiveTask = activeTasks[0];

        try {
          await appendProcessStarted(client as unknown as PgClientLike, {
            instanceId: result.instanceId,
            procKey: processKey,
            actor,
            nowMs: Date.now(),
            // T-0339 (E15-S3): supply tenantId so instance.started + task.created
            // transition-journal events are emitted (F2 Phase 1).
            tenantId,
            // T-0575 BUG-015: real candidateGroups[0]/name when the engine yielded
            // an active user-task with non-empty values; appendProcessStarted's own
            // ?? fallback applies when these are undefined/empty.
            ...(firstActiveTask !== undefined && firstActiveTask.candidateGroups.length > 0
              ? { approverRole: firstActiveTask.candidateGroups[0] }
              : {}),
            ...(firstActiveTask !== undefined && firstActiveTask.name !== ""
              ? { step: firstActiveTask.name, taskName: firstActiveTask.name }
              : {}),
          });
        } catch {
          // Projection is additive; never fail the start on a projection write error.
        }

        // T-0443: explicit-start → drive task-submit user task so the instance
        // advances past the submit gate without waiting for a second human action.
        // Best-effort only: NEVER roll back the already-started instance on failure.
        // The 201 response shape is FROZEN (ADR §2.2) — this is purely engine-internal.
        try {
          const submitTask = activeTasks.find(
            (t) => t.taskDefinitionKey === "task-submit",
          );
          if (submitTask) {
            const completeResult = await flowable.completeUserTask(submitTask.id);
            if (!completeResult.ok) {
              console.warn(
                `[process-start T-0443] task-submit auto-complete failed for instance ` +
                  `${result.instanceId}: ${completeResult.code} (non-fatal, instance still started)`,
              );
            }
          }
        } catch (submitErr) {
          console.warn(
            `[process-start T-0443] task-submit drive error for instance ` +
              `${result.instanceId} (non-fatal):`,
            submitErr,
          );
        }
      }
      return result;
    });

    if (!startResult.ok) {
      // T-0483: typed engine error (ENGINE_UNAVAILABLE → 503 + honest message)
      // instead of an opaque "502 startInstance failed: ...".
      const { status, code, message } = flowableErrorToHttp(startResult.code);
      throw new HttpError(status, code, message);
    }

    // 6. 201 with the FROZEN response shape.
    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        instanceId: startResult.instanceId,
        processKey,
        tenantId,
      }),
    );
  };
}
