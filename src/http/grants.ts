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
 * encoding seam: writeGrantAuditEvent / writeAssignmentAuditEvent encode via the
 * T-0031 encoders (encodeGrantAuditEvent / encodeAssignmentAuditEvent), then append
 * through the SINGLE canonical audit sink — appendAuditEvent (src/db/audit-writer.ts,
 * T-0068). The earlier T-0030 placeholder local writer (partial/non-JCS preimage on
 * the same vocab=1 tables) is REMOVED: one preimage rule governs the whole chain so
 * grant + lifecycle rows interleave verifiably (ADR §9 forward-obligation landed).
 */

import { randomUUID } from "node:crypto";
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
import {
  encodeGrantAuditEvent,
  encodeAssignmentAuditEvent,
  type AssignmentAuditEvent,
  type AuditEventInput,
} from "../core/audit-grant-encoder.js";
import { combineCriticality, criticalityDiff } from "../core/role-criticality.js";
import {
  dualControlDecision,
  buildConfirmationFlag,
  encodeDualControlAuditEvent,
  requirementReason,
  type ConfirmationFlag,
} from "../core/dual-control.js";
import { loadAdminContext } from "../db/org.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
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
// appendAuditEventInput — routes a pre-encoded AuditEventInput through the SINGLE
// canonical audit sink (src/db/audit-writer.ts, T-0068). It does NOT compute a
// chain itself: T-0030 originally carried a LOCAL placeholder writer with a
// partial, non-length-prefixed, non-JCS preimage that stamped vocab_version=1 on
// the same audit_event/audit_head tables. Two incompatible preimage rules under
// the same vocab pin would make a verifier (T-0053) false-positive tamper on grant
// rows and break density verification on a mixed grant+lifecycle chain. Per the
// ADR §9 forward-obligation, grant-trail audit now appends through the canonical
// appendAuditEvent (length-prefixed/JCS over all 14 fields, FOR-UPDATE seed-head
// serialization), the same sink lifecycle audit uses — one preimage, one chain.
//
// Runs INSIDE a withTenantTx callback (no own transaction); the writer sources
// tenant_id from the choros.tenant_id GUC the caller set.
// ---------------------------------------------------------------------------

const grantAuditWriter = makePgAuditWriter();

async function appendAuditEventInput(
  client: pg.PoolClient,
  _tenantId: string,
  input: AuditEventInput,
): Promise<void> {
  await grantAuditWriter.appendAuditEvent(client as unknown as PgClientLike, input);
}

// ---------------------------------------------------------------------------
// writeGrantAuditEvent — T-0031 encoder seam integration.
// Encodes a GrantAuditEvent via encodeGrantAuditEvent (T-0031) and appends
// to audit_event via appendAuditEventInput.
// Called INSIDE a withTenantTx callback (no own transaction).
// ---------------------------------------------------------------------------

async function writeGrantAuditEvent(
  client: pg.PoolClient,
  tenantId: string,
  evt: GrantAuditEvent,
  nowMs: number,
): Promise<void> {
  const input = encodeGrantAuditEvent(evt, nowMs);
  await appendAuditEventInput(client, tenantId, input);
}

// ---------------------------------------------------------------------------
// writeAssignmentAuditEvent — T-0031 encoder seam integration.
// Encodes an AssignmentAuditEvent via encodeAssignmentAuditEvent (T-0031)
// and appends to audit_event via appendAuditEventInput.
// Called INSIDE a withTenantTx callback (no own transaction).
// ---------------------------------------------------------------------------

async function writeAssignmentAuditEvent(
  client: pg.PoolClient,
  tenantId: string,
  evt: AssignmentAuditEvent,
  nowMs: number,
): Promise<void> {
  const input = encodeAssignmentAuditEvent(evt, nowMs);
  await appendAuditEventInput(client, tenantId, input);
}

// ---------------------------------------------------------------------------
// T-0044 dual-control seam helpers.
//
// loadRoleEffectiveGrants — read the role's grant rows INSIDE the caller's
// transaction (the live DAO binding is T-0053; day-1 reads in the existing
// withTenantTx). The from/to criticality fold uses these effective grants.
// writeDualControlAuditEvent — append the dualcontrol.gate WORM event via the
// canonical appendAuditEventInput (NF-7 — no parallel audit path).
// ---------------------------------------------------------------------------

async function loadRoleEffectiveGrants(
  client: pg.PoolClient,
  tenantId: string,
  roleId: string,
): Promise<Grant[]> {
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
      WHERE tenant_id = $1 AND role_id = $2`,
    [tenantId, roleId],
  );
  return rows.map((g) => ({
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
  }));
}

async function writeDualControlAuditEvent(
  client: pg.PoolClient,
  tenantId: string,
  args: {
    flag: ConfirmationFlag;
    decision: import("../core/dual-control.js").DualControlDecision;
    changeKind: "grant" | "assignment";
    actor: string;
    proposedBy: string;
    primaryConfirmer: string | null;
    via?: "dual-control" | "dual-control.second-confirm";
    nowMs: number;
  },
): Promise<void> {
  const input = encodeDualControlAuditEvent({
    id: randomUUID(),
    flag: args.flag,
    decision: args.decision,
    changeKind: args.changeKind,
    actor: args.actor,
    proposedBy: args.proposedBy,
    primaryConfirmer: args.primaryConfirmer,
    via: args.via,
    nowMs: args.nowMs,
  });
  await appendAuditEventInput(client, tenantId, input);
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

    // T-0044 rev-2 §9.6 — CONFIRM-REQUEST #2 (second authenticated confirm) on
    // an existing semi-confirmed grant. The phase selector rides the SAME
    // endpoint (no new route). The second approver's identity is the
    // authenticated actor (extractActor) — NEVER a body field (R-AUTH).
    if (b["phase"] === "confirm2") {
      await handleSecondConfirm({
        pool,
        tenantId,
        actor: actorId, // authenticated, NOT from body
        changeRef: b["change_ref"],
        changeKind: "grant",
        nowMs,
        res,
      });
      return;
    }

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
    // T-0044 rev-2 R-AUTH (§9.2/§9.5, FE-2026-W24-0044-C): approver identity is
    // taken ONLY from the authenticated actor (extractActor), NEVER from the
    // request body. This closes the pre-existing `confirmed_by = b["confirmed_by"]`
    // body-assertion (the proposer could name their own confirmer). proposed_by /
    // confirmed_by below are derived from the gate's two-request flow, not the body.
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

    // Write: gate (T-0044) + INSERT + audit in one transaction (ADR §2.4/§3.8/§9.6).
    const newId = childGrant.id;

    const gateOutcome = await withTenantTx(pool, tenantId, async (client) => {
      // T-0044 §9.6 — fold the role's EFFECTIVE criticality before/after the
      // proposed grant (compiled, NOT a row-diff: FR-4). The live DAO is T-0053;
      // day-1 reads inside this transaction (coder seam, ADR §8).
      const current = await loadRoleEffectiveGrants(client, tenantId, roleId);
      const fromCrit = combineCriticality(current, nowMs);
      const toCrit = combineCriticality([...current, childGrant], nowMs);
      const addedReadGrants =
        childGrant.operation === "read" ? [childGrant] : [];

      // R-AUTH (§9.6): proposer-as-only-actor at req#1; approvers === [] (a
      // second authenticated approver arrives in a SEPARATE confirm2 request).
      const decision = dualControlDecision({
        from: fromCrit,
        to: toCrit,
        proposedBy: actorId, // authenticated actor — NOT a body field
        approvers: [],
        addedReadGrants,
      });

      const reqReason = requirementReason({
        from: fromCrit,
        to: toCrit,
        addedReadGrants,
      });

      if (decision.required_approvers === 1) {
        // Routine (non-escalating) path: a single authenticated approver
        // (≠ proposer) completes in one request. R-AUTH still binds (§9.5):
        // confirmed_by is the authenticated actor, never b["confirmed_by"].
        // Day-1: the requesting actor IS the single scoped approver; the
        // proposer-exclusion is structurally satisfied because there is no
        // separate proposer (proposed_by = NULL, confirmed_by = actor). A
        // future propose/confirm split asserts actor !== proposer here.
        await client.query(
          `INSERT INTO choros."grant"
             (tenant_id, id, role_id, resource_type, resource_facet,
              operation, scope, "constraint", delegable, granted_by,
              valid_from, valid_until, created_at,
              proposed_by, confirmed_by, confirmed2_by)
           VALUES ($1, $2, $3, $4, $5::jsonb,
                   $6, $7::jsonb, $8::jsonb, $9, $10,
                   $11, $12, $13,
                   $14, $15, $16)`,
          [
            tenantId, newId, roleId, resourceType,
            resourceFacet !== null ? JSON.stringify(resourceFacet) : null,
            operation, JSON.stringify(scope),
            constraint !== null ? JSON.stringify(constraint) : null,
            delegable, grantedBy, validFrom, validUntil, nowMs,
            null,       // proposed_by (no separate proposer day-1)
            actorId,    // confirmed_by = authenticated actor (R-AUTH)
            null,       // confirmed2_by stays NULL (routine → active)
          ],
        );

        const flag = buildConfirmationFlag({
          changeRef: newId,
          diff: criticalityDiff(fromCrit, toCrit),
          approvers: [actorId],
          status: "satisfied",
        });
        await writeDualControlAuditEvent(client, tenantId, {
          flag, decision, changeKind: "grant", actor: actorId,
          proposedBy: actorId, primaryConfirmer: actorId,
          via: "dual-control", nowMs,
        });

        // Existing grant.create audit (sibling event, same tx — NF-7).
        await writeGrantAuditEvent(client, tenantId, {
          kind: "grant.create",
          actor: actorId,
          subjectRoleId: roleId,
          capability: { resourceType, operation, resourceFacet: resourceFacet ?? undefined },
          scope: scope as unknown as ScopeElement,
          confirmedBy: actorId,
        }, nowMs);

        return { state: "confirmed" as const, reason: reqReason };
      }

      // Escalating path (required_approvers === 2): the row lands SEMI-CONFIRMED
      // (confirmed2_by IS NULL ⇒ NOT active). The critical expansion is NOT
      // active until a SECOND authenticated approver confirms (§9.3/§9.6).
      await client.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, resource_facet,
            operation, scope, "constraint", delegable, granted_by,
            valid_from, valid_until, created_at,
            proposed_by, confirmed_by, confirmed2_by)
         VALUES ($1, $2, $3, $4, $5::jsonb,
                 $6, $7::jsonb, $8::jsonb, $9, $10,
                 $11, $12, $13,
                 $14, $15, $16)`,
        [
          tenantId, newId, roleId, resourceType,
          resourceFacet !== null ? JSON.stringify(resourceFacet) : null,
          operation, JSON.stringify(scope),
          constraint !== null ? JSON.stringify(constraint) : null,
          delegable, grantedBy, validFrom, validUntil, nowMs,
          actorId,  // proposed_by = authenticated actor
          actorId,  // confirmed_by = approver1 (authenticated)
          null,     // confirmed2_by = NULL → semi-confirmed, NOT active
        ],
      );

      const flag = buildConfirmationFlag({
        changeRef: newId,
        diff: criticalityDiff(fromCrit, toCrit),
        approvers: [actorId], // only the first authenticated confirmer so far
        status: "pending",
      });
      await writeDualControlAuditEvent(client, tenantId, {
        flag, decision, changeKind: "grant", actor: actorId,
        proposedBy: actorId, primaryConfirmer: actorId,
        via: "dual-control", nowMs,
      });

      // Existing grant.create audit (sibling event, same tx).
      await writeGrantAuditEvent(client, tenantId, {
        kind: "grant.create",
        actor: actorId,
        subjectRoleId: roleId,
        capability: { resourceType, operation, resourceFacet: resourceFacet ?? undefined },
        scope: scope as unknown as ScopeElement,
        proposedBy: actorId,
        confirmedBy: actorId,
      }, nowMs);

      return { state: "semi-confirmed" as const, reason: reqReason };
    });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: newId,
        state: gateOutcome.state,
        ...(gateOutcome.state === "semi-confirmed"
          ? { second_approver_required: true, reason: gateOutcome.reason }
          : {}),
      }),
    );
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

    // T-0044 rev-2 §9.6 — CONFIRM-REQUEST #2 on a semi-confirmed assignment.
    if (b["phase"] === "confirm2") {
      await handleSecondConfirm({
        pool,
        tenantId,
        actor: actorId, // authenticated, NOT from body
        changeRef: b["change_ref"],
        changeKind: "assignment",
        nowMs,
        res,
      });
      return;
    }

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

    // T-0044 rev-2 R-AUTH: proposed_by/confirmed_by are derived from the gate's
    // two-request flow (authenticated actor), NOT from the request body. The
    // pre-existing `confirmed_by = b["confirmed_by"]` body-assertion is closed
    // (FE-2026-W24-0044-C).
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

    const gateOutcome = await withTenantTx(pool, tenantId, async (client) => {
      // T-0044 §9.6 / FR-7 — the dual-control gate guards the assignment confirm
      // path too. An assignment does NOT change the role's grant set, so the
      // EFFECTIVE criticality folds identically before/after (from ≡ to ⇒ no
      // escalation): day-1 this is a routine one-approver path. The guard is
      // wired honestly so a future role-criticality-bearing assignment change
      // escalates through the SAME seam (no second enforcement point).
      const roleGrants = await loadRoleEffectiveGrants(client, tenantId, roleId);
      const fromCrit = combineCriticality(roleGrants, nowMs);
      const toCrit = combineCriticality(roleGrants, nowMs);
      const decision = dualControlDecision({
        from: fromCrit,
        to: toCrit,
        proposedBy: actorId,
        approvers: [],
        addedReadGrants: [],
      });

      const isEscalating = decision.required_approvers === 2;
      // INSERT — confirmed_by = authenticated actor (R-AUTH); confirmed2_by is
      // NULL at req#1 (semi-confirmed if escalating; active if routine).
      await client.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope,
            valid_from, valid_until, source, granted_by,
            proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb,
                 $6, $7, $8, $9,
                 $10, $11, $12, $13, $13)`,
        [
          tenantId, newId, employeeId, roleId, JSON.stringify(orgScope),
          validFrom, validUntil, source, grantedBy,
          isEscalating ? actorId : null, // proposed_by
          actorId,                        // confirmed_by (authenticated)
          null,                           // confirmed2_by
          nowMs,
        ],
      );

      const flag = buildConfirmationFlag({
        changeRef: newId,
        diff: criticalityDiff(fromCrit, toCrit),
        approvers: [actorId],
        status: isEscalating ? "pending" : "satisfied",
      });
      await writeDualControlAuditEvent(client, tenantId, {
        flag, decision, changeKind: "assignment", actor: actorId,
        proposedBy: actorId, primaryConfirmer: actorId,
        via: "dual-control", nowMs,
      });

      // Existing assignment.create audit (sibling event, same tx — NF-7).
      await writeAssignmentAuditEvent(client, tenantId, {
        kind: "assignment.create",
        actor: actorId,
        employeeId,
        roleId,
        orgScope,
        proposedBy: isEscalating ? actorId : undefined,
        confirmedBy: actorId,
      }, nowMs);

      return { state: isEscalating ? ("semi-confirmed" as const) : ("confirmed" as const) };
    });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: newId,
        state: gateOutcome.state,
        ...(gateOutcome.state === "semi-confirmed"
          ? { second_approver_required: true }
          : {}),
      }),
    );
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

        // Audit emit — role_assignment revokes use encodeAssignmentAuditEvent (T-0031 seam).
        const auditEvt: AssignmentAuditEvent = {
          kind: "assignment.revoke",
          actor: actorId,
          employeeId: raRow.employeeId,
          roleId: raRow.roleId,
          orgScope: raRow.orgScope,
        };
        await writeAssignmentAuditEvent(client, tenantId, auditEvt, nowMs);
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

// ---------------------------------------------------------------------------
// T-0044 rev-2 §9.6 — CONFIRM-REQUEST #2 (second authenticated confirm).
//
// The SECOND approver of a semi-confirmed criticality-escalating change. The
// approver's identity is the authenticated actor (passed in from extractActor)
// — NEVER a body field (R-AUTH). The write-gard loads proposed_by/confirmed_by
// from the DB ROW (not the body) and enforces distinctness over the THREE
// authenticated principals: actor2 ≠ proposed_by AND actor2 ≠ confirmed_by.
// On success it sets confirmed2_by = actor2 (semi-confirmed → confirmed) and
// appends a second dualcontrol.gate WORM event (via: dual-control.second-confirm).
// ---------------------------------------------------------------------------

async function handleSecondConfirm(args: {
  pool: pg.Pool;
  tenantId: string;
  actor: string;
  changeRef: unknown;
  changeKind: "grant" | "assignment";
  nowMs: number;
  res: import("node:http").ServerResponse;
}): Promise<void> {
  const { pool, tenantId, actor, changeKind, nowMs, res } = args;
  if (typeof args.changeRef !== "string") {
    throw new HttpError(400, "VALIDATION", "change_ref is required for phase=confirm2");
  }
  const changeRef = args.changeRef;
  assertUuidShape(changeRef, "change_ref");

  const table = changeKind === "grant" ? 'choros."grant"' : "choros.role_assignment";

  await withTenantTx(pool, tenantId, async (client) => {
    // Load the target row's approver columns from the DB — NOT the body (R-AUTH).
    const { rows } = await client.query<{
      proposed_by: string | null;
      confirmed_by: string | null;
      confirmed2_by: string | null;
    }>(
      `SELECT proposed_by, confirmed_by, confirmed2_by
         FROM ${table} WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, changeRef],
    );
    if (rows.length === 0) {
      throw new HttpError(404, "NOT_FOUND", `${changeKind} ${changeRef} not found`);
    }
    const row = rows[0];

    // Already confirmed by a second approver → reject (idempotent guard).
    if (row.confirmed2_by !== null) {
      throw new HttpError(
        409,
        "DUAL_CONTROL_UNSATISFIED",
        "already_confirmed",
      );
    }

    // Distinctness over AUTHENTICATED ids: actor2 must differ from BOTH the
    // proposer and the first confirmer (§9.6). A self-confirm is rejected.
    if (actor === row.proposed_by || actor === row.confirmed_by) {
      throw new HttpError(
        409,
        "DUAL_CONTROL_UNSATISFIED",
        "self_confirm",
      );
    }

    // Transition semi-confirmed → confirmed. The `AND confirmed2_by IS NULL`
    // guard makes the UPDATE a no-op under a concurrent double-confirm race.
    const upd = await client.query(
      `UPDATE ${table}
          SET confirmed2_by = $3${changeKind === "assignment" ? ", updated_at = $4" : ""}
        WHERE tenant_id = $1 AND id = $2 AND confirmed2_by IS NULL`,
      changeKind === "assignment"
        ? [tenantId, changeRef, actor, nowMs]
        : [tenantId, changeRef, actor],
    );
    if (upd.rowCount === 0) {
      // Lost the race — another second approver landed first.
      throw new HttpError(409, "DUAL_CONTROL_UNSATISFIED", "already_confirmed");
    }

    // The distinct approver set is now {confirmed_by(req#1), confirmed2_by(req#2)}
    // — both authenticated, never body-asserted.
    const approvers = [row.confirmed_by, actor].filter(
      (a): a is string => typeof a === "string",
    );
    const flag = buildConfirmationFlag({
      changeRef,
      // The effective_diff was recorded on req#1's pending event; req#2 records
      // the satisfied transition. The expansion bits are carried in the prior
      // event; here we emit the second-confirm with an escalating diff marker.
      diff: { expanded: { approve_or_transition: false, external_invoke: false, sensitive_read: false }, escalates: true },
      approvers,
      status: "satisfied",
    });
    await writeDualControlAuditEvent(client, tenantId, {
      flag,
      decision: {
        required_approvers: 2,
        distinct_ok: true,
        satisfied: true,
        reason: "satisfied",
      },
      changeKind,
      actor,
      proposedBy: row.proposed_by ?? actor,
      primaryConfirmer: actor,
      via: "dual-control.second-confirm",
      nowMs,
    });
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ id: changeRef, state: "confirmed" }));
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
): Promise<{ id: string; employeeId: string; roleId: string; orgScope: ScopeElement }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const { rows } = await client.query<{
      id: string;
      employee_id: string;
      role_id: string;
      org_scope: unknown;
    }>(
      `SELECT id, employee_id, role_id, org_scope
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
      employeeId: r.employee_id,
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
