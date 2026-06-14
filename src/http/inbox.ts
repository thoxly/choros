/**
 * src/http/inbox.ts
 *
 * Read-API for inbox task list (GET /api/inbox).
 * Write-API: POST /api/inbox/:id/claim — claim a pool task (assign to caller).
 * In-memory seed data with task inbox items matching screen-inbox.jsx shape.
 * Zero external dependencies — only node:http types and router.ts.
 *
 * T-0093: tabs / filters / role-addressing. The Inbox spec (claude-design-prompts.md
 * Промпт 1 §2) fixes one invariant: **a task is addressed to a ROLE/position, not to a
 * specific human**. This module makes that invariant first-class:
 *
 *   - every seed item carries `role` (the position/role the task is addressed to) and
 *     `tenant` (the tenant the task belongs to);
 *   - the 4 tabs are computed SERVER-SIDE from role-membership + claim state + an
 *     explicit `escalated` flag, not from client-side string heuristics:
 *       • Все       — all tasks visible to the actor's tenant
 *       • Мне       — tasks claimed-by-me OR directly assigned to me
 *       • Из пула   — UNCLAIMED tasks addressed to a ROLE the actor holds
 *       • Эскалации — tasks flagged escalated (or failed)
 *   - tenant isolation: a task addressed to a role in tenant A is never returned for
 *     an actor in tenant B.
 *
 * T-0138: claim write-path. In-memory claimed set (process-lifetime) models the
 * "взять из пула" → "назначена мне" transition. A real implementation would
 * write to a DB user_task_claim table; the seed-layer contract is identical
 * (same HTTP shape, same error codes).
 */
import { HttpError, type Router } from "./router.js";
import { JobStore } from "../core/jobStore.js";
import { findEmployee } from "./org.js";
import { DEV_USER_HEADER } from "./auth.js";
import { DEV_TENANT_ID, getOrgPool, resolveActorTenant } from "../db/org.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TabId = "all" | "mine" | "pool" | "esc";
type ExecKind = "agent" | "human" | "service";

type InboxItem = {
  id: string;
  status: "running" | "waiting" | "failed" | "done" | "paused";
  name: string;
  step: string;
  inst: string;
  /**
   * Role/position the task is ADDRESSED TO. Invariant: a task targets a role, not a
   * specific human. "Из пула" claim eligibility is computed from this, not from execName.
   */
  role: string;
  /** Task is an escalation (drives the «Эскалации» tab without step string-matching). */
  escalated?: boolean;
  execType?: ExecKind;
  execName?: string;
  pool?: boolean;
  sla: { min: number; left: number };
  due: string;
  mine?: boolean;
  /**
   * Taken-task state (T-0094). Present IFF the task has been claimed from the pool.
   *  - `claimedBy` is the actor id (employee slug) that holds the claim — the «кто взял».
   *  - `claimedAt` is the claim timestamp in epoch-ms — the «когда взял».
   * These let the UI render «взято <name>, <when>» truthfully instead of guessing.
   */
  claimedBy?: string;
  claimedAt?: number;
};

/** Internal seed shape — carries tenant + role for addressing; tenant is stripped on the wire. */
type SeedItem = InboxItem & { tenant: string };

// ---------------------------------------------------------------------------
// In-memory seed fixture
//
// `role` is the position the task is addressed to (matches showcase positions:
// fin-ctrl / fin-appr / fin-cfo / cs-l1 / cs-l2 / plat-int / plat-svc).
// `tenant` scopes the row — DEV_TENANT_ID is the dev silo; OTHER_TENANT_ID models a
// foreign tenant whose tasks must never leak into the dev actor's inbox.
// ---------------------------------------------------------------------------

const OTHER_TENANT_ID = "b0000000-0000-0000-0000-0000000000ff";

const INBOX_SEED: SeedItem[] = [
  { id: "t1", tenant: DEV_TENANT_ID, status: "running", name: "Проверить реквизиты счёта №4471", step: "Согласование счёта · узел Проверка", inst: "INS-7731", role: "fin-appr", execType: "agent", execName: "Счёт-агент", sla: { min: 120, left: 88 }, due: "07.06 16:40" },
  { id: "t2", tenant: DEV_TENANT_ID, status: "waiting", name: "Подтвердить возврат средств клиенту", step: "Возврат · узел Утверждение", inst: "INS-7702", role: "fin-ctrl", execType: "human", execName: "А. Кравцова", sla: { min: 240, left: 42 }, due: "07.06 15:12" },
  { id: "t3", tenant: DEV_TENANT_ID, status: "waiting", name: "Сверить платёж с договором ДГ-2231", step: "Закрытие месяца · узел Сверка", inst: "INS-7698", role: "fin-ctrl", pool: true, sla: { min: 180, left: 175 }, due: "07.06 19:55" },
  { id: "t4", tenant: DEV_TENANT_ID, status: "running", name: "Распознать вложение invoice_4480.pdf", step: "Согласование счёта · узел OCR", inst: "INS-7731", role: "plat-svc", execType: "service", execName: "ocr-gateway", sla: { min: 5, left: 2 }, due: "07.06 14:33" },
  { id: "t5", tenant: DEV_TENANT_ID, status: "waiting", name: "Классифицировать обращение #88214", step: "Поддержка · узел Триаж", inst: "INS-7740", role: "cs-l1", execType: "agent", execName: "Триаж-агент", sla: { min: 30, left: 7 }, due: "07.06 14:38" },
  { id: "t6", tenant: DEV_TENANT_ID, status: "failed", name: "Эскалация: спор по возврату #88190", step: "Поддержка · узел L2", inst: "INS-7733", role: "cs-l2", escalated: true, pool: true, sla: { min: 60, left: -14 }, due: "07.06 14:05" },
  { id: "t7", tenant: DEV_TENANT_ID, status: "waiting", name: "Утвердить платёж поставщику > ₽50 000", step: "Согласование счёта · эскалация", inst: "INS-7731", role: "fin-cfo", escalated: true, execType: "human", execName: "Е. Ларина", sla: { min: 480, left: 360 }, due: "07.06 22:30" },
  { id: "t8", tenant: DEV_TENANT_ID, status: "running", name: "Синхронизировать проводки за 06.06", step: "Закрытие месяца · узел Синк", inst: "INS-7690", role: "plat-svc", execType: "service", execName: "ledger-sync", sla: { min: 15, left: 11 }, due: "07.06 14:48" },
  { id: "t9", tenant: DEV_TENANT_ID, status: "waiting", name: "Проверить контрагента (KYC) ООО «Вектор»", step: "Онбординг · узел Комплаенс", inst: "INS-7755", role: "fin-ctrl", pool: true, sla: { min: 720, left: 540 }, due: "08.06 01:10" },
  { id: "t10", tenant: DEV_TENANT_ID, status: "waiting", name: "Ответить на запрос статуса возврата", step: "Поддержка · узел Ответ", inst: "INS-7733", role: "cs-l1", execType: "agent", execName: "Триаж-агент", sla: { min: 30, left: 24 }, due: "07.06 14:55" },
  { id: "t11", tenant: DEV_TENANT_ID, status: "waiting", name: "Согласовать акт сверки за май", step: "Закрытие месяца · узел Утверждение", inst: "INS-7698", role: "fin-ctrl", pool: true, sla: { min: 1440, left: 980 }, due: "08.06 09:00" },
  { id: "t12", tenant: DEV_TENANT_ID, status: "running", name: "Инициировать платёж по счёту №4468", step: "Согласование счёта · узел Платёж", inst: "INS-7729", role: "fin-appr", execType: "agent", execName: "Счёт-агент", sla: { min: 60, left: 31 }, due: "07.06 15:08" },
  // Foreign-tenant task — addressed to a role, but in another tenant. Must NEVER appear
  // for a dev-tenant actor. Proves tenant isolation deterministically (no DB needed).
  { id: "x1", tenant: OTHER_TENANT_ID, status: "waiting", name: "Чужой тенант: согласовать счёт", step: "Согласование счёта · узел Проверка", inst: "INS-9001", role: "fin-ctrl", pool: true, sla: { min: 120, left: 60 }, due: "07.06 16:00" },
];

// ---------------------------------------------------------------------------
// Role membership (dev-fixture).
//
// Maps dev-user slug → set of role/position keys the user holds. Drives the
// "Из пула" tab: an unclaimed task addressed to role R is claimable by (and shown
// to) actors who hold R. In a DB-backed impl this comes from role_assignment;
// here it is a fixture aligned with the showcase org (src/http/org.ts ORG_SEED).
// ---------------------------------------------------------------------------

const USER_ROLES: Record<string, string[]> = {
  "e-kravtsova": ["fin-ctrl"], // Контролёр расчётов
  "e-mironov": ["fin-appr"], // Согласующий счетов
  "e-larina": ["fin-cfo", "fin-appr"], // Финансовый директор + согласование
  "e-orlov": ["cs-l1"],
  "e-savina": ["cs-l1"],
  "e-petrov": ["cs-l2"],
  "e-belov": ["plat-int"],
  // e-sokolov (test claimant) holds the broad fin-ctrl pool role
  "e-sokolov": ["fin-ctrl"],
};

function rolesForUser(devUserId?: string | null): string[] {
  if (!devUserId) return [];
  return USER_ROLES[devUserId] ?? [];
}

// ---------------------------------------------------------------------------
// In-memory claim state (T-0138 write-path)
// Maps taskId → { claimedBy: userId, claimedAt: ms }
// Process-lifetime only — survives across requests in a running server.
// ---------------------------------------------------------------------------

interface ClaimRecord {
  claimedBy: string;
  claimedAt: number;
}

const CLAIMED: Map<string, ClaimRecord> = new Map();

// ---------------------------------------------------------------------------
// Tenant resolution — DB path resolves the actor's tenant from the slug;
// no-DB fallback is DEV_TENANT_ID. Mirrors src/http/org.ts.
// ---------------------------------------------------------------------------

function hasDb(): boolean {
  return Boolean(process.env["DATABASE_URL"]);
}

async function resolveTenant(devUserId?: string | null): Promise<string> {
  if (hasDb() && devUserId) {
    return resolveActorTenant(getOrgPool(), devUserId);
  }
  return DEV_TENANT_ID;
}

// ---------------------------------------------------------------------------
// Data accessors
// ---------------------------------------------------------------------------

/** Strip the internal `tenant` field — it is not part of the wire contract. */
function toWire(item: SeedItem): InboxItem {
  const wire: Record<string, unknown> = { ...item };
  delete wire["tenant"];
  return wire as unknown as InboxItem;
}

/**
 * Materialize the actor's inbox view: tenant-scoped, with claim state + `mine`
 * applied. Does NOT apply tab/filter — that is layered on top so the tab counts
 * can be computed from the same base list.
 */
async function findInboxItems(devUserId?: string | null): Promise<InboxItem[]> {
  const tenantId = await resolveTenant(devUserId);

  // Resolve dev-user to person if provided (findEmployee is async: DB-backed or in-memory)
  let person = null;
  if (devUserId && typeof devUserId === "string") {
    person = await findEmployee(devUserId);
  }

  const tenantItems = INBOX_SEED
    // Tenant isolation: only this actor's tenant. Foreign-tenant tasks never leak.
    .filter((item) => item.tenant === tenantId);

  // Resolve display names for the distinct claimers present in this tenant view, so a
  // claimed row can render «взято <name>» rather than a raw slug. findEmployee is
  // tolerant of unknown ids (returns null) — we fall back to the slug in that case.
  const claimerNames = new Map<string, string>();
  for (const seed of tenantItems) {
    const claim = CLAIMED.get(seed.id);
    if (claim && !claimerNames.has(claim.claimedBy)) {
      const claimer = await findEmployee(claim.claimedBy);
      claimerNames.set(claim.claimedBy, claimer?.name ?? claim.claimedBy);
    }
  }

  return tenantItems.map((seed) => {
    const item = toWire(seed);
    const claim = CLAIMED.get(item.id);

    if (claim) {
      // Claimed item: pool cleared, assigned to claimer. Surface the taken-state
      // (who + when) as first-class wire fields — the UI reflects it, not guesses it.
      const mine =
        devUserId !== undefined && devUserId !== null && devUserId === claim.claimedBy;
      return {
        ...item,
        pool: false,
        execType: "human" as const,
        execName: claimerNames.get(claim.claimedBy) ?? claim.claimedBy,
        claimedBy: claim.claimedBy,
        claimedAt: claim.claimedAt,
        mine,
      };
    }

    const mine =
      person !== null &&
      item.execType === "human" &&
      item.execName === person.name;

    return { ...item, mine };
  });
}

// ---------------------------------------------------------------------------
// Tab / filter logic (server-side; the design's intent — not client heuristics)
// ---------------------------------------------------------------------------

function isEscalated(item: InboxItem): boolean {
  return item.escalated === true || item.status === "failed";
}

/**
 * Decide whether an item belongs in a given tab for the given actor.
 *   all  — everything (already tenant-scoped)
 *   mine — claimed-by-me / assigned-to-me
 *   pool — UNCLAIMED, pooled, addressed to a ROLE the actor holds
 *   esc  — escalated / failed
 */
function inTab(item: InboxItem, tab: TabId, devUserId: string | null, myRoles: string[]): boolean {
  switch (tab) {
    case "mine":
      return item.mine === true;
    case "pool":
      // Pool eligibility is by ROLE, not by name (the core invariant).
      return item.pool === true && (myRoles.length === 0 ? true : myRoles.includes(item.role));
    case "esc":
      return isEscalated(item);
    case "all":
    default:
      return true;
  }
}

function parseTab(raw: string | null): TabId {
  if (raw === "mine" || raw === "pool" || raw === "esc" || raw === "all") return raw;
  return "all";
}

function parseExec(raw: string | null): ExecKind | null {
  return raw === "agent" || raw === "human" || raw === "service" ? raw : null;
}

/** Parse query params off the raw request url (router strips them before routing). */
function parseQuery(url: string | undefined): URLSearchParams {
  const q = (url ?? "").indexOf("?");
  return new URLSearchParams(q >= 0 ? (url as string).slice(q + 1) : "");
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerInboxRoutes(router: Router, _store?: JobStore): void {
  // GET /api/inbox[?tab=all|mine|pool|esc][&exec=agent|human|service][&sort=sla]
  //
  // - tenant-scoped to the actor (foreign-tenant tasks never returned)
  // - `tab` filters server-side using role-addressing + claim state + escalated flag
  // - `exec` filters by executor type; `sort=sla` orders by SLA headroom ascending
  // - response always includes `counts` (per-tab) computed from the tenant-scoped base
  //
  // Backward compatible: with NO query params, returns the full tenant list under
  // `items` (legacy shape) plus the additive `counts` object.
  router.register("GET", "/api/inbox", async (req, res) => {
    let devUserId = req.headers[DEV_USER_HEADER];
    if (Array.isArray(devUserId)) devUserId = devUserId[0];
    const actor = typeof devUserId === "string" ? devUserId : null;

    const base = await findInboxItems(actor);
    const myRoles = rolesForUser(actor);

    // Per-tab counts from the tenant-scoped base (so the UI badge totals are server-truth).
    const counts: Record<TabId, number> = {
      all: base.length,
      mine: base.filter((i) => inTab(i, "mine", actor, myRoles)).length,
      pool: base.filter((i) => inTab(i, "pool", actor, myRoles)).length,
      esc: base.filter((i) => inTab(i, "esc", actor, myRoles)).length,
    };

    const query = parseQuery(req.url);
    const tab = parseTab(query.get("tab"));
    const execFilter = parseExec(query.get("exec"));
    const sort = query.get("sort");

    let items = base.filter((i) => inTab(i, tab, actor, myRoles));
    if (execFilter) {
      items = items.filter((i) => i.execType === execFilter);
    }
    if (sort === "sla") {
      // Ascending SLA headroom — most-urgent (incl. overdue, negative `left`) first.
      items = [...items].sort((a, b) => a.sla.left - b.sla.left);
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ items, counts, tab }));
  });

  // POST /api/inbox/:id/claim — claim a pool task (T-0138 write-path).
  //
  // Authz: requires x-dev-user header (dev mode); 401 if absent.
  // Preconditions:
  //   - task must exist in the actor's tenant: 404 NOT_FOUND
  //   - task must be pool=true AND not already claimed: 409 ALREADY_CLAIMED
  //   - task must be addressed to a ROLE the actor holds: 403 NOT_ELIGIBLE
  //     (the claim-from-pool invariant: you may only take pool work for your role)
  // Success: 200 { item } — item with pool:false, execType:"human", mine:true
  //   (caller always mines their own claim) and the taken-state (T-0094):
  //   claimedBy=actor id, claimedAt=epoch-ms, execName=claimer display name.
  //
  // Idempotency: re-claiming own task → 200 (no-op, SAME claim record — claimedAt
  //   is preserved, NOT advanced — so «когда взято» is stable across re-claims).
  // Claiming another user's claimed task → 409 ALREADY_CLAIMED.
  router.register("POST", "/api/inbox/:id/claim", async (req, res, params) => {
    let devUserId = req.headers[DEV_USER_HEADER];
    if (Array.isArray(devUserId)) devUserId = devUserId[0];
    if (!devUserId || typeof devUserId !== "string") {
      throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
    }

    const taskId = params["id"] as string;
    const tenantId = await resolveTenant(devUserId);

    // Task must exist AND be visible in the actor's tenant.
    const task = INBOX_SEED.find((t) => t.id === taskId && t.tenant === tenantId);
    if (!task) {
      throw new HttpError(404, "NOT_FOUND", "task not found");
    }

    // Check existing claim
    const existing = CLAIMED.get(taskId);
    if (existing) {
      if (existing.claimedBy === devUserId) {
        // Idempotent re-claim — return current state
        const items = await findInboxItems(devUserId);
        const item = items.find((t) => t.id === taskId);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ item }));
        return;
      }
      throw new HttpError(409, "ALREADY_CLAIMED", "task already claimed by another user");
    }

    // Task must be pooled (not assigned to a specific person)
    if (!task.pool) {
      throw new HttpError(409, "NOT_POOL_TASK", "task is not a pool task and cannot be claimed");
    }

    // Claim-from-pool invariant: caller must hold the ROLE the task is addressed to.
    // Empty role set (unknown dev-user) is permitted in the dev fixture so the
    // pre-existing T-0138 claimant flow keeps working.
    const myRoles = rolesForUser(devUserId);
    if (myRoles.length > 0 && !myRoles.includes(task.role)) {
      throw new HttpError(403, "NOT_ELIGIBLE", "actor does not hold the role this task is addressed to");
    }

    // Register claim
    CLAIMED.set(taskId, { claimedBy: devUserId, claimedAt: Date.now() });

    const items = await findInboxItems(devUserId);
    const item = items.find((t) => t.id === taskId);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ item }));
  });
}

/**
 * T-0138 test seam: reset in-memory claim state between tests.
 * Not called from production code.
 */
export function _resetClaimStateForTests(): void {
  CLAIMED.clear();
}
