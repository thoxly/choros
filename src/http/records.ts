/**
 * src/http/records.ts — T-0264 E13: record create/list/get/update API.
 *
 * Records are the actual DATA ROWS of an application (migration 005_record.sql),
 * each conforming to the field-schema (`record_schema`) of the registry_def that
 * governs it. This is the third write-surface over a config/data primitive after
 * applications (T-0262) and registry_def (T-0263) — same module shape, same router
 * seam, same honest-degrade contract.
 *
 * Registers (deps-gated on { pool, resolveActorTenant }):
 *   POST /api/records      → create one record (validated against its registry_def)
 *   GET  /api/records      → list the caller-tenant's records (?application_id=,
 *                            ?registry_def_id= filters)
 *   GET  /api/records/:id  → get one record (404 if not in tenant)
 *   PUT  /api/records/:id  → update record data (re-validated; audited; 404 if not in tenant)
 *
 * THE RECORD ↔ registry_def LINK (migration 005): the `record` table carries only
 * `registry_id` (composite FK (tenant_id, registry_id) → registry_def(tenant_id, id)).
 * There is NO application_id column on `record` — the governing application is reached
 * THROUGH the registry_def (registry_def.application_id). The API therefore:
 *   - accepts `application_id` (+ optional `registry_def_id`) on POST and resolves the
 *     governing registry_def under that application (exactly-one rule, see below);
 *   - surfaces `application_id` + `registry_def_id` on every response by reading them
 *     from the joined registry_def row.
 *
 * GOVERNING registry_def RESOLUTION (POST):
 *   - If `registry_def_id` is supplied, it must be a registry_def of `application_id`
 *     in the caller's tenant; otherwise 404 NOT_FOUND.
 *   - If `registry_def_id` is absent, the application must have EXACTLY ONE
 *     registry_def — that one governs. Zero → 404 NOT_FOUND ("no registry_def");
 *     more than one → 409 CONFLICT ("ambiguous; pass registry_def_id"). This keeps the
 *     no-arg path honest: we never silently pick one of several schemas.
 *
 * DATA VALIDATION (the heart of T-0264): `data` is validated against the governing
 * registry_def's `record_schema` via validateRecordAgainstSchema (record-schema-
 * validator.ts — AJV). A mismatch is 400 VALIDATION with the AJV errors. We build a
 * one-entry SchemaHistoryMap { record_schema_version → record_schema } and validate
 * { data, schema_version: record_schema_version } against it — i.e. the record is
 * validated against the CURRENT schema version of its registry_def at write time.
 *
 * MULTI-TENANT (mandatory, AC): every operation runs inside withTenantTx under
 * SET LOCAL choros.tenant_id = '<actor-tenant>' + FORCE RLS (policy
 * record_tenant_isolation, migration 005). The actor's REAL tenant is resolved from
 * the dev-user slug via the injected resolveActorTenant — NEVER from the body or an
 * attacker-controlled header. A caller in tenant A therefore cannot read or update
 * tenant B's record (RLS-enforced, the Враг target).
 *
 * AUDIT (mandatory, like every mutating endpoint): create and update each append ONE
 * audit event (type record.create / record.update) via makePgAuditWriter().appendAuditEvent
 * INSIDE the same withTenantTx — so a caller ROLLBACK undoes the row AND the audit
 * entry atomically (T-0016 / T-0068 hash-chain).
 *
 * DEPS INJECTION (mirrors applications.ts / registry-defs.ts): the composition root
 * supplies { pool, resolveActorTenant }. When absent (no DATABASE_URL) the routes are
 * NOT registered — same honest-degrade contract as the other DB-backed write APIs.
 *
 * COLUMNS (migration 005_record.sql):
 *   tenant_id   uuid    (scope; resolved from actor, not body)
 *   id          uuid    (server-generated)
 *   registry_id uuid    (FK to the governing registry_def)
 *   data        jsonb   (the record payload; validated against record_schema)
 *   created_at  bigint  (epoch ms, server clock)
 *   updated_at  bigint  (epoch ms, server clock)
 *   created_by  text    (actor slug)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext } from "./auth.js";
import { validateRecordAgainstSchema } from "../core/record-schema-validator.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// Injected deps (mirrors ApplicationRoutesDeps / RegistryDefCrudDeps)
// ---------------------------------------------------------------------------

/**
 * Resolve the tenant the actor (dev-user slug) actually belongs to.
 * Production binding = resolveActorTenant(getOrgPool(), slug); injected so the test
 * suite can stub the membership check (actor A → tenant A, actor B → tenant B).
 */
export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface RecordRoutesDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// withTenantTx — canonical RLS pattern (mirrors applications.ts / registry-defs.ts)
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuidShape(tenantId, "tenantId");
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
// extractActor — caller identity (mirrors applications.ts / registry-defs.ts)
// ---------------------------------------------------------------------------

function extractActor(req: IncomingMessage): string {
  // Keycloak mode: AuthContext is set by withAuth() middleware before the handler.
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    return ctx.sub;
  }
  // Dev mode: x-dev-user header.
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// Row types + serializer
// ---------------------------------------------------------------------------

// A record joined to its governing registry_def, so the API surface can present
// application_id + registry_def_id + record_schema_version (none of which live on
// the record row itself — they come from the registry_def, migration 004 + 070).
interface RecordJoinedRow {
  id: string;
  registry_id: string;
  application_id: string;
  record_schema_version: number;
  data: unknown;
  created_at: string | number; // bigint comes back as a string from node-postgres
  updated_at: string | number;
}

function serializeRecord(row: RecordJoinedRow): Record<string, unknown> {
  return {
    id: row.id,
    application_id: row.application_id,
    registry_def_id: row.registry_id,
    record_schema_version: Number(row.record_schema_version),
    data: row.data,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

// SELECT a record + its governing registry_def's application_id / version, all
// tenant-scoped (the join also enforces tenant_id-leading FK alignment).
const RECORD_SELECT_JOIN =
  `r.id, r.registry_id, rd.application_id, rd.record_schema_version, ` +
  `r.data, r.created_at, r.updated_at`;

// ---------------------------------------------------------------------------
// Governing registry_def — the schema a record is validated against.
// ---------------------------------------------------------------------------

interface GoverningRegistryDef {
  id: string;
  application_id: string;
  record_schema: unknown;
  record_schema_version: number;
}

/**
 * Resolve the registry_def that governs records under `applicationId`.
 *
 * - registryDefId supplied → that registry_def, but only if it belongs to the
 *   application in this tenant (else 404).
 * - registryDefId absent → the application must have EXACTLY ONE registry_def
 *   (0 → 404, >1 → 409 ambiguous). Never silently picks among several schemas.
 *
 * Runs against an already-tenant-scoped client (inside withTenantTx + RLS).
 */
async function resolveGoverningRegistryDef(
  client: pg.PoolClient,
  tenantId: string,
  applicationId: string,
  registryDefId: string | null,
): Promise<GoverningRegistryDef> {
  if (registryDefId !== null) {
    const res = await client.query<GoverningRegistryDef>(
      `SELECT id, application_id, record_schema, record_schema_version
         FROM choros.registry_def
        WHERE tenant_id = $1 AND id = $2 AND application_id = $3`,
      [tenantId, registryDefId, applicationId],
    );
    if (res.rows.length === 0) {
      throw new HttpError(
        404,
        "NOT_FOUND",
        `registry_def '${registryDefId}' not found for application '${applicationId}' in this tenant`,
      );
    }
    return res.rows[0]!;
  }

  // No registry_def_id given: the application must have exactly one registry_def.
  const res = await client.query<GoverningRegistryDef>(
    `SELECT id, application_id, record_schema, record_schema_version
       FROM choros.registry_def
      WHERE tenant_id = $1 AND application_id = $2
      ORDER BY created_at ASC, slug ASC`,
    [tenantId, applicationId],
  );
  if (res.rows.length === 0) {
    throw new HttpError(
      404,
      "NOT_FOUND",
      `application '${applicationId}' has no registry_def to govern records`,
    );
  }
  if (res.rows.length > 1) {
    throw new HttpError(
      409,
      "CONFLICT",
      `application '${applicationId}' has multiple registry_defs; pass registry_def_id to disambiguate`,
    );
  }
  return res.rows[0]!;
}

/**
 * Load the governing registry_def for an EXISTING record (by its registry_id).
 * Used by PUT to re-validate the updated data against the same schema that governs
 * the row. Tenant-scoped via RLS on the open client.
 */
async function loadRegistryDefById(
  client: pg.PoolClient,
  tenantId: string,
  registryDefId: string,
): Promise<GoverningRegistryDef> {
  const res = await client.query<GoverningRegistryDef>(
    `SELECT id, application_id, record_schema, record_schema_version
       FROM choros.registry_def
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, registryDefId],
  );
  if (res.rows.length === 0) {
    // The record's FK guarantees a registry_def exists in the tenant; defensive 404.
    throw new HttpError(404, "NOT_FOUND", "governing registry_def not found");
  }
  return res.rows[0]!;
}

/**
 * Validate `data` against a registry_def's record_schema (the current version).
 * Builds a one-entry SchemaHistoryMap so we reuse the canonical record-schema-
 * validator (one validator, not two). Throws 400 VALIDATION on mismatch.
 */
function assertDataValid(data: unknown, reg: GoverningRegistryDef): void {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "VALIDATION", "data must be a JSON object");
  }
  const schemaHistory = new Map<number, object>([
    [Number(reg.record_schema_version), reg.record_schema as object],
  ]);
  const result = validateRecordAgainstSchema(
    { data: data as object, schema_version: Number(reg.record_schema_version) },
    schemaHistory,
  );
  if (!result.valid) {
    throw new HttpError(
      400,
      "VALIDATION",
      `data does not conform to registry_def schema: ${result.errors.join("; ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

async function createRecord(args: {
  pool: pg.Pool;
  tenantId: string;
  applicationId: string;
  registryDefId: string | null;
  data: unknown;
  actor: string;
  nowMs: number;
}): Promise<RecordJoinedRow> {
  const { pool, tenantId, applicationId, registryDefId, data, actor, nowMs } = args;
  const id = randomUUID();
  return withTenantTx(pool, tenantId, async (client) => {
    // 1. Resolve the governing registry_def (404/409 paths inside).
    const reg = await resolveGoverningRegistryDef(
      client,
      tenantId,
      applicationId,
      registryDefId,
    );

    // 2. Validate data against the governing schema (400 on mismatch).
    assertDataValid(data, reg);

    // 3. Insert the record (tenant-scoped under RLS).
    await client.query(
      `INSERT INTO choros.record
         (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5, $6)`,
      [tenantId, id, reg.id, JSON.stringify(data), nowMs, actor],
    );

    // 4. Append ONE audit event (record.create) inside the same tx (T-0016 / T-0068).
    const writer = makePgAuditWriter();
    await writer.appendAuditEvent(client as unknown as PgClientLike, {
      id: randomUUID(),
      type: "record.create",
      actor,
      subject: id,
      scope: { registry_def_id: reg.id, application_id: reg.application_id },
      via: "records-api",
      proposed_by: null,
      confirmed_by: actor,
      payload: {
        record_id: id,
        registry_def_id: reg.id,
        application_id: reg.application_id,
        record_schema_version: Number(reg.record_schema_version),
      },
      occurred_at: nowMs,
    });

    // 5. Read back the joined row for the response.
    const res = await client.query<RecordJoinedRow>(
      `SELECT ${RECORD_SELECT_JOIN}
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, id],
    );
    return res.rows[0]!;
  });
}

async function listRecords(
  pool: pg.Pool,
  tenantId: string,
  applicationId: string | null,
  registryDefId: string | null,
): Promise<RecordJoinedRow[]> {
  return withTenantTx(pool, tenantId, async (client) => {
    const conds: string[] = ["r.tenant_id = $1"];
    const params: unknown[] = [tenantId];
    if (applicationId !== null) {
      params.push(applicationId);
      conds.push(`rd.application_id = $${params.length}`);
    }
    if (registryDefId !== null) {
      params.push(registryDefId);
      conds.push(`r.registry_id = $${params.length}`);
    }
    const res = await client.query<RecordJoinedRow>(
      `SELECT ${RECORD_SELECT_JOIN}
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
        WHERE ${conds.join(" AND ")}
        ORDER BY r.created_at DESC, r.id ASC`,
      params,
    );
    return res.rows;
  });
}

async function getRecord(
  pool: pg.Pool,
  tenantId: string,
  id: string,
): Promise<RecordJoinedRow | null> {
  return withTenantTx(pool, tenantId, async (client) => {
    const res = await client.query<RecordJoinedRow>(
      `SELECT ${RECORD_SELECT_JOIN}
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, id],
    );
    return res.rows[0] ?? null;
  });
}

async function updateRecord(args: {
  pool: pg.Pool;
  tenantId: string;
  id: string;
  data: unknown;
  actor: string;
  nowMs: number;
}): Promise<RecordJoinedRow | null> {
  const { pool, tenantId, id, data, actor, nowMs } = args;
  return withTenantTx(pool, tenantId, async (client) => {
    // 1. Lock and read the existing record (tenant-scoped; FOR UPDATE).
    const cur = await client.query<{ registry_id: string }>(
      `SELECT registry_id
         FROM choros.record
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE`,
      [tenantId, id],
    );
    if (cur.rows.length === 0) {
      // Not in the caller's tenant (RLS-filtered) OR does not exist → caller maps to 404.
      return null;
    }
    const registryId = cur.rows[0]!.registry_id;

    // 2. Re-validate the new data against the governing registry_def schema.
    const reg = await loadRegistryDefById(client, tenantId, registryId);
    assertDataValid(data, reg);

    // 3. Apply the update.
    await client.query(
      `UPDATE choros.record
          SET data = $1::jsonb,
              updated_at = $2
        WHERE tenant_id = $3 AND id = $4`,
      [JSON.stringify(data), nowMs, tenantId, id],
    );

    // 4. Append ONE audit event (record.update) inside the same tx.
    const writer = makePgAuditWriter();
    await writer.appendAuditEvent(client as unknown as PgClientLike, {
      id: randomUUID(),
      type: "record.update",
      actor,
      subject: id,
      scope: { registry_def_id: reg.id, application_id: reg.application_id },
      via: "records-api",
      proposed_by: null,
      confirmed_by: actor,
      payload: {
        record_id: id,
        registry_def_id: reg.id,
        application_id: reg.application_id,
        record_schema_version: Number(reg.record_schema_version),
      },
      occurred_at: nowMs,
    });

    // 5. Read back the joined row for the response.
    const res = await client.query<RecordJoinedRow>(
      `SELECT ${RECORD_SELECT_JOIN}
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, id],
    );
    return res.rows[0] ?? null;
  });
}

// ---------------------------------------------------------------------------
// Query-param parsing
// ---------------------------------------------------------------------------

function parseUuidQueryParam(
  req: IncomingMessage,
  name: string,
): string | null {
  const rawUrl = req.url ?? "";
  const qIdx = rawUrl.indexOf("?");
  if (qIdx < 0) return null;
  const params = new URLSearchParams(rawUrl.slice(qIdx + 1));
  const val = params.get(name);
  if (val === null) return null;
  if (!UUID_RE.test(val)) {
    throw new HttpError(400, "VALIDATION", `${name} query param must be a valid UUID`);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register the records create/list/get/update routes.
 *
 * @param router HTTP router.
 * @param deps   Injected { pool, resolveActorTenant }. When omitted the routes are
 *               NOT registered (no-DB honest degrade — same as the other write APIs).
 */
export function registerRecordRoutes(
  router: Router,
  deps?: RecordRoutesDeps,
): void {
  if (!deps) return;
  const { pool, resolveActorTenant } = deps;

  // POST /api/records — create one record in the caller's tenant, validated against
  // the governing registry_def's record_schema.
  router.register("POST", "/api/records", async (req: IncomingMessage, res: ServerResponse) => {
    const actor = extractActor(req);

    const rawBody = await readJsonBody(req);
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;

    const applicationId = body["application_id"];
    if (typeof applicationId !== "string" || !UUID_RE.test(applicationId)) {
      throw new HttpError(400, "VALIDATION", "application_id must be a valid UUID");
    }

    let registryDefId: string | null = null;
    if (
      "registry_def_id" in body &&
      body["registry_def_id"] !== null &&
      body["registry_def_id"] !== undefined
    ) {
      if (typeof body["registry_def_id"] !== "string" || !UUID_RE.test(body["registry_def_id"])) {
        throw new HttpError(400, "VALIDATION", "registry_def_id must be a valid UUID");
      }
      registryDefId = body["registry_def_id"];
    }

    if (!("data" in body)) {
      throw new HttpError(400, "VALIDATION", "data is required");
    }
    const data = body["data"];

    const tenantId = await resolveActorTenant(actor);
    const row = await createRecord({
      pool,
      tenantId,
      applicationId,
      registryDefId,
      data,
      actor,
      nowMs: Date.now(),
    });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(serializeRecord(row)));
  });

  // GET /api/records — list the caller-tenant's records, optionally filtered by
  // ?application_id= and/or ?registry_def_id=.
  router.register("GET", "/api/records", async (req: IncomingMessage, res: ServerResponse) => {
    const actor = extractActor(req);
    const applicationId = parseUuidQueryParam(req, "application_id");
    const registryDefId = parseUuidQueryParam(req, "registry_def_id");

    const tenantId = await resolveActorTenant(actor);
    const rows = await listRecords(pool, tenantId, applicationId, registryDefId);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ records: rows.map(serializeRecord) }));
  });

  // GET /api/records/:id — get one record (404 if not in the caller's tenant).
  router.register(
    "GET",
    "/api/records/:id",
    async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "record id");

      const actor = extractActor(req);
      const tenantId = await resolveActorTenant(actor);
      const row = await getRecord(pool, tenantId, id);
      if (row === null) {
        // Not in the caller's tenant (RLS-filtered) OR does not exist → 404.
        throw new HttpError(404, "NOT_FOUND", "record not found");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(serializeRecord(row)));
    },
  );

  // PUT /api/records/:id — update a record's data (re-validated; audited; 404 if not
  // in the caller's tenant).
  router.register(
    "PUT",
    "/api/records/:id",
    async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "record id");

      const actor = extractActor(req);

      const rawBody = await readJsonBody(req);
      if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;

      if (!("data" in body)) {
        throw new HttpError(400, "VALIDATION", "data is required");
      }
      const data = body["data"];

      const tenantId = await resolveActorTenant(actor);
      const row = await updateRecord({
        pool,
        tenantId,
        id,
        data,
        actor,
        nowMs: Date.now(),
      });
      if (row === null) {
        throw new HttpError(404, "NOT_FOUND", "record not found");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(serializeRecord(row)));
    },
  );
}
