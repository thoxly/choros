/**
 * src/http/audit.ts
 *
 * Read-API for the audit log.
 *
 *   GET /api/audit              — T-0500: the REAL tenant-wide hash-chained audit
 *                                 log (choros.audit_event), tenant-scoped + REDACTED
 *                                 + keyset-paginated + authz-gated. Replaces the
 *                                 former in-memory "Счёт-агент" demo timeline.
 *   GET /api/audit/:instanceId  — demo instance trace (in-memory seed). Data shape
 *                                 UNCHANGED since T-0234; authz gate ADDED (T-0737).
 *   GET /api/audit/export       — download a demo instance as JSON (T-0138). Data
 *                                 shape UNCHANGED; authz gate ADDED (T-0737).
 *
 * T-0500 (the reality-gap fix): `GET /api/audit` used to return a hardcoded in-memory
 * timeline ({instance, trace}) that had NOTHING to do with the real audit_log. It now
 * reads the genuine append-only, hash-chained audit the writer produces, scoped to the
 * CALLER's tenant, redacted at the projection boundary (raw payload/scope NEVER egress),
 * behind a conservative owner/admin gate (the whole tenant's audit is sensitive).
 * Response shape: { events: AuditLogItem[], nextCursor } — the flat, paginated list the
 * audit screen now consumes. The instance-trace demo routes serve different (fixture)
 * data — a different, instance-scoped surface used by the process-instance demo — but
 * are gated by the SAME authority policy (see T-0737 below).
 *
 * SECURITY (the spine of this read — it is audit EXPOSURE):
 *   • authz   — genesis-owner ONLY (T-0500 review: mgmt_object:* grant must not open
 *               the whole journal). 401 if unauthenticated, 403 otherwise.
 *   • tenant  — withTenantTx (SET LOCAL choros.tenant_id + FORCE RLS) AND a literal
 *               WHERE tenant_id = $1 in the SELECT (defence-in-depth). Tenant comes
 *               from the ACTOR's resolved identity, NEVER from the request.
 *   • redact  — readAuditLog projects an allow-list ONLY (id/ts/actor/action/summary/
 *               safe-target). Raw payload/scope/subject free-text is dropped in the DAO.
 *   • filters — optional ?actor= / ?action= are bound as parameters ($N), never
 *               interpolated (injection-safe; LIKE wildcards neutralised).
 *
 * T-0737 (security/P1, closes a forward obligation this file carried since T-0138/
 * T-0500): GET /api/audit/export and GET /api/audit/:instanceId used to have NO
 * PDP/authority gate at all — export required only an x-dev-user header (any tenant
 * member, or in keycloak mode any authenticated caller), and :instanceId required
 * NOTHING (dev-mode auth is a no-op; no per-route check either). A T-0726 judge
 * finding (R-3, on T-0702) confirmed a live-but-deactivated actor's residual JWT
 * (~300s window; KC session revocation cannot shrink an already-issued access token)
 * would read all three routes unfiltered. All three now share ONE gate —
 * requireAuditRead() — the SAME loadAdminContext + genesis-owner-only policy as the
 * pre-existing /api/audit gate. See requireAuditRead()'s doc comment for why the
 * gate is a shared FUNCTION (not inlined per-route) and how that interacts with
 * ci/checks/actor-active-route-coverage.sh (ADR-T0726).
 *
 * Export-API (T-0138, demo instance) write-path:
 *   GET /api/audit/export?instance=<id>  — download named instance as JSON.
 *   GET /api/audit/export                — download default instance (INS-7731).
 *   Authz: requireAuditRead() (T-0737) — genesis-owner only, same as /api/audit.
 *
 * T-0733 (R-1 из ревью T-0712, столп 4 анти-UUID): `department.moved`/
 * `position.moved` targets used to stay a bare id (MonoId) — T-0712 explicitly
 * punted the node-name resolver as a follow-up ("резолвер имён department/
 * position не существует в кодовой базе"). This module now batch-resolves
 * those ids too, through node-resolver.ts (the ORG-TREE-NODE sibling of
 * actor-resolver.ts) — same O(1)-query-per-page discipline, folded into the
 * SAME response pass as the T-0648 actor batch below.
 *
 * T-0769 (столп 4 анти-UUID, same acknowledged baseline T-0712/T-0733 closed
 * for actors/nodes): `record.create` (and its siblings `record.update` /
 * `record.deleted`) targets are RECORD ids — resolved through
 * record-resolver.ts (the THIRD sibling: actor-resolver.ts for employees,
 * node-resolver.ts for org-tree nodes, record-resolver.ts for records), same
 * O(1)-query-per-page discipline, folded into the SAME response pass.
 */
import pg from "pg";
import { HttpError, type Router } from "./router.js";
import { JobStore } from "../core/jobStore.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import {
  resolveActorSlugFromAuth,
  resolveActorTenant,
  loadAdminContext,
} from "../db/org.js";
import type { AdminContext } from "../core/scoped-admin.js";
import type { PgClientLike } from "../db/audit-writer.js";
import {
  readAuditLog,
  decodeAuditCursor,
  type AuditLogCursor,
} from "../db/audit-read-dao.js";
import { batchResolveActors, resolveActorDisplay, type ResolvedActor } from "../db/actor-resolver.js";
import { batchResolveOrgNodes, resolveNodeDisplay, type ResolvedNode } from "../db/node-resolver.js";
import { batchResolveRecords, resolveRecordDisplay, type ResolvedRecord } from "../db/record-resolver.js";
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

// ===========================================================================
// T-0500 — REAL tenant-wide audit log read (GET /api/audit).
// ===========================================================================

const AUDIT_DEFAULT_LIMIT = 30;
const AUDIT_MAX_LIMIT = 100;

/**
 * Mode-aware caller identity (mirrors agents.ts::extractActor / process-defs.ts).
 *   - keycloak: identity from the VALIDATED token (sub/preferred_username → slug); null
 *     → 401 fail-closed. x-dev-user is NOT consulted once a token authenticated.
 *   - dev: getAuthContext is undefined (withAuth no-op) → x-dev-user.
 */
async function extractActor(
  req: import("node:http").IncomingMessage,
  pool: pg.Pool,
): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

/** withTenantTx — read-path tenant scoping (SET LOCAL choros.tenant_id + RLS), mirrors agents.ts. */
async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
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

/**
 * The audit-read gate. The WHOLE tenant's audit is sensitive (it carries the entire
 * org's actions, including grants, auth events, agent decisions), so the gate is
 * OWNER-ONLY (T-0500 review): a mgmt_object:* grant covers a SINGLE object type
 * (department/position/employee) and MUST NOT open the entire journal.
 *
 * Аудит всего тенанта — owner-only (T-0500 review): mgmt-грант на один объект НЕ
 * должен открывать весь журнал. Расширение (напр. dedicated audit:read грант или
 * admin-ярус) — отдельным founder-решением.
 */
function holdsAuditRead(admin: AdminContext): boolean {
  return admin.isGenesisOwner;
}

/**
 * T-0737 — the SINGLE shared authority gate for ALL THREE audit-surface GET
 * routes registered below: the REAL tenant-wide journal (T-0500) AND the two
 * legacy demo routes (GET /api/audit/export, GET /api/audit/:instanceId —
 * T-0138/T-0234). Those two used to carry only AUTHENTICATION (withAuth /
 * an x-dev-user presence check) with NO authorization at all — the file's own
 * "FORWARD-OBLIGATION" comment flagged this and explicitly required closing
 * all three together (T-0726 judge finding on T-0702's R-3: a live-but-
 * deactivated actor's residual JWT window would otherwise read the entire
 * audit surface unfiltered). This reuses the EXACT SAME resolver + policy as
 * the pre-existing /api/audit gate (loadAdminContext + holdsAuditRead,
 * genesis-owner ONLY) — no second authority path.
 *
 * Fail-closed at every step: unresolved/unauthenticated identity -> 401/403
 * from extractActor / resolveActorTenant; insufficient authority -> 403
 * ADMIN_GATE_REJECTED. Callers MUST check `pool !== undefined` first (503
 * AUDIT_UNAVAILABLE) — this function needs a live DB connection to resolve
 * the caller's admin context and cannot fail open when one is absent.
 *
 * NOTE for readers of ci/checks/actor-active-route-coverage.sh (ADR-T0726):
 * this is a module-scope helper defined BEFORE registerAuditRoutes' first
 * `.register(` call, so its `loadAdminContext` reference is invisible to that
 * gate's block-scoped text scan (§2.4 limitation #1 — the SAME class of gap
 * notification-prefs.ts's `checkAdminGrant` wrapper already has). All three
 * call sites below are hand-verified and whitelisted under ROUTE_WHITELIST §D
 * with a citation to this function — do NOT "fix" the scan gap by duplicating
 * this gate inline per-route; that would triple the surface for any future
 * change to the audit-read authority policy.
 */
async function requireAuditRead(
  pool: pg.Pool,
  req: import("node:http").IncomingMessage,
): Promise<{ actorId: string; tenantId: string }> {
  const actorId = await extractActor(req, pool);
  const tenantId = await resolveActorTenant(pool, actorId);
  const admin = await loadAdminContext(pool, tenantId, actorId, Date.now());
  if (!holdsAuditRead(admin)) {
    throw new HttpError(
      403,
      "ADMIN_GATE_REJECTED",
      "insufficient authority to read the tenant audit log",
    );
  }
  return { actorId, tenantId };
}

/** Parse ?limit= / ?cursor= / ?actor= / ?action= for the audit list. */
function parseAuditQuery(req: import("node:http").IncomingMessage): {
  limit: number;
  cursor: AuditLogCursor | null;
  actor: string | null;
  action: string | null;
} {
  const rawUrl = req.url ?? "";
  const qIdx = rawUrl.indexOf("?");
  const sp = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "");

  let limit = AUDIT_DEFAULT_LIMIT;
  const rawLimit = sp.get("limit");
  if (rawLimit !== null) {
    const parsed = parseInt(rawLimit, 10);
    if (!isNaN(parsed)) {
      limit = Math.min(Math.max(1, parsed), AUDIT_MAX_LIMIT);
    }
  }

  const rawCursor = sp.get("cursor");
  const cursor = rawCursor !== null ? decodeAuditCursor(rawCursor) : null;

  // Filters are bound as PARAMETERS downstream — capture raw values (trimmed, capped).
  const actorRaw = sp.get("actor");
  const actor = actorRaw !== null && actorRaw.trim() !== "" ? actorRaw.trim().slice(0, 128) : null;
  const actionRaw = sp.get("action");
  const action = actionRaw !== null && actionRaw.trim() !== "" ? actionRaw.trim().slice(0, 64) : null;

  return { limit, cursor, actor, action };
}

/**
 * GET /api/audit?limit=&cursor=&actor=&action= — the REAL tenant-wide audit log.
 *
 * Response: { events: [{ id, ts, actor, action, summary, target }], nextCursor }
 */
async function handleGetAuditLog(
  pool: pg.Pool,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  // Authz — requireAuditRead resolves actor+tenant and requires owner authority
  // (loadAdminContext, own tx, no side-effect) BEFORE the read tx. Fail-closed.
  const { tenantId } = await requireAuditRead(pool, req);
  const { limit, cursor, actor, action } = parseAuditQuery(req);

  const page = await withTenantTx(pool, tenantId, async (client) =>
    readAuditLog(
      client as unknown as PgClientLike,
      tenantId,
      limit,
      cursor,
      { actor, action },
    ),
  );

  // T-0648 (W4-UX/столп 4): batch-resolve every DISTINCT actor id on this page in ONE
  // query (batchResolveActors) — not a per-row lookup. A resolver failure degrades to
  // an empty map (every item then falls back to resolveActorDisplay's honest fallback
  // shape — raw id as name, resolved:false), never turning a redacted read into a 500.
  //
  // T-0712: `employee.moved` rows also carry a `target` that is itself an employee id
  // (the person who got moved — audit-read-dao.ts falls back to the writer's `subject`
  // column for the three org-move `.moved` types). That id is resolvable through the
  // SAME employee table/batch query — folded into the SAME single round-trip rather
  // than a second query, so the "who got moved" chip is a real human name too, not
  // just a bare id.
  const distinctActors = new Set(page.items.map((item) => item.actor));
  for (const item of page.items) {
    if (item.action === "employee.moved" && item.target) distinctActors.add(item.target);
  }
  let actorResolved: Map<string, ResolvedActor> = new Map();
  if (distinctActors.size > 0) {
    try {
      actorResolved = await batchResolveActors(pool, tenantId, [...distinctActors]);
    } catch {
      actorResolved = new Map();
    }
  }

  // T-0733 (R-1 из ревью T-0712): `department.moved`/`position.moved` targets are
  // ORG-TREE NODES, not employees — resolved through the SEPARATE node-resolver.ts
  // batch (department/position are different tables from employee, so they cannot
  // share batchResolveActors' query). Same failure discipline as the actor batch
  // above: a resolver error degrades to an empty map, never a 500.
  const distinctDeptIds = new Set<string>();
  const distinctPosIds = new Set<string>();
  for (const item of page.items) {
    if (item.action === "department.moved" && item.target) distinctDeptIds.add(item.target);
    if (item.action === "position.moved" && item.target) distinctPosIds.add(item.target);
  }
  let nodeResolved: Map<string, ResolvedNode> = new Map();
  if (distinctDeptIds.size > 0 || distinctPosIds.size > 0) {
    try {
      nodeResolved = await batchResolveOrgNodes(pool, tenantId, [...distinctDeptIds], [...distinctPosIds]);
    } catch {
      nodeResolved = new Map();
    }
  }

  // T-0769 (столп 4 анти-UUID): `record.create`/`record.update`/`record.deleted`
  // targets are RECORD ids — audit-read-dao.ts's `safeTarget` falls back to the
  // writer's `record_id` payload key for every `record.*` type (records.ts /
  // form-record-persister.ts / step-applier.ts have always populated it) — so
  // this is a pure read-side enrichment, retroactive over every existing row,
  // exactly like T-0733's node batch above. Resolved through record-resolver.ts
  // (the THIRD sibling batch, choros.record ⋈ choros.registry_def). A resolver
  // error degrades to an empty map — same failure discipline as the actor/node
  // batches (never turns a redacted read into a 500).
  const distinctRecordIds = new Set<string>();
  for (const item of page.items) {
    if (item.action.startsWith("record.") && item.target) distinctRecordIds.add(item.target);
  }
  let recordResolved: Map<string, ResolvedRecord> = new Map();
  if (distinctRecordIds.size > 0) {
    try {
      recordResolved = await batchResolveRecords(pool, tenantId, [...distinctRecordIds]);
    } catch {
      recordResolved = new Map();
    }
  }

  const events = page.items.map((item) => {
    let targetDisplay: ResolvedActor | ResolvedNode | ResolvedRecord | null = null;
    if (item.action === "employee.moved" && item.target) {
      targetDisplay = resolveActorDisplay(actorResolved, item.target);
    } else if (item.action === "department.moved" && item.target) {
      targetDisplay = resolveNodeDisplay(nodeResolved, item.target, "department");
    } else if (item.action === "position.moved" && item.target) {
      targetDisplay = resolveNodeDisplay(nodeResolved, item.target, "position");
    } else if (item.action.startsWith("record.") && item.target) {
      // resolveRecordDisplay returns null on a miss (deleted/foreign record) —
      // the frontend then falls through to its pre-existing raw-id MonoId chip
      // (see the module doc's "HONEST DEGRADATION" note in record-resolver.ts).
      targetDisplay = resolveRecordDisplay(recordResolved, item.target);
    }
    return {
      ...item,
      actorDisplay: resolveActorDisplay(actorResolved, item.actor),
      targetDisplay,
    };
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ events, nextCursor: page.nextCursor }));
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAuditRoutes(
  router: Router,
  _store?: JobStore,
  pool?: pg.Pool,
): void {
  // GET /api/audit — T-0500: the REAL tenant-wide, redacted, paginated audit log.
  //
  // When no pool is wired (memory mode / DATABASE_URL absent), there is NO real audit
  // store to read — fail HONESTLY (503) rather than fall back to a fake timeline.
  router.register("GET", "/api/audit", withAuth(async (req, res) => {
    if (pool === undefined) {
      throw new HttpError(
        503,
        "AUDIT_UNAVAILABLE",
        "audit log is not available (no database configured)",
      );
    }
    await handleGetAuditLog(pool, req, res);
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
  // Authz (T-0737 — CLOSED, was FORWARD-OBLIGATION): requireAuditRead — the SAME
  // owner-only gate as GET /api/audit (loadAdminContext + holdsAuditRead). This
  // route serves demo/fixture data (T-0138), not the real journal, but is grouped
  // under the SAME audit-surface authority policy per the file's own forward
  // obligation ("all three routes must be closed together"). No pool wired
  // (memory mode) -> 503, same as /api/audit (the gate itself needs a DB read).
  //
  // Response: 200 application/json + Content-Disposition: attachment.
  router.register("GET", "/api/audit/export", withAuth(async (req, res) => {
    if (pool === undefined) {
      throw new HttpError(
        503,
        "AUDIT_UNAVAILABLE",
        "audit export is not available (no database configured)",
      );
    }
    await requireAuditRead(pool, req);

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
  // Authz (T-0737 — CLOSED, was FORWARD-OBLIGATION): requireAuditRead — the SAME
  // owner-only gate as GET /api/audit and GET /api/audit/export. Previously this
  // route had NO gate at all (not even an x-dev-user presence check) — any
  // withAuth-authenticated caller (or, in dev mode, ANY request at all, since dev
  // auth is a no-op) could read it. No pool wired (memory mode) -> 503.
  router.register("GET", "/api/audit/:instanceId", withAuth(async (req, res, params) => {
    if (pool === undefined) {
      throw new HttpError(
        503,
        "AUDIT_UNAVAILABLE",
        "audit instance trace is not available (no database configured)",
      );
    }
    await requireAuditRead(pool, req);

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
