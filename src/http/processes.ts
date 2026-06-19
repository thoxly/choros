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
import { withAuth } from "./auth.js";
import { JobStore } from "../core/jobStore.js";
import { tryLoadShowcasePack } from "./pack-serve.js";
import { makeStartInstanceHandler, type StartInstanceDeps } from "./process-start.js";
import {
  listInstanceProjections,
  type InstanceProjection,
} from "./process-projection.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProcessInstance = {
  id: string;
  name: string;
  procId: string;
  status: "running" | "waiting" | "done" | "failed";
  node: string;
  started: string;
  elapsed: string;
  progress: { done: number; total: number };
  execs: ("human" | "agent" | "service")[];
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
  // Linear ТЭЛ progress: waiting at U4 ⇒ 2/3 nodes done; done ⇒ 3/3.
  const progress = p.status === "done" ? { done: 3, total: 3 } : { done: 2, total: 3 };
  return {
    id: p.inst,
    name: "Канонический линейный ТЭЛ",
    procId: p.procKey,
    status: p.status === "running" ? "running" : p.status, // running|waiting|done
    node: p.step,
    started,
    elapsed: "—",
    progress,
    execs: ["human", "agent"],
  };
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
    router.register("POST", "/api/processes/start", withAuth(makeStartInstanceHandler(startDeps)));
  }

  // GET /api/processes — return full process instances list. When start-deps are
  // present (DB-backed), merge the started-instance projections (T-0282 §2.3) over
  // the pack/seed display rows so a started ТЭЛ instance is visible (AC-1) and shows
  // `done` after approve (AC-6). Tenant-scoped via the injected resolver; degrades
  // gracefully to display-only on any projection error (read-only path).
  router.register("GET", "/api/processes", async (req, res) => {
    // T-0259: base may be null when DATABASE_URL is set but the pack file is
    // absent (container without seed dir). Degrade to graceful-empty so the
    // endpoint never 500s. The `demo: true` marker lets the frontend distinguish
    // "no data yet" from an error.
    const base = findProcessInstances();
    if (base === null) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ instances: [], demo: true }));
      return;
    }

    let merged = base;

    if (startDeps) {
      let devUserId = req.headers["x-dev-user"];
      if (Array.isArray(devUserId)) devUserId = devUserId[0];
      if (typeof devUserId === "string" && devUserId) {
        try {
          const tenantId = await startDeps.resolveActorTenant(devUserId);
          const projections = await listInstanceProjections(startDeps.pool, tenantId);
          const seen = new Set(base.map((i) => i.id));
          const extra = projections
            .filter((p) => !seen.has(p.inst))
            .map(projectionToInstance);
          merged = [...base, ...extra];
        } catch {
          merged = base; // read-only projection — never fail the display GET.
        }
      }
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ instances: merged }));
  });

  // GET /api/processes/:id — return specific instance or 404
  router.register("GET", "/api/processes/:id", async (_req, res, params) => {
    const instance = findProcessInstance(params.id as string);
    if (!instance) {
      throw new HttpError(404, "NOT_FOUND", "instance not found");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(instance));
  });
}
