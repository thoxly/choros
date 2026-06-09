/**
 * src/http/audit.ts
 *
 * Read-API for instance audit trace (GET /api/audit and GET /api/audit/:instanceId).
 * In-memory seed data with audit events timeline for a single instance.
 * Zero external dependencies — only node:http types and router.ts.
 */
import { HttpError, type Router } from "./router.js";
import { JobStore } from "../core/jobStore.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditEvent = {
  ts: string;
  type: "human" | "agent" | "service";
  actor: string;
  action: string;
  target?: string | null;
  tag?: string | null;
  tool?: boolean;
  meta?: {
    dur: string;
    tok: string;
    cost: string;
  };
  payload?: {
    call: string;
    out: string;
  };
  pending?: boolean;
};

export type AuditTraceStep = {
  node: string;
  name: string;
  events: AuditEvent[];
};

export type AuditInstance = {
  process: string;
  procId: string;
  id: string;
  status: "running" | "waiting" | "failed" | "done" | "paused";
  started: string;
  elapsed: string;
  node: string;
  execs: string[];
  budget: Array<{
    label: string;
    used: number;
    total: number;
    unit: string;
    money?: boolean;
  }>;
};

export type AuditData = {
  instance: AuditInstance;
  trace: AuditTraceStep[];
};

// ---------------------------------------------------------------------------
// In-memory seed fixture (copied verbatim from screen-audit.jsx)
// ---------------------------------------------------------------------------

const AUDIT_SEED: Record<string, AuditData> = {
  "INS-7731": {
    instance: {
      process: "Согласование счёта поставщика",
      procId: "PRC-INV-APPROVE",
      id: "INS-7731",
      status: "running",
      started: "07.06.2026 14:28:11",
      elapsed: "00:06:42",
      node: "n7 · Утверждение платежа",
      execs: ["service", "agent", "human"],
      budget: [
        { label: "Токены инстанса", used: 148920, total: 250000, unit: "ткн" },
        { label: "Стоимость", used: 11800, total: 12480, unit: "₽", money: true },
      ],
    },
    trace: [
      {
        node: "n1",
        name: "Старт · поступление счёта",
        events: [
          {
            ts: "14:28:11.004",
            type: "service",
            actor: "ledger-sync",
            action: "зарегистрировал входящий счёт",
            target: "DOC-4471",
            tag: "ok",
          },
          {
            ts: "14:28:11.182",
            type: "service",
            actor: "ocr-gateway",
            action: "вызвал инструмент",
            target: "mcp://ocr.extract",
            tag: "mcp",
            tool: true,
            meta: { dur: "1 284 мс", tok: "— ткн", cost: "₽4.10" },
            payload: {
              call: "ocr.extract(file=invoice_4471.pdf, lang=ru)",
              out: '{ supplier: "ООО Вектор", amount: 184000, vat: 30667, date: "2026-06-05" }',
            },
          },
        ],
      },
      {
        node: "n3",
        name: "Проверка реквизитов",
        events: [
          {
            ts: "14:28:13.560",
            type: "agent",
            actor: "Счёт-агент",
            action: "начал задачу",
            target: "TSK-0091",
            tag: null,
          },
          {
            ts: "14:28:14.902",
            type: "agent",
            actor: "Счёт-агент",
            action: "вызвал инструмент",
            target: "mcp://contracts.lookup",
            tag: "mcp",
            tool: true,
            meta: { dur: "612 мс", tok: "2 480 ткн", cost: "₽1.90" },
            payload: {
              call: 'contracts.lookup(supplier="ООО Вектор")',
              out: '{ contract: "ДГ-2231", limit: 250000, status: "active" }',
            },
          },
          {
            ts: "14:28:16.071",
            type: "agent",
            actor: "Счёт-агент",
            action: "вызвал инструмент",
            target: "mcp://ledger.invoices",
            tag: "mcp",
            tool: true,
            meta: { dur: "338 мс", tok: "1 120 ткн", cost: "₽0.80" },
            payload: {
              call: 'ledger.invoices.match(amount=184000, contract="ДГ-2231")',
              out: "{ match: true, duplicate: false }",
            },
          },
          {
            ts: "14:28:17.430",
            type: "agent",
            actor: "Счёт-агент",
            action: "вынес решение: реквизиты корректны, в пределах лимита договора",
            target: null,
            tag: "ok",
          },
        ],
      },
      {
        node: "n5",
        name: "Сверка с договором",
        events: [
          {
            ts: "14:30:02.118",
            type: "human",
            actor: "А. Кравцова",
            action: "приняла задачу из пула",
            target: "TSK-0092",
            tag: null,
          },
          {
            ts: "14:31:48.640",
            type: "human",
            actor: "А. Кравцова",
            action: "подтвердила сверку, оставила комментарий",
            target: null,
            tag: "ok",
            meta: { dur: "1 м 46 с", tok: "—", cost: "—" },
            payload: {
              call: "комментарий оператора",
              out: "«Сумма НДС совпадает с актом. К оплате.»",
            },
          },
        ],
      },
      {
        node: "n7",
        name: "Утверждение платежа",
        events: [
          {
            ts: "14:31:50.002",
            type: "agent",
            actor: "Счёт-агент",
            action: "запросил инициацию платежа",
            target: "mcp://payments.initiate",
            tag: "mcp",
            tool: true,
            meta: { dur: "—", tok: "840 ткн", cost: "₽0.60" },
            payload: {
              call: "payments.initiate(amount=184000, ccy=RUB)",
              out: '{ error: "AMOUNT_OVER_AUTONOMY", limit: 50000 }',
            },
          },
          {
            ts: "14:31:50.214",
            type: "agent",
            actor: "Счёт-агент",
            action: "превысил порог автономии — эскалация",
            target: "₽184 000 > ₽50 000",
            tag: "esc",
          },
          {
            ts: "14:31:50.330",
            type: "service",
            actor: "control-plane",
            action: "создал задачу утверждения и назначил",
            target: "Е. Ларина",
            tag: "budget",
            meta: { dur: "—", tok: "—", cost: "—" },
            payload: {
              call: 'escalate(to="Е. Ларина", role="Финансовый директор")',
              out: '{ task: "TSK-0093", sla_min: 480 }',
            },
          },
          {
            ts: "14:34:53.770",
            type: "human",
            actor: "Е. Ларина",
            action: "ожидает решения по утверждению платежа",
            target: "TSK-0093",
            tag: null,
            pending: true,
          },
        ],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Data accessors
// ---------------------------------------------------------------------------

function findAuditData(instanceId: string): AuditData | null {
  return AUDIT_SEED[instanceId] || null;
}

export function getDefaultAuditInstance(): AuditData {
  return AUDIT_SEED["INS-7731"]!;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAuditRoutes(router: Router, _store?: JobStore): void {
  // GET /api/audit — return default instance (INS-7731)
  router.register("GET", "/api/audit", async (_req, res) => {
    const data = getDefaultAuditInstance();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  });

  // GET /api/audit/:instanceId — return specific instance or 404
  router.register("GET", "/api/audit/:instanceId", async (_req, res, params) => {
    const data = findAuditData(params.instanceId as string);
    if (!data) {
      throw new HttpError(404, "NOT_FOUND", "instance not found");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  });
}
