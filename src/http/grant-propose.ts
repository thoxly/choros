/**
 * src/http/grant-propose.ts — T-0039 E3.5: LLM-proposes-grants / human-confirms
 *
 * Registers one ephemeral, read-only proposal route:
 *   POST /api/grants/propose
 *
 * Design invariants:
 *  - NEVER writes a grant row (FF-39-1).
 *  - Resolves tenant BYO proposal-agent from agent_card by slug 'proposal-agent'
 *    (env PROPOSAL_AGENT_SLUG); 503 NO_PROPOSAL_AGENT if absent (FR-7/AC-08).
 *  - Calls llm_endpoint via globalThis.fetch (no LLM SDK, no platform key — NF-1/FF-39-2).
 *  - Every returned atom sanitized through parseScopeElement; freeform/invalid dropped,
 *    never 500 (NF-2/NF-3/AC-06/AC-11).
 *  - Emits one informational grant.proposal_requested audit row via canonical sink (FR-9).
 *  - resolveSecret value NEVER in logs/response/audit (NF-4/FF-39-8).
 *  - Imports parseScopeElement from ./grants.js — ONE scope parser (FF-39-5).
 *  - Does NOT touch scoped-admin.ts (NF-6/FF-39-6).
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import pg from "pg";
import { parseScopeElement } from "./grants.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import type { ScopeElement } from "../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

/** Well-known slug for the BYO proposal-agent. Override with env PROPOSAL_AGENT_SLUG. */
const PROPOSAL_AGENT_SLUG =
  process.env["PROPOSAL_AGENT_SLUG"] ?? "proposal-agent";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Types (object model per ADR §7)
// ---------------------------------------------------------------------------

/** An ephemeral proposed grant atom (HTTP response only — never persisted). */
export interface ProposedGrantAtom {
  resource_type: string;
  operation: string;
  scope: ScopeElement;
  reason?: string;
}

/** Response envelope for POST /api/grants/propose (200). */
export interface GrantProposeResponse {
  proposal_agent_id: string;
  proposed: ProposedGrantAtom[];
}

/** What the BYO LLM is expected to return (sanitized after). */
export interface LlmProposeResponse {
  atoms: unknown[];
}

/** Request sent to the BYO LLM endpoint. */
export interface LlmProposeRequest {
  endpoint: string;
  model: string | null;
  secret: string;
  text: string;
  role_id: string;
  schema: unknown;
}

/**
 * Dependency-injection bag for testability and custody boundary (ADR §2.2).
 *
 *  - resolveSecret: RL-3 port (T-0025 owns real impl). Day-1: identity stub.
 *    The resolved value is NEVER logged or returned (NF-4/FF-39-8).
 *  - callLlm: default = globalThis.fetch to llm_endpoint. Injected for tests.
 *  - now: injectable clock for deterministic tests.
 */
export interface GrantProposeDeps {
  resolveSecret: (handle: string, ctx: { tenantId: string }) => Promise<string>;
  callLlm: (req: LlmProposeRequest) => Promise<LlmProposeResponse>;
  now: () => number;
  /**
   * T-0489 [SECURITY]: resolve the caller's slug → the tenant the caller ACTUALLY
   * belongs to (production binding = resolveActorTenant(getOrgPool(), slug), fail-
   * closed). When supplied (server.ts), the proposal runs under the actor's OWN
   * tenant — never the hardcoded Dev Silo. When omitted (unit tests with a stub
   * pool), the legacy DEV_TENANT_ID is used so dev-mode tests stay unchanged.
   */
  resolveActorTenant?: (actorSlug: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Default dep implementations (day-1 stubs / fetch)
// ---------------------------------------------------------------------------

/**
 * Day-1 resolveSecret stub: echoes the handle as-is.
 * GUARD: value NEVER logged or returned (NF-4/FF-39-8).
 * Real custody lands with T-0025 (RL-3 port replacement).
 */
async function defaultResolveSecret(
  handle: string,
  _ctx: { tenantId: string },
): Promise<string> {
  // NOTE: do NOT console.log this value (FF-39-8 guard).
  return handle;
}

/** JSON schema we ask the BYO LLM to produce (structured-output constraint). */
const GRANT_ATOM_SCHEMA = {
  type: "object",
  properties: {
    atoms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          resource_type: { type: "string" },
          operation: { type: "string" },
          scope: {
            type: "object",
            description: "ScopeElement: node|tags|interval|set (never freeform)",
          },
          reason: { type: "string" },
        },
        required: ["resource_type", "operation", "scope"],
      },
    },
  },
  required: ["atoms"],
};

/**
 * Default callLlm: plain globalThis.fetch POST to BYO endpoint.
 * No LLM SDK, no platform API key (NF-1/FF-39-2).
 * The secret is passed in Authorization header — NEVER logged (FF-39-8).
 */
async function defaultCallLlm(req: LlmProposeRequest): Promise<LlmProposeResponse> {
  const payload = {
    model: req.model ?? "default",
    messages: [
      {
        role: "system",
        content:
          "You are a RBAC grant proposal engine. Given a natural-language role description, " +
          "propose a minimal set of structural grants. Use ONLY these scope kinds: " +
          "node (hierarchy:resource|org, nodeId, nodeLevel), " +
          "tags (tags:[string]), interval (axis, lo, hi), set (members:[atom]). " +
          "Never use freeform scope.",
      },
      {
        role: "user",
        content: `Role description: ${req.text}\nRole ID: ${req.role_id}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "grant_atoms", schema: req.schema, strict: true },
    },
  };

  const response = await globalThis.fetch(req.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // secret goes into Authorization header — NEVER into logs/audit (FF-39-8)
      Authorization: `Bearer ${req.secret}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new HttpError(502, "LLM_CALL_FAILED", `BYO LLM responded ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  // Most LLM APIs wrap content in choices[0].message.content (OpenAI-compat)
  let atoms: unknown[] = [];
  const choices = data["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const firstChoice = choices[0] as Record<string, unknown>;
    const message = firstChoice["message"] as Record<string, unknown> | undefined;
    const content = message?.["content"];
    if (typeof content === "string") {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (Array.isArray(parsed["atoms"])) atoms = parsed["atoms"];
      } catch {
        atoms = [];
      }
    }
  } else if (Array.isArray(data["atoms"])) {
    // Direct {atoms:[...]} response (test stub compat)
    atoms = data["atoms"] as unknown[];
  }

  return { atoms };
}

/**
 * Default deps (day-1 stub resolveSecret + globalThis.fetch callLlm + Date.now clock).
 * Exported (T-0489) so the composition root can spread it and override ONLY
 * `resolveActorTenant` without re-implementing the LLM/secret defaults.
 * `resolveActorTenant` is left undefined here so this module stays DB-free by default.
 */
export const defaultGrantProposeDeps: GrantProposeDeps = {
  resolveSecret: defaultResolveSecret,
  callLlm: defaultCallLlm,
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// Audit sink
// ---------------------------------------------------------------------------

const proposeAuditWriter = makePgAuditWriter();

async function appendProposalAudit(
  client: pg.PoolClient,
  input: AuditEventInput,
): Promise<void> {
  await proposeAuditWriter.appendAuditEvent(client as unknown as PgClientLike, input);
}

// ---------------------------------------------------------------------------
// withTenantTx helper (mirrors grants.ts — grant-propose owns its own copy
// so grants.ts is not modified for the new network-egress code path).
// ---------------------------------------------------------------------------

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// extractActor — mode-aware caller identity (T-0489 / T-0372 pattern).
//
// keycloak mode: getAuthContext is populated (withAuth ran first); the JWT `sub`
//   is the KC user UUID, NOT the employee slug, so resolve it via
//   resolveActorSlugFromAuth (kind='human' only; sub-first, preferred_username
//   fallback). null ⇒ fail closed (401) — never trust the raw sub.
// dev mode: getAuthContext is undefined; read the x-dev-user header as before.
//
// Before T-0489 this route read x-dev-user as the SOLE identity even in keycloak
// mode (FF-0328-2 bug class); it now consults getAuthContext first.
// ---------------------------------------------------------------------------

async function extractActor(req: IncomingMessage, pool: pg.Pool): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

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
// Route registration (ADR §2.1)
// ---------------------------------------------------------------------------

/**
 * Register POST /api/grants/propose (T-0039).
 *
 * The route is distinct from existing routes:
 *   POST /api/grants         — root, no segment
 *   POST /api/grants/:id/revoke — :id segment
 *   POST /api/grants/propose — FIXED literal segment, never captured by :id
 *
 * @param router  - The Router instance (from src/http/router.ts)
 * @param pool    - Postgres pool (DATABASE_URL-backed)
 * @param deps    - Injected deps (defaults to stub/fetch; override in tests)
 */
export function registerGrantProposeRoute(
  router: Router,
  pool: pg.Pool,
  deps: GrantProposeDeps = defaultGrantProposeDeps,
): void {
  // withAuth: keycloak mode REQUIRES a valid Bearer JWT (401 otherwise; no x-dev-user
  // bypass); dev mode is a no-op pass-through and the x-dev-user path is unchanged.
  router.register("POST", "/api/grants/propose", withAuth(async (req, res) => {
    // T-0489: identity is mode-aware (getAuthContext first; x-dev-user only as the
    // dev fallback) — no longer reads x-dev-user as the sole identity in keycloak mode.
    const actorId = await extractActor(req, pool);

    // T-0489 [SECURITY]: the proposal runs under the actor's OWN tenant (resolved
    // from identity, fail-closed) when a resolver is wired — never a request-supplied
    // tenant or the hardcoded Dev Silo. Unit tests omit the resolver → DEV_TENANT_ID.
    const tenantId = deps.resolveActorTenant
      ? await deps.resolveActorTenant(actorId)
      : DEV_TENANT_ID;
    const nowMs = deps.now();

    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    // Validate required fields.
    const text = b["text"];
    if (typeof text !== "string" || text.trim() === "") {
      throw new HttpError(400, "VALIDATION", "text is required");
    }

    const roleId = b["role_id"];
    if (typeof roleId !== "string") {
      throw new HttpError(400, "VALIDATION", "role_id is required");
    }
    assertUuidShape(roleId, "role_id");

    // Perform proposal inside a tenant-scoped transaction (FR-8/AC-12).
    const result = await withTenantTx(pool, tenantId, async (client) => {
      // ------------------------------------------------------------------
      // §2.4 — Resolve proposal-agent from agent_card JOIN employee by slug.
      // The query is RLS-isolated: only sees the current tenant's rows (FR-8).
      // ------------------------------------------------------------------
      const { rows: agentRows } = await client.query<{
        employee_id: string;
        llm_endpoint: string;
        llm_secret_handle: string | null;
        llm_model: string | null;
      }>(
        `SELECT ac.employee_id, ac.llm_endpoint, ac.llm_secret_handle, ac.llm_model
           FROM choros.agent_card ac
           JOIN choros.employee e
                ON e.tenant_id = ac.tenant_id AND e.id = ac.employee_id
          WHERE ac.tenant_id = $1
            AND e.slug = $2
            AND ac.llm_endpoint IS NOT NULL
          LIMIT 1`,
        [tenantId, PROPOSAL_AGENT_SLUG],
      );

      if (agentRows.length === 0) {
        // No BYO agent configured — 503, no platform fallback (FR-7/AC-08).
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: { code: "NO_PROPOSAL_AGENT" } }));
        // Signal that we've already responded — use a sentinel throw below.
        throw Object.assign(new Error("NO_PROPOSAL_AGENT"), { _handled: true });
      }

      const agent = agentRows[0];
      const proposalAgentId = agent.employee_id;

      // ------------------------------------------------------------------
      // §2.5 — Resolve secret (RL-3 port) + call BYO LLM.
      // The resolved credential is NEVER logged or returned (NF-4/FF-39-8).
      // ------------------------------------------------------------------
      const handle = agent.llm_secret_handle ?? "";
      // NOTE: secret is kept in a local const — not spread into any log call.
      const secret = await deps.resolveSecret(handle, { tenantId });

      let rawAtoms: unknown[] = [];
      try {
        const llmResp = await deps.callLlm({
          endpoint: agent.llm_endpoint,
          model: agent.llm_model,
          secret, // passed through, never logged (FF-39-8)
          text: text.trim(),
          role_id: roleId,
          schema: GRANT_ATOM_SCHEMA,
        });
        rawAtoms = llmResp.atoms;
      } catch (err) {
        // A handled error (NO_PROPOSAL_AGENT sentinel) is re-thrown as-is.
        if ((err as { _handled?: boolean })._handled) throw err;
        // LLM call errors are HTTP 502 (bad gateway).
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, "LLM_CALL_FAILED", String((err as Error).message ?? err));
      }

      // ------------------------------------------------------------------
      // §2.5 step 3 — Sanitize atoms through parseScopeElement.
      // - null (invalid OR freeform) → atom dropped (NF-2/NF-3/AC-06/AC-11).
      // - resource_type / operation are carried through as strings.
      // ------------------------------------------------------------------
      const proposed: ProposedGrantAtom[] = [];
      for (const raw of rawAtoms) {
        if (raw === null || typeof raw !== "object") continue;
        const a = raw as Record<string, unknown>;
        const resourceType = a["resource_type"];
        const operation = a["operation"];
        if (typeof resourceType !== "string" || typeof operation !== "string") continue;

        const scope = parseScopeElement(a["scope"]);
        if (scope === null) continue; // freeform or invalid → dropped (never 500)

        const atom: ProposedGrantAtom = { resource_type: resourceType, operation, scope };
        if (typeof a["reason"] === "string") atom.reason = a["reason"];
        proposed.push(atom);
      }

      // ------------------------------------------------------------------
      // §2.6 — Audit: one informational grant.proposal_requested row.
      // Credential NEVER in payload (AC-13/FF-39-8).
      // Emitted whether or not the admin later confirms (FR-9/AC-09).
      // ------------------------------------------------------------------
      const auditInput: AuditEventInput = {
        id: randomUUID(),
        type: "grant.proposal_requested",
        actor: actorId,
        subject: roleId,
        scope: null,
        via: "grant-propose",
        proposed_by: null,
        confirmed_by: null,
        // payload fields: proposalAgentId, proposedCount, model only (AC-13)
        payload: {
          proposalAgentId,
          proposedCount: proposed.length,
          model: agent.llm_model,
        },
        occurred_at: nowMs,
      };
      await appendProposalAudit(client, auditInput);

      return { proposalAgentId, proposed };
    }).catch((err: unknown) => {
      if ((err as { _handled?: boolean })._handled) return null; // already responded
      throw err;
    });

    // null means we already sent a 503 response above.
    if (result === null) return;

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        proposal_agent_id: result.proposalAgentId,
        proposed: result.proposed,
      } satisfies GrantProposeResponse),
    );
  }));
}
