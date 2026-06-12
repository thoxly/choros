/**
 * src/http/inbox.ts
 *
 * Read-API for inbox task list (GET /api/inbox).
 * Write-API: POST /api/inbox/:id/claim — claim a pool task (assign to caller).
 * In-memory seed data with task inbox items matching screen-inbox.jsx shape.
 * Zero external dependencies — only node:http types and router.ts.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InboxItem = {
  id: string;
  status: "running" | "waiting" | "failed" | "done" | "paused";
  name: string;
  step: string;
  inst: string;
  execType?: "agent" | "human" | "service";
  execName?: string;
  pool?: boolean;
  sla: { min: number; left: number };
  due: string;
  mine?: boolean;
};

// ---------------------------------------------------------------------------
// In-memory seed fixture
// ---------------------------------------------------------------------------

const INBOX_SEED: InboxItem[] = [
  { id: "t1", status: "running", name: "Проверить реквизиты счёта №4471", step: "Согласование счёта · узел Проверка", inst: "INS-7731", execType: "agent", execName: "Счёт-агент", sla: { min: 120, left: 88 }, due: "07.06 16:40" },
  { id: "t2", status: "waiting", name: "Подтвердить возврат средств клиенту", step: "Возврат · узел Утверждение", inst: "INS-7702", execType: "human", execName: "А. Кравцова", sla: { min: 240, left: 42 }, due: "07.06 15:12" },
  { id: "t3", status: "waiting", name: "Сверить платёж с договором ДГ-2231", step: "Закрытие месяца · узел Сверка", inst: "INS-7698", pool: true, sla: { min: 180, left: 175 }, due: "07.06 19:55" },
  { id: "t4", status: "running", name: "Распознать вложение invoice_4480.pdf", step: "Согласование счёта · узел OCR", inst: "INS-7731", execType: "service", execName: "ocr-gateway", sla: { min: 5, left: 2 }, due: "07.06 14:33" },
  { id: "t5", status: "waiting", name: "Классифицировать обращение #88214", step: "Поддержка · узел Триаж", inst: "INS-7740", execType: "agent", execName: "Триаж-агент", sla: { min: 30, left: 7 }, due: "07.06 14:38" },
  { id: "t6", status: "failed", name: "Эскалация: спор по возврату #88190", step: "Поддержка · узел L2", inst: "INS-7733", pool: true, sla: { min: 60, left: -14 }, due: "07.06 14:05" },
  { id: "t7", status: "waiting", name: "Утвердить платёж поставщику > ₽50 000", step: "Согласование счёта · эскалация", inst: "INS-7731", execType: "human", execName: "Е. Ларина", sla: { min: 480, left: 360 }, due: "07.06 22:30" },
  { id: "t8", status: "running", name: "Синхронизировать проводки за 06.06", step: "Закрытие месяца · узел Синк", inst: "INS-7690", execType: "service", execName: "ledger-sync", sla: { min: 15, left: 11 }, due: "07.06 14:48" },
  { id: "t9", status: "waiting", name: "Проверить контрагента (KYC) ООО «Вектор»", step: "Онбординг · узел Комплаенс", inst: "INS-7755", pool: true, sla: { min: 720, left: 540 }, due: "08.06 01:10" },
  { id: "t10", status: "waiting", name: "Ответить на запрос статуса возврата", step: "Поддержка · узел Ответ", inst: "INS-7733", execType: "agent", execName: "Триаж-агент", sla: { min: 30, left: 24 }, due: "07.06 14:55" },
  { id: "t11", status: "waiting", name: "Согласовать акт сверки за май", step: "Закрытие месяца · узел Утверждение", inst: "INS-7698", pool: true, sla: { min: 1440, left: 980 }, due: "08.06 09:00" },
  { id: "t12", status: "running", name: "Инициировать платёж по счёту №4468", step: "Согласование счёта · узел Платёж", inst: "INS-7729", execType: "agent", execName: "Счёт-агент", sla: { min: 60, left: 31 }, due: "07.06 15:08" },
];

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
// Data accessors
// ---------------------------------------------------------------------------

async function findInboxItems(devUserId?: string): Promise<InboxItem[]> {
  // Resolve dev-user to person if provided (findEmployee is async: DB-backed or in-memory)
  let person = null;
  if (devUserId && typeof devUserId === "string") {
    person = await findEmployee(devUserId);
  }

  // Add mine flag to each item: true if item is assigned to this person.
  // T-0138: also apply in-memory claim state — claimed items lose pool flag
  // and gain execType/execName of the claimer.
  return INBOX_SEED.map((item) => {
    const claim = CLAIMED.get(item.id);

    if (claim) {
      // Claimed item: pool cleared, assigned to claimer.
      const mine =
        devUserId !== undefined && devUserId !== null && devUserId === claim.claimedBy;
      return {
        ...item,
        pool: false,
        execType: "human" as const,
        execName: claim.claimedBy, // day-1: userId as display name; real impl resolves to person.name
        mine,
      };
    }

    const mine =
      person !== null &&
      item.execType === "human" &&
      item.execName === person.name;

    return {
      ...item,
      mine,
    };
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerInboxRoutes(router: Router, _store?: JobStore): void {
  // GET /api/inbox — return full inbox task list with mine flag per item
  router.register("GET", "/api/inbox", async (req, res) => {
    // Read the dev-user header (handle both string and array cases)
    let devUserId = req.headers[DEV_USER_HEADER];
    if (Array.isArray(devUserId)) {
      devUserId = devUserId[0];
    }

    const items = await findInboxItems(devUserId);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ items }));
  });

  // POST /api/inbox/:id/claim — claim a pool task (T-0138 write-path).
  //
  // Authz: requires x-dev-user header (dev mode); 401 if absent.
  // Preconditions:
  //   - task must exist: 404 NOT_FOUND
  //   - task must be pool=true AND not already claimed: 409 ALREADY_CLAIMED
  // Success: 200 { item } — item with pool:false, execType:"human",
  //   execName=userId, mine:true (caller always mines their own claim).
  //
  // Idempotency: re-claiming own task → 200 (no-op, same record returned).
  // Claiming another user's claimed task → 409 ALREADY_CLAIMED.
  router.register("POST", "/api/inbox/:id/claim", async (req, res, params) => {
    // Resolve caller identity — 401 if absent
    let devUserId = req.headers[DEV_USER_HEADER];
    if (Array.isArray(devUserId)) devUserId = devUserId[0];
    if (!devUserId || typeof devUserId !== "string") {
      throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
    }

    const taskId = params["id"] as string;

    // Task must exist in seed
    const taskExists = INBOX_SEED.some((t) => t.id === taskId);
    if (!taskExists) {
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
      // Claimed by someone else
      throw new HttpError(409, "ALREADY_CLAIMED", "task already claimed by another user");
    }

    // Task must be pooled (not assigned to a specific person)
    const task = INBOX_SEED.find((t) => t.id === taskId)!;
    if (!task.pool) {
      throw new HttpError(409, "NOT_POOL_TASK", "task is not a pool task and cannot be claimed");
    }

    // Register claim
    CLAIMED.set(taskId, { claimedBy: devUserId, claimedAt: Date.now() });

    // Return updated item
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
