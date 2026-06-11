/**
 * src/http/processes.ts
 *
 * Read-API for process instances (GET /api/processes).
 * In-memory seed data with process instance list matching screen-processes.jsx shape.
 * T-0141: when DATABASE_URL is set, serves process_instances from showcase pack file
 * (pack-serve.ts). PROCESSES_SEED remains as no-DB fallback (I-2 / spec §4.5).
 * Zero pg / src/db/* imports (FF-DISPLAY-4).
 */
import { HttpError, type Router } from "./router.js";
import { JobStore } from "../core/jobStore.js";
import { loadShowcasePack } from "./pack-serve.js";

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

function findProcessInstances(): ProcessInstance[] {
  if (hasDb()) {
    // T-0141: serve from single source (pack file) when DB-backed mode active.
    // process_instances pack shape = ProcessInstance type (T-0140 ADR §3.10).
    const pack = loadShowcasePack();
    return pack.process_instances as ProcessInstance[];
  }
  return PROCESSES_SEED;
}

function findProcessInstance(instanceId: string): ProcessInstance | null {
  return findProcessInstances().find((p) => p.id === instanceId) || null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerProcessesRoutes(
  router: Router,
  _store?: JobStore
): void {
  // GET /api/processes — return full process instances list
  router.register("GET", "/api/processes", async (_req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ instances: findProcessInstances() }));
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
