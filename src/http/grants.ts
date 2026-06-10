/**
 * src/http/grants.ts — T-0030 E3.4: Structural grant write-API
 *
 * Registers four write routes + GET /api/rights/dictionaries:
 *   POST /api/grants
 *   POST /api/grants/:id/revoke
 *   POST /api/role-assignments
 *   POST /api/role-assignments/:id/revoke
 *   GET  /api/rights/dictionaries
 *
 * Every write is gated by validateAdminDelegation (imported VERBATIM from
 * scoped-admin.ts — NF-7) before any INSERT (FF-9, AC-02/03/04/08/10).
 *
 * Grant INSERT + GrantAuditEvent audit_event INSERT are wrapped in a SINGLE
 * withTenant transaction for atomicity (ADR §2.4, Alt-D rejected).
 *
 * isGenesisOwner is NEVER hardcoded; it is resolved from the DB via
 * loadAdminContext → isGenesisOwnerForTenant (NF-3 / AC-15).
 *
 * encoding seam: T-0031 will replace writeGrantAuditEvent with its own
 * encoder. For now this is a thin local function writing the minimal honest
 * audit_event row using the existing T-0016 append path.
 */

import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  type GrantAuditEvent,
  type ScopeElement,
  normalize,
} from "../core/grant-lattice.js";
import {
  validateAdminDelegation,
} from "../core/scoped-admin.js";
import type { Grant } from "../core/grant-lattice.js";
import type { AncestryOracle } from "../core/grant-lattice.js";
import { loadAdminContext } from "../db/org.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER } from "./auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

// Seed-based in-memory oracle for org hierarchy ancestry.
// Day-1: uses slug-based IDs from ra-data.jsx ORG_TREE and UUID-based IDs
// from migrations. We do a simple prefix-match descent for the slug tree;
// for UUID nodes we treat equality-only (no DB traversal — T-0053 improves).
const ORG_SEED_CHILDREN: Record<string, string[]> = {
  org: ["fin", "cs", "plat", "sales"],
  fin: ["fin-calc", "fin-approve", "fin-treasury"],
  cs: ["cs-l1", "cs-l2"],
  sales: ["sales-smb", "sales-ent"],
  // UUID forest root departments (from migration 014/026 seed):
  "b0000000-0000-0000-0000-000000000001": [], // fin dept
  "b0000000-0000-0000-0000-000000000002": [], // cs dept
  "b0000000-0000-0000-0000-000000000003": [], // plat dept
};

function isDescendantOrSelfSeed(
  descendantId: string,
  ancestorId: string,
): boolean {
  if (descendantId === ancestorId) return true;
  const children = ORG_SEED_CHILDREN[ancestorId] ?? [];
  for (const c of children) {
    if (isDescendantOrSelfSeed(descendantId, c)) return true;
  }
  return false;
}

const SEED_ORACLE: AncestryOracle = {
  isDescendantOrSelf(_hierarchy, descendantId, ancestorId) {
    return isDescendantOrSelfSeed(descendantId, ancestorId);
  },
};

// ---------------------------------------------------------------------------
// withTenant helper (mirrors src/db/org.ts — write-path needs own transaction)
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  // Defence-in-depth: reject non-UUID tenantId before string-interpolating into
  // SET LOCAL (mirrors org.ts withTenant guard — R-4 / T-0116 R-3 pattern).
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
// parseScopeElement — ADR §2.3
// Returns a normalized ScopeElement or null if invalid.
// Freeform scope (kind:"freeform") is returned as-is (only genesis owner may use it).
// ---------------------------------------------------------------------------

export function parseScopeElement(raw: unknown): ScopeElement | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = r["kind"];

  if (kind === "freeform") {
    // Freeform is NOT a ScopeElement — the caller handles it specially.
    // We signal this by returning null; the handler checks the raw body separately.
    return null;
  }

  if (kind === "node") {
    const hierarchy = r["hierarchy"];
    const nodeId = r["nodeId"];
    const nodeLevel = r["nodeLevel"];
    if (
      (hierarchy !== "resource" && hierarchy !== "org") ||
      typeof nodeId !== "string" ||
      typeof nodeLevel !== "string"
    ) {
      return null;
    }
    return normalize({
      kind: "node",
      hierarchy: hierarchy as "resource" | "org",
      nodeId,
      nodeLevel: nodeLevel as ScopeElement extends { kind: "node" }
        ? ScopeElement["nodeLevel"]
        : never,
    } as ScopeElement);
  }

  if (kind === "tags") {
    const tags = r["tags"];
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) {
      return null;
    }
    return normalize({ kind: "tags", tags: tags as string[] });
  }

  if (kind === "interval") {
    const axis = r["axis"];
    const lo = r["lo"];
    const hi = r["hi"];
    if (
      typeof axis !== "string" ||
      typeof lo !== "number" ||
      typeof hi !== "number"
    ) {
      return null;
    }
    return normalize({ kind: "interval", axis, lo, hi });
  }

  if (kind === "set") {
    const members = r["members"];
    if (!Array.isArray(members)) return null;
    const parsed: Array<Exclude<ScopeElement, { kind: "set" }>> = [];
    for (const m of members) {
      const me = parseScopeElement(m);
      if (!me || me.kind === "set") return null; // sets can only contain atoms
      parsed.push(me as Exclude<ScopeElement, { kind: "set" }>);
    }
    return normalize({ kind: "set", members: parsed });
  }

  return null;
}

// ---------------------------------------------------------------------------
// writeGrantAuditEvent — encoding seam: T-0031 will replace with its encoder.
// Thin local function writing the minimal honest audit_event row.
// Follows the T-0016 append path: chained SHA-256 hash per tenant.
// Called INSIDE a withTenantTx callback (no own transaction).
// ---------------------------------------------------------------------------

async function writeGrantAuditEvent(
  client: pg.PoolClient,
  tenantId: string,
  evt: GrantAuditEvent,
  nowMs: number,
): Promise<void> {
  // Fetch current audit head for this tenant to maintain hash chain.
  const headRes = await client.query<{
    seq: string;
    row_hash: Buffer;
  }>(
    `SELECT seq, row_hash FROM choros.audit_head WHERE tenant_id = $1`,
    [tenantId],
  );

  let prevSeq: bigint;
  let prevHash: Buffer;

  if (headRes.rows.length === 0) {
    // No head yet — initialize.
    prevSeq = 0n;
    prevHash = Buffer.alloc(32); // all-zeros sentinel
  } else {
    prevSeq = BigInt(headRes.rows[0].seq);
    prevHash = headRes.rows[0].row_hash;
  }

  const newSeq = prevSeq + 1n;
  const auditId = randomUUID();
  const payload = JSON.stringify({ capability: evt.capability });

  // row_hash = SHA-256(prevHash || type || actor || subject || occurred_at)
  const rowHash = createHash("sha256")
    .update(prevHash)
    .update(evt.kind)
    .update(evt.actor)
    .update(evt.subjectRoleId ?? "")
    .update(String(nowMs))
    .digest();

  const scopeJson = JSON.stringify(evt.scope);

  // Insert audit_event row (AC-12 / FF-1).
  await client.query(
    `INSERT INTO choros.audit_event
       (tenant_id, seq, id, type, actor, subject, scope, via,
        proposed_by, confirmed_by, payload, occurred_at,
        prev_hash, row_hash, vocab_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8,
             $9, $10, $11::jsonb, $12,
             $13, $14, $15)`,
    [
      tenantId,
      newSeq.toString(),
      auditId,
      evt.kind,
      evt.actor,
      evt.subjectRoleId,
      scopeJson,
      "grant-editor",
      evt.proposedBy ?? null,
      evt.confirmedBy ?? null,
      payload,
      nowMs.toString(),
      prevHash,
      rowHash,
      1,
    ],
  );

  // Upsert audit_head advancing seq by exactly +1 (trigger enforces this).
  if (headRes.rows.length === 0) {
    await client.query(
      `INSERT INTO choros.audit_head (tenant_id, seq, row_hash, updated_at, vocab_version)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, newSeq.toString(), rowHash, nowMs.toString(), 1],
    );
  } else {
    await client.query(
      `UPDATE choros.audit_head
          SET seq = $2, row_hash = $3, updated_at = $4, vocab_version = $5
        WHERE tenant_id = $1`,
      [tenantId, newSeq.toString(), rowHash, nowMs.toString(), 1],
    );
  }
}

// ---------------------------------------------------------------------------
// Seed dictionaries for GET /api/rights/dictionaries (FR-8 / AC-16)
// Day-1: served from seed data (ra-data.jsx constants); no DB needed.
// ---------------------------------------------------------------------------

const DICT_RESOURCES = [
  { uri: "mcp://ledger.invoices", name: "Реестр счетов" },
  { uri: "mcp://ledger.recon", name: "Сверка платежей" },
  { uri: "mcp://payments.initiate", name: "Платёжный шлюз" },
  { uri: "mcp://payments.refund", name: "Возвраты средств" },
  { uri: "mcp://counterparty.kyc", name: "Контрагенты (KYC)" },
  { uri: "mcp://contracts.lookup", name: "Справочник договоров" },
  { uri: "mcp://support.queue", name: "Очередь обращений" },
  { uri: "mcp://crm.customer", name: "CRM клиента" },
  { uri: "mcp://kb.search", name: "База знаний" },
  { uri: "mcp://escalations.queue", name: "Очередь эскалаций" },
];

const DICT_OPERATIONS = [
  "read",
  "create",
  "update",
  "delete",
  "approve",
  "transition",
  "invoke",
];

const DICT_ORG_TREE = [
  { id: "org", label: "Компания", depth: 0, children: ["fin", "cs", "plat", "sales"] },
  { id: "fin", label: "Финансы", depth: 1, children: ["fin-calc", "fin-approve", "fin-treasury"] },
  { id: "fin-calc", label: "Расчёты", depth: 2, children: [] },
  { id: "fin-approve", label: "Согласование", depth: 2, children: [] },
  { id: "fin-treasury", label: "Казначейство", depth: 2, children: [] },
  { id: "cs", label: "Клиентский сервис", depth: 1, children: ["cs-l1", "cs-l2"] },
  { id: "cs-l1", label: "Поддержка L1", depth: 2, children: [] },
  { id: "cs-l2", label: "Эскалации L2", depth: 2, children: [] },
  { id: "plat", label: "Платформа", depth: 1, children: [] },
  { id: "sales", label: "Продажи", depth: 1, children: ["sales-smb", "sales-ent"] },
  { id: "sales-smb", label: "SMB", depth: 2, children: [] },
  { id: "sales-ent", label: "Enterprise", depth: 2, children: [] },
];

const DICT_SCOPE_TAGS = [
  { id: "pii", label: "ПДн" },
  { id: "payments", label: "платежи" },
  { id: "contracts", label: "договоры" },
  { id: "kyc", label: "KYC" },
  { id: "ext-api", label: "внешние-API" },
];

// ---------------------------------------------------------------------------
// Route registration (ADR §2.6)
// ---------------------------------------------------------------------------

/**
 * Register GET /api/rights/dictionaries UNCONDITIONALLY — seed-backed, no DB
 * required (ADR §2.1 / AC-16). Must be called BEFORE registerRightsRoutes so
 * that the literal path "dictionaries" is not captured by :roleId catch-all.
 */
export function registerDictionariesRoute(router: Router): void {
  // ---------- GET /api/rights/dictionaries (FR-8 / AC-16) ------------------
  router.register("GET", "/api/rights/dictionaries", async (_req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        resources: DICT_RESOURCES,
        operations: DICT_OPERATIONS,
        orgTree: DICT_ORG_TREE,
        scopeTags: DICT_SCOPE_TAGS,
      }),
    );
  });
}

export function registerGrantsRoutes(router: Router, pool: pg.Pool): void {

  // ---------- POST /api/grants (FR-1 / FR-2 / FR-6 / AC-01..06) -----------
  router.register("POST", "/api/grants", async (req, res) => {
    const actorId = extractActor(req);
    const tenantId = DEV_TENANT_ID;
    const nowMs = Date.now();

    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    // Load admin context once — reused for freeform admission guard and gate
    // (R-3: hoisted to avoid double DB round-trip in genesis-owner freeform path).
    const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);

    // Parse and validate scope (NF-1 / AC-05).
    const rawScope = b["scope"];
    const isFreeform =
      rawScope !== null &&
      typeof rawScope === "object" &&
      (rawScope as Record<string, unknown>)["kind"] === "freeform";

    let scope: ScopeElement | { kind: "freeform"; predicate: string };
    if (isFreeform) {
      // Freeform is only admitted for genesis owner (ADR §2.3 / NF-1).
      if (!admin.isGenesisOwner) {
        throw new HttpError(400, "INVALID_SCOPE", "freeform scope requires genesis owner");
      }
      scope = rawScope as { kind: "freeform"; predicate: string };
    } else {
      const parsed = parseScopeElement(rawScope);
      if (!parsed) {
        throw new HttpError(400, "INVALID_SCOPE", "scope must be a valid ScopeElement");
      }
      scope = parsed;
    }

    // Validate required fields.
    const roleId = b["role_id"];
    if (typeof roleId !== "string") {
      throw new HttpError(400, "VALIDATION", "role_id is required");
    }
    assertUuidShape(roleId, "role_id");

    const resourceType = b["resource_type"];
    if (typeof resourceType !== "string") {
      throw new HttpError(400, "VALIDATION", "resource_type is required");
    }

    const operation = b["operation"];
    if (typeof operation !== "string") {
      throw new HttpError(400, "VALIDATION", "operation is required");
    }

    const grantedBy = b["granted_by"];
    if (typeof grantedBy !== "string") {
      throw new HttpError(400, "VALIDATION", "granted_by is required");
    }

    let delegable =
      b["delegable"] === undefined ? true : Boolean(b["delegable"]);
    // NF-1: freeform scopes are forced non-delegable regardless of request body
    // (R-2: data-model invariant — validateNarrowing runtime check is not enough).
    if (isFreeform) {
      delegable = false;
    }
    const proposedBy =
      typeof b["proposed_by"] === "string" ? b["proposed_by"] : null;
    const confirmedBy =
      typeof b["confirmed_by"] === "string" ? b["confirmed_by"] : null;
    const validFrom =
      typeof b["valid_from"] === "number" ? b["valid_from"] : null;
    const validUntil =
      typeof b["valid_until"] === "number" ? b["valid_until"] : null;
    const resourceFacet = b["resource_facet"] ?? null;
    const constraint = b["constraint"] ?? null;

    // Verify role exists in tenant (404 if not).
    await assertRoleExists(pool, tenantId, roleId);

    // Build the child Grant object for validateAdminDelegation.
    const childGrant: Grant = {
      tenantId,
      id: randomUUID(),
      roleId,
      resourceType: resourceType as Grant["resourceType"],
      resourceFacet: resourceFacet ?? undefined,
      operation: operation as Grant["operation"],
      scope: scope as Grant["scope"],
      constraint: constraint ?? undefined,
      delegable,
      grantedBy,
      validFrom: validFrom ?? undefined,
      validUntil: validUntil ?? undefined,
      createdAt: nowMs,
    };

    // Gate: validateAdminDelegation (FF-9 — called before INSERT).
    const targetOrgScope: ScopeElement =
      admin.adminOrgScope.kind === "set" && admin.adminOrgScope.members.length === 0
        ? { kind: "set", members: [] }
        : admin.adminOrgScope;

    const gateResult = validateAdminDelegation(
      admin,
      { kind: "grant", childGrant, targetOrgScope },
      SEED_ORACLE,
    );

    if (!gateResult.ok) {
      throw new HttpError(403, "ADMIN_GATE_REJECTED", gateResult.reason);
    }

    // Write: INSERT + audit in one transaction (ADR §2.4 / AC-12 / FF-6).
    const newId = childGrant.id;

    await withTenantTx(pool, tenantId, async (client) => {
      // INSERT INTO choros."grant" — tenant_id is $1 (FF-4 / AC-20).
      await client.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, resource_facet,
            operation, scope, "constraint", delegable, granted_by,
            valid_from, valid_until, created_at, proposed_by, confirmed_by)
         VALUES ($1, $2, $3, $4, $5::jsonb,
                 $6, $7::jsonb, $8::jsonb, $9, $10,
                 $11, $12, $13, $14, $15)`,
        [
          tenantId,          // $1 — tenant_id leading (FF-4)
          newId,             // $2
          roleId,            // $3
          resourceType,      // $4
          resourceFacet !== null ? JSON.stringify(resourceFacet) : null, // $5
          operation,         // $6
          JSON.stringify(scope), // $7
          constraint !== null ? JSON.stringify(constraint) : null, // $8
          delegable,         // $9
          grantedBy,         // $10
          validFrom,         // $11
          validUntil,        // $12
          nowMs,             // $13
          proposedBy,        // $14
          confirmedBy,       // $15
        ],
      );

      // Audit emit (AC-12 / FF-1 / FF-6 — same transaction).
      // GrantAuditEvent.scope is Scope=ScopeElement; freeform is recorded as-is.
      const auditEvt: GrantAuditEvent = {
        kind: "grant.create",
        actor: actorId,
        subjectRoleId: roleId,
        capability: {
          resourceType,
          operation,
          resourceFacet: resourceFacet ?? undefined,
        },
        scope: scope as unknown as ScopeElement,
        proposedBy: proposedBy ?? undefined,
        confirmedBy: confirmedBy ?? undefined,
      };
      await writeGrantAuditEvent(client, tenantId, auditEvt, nowMs);
    });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: newId }));
  });

  // ---------- POST /api/grants/:id/revoke (FR-3 / AC-07/08/13) -------------
  router.register("POST", "/api/grants/:id/revoke", async (req, res, params) => {
    const actorId = extractActor(req);
    const tenantId = DEV_TENANT_ID;
    const nowMs = Date.now();
    const grantId = params.id as string;

    // Fetch the grant row (404 if missing or wrong tenant).
    const grantRow = await fetchGrantRow(pool, tenantId, grantId);

    // Load admin context.
    const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);

    // Gate: admin must hold covering mgmt_object:grant authority (AC-08).
    const targetOrgScope = admin.adminOrgScope;

    const gateResult = validateAdminDelegation(
      admin,
      { kind: "grant", childGrant: grantRow, targetOrgScope },
      SEED_ORACLE,
    );

    if (!gateResult.ok) {
      throw new HttpError(403, "ADMIN_GATE_REJECTED", gateResult.reason);
    }

    // Write: UPDATE valid_until + audit in one transaction (AC-07 / FF-6).
    await withTenantTx(pool, tenantId, async (client) => {
      // UPDATE — tenant_id is $1 (FF-4 / AC-20).
      await client.query(
        `UPDATE choros."grant"
            SET valid_until = $3
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, grantId, nowMs],
      );

      // Audit emit (AC-13 / FF-6 — same transaction).
      const auditEvt: GrantAuditEvent = {
        kind: "grant.revoke",
        actor: actorId,
        subjectRoleId: grantRow.roleId,
        capability: {
          resourceType: grantRow.resourceType,
          operation: grantRow.operation,
          resourceFacet: grantRow.resourceFacet,
        },
        scope: grantRow.scope as unknown as ScopeElement,
      };
      await writeGrantAuditEvent(client, tenantId, auditEvt, nowMs);
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: grantId }));
  });

  // ---------- POST /api/role-assignments (FR-4 / AC-09/10) -----------------
  router.register("POST", "/api/role-assignments", async (req, res) => {
    const actorId = extractActor(req);
    const tenantId = DEV_TENANT_ID;
    const nowMs = Date.now();

    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    const employeeId = b["employee_id"];
    if (typeof employeeId !== "string") {
      throw new HttpError(400, "VALIDATION", "employee_id is required");
    }
    assertUuidShape(employeeId, "employee_id");

    const roleId = b["role_id"];
    if (typeof roleId !== "string") {
      throw new HttpError(400, "VALIDATION", "role_id is required");
    }
    assertUuidShape(roleId, "role_id");

    const rawOrgScope = b["org_scope"];
    const orgScope = parseScopeElement(rawOrgScope);
    if (!orgScope) {
      throw new HttpError(400, "INVALID_SCOPE", "org_scope must be a valid ScopeElement");
    }

    const source = b["source"];
    if (typeof source !== "string") {
      throw new HttpError(400, "VALIDATION", "source is required");
    }

    const grantedBy = b["granted_by"];
    if (typeof grantedBy !== "string") {
      throw new HttpError(400, "VALIDATION", "granted_by is required");
    }

    const proposedBy =
      typeof b["proposed_by"] === "string" ? b["proposed_by"] : null;
    const confirmedBy =
      typeof b["confirmed_by"] === "string" ? b["confirmed_by"] : null;
    const validFrom =
      typeof b["valid_from"] === "number" ? b["valid_from"] : null;
    const validUntil =
      typeof b["valid_until"] === "number" ? b["valid_until"] : null;

    // Verify employee + role exist (404 if not).
    await assertEmployeeExists(pool, tenantId, employeeId);
    await assertRoleExists(pool, tenantId, roleId);

    // Load admin context and gate.
    const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);
    const gateResult = validateAdminDelegation(
      admin,
      { kind: "assignment", targetOrgScope: orgScope },
      SEED_ORACLE,
    );

    if (!gateResult.ok) {
      throw new HttpError(403, "ADMIN_GATE_REJECTED", gateResult.reason);
    }

    const newId = randomUUID();

    await withTenantTx(pool, tenantId, async (client) => {
      // INSERT INTO choros.role_assignment — tenant_id is $1 (FF-4 / AC-20).
      await client.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope,
            valid_from, valid_until, source, granted_by,
            proposed_by, confirmed_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb,
                 $6, $7, $8, $9,
                 $10, $11, $12, $12)`,
        [
          tenantId,             // $1 — tenant_id leading (FF-4)
          newId,                // $2
          employeeId,           // $3
          roleId,               // $4
          JSON.stringify(orgScope), // $5
          validFrom,            // $6
          validUntil,           // $7
          source,               // $8
          grantedBy,            // $9
          proposedBy,           // $10
          confirmedBy,          // $11
          nowMs,                // $12 → created_at + updated_at
        ],
      );

      // Audit emit (AC-12 / FR-6 / FF-6 — same transaction).
      // role_assignment creates are modelled as assignment-scope mgmt events.
      const auditEvt: GrantAuditEvent = {
        kind: "grant.create",
        actor: actorId,
        subjectRoleId: roleId,
        capability: {
          resourceType: "mgmt_object:role",
          operation: "create",
        },
        scope: orgScope,
        proposedBy: proposedBy ?? undefined,
        confirmedBy: confirmedBy ?? undefined,
      };
      await writeGrantAuditEvent(client, tenantId, auditEvt, nowMs);
    });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: newId }));
  });

  // ---------- POST /api/role-assignments/:id/revoke (FR-5 / AC-11) ---------
  router.register(
    "POST",
    "/api/role-assignments/:id/revoke",
    async (req, res, params) => {
      const actorId = extractActor(req);
      const tenantId = DEV_TENANT_ID;
      const nowMs = Date.now();
      const raId = params.id as string;

      // Fetch assignment row (404 if missing).
      const raRow = await fetchRoleAssignmentRow(pool, tenantId, raId);

      // Load admin context and gate on assignment's org_scope.
      const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);
      const gateResult = validateAdminDelegation(
        admin,
        {
          kind: "assignment",
          targetOrgScope: raRow.orgScope,
        },
        SEED_ORACLE,
      );

      if (!gateResult.ok) {
        throw new HttpError(403, "ADMIN_GATE_REJECTED", gateResult.reason);
      }

      await withTenantTx(pool, tenantId, async (client) => {
        // UPDATE — tenant_id is $1 (FF-4 / AC-20).
        await client.query(
          `UPDATE choros.role_assignment
              SET valid_until = $3, updated_at = $3
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, raId, nowMs],
        );

        const auditEvt: GrantAuditEvent = {
          kind: "grant.revoke",
          actor: actorId,
          subjectRoleId: raRow.roleId,
          capability: {
            resourceType: "mgmt_object:role",
            operation: "delete",
          },
          scope: raRow.orgScope,
        };
        await writeGrantAuditEvent(client, tenantId, auditEvt, nowMs);
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: raId }));
    },
  );
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function extractActor(req: import("node:http").IncomingMessage): string {
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

async function assertRoleExists(
  pool: pg.Pool,
  tenantId: string,
  roleId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM choros.role WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, roleId],
    );
    await client.query("COMMIT");
    if (rows.length === 0) {
      throw new HttpError(404, "NOT_FOUND", `role ${roleId} not found`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function assertEmployeeExists(
  pool: pg.Pool,
  tenantId: string,
  employeeId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM choros.employee WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, employeeId],
    );
    await client.query("COMMIT");
    if (rows.length === 0) {
      throw new HttpError(404, "NOT_FOUND", `employee ${employeeId} not found`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function fetchGrantRow(
  pool: pg.Pool,
  tenantId: string,
  grantId: string,
): Promise<Grant> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const { rows } = await client.query<{
      id: string;
      role_id: string;
      resource_type: string;
      resource_facet: unknown;
      operation: string;
      scope: unknown;
      constraint: unknown;
      delegable: boolean;
      granted_by: string;
      valid_from: string | null;
      valid_until: string | null;
      created_at: string;
    }>(
      `SELECT id, role_id, resource_type, resource_facet,
              operation, scope, "constraint", delegable,
              granted_by, valid_from, valid_until, created_at
         FROM choros."grant"
        WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, grantId],
    );
    await client.query("COMMIT");
    if (rows.length === 0) {
      throw new HttpError(404, "NOT_FOUND", `grant ${grantId} not found`);
    }
    const g = rows[0];
    return {
      tenantId,
      id: g.id,
      roleId: g.role_id,
      resourceType: g.resource_type as Grant["resourceType"],
      resourceFacet: g.resource_facet ?? undefined,
      operation: g.operation as Grant["operation"],
      scope: g.scope as Grant["scope"],
      constraint: g.constraint ?? undefined,
      delegable: g.delegable,
      grantedBy: g.granted_by,
      validFrom: g.valid_from != null ? Number(g.valid_from) : undefined,
      validUntil: g.valid_until != null ? Number(g.valid_until) : undefined,
      createdAt: Number(g.created_at),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function fetchRoleAssignmentRow(
  pool: pg.Pool,
  tenantId: string,
  raId: string,
): Promise<{ id: string; roleId: string; orgScope: ScopeElement }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const { rows } = await client.query<{
      id: string;
      role_id: string;
      org_scope: unknown;
    }>(
      `SELECT id, role_id, org_scope
         FROM choros.role_assignment
        WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, raId],
    );
    await client.query("COMMIT");
    if (rows.length === 0) {
      throw new HttpError(404, "NOT_FOUND", `role_assignment ${raId} not found`);
    }
    const r = rows[0];
    return {
      id: r.id,
      roleId: r.role_id,
      orgScope: r.org_scope as ScopeElement,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
