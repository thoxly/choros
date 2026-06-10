/**
 * src/http/grant-trail.ts
 *
 * T-0031: HTTP route for the grant trail read API.
 *
 * Registers: GET /api/grant-trail
 *
 * DESIGN INVARIANTS (ADR §4.3):
 *  - Auth: X-Dev-User header for tenantId resolution (dev day-1; prod auth = T-0054).
 *  - Static fallback: when DATABASE_URL is absent, returns TRAIL seed data reformatted
 *    to GrantTrailRow shape (NF-8 / AC-18).
 *  - Validation: limit 1..500; before_seq must be integer if present.
 *  - HTTP error codes are machine-readable (NF-7): 400 INVALID_PARAM.
 */

import type { IncomingMessage } from "node:http";
import pg from "pg";
import { HttpError, type Router } from "./router.js";
import { queryGrantTrail, type GrantTrailRow } from "../db/audit-grant-trail.js";
import { getOrgPool, DEV_TENANT_ID } from "../db/org.js";

// ---------------------------------------------------------------------------
// Static seed — reformatted TRAIL from ra-data.jsx to GrantTrailRow shape.
// Used when DATABASE_URL is absent (NF-8 / AC-18).
// The ts field from ra-data.jsx is stored as a human-readable string;
// we convert it to epoch-ms for the GrantTrailRow.occurred_at field.
// ---------------------------------------------------------------------------

const TRAIL_SEED: GrantTrailRow[] = [
  {
    seq: 10,
    id: "grt-9f4a2c",
    type: "grant.create",
    actor: "М. Соколов",
    subject: "role-fin-approve-250",
    scope: { kind: "node", hierarchy: "org", nodeId: "fin", nodeLevel: "department" },
    proposed_by: "human",
    confirmed_by: "М. Соколов",
    payload: { resourceType: "record", operation: "exec", roleId: null },
    occurred_at: 1749383066318,
  },
  {
    seq: 9,
    id: "grt-9f49b1",
    type: "grant.create",
    actor: "М. Соколов",
    subject: "role-fin-approve-50",
    scope: { kind: "node", hierarchy: "org", nodeId: "fin-approve", nodeLevel: "department" },
    proposed_by: "llm",
    confirmed_by: "М. Соколов",
    payload: { resourceType: "registry", operation: "write" },
    occurred_at: 1749382724901,
  },
  {
    seq: 8,
    id: "grt-9f49b0",
    type: "grant.create",
    actor: "М. Соколов",
    subject: "role-fin-approve-50",
    scope: { kind: "node", hierarchy: "org", nodeId: "fin-approve", nodeLevel: "department" },
    proposed_by: "llm",
    confirmed_by: "М. Соколов",
    payload: { resourceType: "record", operation: "exec" },
    occurred_at: 1749382724901,
  },
  {
    seq: 7,
    id: "grt-9f3d77",
    type: "grant.revoke",
    actor: "А. Кравцова",
    subject: "role-cs-l2",
    scope: { kind: "interval", axis: "payment", lo: 0, hi: 30000 },
    proposed_by: "human",
    confirmed_by: "А. Кравцова",
    payload: { resourceType: "record", operation: "exec" },
    occurred_at: 1749375139044,
  },
  {
    seq: 6,
    id: "grt-9f2a10",
    type: "assignment.create",
    actor: "policy-sync",
    subject: "e-triage",
    scope: { kind: "node", hierarchy: "org", nodeId: "cs-l1", nodeLevel: "department" },
    proposed_by: "human",
    confirmed_by: "М. Соколов",
    payload: { roleId: "role-cs-l1" },
    occurred_at: 1749370502560,
  },
  {
    seq: 5,
    id: "grt-9e88c3",
    type: "grant.create",
    actor: "М. Соколов",
    subject: "role-cs-l1",
    scope: { kind: "node", hierarchy: "org", nodeId: "cs", nodeLevel: "department" },
    proposed_by: "llm",
    confirmed_by: "М. Соколов",
    payload: { resourceType: "record", operation: "write" },
    occurred_at: 1749320031222,
  },
  {
    seq: 4,
    id: "grt-9e71fa",
    type: "grant.create",
    actor: "А. Кравцова",
    subject: "role-fin-escrcv",
    scope: { kind: "node", hierarchy: "org", nodeId: "fin", nodeLevel: "department" },
    proposed_by: "human",
    confirmed_by: "А. Кравцова",
    payload: { resourceType: "record", operation: "write" },
    occurred_at: 1749312450119,
  },
  {
    seq: 3,
    id: "grt-9e6d05",
    type: "grant.create",
    actor: "М. Соколов",
    subject: "role-plat-ledger",
    scope: { kind: "node", hierarchy: "org", nodeId: "plat", nodeLevel: "department" },
    proposed_by: "human",
    confirmed_by: "М. Соколов",
    payload: { resourceType: "record", operation: "exec" },
    occurred_at: 1749295650005,
  },
  {
    seq: 2,
    id: "grt-9e2b88",
    type: "grant.create",
    actor: "Д. Гаврилов",
    subject: "role-fin-recon",
    scope: { kind: "node", hierarchy: "org", nodeId: "fin", nodeLevel: "department" },
    proposed_by: "llm",
    confirmed_by: "Д. Гаврилов",
    payload: { resourceType: "record", operation: "write" },
    occurred_at: 1749267108005,
  },
  {
    seq: 1,
    id: "grt-9d04f1",
    type: "grant.create",
    actor: "М. Соколов",
    subject: "role-cs-l2",
    scope: { kind: "node", hierarchy: "org", nodeId: "cs", nodeLevel: "department" },
    proposed_by: "human",
    confirmed_by: "М. Соколов",
    payload: { resourceType: "record", operation: "write" },
    occurred_at: 1749228913840,
  },
];

// ---------------------------------------------------------------------------
// extractQueryParams — parse and validate all query params from the request URL.
// Throws HttpError(400, "INVALID_PARAM") on invalid input (NF-7).
// ---------------------------------------------------------------------------

type ParsedGrantTrailParams = {
  roleId?: string;
  actor?: string;
  subject?: string;
  limit: number;
  beforeSeq?: number;
};

function extractQueryParams(req: IncomingMessage): ParsedGrantTrailParams {
  const rawUrl = req.url ?? "/";
  const questionIdx = rawUrl.indexOf("?");
  const query = questionIdx === -1 ? "" : rawUrl.slice(questionIdx + 1);
  const params = new URLSearchParams(query);

  const roleId = params.get("role_id") ?? undefined;
  const actor = params.get("actor") ?? undefined;
  const subject = params.get("subject") ?? undefined;

  // limit: default 100, max 500
  const limitRaw = params.get("limit");
  let limit = 100;
  if (limitRaw !== null && limitRaw !== "") {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1) {
      throw new HttpError(400, "INVALID_PARAM", "limit must be an integer 1–500");
    }
    if (n > 500) {
      throw new HttpError(400, "INVALID_PARAM", "limit must be an integer 1–500");
    }
    limit = n;
  }

  // before_seq: optional, must be non-negative integer if present
  const beforeSeqRaw = params.get("before_seq");
  let beforeSeq: number | undefined;
  if (beforeSeqRaw !== null && beforeSeqRaw !== "") {
    const n = Number(beforeSeqRaw);
    if (!Number.isInteger(n) || n < 0) {
      throw new HttpError(400, "INVALID_PARAM", "before_seq must be an integer");
    }
    beforeSeq = n;
  }

  return { roleId, actor, subject, limit, beforeSeq };
}

// ---------------------------------------------------------------------------
// registerGrantTrailRoutes — main export. Registers GET /api/grant-trail.
//
// The pool parameter is optional — when absent (or when DATABASE_URL is not
// set) the route returns the static TRAIL_SEED data (NF-8 / AC-18).
// ---------------------------------------------------------------------------

export function registerGrantTrailRoutes(router: Router, pool?: pg.Pool): void {
  router.register("GET", "/api/grant-trail", async (req, res) => {
    const parsed = extractQueryParams(req);

    let rows: GrantTrailRow[];
    let hasMore: boolean;

    const dbPool: pg.Pool | undefined = pool ?? (process.env["DATABASE_URL"] ? getOrgPool() : undefined);

    if (dbPool) {
      // Resolve tenantId from X-Dev-User header; fall back to DEV_TENANT_ID.
      // Day-1: all requests use the single dev tenant (T-0054 will add proper resolution).
      let tenantId = DEV_TENANT_ID;
      const devUser = req.headers["x-dev-user"];
      if (typeof devUser === "string" && devUser.length > 0) {
        // Day-1: tenantId is the DEV_TENANT_ID regardless of which user is acting.
        // The user identity is not a tenantId — leave tenantId as DEV_TENANT_ID.
        // (T-0054 will implement proper JWT-based tenant resolution.)
        tenantId = DEV_TENANT_ID;
      }

      const result = await queryGrantTrail(dbPool, tenantId, {
        roleId: parsed.roleId,
        actor: parsed.actor,
        subject: parsed.subject,
        limit: parsed.limit,
        beforeSeq: parsed.beforeSeq,
      });
      rows = result.rows;
      hasMore = result.hasMore;
    } else {
      // Static fallback — no DATABASE_URL (NF-8 / AC-18).
      let seedRows = TRAIL_SEED;

      // Apply client-side filters to seed data to honour AC-13 / AC-14 / AC-15.
      if (parsed.actor !== undefined) {
        seedRows = seedRows.filter((r) => r.actor === parsed.actor);
      }
      if (parsed.subject !== undefined) {
        seedRows = seedRows.filter((r) => r.subject === parsed.subject);
      }
      if (parsed.roleId !== undefined) {
        seedRows = seedRows.filter(
          (r) =>
            r.subject === parsed.roleId ||
            (r.payload !== null &&
              typeof r.payload === "object" &&
              (r.payload as Record<string, unknown>)["roleId"] === parsed.roleId),
        );
      }
      if (parsed.beforeSeq !== undefined) {
        seedRows = seedRows.filter((r) => r.seq < parsed.beforeSeq!);
      }

      // Limit + hasMore for seed data
      const limitedRows = seedRows.slice(0, parsed.limit + 1);
      hasMore = limitedRows.length > parsed.limit;
      rows = hasMore ? limitedRows.slice(0, parsed.limit) : limitedRows;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ rows, hasMore }));
  });
}
