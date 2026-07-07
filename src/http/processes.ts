/**
 * src/http/processes.ts
 *
 * Read-API for process instances (GET /api/processes) + the start-instance
 * write-route (POST /api/processes/start, T-0280 / ADR T-0278 §B).
 *
 * In-memory seed data with process instance list matching screen-processes.jsx shape.
 * T-0141: when DATABASE_URL is set, serves process_instances from showcase pack file
 * (pack-serve.ts). PROCESSES_SEED remains as no-DB fallback (I-2 / spec §4.5).
 *
 * Zero pg / src/db/* imports in THIS file (FF-DISPLAY-4): the read GETs are the
 * display plane. The POST start-route's pg/RLS/engine logic lives in the dedicated
 * src/http/process-start.ts (ADR §3 extract-module sanction); this file only wires
 * the handler in when the composition root supplies a pool + FlowableClient.
 */
import { HttpError, type Router } from "./router.js";
import { withAuth, getAuthContext } from "./auth.js";
import {
  withActorInject,
  type ActorSlugResolver,
} from "./actor-inject-registrar.js";
import { JobStore } from "../core/jobStore.js";
import { tryLoadShowcasePack } from "./pack-serve.js";
import { makeStartInstanceHandler, type StartInstanceDeps, type ActorsDisplayResolver } from "./process-start.js";
import {
  listInstanceProjections,
  type InstanceProjection,
} from "./process-projection.js";
import {
  overlayLiveSteps,
  resolveLiveNodesByInstance,
  type CatalogEnginePort,
} from "../core/process-catalog-view.js";
import type { FlowableClient } from "../core/flowable-client.js";

// T-0709-R-P2-1 (judge): same per-request budget the catalog uses. Re-declared here
// (a plain number, not an import) so this display-plane module keeps importing ONLY from
// core/* — importing the value from process-catalog.ts would pull `pg` into this file and
// trip the FF-7-3 display-plane isolation gate. Kept in sync by intent (both surfaces
// bound the best-effort live overlay identically); the shared LOGIC lives in the core.
const LIVE_OVERLAY_DEADLINE_MS = 2_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProcessInstance = {
  id: string;
  name: string;
  procId: string;
  status: "running" | "waiting" | "done" | "failed";
  node: string;
  /**
   * T-0456 [D8-R1]: the CONCURRENT active nodes/steps of this instance. An AND-split
   * (parallelGateway) leaves several user-tasks active at once, so the process card
   * must show every concurrent branch, not a single "current node". For linear
   * (single-token) instances this is a 1-element array; absent on seed fixtures
   * (the card falls back to `node`).
   */
  nodes?: string[];
  started: string;
  elapsed: string;
  progress: { done: number; total: number };
  execs: ("human" | "agent" | "service")[];
  /**
   * T-0414 / T-0356: originating record id when started via an on_create trigger.
   * Absent for instances started via the explicit launch affordance.
   */
  recordId?: string;
};

// ---------------------------------------------------------------------------
// In-memory seed fixture
// ---------------------------------------------------------------------------

const PROCESSES_SEED: ProcessInstance[] = [
  {
    id: "INS-7731",
    name: "Согласование счёта поставщика",
    procId: "PRC-INV-APPROVE",
    status: "running",
    node: "n7 · Утверждение платежа",
    started: "07.06.2026 14:28:11",
    elapsed: "00:06:42",
    progress: { done: 4, total: 7 },
    execs: ["human", "agent", "service"],
  },
  {
    id: "INS-7702",
    name: "Возврат средств клиенту",
    procId: "PRC-REFUND",
    status: "waiting",
    node: "n3 · Утверждение",
    started: "07.06.2026 10:15:44",
    elapsed: "04:13:28",
    progress: { done: 2, total: 5 },
    execs: ["human"],
  },
  {
    id: "INS-7698",
    name: "Закрытие месяца",
    procId: "PRC-MONTH-CLOSE",
    status: "running",
    node: "n5 · Сверка",
    started: "06.06.2026 23:30:00",
    elapsed: "14:58:12",
    progress: { done: 5, total: 8 },
    execs: ["human", "service"],
  },
  {
    id: "INS-7740",
    name: "Классификация обращения",
    procId: "PRC-SUPPORT-TRIAGE",
    status: "running",
    node: "n2 · Триаж",
    started: "07.06.2026 14:30:22",
    elapsed: "00:00:58",
    progress: { done: 1, total: 4 },
    execs: ["agent"],
  },
  {
    id: "INS-7755",
    name: "Проверка контрагента (KYC)",
    procId: "PRC-KYC",
    status: "waiting",
    node: "n4 · Комплаенс",
    started: "07.06.2026 08:00:00",
    elapsed: "06:30:45",
    progress: { done: 1, total: 3 },
    execs: ["human", "service"],
  },
  {
    id: "INS-7733",
    name: "Поддержка и эскалация",
    procId: "PRC-SUPPORT-ESC",
    status: "failed",
    node: "n6 · L2",
    started: "06.06.2026 18:45:30",
    elapsed: "19:45:02",
    progress: { done: 3, total: 4 },
    execs: ["human", "agent"],
  },
  {
    id: "INS-7729",
    name: "Инициирование платежа",
    procId: "PRC-PAYMENT-INIT",
    status: "done",
    node: "n7 · Завершение",
    started: "07.06.2026 15:05:11",
    elapsed: "00:03:20",
    progress: { done: 5, total: 5 },
    execs: ["agent"],
  },
  {
    id: "INS-7690",
    name: "Синхронизация проводок",
    procId: "PRC-LEDGER-SYNC",
    status: "done",
    node: "n8 · Завершение",
    started: "07.06.2026 14:32:15",
    elapsed: "00:02:08",
    progress: { done: 3, total: 3 },
    execs: ["service"],
  },
];

// ---------------------------------------------------------------------------
// DB availability flag — same pattern as org.ts
// ---------------------------------------------------------------------------

function hasDb(): boolean {
  return Boolean(process.env["DATABASE_URL"]);
}

// ---------------------------------------------------------------------------
// Data accessors — pack-file-serve path when DATABASE_URL set, else PROCESSES_SEED
// ---------------------------------------------------------------------------

/** Sentinel returned when the pack file is absent in the deployed container. */
export const PACK_ABSENT_SENTINEL = null;

function findProcessInstances(): ProcessInstance[] | null {
  if (hasDb()) {
    // T-0141: serve from single source (pack file) when DB-backed mode active.
    // process_instances pack shape = ProcessInstance type (T-0140 ADR §3.10).
    // T-0259: tryLoadShowcasePack returns null when the pack file is absent
    // (container deployment); callers degrade to graceful-empty (never 500).
    const pack = tryLoadShowcasePack();
    if (pack === null) {
      return PACK_ABSENT_SENTINEL;
    }
    return pack.process_instances as ProcessInstance[];
  }
  return PROCESSES_SEED;
}

function findProcessInstance(instanceId: string): ProcessInstance | null {
  const instances = findProcessInstances();
  if (instances === null) return null;
  return instances.find((p) => p.id === instanceId) || null;
}

// ---------------------------------------------------------------------------
// T-0282 (ADR §2.3) — read-only merge of started-instance projections over the
// pack/seed display data. A started ТЭЛ instance becomes visible in the list
// (AC-1) and reaches `done` after approve (AC-6). The projection itself lives in
// process-projection.ts (which carries pg) — this file stays display-plane-pure
// (it imports the projection module, never pg / src/db/* directly; FF-DISPLAY-4 /
// FF-7-3 grep this file's own imports).
// ---------------------------------------------------------------------------

/** Map an InstanceProjection to the ProcessInstance wire shape. */
function projectionToInstance(p: InstanceProjection): ProcessInstance {
  const started = new Date(p.startedAt).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  // T-0614 [деТЭЛ]: honest "known so far" step count, resolved by the projection
  // (process-projection.ts) from the actual audit fold for THIS instance — replaces
  // the case-literal {done:2,total:3}/{done:3,total:3} of the linear ТЭЛ's 3 nodes
  // that used to be assigned unconditionally to every instance regardless of its
  // real process (D-064 violation, found live by the founder 2026-07-03). NOT the
  // full BPMN user-task count of the definition (see ADR-T0614 §4 O1 follow-up).
  const progress = { done: p.stepsDone, total: p.stepsKnownTotal };
  // T-0456 [D8-R1]: surface concurrent branches. `node` stays the primary step for
  // back-compat; `nodes` carries every concurrent waiting step so the card can render
  // an AND-split's parallel branches. A done instance has no waiting nodes.
  const nodes = p.concurrentSteps.length > 0 ? [...p.concurrentSteps] : [p.step];
  return {
    id: p.inst,
    // T-0614 [деТЭЛ]: the REAL process-definition name (choros.process_definition,
    // or the honest fallbackDefinitionName(procKey) for an engine-only key) —
    // replaces the case-literal "Канонический линейный ТЭЛ" that used to be
    // assigned to EVERY instance (purchaseApproval and acceptance-demo instances
    // both showed this one literal name — the live fact that surfaced this bug).
    name: p.definitionName,
    procId: p.procKey,
    status: p.status === "running" ? "running" : p.status, // running|waiting|done
    node: p.step,
    nodes,
    started,
    elapsed: "—",
    progress,
    // T-0614 [деТЭЛ]: the one concretely-known executor kind (the actor who
    // STARTED this instance, resolved via choros.employee.kind by the projection)
    // — replaces the case-literal ["human","agent"] assigned unconditionally to
    // every instance. "service" is never fabricated (see ADR-T0614 §4 O2).
    execs: [p.starterActorKind],
    // T-0414 / T-0356: pass through the originating record id for on_create instances
    // so the e2e spec can correlate by recordId without a separate lookup.
    ...(p.recordId !== undefined ? { recordId: p.recordId } : {}),
  };
}

// ---------------------------------------------------------------------------
// T-0708 [E16 §6, capstone T-0691]: record-scoped filter for GET /api/processes.
// Pure + exported so the wiring (the record→instance reverse link on the record
// card) is unit-testable without an HTTP round-trip. Two small helpers:
//   - readRecordFilter: extract a trimmed non-empty `record` query param, else null
//     (null = "no filter", the byte-unchanged legacy full-list path).
//   - filterInstancesByRecord: keep only instances whose recordId === the filter.
//     An instance with a different OR absent recordId is dropped; the filter is
//     applied AFTER tenant-scoped projection so it can never widen visibility.
// ---------------------------------------------------------------------------

/** Extract the `?record=<id>` filter, or null when absent/blank (no filter). */
function readRecordFilter(req: import("node:http").IncomingMessage): string | null {
  const rawUrl = req.url ?? "";
  const qIdx = rawUrl.indexOf("?");
  if (qIdx < 0) return null;
  const value = new URLSearchParams(rawUrl.slice(qIdx + 1)).get("record");
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Keep only the instances whose `recordId` exactly equals `recordId`. An instance
 * with a different or absent recordId is excluded (never fabricated). Exported for
 * the unit tier.
 */
export function filterInstancesByRecord(
  instances: ProcessInstance[],
  recordId: string,
): ProcessInstance[] {
  return instances.filter((i) => i.recordId === recordId);
}

// ---------------------------------------------------------------------------
// T-0609: instance history detail (variables + BPMN activity history), read
// live from the engine via the two new FlowableClient read-only methods
// (getHistoricVariableInstances / getHistoricActivityInstances). This is the
// engine-native replacement for the raw SQL a P0 gateway-branch diagnosis
// previously required — no product surface showed "which branch did this
// instance take, with what values" before this.
//
// Best-effort by design: BOTH sub-fetches degrade independently to an empty
// result on engine error (never throw past this function) so a Flowable
// outage never turns the instance-detail response into a 500 — only
// `historyAvailable` flips to false, and the caller keeps the honest
// best-effort audit-projection note it already shows today.
// ---------------------------------------------------------------------------

/** Wire shape appended to a ProcessInstance response (T-0609). */
export interface InstanceHistoryDetail {
  variables: { name: string; value: unknown }[];
  history: {
    step: string;
    kind: string;
    startedAt: string | null;
    endedAt: string | null;
    completedBy: string | null;
    /**
     * T-0648 (D-064, UX-study §3): the human-readable resolution of
     * `completedBy` (a raw Flowable assignee — an employee slug — otherwise
     * rendered bare in the UI). Present only when a resolver was injected AND
     * the slug resolved to a real choros.employee row; absent ⇒ the frontend
     * falls back to `completedBy` itself (never worse than today).
     */
    completedByName?: string;
    /**
     * T-0648 FIX-2 (столп 4): the resolved actor TYPE (human/agent/service) of
     * the step's completer. A userTask can be completed by an AGENT — the
     * frontend must NOT hardcode a human glyph. Present iff `completedByName`
     * is; absent ⇒ frontend falls back to "human" (the pre-resolve default).
     */
    completedByType?: "human" | "agent" | "service";
    /** T-0648 FIX-3: the completer's soft-deactivation marker, if resolved. */
    completedByDeactivated?: boolean;
  }[];
  /** false when the engine could not be reached for the activity history. */
  historyAvailable: boolean;
}

async function fetchInstanceHistoryDetail(
  flowable: FlowableClient,
  engineInstanceId: string,
  tenantId?: string,
  resolveActorsDisplay?: ActorsDisplayResolver,
): Promise<InstanceHistoryDetail> {
  // Both methods are OPTIONAL on FlowableClient (mirrors pingEngine — existing
  // partial test-stub clients across src/__tests__/ need no change). Absent ⇒
  // the same honest-degrade as an engine error.
  const [varsResult, actsResult] = await Promise.all([
    flowable.getHistoricVariableInstances
      ? flowable.getHistoricVariableInstances(engineInstanceId)
      : Promise.resolve({ ok: false as const, code: "UNKNOWN" as const }),
    flowable.getHistoricActivityInstances
      ? flowable.getHistoricActivityInstances(engineInstanceId)
      : Promise.resolve({ ok: false as const, code: "UNKNOWN" as const }),
  ]);

  const variables = varsResult.ok ? varsResult.variables : [];
  const history = actsResult.ok
    ? actsResult.activities
        // T-0648 LIVE_PROOF fix (§2): Flowable's historic-activity-instances
        // include `sequenceFlow` entries — the EDGES between nodes, not steps a
        // person/agent ever performs. They (a) carry an EMPTY activityName, so
        // `activityName || activityId` leaks the raw technical id ("sf-start-fin",
        // "sf-timer-esc") into the UI as a "step name", and (b) never have an
        // assignee, so they can never show a completedBy. Both are exactly the
        // RED symptoms the live-proof caught. A sequenceFlow is a transition, not
        // a step in the human history — drop it so only real BPMN NODES remain
        // (startEvent/userTask/gateway/event/…), whose names are human and whose
        // userTasks carry the completing assignee.
        .filter((a) => a.activityType !== "sequenceFlow")
        .map((a) => ({
          step: a.activityName || a.activityId,
          kind: a.activityType,
          startedAt: a.startTime,
          endedAt: a.endTime,
          completedBy: a.assignee,
        }))
    : [];

  // T-0648: batch-resolve every DISTINCT completedBy slug in ONE query (no
  // per-step round-trip) — this instance's history is typically a handful of
  // steps, but the O(1)-queries invariant holds regardless of step count.
  let historyWithNames = history;
  if (tenantId && resolveActorsDisplay) {
    const slugs = [...new Set(history.map((h) => h.completedBy).filter((v): v is string => !!v))];
    if (slugs.length > 0) {
      try {
        const resolved = await resolveActorsDisplay(tenantId, slugs);
        historyWithNames = history.map((h) => {
          if (!h.completedBy) return h;
          const hit = resolved.get(h.completedBy);
          // T-0648 FIX-2/FIX-3: carry the resolved TYPE + deactivation so the
          // frontend renders the right glyph (agent-completed step ≠ human) and
          // the deactivation marker, instead of hardcoding "human".
          return hit
            ? {
                ...h,
                completedByName: hit.name,
                completedByType: hit.type,
                completedByDeactivated: hit.deactivated,
              }
            : h;
        });
      } catch {
        // Degrade gracefully: keep the raw slug (read-projection, never throws).
      }
    }
  }

  return { variables, history: historyWithNames, historyAvailable: actsResult.ok };
}

// ---------------------------------------------------------------------------
// T-0709-R-P0-1 (judge): live-engine step/node overlay for the DETAIL plane.
//
// THE FIX for the review's P0: before this, GET /api/processes and /api/processes/:id
// derived node/nodes purely from projectionToInstance ← listInstanceProjections — the
// process.started audit SNAPSHOT, frozen at start time and never re-derived as the token
// advanced. The catalog (T-0709) had already been moved to the LIVE engine node, so the
// two surfaces DISAGREED (catalog live, detail frozen) — the exact bug class T-0709 set
// out to close, moved to the other side.
//
// This overlays each NON-DONE projection's step/role/concurrentSteps with the engine's
// REAL active user-task set — via the SAME resolveLiveNodesByInstance + overlayLiveSteps
// the catalog uses (single source of truth). projectionToInstance then maps the OVERLAID
// projection, so `node` (= p.step) and `nodes` (= p.concurrentSteps) reflect the token's
// real position. Both surfaces now read the same live source; they cannot diverge.
//
// Honest degrade (identical to the catalog): no getActiveUserTasks method on the client,
// engine unreachable per-instance, no active user-task, or the shared deadline elapsing
// ⇒ that projection stays byte-identical on its audit snapshot — never worse than before,
// never a 500. Display-plane isolation (FF-7-3) preserved: this reaches the engine ONLY
// through the injected client's read method (no pg, no bare fetch, no startInstance).
// ---------------------------------------------------------------------------

/**
 * Overlay the live active-node (step/role/concurrentSteps) onto the NON-DONE members of
 * `projections`, reading the engine through the injected FlowableClient. Reuses the SAME
 * core helpers the catalog uses. Best-effort + bounded by a shared deadline; a total
 * engine miss returns the projections unchanged. When the client has no getActiveUserTasks
 * method (bare test stubs / a client that predates it), the input is returned as-is.
 */
async function overlayDetailLiveSteps(
  flowable: FlowableClient,
  projections: readonly InstanceProjection[],
): Promise<InstanceProjection[]> {
  const port = flowable as unknown as Partial<CatalogEnginePort>;
  if (typeof port.getActiveUserTasks !== "function") return [...projections];
  const runningInstIds = projections
    .filter((p) => p.status !== "done")
    .map((p) => p.inst);
  if (runningInstIds.length === 0) return [...projections];
  const liveByInst = await resolveLiveNodesByInstance(
    port as CatalogEnginePort,
    runningInstIds,
    { deadlineMs: LIVE_OVERLAY_DEADLINE_MS },
  );
  return overlayLiveSteps(projections, liveByInst);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerProcessesRoutes(
  router: Router,
  _store?: JobStore,
  // T-0280 (ADR §B): when the composition root supplies the start-instance deps
  // (pool + FlowableClient + actor→tenant resolver), register the write-route.
  // Absent ⇒ GET-only display plane (E2E/no-DB/no-engine path stays unchanged).
  startDeps?: StartInstanceDeps,
  // T-0328 G1: optional actor-slug resolver (resolveActorSlugFromAuth, kind='human').
  // When supplied AND startDeps is present, the FROZEN process-start body is wrapped
  // in the actor-inject façade so that, in keycloak mode, the validated JWT identity is
  // resolved into x-dev-user + x-tenant-id BEFORE the frozen body reads them — making
  // the surface FUNCTIONAL with a real Bearer (not just 401-closed). Absent ⇒ the
  // legacy withAuth-only wrap (bypass closed, but keycloak body still 401s; pre-G1).
  actorSlugResolver?: ActorSlugResolver,
): void {
  // POST /api/processes/start — start-instance write-route (T-0280, FROZEN §2.2).
  // Registered BEFORE GET /api/processes/:id so the literal '/start' segment is not
  // captured by the ':id' pattern. Tenant-scoped (withTenantTx + RLS); the pg/engine
  // logic lives in process-start.ts (FF-DISPLAY-4 keeps THIS file display-plane-pure).
  if (startDeps) {
    // withAuth: keycloak mode REQUIRES a valid Bearer JWT (401 otherwise; no x-dev-user
    // bypass); dev mode is a no-op pass-through and the x-dev-user / x-tenant-id FROZEN
    // contract (§2.2) is unchanged. The display-plane GETs below stay unguarded (public
    // read), matching the existing read-API posture.
    const startHandler = makeStartInstanceHandler(startDeps);
    if (actorSlugResolver) {
      // T-0328 G1: actor-inject façade (superset of withAuth). In keycloak mode it
      // resolves the validated JWT identity → x-dev-user AND the actor's OWN tenant →
      // x-tenant-id (via startDeps.resolveActorTenant, fail-closed; NEVER a header-asserted
      // tenant) BEFORE the FROZEN body reads them. The 201/§2.2 REST contract is unchanged;
      // the body is byte-untouched. Dev mode is a pure pass-through. (ADR T-0328 §4.2.)
      router.register(
        "POST",
        "/api/processes/start",
        withActorInject(startHandler, {
          resolveActorSlug: actorSlugResolver,
          injectTenant: startDeps.resolveActorTenant,
        }),
      );
    } else {
      // Pre-G1 / no-slug-resolver path (e.g. tests that only need the dev x-dev-user
      // flow): withAuth-only — bypass closed, but keycloak body still 401s without
      // a slug resolver. Preserved for backward compatibility.
      router.register("POST", "/api/processes/start", withAuth(startHandler));
    }
  }

  // T-0564: resolve the authenticated actor → employee SLUG (mode-aware), mirroring
  // src/http/inbox.ts. In keycloak mode the JWT `sub` is a random UUID (≠ employee
  // slug) — feeding it straight into resolveActorTenant fail-closes (403) and the
  // handler silently degrades to an EMPTY list for every real KC persona. We must
  // resolve sub→slug via the injected actorSlugResolver (resolveActorSlugFromAuth,
  // kind='human') BEFORE resolveActorTenant. In dev mode the x-dev-user header value
  // IS the slug (unchanged). Returns null when no actor / no employee matches.
  //
  // Kept LOCAL to the read GETs (this file stays display-plane-pure — it reaches the
  // DB only via startDeps/process-projection, never pg/src/db/* directly; FF-DISPLAY-4).
  async function resolveActorSlugForRead(
    req: import("node:http").IncomingMessage,
  ): Promise<string | null> {
    const authCtx = getAuthContext(req);
    if (authCtx !== undefined) {
      // Keycloak mode: resolve sub → employee slug via the injected resolver.
      // Absent resolver (pre-G1 wiring / no DB) ⇒ no actor (honest-empty, never a
      // raw-UUID tenant lookup).
      if (!actorSlugResolver) return null;
      return actorSlugResolver(authCtx.sub, authCtx.preferredUsername);
    }
    // Dev mode: x-dev-user header value IS the slug.
    let h = req.headers["x-dev-user"];
    if (Array.isArray(h)) h = h[0];
    return typeof h === "string" && h ? h : null;
  }

  // GET /api/processes — return full process instances list.
  //
  // T-0301 (mock-leak fix): in DB mode, serve ONLY real tenant-scoped instance
  // projections. The showcase pack (seed/showcase/pack.json) and PROCESSES_SEED
  // are display-plane fixtures that must NOT appear for real authenticated tenants;
  // they mask real process data and break the ТЭЛ journey. Honest-empty is correct
  // for a tenant that has not started any process instances yet.
  //
  // In no-DB mode (no DATABASE_URL): fall back to the existing PROCESSES_SEED /
  // pack path (memory tests and dev-without-DB are unchanged, FF-11).
  //
  // T-0259 compat: when DATABASE_URL is set but the pack file is absent, that path
  // is no longer reached for the list endpoint (DB mode goes directly to projections).
  // The `demo: true` sentinel is retained only for the no-DB + pack-absent corner.
  //
  // T-0564: wrapped in withAuth so getAuthContext(req) is populated in keycloak mode
  // (in dev mode withAuth is a pass-through, so the x-dev-user branch is unchanged).
  router.register("GET", "/api/processes", withAuth(async (req, res) => {
    // T-0708 [E16 §6, capstone T-0691]: optional `?record=<recordId>` filter — the
    // record-detail card's reverse link (запись→инстансы). The existing card→record
    // link («ЗАПИСЬ-ИСТОЧНИК») made the pair one-directional; this closes it. The
    // filter is applied AFTER the tenant-scoped projection fold, so it never widens
    // visibility (a foreign record id can only match this tenant's own instances)
    // and needs no new route — it lives on this already-withAuth-wrapped GET.
    const recordFilter = readRecordFilter(req);

    // DB mode: serve ONLY real tenant-scoped projections (T-0301).
    if (hasDb() && startDeps) {
      // T-0564: resolve sub→slug (keycloak) or x-dev-user (dev) BEFORE the tenant lookup.
      const actorSlug = await resolveActorSlugForRead(req);

      let instances: ProcessInstance[] = [];
      if (actorSlug) {
        try {
          const tenantId = await startDeps.resolveActorTenant(actorSlug);
          const projections = await listInstanceProjections(startDeps.pool, tenantId);
          // T-0709-R-P0-1: overlay each non-done instance's LIVE active node so the list's
          // node/nodes match the catalog AND the detail route (single live source). Best-
          // effort — an engine miss leaves that instance on its snapshot (never worse).
          const display = await overlayDetailLiveSteps(startDeps.flowable, projections);
          instances = display.map(projectionToInstance);
        } catch {
          // Read-projection: degrade gracefully to honest-empty — never 500.
          instances = [];
        }
      }

      // T-0708: apply the record filter over the ALREADY tenant-scoped list.
      if (recordFilter !== null) instances = filterInstancesByRecord(instances, recordFilter);

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ instances }));
      return;
    }

    // No-DB / no-startDeps fallback: legacy display-plane path (FF-11).
    // T-0259: base may be null when the pack file is absent in the deployed
    // container. Degrade to graceful-empty so the endpoint never 500s.
    const base = findProcessInstances();
    if (base === null) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ instances: [], demo: true }));
      return;
    }

    // T-0708: the seed/pack fixtures carry NO recordId, so a record-scoped query in
    // no-DB mode is honestly empty (we do not fabricate a record binding for a
    // fixture). Without the filter the legacy full-list behaviour is byte-unchanged.
    const list = recordFilter !== null ? filterInstancesByRecord(base, recordFilter) : base;

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ instances: list }));
  }));

  // GET /api/processes/:id — return specific instance or 404.
  //
  // T-0564: give the detail route a REAL projection branch. Previously it only ever
  // consulted the pack/seed fixture (findProcessInstance), so a live started instance
  // (whose id is a Flowable instance id, not a seed INS-xxxx) always 404'd — the
  // T-0556 detail screen fetches /api/processes/:id by that instance id.
  //
  // DB mode: resolve actor → tenant → tenant-scoped projections (same source as the
  // list), then find the one whose `inst` equals the requested id and map it via the
  // EXACT SAME projectionToInstance mapper the list uses (wire contract preserved —
  // `id` = p.inst). 404 when not found. No-DB mode: the pack/seed fixture fallback is
  // unchanged (FF-11 / no-DB display-plane path).
  //
  // Wrapped in withAuth for the same reason as the list route (populates AuthContext
  // in keycloak mode; pass-through in dev mode).
  router.register("GET", "/api/processes/:id", withAuth(async (req, res, params) => {
    const instanceId = params.id as string;

    // DB mode: serve the real tenant-scoped projection for this instance id.
    if (hasDb() && startDeps) {
      const actorSlug = await resolveActorSlugForRead(req);
      if (actorSlug) {
        try {
          const tenantId = await startDeps.resolveActorTenant(actorSlug);
          const projections = await listInstanceProjections(startDeps.pool, tenantId);
          const match = projections.find((p) => p.inst === instanceId);
          if (match) {
            // T-0709-R-P0-1: overlay THIS instance's LIVE active node (step/role/
            // concurrentSteps) so the detail screen's node/nodes reflect the token's
            // real position — the SAME live source the catalog reads. Overlaying only
            // the matched projection keeps the fan-out at one engine call; a miss leaves
            // `match` byte-unchanged on its snapshot (overlayLiveSteps no-ops).
            const [displayMatch] = await overlayDetailLiveSteps(startDeps.flowable, [match]);
            const overlaid = displayMatch ?? match;
            // T-0609: variables + detailed transition history, read from the SAME
            // Flowable client already threaded into startDeps — under the SAME
            // tenant-membership gate this whole branch already applies (no new
            // PDP/capability path; the live acceptance directive was explicit:
            // do not widen visibility beyond what this page already grants).
            // Best-effort: an engine error degrades to empty arrays +
            // historyAvailable:false, never a 500 (the instance's core fields
            // above do not depend on the engine being reachable).
            const detail = await fetchInstanceHistoryDetail(
              startDeps.flowable,
              match.inst,
              tenantId,
              startDeps.resolveActorsDisplay,
            );
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ...projectionToInstance(overlaid), ...detail }));
            return;
          }
        } catch {
          // Read-projection: degrade gracefully — fall through to 404 (never 500).
        }
      }
      // DB mode + no matching real instance ⇒ 404 (the seed fixture is NOT served to
      // real authenticated tenants; T-0301 mock-leak invariant).
      throw new HttpError(404, "NOT_FOUND", "instance not found");
    }

    // No-DB fallback: pack/seed fixture lookup (FF-11 display-plane path).
    const instance = findProcessInstance(instanceId);
    if (!instance) {
      throw new HttpError(404, "NOT_FOUND", "instance not found");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(instance));
  }));
}
