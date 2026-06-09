/**
 * src/http/inbox.ts
 *
 * Read-API for inbox task list (GET /api/inbox).
 * In-memory seed data with task inbox items matching screen-inbox.jsx shape.
 * Zero external dependencies — only node:http types and router.ts.
 */
import { type Router } from "./router.js";
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
// Data accessors
// ---------------------------------------------------------------------------

function findInboxItems(devUserId?: string): InboxItem[] {
  // Resolve dev-user to person if provided
  let person = null;
  if (devUserId && typeof devUserId === "string") {
    person = findEmployee(devUserId);
  }

  // Add mine flag to each item: true if item is assigned to this person
  return INBOX_SEED.map((item) => {
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

    const items = findInboxItems(devUserId);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ items }));
  });
}
