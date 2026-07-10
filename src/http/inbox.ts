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
import { randomUUID } from "node:crypto";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { JobStore } from "../core/jobStore.js";
import { findEmployee } from "./org.js";
import { batchResolveActors, resolveActorDisplay, type ResolvedActor } from "../db/actor-resolver.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { DEV_TENANT_ID, getOrgPool, resolveActorTenant, resolveActorSlugFromAuth } from "../db/org.js";
import { findEmployeeById } from "../db/org.js";
import {
  getRoleSlugsForActor,
  getHoldersForRole,
  findTenantOwnerSlug,
  getRoleAssignmentOrgScopesForEmployee,
} from "../db/grants-dao.js";
import { getActiveSubstitutionsByRole, getActiveSubstitutionsForSubstitute } from "../db/substitution-dao.js";
import { isRuleEffective, computeEffectivePool } from "../core/substitution.js";
import { isGenesisOwnerForTenant } from "../db/org.js";
import { isNarrowerOrEqual, type ScopeElement } from "../core/grant-lattice.js";
import { loadTenantOrgAncestry } from "../db/org-ancestry.js";
import { parsePaginationParams, paginateInMemory } from "../core/data-access-port.js";
// executor-resolver: the batch path (resolveExecutorFallbackBatch below) calls
// DAO functions directly for performance (avoids port-wrapper overhead at scale).
// resolveExecutor (src/core/executor-resolver.ts) remains the canonical single-task
// entry point for callers outside inbox.ts (e.g. claim write-path, future per-task
// routing logic).
// Factory functions (makeDbRoleHolderSource, makeTenantOwnerFallbackPort,
// makeDbSubstitutionPort) are available for callers that use the single-task
// resolveExecutor path — they are not used in the batch path here.
import { listDeferredInboxTasks } from "../db/deferred-inbox-store.js";
import { makePgAuditWriter } from "../db/audit-writer.js";
import {
  APPROVE_TASK_NAME,
  resolveDefaultApproverRole,
  appendTaskApproved,
  findWaitingInstanceTask,
  listInstanceInboxTasks,
  listInstanceProjections,
  reconcileInstanceTimers,
  reconcileInstanceEngineDrive,
  reconcileInboxEngineDriveOnRead,
  surfaceMessageCatchWaits,
  makeEngineMessageSubscriptionSource,
  ENGINE_TASK_NOT_FOUND,
  AMBIGUOUS_ACTIVE_TASK,
  ENGINE_DRIVE_TIMEOUT,
  type InstanceProjection,
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
import type { FlowableClient } from "../core/flowable-client.js";
import {
  overlayLiveSteps,
  resolveLiveNodesByInstance,
  type CatalogEnginePort,
} from "../core/process-catalog-view.js";
import { resolveActorPrivilege } from "../db/sandbox-gate-dao.js";

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
   * T-0683 (D-064, wave-5 human-layer): the HUMAN-READABLE process-definition
   * name for this task's instance (from InstanceInboxTask.processName, resolved
   * batched from choros.process_definition.name — reused resolveDefinitionNames).
   * The inbox «ПРОЦЕСС» column renders THIS as the primary identifier instead of
   * the raw instance-UUID (`inst`). Additive optional — absent on seed fixtures
   * (whose `inst` is a human "INS-7731" label, already non-UUID) and on defer/
   * agent rows that have no process definition; the client's ProcessRef falls
   * back to the task step/name for those, never to a bare machine key.
   */
  processName?: string;
  /**
   * T-0653 (W5-UX/§4): the process-definition KEY of this task's instance —
   * carried so the server can filter/group by process exactly (a stable machine
   * key), independent of the human processName. Additive optional — absent on
   * seed fixtures and defer/agent rows with no process definition. NEVER rendered
   * as a primary identifier (anti-uuid); used only as a filter/group axis.
   */
  procKey?: string;
  /**
   * T-0683: originating business record id (present when the process was started
   * by an on_create trigger). The client's RecordRef lazily resolves this to the
   * record's TITLE — the human disambiguator between two instances of the same
   * process. Additive optional — absent for manually-started / seed / defer rows.
   */
  recordId?: string;
  /**
   * Role/position the task is ADDRESSED TO. Invariant: a task targets a role, not a
   * specific human. "Из пула" claim eligibility is computed from this, not from execName.
   */
  role: string;
  /**
   * T-0653: server-computed «this is an approval task» flag — true when the
   * task's role is the tenant's configured approver role (APPROVER_ROLE, env-
   * configurable, single source of truth in process-projection.ts). Lets the
   * inbox show the inline «Согласовать» quick-action WITHOUT hardcoding the
   * role slug in the client (D-064: the case-role literal stays server-side).
   * Additive optional — absent ⇒ no inline approve affordance (the server still
   * enforces eligibility on POST /api/inbox/:id/action regardless).
   */
  canApprove?: boolean;
  /** Task is an escalation (drives the «Эскалации» tab without step string-matching). */
  escalated?: boolean;
  execType?: ExecKind;
  execName?: string;
  /**
   * T-0648 (W4-UX): raw actor identifier behind execName (employee slug, or the raw
   * id when unresolved) — carried alongside execName so the client's ActorChip can
   * show the machine id as a secondary/tooltip affordance instead of as the primary
   * label. Additive optional field; absent implies execName IS already the display
   * name with no separate raw id (seed fixtures, e.g.).
   */
  execSlug?: string;
  /**
   * T-0648 FIX-3: the claimer's soft-deactivation marker (ResolvedActor.
   * deactivated). Additive optional field — lets the client's ActorChip show
   * the «(деактивирован)» marker for a claim held by an actor who was
   * subsequently deactivated (a lost signal today). Absent ⇒ active/unknown.
   */
  execDeactivated?: boolean;
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
  /**
   * T-0459 [D8-R4]: true when this waiting row represents an instance PARKED ON A
   * MESSAGE-CATCH (receiveTask / intermediateCatchEvent(message|signal) / message
   * boundary) — it is WAITING for a correlated message, not for a human decision.
   * Drives the card / inbox to render «Ожидает сообщения» instead of an actionable
   * approve button. Additive optional field — absent on all existing tasks.
   */
  messageCatch?: boolean;
  /**
   * T-0459 [D8-R4]: the message/signal name a messageCatch row is waiting for
   * (surfaced for the card label «Ожидает: <messageName>»). Present only on
   * messageCatch rows.
   */
  messageName?: string;
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

/** Built-in fallback when ENGINE_DRIVE_DEADLINE_MS is not set (T-0591 F-2). */
const DEFAULT_ENGINE_DRIVE_DEADLINE_MS = 10_000;

/**
 * T-0591 (F-2, ADR-T0591-drive-deadline §2.4): overall wall-clock budget (ms)
 * for the ENTIRE post-approve engine-drive path (reconcileInstanceEngineDrive's
 * poll loop + completeUserTask + both isInstanceEnded checks + fan-out). Read
 * LAZILY per-call (mirrors claim-reaper.ts's sweepStaleClaims: `opts.thresholdMs
 * ?? (process.env[...] ? parseInt(...) : DEFAULT)`), not cached at module load —
 * so tests can flip the env var per-case, and so a running process picks up an
 * operator override without a restart. Absent/invalid env ⇒ built-in default
 * 10_000 — honest-degrade, symmetric with reconcileInstanceEngineDrive's own
 * pollTimeoutMs/pollIntervalMs defaults.
 */
function resolveEngineDriveDeadlineMs(): number {
  const raw = process.env["ENGINE_DRIVE_DEADLINE_MS"];
  if (raw === undefined || raw === "") return DEFAULT_ENGINE_DRIVE_DEADLINE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ENGINE_DRIVE_DEADLINE_MS;
}

// ---------------------------------------------------------------------------
// T-0718 [E16/P1, из re-proof T-0709]: live-engine step overlay for the INBOX
// detail projection — the SAME snapshot↔engine divergence T-0709 closed on the
// catalog + detail planes, in the THIRD read surface (GET /api/inbox/:id).
//
// THE BUG (found live, T-0709 LIVE_PROOF; родитель T-0349): GET /api/inbox/:id
// returns { item, projection }. `projection` comes straight from
// listInstanceProjections — the process.started audit SNAPSHOT, frozen at start
// and never re-derived as the token advances. So the drawer shows the item's
// LIVE step (item.step, from the waiting userTask) beside a PHANTOM projection
// step (projection.step, the frozen/next-node snapshot) — e.g. item.step
// 'Завершить проверку' vs projection.step 'Согласование' on the same instance.
// T-0709's overlay reached the catalog (/api/process-catalog) and detail
// (/api/processes[/:id]) planes but NOT this one; the inbox projection stayed
// frozen while the other two went live — the exact divergence class T-0709
// existed to kill, moved to the inbox side.
//
// THE FIX (reuse of the T-0709 core, no duplication): overlay this single
// projection's step/role/concurrentSteps with the engine's REAL active
// user-task set via the SAME resolveLiveNodesByInstance + overlayLiveSteps the
// catalog and detail planes share (src/core/process-catalog-view.ts — the single
// source of truth). overlayLiveSteps<P extends ProjectionLike> is generic and
// preserves InstanceProjection's extra fields (concurrentSteps included), so the
// inbox projection now reflects the token's real position, identically to the
// other two surfaces — they cannot diverge.
//
// Honest degrade (identical to the catalog/detail overlay): no getActiveUserTasks
// method on the injected client (bare test stubs), engine unreachable, no active
// user-task, the shared deadline elapsing, or a done projection ⇒ the projection
// is returned byte-identical on its audit snapshot — never worse than before,
// never a 500. Display-only: status/startedAt/inboxTaskId are untouched (the
// audit track is not rewritten). Reaches the engine ONLY through the injected
// FlowableClient's read method — no bare fetch, no write path.
// ---------------------------------------------------------------------------

/**
 * Same per-request live-overlay budget the catalog + detail planes use
 * (processes.ts LIVE_OVERLAY_DEADLINE_MS). Re-declared as a plain number (kept in
 * sync by intent — all three read surfaces bound the best-effort overlay
 * identically; the shared LOGIC lives in the core resolveLiveNodesByInstance).
 */
const LIVE_OVERLAY_DEADLINE_MS = 2_000;

/**
 * Overlay the live active-node (step/role/concurrentSteps) onto ONE inbox-detail
 * projection, reading the engine through the injected FlowableClient. Reuses the
 * SAME core helpers (resolveLiveNodesByInstance + overlayLiveSteps) the catalog
 * and detail planes use, so all three read surfaces agree on the current step.
 *
 * Best-effort + bounded by the shared deadline. When the client is absent / has
 * no getActiveUserTasks method (older stubs), the projection is done, or the
 * engine yields no live node, the projection is returned UNCHANGED — honest
 * degrade to the audit snapshot (never worse than pre-T-0718, never a throw).
 */
async function overlayInboxDetailLiveStep(
  flowable: FlowableClient | undefined,
  projection: InstanceProjection,
): Promise<InstanceProjection> {
  if (projection.status === "done") return projection;
  const port = flowable as unknown as Partial<CatalogEnginePort> | undefined;
  if (!port || typeof port.getActiveUserTasks !== "function") return projection;
  try {
    const liveByInst = await resolveLiveNodesByInstance(
      port as CatalogEnginePort,
      [projection.inst],
      { deadlineMs: LIVE_OVERLAY_DEADLINE_MS },
    );
    return overlayLiveSteps([projection], liveByInst)[0]!;
  } catch {
    // Best-effort: an engine miss must never fail the detail read (honest degrade).
    return projection;
  }
}

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
  /**
   * T-0443: optional FlowableClient for engine-drive post-approve.
   * When present, the approve handler resolves the engine task by taskDefinitionKey,
   * completes it, and reconciles (isInstanceEnded → emit instance.ended or
   * emit process.next_task with live defKey/name/role). Absent ⇒ unchanged
   * linear audit-only behaviour (honest-degrade).
   */
  flowableClient?: FlowableClient;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// T-0638 (F2): canonical audit writer for the defer-resolve branch of the
// approve action route (agent.defer_resolved event) — same single-writer
// discipline as process-projection.ts's module-scope `writer`.
const deferResolveAuditWriter = makePgAuditWriter();

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
// T-0380/T-0429 (D4): Executor resolver — batched fallback resolution
//
// `resolveExecutorFallbackBatch` is called ONCE per inbox read (DB mode only)
// to compute the routed_to_fallback patch for ALL instance tasks in a single
// batched pass. It avoids the N+1 pattern that results from calling the resolver
// once per task under Promise.all (≤200 tasks × 2 DB txs = up to 400 connections
// against a max=10 pool).
//
// Batching strategy (T-0429 ladder fix — substitution wired):
//   1. Collect the DISTINCT set of role slugs across all unclaimed instance tasks.
//   2. Resolve holders for each DISTINCT role slug in parallel (at most once per role).
//   3. T-0429: For roles that HAVE holders, fetch active substitution rules
//      (getActiveSubstitutionsByRole — one DB tx per distinct role). Apply
//      suppress-absent + add-substitute per holder in-memory. A role whose effective
//      pool shrinks to zero after substitution proceeds to fallback (rung 4).
//   4. Resolve the tenant owner slug ONCE when at least one role has an empty
//      effective pool (unfilled OR all holders absent with no substitutes).
//   5. For each task, look up its role's resolution from the in-memory maps built
//      in steps 2–4 and compute the patch without any further DB round-trips.
//
// No-DB path: caller skips this function entirely (instanceTasks is never populated
// without hasDb()); no-DB inbox uses INBOX_SEED only.
//
// "absent" ≠ "unfilled" distinction (T-0429 лесенка fix):
//   - "absent"  (rung 3): a KNOWN holder has an active substitution rule → route to
//     their substitute. If all holders are absent and all have substitutes, the task
//     reaches the substitutes, NOT the fallback owner.
//   - "unfilled" (rung 4): the role's effective pool is empty (either no holders at
//     all, or all holders absent with no active substitutes) → route to owner + F7.
// ---------------------------------------------------------------------------

/**
 * T-0380/T-0429 (D4/F6/F7): Batch fallback patch resolver with substitution.
 *
 * Given a list of (taskId, roleSlug) pairs from unclaimed instance inbox tasks,
 * resolves which tasks need `routed_to_fallback: "role_unfilled"` — in a single
 * batched pass rather than one DB trip per task.
 *
 * T-0429: now applies the full rung-3 substitution logic (suppress absent holders,
 * add substitutes) before deciding whether to go to fallback (rung 4). A role
 * whose holders are all absent WITH active substitutes does NOT go to fallback —
 * the substitute(s) form the effective pool for that role.
 *
 * Returns a Map<taskId, { routed_to_fallback: "role_unfilled" }> for tasks whose
 * effective pool (after substitution) is empty. Tasks with live holders (or
 * substitutes for absent holders) are absent from the map.
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

    // Step 3: T-0429 substitution rung — for roles that HAVE holders, apply the
    // suppress-absent + add-substitute logic in-memory.
    //
    // We batch: for each DISTINCT role that has holders, fetch ALL active
    // substitution rules for that role in ONE DB tx (getActiveSubstitutionsByRole),
    // then iterate over the holders to build the effective pool.
    //
    // The effective pool per role:
    //   - Start with the raw holder set.
    //   - For each holder: if an active substitution rule exists (absentEmployeeId
    //     === holderSlug, confirmed, in-window), SUPPRESS the absent holder and ADD
    //     their substituteEmployeeId (the substitute's slug from mapRow).
    //   - If the effective pool is still non-empty → role is covered; no fallback.
    //   - If the effective pool is empty (all holders absent, all substitutes also
    //     absent or no substitute) → treat as "unfilled" → fallback (rung 4).
    //
    // Chain substitutions (substitute is also absent) are NOT resolved in the batch
    // path (the batch keeps one DB tx per role; chains require recursive lookup).
    // For the fallback-patch use-case (decide: fallback vs. pool?), a single-hop
    // check is sufficient: if A→B and B is also absent, the effective pool still
    // contains B's slug — a task will route there and the inbox will show B as the
    // candidate. Substitution is single-hop everywhere (the single-task resolver
    // path does not follow chains either); chains A→B→C are never resolved.
    const effectivePoolByRole = new Map<string, readonly string[]>();
    await Promise.all(
      distinctRoles.map(async (roleSlug) => {
        const holders = holdersByRole.get(roleSlug) ?? [];
        if (holders.length === 0) {
          // Unfilled role: effective pool is empty immediately (skip substitution).
          effectivePoolByRole.set(roleSlug, []);
          return;
        }

        // Fetch all active substitution rules for this role in one DB tx.
        let substRules: import("../core/substitution.js").SubstitutionRule[] = [];
        try {
          substRules = await getActiveSubstitutionsByRole(pool, tenantId, roleSlug, nowMs);
        } catch {
          // Degrade gracefully: if substitution lookup fails, use raw holders.
          effectivePoolByRole.set(roleSlug, holders);
          return;
        }

        if (substRules.length === 0) {
          // No substitution rules → pool is unchanged.
          effectivePoolByRole.set(roleSlug, holders);
          return;
        }

        // T-0744: build the effective pool via the ONE coverage invariant
        // (computeEffectivePool). An absent holder is always suppressed; the
        // substitute re-joins ONLY when they provide coverage (Tier-2 grant, or
        // they personally hold the role). A Tier-1 non-holder no longer masks an
        // emptied role — routing now agrees with the claim-gate, so the role
        // surfaces as routed_to_fallback:"role_unfilled" (§2.4/§3-в1).
        effectivePoolByRole.set(roleSlug, computeEffectivePool(holders, substRules, roleSlug));
      }),
    );

    // Step 4: resolve tenant owner slug ONCE — only needed when at least one role
    // has an empty effective pool (unfilled or all holders absent with no substitute).
    const rolesWithEmptyPool = distinctRoles.filter(
      (slug) => (effectivePoolByRole.get(slug) ?? []).length === 0,
    );
    let ownerSlug: string | null = null;
    if (rolesWithEmptyPool.length > 0) {
      ownerSlug = await findTenantOwnerSlug(pool, tenantId, nowMs);
    }

    // Step 5: for each task, apply the resolution from in-memory effective-pool map.
    for (const task of tasks) {
      const effective = effectivePoolByRole.get(task.role) ?? [];
      if (effective.length > 0) {
        // Effective pool is non-empty (live holders or substitutes) → no fallback.
        continue;
      }
      // Effective pool is empty — role_unfilled (rung 4). Mark regardless of whether
      // an owner was found (mirrors the "unresolvable" branch in resolveExecutor).
      if (rolesWithEmptyPool.includes(task.role)) {
        result.set(task.id, { routed_to_fallback: "role_unfilled" as const });
        void ownerSlug; // resolved above; used structurally by the fallback path
      }
    }
  } catch {
    // Degrade gracefully: executor resolver errors are non-fatal for inbox reads.
    // Tasks surface without fallback marking rather than blocking the inbox.
  }

  return result;
}

// ---------------------------------------------------------------------------
// T-0558 (sandbox gate): suppress instance tasks whose originating process
// DEFINITION is not published, for a NON-privileged caller.
//
// The inbox projection is audit-event-backed (it does not join process_definition),
// so the gate is applied as a post-projection filter at the smallest correct seam:
// given the DISTINCT procKeys across the unclaimed/instance tasks, query
// process_definition.status (tenant-scoped) to learn which keys are PUBLISHED, then
// drop tasks whose key is draft/unknown. Privileged actors (owner/admin OR
// authoring_draft grant) are exempt — they may dry-run sandbox processes.
//
// Tenant isolation (T-0013) is preserved: the lookup runs inside a tenant-scoped RLS
// tx with an explicit tenant_id WHERE guard — it NEVER broadens the tenant scope, it
// only narrows the already-tenant-scoped result. Degrades fail-CLOSED in spirit but
// safe in practice: a DB error leaves the unprivileged caller seeing nothing newly
// surfaced beyond what was already projected (we return the unfiltered set only when
// the lookup itself cannot run — see the no-DB short-circuit at the call site).
// ---------------------------------------------------------------------------

/**
 * Return the subset of `procKeys` that are POSITIVELY KNOWN to be DRAFT in this tenant
 * — i.e. a process_definition row exists for the key AND its latest status is draft (no
 * published version of the same key exists). Keys with a published version, or with NO
 * process_definition row at all (legacy / directly-deployed engine processes), are NOT
 * returned: absence of a draft record is not evidence of draft, so those tasks stay
 * visible. This makes the gate hide ONLY what it can prove is sandbox.
 *
 * Tenant-scoped (SET LOCAL choros.tenant_id + explicit WHERE guard). An empty input or
 * any DB error returns an empty set (fail-OPEN for visibility on a read projection — a
 * lookup failure must not blank a legitimate inbox; the authored-draft hiding is a
 * best-effort projection narrowing, never a tenant-scope relaxation).
 */
export async function draftOnlyProcessKeys(
  pool: pg.Pool,
  tenantId: string,
  procKeys: readonly string[],
): Promise<Set<string>> {
  const draftOnly = new Set<string>();
  const distinct = [...new Set(procKeys)].filter((k) => k.length > 0);
  if (distinct.length === 0) return draftOnly;
  if (!UUID_RE.test(tenantId)) return draftOnly;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    // A key is draft-ONLY when it has at least one row but NO published row.
    const res = await client.query<{ process_key: string }>(
      `SELECT process_key
         FROM choros.process_definition
        WHERE tenant_id = $1
          AND process_key = ANY($2::text[])
        GROUP BY process_key
        HAVING bool_or(status = 'published') = false`,
      [tenantId, distinct],
    );
    await client.query("COMMIT");
    for (const row of res.rows) draftOnly.add(row.process_key);
  } catch {
    await client.query("ROLLBACK").catch(() => {});
  } finally {
    client.release();
  }
  return draftOnly;
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
  // T-0710 [E16, capstone T-0691 P2]: optional instance SCOPE (GET /api/inbox
  // ?instance=<id>). Pushed into the SQL-backed sources (listInstanceInboxTasks /
  // listDeferredInboxTasks — each filters its OWN honest instance-identity field,
  // not a shared post-fetch predicate) and applied to the in-memory seed fixture.
  // Absent/null ⇒ byte-identical to the pre-T-0710 unscoped read.
  instanceFilter?: string | null,
): Promise<InboxItem[]> {
  const tenantId = await resolveTenant(devUserId);
  const instScope = instanceFilter && instanceFilter.trim() !== "" ? instanceFilter.trim() : undefined;

  // T-0653 (fix-forward defect #10): the `canApprove` flag must compare the
  // task's role against the ENV-CONFIGURABLE default approver role
  // (resolveDefaultApproverRole → CHOROS_DEFAULT_APPROVER_ROLE), matching the
  // InboxItem.canApprove doc-comment promise — NOT the raw APPROVER_ROLE
  // literal. Resolved once per read and reused on BOTH the instance path and
  // the defer path (fix-forward defect #4) so the two cannot drift.
  const approverRole = resolveDefaultApproverRole();

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
    .filter((item) => item.tenant === tenantId)
    // T-0710: seed fixtures carry their own honest `.inst` — scope in-memory
    // (no LIMIT-window concern for a small constant fixture array).
    .filter((item) => instScope === undefined || item.inst === instScope);

  // T-0648 (W4-UX/столп 4): resolve display info for EVERY distinct claimer across
  // the WHOLE claim-state map (seed + defer + instance items all share claimStateMap)
  // in ONE batched query — not one findEmployee() call per distinct claimer, and not
  // three separate resolutions (one per item block below). A resolver failure
  // degrades to an empty map (every item then falls back to the raw claimedBy id via
  // resolveActorDisplay below), never turning a read into a 500.
  const distinctClaimers = [...new Set([...claimStateMap.values()].map((c) => c.claimedBy))];
  let claimerResolved: Map<string, ResolvedActor> = new Map();
  if (hasDb() && distinctClaimers.length > 0) {
    try {
      claimerResolved = await batchResolveActors(getOrgPool(), tenantId, distinctClaimers);
    } catch {
      claimerResolved = new Map();
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
      const claimerInfo = resolveActorDisplay(claimerResolved, claim.claimedBy);
      return {
        ...item,
        pool: false,
        execType: claimerInfo.type,
        execName: claimerInfo.name,
        execSlug: claim.claimedBy,
        execDeactivated: claimerInfo.deactivated,
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
    const deferRows = await listDeferredInboxTasks(getOrgPool(), tenantId, { instanceId: instScope });

    // T-0638 (F6, defect #4): honest addressing — a defer task addressed to a
    // role with NO confirmed holders in this tenant must not go to a
    // literal-hardcoded fallback role that may hold nobody either (the bug:
    // dispatch-outcome.ts / run-precheck.ts / deferred-inbox-store.ts each
    // fall back to a code-literal role — "role-approver" / "fin-ctrl" —
    // regardless of whether that role has a live holder). Reuse the SAME
    // batched fallback resolver already proven for instance tasks (T-0380 D4,
    // resolveExecutorFallbackBatch below) so an unfilled role routes to the
    // tenant owner (routed_to_fallback:"role_unfilled"), instead of silently
    // becoming unclaimable by anyone. Only UNCLAIMED rows need resolution —
    // a claimed row already has a real assignee.
    const unclaimedDeferTasks = deferRows
      .filter((row) => !claimStateMap.get(row.id))
      .map((row) => ({ id: row.id, role: row.role }));
    const deferFallbackPatches = await resolveExecutorFallbackBatch(
      unclaimedDeferTasks,
      tenantId,
      nowMs,
    );

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
        // T-0653 (fix-forward defect #4): a claimed defer task addressed to the
        // approver role must keep the inline «Согласовать» affordance — the
        // client now gates the quick-action on t.canApprove (was t.role===...),
        // so without this the claimed role-approver defer row lost its button.
        // Same env-configurable role check as the instance path (defect #10).
        ...(row.role === approverRole ? { canApprove: true } : {}),
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
        // T-0638 (F7, defect #2): a defer task IS an escalation by definition —
        // the agent declined to act autonomously and a human must decide. Drives
        // the «Эскалации» tab (inTab('esc',...) already checks item.escalated).
        escalated: true,
      };

      if (claim) {
        const mine =
          devUserId !== undefined && devUserId !== null && devUserId === claim.claimedBy;
        const claimerInfo = resolveActorDisplay(claimerResolved, claim.claimedBy);
        return {
          ...base,
          pool: false,
          execType: claimerInfo.type,
          execName: claimerInfo.name,
          execSlug: claim.claimedBy,
          execDeactivated: claimerInfo.deactivated,
          claimedBy: claim.claimedBy,
          claimedAt: claim.claimedAt,
          mine,
        };
      }

      // T-0638 (F6): apply the honest-addressing fallback patch when this
      // role has no live holders — same shape as the instance-task path.
      const fallbackPatch = deferFallbackPatches.get(row.id);
      if (fallbackPatch) {
        return { ...base, ...fallbackPatch };
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
    const instanceTasks = await listInstanceInboxTasks(getOrgPool(), tenantId, { instanceId: instScope });

    // T-0558 (sandbox gate): remember each task's originating process key so we can
    // suppress tasks of a DRAFT (unpublished) process definition for a non-privileged
    // caller (the InboxItem wire shape does not carry procKey).
    const procKeyByTaskId = new Map<string, string>();
    for (const row of instanceTasks) procKeyByTaskId.set(row.id, row.procKey);

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
        // T-0683 (D-064, wave-5): carry the HUMAN process name + originating record
        // id so the inbox «ПРОЦЕСС» column shows a human identifier, not the raw
        // instance-UUID. processName is always present on an instance task (the
        // projection guarantees a fallback name); recordId only when on_create-started.
        processName: row.processName,
        // T-0653: carry procKey as a stable filter/group axis (never rendered primary).
        ...(row.procKey !== undefined ? { procKey: row.procKey } : {}),
        ...(row.recordId !== undefined ? { recordId: row.recordId } : {}),
        role: row.role,
        // T-0653: approval-task flag (server-side role check; no client literal).
        // Compares against the env-configurable resolved approver role (defect #10).
        ...(row.role === approverRole ? { canApprove: true } : {}),
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
        // T-0458 [D8-R3]: carry the timer-firing escalation provenance + F5 prefill
        // reason from the projection so the «Эскалации» tab + prefilled form work
        // without client-side string-matching.
        ...(row.escalated ? { escalated: true } : {}),
        ...(row.doubtReason ? { doubt_reason: row.doubtReason } : {}),
        // T-0459 [D8-R4]: carry the message-catch wait provenance + awaited message
        // name so the card renders «Ожидает сообщения» (not an approve button) and
        // the wait is observable in the GET /api/inbox response.
        ...(row.messageCatch ? { messageCatch: true } : {}),
        ...(row.messageName ? { messageName: row.messageName } : {}),
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
        const claimerInfo = resolveActorDisplay(claimerResolved, claim.claimedBy);
        return {
          ...base,
          pool: false,
          execType: claimerInfo.type,
          execName: claimerInfo.name,
          execSlug: claim.claimedBy,
          execDeactivated: claimerInfo.deactivated,
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

    // T-0558 (sandbox gate): for a NON-privileged caller, drop instance tasks whose
    // originating process_definition is not published (draft/unknown). Privileged
    // actors (owner/admin OR authoring_draft grant) see sandbox-process tasks so they
    // can dry-run them. Resolved tenant-scoped + fail-closed (resolveActorPrivilege);
    // a privilege-resolution error degrades to "not privileged" → drafts stay hidden.
    let sandboxPrivileged = false;
    if (devUserId) {
      try {
        const priv = await resolveActorPrivilege(getOrgPool(), tenantId, devUserId, nowMs);
        sandboxPrivileged = priv.isOwnerOrAdmin || priv.hasAuthoringDraftGrant;
      } catch {
        sandboxPrivileged = false; // fail-closed: drafts remain hidden on resolution error.
      }
    }
    if (sandboxPrivileged) {
      instanceItems = rawInstanceItems;
    } else {
      const allProcKeys = [...procKeyByTaskId.values()];
      const draftOnly = await draftOnlyProcessKeys(getOrgPool(), tenantId, allProcKeys);
      instanceItems = rawInstanceItems.filter((item) => {
        const key = procKeyByTaskId.get(item.id);
        // Drop ONLY tasks whose process definition is positively known draft-only.
        return key === undefined || !draftOnly.has(key);
      });
    }
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
  const merged = [...dedupedDefer, ...dedupedInstance];

  // T-0648 (D-064, UX-study §3): claimer display (execName/execType/execSlug) for
  // every claimed row across seed/defer/instance is ALREADY resolved above, at
  // construction time, from the single claimerResolved batch built once per
  // request (see the resolveActorDisplay calls in each item-building block) — no
  // second pass needed here.
  return merged;
}

// ---------------------------------------------------------------------------
// Tab / filter logic (server-side; the design's intent — not client heuristics)
// ---------------------------------------------------------------------------

function isEscalated(item: InboxItem): boolean {
  return item.escalated === true || item.status === "failed";
}

/**
 * T-0710 [E16, capstone T-0691 P2]: STABLE partition — non-escalated items first,
 * escalated items last, ORIGINAL relative order preserved within each group
 * (Array.prototype.sort is stability-guaranteed since ES2019; this file targets
 * a modern Node runtime). Pure, exported for the unit tier. See the call site
 * (GET /api/inbox default ordering) for why: agent escalations otherwise
 * dominate the front of the list and bury older genuine approver-waiting tasks
 * past the default page size.
 */
export function stableSortEscalatedLast(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => Number(isEscalated(a)) - Number(isEscalated(b)));
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
// T-0653 (W5-UX/§4) — server-side inbox search / filters / grouping.
//
// UX-study §4: «parseQuery знает только tab/exec/sort/page» — нет поиска,
// фильтров по процессу/статусу/дедлайну, нет группировки. Эти фильтры
// применяются к УЖЕ материализованному InboxItem[] (findInboxItems), т.е. IN-
// MEMORY по строкам, а НЕ через SQL — поэтому НЕТ SQL-инъекции для q= (нет SQL-
// пути для инбокс-поиска вовсе; сравнение — String.includes на резолвнутых
// полях). Фильтры применяются ДО пагинации (сервер фильтрует, не клиент).
// ---------------------------------------------------------------------------

const INBOX_STATUSES = new Set(["running", "waiting", "failed", "done", "paused"]);

/**
 * T-0653 (fix-forward defect #1): hard cap on the number of rows returned in
 * GROUPED mode (?group=process). In grouped mode the server returns the ENTIRE
 * filtered set (not a page) so that each group's rendered body and its count
 * badge always agree — page-paginated bodies under server-computed group counts
 * produced a group badge of «12» over an empty tbody until every page loaded.
 * The cap bounds the worst case (a tenant with thousands of open tasks); when
 * hit, the response carries groupTruncated:true so the client can show an
 * honest «показаны первые N — уточните фильтр» notice instead of silently
 * dropping rows. 500 comfortably covers a human's real working set while
 * bounding the payload.
 */
const INBOX_GROUP_ROW_CAP = 500;

export interface InboxFilters {
  q: string | null;
  process: string | null;
  status: string | null;
  deadlineFrom: number | null;
  deadlineTo: number | null;
}

/** Parse the T-0653 inbox filter params (all optional, additive to tab/exec/sort). */
export function parseInboxFilters(query: URLSearchParams): InboxFilters {
  const rawStatus = query.get("status");
  const status = rawStatus !== null && INBOX_STATUSES.has(rawStatus) ? rawStatus : null;
  const numOrNull = (v: string | null): number | null => {
    if (v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    q: (query.get("q") ?? "").trim() || null,
    process: (query.get("process") ?? "").trim() || null,
    status,
    deadlineFrom: numOrNull(query.get("deadline_from")),
    deadlineTo: numOrNull(query.get("deadline_to")),
  };
}

/**
 * matchesInboxFilters — pure predicate: does an item pass the T-0653 filters?
 *  - q: case-insensitive substring over name / step / processName / inst / procKey
 *  - process: case-insensitive substring over procKey / processName / inst
 *  - status: exact status match
 *  - deadline_from/to: item.deadline (epoch-ms) within [from, to] (either bound optional)
 * Items WITHOUT a deadline are excluded ONLY when a deadline bound is active.
 */
export function matchesInboxFilters(item: InboxItem, f: InboxFilters): boolean {
  if (f.q) {
    const needle = f.q.toLowerCase();
    const hay = [item.name, item.step, item.processName, item.inst, item.procKey]
      .filter((s): s is string => typeof s === "string")
      .join(" · ")
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  if (f.process) {
    const needle = f.process.toLowerCase();
    const hay = [item.procKey, item.processName, item.inst]
      .filter((s): s is string => typeof s === "string")
      .join(" · ")
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  if (f.status && item.status !== f.status) return false;
  if (f.deadlineFrom !== null || f.deadlineTo !== null) {
    if (typeof item.deadline !== "number") return false;
    if (f.deadlineFrom !== null && item.deadline < f.deadlineFrom) return false;
    if (f.deadlineTo !== null && item.deadline > f.deadlineTo) return false;
  }
  return true;
}

export interface InboxGroup {
  key: string;
  label: string;
  count: number;
  procKey?: string;
  inst?: string;
}

/**
 * groupInboxByProcess — свёртки по процессу (UX-study §4: «группировка по
 * процессу со свёртками»). Ключ группы — стабильный: procKey ?? inst ?? "—".
 * Ярлык — человекочитаемый processName ?? inst ?? «Без процесса». Каунт — от
 * ПЕРЕДАННОГО (уже отфильтрованного) набора. Порядок групп — по убыванию каунта,
 * затем по ярлыку (детерминизм).
 */
export function groupInboxByProcess(items: InboxItem[]): InboxGroup[] {
  const byKey = new Map<string, InboxGroup>();
  for (const item of items) {
    const key = item.procKey ?? item.inst ?? "—";
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, {
        key,
        label: item.processName ?? item.inst ?? "Без процесса",
        count: 1,
        ...(item.procKey !== undefined ? { procKey: item.procKey } : {}),
        ...(item.inst !== undefined ? { inst: item.inst } : {}),
      });
    }
  }
  return [...byKey.values()].sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label, "ru"));
}

// ---------------------------------------------------------------------------
// T-0588 (BLOCK-1/BLOCK-4): resolveTier2SubstitutionClaim — shared Tier-2
// substitution-eligibility check, used by BOTH the claim route (FR-1) and the
// approve route (BLOCK-4 — a substitute who claimed via Tier-2 must also be
// able to complete the userTask, or the substitution is claim-only and dead
// weight for LIVE_PROOF). Extracted so the two gates cannot silently drift.
//
// Returns the absent employee's slug when a Tier-2 substitution_rule licenses
// `actorSlug` to act as `taskRole` on this task's behalf; undefined otherwise
// (including on any DB error — degrades to "no match", never throws: the
// caller's base role-check has already run and rejected before this is
// consulted, so failure here must fall through to the caller's own 403, not
// mask it with a 500).
//
// Containment (BLOCK-1, review R-1 fix): a pool task carries no org-scope of
// its own (task.role is the only addressing field). The ONLY real,
// task-relevant scope available is the ABSENT holder's OWN
// role_assignment.org_scope for this role — the rule is honest only when its
// org_scope does not exceed that real assignment's reach
// (isNarrowerOrEqual(rule.orgScope, absentAssignmentScope)). No active
// assignment to check against ⇒ fail closed (no match) — see
// getRoleAssignmentOrgScopesForEmployee doc comment (grants-dao.ts) for the
// full rationale (no TOP/tenant-wide sentinel exists in this lattice either).
// ---------------------------------------------------------------------------

async function resolveTier2SubstitutionClaim(
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
  taskRole: string,
  nowMs: number,
): Promise<string | undefined> {
  try {
    const substRules = await getActiveSubstitutionsForSubstitute(pool, tenantId, actorSlug, nowMs);
    const candidates = substRules.filter(
      (r) =>
        r.roleId === taskRole &&
        // T-0744: Tier-2 only. This is NOT because "a Tier-1 substitute already
        // holds the role" (the false premise, T-0729 §2.7 / T-0588 §1.3 — a Tier-1
        // stand-in may NOT hold it): a Tier-1 substitute who DOES hold the role
        // claims via their own role_assignment (myRoles) and never reaches here; a
        // Tier-1 non-holder gives NO coverage (substituteProvidesCoverage=false) →
        // the role is orphaned → routing falls it to the owner (owner-orphan claim
        // branch), not this substitution path. So this filter matching only Tier-2
        // is exactly right, and no longer rests on the false premise.
        r.ttlGrantId !== null &&
        isRuleEffective(r, nowMs),
    );
    if (candidates.length === 0) return undefined;

    const oracle = await loadTenantOrgAncestry(pool, tenantId);
    for (const candidate of candidates) {
      const absentScopes = await getRoleAssignmentOrgScopesForEmployee(
        pool,
        tenantId,
        candidate.absentEmployeeId,
        taskRole,
        nowMs,
      );
      const covered = absentScopes.some((absentScope) =>
        isNarrowerOrEqual(candidate.orgScope as ScopeElement, absentScope, oracle),
      );
      if (covered) return candidate.absentEmployeeId;
    }
    return undefined;
  } catch {
    // Degrade gracefully: a lookup failure does NOT grant a claim/approve that
    // the base role-check already rejected — falls through to the caller's 403.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// T-0744 (в2) — owner-claim of an orphaned role.
//
// isRoleEffectivePoolEmpty: does the role currently have ZERO claim-eligible
// executors? Reuses the SAME coverage invariant the routing path uses
// (computeEffectivePool over confirmed holders + active substitution rules), so
// "empty here" ⟺ "routed_to_fallback:'role_unfilled' there" — the router and the
// claim-gate cannot drift. Confirmed holders come from getHoldersForRole (already
// deactivation-filtered, T-0588); Tier-1 non-holder substitutes do NOT count as
// coverage, so a role covered only by such a stand-in reads as empty (§2.6/§3-в2).
// ---------------------------------------------------------------------------

async function isRoleEffectivePoolEmpty(
  pool: pg.Pool,
  tenantId: string,
  roleSlug: string,
  nowMs: number,
): Promise<boolean> {
  const holders = await getHoldersForRole(pool, tenantId, roleSlug, nowMs);
  if (holders.length === 0) return true;
  const substRules = await getActiveSubstitutionsByRole(pool, tenantId, roleSlug, nowMs);
  return computeEffectivePool(holders, substRules, roleSlug).length === 0;
}

// isOwnerOrphanClaimEligible: may `actorSlug` claim/approve THIS role's task as
// the tenant owner? True iff the actor is the genesis tenant-owner
// (isGenesisOwnerForTenant — deactivation-safe: a deactivated owner is false, so
// the task stays unresolvable per T-0588 AC-7) AND the role's effective pool is
// empty (the task is genuinely orphaned). The empty-pool gate is critical: the
// owner may take ONLY an orphaned task, never pool work with live holders — that
// would bypass pool discipline. Fail-CLOSED: any DB error → false, so the caller
// falls through to its honest 403 (never a wrong-allow, never a 500 masking it).
// The owner acts as THEMSELVES (they hold top authority + are the F6/PD-10
// last-resort executor) — the caller records NO on_behalf_of for an owner claim.
async function isOwnerOrphanClaimEligible(
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
  roleSlug: string,
  nowMs: number,
): Promise<boolean> {
  try {
    if (!(await isGenesisOwnerForTenant(pool, tenantId, actorSlug, nowMs))) return false;
    return await isRoleEffectivePoolEmpty(pool, tenantId, roleSlug, nowMs);
  } catch {
    return false;
  }
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

    // T-0710 [E16, capstone T-0691 P2]: parse the query EARLY (was parsed only
    // after findInboxItems ran, so `?instance=<id>` — meant to scope the list to
    // one process instance's tasks — was silently ignored: it never reached
    // findInboxItems at all, and applying it AFTER the fact as a post-filter over
    // an already tab/paginated response would have narrowed the wrong (partial)
    // set. Parsed once here and reused unchanged below (tab/exec/sort/filters).
    const query = parseQuery(req.url);
    const instanceParam = query.get("instance");

    // T-0458 [D8-R3]: timer-firing projection (reconcile-on-read). A boundary/
    // intermediate TIMER that fired in Flowable routes the token to the escalation
    // user-task WITHOUT a human action, so the firing cannot be projected on the
    // approve path. Here — the moment the inbox is read — we reconcile each waiting
    // instance's live engine task set and surface any newly-active (timer-fired)
    // escalation task as a process.next_task(escalated) row, so it appears in THIS
    // response. Best-effort + idempotent (dedup by defKey); engine/DB hiccups degrade
    // silently. Only runs when a FlowableClient + DB are available (honest-degrade).
    if (writeDeps?.flowableClient && hasDb()) {
      try {
        const reconTenantId = await resolveTenant(actor);
        await reconcileInstanceTimers(
          getOrgPool(),
          reconTenantId,
          writeDeps.flowableClient,
          { actor: actor ?? "system:timer" },
        );
      } catch (err) {
        console.warn("[inbox T-0458] timer reconcile-on-read failed (non-fatal):", err);
      }
    }

    // T-0522 [Option A]: engine-drive reconcile-on-read net. The post-approve engine
    // drive is fire-and-forget — if it lost the timing race or hit a transient engine
    // error, a DMN-gateway-spawned 2nd task («Доп.согласование» on the 6M branch) could
    // silently never appear (ADR-T0432 §3.1, the prime CS-1 flakiness suspect). Here —
    // the moment the inbox is read — we re-drive every WAITING instance against the live
    // engine token set and surface any gateway task the async missed, so it self-heals.
    // PURE MIRROR (completeEngineTask=false → never completes a task; that is the human's
    // action). Idempotent (dedup by defKey); engine/DB hiccups degrade silently (the NEXT
    // read retries; the inbox 200 is never blocked). Same honest-degrade gate as T-0458.
    if (writeDeps?.flowableClient && hasDb()) {
      try {
        const driveTenantId = await resolveTenant(actor);
        await reconcileInboxEngineDriveOnRead(
          getOrgPool(),
          driveTenantId,
          writeDeps.flowableClient,
          { actor: actor ?? "system:engine-drive" },
        );
      } catch (err) {
        console.warn("[inbox T-0522] engine-drive reconcile-on-read failed (non-fatal):", err);
      }
    }

    // T-0459 [D8-R4]: message-catch WAITING projection (reconcile-on-read). An
    // instance PARKED on a message-catch (receiveTask / intermediateCatchEvent /
    // message boundary) is WAITING for a correlated message — it has no userTask, so
    // it never surfaces on the approve/timer paths. Here — the moment the inbox is
    // read — we ask the engine which waiting instances carry a parked message/signal
    // event-subscription (getMessageCatchWaits) and surface each as a
    // «Ожидает сообщения» waiting row carrying the awaited messageName, so it appears
    // in THIS response. MIRRORS reconcileInstanceTimers: same honest-degrade pattern
    // (only when FlowableClient + DB present; engine/DB hiccups log non-fatal, never
    // fail the 200); idempotent (dedup by inst+messageName in surfaceMessageCatchWaits).
    if (writeDeps?.flowableClient && hasDb()) {
      try {
        const waitTenantId = await resolveTenant(actor);
        const subscriptionSource = makeEngineMessageSubscriptionSource(
          getOrgPool(),
          writeDeps.flowableClient,
        );
        await surfaceMessageCatchWaits(
          getOrgPool(),
          waitTenantId,
          subscriptionSource,
          { actor: actor ?? "system:message" },
        );
      } catch (err) {
        console.warn("[inbox T-0459] message-wait reconcile-on-read failed (non-fatal):", err);
      }
    }

    // T-0710: thread the ?instance= scope through — honestly narrows at the
    // SOURCE (SQL WHERE for the DB-backed reads, in-memory for the seed fixture),
    // not a post-fetch filter over an already tab/paginated response.
    const base = await findInboxItems(actor, Date.now(), undefined, instanceParam);
    // T-0331 (S0a): resolve role slugs from live DB (falls back to in-memory fixture
    // when !hasDb()); DB errors propagate as 500 (fail-closed, NF-3). tenantId from
    // resolveTenant mirrors the same source used by findInboxItems so role-check and
    // task-list are always co-scoped to the same tenant.
    const inboxTenantId = await resolveTenant(actor);
    const myRoles = await resolveRolesForActor(actor, inboxTenantId);

    const tab = parseTab(query.get("tab"));
    const execFilter = parseExec(query.get("exec"));
    const sort = query.get("sort");

    // T-0653 (fix-forward defect #3): the per-tab badge counts must respect the
    // ACTIVE q/filters/exec so a badge of «42» never sits over 3 visible rows.
    // We first narrow the base by the cross-tab filters (exec + q/process/status/
    // deadline), THEN compute each tab's count over THAT narrowed set. This makes
    // the active tab's badge equal its visible total, and each other tab's badge
    // an honest "how many match the current search would land in that tab".
    // (Tenant scoping + role-addressing still fully apply — inTab is unchanged.)
    const inboxFilters = parseInboxFilters(query);
    let filteredBase = base;
    if (execFilter) {
      filteredBase = filteredBase.filter((i) => i.execType === execFilter);
    }
    filteredBase = filteredBase.filter((i) => matchesInboxFilters(i, inboxFilters));

    // Per-tab counts over the filtered base (badge ↔ visible list agree).
    const counts: Record<TabId, number> = {
      all: filteredBase.filter((i) => inTab(i, "all", actor, myRoles)).length,
      mine: filteredBase.filter((i) => inTab(i, "mine", actor, myRoles)).length,
      pool: filteredBase.filter((i) => inTab(i, "pool", actor, myRoles)).length,
      esc: filteredBase.filter((i) => inTab(i, "esc", actor, myRoles)).length,
    };

    // The active tab's rows = filtered base narrowed to the selected tab.
    let filtered = filteredBase.filter((i) => inTab(i, tab, actor, myRoles));

    if (sort === "sla") {
      // Ascending SLA headroom — most-urgent (incl. overdue, negative `left`) first.
      filtered = [...filtered].sort((a, b) => a.sla.left - b.sla.left);
    } else {
      // T-0710 [E16, capstone T-0691 P2]: default-order visibility fix. Live-found:
      // the inbox is dominated by agent escalations (every defer row IS an
      // escalation by construction — T-0638 F7 — and the merge lists ALL defer
      // rows before ANY instance row), so an older genuine approver-waiting task
      // (a plain, non-escalated instance row) can sit past the default page size
      // and be invisible unless the operator pages through. A STABLE partition —
      // non-escalated rows first, escalated rows last, original relative order
      // preserved within each group — surfaces the human-waiting-for-approval
      // queue ahead of the escalation queue by default, without inventing a new
      // tab/IA (the esc tab's own contents are ALL escalated already, so this is a
      // no-op there) and without touching the explicit `sort=sla` urgency order
      // above (an operator who asked for urgency-first keeps getting it,
      // escalations included — they are usually the most urgent by construction).
      filtered = stableSortEscalatedLast(filtered);
    }

    // T-0653: group-by-process summaries (with counts) over the FILTERED set.
    // Only when explicitly requested (?group=process); absent ⇒ response shape
    // unchanged (backward compatible).
    const groupMode = query.get("group");

    if (groupMode === "process") {
      // T-0653 (fix-forward defect #1, вариант «б»): GROUPED mode returns the
      // ENTIRE filtered set (capped), NOT a page. The group counts and the group
      // bodies are then computed from the SAME rows, so a group badge never sits
      // over a partially-loaded/empty tbody (the flaw: server counted groups over
      // the full filtered set but the client rendered bodies from paginated rows).
      // This also removes «Показать ещё» in grouped mode client-side (defect #2):
      // there is no next page to append — the whole set is already here.
      const total = filtered.length;
      const capped = filtered.slice(0, INBOX_GROUP_ROW_CAP);
      const groups = groupInboxByProcess(capped);
      const groupTruncated = total > capped.length;

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        items: capped,
        counts,
        tab,
        // Grouped mode is single-page by construction — report it honestly so the
        // client's load-more (page < totalPages) never shows in grouped mode.
        page: 1,
        totalPages: 1,
        total,
        limit: capped.length,
        groups,
        // Honest signal: the filtered set exceeded the grouped-mode row cap, so
        // some rows (and possibly whole groups) are not shown — refine the filter.
        ...(groupTruncated ? { groupTruncated: true, groupRowCap: INBOX_GROUP_ROW_CAP } : {}),
      }));
      return;
    }

    // T-0401 [D7-3]: FLAT mode paginates the filtered result set (unchanged).
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
            // T-0683: human process name + record id for the detail drawer's ProcessRef.
            processName: instanceTaskForDetail.processName,
            ...(instanceTaskForDetail.recordId !== undefined
              ? { recordId: instanceTaskForDetail.recordId }
              : {}),
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
        // T-0718 [E16/P1, из re-proof T-0709]: overlay the LIVE engine step onto the
        // (non-done) projection so projection.step/role/concurrentSteps reflect the
        // node the token is REALLY on — not the frozen process.started snapshot that
        // showed a phantom step (e.g. 'Согласование') beside the item's live step. Reuses
        // the SAME core resolveLiveNodesByInstance + overlayLiveSteps the catalog and
        // /api/processes detail planes use (single source of truth) — all three read
        // surfaces now agree. Honest degrade to the snapshot when the engine is
        // unreachable / has no active user-task / the client lacks the read method.
        if (projection) {
          projection = await overlayInboxDetailLiveStep(writeDeps.flowableClient, projection);
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

    // T-0588 (BLOCK-3, review follow-up): a deactivated actor must not be able
    // to claim ANY pool task — not even one addressed to a role they still hold
    // a role_assignment for. Deactivation disables the ACCOUNT (T-0583/migration
    // 125) independently of role_assignment.valid_until (see ADR §"Дыра №2" —
    // "деактивированный = не держатель"); the role/substitution eligibility gate
    // below only checks role/substitution membership, so without this check a
    // fired employee whose role_assignment was not separately revoked could
    // still claim new work up to that point. Fail-closed: unlike the actorKind
    // telemetry lookup further below, a DB error here is NOT swallowed — this
    // IS the security gate.
    if (hasDb()) {
      const actingEmp = await findEmployeeById(getOrgPool(), tenantId, devUserId);
      if (actingEmp?.deactivatedAt != null) {
        throw new HttpError(403, "NOT_ELIGIBLE", "actor account is deactivated and cannot claim tasks");
      }
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
    //
    // T-0588 (FR-1): when the direct role-slug check misses, ADDITIONALLY consult
    // Tier-2 substitution_rule — a substitute holds a TTL'd grant (NOT a
    // role_assignment), so myRoles.includes(taskRole) is false for them even with a
    // live, confirmed, in-window rule. This branch is local to the claim endpoint
    // (does NOT widen getRoleSlugsForActor / myRoles — see ADR rejected-alternatives):
    // it only ever ALLOWS this one claim, and only records who was substituted for.
    let onBehalfOfSlug: string | undefined;
    // T-0744 (в2): owner-claim of an orphaned role. When the Tier-2 substitution
    // branch also misses, the tenant OWNER may claim a task whose role is
    // genuinely orphaned (effective pool empty) — the F6/PD-10 last-resort path,
    // now actually reachable (§2.6 fixed: the display-only routed_to_fallback no
    // longer leaves the owner stuck at 403). The owner acts as themselves — no
    // on_behalf_of. Gated on empty pool so the owner cannot grab pool work with
    // live holders.
    let ownerOrphanClaim = false;
    if (taskRole !== undefined && !myRoles.includes(taskRole)) {
      if (hasDb()) {
        const orgPool = getOrgPool();
        onBehalfOfSlug = await resolveTier2SubstitutionClaim(orgPool, tenantId, devUserId, taskRole, nowMs);
        if (onBehalfOfSlug === undefined) {
          ownerOrphanClaim = await isOwnerOrphanClaimEligible(orgPool, tenantId, devUserId, taskRole, nowMs);
        }
      }
      if (onBehalfOfSlug === undefined && !ownerOrphanClaim) {
        throw new HttpError(403, "NOT_ELIGIBLE", "actor does not hold the role this task is addressed to");
      }
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
          // T-0588: onBehalfOfSlug is set ONLY when this claim was authorized via
          // the Tier-2 substitution branch above; undefined for a normal
          // role-assignment claim (payload key omitted, byte-identical to today).
          await appendTaskClaimed(txClient, {
            taskId,
            actor: devUserId,
            actorKind,
            tenantId,
            role: taskRole ?? "",
            nowMs,
            onBehalfOf: onBehalfOfSlug,
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
    const { pool, resolveActorTenant: resolveActorTenantDep, outboxStore, flowableClient: writeDepsFlowable } = writeDeps;

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
        // T-0688 (stale-drawer, capstone T-0647 minor finding): findWaitingInstanceTask
        // returns null both for a genuinely unknown taskId AND for a task that
        // WAS this exact instance's waiting step a moment ago but has SINCE
        // completed — most commonly via the T-0522 engine-drive reconcile-on-read
        // net (GET /api/inbox self-heals a missed post-approve engine drive on
        // every list read) or a concurrent duplicate click/tab. In that second
        // case the step DID complete successfully — the human just did not cause
        // THIS click to be the one that completed it. Before falling through to
        // the defer-row branch (and its own honest 404), check the projection
        // track for a `done` row correlated to THIS taskId (inboxTaskId) — the
        // SAME check GET /api/inbox/:id already performs (line ~1573 above) to
        // keep serving detail for a just-completed task. A match here means
        // "already done" — return the ordinary 200 success shape (idempotent),
        // not the scary "задача уже недоступна" error a genuine 404 implies.
        // No new query: listInstanceProjections is the same read GET already uses.
        const doneProjections = await listInstanceProjections(pool, tenantId);
        const doneProj = doneProjections.find((p) => p.inboxTaskId === taskId && p.status === "done");
        if (doneProj) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              instanceId: doneProj.inst,
              status: "done",
              action: "approve",
              outcome: outcomeName,
              engine: "already",
            }),
          );
          return;
        }

        // T-0638 (defect #1): taskId may address a DEFER task (agent.deferred
        // audit event) rather than an ordinary instance userTask. A defer row
        // is NEVER in listInstanceInboxTasks (it is a different audit type,
        // agent.deferred vs process.started/process.next_task) — the OLD
        // unconditional 404 here left a claimed defer task permanently stuck:
        // ACCEPTED DECISION 1 (dispatch-outcome.ts) already closed the
        // agent's OWN external task at defer time and advanced the engine
        // token downstream, but nothing surfaced/completed that downstream
        // step from a defer-card click — see docs/design/ADR-T0638-defer-task-complete.md.
        const deferRows = await listDeferredInboxTasks(pool, tenantId);
        const deferRow = deferRows.find((r) => r.id === taskId);

        if (!deferRow) {
          throw new HttpError(404, "NOT_FOUND", "задача не найдена — обновите страницу");
        }
        if (!deferRow.instanceId) {
          // Legacy defer event (no payload.instance_id — e.g. run-precheck.ts's
          // demo-run path, or a row written before T-0638): there is no live
          // engine instance to drive. Honest 404 — never a silent no-op 200,
          // never an attempt to call the engine with an id we know is absent.
          throw new HttpError(
            404,
            "DEFER_NOT_ROUTABLE",
            "эта отложенная задача не привязана к процессу — продвинуть её нельзя",
          );
        }

        // Authz: same approve-grant discipline as the ordinary instance path
        // (deny-by-default) — the actor must hold the role the defer task is
        // addressed to, or a Tier-2 substitution licenses them to act for it.
        const deferNowMs = Date.now();
        const deferMyRoles = await resolveRolesForActor(actor, tenantId, deferNowMs);
        if (!deferMyRoles.includes(deferRow.role)) {
          const onBehalf = await resolveTier2SubstitutionClaim(
            pool,
            tenantId,
            actor,
            deferRow.role,
            deferNowMs,
          );
          if (onBehalf === undefined) {
            throw new HttpError(
              403,
              "NOT_ELIGIBLE",
              "actor does not hold the approve grant for this task",
            );
          }
        }

        if (hasDb()) {
          const actingEmp = await findEmployeeById(pool, tenantId, actor);
          if (actingEmp?.deactivatedAt != null) {
            throw new HttpError(403, "NOT_ELIGIBLE", "actor account is deactivated and cannot approve tasks");
          }
        }

        // Record the human's resolution of the escalation as ONE audit event
        // (open-vocabulary type, mirrors agent.deferred/agent.proceeded/
        // agent.blocked — NO new table, D-064/defer-no-new-table.sh NF-2).
        await withTenantTx(pool, tenantId, async (client) => {
          await deferResolveAuditWriter.appendAuditEvent(
            client as unknown as import("../db/audit-writer.js").PgClientLike,
            {
              id: randomUUID(),
              type: "agent.defer_resolved",
              actor,
              subject: `agent:${deferRow.execName}`,
              scope: { skill: deferRow.step, instance_id: deferRow.instanceId },
              via: "inbox-action",
              proposed_by: null,
              confirmed_by: null,
              payload: {
                inbox_task_id: taskId,
                resolved_by: actor,
                instance_id: deferRow.instanceId,
                proc_key: deferRow.procKey,
                outcome: outcomeName,
              },
              occurred_at: deferNowMs,
            },
          );
        });

        // Drive the engine: the agent's OWN external task is ALREADY closed
        // (ACCEPTED DECISION 1) — what remains is whatever userTask the token
        // reached downstream. Resolve-by-instance (approvedTaskDefKey omitted)
        // is the SAME mechanism the base process.started approve path already
        // uses (T-0571 §2.1) — no new engine API, no re-attempt to complete an
        // already-closed external task.
        if (!writeDepsFlowable) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              instanceId: deferRow.instanceId,
              status: "done",
              action: "approve",
              outcome: outcomeName,
              engine: "not_configured",
            }),
          );
          return;
        }

        const driveResult = await reconcileInstanceEngineDrive(
          pool,
          tenantId,
          writeDepsFlowable,
          {
            instanceId: deferRow.instanceId,
            procKey: deferRow.procKey ?? "process:unknown",
            completeEngineTask: true,
            actor,
            driveDeadlineMs: resolveEngineDriveDeadlineMs(),
          },
        );

        if (!driveResult.ok) {
          const isStructural =
            driveResult.code === ENGINE_TASK_NOT_FOUND ||
            driveResult.code === AMBIGUOUS_ACTIVE_TASK ||
            driveResult.code === ENGINE_DRIVE_TIMEOUT;
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: {
                code: isStructural ? driveResult.code : "ENGINE_DRIVE_FAILED",
                stage: driveResult.stage,
                engineCode: driveResult.code,
                instanceId: deferRow.instanceId,
              },
            }),
          );
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            instanceId: deferRow.instanceId,
            status: "done",
            action: "approve",
            outcome: outcomeName,
            engine: driveResult.alreadyEnded ? "already" : "completed",
          }),
        );
        return;
      }

      // T-0588 (RE-VERIFY, symmetry with BLOCK-3): a deactivated actor must not
      // be able to APPROVE any task either — not even one addressed to a role
      // they still hold a live role_assignment for. Deactivation disables the
      // ACCOUNT (T-0583/migration 125) independently of role_assignment.valid_until
      // (ADR §"Дыра №2" — "деактивированный = не держатель"); getRoleSlugsForActor
      // does not filter on employee.deactivated_at, so without this check a fired
      // employee whose role_assignment was not separately revoked could still
      // approve tasks up to that point (same privilege-escalation class as the
      // claim-path gap fixed in BLOCK-3, ~line 1413). Mirrors that gate exactly:
      // fail-closed on DB error (this IS the security gate, not telemetry), and
      // runs BEFORE the myRoles/Tier-2-substitution PDP check below.
      // Uses writeDeps.pool (NOT getOrgPool()) — same reasoning as the actor-tenant
      // resolution above: this route is wired to an injected pool, and every other
      // DB call in this handler consistently uses that same connection.
      if (hasDb()) {
        const actingEmp = await findEmployeeById(pool, tenantId, actor);
        if (actingEmp?.deactivatedAt != null) {
          throw new HttpError(403, "NOT_ELIGIBLE", "actor account is deactivated and cannot approve tasks");
        }
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
      // T-0588 (BLOCK-4, review follow-up): a Tier-2 substitute who claimed this
      // task (claim route, FR-1) must also be able to APPROVE it — otherwise the
      // substitution is claim-only and the substitute is stuck holding a task
      // they can never complete (LIVE_PROOF §"(б) Заместитель забирает задачу"
      // requires claim→approve→done end-to-end). Same Tier-2 gate as the claim
      // route (resolveTier2SubstitutionClaim — same guards: confirmed, in-window,
      // deactivated-substitute filter via SUBST_SELECT, org-scope containment
      // against the absent holder's real role_assignment).
      let approveOnBehalfOfSlug: string | undefined;
      // T-0744 (в2): mirror the claim route's owner-orphan branch on approve so
      // an owner who claimed an orphaned task can also complete it (claim→approve
      // →done, or the owner-claim is dead weight). Same empty-pool gate; owner
      // acts as themselves (no on_behalf_of).
      let approveOwnerOrphanClaim = false;
      if (!myRoles.includes(task.role)) {
        approveOnBehalfOfSlug = await resolveTier2SubstitutionClaim(pool, tenantId, actor, task.role, nowMs);
        if (approveOnBehalfOfSlug === undefined) {
          approveOwnerOrphanClaim = await isOwnerOrphanClaimEligible(pool, tenantId, actor, task.role, nowMs);
        }
        if (approveOnBehalfOfSlug === undefined && !approveOwnerOrphanClaim) {
          throw new HttpError(
            403,
            "NOT_ELIGIBLE",
            "actor does not hold the approve grant for this task",
          );
        }
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
          // T-0588 (BLOCK-4): set ONLY when this approve was authorized via the
          // Tier-2 substitution branch above; undefined for a normal role-assignment
          // approve (payload key omitted, byte-identical to today).
          onBehalfOf: approveOnBehalfOfSlug,
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

      // T-0443 / T-0522 / T-0571: engine-drive post-approve.
      //
      // T-0571 (ADR-T0571-engine-drive-seam §2.3, BUG-014): completion of the base
      // engine user-task is now SYNCHRONOUS to the HTTP response — the fire-and-forget
      // `void (async…)()` IIFE is GONE for the completion step. The response is 200
      // ONLY when the engine step is genuinely completed (or a legitimate idempotent
      // repeat / engine-not-configured); otherwise it is a typed 502. This ends the
      // "always 200 regardless of engine state" contract — that silent-200 WAS BUG-014
      // (AC-7's "main evil": a false success the user could not distinguish from a real
      // one). Fan-out of the NEXT task (post-completion "surface every live user-task")
      // remains eventually-consistent — self-healed by reconcile-on-read (GET
      // /api/inbox) — completion and fan-out are deliberately decoupled (ADR §2.3).
      //
      // T-0443 Fix A / T-0571: `task.taskDefKey` is the projection's signal — a REAL
      // engine defKey for process.next_task rows (e.g. "task-extra-approve" on the 6M
      // gateway branch), or `null` for a base process.started row (T-0571
      // resolve-by-instance: the base step's target engine task is resolved as "the
      // active user-task of THIS instanceId", not by matching a ТЭЛ-specific literal —
      // see reconcileInstanceEngineDrive §2.1).
      //
      // Honest-degrade (NF-3): if writeDepsFlowable is absent, the engine is not
      // configured at all — this is a DELIBERATE product configuration (demo/offline),
      // not a failure, and stays 200 with an explicit `engine:"not_configured"` field so
      // it is observably different from a real completion or a real failure.
      let engineField: "completed" | "already" | "not_configured" = "not_configured";
      if (writeDepsFlowable) {
        const engineDriveInstanceId = task.inst;
        const engineDriveProcKey = task.procKey;
        const approvedTaskDefKey: string | null = task.taskDefKey;

        const result = await reconcileInstanceEngineDrive(
          pool,
          tenantId,
          writeDepsFlowable,
          {
            instanceId: engineDriveInstanceId,
            procKey: engineDriveProcKey,
            approvedTaskDefKey,
            completeEngineTask: true, // post-approve: complete the human's task.
            actor,
            // T-0591 (F-2): bound the WHOLE drive path, not just poll-between-
            // iterations — a single degraded engine call can no longer stretch
            // this HTTP response past ENGINE_DRIVE_DEADLINE_MS.
            driveDeadlineMs: resolveEngineDriveDeadlineMs(),
          },
        );

        if (!result.ok) {
          // T-0571 (NF-1/AC-7): the engine step did NOT complete — this is now a
          // VISIBLE, typed error, never a silent 200. The human's decision (task.approved
          // + applyStepResult, above) is already committed and is NOT rolled back (ADR
          // §2.3: "recorded, but the engine step did not complete — retry/escalate").
          // The reconcile-on-read net (GET /api/inbox) will keep retrying the engine
          // side on every subsequent read, so a transient failure self-heals; a
          // structural one (ENGINE_TASK_NOT_FOUND / AMBIGUOUS_ACTIVE_TASK) surfaces here
          // so a human/ops can act instead of trusting a false "done".
          console.warn(
            `[inbox T-0571 engine-drive] reconcile failed at stage=${result.stage} ` +
              `code=${result.code} (instance ${engineDriveInstanceId}) — ` +
              `approve recorded, engine step NOT completed; reconcile-on-read will retry`,
          );
          // T-0571 (ADR §2.3 response contract, amended after REVIEW F-1 —
          // orchestrator-sanctioned): the `code` field distinguishes WHICH of the
          // 502 shapes this is. The STRUCTURAL codes (ENGINE_TASK_NOT_FOUND /
          // AMBIGUOUS_ACTIVE_TASK) are surfaced verbatim as `error.code` — they ARE
          // the diagnosis, not a wrapped transport error. T-0591 (F-2) adds
          // ENGINE_DRIVE_TIMEOUT as a THIRD structural code: it is not an
          // engine-reported failure either — it is the product choosing to stop
          // waiting once the shared drive-deadline elapsed (ADR-T0591 §2.2: the
          // underlying engine call may still have succeeded moments later; the
          // frontend message for this code says so explicitly, ENGINE_DRIVE_ERROR_
          // MESSAGE in screen-inbox.jsx). Any OTHER engine result.code
          // (transport/HTTP failure — e.g. ENGINE_UNAVAILABLE, a non-NOT_FOUND
          // completeUserTask error) is wrapped as the generic ENGINE_DRIVE_FAILED,
          // with the underlying engine code nested in `engineCode` (diagnostic, not
          // the dispatch key).
          //
          // Body shape: {error:{code, stage, engineCode, instanceId}} — the
          // codebase-wide error envelope (see router.ts sendErrorEnvelope, and its
          // inline mirrors in files.ts/grant-propose.ts/message-ingest.ts/
          // process-defs.ts). The original draft used a flat top-level object; REVIEW
          // F-1 found this diverged from the convention AND from the real consumer
          // (web/src/screens/screen-inbox.jsx reads body?.error?.code in both
          // handleComplete and approveTask) — fixed here, ADR §2.3 amended to match.
          const isStructural =
            result.code === ENGINE_TASK_NOT_FOUND ||
            result.code === AMBIGUOUS_ACTIVE_TASK ||
            result.code === ENGINE_DRIVE_TIMEOUT;
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: {
                code: isStructural ? result.code : "ENGINE_DRIVE_FAILED",
                stage: result.stage,
                engineCode: result.code,
                instanceId: engineDriveInstanceId,
              },
            }),
          );
          return;
        }

        engineField = result.alreadyEnded ? "already" : "completed";
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      // T-0353 [E16]: include outcomeName in response so the caller can show the
      // chosen branch label in the UI (e.g. "Согласовано", "Отклонено").
      // T-0571: `engine` field makes the engine-drive outcome observable (NF-2/NF-3) —
      // "completed" (real engine completion this call), "already" (legitimate idempotent
      // repeat — the step/instance was already done), or "not_configured" (engine client
      // absent — audit-only mode, a deliberate product configuration, not a failure).
      res.end(
        JSON.stringify({
          instanceId: task.inst,
          status: "done",
          action: "approve",
          outcome: outcomeName,
          engine: engineField,
        }),
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
