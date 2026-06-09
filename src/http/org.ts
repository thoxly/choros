/**
 * src/http/org.ts
 *
 * Read-API for org structure (GET /api/org and optionally GET /api/org/employee/:id).
 * In-memory seed data with org hierarchy: department → position → people.
 * Zero external dependencies — only node:http types and router.ts.
 */
import { HttpError, type Router } from "./router.js";
import { JobStore } from "../core/jobStore.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OrgPerson = {
  id: string;
  name: string;
  type: "human" | "agent" | "service";
};

type OrgPosition = {
  id: string;
  title: string;
  people: OrgPerson[];
};

type OrgDepartment = {
  id: string;
  name: string;
  positions: OrgPosition[];
};

// ---------------------------------------------------------------------------
// In-memory seed fixture
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
          { id: "s-ledger", name: "ledger-sync", type: "service" },
          { id: "s-ocr", name: "ocr-gateway", type: "service" },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Data accessors
// ---------------------------------------------------------------------------

function findOrgData(): OrgDepartment[] {
  return ORG_SEED;
}

export function findEmployee(employeeId: string): OrgPerson & { position: string; department: string } | null {
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

export function listSelectableUsers(): Array<{
  id: string;
  name: string;
  position: string;
  department: string;
}> {
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
// Route registration
// ---------------------------------------------------------------------------

export function registerOrgRoutes(router: Router, _store?: JobStore): void {
  // GET /api/org — return full org tree
  router.register("GET", "/api/org", async (_req, res) => {
    const departments = findOrgData();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ departments }));
  });

  // GET /api/org/employee/:id — return details of one employee (optional)
  router.register("GET", "/api/org/employee/:id", async (_req, res, params) => {
    const employee = findEmployee(params.id as string);
    if (!employee) {
      throw new HttpError(404, "NOT_FOUND", "employee not found");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(employee));
  });
}
