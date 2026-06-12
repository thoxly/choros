/**
 * src/http/audit.ts
 *
 * Read-API for instance audit trace (GET /api/audit and GET /api/audit/:instanceId).
 * Export-API: GET /api/audit/export — download audit log as JSON file (T-0138).
 * In-memory seed data with audit events timeline for a single instance.
 * Zero external dependencies — only node:http types and router.ts.
 *
 * T-0138 export write-path:
 *   GET /api/audit/export?instance=<id>  — download named instance as JSON.
 *   GET /api/audit/export                — download default instance (INS-7731).
 *   Authz: x-dev-user header required in dev mode (401 if absent).
 *   PDP gate: same principal as GET /api/audit (observer role assumed for day-1
 *   seed; production gates via PDP grant check — forward obligation annotated
 *   inline as FORWARD-OBLIGATION comment).
 *   Response: 200 application/json + Content-Disposition: attachment filename.
 */
import { HttpError, type Router } from "./router.js";
import { JobStore } from "../core/jobStore.js";
import { DEV_USER_HEADER } from "./auth.js";

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

  // GET /api/audit/export — download audit log as JSON file (T-0138).
  //
  // MUST be registered BEFORE GET /api/audit/:instanceId to prevent "export"
  // from being captured as an instanceId param.
  //
  // Query params:
  //   ?instance=<id>  — export a specific instance (404 if not found)
  //   (absent)        — export the default instance (INS-7731)
  //
  // Authz: x-dev-user header required (dev mode); 401 if absent.
  //   FORWARD-OBLIGATION: production route MUST check PDP for
  //   operation=read on resource=audit_trace before returning data.
  //
  // Response: 200 application/json + Content-Disposition: attachment.
  router.register("GET", "/api/audit/export", async (req, res) => {
    // Dev-mode auth gate: require x-dev-user header
    let devUser = req.headers[DEV_USER_HEADER];
    if (Array.isArray(devUser)) devUser = devUser[0];
    if (!devUser || typeof devUser !== "string") {
      throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
    }

    // Parse optional ?instance= query param
    const rawUrl = req.url ?? "/";
    const questionIdx = rawUrl.indexOf("?");
    const qs = questionIdx === -1 ? "" : rawUrl.slice(questionIdx + 1);
    const params = new URLSearchParams(qs);
    const instanceId = params.get("instance") ?? null;

    let data: AuditData;
    if (instanceId !== null && instanceId !== "") {
      const found = findAuditData(instanceId);
      if (!found) {
        throw new HttpError(404, "NOT_FOUND", "instance not found");
      }
      data = found;
    } else {
      data = getDefaultAuditInstance();
    }

    const filename = `audit-${data.instance.id}-${Date.now()}.json`;
    const body = JSON.stringify(data, null, 2);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.end(body);
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
