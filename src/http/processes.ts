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
  isInstanceDetailVisible,
  filterProjectionsByReadVisibility,
  // T-0756 [E16 §6, capstone T-0691 P1]: per-hop-ACL source-record projection +
  // participant check. Both live in process-projection.ts (which carries pg) so
  // THIS module stays display-plane-pure (FF-DISPLAY-4) — it only calls them.
  resolveSourceRecordProjection,
  isInstanceParticipant,
  type InstanceProjection,
  type SourceRecordProjection,
} from "./process-projection.js";
import {
  overlayLiveSteps,
  resolveLiveNodesByInstance,
  type CatalogEnginePort,
} from "../core/process-catalog-view.js";
import type { FlowableClient } from "../core/flowable-client.js";
// T-0756: type-only import (Grant/AncestryOracle) to thread the READ-visibility
// object into resolveSourceRecordProjection. Types erase at compile — this is NOT
// the lattice math (isNarrowerOrEqual/isEffective), which stays out of this module
// (FF-INST-VIS-2b, single-resolver: containment is resolved only in read-visibility.ts).
import type { Grant, AncestryOracle } from "../core/grant-lattice.js";

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
  /**
   * T-0654 [part A]: numeric epoch-ms of the start, carried alongside the pre-formatted
   * `started` string so the server-side date filter (?started_from/?started_to) and the
   * deterministic newest-first sort can operate on a real number. Present on DB-backed
   * projections; ABSENT on the seed/pack fixtures (whose `started` is only a ru-RU string).
   * An absent value is "unknown start time" — it passes an optional date bound (cannot be
   * judged) and sorts after all known-time instances.
   */
  startedAtMs?: number;
  /**
   * T-0654 [part A / UX-study §5.3]: the starter's raw actor id (from the projection's
   * starterActorId). Drives the ?mine= filter and is the key the name resolver keys on.
   * Present on DB-backed projections; absent on seed/pack fixtures.
   */
  starterId?: string;
  /**
   * T-0654 [part A]: the starter's human-readable name, batch-resolved via the injected
   * resolveActorsDisplay (T-0648). Best-effort — absent when no resolver is wired, the
   * actor did not resolve, or in the no-DB path (the frontend then falls back to the
   * `starterType` glyph / `starterId`, never worse than today's exec glyphs).
   */
  starterName?: string;
  /**
   * T-0654 [part A]: the starter's actor type. Defaults from the projection's
   * starterActorKind (human|agent), refined to the resolver's type (which can also be
   * "service") when the name resolves. Present on DB-backed projections.
   */
  starterType?: "human" | "agent" | "service";
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
    // T-0654 [part A]: numeric start + starter identity for server-side filter/sort and
    // the «Запущен: <Имя>» display. starterName is filled later (batch resolve on the
    // page only); starterType defaults from the projection's kind here.
    startedAtMs: p.startedAt,
    starterId: p.starterActorId,
    starterType: p.starterActorKind,
  };
}

// ---------------------------------------------------------------------------
// T-0708 [E16 §6, capstone T-0691]: record-scoped filter for GET /api/processes.
// The record→instance reverse link (record card → its instances). T-0654 [part A]
// folded the URL parse of `?record=` INTO parseProcessListQuery (record is now one
// field of the unified query, composed with every other filter), so the standalone
// `readRecordFilter` reader is gone. This pure `filterInstancesByRecord` predicate is
// retained (exported, unit-tested) as the single source of the record-match rule: an
// instance with a different OR absent recordId is dropped, applied AFTER the
// tenant-scoped projection so it can never widen visibility.
// ---------------------------------------------------------------------------

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
// T-0654 [part A / UX-study §5.1]: server-side query pipeline for GET /api/processes.
//
// Before this the read had ONE optional filter (?record=) and returned every projected
// instance in one shot (the live-found "25 инстансов в скролл-щели"). This adds the
// operator-page contract: search (?q=), exact definition (?definition=) / status
// (?status=) filters, a started-time range (?started_from/?started_to), a "mine" toggle
// (?mine=, instances the reading actor started), and server-side pagination
// (?limit/?offset) — all as PURE, exported functions so the whole contract unit-tests in
// isolation (no HTTP, no pg — this module stays display-plane-pure, FF-DISPLAY-4).
//
// Everything operates on the ALREADY tenant-scoped ProcessInstance[] (mapped from the
// projection fold), so no filter can ever widen visibility (FF-5): a foreign
// definition/record/actor simply matches nothing. Sort + paginate are a total,
// deterministic order (FF-3/FF-4).
// ---------------------------------------------------------------------------

/** Parsed, validated query for the process list. All filters null ⇒ absent. */
export interface ProcessListQuery {
  q: string | null;
  definition: string | null;
  status: string | null;
  startedFrom: number | null;
  startedTo: number | null;
  /** actor slug to match against starterId when ?mine= was requested; null ⇒ no mine filter. */
  mineActor: string | null;
  record: string | null;
  limit: number;
  offset: number;
}

/** Default page size when no ?limit given — high enough that an unparameterised read is
 *  byte-for-byte the pre-T-0654 "return everything (up to the fold window)" behaviour. */
export const PROCESS_LIST_DEFAULT_LIMIT = 200;
/** Hard cap on page size (mirrors the ≤500 fold window; a page never exceeds this). */
export const PROCESS_LIST_MAX_LIMIT = 200;

/** Parse a bound as epoch-ms: accepts a numeric string OR an ISO/date string. null on junk. */
function parseTimeBound(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // Pure-integer string ⇒ treat as epoch-ms directly (avoids Date.parse mangling "1717…").
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function clampInt(raw: string | null, dflt: number, min: number, max: number): number {
  if (raw === null) return dflt;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/**
 * Parse the GET /api/processes query string into a validated {@link ProcessListQuery}.
 * `actorSlug` is the resolved reading actor (dev header or sub→slug) — required for the
 * ?mine= filter; when absent, ?mine= is treated as "no mine filter" (an unauthenticated /
 * unresolvable reader has no notion of "mine"). Reads the raw URL directly (same approach
 * the record filter used) so it needs no router-parsed query object.
 */
export function parseProcessListQuery(
  req: import("node:http").IncomingMessage,
  actorSlug: string | null,
): ProcessListQuery {
  const rawUrl = req.url ?? "";
  const qIdx = rawUrl.indexOf("?");
  const params = new URLSearchParams(qIdx < 0 ? "" : rawUrl.slice(qIdx + 1));
  const nonEmpty = (key: string): string | null => {
    const v = params.get(key);
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  };
  const mineRaw = params.get("mine");
  const mineRequested = mineRaw === "1" || mineRaw === "true";
  return {
    q: nonEmpty("q"),
    definition: nonEmpty("definition"),
    status: nonEmpty("status"),
    startedFrom: parseTimeBound(params.get("started_from")),
    startedTo: parseTimeBound(params.get("started_to")),
    mineActor: mineRequested ? actorSlug : null,
    record: nonEmpty("record"),
    limit: clampInt(params.get("limit"), PROCESS_LIST_DEFAULT_LIMIT, 1, PROCESS_LIST_MAX_LIMIT),
    offset: Math.max(0, clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER)),
  };
}

/** True when `inst` passes EVERY active filter of `q`. Unknown-time instances pass an
 *  optional date bound (cannot be judged); ?mine excludes instances with no known starter. */
function instanceMatchesQuery(inst: ProcessInstance, q: ProcessListQuery): boolean {
  if (q.record !== null && inst.recordId !== q.record) return false;
  if (q.definition !== null && inst.procId !== q.definition) return false;
  if (q.status !== null && inst.status !== q.status) return false;
  if (q.mineActor !== null && inst.starterId !== q.mineActor) return false;
  if (q.startedFrom !== null && inst.startedAtMs !== undefined && inst.startedAtMs < q.startedFrom) return false;
  if (q.startedTo !== null && inst.startedAtMs !== undefined && inst.startedAtMs > q.startedTo) return false;
  if (q.q !== null) {
    const needle = q.q.toLowerCase();
    const hay = [inst.name, inst.procId, inst.id, inst.node].filter((s): s is string => typeof s === "string");
    if (!hay.some((s) => s.toLowerCase().includes(needle))) return false;
  }
  return true;
}

/** Total, deterministic order: known start time DESC (newest first), unknown-time last,
 *  ties (and the whole unknown group) broken by id ASC. */
function compareForList(a: ProcessInstance, b: ProcessInstance): number {
  const am = a.startedAtMs;
  const bm = b.startedAtMs;
  if (am !== undefined && bm !== undefined) {
    if (am !== bm) return bm - am; // newer first
  } else if (am !== undefined) {
    return -1; // known before unknown
  } else if (bm !== undefined) {
    return 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable tiebreak
}

/**
 * Filter → sort → paginate a tenant-scoped instance list. PURE. Returns the requested
 * page plus the `total` size of the filtered set (BEFORE the slice) so the client can
 * render "N из total". A slice past the end yields an empty page with total unchanged.
 */
export function selectProcessPage(
  instances: ProcessInstance[],
  q: ProcessListQuery,
): { page: ProcessInstance[]; total: number } {
  const filtered = instances.filter((i) => instanceMatchesQuery(i, q));
  filtered.sort(compareForList);
  const total = filtered.length;
  const page = filtered.slice(q.offset, q.offset + q.limit);
  return { page, total };
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
  // T-0654 [part A / UX-study §5.3]: the instance's starter id — folded into the SAME
  // single batch resolve as the step completers so «Запущен: <Имя>» costs NO extra query
  // (preserves the T-0648 "exactly one resolve call PER REQUEST" invariant). The resolved
  // starter display is returned via `starterDisplay` (kept OFF InstanceHistoryDetail so
  // that interface stays history-only) for the caller to apply to the instance header.
  starterActorId?: string,
): Promise<InstanceHistoryDetail & { starterDisplay?: { name: string; type: "human" | "agent" | "service" } }> {
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
  // T-0654: the starter id joins the SAME distinct set so the whole request still
  // costs exactly ONE resolve call (no separate starter lookup).
  let historyWithNames = history;
  let starterDisplay: { name: string; type: "human" | "agent" | "service" } | undefined;
  if (tenantId && resolveActorsDisplay) {
    const idSet = new Set(history.map((h) => h.completedBy).filter((v): v is string => !!v));
    if (starterActorId) idSet.add(starterActorId);
    const slugs = [...idSet];
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
        // T-0654: pull the starter's resolved display from the SAME batch.
        if (starterActorId) {
          const starterHit = resolved.get(starterActorId);
          if (starterHit && starterHit.resolved) {
            starterDisplay = { name: starterHit.name, type: starterHit.type };
          }
        }
      } catch {
        // Degrade gracefully: keep the raw slug (read-projection, never throws).
      }
    }
  }

  return { variables, history: historyWithNames, historyAvailable: actsResult.ok, starterDisplay };
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
// T-0654 [part A / UX-study §5.3]: batch-resolve the starter NAME for a page of
// instances. One query for the whole page's DISTINCT starter ids (O(1) queries,
// never per-row), via the SAME injected resolveActorsDisplay the history detail uses
// (T-0648). Best-effort + non-fatal: no resolver, no tenant, or a resolve error leaves
// the page unchanged (starterName absent, starterType/starterId from the projection
// remain) — the frontend degrades to the type glyph, never worse than today. Returns a
// NEW array; inputs are not mutated. Display-plane-pure: reaches the DB only through the
// injected function (no pg here).
// ---------------------------------------------------------------------------
async function enrichStarterNames(
  page: ProcessInstance[],
  tenantId: string,
  resolveActorsDisplay?: ActorsDisplayResolver,
): Promise<ProcessInstance[]> {
  if (!resolveActorsDisplay) return page;
  const ids = [...new Set(page.map((i) => i.starterId).filter((v): v is string => !!v))];
  if (ids.length === 0) return page;
  try {
    const resolved = await resolveActorsDisplay(tenantId, ids);
    return page.map((inst) => {
      if (!inst.starterId) return inst;
      const hit = resolved.get(inst.starterId);
      if (!hit || !hit.resolved) return inst;
      return { ...inst, starterName: hit.name, starterType: hit.type };
    });
  } catch {
    // Read-projection: degrade gracefully — keep the raw starter fields.
    return page;
  }
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
    // T-0564: resolve sub→slug (keycloak) or x-dev-user (dev) — needed for the tenant
    // lookup AND the ?mine= filter. Resolved once, up front, for both branches.
    const actorSlug = await resolveActorSlugForRead(req);
    // T-0654 [part A / UX-study §5.1]: parse the operator-page query — search, exact
    // definition/status filters, started-time range, ?mine=, pagination. Supersedes the
    // single T-0708 `?record=` read (record is now one field of the query; it still
    // composes with every other filter and is still applied AFTER the tenant-scoped
    // projection, so visibility can never widen — FF-5).
    const query = parseProcessListQuery(req, actorSlug);

    // DB mode: serve ONLY real tenant-scoped projections (T-0301).
    if (hasDb() && startDeps) {
      let page: ProcessInstance[] = [];
      let total = 0;
      if (actorSlug) {
        try {
          const tenantId = await startDeps.resolveActorTenant(actorSlug);
          // Fold up to the full window (≤500, readEvents cap) so the filters/pagination
          // page over the real set, not an arbitrary slice.
          const projections = await listInstanceProjections(startDeps.pool, tenantId, { limit: 500 });
          // T-0722 (D-064, P2 из T-0714 — security/PDP): narrow the ALREADY tenant-scoped
          // `projections` to the READ-visibility of each instance's SOURCE RECORD — the
          // SAME single authority path (isRecordReadable) the DETAIL gate (T-0721) applies,
          // batched over the whole list (filterProjectionsByReadVisibility) instead of a
          // per-instance round-trip. Reuses the SAME startDeps.resolveReadVisibility
          // resolver DETAIL calls below (no new server.ts wiring). Honest-degrade (NF-2):
          // resolver absent → skip, byte-identical to pre-T-0722 tenant-scope-only.
          //
          // T-0654 [rebase+recompose]: this PDP narrowing runs FIRST — BEFORE the query
          // pipeline AND before any live-engine overlay — so parseProcessListQuery/
          // selectProcessPage filter/sort/paginate over the ALREADY PDP-visible set.
          // Therefore {total} = |PDP-visible ∩ query-match|, NOT the raw tenant count:
          // the pagination `total` cannot leak the number of instances the caller may not
          // see (the enumeration side-channel T-0722 closed stays closed under pagination).
          let visibleProjections = projections;
          if (startDeps.resolveReadVisibility) {
            const gateNowMs = Date.now();
            const { grants, ancestry } = await startDeps.resolveReadVisibility(
              actorSlug,
              tenantId,
              gateNowMs,
            );
            visibleProjections = await filterProjectionsByReadVisibility(
              startDeps.pool,
              tenantId,
              projections,
              grants,
              ancestry,
              gateNowMs,
            );
          }
          // Map the PDP-visible projections (cheap, no engine I/O yet) so the pure
          // pipeline filters/sorts/paginates over the visible set only.
          const allInstances = visibleProjections.map(projectionToInstance);
          const selected = selectProcessPage(allInstances, query);
          total = selected.total;

          // T-0709-R-P0-1: overlay the LIVE active node — but ONLY for the returned PAGE
          // (≤ limit engine reads), not all visible projections (FF-6). Input is drawn
          // from visibleProjections (post-PDP), so a hidden instance never reaches the
          // engine layer either. Re-map the overlaid projections and splice them back into
          // the page by id, preserving page order.
          const pageIds = new Set(selected.page.map((i) => i.id));
          const pageProjections = visibleProjections.filter((p) => pageIds.has(p.inst));
          const overlaid = await overlayDetailLiveSteps(startDeps.flowable, pageProjections);
          const overlaidByInst = new Map(overlaid.map((p) => [p.inst, projectionToInstance(p)]));
          const overlaidPage = selected.page.map((i) => overlaidByInst.get(i.id) ?? i);

          // T-0654: batch-resolve the starter NAME for the page (T-0648 resolver).
          page = await enrichStarterNames(overlaidPage, tenantId, startDeps.resolveActorsDisplay);
        } catch {
          // Read-projection: degrade gracefully to honest-empty — never 500.
          page = [];
          total = 0;
        }
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ instances: page, total, limit: query.limit, offset: query.offset }));
      return;
    }

    // No-DB / no-startDeps fallback: legacy display-plane path (FF-11).
    // T-0259: base may be null when the pack file is absent in the deployed
    // container. Degrade to graceful-empty so the endpoint never 500s.
    const base = findProcessInstances();
    if (base === null) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ instances: [], total: 0, limit: query.limit, offset: query.offset, demo: true }));
      return;
    }

    // T-0654: same pure pipeline over the seed/pack fixtures. The fixtures carry NO
    // recordId/starterId/startedAtMs, so ?record=/?mine= are honestly empty and the date
    // filter cannot judge them (they pass); ?q=/?definition=/?status=/pagination all work.
    const { page, total } = selectProcessPage(base, query);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ instances: page, total, limit: query.limit, offset: query.offset }));
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
            // T-0721 (D-064, P1 из T-0714 — security/PDP): DETAIL visibility
            // (variables/history/completedBy*/starter below) is INHERITED from the
            // READ-visibility of the instance's SOURCE RECORD — the same
            // isRecordReadable/resolveReadVisibility single authority path records.ts
            // already gates on (T-0570). Honest-degrade (NF-2): resolveReadVisibility
            // absent ⇒ skip, byte-identical to pre-T-0721. Record-less instances (no
            // recordId) are NEVER narrowed here (phase-1 scope — see process-projection.ts's
            // isInstanceDetailVisible doc-comment; process-def-scoped narrowing is a follow-up).
            // T-0721 resolves READ-visibility ONCE; T-0756 REUSES the SAME
            // {grants, ancestry} for the source-record projection's canOpen (no
            // second resolve). readVis stays undefined under honest-degrade.
            let detailVisible = true;
            let readVis:
              | { readonly grants: readonly Grant[]; readonly ancestry: AncestryOracle }
              | undefined;
            if (startDeps.resolveReadVisibility) {
              const gateNowMs = Date.now();
              const { grants, ancestry } = await startDeps.resolveReadVisibility(
                actorSlug,
                tenantId,
                gateNowMs,
              );
              readVis = { grants, ancestry };
              detailVisible = await isInstanceDetailVisible(
                startDeps.pool,
                tenantId,
                match.recordId,
                grants,
                ancestry,
                gateNowMs,
              );
            }
            // T-0756 [E16 §6, capstone T-0691 P1]: PARTICIPANT tier. A caller who
            // ACTS on this instance (holds its task role / acted on it / tenant
            // owner) but lacks source-record READ still gets the SKELETON + a SAFE
            // source-record projection (NO variables/history). Only computed when
            // the T-0721 DETAIL gate denied — a reader is already fully visible.
            // Single per-hop-ACL authority (isInstanceParticipant); no bespoke math.
            let participant = false;
            if (!detailVisible) {
              participant = await isInstanceParticipant(
                startDeps.pool,
                tenantId,
                instanceId,
                actorSlug,
                Date.now(),
              );
            }
            if (detailVisible || participant) {
              // T-0709-R-P0-1: overlay THIS instance's LIVE active node (step/role/
              // concurrentSteps) so the detail screen's node/nodes reflect the token's
              // real position — the SAME live source the catalog reads. Overlaying only
              // the matched projection keeps the fan-out at one engine call; a miss leaves
              // `match` byte-unchanged on its snapshot (overlayLiveSteps no-ops).
              const [displayMatch] = await overlayDetailLiveSteps(startDeps.flowable, [match]);
              const overlaid = displayMatch ?? match;
              // T-0756: the SAFE source-record projection (human title + type + honest
              // canOpen), delivered PRE-RESOLVED so RecordRef renders the title without a
              // records/:id fetch that would 404 → no raw-UUID fallback. canOpen reuses the
              // SAME READ-PDP grants/ancestry above + the sandbox gate — the link is offered
              // ONLY when GET /api/records/:id would actually 200 (never a dead «открыть»).
              let sourceRecord: SourceRecordProjection | null = null;
              if (match.recordId !== undefined) {
                sourceRecord = await resolveSourceRecordProjection(
                  startDeps.pool,
                  tenantId,
                  match.recordId,
                  actorSlug,
                  Date.now(),
                  readVis,
                );
              }
              const sourceRecordKey = sourceRecord !== null ? { sourceRecord } : {};
              if (detailVisible) {
                // T-0609: variables + detailed transition history, read from the SAME
                // Flowable client already threaded into startDeps. Best-effort: an engine
                // error degrades to empty arrays + historyAvailable:false, never a 500.
                //
                // T-0654 [part A / UX-study §5.3, rebase+recompose]: pass the starter id so
                // the starter NAME for «Запущен: <Имя>» resolves in the SAME single batch as
                // the step completers (no extra query — T-0648 one-call-per-request invariant
                // kept). CRITICAL: this whole body — INCLUDING the starter resolve — runs ONLY
                // inside `if (detailVisible)`, so no raw variables/history/completedBy AND no
                // starter identity is ever resolved or emitted for a PDP-hidden instance
                // (the T-0721 P1 gate is preserved around the added starter-fold).
                const { starterDisplay, ...historyDetail } = await fetchInstanceHistoryDetail(
                  startDeps.flowable,
                  match.inst,
                  tenantId,
                  startDeps.resolveActorsDisplay,
                  overlaid.starterActorId,
                );
                const detailInstance = projectionToInstance(overlaid);
                const withStarter = starterDisplay
                  ? { ...detailInstance, starterName: starterDisplay.name, starterType: starterDisplay.type }
                  : detailInstance;
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ...withStarter, ...historyDetail, ...sourceRecordKey }));
                return;
              }
              // T-0756 PARTICIPANT SKELETON: status/step/progress/starter (the inbox
              // already shows a participant these — T-0750 precedent) + the safe
              // source-record projection. NO variables/history/completedBy* — those
              // stay reader-only, so the T-0721 threat surface is UNCHANGED for a
              // participant who cannot READ the source record.
              const detailInstance = projectionToInstance(overlaid);
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ...detailInstance, ...sourceRecordKey }));
              return;
            }
            // else: fall through to the honest 404 below (T-0570 precedent,
            // records.ts:2059-2071) — indistinguishable from not-found, never
            // reveals that a hidden instance exists (FR-5-style non-disclosure).
          }
        } catch {
          // Read-projection: degrade gracefully — fall through to 404 (never 500).
        }
      }
      // DB mode + no matching real instance (OR denied by the READ-visibility
      // gate above) ⇒ 404 (the seed fixture is NOT served to real authenticated
      // tenants; T-0301 mock-leak invariant).
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
