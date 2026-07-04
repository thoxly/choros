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
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import {
  listOrgTree,
  findEmployeeById,
  listHumanEmployees,
  getOrgPool,
  DEV_TENANT_ID,
  resolveActorTenant,
  resolveActorSlugFromAuth,
  resolveTenantBySlug,
  getTenantInfo,
  loadAdminContext,
  type OrgPerson,
  type OrgDepartment,
} from "../db/org.js";
import {
  AUTHORING_DRAFT,
  OBSERVABILITY_READ,
  holdsObservabilityRead,
} from "../core/capability-authz.js";

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
  router.register("GET", "/api/org", withAuth(async (req, res) => {
    let departments: OrgDepartment[];
    if (hasDb()) {
      // Mode-aware actor resolution (T-0327; T-0371/T-0633 fix): keycloak mode
      // resolves the JWT sub/preferred_username to the REAL employee slug via
      // resolveActorSlugFromAuth — mirrors /api/my-tenant and
      // /api/me/nav-capabilities below in this same file. Returning the raw
      // JWT sub here (the former bug) sends an unresolvable UUID into
      // resolveActorTenant for any seeded persona (KC sub != employee.slug),
      // which fail-closes with 403 ACTOR_TENANT_UNRESOLVED even for a
      // legitimate owner. dev mode (x-dev-user) is unchanged.
      const authCtx = getAuthContext(req);
      let actorSlug: string | undefined;
      if (authCtx !== undefined) {
        const resolved = await resolveActorSlugFromAuth(
          getOrgPool(),
          authCtx.sub,
          authCtx.preferredUsername,
        );
        if (!resolved) {
          throw new HttpError(
            401,
            "UNAUTHENTICATED",
            "no employee matches authenticated identity",
          );
        }
        actorSlug = resolved;
      } else {
        let h = req.headers[DEV_USER_HEADER];
        if (Array.isArray(h)) h = h[0];
        actorSlug = typeof h === "string" && h.length > 0 ? h : undefined;
      }
      const tenantId =
        actorSlug
          ? await resolveActorTenant(getOrgPool(), actorSlug)
          : DEV_TENANT_ID;
      departments = await listOrgTree(getOrgPool(), tenantId);
    } else {
      departments = findOrgDataSync();
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ departments }));
  }));

  // GET /api/my-tenant — resolve the CALLER's real tenant from their identity.
  //
  // WHY THIS EXISTS: in keycloak mode the JWT carries no tenant claim and the SPA
  // had no way to learn which tenant the logged-in user belongs to — so every
  // org/process/agent screen hardcoded x-tenant-id = DEV_TENANT_ID (the seed
  // "Dev Silo"). A user who registered their OWN company was therefore pointed at
  // a tenant they don't own → 403 NOT_OWNER on org writes (and process drafts
  // leaked into the dev silo). This endpoint returns the caller's actual tenant
  // (resolved from the validated identity, NEVER from a request header), so the
  // SPA can send the correct tenant and label the workspace with the real company.
  router.register("GET", "/api/my-tenant", withAuth(async (req, res) => {
    let tenantId: string;
    let tenant = null;
    if (hasDb()) {
      const authCtx = getAuthContext(req);
      let actorSlug: string | null | undefined;
      if (authCtx !== undefined) {
        // keycloak: resolve sub/preferred_username → employee slug (sub-first).
        actorSlug = await resolveActorSlugFromAuth(
          getOrgPool(),
          authCtx.sub,
          authCtx.preferredUsername,
        );
        if (!actorSlug) {
          throw new HttpError(
            401,
            "UNAUTHENTICATED",
            "no employee matches authenticated identity",
          );
        }
      } else {
        // dev: x-dev-user header is the slug.
        let h = req.headers[DEV_USER_HEADER];
        if (Array.isArray(h)) h = h[0];
        actorSlug = typeof h === "string" && h.length > 0 ? h : undefined;
        if (!actorSlug) {
          throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
        }
      }
      tenantId = await resolveActorTenant(getOrgPool(), actorSlug);
      tenant = await getTenantInfo(getOrgPool(), tenantId);
    } else {
      // dev-no-db: keep the SPA functional with the legacy fallback tenant.
      tenantId = DEV_TENANT_ID;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ tenantId, tenant }));
  }));

  // T-0539: GET /api/me/nav-capabilities — nav-visibility capability projection.
  //
  // Thin wrapper over loadAdminContext + getGrantsForSubject.
  // Returns NavCapabilitySet { isGenesisOwner, capabilities[], zones[], degraded? }
  // derived EXCLUSIVELY from the actor's grants — NOT a second permission layer.
  //
  // Zone map (ADR §6, projectZones):
  //   'work'         — always (floor, no capability required)
  //   'constructor'  — 'authoring_draft' ∈ capabilities
  //   'observability'— 'observability:read' ∈ capabilities
  //   'admin'        — any mgmt_object:* grant OR isGenesisOwner
  //
  // Fail-closed: any DB error → { isGenesisOwner:false, capabilities:[], zones:['work'], degraded:true }
  // dev-no-db → same degraded response (SPA stays functional, only РАБОТА visible).
  router.register("GET", "/api/me/nav-capabilities", withAuth(async (req, res) => {
    // dev-no-db fast-path: no DB available → fail-closed floor.
    if (!hasDb()) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        isGenesisOwner: false,
        capabilities: [],
        zones: ["work"],
        degraded: true,
      }));
      return;
    }

    try {
      // Resolve actor slug — same pattern as /api/my-tenant.
      const authCtx = getAuthContext(req);
      let actorSlug: string | null | undefined;
      if (authCtx !== undefined) {
        actorSlug = await resolveActorSlugFromAuth(
          getOrgPool(),
          authCtx.sub,
          authCtx.preferredUsername,
        );
        if (!actorSlug) {
          throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
        }
      } else {
        let h = req.headers[DEV_USER_HEADER];
        if (Array.isArray(h)) h = h[0];
        actorSlug = typeof h === "string" && h.length > 0 ? h : undefined;
        if (!actorSlug) {
          throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
        }
      }

      const tenantId = await resolveActorTenant(getOrgPool(), actorSlug);
      const nowMs = Date.now();

      // Load admin context (isGenesisOwner + mgmt_object:* grants via existing resolver).
      // Also load all actor grants (getGrantsForSubject) for capability-token check.
      // Both use the same pool/tenant pattern — existing, tested resolver paths.
      const { getGrantsForSubject } = await import("../db/grants-dao.js");
      const [adminCtx, actorGrants] = await Promise.all([
        loadAdminContext(getOrgPool(), tenantId, actorSlug, nowMs),
        getGrantsForSubject(getOrgPool(), tenantId, actorSlug, nowMs),
      ]);

      const { isGenesisOwner } = adminCtx;

      // Capability-class set: capability tokens the actor holds.
      const capTokens = new Set<string>();
      for (const g of actorGrants) {
        const rt = g.resourceType as string;
        if (rt === (AUTHORING_DRAFT as string) || rt === (OBSERVABILITY_READ as string)) {
          capTokens.add(rt);
        }
      }
      // mgmt_object:* classes from adminCtx (for capabilities[] field completeness).
      const mgmtTypes = new Set<string>();
      for (const g of adminCtx.adminGrants) {
        mgmtTypes.add(g.resourceType as string);
      }

      // Flat capability list for the response (deduplicated).
      const capabilities: string[] = [
        ...Array.from(capTokens),
        ...Array.from(mgmtTypes),
      ];

      // projectZones — the SINGLE canonical zone-map (ADR §4.4 / §6).
      const zones: string[] = ["work"]; // floor: always visible
      if (isGenesisOwner || capTokens.has(AUTHORING_DRAFT as string)) {
        zones.push("constructor");
      }
      if (isGenesisOwner || holdsObservabilityRead(actorGrants)) {
        zones.push("observability");
      }
      if (isGenesisOwner || adminCtx.adminGrants.length > 0) {
        zones.push("admin");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ isGenesisOwner, capabilities, zones }));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // Unexpected DB/resolver error → fail-closed degraded response.
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        isGenesisOwner: false,
        capabilities: [],
        zones: ["work"],
        degraded: true,
      }));
    }
  }));

  // GET /api/org/employee/:id — return details of one employee
  router.register("GET", "/api/org/employee/:id", withAuth(async (_req, res, params) => {
    const employee = await findEmployee(params.id as string);
    if (!employee) {
      throw new HttpError(404, "NOT_FOUND", "employee not found");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(employee));
  }));

  // GET /api/users — return human-only list (used by auth.ts route handler)
  // Note: /api/users is registered here for DB-backed path; auth.ts also registers it.
  // To avoid double-registration, /api/users stays in auth.ts; org.ts provides helpers.
}

