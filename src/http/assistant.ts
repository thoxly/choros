/**
 * src/http/assistant.ts — T-0359 (E17): AI-assistant API routes.
 *
 * registerAssistantRoutes(router, { pool, resolveActorTenant, llmPortFactory })
 *
 * Routes:
 *   GET    /api/assistant/threads
 *   POST   /api/assistant/threads
 *   GET    /api/assistant/threads/:id/messages
 *   POST   /api/assistant/threads/:id/messages  ← LLM dispatch entry
 *   GET    /api/assistant/threads/:id/budget
 *
 * THREAD/MESSAGE PERSISTENCE: NO NEW TABLE (founder constraint).
 * Threads and messages are persisted as audit_event rows:
 *   type: "assistant.thread"  — one row per thread (on creation)
 *   type: "assistant.message" — one row per user turn + one per assistant reply
 * Reconstruction (GET) is done by querying audit_event for these types.
 *
 * SECURITY INVARIANTS:
 *   1. Grants intersection: resolveFor uses makeIntersectionGrantSource so the
 *      agent can NEVER read/write more than the user.
 *   2. Tenant/RLS: resolveActorTenant + withTenantTx; cross-tenant → 403.
 *   3. Audit: every message (user + assistant) → appendAuditEvent in the tx.
 *   4. Dormant LLM: llmPortFactory returns dormantLlmPort when unconfigured →
 *      route returns 503 LLM_NOT_CONFIGURED instead of crashing.
 *   5. No secrets in core: this file imports from src/adapters only for the
 *      factory type; the raw key never appears here.
 *
 * INTENT-DISPATCH SEAM:
 *   This file calls intentDispatch() from src/core/assistant-intent.ts.
 *   Wave 2 tasks (T-0360 analyst, T-0361 configurator) edit ONLY their own
 *   core modules — this file is NEVER touched by them.
 */

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError, type Router, readJsonBody } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { makeDbGrantSource } from "../db/grants-dao.js";
import { makeIntersectionGrantSource } from "../core/agent-on-behalf.js";
import { makePgAuditWriter } from "../db/audit-writer.js";
import {
  intentDispatch,
  classifyIntent,
  type HandlerContext,
} from "../core/assistant-intent.js";
import { LlmDormantError, type LlmPort } from "../core/llm-port.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import type { AncestryOracle } from "../core/grant-lattice.js";
import type { ResolveSubject } from "../core/object-handle.js";
// T-0363 (d): import runConfigurator to execute approvedOps as DRAFT.
import { runConfigurator, type ApprovedOp } from "../core/assistant-configurator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

/** Factory that returns the LLM port for a given tenant (or dormantLlmPort). */
export type LlmPortFactory = (tenantId: string) => LlmPort;

export interface AssistantRouteDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
  /** Factory that returns the correct LlmPort (or dormantLlmPort) per tenant. */
  llmPortFactory: LlmPortFactory;
  /**
   * The "assistant agent" slug used as the agent actor for grant intersection.
   * Defaults to "assistant-agent" — the agent employee slug seeded in migration.
   */
  agentSlug?: string;
  /**
   * Injected AncestryOracle (defaults to a flat oracle that only allows exact
   * node equality — conservative, fail-closed until full oracle is wired).
   */
  ancestry?: AncestryOracle;
}

// ---------------------------------------------------------------------------
// UUID guard
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// withTenantTx — mirrors the pattern from agents-list.ts / records.ts
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
// extractActorSlug — mode-aware, resolves the authenticated request → the
// correct employee SLUG (T-0371).
//
// THE BUG (proven live, s39): the previous extractActor returned the raw JWT
// `sub` in keycloak mode. But `sub` is the Keycloak user UUID, while grant and
// tenant resolution downstream are keyed on employee.slug. Self-registered users
// satisfy slug == sub (T-0342) so they resolved; SEEDED personas (e-orlov,
// e-larina, e-configurator…) have human-readable slugs whose KC sub is a random
// UUID → employee WHERE slug=<UUID> missed → getGrantsForSubject returned [] →
// every grant-gated path fail-closed (e.g. e-configurator getting "недостаточно
// прав, требуется грант authoring_draft" despite holding that grant via 088).
//
// FIX (T-0366 identity pattern, applied at the ROUTE seam for this task only):
//   keycloak mode → resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername):
//     sub-first (registered user, slug == sub) → preferred_username fallback
//     (seeded persona) → fail-closed (null → 401). See the security analysis on
//     resolveActorSlugFromAuth in src/db/org.ts: the fallback cannot be abused to
//     impersonate a seeded persona because (a) the sub lookup is always tried
//     first and short-circuits for registered users, and (b) Keycloak enforces
//     username uniqueness per realm, so the seeded personas' usernames cannot be
//     claimed by a second user.
//   dev mode → the x-dev-user header value IS the slug (unchanged).
//
// FOLLOW-UP (do NOT fix here — see handoff): src/http/forms.ts, records write,
// and applications have the SAME latent bug (they key tenant/grant resolution on
// the raw sub via their own extractActor). They should adopt resolveActorSlugFromAuth
// in a follow-up task; this change is scoped to the assistant route to bound review.
// ---------------------------------------------------------------------------

async function extractActorSlug(
  req: IncomingMessage,
  pool: pg.Pool,
): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    // keycloak mode: ctx.sub is the KC user UUID, NOT the employee slug.
    // Resolve it to the real slug (sub-first, preferred_username-fallback).
    const slug = await resolveActorSlugFromAuth(
      pool,
      ctx.sub,
      ctx.preferredUsername,
    );
    if (slug === null) {
      // No employee matches sub or preferred_username → fail-closed.
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
  // dev mode: the x-dev-user header value IS the slug.
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// Flat AncestryOracle (conservative default — node equality only).
// This is fail-closed: a broader-scoped user grant cannot cover a narrower
// agent scope unless the scope IDs match exactly.
// Production wiring: the real oracle is injected via deps.ancestry.
// ---------------------------------------------------------------------------

const flatOracle: AncestryOracle = {
  isDescendantOrSelf(
    _hierarchy: string,
    descendantId: string,
    ancestorId: string,
  ): boolean {
    // Conservative: only exact identity (no hierarchy traversal).
    return descendantId === ancestorId;
  },
};

// ---------------------------------------------------------------------------
// Audit writer (singleton per module load — no IO at module init time)
// ---------------------------------------------------------------------------

const auditWriter = makePgAuditWriter();

// ---------------------------------------------------------------------------
// T-0363 (d): Draft execution of configurator approvedOps.
//
// Executes each ApprovedOp as DRAFT using the same DB paths the visual
// constructor uses (co-equal invariant). Called after runConfigurator() returns.
//
// SECURITY:
//  - Only ApprovedOps (tier='draft', non-destructive) are executed.
//  - Destructive ops never reach here — they land in blockedOps in the core.
//  - Each op is wrapped in withTenantTx so tenant isolation is preserved.
//  - Errors per-op are logged to console.error (non-fatal) — partial success
//    is reported in the text rather than crashing the whole message.
// ---------------------------------------------------------------------------

/** Execute a single ApprovedOp as a DRAFT DB write. Returns null on success, error message on failure. */
async function executeApprovedOpAsDraft(
  pool: pg.Pool,
  tenantId: string,
  op: ApprovedOp,
): Promise<string | null> {
  try {
    const nowMs = Date.now();

    switch (op.kind) {
      // -----------------------------------------------------------------------
      // author_binding — upsert process_app_binding DRAFT row.
      // Same SQL as process-catalog.ts POST /api/process-catalog/:key/binding.
      // -----------------------------------------------------------------------
      case "author_binding": {
        const args = op.args;
        const processKey   = typeof args["processKey"]   === "string" ? args["processKey"]   : null;
        const applicationId = typeof args["applicationId"] === "string" ? args["applicationId"] : null;
        const triggerType   = typeof args["triggerType"]  === "string" ? args["triggerType"]  : "launcher";
        const startFormKey  = typeof args["startFormKey"] === "string" ? args["startFormKey"] : null;
        const fieldMapping  = typeof args["fieldMapping"] === "string"
          ? (() => { try { return JSON.parse(args["fieldMapping"] as string); } catch { return {}; } })()
          : {};

        if (!processKey || !applicationId) {
          return `author_binding: missing processKey or applicationId`;
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await client.query("SET LOCAL search_path TO choros");
          await client.query(
            `INSERT INTO choros.process_app_binding
               (tenant_id, id, process_key, application_id, form_key,
                trigger_type, start_form_key, field_mapping,
                created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9)
             ON CONFLICT (tenant_id, process_key, application_id)
             DO UPDATE SET
               trigger_type   = EXCLUDED.trigger_type,
               start_form_key = EXCLUDED.start_form_key,
               field_mapping  = EXCLUDED.field_mapping,
               updated_at     = EXCLUDED.updated_at`,
            [tenantId, randomUUID(), processKey, applicationId, startFormKey,
             triggerType, startFormKey, JSON.stringify(fieldMapping), nowMs],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
        return null;
      }

      // -----------------------------------------------------------------------
      // edit_jsonschema_non_destructive — merge field into registry_def.record_schema.
      // Only additive ops reach here (redline guard runs in core).
      // Same table as registry-defs.ts PUT /api/registry-defs/:id.
      // -----------------------------------------------------------------------
      case "edit_jsonschema_non_destructive": {
        const args = op.args;
        const registryDefId = typeof args["registryDefId"] === "string" ? args["registryDefId"] : null;
        const fieldKey      = typeof args["fieldKey"]       === "string" ? args["fieldKey"]       : null;
        const fieldSchemaRaw = typeof args["fieldSchema"]   === "string" ? args["fieldSchema"]    : null;
        const opKind        = typeof args["opKind"]         === "string" ? args["opKind"]         : null;

        if (!registryDefId || !fieldKey) {
          return `edit_jsonschema_non_destructive: missing registryDefId or fieldKey`;
        }

        let fieldSchema: Record<string, unknown> = { type: "string" };
        if (fieldSchemaRaw) {
          try { fieldSchema = JSON.parse(fieldSchemaRaw) as Record<string, unknown>; } catch { /* use default */ }
        }

        // Only add_field / relabel / toggle_required / enum_change non-destructive ops.
        // drop_field / rename_field / change_type are already blocked in core — safety check.
        if (opKind === "drop_field" || opKind === "rename_field") {
          return `edit_jsonschema_non_destructive: refusing to execute destructive op '${opKind}' — should have been blocked`;
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await client.query("SET LOCAL search_path TO choros");

          // Merge the field into the existing record_schema using jsonb path operations.
          // For add_field: set properties[fieldKey] = fieldSchema (additive only).
          await client.query(
            `UPDATE choros.registry_def
                SET record_schema = jsonb_set(
                  COALESCE(record_schema, '{}'::jsonb),
                  ARRAY['properties', $2],
                  $3::jsonb,
                  true
                ),
                updated_at = $4
              WHERE tenant_id = $1 AND id = $5`,
            [tenantId, fieldKey, JSON.stringify(fieldSchema), nowMs, registryDefId],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
        return null;
      }

      // -----------------------------------------------------------------------
      // emit_form — store form schema as a process_definition draft (form XML is
      // serialized as JSON in bpmn_xml column until a dedicated form_def table lands).
      // Note: this uses the process_definition table as the nearest available DRAFT
      // store for form authoring artifacts in the current schema.
      // -----------------------------------------------------------------------
      case "emit_form": {
        const args = op.args;
        const formKey      = typeof args["formKey"]      === "string" ? args["formKey"]      : null;
        const applicationId = typeof args["applicationId"] === "string" ? args["applicationId"] : null;
        const formSchema   = typeof args["formSchema"]   === "string" ? args["formSchema"]   : "{}";

        if (!formKey) {
          return `emit_form: missing formKey`;
        }

        // Use a synthetic process_key that namespaces forms (choros:form:<key>)
        // so they are distinguishable from real process definitions.
        const syntheticProcessKey = `choros:form:${formKey}`;
        const syntheticName = `[DRAFT FORM] ${formKey}${applicationId ? ` (app ${applicationId})` : ""}`;

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await client.query("SET LOCAL search_path TO choros");
          await client.query(
            `INSERT INTO choros.process_definition
               (tenant_id, id, process_key, name, bpmn_xml, version, status, deployment_id,
                created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 1, 'draft', NULL, $6, $6)
             ON CONFLICT (tenant_id, process_key, version) DO UPDATE
               SET bpmn_xml   = EXCLUDED.bpmn_xml,
                   name       = EXCLUDED.name,
                   updated_at = EXCLUDED.updated_at`,
            [tenantId, randomUUID(), syntheticProcessKey, syntheticName, formSchema, nowMs],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
        return null;
      }

      // -----------------------------------------------------------------------
      // author_dmn — store DMN XML as a process_definition DRAFT row.
      // Same table + 'draft' status as process-defs POST /api/process-defs.
      // -----------------------------------------------------------------------
      case "author_dmn": {
        const args = op.args;
        const processKey = typeof args["processKey"] === "string" ? args["processKey"] : null;
        const dmnKey     = typeof args["dmnKey"]     === "string" ? args["dmnKey"]     : null;
        const dmnXml     = typeof args["dmnXml"]     === "string" ? args["dmnXml"]     : "";

        if (!processKey || !dmnKey) {
          return `author_dmn: missing processKey or dmnKey`;
        }

        const syntheticKey = `${processKey}:dmn:${dmnKey}`;
        const syntheticName = `[DRAFT DMN] ${dmnKey} (process: ${processKey})`;

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await client.query("SET LOCAL search_path TO choros");
          await client.query(
            `INSERT INTO choros.process_definition
               (tenant_id, id, process_key, name, bpmn_xml, version, status, deployment_id,
                created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 1, 'draft', NULL, $6, $6)
             ON CONFLICT (tenant_id, process_key, version) DO UPDATE
               SET bpmn_xml   = EXCLUDED.bpmn_xml,
                   name       = EXCLUDED.name,
                   updated_at = EXCLUDED.updated_at`,
            [tenantId, randomUUID(), syntheticKey, syntheticName, dmnXml, nowMs],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
        return null;
      }

      default:
        // Unknown op kind — log and skip (fail-open on unknown ops is safer than crashing).
        return `unknown op kind: ${String((op as ApprovedOp).kind)}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `op ${op.kind} failed: ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers: thread + message shapes reconstructed from audit_event rows
// ---------------------------------------------------------------------------

interface ThreadPayload {
  title: string;
  context_ref: unknown | null;
  user_subject: string;
  agent_subject: string;
}

interface MessagePayload {
  thread_id: string;
  role: "user" | "assistant";
  text: string;
  context_ref: unknown | null;
  intent?: string;
  streaming_done?: boolean;
}

interface ThreadRow {
  id: string;
  title: string;
  created_at: string;
  context_ref: unknown | null;
  message_count: number;
}

interface MessageRow {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: string;
  context_ref: unknown | null;
  intent?: string;
}

// ---------------------------------------------------------------------------
// DB helpers — reconstruct threads/messages from audit_event
// ---------------------------------------------------------------------------

async function fetchThreads(
  client: pg.PoolClient,
  userSubject: string,
): Promise<ThreadRow[]> {
  // Fetch all "assistant.thread" audit events for this user in this tenant.
  const { rows } = await client.query<{
    id: string;
    occurred_at: string;
    payload: unknown;
  }>(
    `SELECT id, occurred_at, payload
       FROM choros.audit_event
      WHERE type = 'assistant.thread'
        AND subject = $1
      ORDER BY occurred_at ASC`,
    [userSubject],
  );

  // Count messages per thread.
  const threadIds = rows.map((r) => r.id);
  if (threadIds.length === 0) return [];

  const { rows: msgCountRows } = await client.query<{
    thread_id: string;
    cnt: string;
  }>(
    `SELECT
       payload->>'thread_id' AS thread_id,
       COUNT(*) AS cnt
       FROM choros.audit_event
      WHERE type = 'assistant.message'
        AND payload->>'thread_id' = ANY($1::text[])
        AND subject = $2
      GROUP BY payload->>'thread_id'`,
    [threadIds, userSubject],
  );
  const countMap = new Map<string, number>();
  for (const r of msgCountRows) {
    countMap.set(r.thread_id, Number(r.cnt));
  }

  return rows.map((r) => {
    const p = r.payload as ThreadPayload;
    return {
      id: r.id,
      title: p.title ?? "Разговор",
      created_at: new Date(Number(r.occurred_at)).toISOString(),
      context_ref: p.context_ref ?? null,
      message_count: countMap.get(r.id) ?? 0,
    };
  });
}

async function fetchThread(
  client: pg.PoolClient,
  threadId: string,
  userSubject: string,
): Promise<ThreadRow | null> {
  assertUuidShape(threadId, "threadId");
  const { rows } = await client.query<{
    id: string;
    occurred_at: string;
    payload: unknown;
    subject: string;
  }>(
    `SELECT id, occurred_at, payload, subject
       FROM choros.audit_event
      WHERE type = 'assistant.thread'
        AND id = $1`,
    [threadId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  // Tenant + ownership check: the thread subject must match the requesting user.
  if (row.subject !== userSubject) return null;
  const p = row.payload as ThreadPayload;
  return {
    id: row.id,
    title: p.title ?? "Разговор",
    created_at: new Date(Number(row.occurred_at)).toISOString(),
    context_ref: p.context_ref ?? null,
    message_count: 0, // caller fills if needed
  };
}

async function fetchMessages(
  client: pg.PoolClient,
  threadId: string,
  userSubject: string,
): Promise<MessageRow[]> {
  assertUuidShape(threadId, "threadId");
  const { rows } = await client.query<{
    id: string;
    occurred_at: string;
    payload: unknown;
    subject: string;
  }>(
    `SELECT id, occurred_at, payload, subject
       FROM choros.audit_event
      WHERE type = 'assistant.message'
        AND payload->>'thread_id' = $1
        AND subject = $2
      ORDER BY occurred_at ASC`,
    [threadId, userSubject],
  );
  return rows.map((r) => {
    const p = r.payload as MessagePayload;
    return {
      id: r.id,
      role: p.role,
      text: p.text,
      ts: new Date(Number(r.occurred_at)).toISOString(),
      context_ref: p.context_ref ?? null,
      intent: p.intent,
    };
  });
}

async function fetchBudget(
  client: pg.PoolClient,
  tenantId: string,
  agentSlug: string,
): Promise<{
  tokens_used: number;
  tokens_limit: number;
  cost_usd: number;
  cost_limit_usd: number;
}> {
  // Look up the agent employee ID.
  const { rows: empRows } = await client.query<{ id: string }>(
    `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
    [tenantId, agentSlug],
  );
  if (empRows.length === 0) {
    // Agent not seeded — return zeroes (honest-degrade).
    return { tokens_used: 0, tokens_limit: 100_000, cost_usd: 0, cost_limit_usd: 1.0 };
  }
  const agentId = empRows[0].id;

  // FF-BUD-10 (T-0023): budget tracking is DORMANT day-1 — no runtime read of the
  // dormant budget ledger tables. Spend reports 0 until the budget subsystem is
  // activated. (The ceiling below reads agent_budget, which is not dormancy-gated.)
  const costUsed = 0;

  // Read the agent_budget ceiling (take the first 'total' window if present).
  const { rows: budgetRows } = await client.query<{
    ceiling: string;
    remaining_cache: string;
  }>(
    `SELECT ceiling, remaining_cache
       FROM choros.agent_budget
      WHERE tenant_id = $1 AND employee_id = $2 AND window_kind = 'total'
      LIMIT 1`,
    [tenantId, agentId],
  );
  const costLimit = budgetRows.length > 0 ? Number(budgetRows[0].ceiling) : 1.0;

  // Token approximation: 1 USD ≈ 100_000 tokens (rough — operator adjusts via budget).
  const tokenRate = 100_000;
  return {
    tokens_used: Math.round(costUsed * tokenRate),
    tokens_limit: Math.round(costLimit * tokenRate),
    cost_usd: costUsed,
    cost_limit_usd: costLimit,
  };
}

// ---------------------------------------------------------------------------
// registerAssistantRoutes — main export
// ---------------------------------------------------------------------------

export function registerAssistantRoutes(
  router: Router,
  deps: AssistantRouteDeps,
): void {
  const { pool, resolveActorTenant, llmPortFactory } = deps;
  const agentSlug = deps.agentSlug ?? "assistant-agent";
  const ancestry = deps.ancestry ?? flatOracle;

  // =========================================================================
  // GET /api/assistant/threads — list threads for the actor
  // =========================================================================
  router.register(
    "GET",
    "/api/assistant/threads",
    withAuth(async (req, res) => {
      const actorSlug = await extractActorSlug(req, pool);
      const tenantId = await resolveActorTenant(actorSlug);

      const threads = await withTenantTx(pool, tenantId, async (client) => {
        return fetchThreads(client, actorSlug);
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ threads }));
    }),
  );

  // =========================================================================
  // POST /api/assistant/threads — create a new thread
  // =========================================================================
  router.register(
    "POST",
    "/api/assistant/threads",
    withAuth(async (req, res) => {
      const actorSlug = await extractActorSlug(req, pool);
      const tenantId = await resolveActorTenant(actorSlug);

      const body = (await readJsonBody(req)) as {
        title?: string;
        context_ref?: unknown;
      };
      const title = String(body.title ?? "Новый разговор").slice(0, 256);
      const contextRef = body.context_ref ?? null;
      const threadId = randomUUID();
      const now = Date.now();

      await withTenantTx(pool, tenantId, async (client) => {
        // Persist thread as audit_event row (no new table — doctrine-faithful).
        const payload: ThreadPayload = {
          title,
          context_ref: contextRef,
          user_subject: actorSlug,
          agent_subject: agentSlug,
        };
        await auditWriter.appendAuditEvent(client, {
          id: threadId,
          type: "assistant.thread",
          actor: agentSlug,
          subject: actorSlug,
          scope: null,
          via: null,
          proposed_by: null,
          confirmed_by: null,
          payload,
          occurred_at: now,
        });
      });

      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: threadId,
          title,
          created_at: new Date(now).toISOString(),
          message_count: 0,
          context_ref: contextRef,
        }),
      );
    }),
  );

  // =========================================================================
  // GET /api/assistant/threads/:id/messages — list messages in a thread
  // =========================================================================
  router.register(
    "GET",
    "/api/assistant/threads/:id/messages",
    withAuth(async (req, res, params) => {
      const threadId = params["id"] ?? "";
      if (!threadId) throw new HttpError(400, "VALIDATION", "thread id required");

      const actorSlug = await extractActorSlug(req, pool);
      const tenantId = await resolveActorTenant(actorSlug);

      const messages = await withTenantTx(pool, tenantId, async (client) => {
        const thread = await fetchThread(client, threadId, actorSlug);
        if (!thread) throw new HttpError(404, "NOT_FOUND", "thread not found");
        return fetchMessages(client, threadId, actorSlug);
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ messages }));
    }),
  );

  // =========================================================================
  // POST /api/assistant/threads/:id/messages — send a message (LLM dispatch)
  // =========================================================================
  router.register(
    "POST",
    "/api/assistant/threads/:id/messages",
    withAuth(async (req, res, params) => {
      const threadId = params["id"] ?? "";
      if (!threadId) throw new HttpError(400, "VALIDATION", "thread id required");

      const actorSlug = await extractActorSlug(req, pool);
      const tenantId = await resolveActorTenant(actorSlug);

      const body = (await readJsonBody(req)) as {
        text?: string;
        context_ref?: unknown;
      };
      const userText = String(body.text ?? "").trim();
      if (!userText) {
        throw new HttpError(400, "VALIDATION", "text is required");
      }
      const contextRef = body.context_ref ?? null;

      // -----------------------------------------------------------------------
      // 1. Verify thread ownership (inside tenant tx).
      // -----------------------------------------------------------------------
      await withTenantTx(pool, tenantId, async (client) => {
        const thread = await fetchThread(client, threadId, actorSlug);
        if (!thread) throw new HttpError(404, "NOT_FOUND", "thread not found");
      });

      // -----------------------------------------------------------------------
      // 2. Resolve the LLM port.
      // -----------------------------------------------------------------------
      const llm = llmPortFactory(tenantId);

      // -----------------------------------------------------------------------
      // 3. Persist the user message (outside LLM call — do not lose it if LLM fails).
      // -----------------------------------------------------------------------
      const userMsgId = randomUUID();
      const userMsgTs = Date.now();
      await withTenantTx(pool, tenantId, async (client) => {
        const payload: MessagePayload = {
          thread_id: threadId,
          role: "user",
          text: userText,
          context_ref: contextRef,
        };
        await auditWriter.appendAuditEvent(client, {
          id: userMsgId,
          type: "assistant.message",
          actor: actorSlug,
          subject: actorSlug,
          scope: null,
          via: null,
          proposed_by: null,
          confirmed_by: null,
          payload,
          occurred_at: userMsgTs,
        });
      });

      // -----------------------------------------------------------------------
      // 4. Build the grants-intersection context (agent ∩ user).
      // -----------------------------------------------------------------------
      const baseGrantSource = makeDbGrantSource(pool);
      const agentSubject: ResolveSubject = {
        tenantId,
        subjectId: agentSlug,
      };
      const userSubject: ResolveSubject = {
        tenantId,
        subjectId: actorSlug,
      };
      const intersectionGrants = makeIntersectionGrantSource(
        baseGrantSource,
        agentSubject,
        userSubject,
        ancestry,
      );

      const handlerCtx: HandlerContext = {
        tenantId,
        userSubject,
        agentSubject,
        intersectionGrants,
        ancestry,
        llm,
        threadId,
        messageId: userMsgId,
      };

      // -----------------------------------------------------------------------
      // 5. Dispatch to intent handler.
      //    LlmDormantError → 503 (no crash, honest-degrade).
      //    T-0363 (d): for CONFIGURATOR intent, call runConfigurator to get the
      //    full ConfiguratorResult so approvedOps can be persisted as DRAFT.
      //    For other intents, use the regular intentDispatch path.
      // -----------------------------------------------------------------------
      let handlerResult;
      try {
        const detectedIntent = classifyIntent(userText);
        if (detectedIntent === "configurator") {
          // T-0363 (d): run the full configurator loop to get approvedOps.
          const cfgResult = await runConfigurator(userText, handlerCtx);
          handlerResult = { text: cfgResult.text, intent: "configurator" as const };

          // Execute approvedOps as DRAFT (non-destructive; destructive ops are in blockedOps).
          const opErrors: string[] = [];
          for (const op of cfgResult.approvedOps) {
            const err = await executeApprovedOpAsDraft(pool, tenantId, op);
            if (err !== null) {
              opErrors.push(err);
              console.error(`[T-0363] draft op failed (${op.kind}): ${err}`);
            }
          }
          if (opErrors.length > 0) {
            // Append error summary to text (non-fatal — user sees partial result).
            handlerResult = {
              text: handlerResult.text + `\n\n⚠ Ошибки при сохранении ${opErrors.length} операций в DRAFT: ${opErrors.join("; ")}`,
              intent: "configurator" as const,
            };
          }
        } else {
          handlerResult = await intentDispatch(userText, handlerCtx);
        }
      } catch (err) {
        if (err instanceof LlmDormantError) {
          // Persist a "dormant" assistant message so the thread is consistent.
          const dormantMsgId = randomUUID();
          const dormantTs = Date.now();
          await withTenantTx(pool, tenantId, async (client) => {
            const payload: MessagePayload = {
              thread_id: threadId,
              role: "assistant",
              text: "LLM не настроен — настройте BYO-ключ для активации ассистента.",
              context_ref: null,
              intent: "unknown",
              streaming_done: true,
            };
            await auditWriter.appendAuditEvent(client, {
              id: dormantMsgId,
              type: "assistant.message",
              actor: agentSlug,
              subject: actorSlug,
              scope: null,
              via: null,
              proposed_by: null,
              confirmed_by: null,
              payload,
              occurred_at: dormantTs,
            });
          });

          res.statusCode = 503;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: "LLM_NOT_CONFIGURED",
              message:
                "LLM не настроен — настройте BYO-ключ для активации ассистента.",
            }),
          );
          return;
        }
        throw err;
      }

      // -----------------------------------------------------------------------
      // 6. Persist the assistant reply + audit the action.
      // -----------------------------------------------------------------------
      const assistantMsgId = randomUUID();
      const assistantTs = Date.now();
      await withTenantTx(pool, tenantId, async (client) => {
        const payload: MessagePayload = {
          thread_id: threadId,
          role: "assistant",
          text: handlerResult.text,
          context_ref: null,
          intent: handlerResult.intent,
          streaming_done: true,
        };
        // Persist assistant message.
        await auditWriter.appendAuditEvent(client, {
          id: assistantMsgId,
          type: "assistant.message",
          actor: agentSlug,         // the agent is the actor
          subject: actorSlug,        // on behalf of the user
          scope: null,
          via: null,
          proposed_by: null,
          confirmed_by: null,
          payload,
          occurred_at: assistantTs,
        });
      });

      // -----------------------------------------------------------------------
      // 7. Respond (buffered JSON — SSE is optional for Wave 2).
      // -----------------------------------------------------------------------
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: assistantMsgId,
          role: "assistant",
          text: handlerResult.text,
          ts: new Date(assistantTs).toISOString(),
          intent: handlerResult.intent,
          streaming_done: true,
        }),
      );
    }),
  );

  // =========================================================================
  // GET /api/assistant/threads/:id/budget — budget for a thread's agent
  // =========================================================================
  router.register(
    "GET",
    "/api/assistant/threads/:id/budget",
    withAuth(async (req, res, params) => {
      const threadId = params["id"] ?? "";
      if (!threadId) throw new HttpError(400, "VALIDATION", "thread id required");

      const actorSlug = await extractActorSlug(req, pool);
      const tenantId = await resolveActorTenant(actorSlug);

      const budget = await withTenantTx(pool, tenantId, async (client) => {
        // Verify thread ownership first.
        const thread = await fetchThread(client, threadId, actorSlug);
        if (!thread) throw new HttpError(404, "NOT_FOUND", "thread not found");
        return fetchBudget(client, tenantId, agentSlug);
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(budget));
    }),
  );
}
