/**
 * src/http/pdp-explain.ts — T-0136: Explain-эндпоинт PDP
 *
 * POST /api/pdp/explain
 *
 * Возвращает диагностическую трассу почему субъект получает allow/deny
 * на запрошенный ресурс и операцию. Переиспользует resolveFor с инъекцией
 * TraceCollector — единая логика, гарантированное совпадение вердиктов.
 *
 * Authz самого explain (ADR §2.2 / gap-map инвариант 4):
 *   - самоопрос: callerSubjectId === body.subject.subjectId
 *   - admin: confirmed, in-window, delegable grant на mgmt_object:grant (read),
 *     проверяется через loadAdminContext + validateAdminDelegation
 *
 * Анти-oracle: не-admin запрос о чужом субъекте → 403 (без подробностей).
 * Маскинг: maskedFields раскрывается только admin; при самоопросе — только
 * governed-флаг (не раскрывать существование drop-полей — AC-8).
 *
 * Ограничение scope (R-2): explain поддерживает op ∈ {read, create, update, delete}.
 * Операции invoke/approve/transition требуют EffectSource / SodSource,
 * которые не имеют production-реализации в контексте explain (T-0053).
 * Запрос с неподдерживаемым op → 422 EXPLAIN_OP_UNSUPPORTED.
 * Это задекларировано в ADR §3.5 как честное сужение, а не молчаливое игнорирование.
 *
 * Record-источник (R-3): для ref.kind === "record" читается реальная запись из БД
 * (tenant-isolated, RLS). Для ref.kind ∈ {registry, application} возвращается non-null
 * sentinel ({ __explain_resource_sentinel__: true }) — resolveFor вызывает getRecord
 * безусловно для всех kind (шаг 5), sentinel нужен чтобы не получить ложный not_found;
 * соответствующий шаг трассы record_fetch ok:true помечен note:"n/a for non-record ref".
 *
 * 503 NO_DATABASE (R-7): эндпоинт регистрируется всегда; без пула отдаёт 503.
 */

import pg from "pg";
import type { IncomingMessage } from "node:http";
import {
  type ResolverDeps,
  type TraceCollector,
  type TraceStep,
  resolveFor,
} from "../core/grant-resolver.js";
import {
  type ObjectHandle,
  type ResolveSubject,
  makeHandle,
} from "../core/object-handle.js";
import {
  type ResourceRef,
} from "../core/object-handle.js";
import {
  type Operation,
  type Grant,
  type ScopeElement,
} from "../core/grant-lattice.js";
import {
  validateAdminDelegation,
} from "../core/scoped-admin.js";
import { loadAdminContext } from "../db/org.js";
import { SEED_ORACLE } from "./seed-ancestry.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Supported operations (R-2): explain is honest only for grant→scope→record
// pipeline. invoke/approve/transition require EffectSource/SodSource that have
// no production-backed implementation in the explain context yet (T-0053).
// ---------------------------------------------------------------------------

/** Operations fully supported by explain (honest verdict match guaranteed). */
const EXPLAIN_SUPPORTED_OPS: readonly Operation[] = ["read", "create", "update", "delete"];

/** All valid operations accepted at the HTTP level. */
const ALL_VALID_OPS: Operation[] = ["read", "create", "update", "delete", "approve", "transition", "invoke"];

// ---------------------------------------------------------------------------
// Ancestry oracle — imported from shared module (T-0053 improves to DB-backed)
// ---------------------------------------------------------------------------
//
// SEED_ORACLE is the shared seed-based oracle from seed-ancestry.ts.
// Known gap: correct only for the dev-seed org topology; wrong for tenants with
// a different department structure. This affects admin delegation checks that
// compare org-scoped authority. DB-backed ancestry requires refactoring the
// synchronous AncestryOracle interface (T-0053).
//
// Do NOT redeclare ORG_SEED_CHILDREN here — use the shared export instead.
// (FF-4 / ci/checks/seed/single-source.sh enforces this)

// ---------------------------------------------------------------------------
// DB-backed grant source for explain (read the subject's actual grants)
// ---------------------------------------------------------------------------

async function loadSubjectGrants(
  pool: pg.Pool,
  tenantId: string,
  subjectId: string,
  nowMs: number,
): Promise<Grant[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");

    // Load confirmed, in-window role_assignments for the subject.
    const { rows: raRows } = await client.query<{
      role_id: string;
    }>(
      `SELECT ra.role_id
         FROM choros.role_assignment ra
        WHERE ra.tenant_id = $1
          AND ra.employee_id = (
                SELECT id FROM choros.employee
                 WHERE tenant_id = $1 AND slug = $2 LIMIT 1
              )
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)`,
      [tenantId, subjectId, nowMs],
    );

    if (raRows.length === 0) {
      await client.query("COMMIT");
      return [];
    }

    const roleIds = raRows.map((r) => r.role_id);

    // Load confirmed grants for all assigned roles.
    const { rows: grantRows } = await client.query<{
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
        WHERE tenant_id = $1
          AND role_id = ANY($2::uuid[])
          AND confirmed_by IS NOT NULL`,
      [tenantId, roleIds],
    );

    await client.query("COMMIT");

    return grantRows.map((g) => ({
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
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// DB-backed record source for explain (R-3: real record, not stub)
//
// For ref.kind === "record": fetch from choros.record (tenant-isolated via RLS).
// Returns null when the record does not exist — resolveFor will emit
// record_fetch ok:false with reason:"not_found" (AC-6 through HTTP path).
//
// For ref.kind ∈ {registry, application}: return a sentinel (non-null) so
// resolveFor reaches the masking step. Registry/application objects are not
// stored in choros.record; the grant-scope check is what matters for these
// resource types. The sentinel is NOT a lie — for registry/application refs,
// record existence is not the gating concern (grant→scope is).
// NOTE: resolveFor calls getRecord unconditionally for ALL ref kinds (step 5);
// the sentinel prevents a false not_found. The resulting record_fetch ok:true
// step in the trace is vacuous for non-record refs — annotated "n/a for
// non-record ref (sentinel)" by the response builder (R-3-resid / N-1).
// ---------------------------------------------------------------------------

async function fetchRecordForExplain(
  pool: pg.Pool,
  tenantId: string,
  ref: ResourceRef,
): Promise<Record<string, unknown> | null> {
  if (ref.kind !== "record") {
    // Registry and application resources are not rows in choros.record.
    // Return a non-null sentinel so resolveFor reaches the masking step.
    return { __explain_resource_sentinel__: true };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");

    const { rows } = await client.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM choros.record
        WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, ref.recordId],
    );

    await client.query("COMMIT");
    if (rows.length === 0) return null;
    return rows[0]!.data;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Request body parsing
// ---------------------------------------------------------------------------

interface ExplainBody {
  subject: { tenantId: string; subjectId: string };
  handle: {
    ref: ResourceRef;
    tenantId: string;
    facet?: { fields: string[] };
  };
  operation: Operation;
}

function parseRef(raw: unknown): ResourceRef {
  if (raw === null || typeof raw !== "object") {
    throw new HttpError(400, "VALIDATION", "handle.ref must be an object");
  }
  const r = raw as Record<string, unknown>;
  const kind = r["kind"];
  if (kind === "record") {
    if (typeof r["tenantId"] !== "string" || typeof r["registryId"] !== "string" || typeof r["recordId"] !== "string") {
      throw new HttpError(400, "VALIDATION", "handle.ref (record) requires tenantId, registryId, recordId");
    }
    return { kind: "record", tenantId: r["tenantId"] as string, registryId: r["registryId"] as string, recordId: r["recordId"] as string };
  }
  if (kind === "registry") {
    if (typeof r["tenantId"] !== "string" || typeof r["applicationId"] !== "string" || typeof r["registryId"] !== "string") {
      throw new HttpError(400, "VALIDATION", "handle.ref (registry) requires tenantId, applicationId, registryId");
    }
    return { kind: "registry", tenantId: r["tenantId"] as string, applicationId: r["applicationId"] as string, registryId: r["registryId"] as string };
  }
  if (kind === "application") {
    if (typeof r["tenantId"] !== "string" || typeof r["applicationId"] !== "string") {
      throw new HttpError(400, "VALIDATION", "handle.ref (application) requires tenantId, applicationId");
    }
    return { kind: "application", tenantId: r["tenantId"] as string, applicationId: r["applicationId"] as string };
  }
  throw new HttpError(400, "VALIDATION", "handle.ref.kind must be record | registry | application");
}

function parseExplainBody(body: unknown): ExplainBody {
  if (body === null || typeof body !== "object") {
    throw new HttpError(400, "VALIDATION", "request body must be an object");
  }
  const b = body as Record<string, unknown>;

  const subject = b["subject"];
  if (subject === null || typeof subject !== "object") {
    throw new HttpError(400, "VALIDATION", "subject is required");
  }
  const s = subject as Record<string, unknown>;
  if (typeof s["tenantId"] !== "string" || typeof s["subjectId"] !== "string") {
    throw new HttpError(400, "VALIDATION", "subject requires tenantId and subjectId");
  }

  const handleRaw = b["handle"];
  if (handleRaw === null || typeof handleRaw !== "object") {
    throw new HttpError(400, "VALIDATION", "handle is required");
  }
  const h = handleRaw as Record<string, unknown>;
  if (typeof h["tenantId"] !== "string") {
    throw new HttpError(400, "VALIDATION", "handle.tenantId is required");
  }
  const ref = parseRef(h["ref"]);

  let facet: { fields: string[] } | undefined;
  if (h["facet"] !== undefined && h["facet"] !== null) {
    const f = h["facet"] as Record<string, unknown>;
    if (!Array.isArray(f["fields"]) || !f["fields"].every((x) => typeof x === "string")) {
      throw new HttpError(400, "VALIDATION", "handle.facet.fields must be string[]");
    }
    facet = { fields: f["fields"] as string[] };
  }

  const operation = b["operation"];
  if (!ALL_VALID_OPS.includes(operation as Operation)) {
    throw new HttpError(400, "VALIDATION", `operation must be one of: ${ALL_VALID_OPS.join(", ")}`);
  }

  return {
    subject: { tenantId: s["tenantId"] as string, subjectId: s["subjectId"] as string },
    handle: { ref, tenantId: h["tenantId"] as string, facet },
    operation: operation as Operation,
  };
}

// ---------------------------------------------------------------------------
// extractCaller — read X-Dev-User (matches grants.ts pattern)
// ---------------------------------------------------------------------------

function extractCaller(req: IncomingMessage): string {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) return ctx.sub;
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// checkExplainAuthz — AC-9, AC-10 (self-query or admin with mgmt_object:grant)
// ---------------------------------------------------------------------------

async function checkExplainAuthz(
  pool: pg.Pool,
  caller: string,
  subjectId: string,
  tenantId: string,
  nowMs: number,
): Promise<"self" | "admin"> {
  // Self-query: caller is the subject.
  if (caller === subjectId) return "self";

  // Admin check: must hold confirmed, in-window, delegable mgmt_object:grant (read).
  const admin = await loadAdminContext(pool, tenantId, caller, nowMs);

  // Build a synthetic child grant representing the explain read operation
  // on mgmt_object:grant. We check whether the admin can read grants — that
  // is the authority required to inspect another principal's rights.
  const syntheticChild: Grant = {
    tenantId,
    id: "explain-check",
    roleId: "explain-check",
    resourceType: "mgmt_object:grant",
    operation: "read",
    scope: admin.adminOrgScope.kind === "set" && admin.adminOrgScope.members.length === 0
      ? { kind: "set", members: [] }
      : admin.adminOrgScope,
    delegable: false,
    grantedBy: caller,
    createdAt: nowMs,
  };

  const targetOrgScope: ScopeElement =
    admin.adminOrgScope.kind === "set" && admin.adminOrgScope.members.length === 0
      ? { kind: "set", members: [] }
      : admin.adminOrgScope;

  const gateResult = validateAdminDelegation(
    admin,
    { kind: "grant", childGrant: syntheticChild, targetOrgScope },
    SEED_ORACLE,
  );

  if (!gateResult.ok) {
    throw new HttpError(403, "EXPLAIN_FORBIDDEN", "caller lacks mgmt_object:grant authority to explain another subject");
  }

  return "admin";
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register POST /api/pdp/explain
 *
 * Registered unconditionally. Without DB pool: 503 NO_DATABASE (R-7).
 *
 * Supported operations (R-2): read, create, update, delete.
 * Operations invoke/approve/transition require EffectSource/SodSource that have
 * no production-backed implementation in explain context (T-0053 pending).
 * Those ops return 422 EXPLAIN_OP_UNSUPPORTED (honest scope declaration).
 */
export function registerPdpExplainRoutes(router: Router, pool: pg.Pool | null): void {
  router.register("POST", "/api/pdp/explain", withAuth(async (req, res) => {
    // R-7: 503 when no DB pool is available.
    if (pool === null) {
      throw new HttpError(503, "NO_DATABASE", "DATABASE_URL not set; explain requires live grant data");
    }

    const caller = extractCaller(req);
    const nowMs = Date.now();
    const tenantId = DEV_TENANT_ID;

    const rawBody = await readJsonBody(req);
    const explainReq = parseExplainBody(rawBody);

    // Tenant guard: all parties (caller's tenant, subject's tenant, handle's tenant)
    // must belong to the same tenant as the server's DEV_TENANT_ID.
    // Caller tenant is implicitly tenantId (server context).
    if (explainReq.subject.tenantId !== tenantId) {
      throw new HttpError(400, "VALIDATION", "subject.tenantId must match server tenant");
    }
    if (explainReq.handle.tenantId !== tenantId) {
      throw new HttpError(400, "VALIDATION", "handle.tenantId must match server tenant");
    }

    // R-2: reject unsupported operations with 422 EXPLAIN_OP_UNSUPPORTED.
    // invoke/approve/transition require EffectSource/SodSource; without them the
    // explain verdict would diverge from the real PDP verdict (AC-1 violation).
    // Honest scooping: declare the limitation rather than silently producing wrong verdicts.
    if (!(EXPLAIN_SUPPORTED_OPS as readonly string[]).includes(explainReq.operation)) {
      throw new HttpError(
        422,
        "EXPLAIN_OP_UNSUPPORTED",
        `operation '${explainReq.operation}' is not supported by explain: ` +
          `effect/SoD sources required for this op are not available in explain context (T-0053 pending). ` +
          `Supported: ${EXPLAIN_SUPPORTED_OPS.join(", ")}`,
      );
    }

    // Authz: self-query or admin check.
    const callerRole = await checkExplainAuthz(
      pool,
      caller,
      explainReq.subject.subjectId,
      tenantId,
      nowMs,
    );

    // Load subject's grants from DB.
    const subjectGrants = await loadSubjectGrants(
      pool,
      tenantId,
      explainReq.subject.subjectId,
      nowMs,
    );

    // Build the ObjectHandle.
    const handle: ObjectHandle = makeHandle(
      explainReq.handle.ref,
      explainReq.handle.tenantId,
      explainReq.handle.facet,
    );

    // Build the ResolveSubject.
    const resolveSubject: ResolveSubject = {
      tenantId: explainReq.subject.tenantId,
      subjectId: explainReq.subject.subjectId,
    };

    // Build in-memory GrantSource, RecordSource, AncestryOracle for explain.
    //
    // R-3: RecordSource is honest:
    //   - ref.kind === "record": real DB lookup; null → record_fetch ok:false (AC-6 through HTTP).
    //   - ref.kind ∈ {registry, application}: sentinel (non-null); resolveFor reaches masking.
    //     These resource types are not stored as rows in choros.record; existence is not
    //     the gating concern — grant→scope coverage is (ADR §3.3).
    const explainDeps: ResolverDeps = {
      grants: {
        getGrants: async (_subject, _nowMs) => subjectGrants,
      },
      records: {
        getRecord: async (ref) => fetchRecordForExplain(pool, tenantId, ref),
      },
      ancestry: SEED_ORACLE,
      // classifications, effects, sod, keyedDigest: NOT wired for explain.
      // effects/sod are absent → invoke/approve/transition are rejected above (R-2).
      // classifications: omitted → masking step governed=false (no data-class governance).
      now: () => nowMs,
    };

    // Collect trace steps.
    const traceSteps: TraceStep[] = [];
    const collector: TraceCollector = { push: (s) => { traceSteps.push(s); } };

    // Run resolveFor with trace — verdict guaranteed to match real resolver for
    // supported ops (grant→scope→record pipeline; no effect/SoD divergence possible
    // since those deps are absent and the guarded ops are rejected above).
    const result = await resolveFor(
      explainDeps,
      handle,
      resolveSubject,
      explainReq.operation,
      undefined, // invokeCtx
      undefined, // guardCtx
      collector,
    );

    const verdict = result.denied ? "deny" : "allow";
    const reason = result.denied ? result.reason : null;

    // Build response steps — apply anti-oracle filtering (AC-8) and vacuous markers.
    // For self-query: strip maskedFields from the masking step.
    // For non-record refs: record_fetch step is vacuous (resolveFor calls getRecord for
    // all ref kinds unconditionally; the sentinel guarantees ok:true — it is N/A as an
    // existence check for registry/application resources). Mark it explicitly so trace
    // consumers are not misled (R-3-resid nit N-1).
    const isNonRecordRef = explainReq.handle.ref.kind !== "record";
    const responseSteps = traceSteps.map((step) => {
      if (step.step === "masking" && callerRole === "self") {
        // Return only the governed flag — no field names (anti-oracle, invar-4).
        return { step: step.step, ok: step.ok, governed: step.governed };
      }
      if (step.step === "record_fetch" && isNonRecordRef) {
        // Vacuous step for registry/application refs: sentinel was returned, not a real
        // DB existence check. Annotate as N/A so trace consumers are not misled.
        return { ...step, note: "n/a for non-record ref (sentinel)" };
      }
      return step;
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ verdict, reason, steps: responseSteps }));
  }));
}
