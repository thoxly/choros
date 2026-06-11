/**
 * src/http/org.ts
 *
 * Read-API for org structure (GET /api/org and GET /api/org/employee/:id).
 * After T-0017: reads from real Postgres tables when DATABASE_URL is set.
 * Falls back to in-memory ORG_SEED when DATABASE_URL is absent (dev-no-db path).
 *
 * FROZEN EXPORTS (FE-W23-0008 / ADR §3.7):
 *   findEmployee, listSelectableUsers, registerOrgRoutes
 * These symbols are imported by src/http/auth.ts and src/http/inbox.ts — do NOT
 * rename, reorder parameters, or change return types.
 */
import { HttpError, type Router } from "./router.js";
import { JobStore } from "../core/jobStore.js";
import { DEV_USER_HEADER } from "./auth.js";
import {
  listOrgTree,
  findEmployeeById,
  listHumanEmployees,
  getOrgPool,
  DEV_TENANT_ID,
  resolveActorTenant,
  resolveTenantBySlug,
  type OrgPerson,
  type OrgDepartment,
} from "../db/org.js";

// ---------------------------------------------------------------------------
// Types (re-exported for callers using OrgPerson shape)
// ---------------------------------------------------------------------------

export type { OrgPerson, OrgDepartment };

// ---------------------------------------------------------------------------
// In-memory seed fixture (fallback when DATABASE_URL is absent)
// ORG_SEED is retained as the migration-seed source for backwards compatibility
// and as the dev-no-db fallback. It is NOT the live HTTP response source when
// DATABASE_URL is set (AC-13 / FF-ORG-10).
// ---------------------------------------------------------------------------

const ORG_SEED: OrgDepartment[] = [
  {
    id: "fin",
    name: "Финансы",
    positions: [
      {
        id: "fin-ctrl",
        title: "Контролёр расчётов",
        people: [
          { id: "e-kravtsova", name: "А. Кравцова", type: "human" },
          { id: "a-recon", name: "Сверка-агент", type: "agent" },
        ],
      },
      {
        id: "fin-appr",
        title: "Согласующий счетов",
        people: [
          { id: "a-invoice", name: "Счёт-агент", type: "agent" },
          { id: "e-mironov", name: "Д. Миронов", type: "human" },
        ],
      },
      {
        id: "fin-cfo",
        title: "Финансовый директор",
        people: [{ id: "e-larina", name: "Е. Ларина", type: "human" }],
      },
    ],
  },
  {
    id: "cs",
    name: "Клиентский сервис",
    positions: [
      {
        id: "cs-l1",
        title: "Линия поддержки L1",
        people: [
          { id: "a-triage", name: "Триаж-агент", type: "agent" },
          { id: "e-orlov", name: "К. Орлов", type: "human" },
          { id: "e-savina", name: "Н. Савина", type: "human" },
        ],
      },
      {
        id: "cs-l2",
        title: "Эскалации L2",
        people: [{ id: "e-petrov", name: "И. Петров", type: "human" }],
      },
    ],
  },
  {
    id: "plat",
    name: "Платформа",
    positions: [
      {
        id: "plat-int",
        title: "Интеграции",
        people: [{ id: "e-belov", name: "С. Белов", type: "human" }],
      },
      {
        id: "plat-svc",
        title: "Сервисные коннекторы",
        people: [
          { id: "s-ledger", name: "ledger-sync", type: "agent" },
          { id: "s-ocr", name: "ocr-gateway", type: "agent" },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// DB availability flag — checked once at module load time
// ---------------------------------------------------------------------------

function hasDb(): boolean {
  return Boolean(process.env["DATABASE_URL"]);
}

// ---------------------------------------------------------------------------
// Data accessors — DB path when DATABASE_URL set, else in-memory fallback
// ---------------------------------------------------------------------------

function findOrgDataSync(): OrgDepartment[] {
  return ORG_SEED;
}

/**
 * findEmployee — FROZEN SIGNATURE (callers: auth.ts, inbox.ts).
 *
 * ADR §1.4 / §3.7: delegates to DB layer (findEmployeeById) when DATABASE_URL
 * is set; falls back to ORG_SEED for dev-no-db path. Callers are always in an
 * async route handler and await this function.
 */
export async function findEmployee(
  employeeId: string,
): Promise<(OrgPerson & { position: string; department: string }) | null> {
  if (hasDb()) {
    // T-0141: resolve actor's tenant from DB (resolveActorTenant fallback=DEV_TENANT_ID)
    const tenantId = await resolveActorTenant(getOrgPool(), employeeId);
    return findEmployeeById(getOrgPool(), tenantId, employeeId);
  }
  // In-memory fallback (no DATABASE_URL).
  for (const department of ORG_SEED) {
    for (const position of department.positions) {
      for (const person of position.people) {
        if (person.id === employeeId) {
          return {
            ...person,
            position: position.title,
            department: department.name,
          };
        }
      }
    }
  }
  return null;
}

/**
 * listSelectableUsers — FROZEN SIGNATURE (callers: auth.ts, inbox.ts).
 *
 * ADR §1.4 / §3.7: delegates to DB layer (listHumanEmployees) when DATABASE_URL
 * is set; falls back to ORG_SEED for dev-no-db path. Callers are always in an
 * async route handler and await this function.
 */
export async function listSelectableUsers(): Promise<Array<{
  id: string;
  name: string;
  position: string;
  department: string;
}>> {
  if (hasDb()) {
    // T-0141: use DEMO_TENANT_SLUG (default: "showcase") for pre-login picker
    const demoSlug = process.env["DEMO_TENANT_SLUG"] ?? "showcase";
    const tenantId = await resolveTenantBySlug(getOrgPool(), demoSlug);
    return listHumanEmployees(getOrgPool(), tenantId);
  }
  // In-memory fallback (no DATABASE_URL).
  const users = [];
  for (const department of ORG_SEED) {
    for (const position of department.positions) {
      for (const person of position.people) {
        if (person.type === "human") {
          users.push({
            id: person.id,
            name: person.name,
            position: position.title,
            department: department.name,
          });
        }
      }
    }
  }
  return users;
}

// ---------------------------------------------------------------------------
// Route registration (FROZEN SIGNATURE: registerOrgRoutes)
// ---------------------------------------------------------------------------

export function registerOrgRoutes(router: Router, _store?: JobStore): void {
  // GET /api/org — return full org tree
  // T-0141: resolve actor's tenant from X-Dev-User header (fallback: DEV_TENANT_ID)
  router.register("GET", "/api/org", async (req, res) => {
    let departments: OrgDepartment[];
    if (hasDb()) {
      let actorSlug = req.headers[DEV_USER_HEADER];
      if (Array.isArray(actorSlug)) actorSlug = actorSlug[0];
      const tenantId =
        actorSlug && typeof actorSlug === "string"
          ? await resolveActorTenant(getOrgPool(), actorSlug)
          : DEV_TENANT_ID;
      departments = await listOrgTree(getOrgPool(), tenantId);
    } else {
      departments = findOrgDataSync();
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ departments }));
  });

  // GET /api/org/employee/:id — return details of one employee
  router.register("GET", "/api/org/employee/:id", async (_req, res, params) => {
    const employee = await findEmployee(params.id as string);
    if (!employee) {
      throw new HttpError(404, "NOT_FOUND", "employee not found");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(employee));
  });

  // GET /api/users — return human-only list (used by auth.ts route handler)
  // Note: /api/users is registered here for DB-backed path; auth.ts also registers it.
  // To avoid double-registration, /api/users stays in auth.ts; org.ts provides helpers.
}

