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
 *   PDP gate: NONE in dev slice — all three audit routes (GET /api/audit,
 *   GET /api/audit/:instanceId, GET /api/audit/export) run without a PDP
 *   grant check. Hardening MUST close all three before production: add
 *   PDP operation=read on resource=audit_trace for each route (see
 *   FORWARD-OBLIGATION comments inline).
 *   Response: 200 application/json + Content-Disposition: attachment filename.
 */
import { HttpError, type Router } from "./router.js";
import { JobStore } from "../core/jobStore.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import {
  runDemoLegalPrecheck,
  demoApproveDenied,
  buildLegalPrecheckSliceView,
  type LegalPrecheckSliceView,
} from "../runtime/legal-precheck/demo-run.js";

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
// T-0234 DEMO-3 — INS-TEL-DEMO: the linear ТЭЛ demo instance whose S3 node
// renders the ACTUAL legal_precheck agent outcome (runLegalPrecheck via the
// deterministic demo stub port — zero paid LLM) + the moat event (the agent's
// attempt to approve → PDP-deny). This is an AUDIT instance, NOT a
// process_instances/rights_cards row, so FF-PACK-2 (8/8) is untouched.
//
// Built lazily on first request and memoized: the demo run is async (motor) but
// deterministic, so the trace is identical every time. D-139: only the safe
// answer + an OPAQUE reasoning_trace_ref reach the slice — never raw reasoning.
// ---------------------------------------------------------------------------

export const TEL_DEMO_INSTANCE_ID = "INS-TEL-DEMO";

/** Render the legal-precheck red-flags answer as a compact slice payload string. */
function redFlagsSummary(view: LegalPrecheckSliceView): string {
  if (view.kind !== "proceed" || view.redFlags.length === 0) {
    return view.note ?? "(нет red-flags)";
  }
  return view.redFlags.map((f) => `${f.clause} [${f.severity}]`).join("; ");
}

let telDemoCache: AuditData | null = null;

async function buildTelDemoInstance(): Promise<AuditData> {
  // Run the legal-precheck agent (S3 actor) deterministically with the stub port.
  const run = await runDemoLegalPrecheck("live-stub");
  const view = buildLegalPrecheckSliceView(run.outcome);
  // Probe the moat: the agent CANNOT approve (PDP-deny).
  const moat = await demoApproveDenied();

  const data: AuditData = {
    instance: {
      process: "Согласование договора (линейный ТЭЛ — демо)",
      procId: "PRC-TEL-DEMO",
      id: TEL_DEMO_INSTANCE_ID,
      status: "waiting",
      started: "15.06.2026 10:00:00",
      elapsed: "00:00:03",
      node: "S3 · Юр-предпроверка → S4 · Согласование",
      execs: ["human", "agent"],
      budget: [
        { label: "Токены инстанса", used: 0, total: 250000, unit: "ткн" },
        { label: "Стоимость LLM", used: 0, total: 0, unit: "₽", money: true },
      ],
    },
    trace: [
      {
        node: "S1",
        name: "Подача · заявка на закупку услуги",
        events: [
          {
            ts: "10:00:00.100",
            type: "human",
            actor: "Орлов (инициатор)",
            action: "подал заявку",
            target: "договор оказания услуг · 5 500 000 ₽",
            tag: "ok",
          },
        ],
      },
      {
        node: "S2",
        name: "Триаж · классификация (слот intake, T-0219)",
        events: [
          {
            ts: "10:00:01.200",
            type: "agent",
            actor: "Заявка-агент",
            action: "классифицировал заявку и вывел маршрут",
            target: "service_agreement · BUD-14 · сумма ≥ 5 млн → юр-предпроверка",
            tag: "ok",
          },
        ],
      },
      {
        node: "S3",
        name: "Юр-предпроверка · АГЕНТ (слот legal_precheck, T-0234 / мотор T-0233)",
        events: [
          {
            ts: "10:00:02.000",
            type: "agent",
            actor: "Юр-агент (legal_precheck)",
            action: `провёл юр-предпроверку → ${view.kind}`,
            target: view.reasoningTraceRef,
            tag: view.kind === "proceed" ? "ok" : "esc",
            tool: true,
            meta: { dur: "—", tok: "0 ткн (stub)", cost: "₽0.00" },
            payload: {
              call: `runLegalPrecheck(dealContext=${view.dealSummary})`,
              out: redFlagsSummary(view),
            },
          },
          {
            // The MOAT: the agent attempts to approve → PDP-deny. The agent role
            // has no `approve` grant; approve stays a human card-action (S4).
            ts: "10:00:02.300",
            type: "agent",
            actor: "Юр-агент (legal_precheck)",
            action: "попытка «Согласовать» → отказ PDP (нет гранта approve)",
            target: moat.denied ? `PDP-deny: ${moat.reason ?? "no_grant"}` : "(moat broken!)",
            tag: "esc",
          },
        ],
      },
      {
        node: "S4",
        name: "Согласование · ЧЕЛОВЕК (card-action approve)",
        events: [
          {
            ts: "10:00:03.000",
            type: "human",
            actor: "Е. Ларина (финконтролёр)",
            action: "ожидает решения по согласованию (approve = человек)",
            target: "card-action approve",
            tag: null,
            pending: true,
          },
        ],
      },
    ],
  };
  return data;
}

/** Lazily build + memoize the deterministic demo ТЭЛ instance. */
export async function getTelDemoInstance(): Promise<AuditData> {
  if (telDemoCache === null) {
    telDemoCache = await buildTelDemoInstance();
  }
  return telDemoCache;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAuditRoutes(router: Router, _store?: JobStore): void {
  // GET /api/audit — return default instance (INS-7731)
  //
  // FORWARD-OBLIGATION: no PDP gate in dev slice. Hardening MUST add
  // PDP check: operation=read, resource=audit_trace before returning data.
  router.register("GET", "/api/audit", withAuth(async (_req, res) => {
    const data = getDefaultAuditInstance();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  }));

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
  //   FORWARD-OBLIGATION: no PDP gate in dev slice. Hardening MUST add
  //   PDP check: operation=read, resource=audit_trace before returning data.
  //   (Same obligation applies to GET /api/audit and GET /api/audit/:instanceId
  //   — all three routes must be closed together in the hardening pass.)
  //
  // Response: 200 application/json + Content-Disposition: attachment.
  router.register("GET", "/api/audit/export", withAuth(async (req, res) => {
    // Mode-aware actor resolution (T-0327): keycloak → JWT sub validated by withAuth;
    // dev → x-dev-user. Actor is resolved for audit but not used further (access check only).
    const _authCtx = getAuthContext(req);
    if (_authCtx === undefined) {
      // Dev mode — verify x-dev-user is present (same as before).
      let devUser = req.headers[DEV_USER_HEADER];
      if (Array.isArray(devUser)) devUser = devUser[0];
      if (!devUser || typeof devUser !== "string") {
        throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
      }
    }

    // Parse optional ?instance= query param
    const rawUrl = req.url ?? "/";
    const questionIdx = rawUrl.indexOf("?");
    const qs = questionIdx === -1 ? "" : rawUrl.slice(questionIdx + 1);
    const params = new URLSearchParams(qs);
    const instanceId = params.get("instance") ?? null;

    let data: AuditData;
    if (instanceId !== null && instanceId !== "") {
      const found =
        instanceId === TEL_DEMO_INSTANCE_ID
          ? await getTelDemoInstance()
          : findAuditData(instanceId);
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
  }));

  // GET /api/audit/:instanceId — return specific instance or 404
  //
  // FORWARD-OBLIGATION: no PDP gate in dev slice. Hardening MUST add
  // PDP check: operation=read, resource=audit_trace before returning data.
  router.register("GET", "/api/audit/:instanceId", withAuth(async (_req, res, params) => {
    const instanceId = params.instanceId as string;
    // T-0234: the demo ТЭЛ instance is built lazily (async motor run, stub port).
    const data =
      instanceId === TEL_DEMO_INSTANCE_ID
        ? await getTelDemoInstance()
        : findAuditData(instanceId);
    if (!data) {
      throw new HttpError(404, "NOT_FOUND", "instance not found");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  }));
}
