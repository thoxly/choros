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
 * write to a DB claim-lock table; the seed-layer contract is identical
 * (same HTTP shape, same error codes).
 */
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { JobStore } from "../core/jobStore.js";
import { findEmployee } from "./org.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { DEV_TENANT_ID, getOrgPool, resolveActorTenant, resolveActorSlugFromAuth } from "../db/org.js";
import { findEmployeeById } from "../db/org.js";
import { getRoleSlugsForActor, getHoldersForRole, findTenantOwnerSlug } from "../db/grants-dao.js";
import { parsePaginationParams, paginateInMemory } from "../core/data-access-port.js";
// executor-resolver: the batch path (resolveExecutorFallbackBatch below) calls
// getHoldersForRole / findTenantOwnerSlug directly to avoid the port-wrapper overhead.
// resolveExecutor (src/core/executor-resolver.ts) remains the canonical single-task
// entry point for callers outside inbox.ts (e.g. claim write-path, future per-task
// routing logic).
import { listDeferredInboxTasks } from "../db/deferred-inbox-store.js";
import {
  APPROVE_TASK_NAME,
  appendTaskApproved,
  findWaitingInstanceTask,
  listInstanceInboxTasks,
  listInstanceProjections,
} from "./process-projection.js";
import {
  applyStepResult,
  readStepClass,
  validateAndFilterFormValues,
  type OutboxEnqueuePort,
} from "../db/step-applier.js";
import {
  AlreadyClaimedError,
  appendTaskClaimed,
  insertClaimLock,
  loadClaimsFromAudit,
  type ClaimState,
} from "./claim-projection.js";

// ---------------------------------------------------------------------------
// extractActorSlug — mode-aware, resolves the authenticated request → the
// correct employee SLUG (T-0372, mirrors assistant.ts extractActorSlug).
//
// In keycloak mode: resolves via resolveActorSlugFromAuth (sub-first →
// preferred_username fallback → null → 401). Prevents raw KC sub (UUID)
// from being used as an employee slug for grant/tenant resolution.
// In dev mode: the x-dev-user header value IS the slug (unchanged).
// ---------------------------------------------------------------------------

async function extractActorSlug(
  req: import("node:http").IncomingMessage,
  getPool: () => pg.Pool,
): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    // Keycloak mode: resolve sub → slug. getPool() is only called here (lazy),
    // so dev-mode tests without DATABASE_URL never trigger getOrgPool().
    const slug = await resolveActorSlugFromAuth(getPool(), ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
  // Dev mode: x-dev-user header value IS the slug.
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

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
  /**
   * Deadline in epoch-ms — the SERVER's source of truth for the live SLA countdown
   * (T-0095). The client derives the live remaining time + warn/over state purely from
   * this (see src/http/sla.ts slaState); it never invents deadlines client-side.
   * Materialized per request as now + sla.left·60s so the countdown is anchored to a
   * real wall-clock instant while the static `sla.left` stays stable for legacy callers.
   */
  deadline?: number;
  mine?: boolean;
  /**
   * Taken-task state (T-0094). Present IFF the task has been claimed from the pool.
   *  - `claimedBy` is the actor id (employee slug) that holds the claim — the «кто взял».
   *  - `claimedAt` is the claim timestamp in epoch-ms — the «когда взял».
   * These let the UI render «взято <name>, <when>» truthfully instead of guessing.
   */
  claimedBy?: string;
  claimedAt?: number;
  /**
   * T-0221 (AC-5): reason for deferral, present only on defer-to-human tasks.
   * Additive optional field — not present on seed tasks. Never contains raw reasoning
   * (D-139 / FF-9: reasoning_trace_ref stays in audit payload, not surfaced here).
   */
  doubt_reason?: string;
  /**
   * T-0380 (F7): when the executor resolver fell back to the tenant owner because
   * the task's role has no confirmed holders, this field is set to "role_unfilled".
   * UI/notification can display "роль не заполнена, поэтому вам" when this is present.
   * Additive optional field — absent on all existing tasks (non-breaking).
   */
  routed_to_fallback?: "role_unfilled";
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
  // T-0282: e-larina is the canonical ТЭЛ approver (BPMN task-approve
  // candidateGroups="role-approver"); she holds role-approver so the U4 approval
  // pool task is claimable + approvable by her (ADR T-0278 §2.1/§2.3, S4 persona).
  "e-larina": ["fin-cfo", "fin-appr", "role-approver"], // Финансовый директор + согласование
  // T-0282: e-orlov is the canonical ТЭЛ initiator (BPMN task-submit
  // candidateGroups="role-initiator"; ADR §2.1, S1 persona).
  "e-orlov": ["cs-l1", "role-initiator"],
  "e-savina": ["cs-l1"],
  "e-petrov": ["cs-l2"],
  "e-belov": ["plat-int"],
  // e-sokolov (test claimant) holds the broad fin-ctrl pool role
  "e-sokolov": ["fin-ctrl"],
};

/**
 * T-0331 (S0a): Resolve the actor's role slugs from the live DB when available,
 * falling back to the in-memory USER_ROLES fixture for memory-mode / no-DB tests.
 *
 * DB path: getRoleSlugsForActor (grants-dao.ts) queries role_assignment → role
 * inside a tenant-scoped RLS transaction. Returns [] for an unknown actor.
 *
 * Fallback path (hasDb() === false): the existing in-memory USER_ROLES fixture,
 * which preserves all existing memory-mode test behaviour (FF-11).
 *
 * Fail-closed (NF-3): when DATABASE_URL is set, any DB error propagates to the
 * caller rather than silently degrading to the in-memory fixture. Authority call
 * sites (claim, approve) MUST see this propagation so the router's INTERNAL:500
 * envelope is returned instead of evaluating grants against stale fixture data.
 * The no-DB path (hasDb() === false) keeps the fixture fallback as before.
 *
 * T-0366 — fallbackActor for KC seed personas:
 *   In keycloak mode, the actor is the JWT `sub` (a random UUID) which does not
 *   match employee.slug for seed personas. The optional `fallbackActor` param
 *   (JWT preferred_username) is passed to getRoleSlugsForActor so that when the
 *   primary lookup fails, the fallback (preferred_username) is tried instead.
 *   In dev-header mode, actor == slug already, so fallbackActor is not supplied.
 */
async function resolveRolesForActor(
  actor?: string | null,
  tenantId: string = DEV_TENANT_ID,
  nowMs: number = Date.now(),
  fallbackActor?: string,
): Promise<string[]> {
  if (!actor) return [];
  if (hasDb()) {
    // No try/catch: DB errors propagate to the caller (fail-closed, NF-3).
    // A fixture fallback here would let a transient DB error silently grant
    // access to actors whose live DB grants have been revoked.
    return await getRoleSlugsForActor(getOrgPool(), tenantId, actor, nowMs, fallbackActor);
  }
  return USER_ROLES[actor] ?? [];
}

// ---------------------------------------------------------------------------
// T-0336 (E15-S2): In-memory CLAIMED Map REMOVED.
//
// Claim-state is now sourced from the append-only `audit_event` track
// (task.claimed events, written by appendTaskClaimed in claim-projection.ts).
// In DB-mode: claim projections are read via loadClaimsFromAudit().
// In no-DB/memory mode: claim-state is not persisted (T-0338 claim-lock primitive
// requires DB — user_task_claim table, migration 078).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T-0282 — inbox write-deps for the card-action approve route (ADR §2.3).
//
// The approve action needs a tenant-scoped pg tx to append the task.approved
// audit event (engine→screen projection advance). Injected from the composition
// root (server.ts) ALONGSIDE the existing claim path — absent ⇒ the approve route
// is not registered (no-DB / memory-mode keeps the seed-only inbox unchanged,
// exactly like the start-route's startDeps gating in processes.ts).
// ---------------------------------------------------------------------------

export interface InboxWriteDeps {
  pool: pg.Pool;
  /** Resolve the tenant the actor (dev-user slug) belongs to. */
  resolveActorTenant: (actorSlug: string) => Promise<string>;
  /**
   * T-0335 (E15-S1b): outbox store for the step-applier (enqueueInTx the
   * `step_applied` row inside the approve tx). When absent, the approve route
   * still appends task.approved but the entity-applier seam is NOT engaged
   * (honest-degrade: no `step_applied` outbox, no «Согласование» record). Present
   * ⇒ the applier runs in the same tx and the fail-closed contract holds.
   */
  outboxStore?: OutboxEnqueuePort;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run fn inside a tenant-scoped tx (SET LOCAL choros.tenant_id + FORCE RLS),
 * mirroring process-start.ts/process-defs.ts. The task.approved append runs here
 * so the projection advance is atomic + tenant-isolated.
 */
async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new HttpError(400, "VALIDATION", "tenantId must be a valid UUID");
  }
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
// T-0380 (D4): Executor resolver — batched fallback resolution
//
// `resolveExecutorFallbackBatch` is called ONCE per inbox read (DB mode only)
// to compute the routed_to_fallback patch for ALL instance tasks in a single
// batched pass. It avoids the N+1 pattern that results from calling the resolver
// once per task under Promise.all (≤200 tasks × 2 DB txs = up to 400 connections
// against a max=10 pool).
//
// Batching strategy:
//   1. Collect the DISTINCT set of role slugs across all unclaimed instance tasks.
//   2. Resolve holders for each DISTINCT role slug in parallel (at most once per role).
//   3. Resolve the tenant owner slug ONCE (owner is per-tenant, not per-task).
//   4. For each task, look up its role's resolution from the in-memory maps built
//      in steps 2–3 and compute the patch without any further DB round-trips.
//
// No-DB path: caller skips this function entirely (instanceTasks is never populated
// without hasDb()); no-DB inbox uses INBOX_SEED only.
//
// Substitution (step 3 of the resolver): the DB-backed SubstitutionSource that
// translates role slugs and employee slugs to UUIDs is pending T-0053. Until that
// port is wired, the substitution step is skipped and the pool→fallback path is
// the active path. The batching below mirrors that same two-step logic.
// ---------------------------------------------------------------------------

/**
 * T-0380 (D4/F6/F7): Batch fallback patch resolver.
 *
 * Given a list of (taskId, roleSlug) pairs from unclaimed instance inbox tasks,
 * resolves which tasks need `routed_to_fallback: "role_unfilled"` — in a single
 * batched pass rather than one DB trip per task.
 *
 * Returns a Map<taskId, { routed_to_fallback: "role_unfilled" }> for tasks whose
 * role has no confirmed holders. Tasks whose role HAS holders are absent from the map.
 *
 * Degrades gracefully: any DB error → returns empty map (no tasks marked fallback).
 */
async function resolveExecutorFallbackBatch(
  tasks: ReadonlyArray<{ id: string; role: string }>,
  tenantId: string,
  nowMs: number,
): Promise<Map<string, { routed_to_fallback: "role_unfilled" }>> {
  const result = new Map<string, { routed_to_fallback: "role_unfilled" }>();
  if (tasks.length === 0) return result;

  try {
    const pool = getOrgPool();

    // Step 1: collect distinct role slugs to resolve (avoid redundant DB queries).
    const distinctRoles = [...new Set(tasks.map((t) => t.role))];

    // Step 2: resolve holders for each distinct role in parallel (one DB tx per
    // distinct role, not one per task).
    const holdersEntries = await Promise.all(
      distinctRoles.map(async (roleSlug) => {
        const holders = await getHoldersForRole(pool, tenantId, roleSlug, nowMs);
        return [roleSlug, holders] as const;
      }),
    );
    const holdersByRole = new Map<string, readonly string[]>(holdersEntries);

    // Step 3: resolve tenant owner slug ONCE (owner is per-tenant, not per-role/task).
    // Only needed if at least one role has no holders.
    const rolesWithNoHolders = distinctRoles.filter(
      (slug) => (holdersByRole.get(slug) ?? []).length === 0,
    );
    let ownerSlug: string | null = null;
    if (rolesWithNoHolders.length > 0) {
      ownerSlug = await findTenantOwnerSlug(pool, tenantId, nowMs);
    }

    // Step 4: for each task, apply the resolution from in-memory maps.
    for (const task of tasks) {
      const holders = holdersByRole.get(task.role) ?? [];
      if (holders.length > 0) {
        // Role has confirmed holders → pool path, no fallback needed.
        continue;
      }
      // Role is empty. With no substitution port wired (T-0053 pending), we go
      // directly to fallback-owner (F6/F7). Mark regardless of whether an owner
      // was found (mirrors the "unresolvable" branch in resolveExecutor).
      if (ownerSlug !== null || rolesWithNoHolders.length > 0) {
        result.set(task.id, { routed_to_fallback: "role_unfilled" as const });
      }
    }
  } catch {
    // Degrade gracefully: executor resolver errors are non-fatal for inbox reads.
    // Tasks surface without fallback marking rather than blocking the inbox.
  }

  return result;
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
 *
 * T-0221: when hasDb(), defer projections from audit_event are merged additively
 * into the list. When !hasDb(), only INBOX_SEED is used (preserving existing
 * behaviour for memory-mode tests, FF-11).
 *
 * T-0336 (E15-S2): claim-state is now derived from the audit_event track
 * (task.claimed events via loadClaimsFromAudit). An optional `claimMap` can be
 * supplied by callers that already loaded it (avoids a redundant DB round-trip
 * on the claim write-path). When not supplied and DB is available, it is loaded
 * here lazily. When no DB, claim-state is empty (T-0338 prerequisite).
 */
async function findInboxItems(
  devUserId?: string | null,
  nowMs: number = Date.now(),
  claimMap?: Map<string, ClaimState>,
): Promise<InboxItem[]> {
  const tenantId = await resolveTenant(devUserId);

  // T-0336: load claim-state from audit_event when DB available and no pre-loaded map.
  // Degrade gracefully (read projection, not write path): any error → empty map.
  let claimStateMap = claimMap ?? new Map<string, ClaimState>();
  if (hasDb() && !claimMap) {
    try {
      claimStateMap = await loadClaimsFromAudit(getOrgPool(), tenantId);
    } catch {
      // Degrade gracefully — claim-state is read-only, safe to skip.
      claimStateMap = new Map();
    }
  }

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
    const claim = claimStateMap.get(seed.id);
    if (claim && !claimerNames.has(claim.claimedBy)) {
      const claimer = await findEmployee(claim.claimedBy);
      claimerNames.set(claim.claimedBy, claimer?.name ?? claim.claimedBy);
    }
  }

  const seedResults: InboxItem[] = tenantItems.map((seed) => {
    const item = toWire(seed);
    const claim = claimStateMap.get(item.id);

    // SLA deadline (T-0095): anchor the static `sla.left` headroom (minutes) to a real
    // wall-clock instant so the client can run a live countdown + warn/over state off a
    // single server-provided source of truth. Stays additive — `sla` itself is untouched.
    item.deadline = nowMs + item.sla.left * 60_000;

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

  // T-0221 (§5.4): merge defer projections from audit_event when DB is available.
  // !hasDb() → only seed (preserves memory-mode test behaviour, FF-11).
  //
  // T-0301: in DB mode, INBOX_SEED must NOT leak into real tenants.
  // seedResults are showcase-fixture rows keyed to DEV_TENANT_ID; a real
  // authenticated tenant has its own UUID and should see ONLY real DB-backed
  // data (deferred + instance tasks). Honest-empty is correct for a fresh tenant.
  if (!hasDb()) {
    return seedResults;
  }

  let deferItems: InboxItem[] = [];
  try {
    const deferRows = await listDeferredInboxTasks(getOrgPool(), tenantId);
    deferItems = deferRows.map((row) => {
      // SLA: if slaMinutes set, use it; otherwise default to 60 min.
      const slaMin = row.slaMinutes ?? 60;
      const claim = claimStateMap.get(row.id);
      const deadline = nowMs + slaMin * 60_000;

      const base: InboxItem = {
        id: row.id,
        status: "waiting",
        name: row.name,
        step: row.step,
        inst: row.inst,
        role: row.role,
        execType: "agent",
        execName: row.execName,
        pool: true,
        sla: { min: slaMin, left: slaMin },
        due: new Date(row.occurredAt + slaMin * 60_000).toLocaleString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
        deadline,
        // T-0221 AC-5 / FF-9: doubt_reason from payload, never reasoning_trace_ref.
        doubt_reason: row.doubtReason,
      };

      if (claim) {
        const mine =
          devUserId !== undefined && devUserId !== null && devUserId === claim.claimedBy;
        return {
          ...base,
          pool: false,
          execType: "human" as const,
          execName: claim.claimedBy,
          claimedBy: claim.claimedBy,
          claimedAt: claim.claimedAt,
          mine,
        };
      }

      return base;
    });
  } catch {
    // If defer projection fails, fall back gracefully to seed-only.
    // This is a read-projection, not a write path — safe to degrade.
    deferItems = [];
  }

  // T-0282 (§2.3): project the WAITING user-tasks of started ТЭЛ instances into
  // the inbox, addressed to the ROLE (candidateGroups → role), NOT to a person
  // (AC-3). Same audit-event-backed read-projection track as the defer merge above
  // — additive, read-only, degrades gracefully (a started instance's approval task
  // appears as a pool task; once approved its instance is `done` and the task drops).
  //
  // T-0380 (D4/F6/F7): After building base items, apply the unified executor resolver
  // in a SINGLE BATCHED PASS (resolveExecutorFallbackBatch) to avoid an N+1 DB
  // fan-out. The batch resolves each DISTINCT role slug once and caches the tenant
  // owner lookup once per request, regardless of task count.
  let instanceItems: InboxItem[] = [];
  try {
    const instanceTasks = await listInstanceInboxTasks(getOrgPool(), tenantId);

    // Build base items synchronously (no DB needed for the base shape).
    const baseItems = instanceTasks.map((row) => {
      const slaMin = 240; // default headroom for an approval task (no per-task SLA yet).
      const claim = claimStateMap.get(row.id);
      const deadline = nowMs + slaMin * 60_000;

      const base: InboxItem = {
        id: row.id,
        status: "waiting",
        name: row.name,
        step: row.step,
        inst: row.inst,
        role: row.role,
        execType: "human",
        pool: true,
        sla: { min: slaMin, left: slaMin },
        due: new Date(row.occurredAt + slaMin * 60_000).toLocaleString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
        deadline,
      };

      return { base, claim };
    });

    // T-0380 (D4): resolve fallback patches for unclaimed tasks in ONE batched pass.
    // Claimed tasks already have an assignee — no fallback resolution needed.
    const unclaimedTasks = baseItems
      .filter(({ claim }) => !claim)
      .map(({ base }) => ({ id: base.id, role: base.role }));
    const fallbackPatches = await resolveExecutorFallbackBatch(unclaimedTasks, tenantId, nowMs);

    // Apply claims and fallback patches to produce final item shapes.
    const rawInstanceItems = baseItems.map(({ base, claim }) => {
      if (claim) {
        const mine =
          devUserId !== undefined && devUserId !== null && devUserId === claim.claimedBy;
        return {
          ...base,
          pool: false,
          execType: "human" as const,
          execName: claim.claimedBy,
          claimedBy: claim.claimedBy,
          claimedAt: claim.claimedAt,
          mine,
        };
      }

      // Apply fallback patch if this task's role had no holders.
      const patch = fallbackPatches.get(base.id);
      if (patch) {
        return { ...base, ...patch };
      }
      return base;
    });
    instanceItems = rawInstanceItems;
  } catch {
    // Read-projection: degrade gracefully to no instance tasks (never a write path).
    instanceItems = [];
  }

  // T-0301: in DB mode return ONLY real data (deferred + instance tasks).
  // Seed rows (INBOX_SEED) are showcase/fixture data that must NOT appear for
  // real authenticated tenants — they would mask real inbox content.
  // Honest-empty is correct for a fresh tenant with no real tasks.
  // Dedup by id (defensive — distinct id spaces between the two real sources).
  const seenIds = new Set<string>();
  const dedupedDefer = deferItems.filter((i) => !seenIds.has(i.id));
  for (const i of dedupedDefer) seenIds.add(i.id);
  const dedupedInstance = instanceItems.filter((i) => !seenIds.has(i.id));
  return [...dedupedDefer, ...dedupedInstance];
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
      // T-0365: fail-closed — empty roles ⇒ sees NO pool tasks (zero-role actor
      // must not see tasks). The old length===0 escape was the hole.
      return item.pool === true && myRoles.includes(item.role);
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

export function registerInboxRoutes(
  router: Router,
  _store?: JobStore,
  // T-0282 (ADR §2.3): when the composition root supplies the write-deps
  // (pool + actor→tenant resolver), register POST /api/inbox/:id/action (approve).
  // Absent ⇒ read + claim only (no-DB/memory-mode unchanged).
  writeDeps?: InboxWriteDeps,
): void {
  // GET /api/inbox[?tab=all|mine|pool|esc][&exec=agent|human|service][&sort=sla]
  //                [&page=N][&limit=N]
  //
  // - tenant-scoped to the actor (foreign-tenant tasks never returned)
  // - `tab` filters server-side using role-addressing + claim state + escalated flag
  // - `exec` filters by executor type; `sort=sla` orders by SLA headroom ascending
  // - response always includes `counts` (per-tab) computed from the tenant-scoped base
  //
  // T-0401 [D7-3]: PAGINATED via page/limit (in-memory).
  //   ?page=N        — zero-based page number (default 0)
  //   ?limit=N       — items per page (1..200, default 50)
  //
  // Backward compatible: response shape is ADDITIVE.
  //   Previously: { items, counts, tab }
  //   Now:        { items, counts, tab, page, totalPages, total, limit }
  //   items is now the CURRENT PAGE only, not all items.
  //   (legacy callers that never sent ?limit= or ?page= get page=0, limit=50 by default;
  //   for small inboxes all items fit on one page so behaviour is unchanged.)
  router.register("GET", "/api/inbox", withAuth(async (req, res) => {
    // Mode-aware actor resolution (T-0327 + T-0372: resolve KC sub → employee slug).
    const authCtx = getAuthContext(req);
    let actor: string | null;
    if (authCtx !== undefined) {
      // Keycloak mode: resolve sub → employee slug (sub-first, preferred_username fallback).
      // resolveActorSlugFromAuth returns null when no employee matches → treat as no actor.
      actor = await resolveActorSlugFromAuth(getOrgPool(), authCtx.sub, authCtx.preferredUsername);
    } else {
      let devUserId = req.headers[DEV_USER_HEADER];
      if (Array.isArray(devUserId)) devUserId = devUserId[0];
      actor = typeof devUserId === "string" ? devUserId : null;
    }

    const base = await findInboxItems(actor);
    // T-0331 (S0a): resolve role slugs from live DB (falls back to in-memory fixture
    // when !hasDb()); DB errors propagate as 500 (fail-closed, NF-3). tenantId from
    // resolveTenant mirrors the same source used by findInboxItems so role-check and
    // task-list are always co-scoped to the same tenant.
    const inboxTenantId = await resolveTenant(actor);
    const myRoles = await resolveRolesForActor(actor, inboxTenantId);

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

    let filtered = base.filter((i) => inTab(i, tab, actor, myRoles));
    if (execFilter) {
      filtered = filtered.filter((i) => i.execType === execFilter);
    }
    if (sort === "sla") {
      // Ascending SLA headroom — most-urgent (incl. overdue, negative `left`) first.
      filtered = [...filtered].sort((a, b) => a.sla.left - b.sla.left);
    }

    // T-0401 [D7-3]: paginate the filtered result set.
    const { limit, page } = parsePaginationParams(query);
    const paged = paginateInMemory(filtered, page, limit);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      items: paged.items,
      counts,
      tab,
      page: paged.page,
      totalPages: paged.totalPages,
      total: paged.total,
      limit: paged.limit,
    }));
  }));

  // GET /api/inbox/:id — task detail (T-0272).
  //
  // Returns the full item shape + optional instance projection (for instance-backed tasks).
  // Instance projection carries the current status (waiting | done) and step, so the UI can
  // show the outcome (process completed / step awaiting action) after the user completes a step.
  //
  // Response: 200 { item, projection? }
  //   - item: full inbox item (same shape as the list, including claimBy/mine/sla)
  //   - projection (optional): { inst, procKey, status, step, startedAt } — present only for
  //     instance-backed tasks (tasks whose id is the inbox_task_id of a process.started event).
  // Errors: 401 UNAUTHENTICATED, 404 NOT_FOUND
  router.register("GET", "/api/inbox/:id", withAuth(async (req, res, params) => {
    // Mode-aware actor resolution (T-0327 + T-0372: resolve KC sub → employee slug).
    const actor = await extractActorSlug(req, () => getOrgPool());
    const taskId = params["id"] as string;

    // Find the item in the actor's tenant inbox.
    // findInboxItems covers seed tasks + deferred (DB-path) + real instance tasks (DB-path).
    // When writeDeps is injected (compose root or test fake), also check instance tasks
    // from the injected pool so the detail route works for instance-backed tasks even in
    // unit tests that use a fake pool (no live DB, hasDb() is false).
    const base = await findInboxItems(actor);
    let item: InboxItem | undefined = base.find((i) => i.id === taskId);

    // Supplemental look-up from writeDeps pool when the item is not in the merged base
    // (e.g. test-only fake pool not visible to findInboxItems which uses getOrgPool()).
    let instanceTaskForDetail: import("./process-projection.js").InstanceInboxTask | null = null;
    if (!item && writeDeps) {
      try {
        const tenantId = await writeDeps.resolveActorTenant(actor);
        instanceTaskForDetail = await findWaitingInstanceTask(writeDeps.pool, tenantId, taskId);
        if (instanceTaskForDetail) {
          // Still waiting — synthesize a minimal InboxItem from the live instance task so
          // the detail returns the same shape regardless of how the task was found.
          item = {
            id: instanceTaskForDetail.id,
            status: "waiting" as const,
            name: instanceTaskForDetail.name,
            step: instanceTaskForDetail.step,
            inst: instanceTaskForDetail.inst,
            role: instanceTaskForDetail.role,
            pool: true,
            sla: { min: 60, left: 60 }, // default SLA for instance tasks (no per-task SLA yet)
            due: "",
            execType: "human" as const,
          } as unknown as InboxItem;
        } else {
          // Task is not waiting — may already be approved/done. Check the projection track
          // so we can still serve the detail view for recently completed tasks.
          // This covers the case where listInstanceInboxTasks drops approved tasks but the
          // UI still wants to show the outcome (e.g. "Завершено") after the approve action.
          const doneProj = (await listInstanceProjections(writeDeps.pool, tenantId))
            .find((p) => p.inboxTaskId === taskId && p.status === "done");
          if (doneProj) {
            item = {
              id: taskId,
              status: "done" as const,
              name: APPROVE_TASK_NAME,
              step: doneProj.step,
              inst: doneProj.inst,
              role: doneProj.role,
              pool: false,
              sla: { min: 60, left: 0 },
              due: "",
              execType: "human" as const,
            } as unknown as InboxItem;
          }
        }
      } catch {
        // Degrade gracefully.
      }
    }

    if (!item) {
      throw new HttpError(404, "NOT_FOUND", "task not found");
    }

    // Optionally attach an instance projection for instance-backed tasks.
    // These tasks originate from a process.started audit event; their id == inbox_task_id.
    // When the projection pool is available, look up the instance state so the UI can show
    // the current step, status (waiting | done), and the final outcome.
    let projection: import("./process-projection.js").InstanceProjection | undefined;
    if (writeDeps) {
      try {
        const tenantId = await writeDeps.resolveActorTenant(actor);
        const projections = await listInstanceProjections(writeDeps.pool, tenantId);
        // Match by inbox_task_id == the audit event id (the task id for instance tasks).
        // listInstanceInboxTasks uses the same event id as both inbox_task_id and task id.
        // Here we look for the instance whose waiting user-task id matches this task id.
        // Use the already-resolved instanceTaskForDetail if available.
        const waitingTask = instanceTaskForDetail
          ?? await findWaitingInstanceTask(writeDeps.pool, tenantId, taskId);
        if (waitingTask) {
          // Still waiting — find its projection.
          projection = projections.find((p) => p.inst === waitingTask.inst);
        } else {
          // May be done — a done projection's inboxTaskId equals the process.started
          // event id, which IS the taskId for instance-backed tasks (self-referential
          // back-link set in appendProcessStarted). Correlate by inboxTaskId so that in
          // a tenant with >1 completed process we return the right instance result, not
          // the first-done-wins arbitrary match (bug: p.status === "done" alone).
          projection = projections.find((p) => p.inboxTaskId === taskId);
        }
      } catch {
        // Degrade gracefully — projection is optional, never fail the detail fetch.
      }
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ item, projection: projection ?? null }));
  }));

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
  router.register("POST", "/api/inbox/:id/claim", withAuth(async (req, res, params) => {
    // Mode-aware actor resolution (T-0327 + T-0372: resolve KC sub → employee slug).
    const devUserId = await extractActorSlug(req, () => getOrgPool());

    const taskId = params["id"] as string;
    const tenantId = await resolveTenant(devUserId);
    const nowMs = Date.now();

    // Task must exist AND be visible in the actor's tenant.
    // T-0221: also check defer projections from audit_event when DB is available.
    const seedTask = INBOX_SEED.find((t) => t.id === taskId && t.tenant === tenantId);

    // For defer tasks from DB: look up in the merged inbox list.
    let taskRole: string | undefined = seedTask?.role;
    let taskIsPool: boolean = seedTask?.pool ?? false;

    if (!seedTask && hasDb()) {
      // Defer task: check if it's in the audit-floor projection.
      const deferRows = await listDeferredInboxTasks(getOrgPool(), tenantId);
      const deferTask = deferRows.find((r) => r.id === taskId);
      if (deferTask) {
        taskRole = deferTask.role;
        taskIsPool = true; // defer tasks are always pool tasks (AC-6)
      } else {
        // T-0282: also check started-instance projection (the U4 approval pool
        // task). Like defer tasks, instance tasks are always pool tasks (AC-3/AC-4).
        const instanceTask = await findWaitingInstanceTask(getOrgPool(), tenantId, taskId);
        if (instanceTask) {
          taskRole = instanceTask.role;
          taskIsPool = true;
        } else {
          throw new HttpError(404, "NOT_FOUND", "task not found");
        }
      }
    } else if (!seedTask) {
      throw new HttpError(404, "NOT_FOUND", "task not found");
    }

    // T-0336 (E15-S2): project claim-state from audit_event (task.claimed events).
    // In DB-mode: fail-closed — DB errors propagate → 500 (never silently allow).
    // In no-DB mode: empty map (T-0338 prerequisite for TOCTOU-safe concurrent claim).
    let claimStateMap = new Map<string, ClaimState>();
    if (hasDb()) {
      // No try/catch: DB errors propagate (fail-closed, NF-3). A transient error
      // here must NOT silently allow a claim on a stale empty state.
      claimStateMap = await loadClaimsFromAudit(getOrgPool(), tenantId);
    }

    // Check existing claim from audit projection
    const existing = claimStateMap.get(taskId);
    if (existing) {
      if (existing.claimedBy === devUserId) {
        // Idempotent re-claim — return current state (claimedAt preserved)
        const items = await findInboxItems(devUserId, nowMs, claimStateMap);
        const item = items.find((t) => t.id === taskId);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ item }));
        return;
      }
      throw new HttpError(409, "ALREADY_CLAIMED", "task already claimed by another user");
    }

    // Task must be pooled (not assigned to a specific person)
    if (!taskIsPool) {
      throw new HttpError(409, "NOT_POOL_TASK", "task is not a pool task and cannot be claimed");
    }

    // T-0336 (E15-S2): PDP resolveFor(op=transition) gate — claim-from-pool invariant.
    //
    // The PDP checks:
    //   1. Live grants via makeDbGrantSource (DB-backed, fail-closed on error).
    //   2. Role-slug eligibility: actor must hold the ROLE the task is addressed to.
    //      resolveRolesForActor uses getGrantsForSubject path (T-0331, same DB DAO).
    //
    // The role-slug check IS the operative PDP gate for this path: task-pool claim
    // eligibility is defined by role assignment, not by process_instance grants (which
    // are not modelled in the current grant table). The grant-lattice path (steps 2-4
    // of resolveFor) is traversed via resolveRolesForActor (getGrantsForSubject) and
    // propagates DB errors fail-closed (NF-3).
    //
    // In DB-mode: resolveRolesForActor errors propagate → 500 (fail-closed).
    // In no-DB mode: falls back to in-memory USER_ROLES fixture (memory tests).
    //
    // T-0372: devUserId is already the resolved employee slug (extractActorSlug
    // handled sub→slug above). No fallback needed — devUserId IS the slug.
    const myRoles = await resolveRolesForActor(devUserId, tenantId, nowMs);
    // T-0365: fail-closed — drop the `myRoles.length > 0 &&` guard that let a
    // zero-role actor skip the check. Now empty roles (or role-mismatch) ⇒ 403.
    // Keep `taskRole !== undefined` guard: unaddressed tasks have no role to check.
    if (taskRole !== undefined && !myRoles.includes(taskRole)) {
      throw new HttpError(403, "NOT_ELIGIBLE", "actor does not hold the role this task is addressed to");
    }

    // T-0338 (E15-S2-claim): Emit task.claimed audit event + insert DB claim-lock.
    // actor_type derived from PDP employee.kind (not from engine kind — spec §5).
    //
    // ONE tenant-RLS tx does ALL three (grant-check already ran above, fail-closed):
    //   (a) insertClaimLock — INSERT into user_task_claim (migration 078).
    //       The partial-unique (tenant_id, task_id) WHERE state='claimed' is the
    //       HARD DB LOCK: a concurrent second claim hits the unique constraint and the
    //       tx rolls back → error is caught and mapped to 409 ALREADY_CLAIMED.
    //   (b) appendTaskClaimed — task.claimed audit event (source of truth, §4.1).
    // Atomicity: if either step fails the whole tx rolls back — no half-state.
    //
    // In no-DB mode: skip (no audit backend, no claim-lock table).
    if (hasDb()) {
      // Resolve actor_type from employee.kind (PDP source — T-0336 §5).
      // Unknown actor defaults to "human" (accurate for human pool-task claim path).
      let actorKind: "human" | "agent" = "human";
      try {
        const emp = await findEmployeeById(getOrgPool(), tenantId, devUserId);
        if (emp?.type === "agent") actorKind = "agent";
      } catch {
        // Non-fatal: default to "human". DB error on actor resolution is not security-critical
        // for actor_type (it's telemetry); fail-closed is on the authz gate above, not here.
      }

      try {
        await withTenantTx(getOrgPool(), tenantId, async (client) => {
          const txClient = client as unknown as import("../db/audit-writer.js").PgClientLike;
          // Step (a): DB lock — conditional-upsert RETURNING closes TOCTOU window.
          // insertClaimLock throws AlreadyClaimedError when 0 rows are returned
          // (a different actor holds a live 'claimed' lock).  If it throws, the tx
          // rolls back here and appendTaskClaimed is NEVER reached — the loser leaves
          // no audit trace.
          await insertClaimLock(txClient, {
            taskId,
            claimedBy: devUserId,
            claimedAt: nowMs,
            role: taskRole ?? "",
            tenantId,
          });
          // Step (b): Audit event — source of truth for claim-state.
          // Only reached when insertClaimLock won the lock (returned ≥1 row).
          await appendTaskClaimed(txClient, {
            taskId,
            actor: devUserId,
            actorKind,
            tenantId,
            role: taskRole ?? "",
            nowMs,
          });
        });
      } catch (err: unknown) {
        // Primary rejection path: insertClaimLock detected a 0-row RETURNING result
        // (different actor holds a live 'claimed' lock) → 409 ALREADY_CLAIMED.
        if (err instanceof AlreadyClaimedError) {
          throw new HttpError(409, "ALREADY_CLAIMED", "task already claimed by another actor");
        }
        // Defense-in-depth: raw unique-constraint violation (23505) from the DB.
        // This is theoretically unreachable with the conditional-upsert logic, but
        // kept as a safety net in case of unexpected constraint behavior.
        const pgErr = err as Record<string, unknown>;
        if (typeof pgErr["code"] === "string" && pgErr["code"] === "23505") {
          throw new HttpError(409, "ALREADY_CLAIMED", "task already claimed by another actor");
        }
        throw err; // any other DB error → 500 (fail-closed)
      }

      // Re-load claim-state after emission so the response reflects the new claim.
      claimStateMap = await loadClaimsFromAudit(getOrgPool(), tenantId);
    }

    const items = await findInboxItems(devUserId, nowMs, claimStateMap);
    const item = items.find((t) => t.id === taskId);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ item }));
  }));

  // -------------------------------------------------------------------------
  // POST /api/inbox/:id/action — card-action on a waiting instance user-task
  // (T-0282 / ADR §2.3 / AC-5). Body: { action: "approve" }.
  //
  // The narrow approve card-action: it verifies the actor holds the `approve`
  // grant (role-eligibility — the actor holds the ROLE the task is addressed to,
  // the same deny-by-default invariant the claim path uses), writes ONE
  // task.approved audit_event via the canonical writer, and the projection
  // advances the instance to `done`. It is NOT a broad mutator: it only acts on a
  // waiting instance user-task it can resolve, and reaches NO engine transport of
  // its own — the audit write is the projection's source of truth (ADR §2.3).
  //
  // Registered only when writeDeps are present (DB-backed). Absent ⇒ 404.
  //
  // Authz / preconditions:
  //   - x-dev-user required: 401 UNAUTHENTICATED
  //   - body.action must be "approve": 400 VALIDATION
  //   - task must be a waiting instance task in the actor's tenant: 404 NOT_FOUND
  //   - actor must hold the role the task is addressed to (approve grant): 403 NOT_ELIGIBLE
  // Success: 200 { instanceId, status: "done", action: "approve" }
  if (writeDeps) {
    const { pool, resolveActorTenant: resolveActorTenantDep, outboxStore } = writeDeps;

    router.register("POST", "/api/inbox/:id/action", withAuth(async (req, res, params) => {
      // Mode-aware actor resolution (T-0327 + T-0372: resolve KC sub → employee slug).
      // CRITICAL: e-larina approve→200 requires the KC sub UUID to be resolved to the
      // seeded human slug 'e-larina' before grant/tenant lookup (T-0366 pattern).
      // Uses writeDeps.pool (injected, not the global getOrgPool) so the same pool is
      // used for resolution and the downstream approve tx — consistent connection behaviour.
      const actor = await extractActorSlug(req, () => pool);

      // Body validation — only the approve action is supported (AC-5; narrow scope).
      const rawBody = await readJsonBody(req);
      if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;
      const action = body["action"];
      if (action !== "approve") {
        throw new HttpError(400, "VALIDATION", "action must be 'approve'");
      }

      // T-0353 [E16]: Optional named outcome (the semantic branch the human chose,
      // e.g. "Согласовать", "На доработку"). When provided, it is recorded as a
      // STEP RESULT on the «Согласование» entity (DOCTRINE: outcome decision = record
      // field, NOT a process variable — RECORD_IN_PAYLOAD guard).
      // When absent, defaults to "approve" (backward compatible with existing tests).
      const rawOutcome = body["outcome"];
      const outcomeName: string =
        rawOutcome !== undefined && rawOutcome !== null && typeof rawOutcome === "string"
          ? rawOutcome
          : "approve";

      // Optional comment (also recorded on the entity, never in process variables).
      const rawComment = body["comment"];
      const outcomeComment: string | undefined =
        typeof rawComment === "string" ? rawComment : undefined;

      // T-0396: Optional human-filled form values from the inbox task card form.
      // T-0376 sends these as formValues: { [fieldKey]: value } when a form is bound
      // to the task. Minimal validation: must be a plain object (not null, not array).
      // Unknown/extra keys not in the form binding are silently forwarded — the
      // applier spreads them into the entity record under formData; the form binding
      // schema is the authoring-time contract (D-061 no-new-table: no runtime
      // re-validation against form_binding.fields here). Canonical provenance fields
      // (decision, approved_by, comment) are applied AFTER the spread so they cannot
      // be overridden by client-supplied values (security: formValues is untrusted).
      const rawFormValues = body["formValues"];
      const humanFormValues: Record<string, unknown> =
        rawFormValues !== null &&
        rawFormValues !== undefined &&
        typeof rawFormValues === "object" &&
        !Array.isArray(rawFormValues)
          ? (rawFormValues as Record<string, unknown>)
          : {};

      const taskId = params["id"] as string;
      const tenantId = await resolveActorTenantDep(actor);

      // The task must be a WAITING instance user-task in the actor's tenant.
      const task = await findWaitingInstanceTask(pool, tenantId, taskId);
      if (!task) {
        throw new HttpError(404, "NOT_FOUND", "no waiting instance task with this id");
      }

      // T-0336 (E15-S2): PDP resolveFor(op=approve) gate.
      //
      // approve-grant check (deny-by-default): the actor must hold the role the task
      // is addressed to via the LIVE getGrants DAO (T-0331 + T-0336 upgrade).
      //
      // The resolveFor PDP is wired via resolveRolesForActor which calls
      // getGrantsForSubject (makeDbGrantSource path) — traversing the full grant-lattice
      // resolution (get grants → filter effective → filter by role slug). DB errors
      // propagate fail-closed (NF-3): a transient DB error must NOT silently allow
      // an actor whose grants have been revoked.
      //
      // actor_type: derived from PDP employee.kind (spec §5 / T-0336).
      // An agent actor (employee.kind='agent') holding role-approver is denied here
      // structurally (the moat: agents have NO approve grant — see tel-scenario seed).
      //
      // T-0372: actor is already the resolved employee slug (extractActorSlug handled
      // the sub→slug resolution above). No fallback needed — actor IS the slug.
      const nowMs = Date.now();
      const myRoles = await resolveRolesForActor(actor, tenantId, nowMs);
      if (!myRoles.includes(task.role)) {
        throw new HttpError(
          403,
          "NOT_ELIGIBLE",
          "actor does not hold the approve grant for this task",
        );
      }

      // F2 (T-0335): compute the wall-clock task duration ONCE here, in the approve
      // handler. occurredAt = the process.started occurred_at (when the task became
      // available); nowMs = the approve instant. Threaded into appendTaskApproved
      // (transition_payload.duration_ms) AND the step_applied outbox payload below.
      const durationMs = Math.max(0, nowMs - task.occurredAt);

      // The atomic approve unit (ONE tenant-scoped tx, RLS):
      //   task.approved audit (projection → `done`)
      //   ⊕ applyStepResult (A: «Согласование» record + record.create audit + step_applied outbox)
      // A caller ROLLBACK (any throw, e.g. the applier's fail-closed FF-G3 path)
      // undoes BOTH — zero records AND zero approve events (T-0335 fitness).
      await withTenantTx(pool, tenantId, async (client) => {
        await appendTaskApproved(client as unknown as import("../db/audit-writer.js").PgClientLike, {
          taskId,
          instanceId: task.inst,
          procKey: task.procKey,
          actor,
          nowMs,
          durationMs, // T-0335: real duration (was hard-coded null in T-0332)
          tenantId,
        });

        // T-0335 applier seam: engage ONLY when the outbox store is wired (the
        // entity-write path). Absent ⇒ honest-degrade to approve-audit-only.
        if (outboxStore) {
          // F1 step-class from form_binding (default-to-A; B → skipped/deferred).
          const stepClass = await readStepClass(client, tenantId, task.procKey);

          // T-0353 [E16] + T-0396: Build formData with the outcome decision AND
          // human-filled form field values from the inbox card form.
          // DOCTRINE (choros-data-ownership-doctrine + RECORD_IN_PAYLOAD guard):
          //   The outcome decision + optional comment + human form values are all
          //   STEP RESULT = ENTITY. They go into the «Согласование» registry record
          //   via applyStepResult's formData — NOT into process variables (Flowable).
          //
          //   humanFormValues — spread FIRST (user-supplied fields from the bound form)
          //   decision       — outcomeName (e.g. "Согласовать"); applied AFTER spread so
          //                    it cannot be overridden by client-submitted formValues
          //   approved_by    — actor slug (provenance); applied AFTER spread (same reason)
          //   comment        — outcomeComment (optional); applied AFTER spread (same reason)
          //
          //   Canonical provenance fields (decision, approved_by, comment) always win
          //   over any identically-named key inside humanFormValues — the server is the
          //   source of truth for provenance, not the client.
          //
          //   The outcome-branch resolver (outcome-branch-resolver.ts) can later
          //   read outcomeName from the flow definition to determine routing when
          //   the process is extended to use named branches. For now, the action
          //   route records the entity — branch resolution is the engine's job.
          // T-0396: Strip prototype-pollution sentinel keys from client-supplied
          // formValues before spreading. JSON.parse+spread is safe at runtime but
          // literal keys `__proto__`, `constructor`, `prototype` have no valid
          // business meaning and must not be stored in the JSONB record.
          const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
          const protoStrippedFormValues: Record<string, unknown> = Object.fromEntries(
            Object.entries(humanFormValues).filter(([k]) => !PROTO_KEYS.has(k)),
          );

          // T-0400 [D7-2]: Runtime form-submit validation (PD-9 at runtime).
          // Validate proto-stripped values against form_binding.fields AND the live
          // registry_def.record_schema BEFORE writing to JSONB. Three rules enforced:
          //   1. Unknown keys → REJECT (not written to JSONB).
          //   2. Enum values → validated against BindingField.options[].
          //   3. Schema drift → fields removed from live schema are flagged.
          // Provenance fields (decision, approved_by, comment) are NOT in
          // form_binding.fields and are appended AFTER this call, so they are never
          // subject to these checks. Proto keys were already stripped above.
          const validationResult = await validateAndFilterFormValues(
            client,
            tenantId,
            task.procKey,
            protoStrippedFormValues,
          );
          if (!validationResult.ok) {
            // Build a readable error message listing all violations.
            const msgs = validationResult.violations
              .map((v) => `[${v.type}] ${v.message}`)
              .join("; ");
            throw new HttpError(
              422,
              "FORM_VALIDATION",
              `form submit validation failed: ${msgs}`,
            );
          }

          const formData: Record<string, unknown> = {
            ...validationResult.safeValues, // T-0400: only validated keys (unknown keys rejected)
            decision: outcomeName,
            approved_by: actor,
            // Fix 2 (review): canonical comment ALWAYS wins. When outcomeComment is
            // defined, it overwrites any client-supplied formValues["comment"].
            // When undefined, explicitly set to undefined so that a client-supplied
            // "comment" key in humanFormValues is evicted from the persisted record
            // (the canonical path is body.comment → outcomeComment, not formValues).
            comment: outcomeComment,
          };

          await applyStepResult(client, {
            tenantId,
            instanceId: task.inst,
            procKey: task.procKey,
            activity: task.step,
            actor,
            taskId,
            stepClass,
            formData,
            durationMs,
            nowMs,
            outboxStore,
          });
        }
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      // T-0353 [E16]: include outcomeName in response so the caller can show the
      // chosen branch label in the UI (e.g. "Согласовано", "Отклонено").
      res.end(
        JSON.stringify({ instanceId: task.inst, status: "done", action: "approve", outcome: outcomeName }),
      );
    }));
  }
}

/**
 * T-0336 (E15-S2): _resetClaimStateForTests is now a no-op.
 *
 * Claim-state is derived from the audit_event track (task.claimed events).
 * In no-DB/memory mode there is no persistent claim-state to reset.
 * In DB mode the test isolation is handled by the DB template isolation
 * (freshTenant per test run — ci/checks/db/*.test.ts pattern).
 *
 * The T-0338 deferred DB claim-lock will add the TOCTOU-safe
 * concurrent-claim primitive; until then, no-DB tests lose claim-state
 * persistence (known, tracked risk — see claim-projection.ts §CONCURRENT-CLAIM).
 *
 * Not called from production code. Preserved for test import compatibility.
 */
export function _resetClaimStateForTests(): void {
  // No-op: in-memory CLAIMED Map removed (T-0336). Claim-state = audit_event projection.
}
