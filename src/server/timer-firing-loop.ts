/**
 * src/server/timer-firing-loop.ts — T-0535 [ENGINE-CORE]: background timer-firing worker.
 *
 * THE PROBLEM (audit). Step deadlines/timers only ever FIRED on-read: T-0458 wired
 * `reconcileInstanceTimers` into the inbox GET handler, so a fired boundary/intermediate
 * timer (→ escalation user-task) was only projected the moment SOMEONE opened the inbox.
 * A deadline like «3 дня → эскалация руководителю» would therefore never surface on its
 * own — it needed a reader to walk past. This loop is the missing background DRIVER: it
 * ticks on a timer and fires due timers for ANY active instance of ANY process, with no
 * human in the loop and no per-case (ТЭЛ) hardcode.
 *
 * THE REUSE. The firing + escalation logic is NOT re-implemented here. `reconcileInstance
 * Timers` (process-projection.ts, T-0458) already does the whole job, generically and
 * idempotently: it reads each non-done instance's LIVE engine user-task set, and for any
 * task the projection has not yet surfaced (a timer routed the token to it) it appends a
 * `process.next_task(escalated, via:"timer-fire")` row addressed to the escalation role
 * (the candidateGroups the timer-escalation mapper stamped). Idempotency is carried by the
 * projection fold itself (dedup by taskDefKey per instance) — a second tick re-running the
 * SAME reconcile emits NOTHING new. This loop's only job is to DRIVE that reconcile across
 * every tenant on a schedule, instead of waiting for a reader.
 *
 * THE PATTERN (mirror of agent-dispatch-loop.ts, T-0378). Per pass:
 *   discover tenants with non-done instances → for each tenant open a tenant-scoped tx →
 *   call reconcileInstanceTimers under that tenant's GUC → COMMIT.
 * Degraded-safe (NF-5): no engine / no DB → no-op handle (server starts, no loop, no throw).
 * Wired in main.ts ALONGSIDE the lifecycle bridge + agent dispatch loop — NEVER inside
 * createServer (so test imports of the server never start a loop).
 *
 * GENERIC. Nothing here mentions ТЭЛ or any process key. Tenant discovery is by «has a
 * non-done instance», firing is whatever the engine says is now active, escalation role is
 * whatever the element's mapper stamped. Any process a user configures a timer on fires.
 *
 * RESILIENCE (GV-5 rotation). One tenant's engine/DB hiccup is swallowed and the loop moves
 * on to the next tenant; one bad PASS is swallowed and the loop survives to the next tick.
 *
 * HONEST SCOPE. The UNIT-testable behaviour is the loop + reconcile (tenant rotation, clock,
 * idempotency, generic firing) against a mock engine + in-memory store. The REAL boundary-
 * timer scheduling/firing inside a live Flowable is server-gated (Flowable must actually
 * advance the token when PT24H elapses) — that is exercised on the deployed stack, not here.
 */

import type pg from "pg";
import {
  reconcileInstanceTimers,
  type TimerReconcileEnginePort,
} from "../http/process-projection.js";
import { makeFlowableClient } from "../core/flowable-client.js";
// T-0636 (F9/F10): reuse the SAME throttled-log primitive the external-task
// bridge uses (single implementation, not a re-invented one) for the top-level
// per-pass catch below.
import { makeErrorLogThrottle, type ErrorLogThrottle } from "../core/externalTaskBridge.js";

/** Handle returned by startTimerFiringLoop; stop() is idempotent. */
export interface TimerFiringHandle {
  stop: () => void;
}

/**
 * Discover the tenants that currently have at least one NON-DONE (running/waiting)
 * instance — the only tenants whose timers can fire this pass. Mirrors the Phase-1
 * cross-tenant discovery of PostgresAgentJobFetcher: a plain query on the BYPASSRLS
 * pool that intentionally sees all tenants, returning ONLY DISTINCT tenant_id (no row
 * data escapes). The per-tenant reconcile (Phase-2) re-scopes under the tenant GUC.
 */
export interface TimerTenantSource {
  /** Tenant ids that have ≥1 non-done instance (firing candidates this pass). */
  listTenantsWithActiveInstances(nowMs: number): Promise<readonly string[]>;
}

/** Run a callback inside an open tenant-scoped tx (BEGIN + SET LOCAL GUC + COMMIT). */
export type WithTenantTx = <T>(
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
) => Promise<T>;

export interface TimerFiringDeps {
  /** Cross-tenant discovery of firing-candidate tenants. */
  readonly tenantSource: TimerTenantSource;
  /**
   * Pool used to read/append the projection during reconcile. reconcileInstanceTimers
   * runs its own GUC-scoped reads/appends via this pool per tenant — it takes the pool
   * + tenantId explicitly (the same shape the on-read call-site in inbox.ts uses), so a
   * separate withTenantTx wrapper is not required here; the tenantId argument is the
   * authoritative scope (mirrors every projection DAO).
   */
  readonly pool: pg.Pool;
  /** Live engine port (getActiveUserTasks) — a FlowableClient in production, mock in tests. */
  readonly engine: TimerReconcileEnginePort;
  /** Actor stamped on emitted escalation rows. Default "system:timer". */
  readonly actor?: string;
  /** Max instances reconciled per tenant per pass (projection read limit). */
  readonly maxInstancesPerTenant?: number;
  /** Server clock (injectable for tests). Default Date.now. */
  readonly now?: () => number;
}

/** A no-op handle (degraded / no engine / no DB). */
function noopHandle(): TimerFiringHandle {
  let stopped = false;
  return {
    stop: () => {
      stopped = true;
      void stopped;
    },
  };
}

/**
 * Process ONE firing pass: discover firing-candidate tenants, then for each tenant run
 * the generic timer reconcile (firing + escalation projection) under that tenant's scope.
 *
 * Per-tenant errors are swallowed (logged) so one bad tenant does not stall the pass
 * (GV-5 rotation). Idempotency is inherited from reconcileInstanceTimers (dedup by
 * taskDefKey in the projection fold) — re-running this pass emits no duplicate escalation.
 *
 * @returns a summary: tenants scanned, escalation rows emitted, tenants errored.
 */
export async function runTimerFiringOnce(
  deps: TimerFiringDeps,
): Promise<{ tenants: number; emitted: number; errored: number }> {
  const now = deps.now ?? Date.now;
  const actor = deps.actor ?? "system:timer";
  const nowMs = now();

  const summary = { tenants: 0, emitted: 0, errored: 0 };

  let tenantIds: readonly string[];
  try {
    tenantIds = await deps.tenantSource.listTenantsWithActiveInstances(nowMs);
  } catch (err) {
    // Discovery failed — this whole pass is a no-op; the loop survives to the next tick.
    console.warn(`[timer-firing] tenant discovery failed (non-fatal): ${String(err)}`);
    return summary;
  }

  for (const tenantId of tenantIds) {
    summary.tenants += 1;
    try {
      const emitted = await reconcileInstanceTimers(deps.pool, tenantId, deps.engine, {
        nowMs,
        actor,
        ...(deps.maxInstancesPerTenant !== undefined ? { limit: deps.maxInstancesPerTenant } : {}),
      });
      summary.emitted += emitted;
    } catch (err) {
      // Per-tenant hiccup — swallow and rotate to the next tenant (GV-5).
      summary.errored += 1;
      console.error(`[timer-firing] tenant ${tenantId} reconcile failed: ${String(err)}`);
    }
  }

  return summary;
}

/**
 * T-0636 (F9): module-level default throttle for startTimerFiringLoop's top-level
 * per-pass catch (shared across the loop's lifetime, one throttle instance per
 * process — mirrors externalTaskBridge's defaultRunBridgeOnceLogThrottle).
 */
const defaultTimerFiringLogThrottle = makeErrorLogThrottle((msg) => console.error(msg));

/**
 * Start the timer-firing poll loop. Degraded no-op when no engine is configured.
 * First pass fires after one interval (server start stays non-blocking). stop() clears
 * the interval. Per-pass errors are now VISIBLE (T-0636 F9: throttled console.error) —
 * the loop still never throws out of the interval callback (NF-5: stays alive).
 */
export function startTimerFiringLoop(
  deps: TimerFiringDeps | undefined,
  opts: {
    readonly intervalMs?: number;
    readonly setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    /** T-0636 (F9/F10): injectable log throttle (defaults to a shared instance). */
    readonly logThrottle?: ErrorLogThrottle;
  } = {},
): TimerFiringHandle {
  if (deps === undefined) {
    return noopHandle();
  }
  const intervalMs = opts.intervalMs ?? 30_000;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const logThrottle = opts.logThrottle ?? defaultTimerFiringLogThrottle;

  const handle = setIntervalFn(() => {
    runTimerFiringOnce(deps).catch((err: unknown) => {
      // T-0636 (F9): a whole-pass failure is now visible (throttled) — never a
      // silent swallow. The loop still does not throw out of this callback.
      logThrottle("TIMER_PASS_FAILED", String(err));
    });
  }, intervalMs);

  return { stop: () => clearInterval(handle) };
}

// ---------------------------------------------------------------------------
// Production wiring — PostgresTimerTenantSource + buildTimerFiringDeps
// ---------------------------------------------------------------------------

/**
 * Production `TimerTenantSource`: discover tenants with ≥1 non-done instance.
 *
 * Mirrors PostgresAgentJobFetcher Phase-1 exactly. A non-done instance is a
 * `process.started` audit_event whose instance has NOT recorded a matching
 * `instance.ended` event. The discovery query is a plain query on the BYPASSRLS
 * migrator pool that intentionally sees ALL tenants — its safety is that it SELECTs
 * ONLY DISTINCT tenant_id (no instance id, payload, or other row data escapes). The
 * cross-tenant tenant list is precisely what drives the per-tenant reconcile.
 *
 * The per-tenant firing scope is re-established inside reconcileInstanceTimers, which
 * reads/appends via listInstanceProjections / appendNextTaskEvent — those take the
 * tenantId explicitly (the authoritative scope under BYPASSRLS, mirroring every DAO).
 */
export class PostgresTimerTenantSource implements TimerTenantSource {
  constructor(private readonly pool: pg.Pool) {}

  async listTenantsWithActiveInstances(_nowMs: number): Promise<readonly string[]> {
    void _nowMs;
    // A tenant is a firing candidate when it has a process.started without a matching
    // instance.ended (i.e. at least one running/waiting instance). The inst id lives in
    // the JSONB payload (`payload->>'inst'`) — same field listInstanceProjections folds.
    // SELECT only DISTINCT tenant_id (no row data leaves the discovery step).
    const { rows } = await this.pool.query<{ tenant_id: string }>(
      `SELECT DISTINCT s.tenant_id
         FROM choros.audit_event s
        WHERE s.type = 'process.started'
          AND NOT EXISTS (
            SELECT 1
              FROM choros.audit_event e
             WHERE e.tenant_id = s.tenant_id
               AND e.type = 'instance.ended'
               AND e.payload->>'inst' = s.payload->>'inst'
          )
        LIMIT 200`,
    );
    return rows.map((r) => r.tenant_id);
  }
}

/**
 * Build the production `TimerFiringDeps`, or `undefined` to degrade to a no-op loop.
 *
 * Requires a pg pool (DB) AND a configured engine (FLOWABLE_BASE_URL): the loop reads
 * the LIVE engine task set to detect a fired timer, so without an engine there is
 * nothing to reconcile. When either is absent, returns `undefined` and the caller
 * degrades to a no-op handle (honest-degrade, NF-5).
 */
export function buildTimerFiringDeps(
  pool: pg.Pool | undefined,
  env: NodeJS.ProcessEnv,
): TimerFiringDeps | undefined {
  if (pool === undefined) return undefined;

  const baseUrl = env["FLOWABLE_BASE_URL"];
  if (baseUrl === undefined || baseUrl === "") return undefined;

  // T-0636 (P0-5): read the SAME env names src/server.ts:474-486 already uses
  // successfully (FLOWABLE_REST_APP_ADMIN_USER_ID / FLOWABLE_REST_APP_ADMIN_PASSWORD)
  // instead of the never-set FLOWABLE_ADMIN_USER/FLOWABLE_ADMIN_PASSWORD names
  // (which always fell through to the literal admin:test default → permanent
  // 401). No password → honest noop-degrade (undefined), mirroring the
  // FLOWABLE_BASE_URL check above — never a literal 'test' substitution.
  const flowableAdminPassword = env["FLOWABLE_REST_APP_ADMIN_PASSWORD"];
  if (!flowableAdminPassword) return undefined;

  const engine = makeFlowableClient({
    baseUrl,
    adminUser: env["FLOWABLE_REST_APP_ADMIN_USER_ID"] ?? "admin",
    adminPassword: flowableAdminPassword,
    timeoutMs: 10_000,
    maxRetries: 3,
    retryBaseDelayMs: 500,
    retryMaxDelayMs: 5_000,
  });

  return {
    tenantSource: new PostgresTimerTenantSource(pool),
    pool,
    engine,
    actor: env["TIMER_FIRING_ACTOR"] ?? "system:timer",
  };
}
