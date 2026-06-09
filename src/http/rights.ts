/**
 * src/http/rights.ts
 *
 * Read-API for RBAC roles (GET /api/rights and optionally GET /api/rights/:roleId).
 * In-memory seed data matching screen-rights.jsx ROLES structure.
 * Zero external dependencies — only node:http types and router.ts.
 */
import { HttpError, type Router } from "./router.js";
import { JobStore } from "../core/jobStore.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Holder = {
  type: "human" | "agent" | "service";
  name: string;
};

type Grant = {
  res: string;
  uri: string;
  ops: string[];
  scope: string;
};

type Field = {
  name: string;
  a: "read" | "write" | "hidden";
};

type Role = {
  id: string;
  name: string;
  dept: string;
  scope: string;
  holders: Holder[];
  grants: Grant[];
  fields: Field[];
};

// ---------------------------------------------------------------------------
// In-memory seed fixture (verbatim from screen-rights.jsx ROLES)
// ---------------------------------------------------------------------------

const RIGHTS_SEED: Role[] = [
  {
    id: "role-fin-control", name: "Контролёр расчётов", dept: "Финансы", scope: "Финансы",
    holders: [{ type: "human", name: "А. Кравцова" }],
    grants: [
      { res: "Реестр счетов", uri: "mcp://ledger.invoices", ops: ["read", "write"], scope: "Финансы" },
      { res: "Сверка платежей", uri: "mcp://ledger.recon", ops: ["read", "write"], scope: "Финансы" },
      { res: "Контрагенты (KYC)", uri: "mcp://counterparty.kyc", ops: ["read", "write"], scope: "Финансы" },
      { res: "Платёжный шлюз", uri: "mcp://payments.initiate", ops: ["exec"], scope: "≤ ₽250 000" },
    ],
    fields: [
      { name: "Сумма счёта", a: "read" }, { name: "Контрагент", a: "write" },
      { name: "Реквизиты", a: "write" }, { name: "Лимит платежа", a: "read" },
    ],
  },
  {
    id: "role-fin-approve-250", name: "Согласование ≤ ₽250 000", dept: "Финансы", scope: "Финансы · Согласование счёта",
    holders: [{ type: "human", name: "А. Кравцова" }, { type: "human", name: "Е. Ларина" }],
    grants: [
      { res: "Реестр счетов", uri: "mcp://ledger.invoices", ops: ["read"], scope: "Финансы · Согласование счёта" },
      { res: "Платёжный шлюз", uri: "mcp://payments.initiate", ops: ["exec"], scope: "≤ ₽250 000" },
    ],
    fields: [
      { name: "Сумма счёта", a: "read" }, { name: "Решение", a: "write" }, { name: "Возврат средств", a: "hidden" },
    ],
  },
  {
    id: "role-fin-approve-50", name: "Согласующий счетов ≤ ₽50 000", dept: "Финансы", scope: "Финансы · Согласование счёта",
    holders: [{ type: "agent", name: "Счёт-агент" }],
    grants: [
      { res: "Реестр счетов", uri: "mcp://ledger.invoices", ops: ["read", "write"], scope: "Финансы · Согласование счёта" },
      { res: "Справочник договоров", uri: "mcp://contracts.lookup", ops: ["read"], scope: "Финансы" },
      { res: "OCR-распознавание", uri: "mcp://ocr.extract", ops: ["exec"], scope: "Финансы · Согласование счёта" },
      { res: "Платёжный шлюз", uri: "mcp://payments.initiate", ops: ["exec"], scope: "≤ ₽50 000" },
    ],
    fields: [
      { name: "Сумма счёта", a: "read" }, { name: "Контрагент", a: "read" }, { name: "Договор", a: "read" },
      { name: "Реквизиты", a: "write" }, { name: "Возврат средств", a: "hidden" },
    ],
  },
  {
    id: "role-fin-recon", name: "Сверка платежей", dept: "Финансы", scope: "Финансы · Закрытие месяца",
    holders: [{ type: "agent", name: "Счёт-агент" }, { type: "human", name: "А. Кравцова" }],
    grants: [
      { res: "Реестр счетов", uri: "mcp://ledger.invoices", ops: ["read"], scope: "Финансы" },
      { res: "Сверка платежей", uri: "mcp://ledger.recon", ops: ["read", "write"], scope: "Финансы · Закрытие месяца" },
      { res: "Шина событий", uri: "mcp://bus.publish", ops: ["exec"], scope: "Финансы" },
    ],
    fields: [
      { name: "Период", a: "read" }, { name: "Расхождение", a: "write" }, { name: "Комментарий", a: "write" },
    ],
  },
  {
    id: "role-fin-escrcv", name: "Приёмник эскалаций агентов", dept: "Финансы", scope: "Финансы",
    holders: [{ type: "human", name: "А. Кравцова" }],
    grants: [
      { res: "Очередь эскалаций", uri: "mcp://escalations.queue", ops: ["read", "write"], scope: "Финансы" },
      { res: "Журнал агентов", uri: "mcp://agents.audit", ops: ["read"], scope: "Финансы" },
    ],
    fields: [
      { name: "Инцидент", a: "read" }, { name: "Резолюция", a: "write" },
    ],
  },
  {
    id: "role-cs-l1", name: "Линия поддержки L1", dept: "Клиентский сервис", scope: "Клиентский сервис · Поддержка",
    holders: [{ type: "agent", name: "Триаж-агент" }, { type: "human", name: "К. Орлов" }, { type: "human", name: "Н. Савина" }],
    grants: [
      { res: "Очередь обращений", uri: "mcp://support.queue", ops: ["read", "write"], scope: "Поддержка" },
      { res: "База знаний", uri: "mcp://kb.search", ops: ["read"], scope: "—" },
      { res: "CRM клиента", uri: "mcp://crm.customer", ops: ["read"], scope: "Поддержка" },
    ],
    fields: [
      { name: "Тема", a: "read" }, { name: "Категория", a: "write" }, { name: "Ответ", a: "write" },
      { name: "Возврат средств", a: "hidden" },
    ],
  },
  {
    id: "role-cs-l2", name: "Эскалации L2", dept: "Клиентский сервис", scope: "Клиентский сервис · Поддержка",
    holders: [{ type: "human", name: "И. Петров" }],
    grants: [
      { res: "Очередь обращений", uri: "mcp://support.queue", ops: ["read", "write"], scope: "Поддержка" },
      { res: "CRM клиента", uri: "mcp://crm.customer", ops: ["read", "write"], scope: "Поддержка" },
      { res: "Возвраты средств", uri: "mcp://payments.refund", ops: ["exec"], scope: "≤ ₽30 000" },
    ],
    fields: [
      { name: "Спор", a: "read" }, { name: "Возврат средств", a: "write" }, { name: "Решение", a: "write" },
    ],
  },
  {
    id: "role-plat-ledger", name: "Коннектор реестра", dept: "Платформа", scope: "Платформа",
    holders: [{ type: "service", name: "ledger-sync" }],
    grants: [
      { res: "Реестр счетов", uri: "mcp://ledger.invoices", ops: ["read", "write"], scope: "Платформа" },
      { res: "Шина событий", uri: "mcp://bus.publish", ops: ["exec"], scope: "Платформа" },
    ],
    fields: [],
  },
];

// ---------------------------------------------------------------------------
// Data accessors
// ---------------------------------------------------------------------------

function findRightsData(): Role[] {
  return RIGHTS_SEED;
}

function findRole(roleId: string): Role | null {
  return RIGHTS_SEED.find((r) => r.id === roleId) || null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerRightsRoutes(router: Router, _store?: JobStore): void {
  // GET /api/rights — return full roles list
  router.register("GET", "/api/rights", async (_req, res) => {
    const roles = findRightsData();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ roles }));
  });

  // GET /api/rights/:roleId — return details of one role
  router.register("GET", "/api/rights/:roleId", async (_req, res, params) => {
    const role = findRole(params.roleId as string);
    if (!role) {
      throw new HttpError(404, "NOT_FOUND", "role not found");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(role));
  });
}
