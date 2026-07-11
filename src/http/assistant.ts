/**
 * src/http/assistant.ts — T-0359 (E17): AI-assistant API routes.
 *                         T-0384 (D5): thread UX — auto-title, lazy-create,
 *                                      delete/rename/pin via tombstone events.
 *
 * registerAssistantRoutes(router, { pool, resolveActorTenant, llmPortFactory })
 *
 * Routes:
 *   GET    /api/assistant/threads
 *   POST   /api/assistant/threads
 *   PATCH  /api/assistant/threads/:id        ← T-0384: rename / pin
 *   DELETE /api/assistant/threads/:id        ← T-0384: tombstone delete
 *   GET    /api/assistant/threads/:id/messages
 *   POST   /api/assistant/threads/:id/messages  ← LLM dispatch entry
 *   GET    /api/assistant/threads/:id/budget
 *
 * THREAD/MESSAGE PERSISTENCE: NO NEW TABLE (founder constraint).
 * Threads and messages are persisted as audit_event rows:
 *   type: "assistant.thread"          — one row per thread (on creation)
 *   type: "assistant.thread.renamed"  — T-0384: rename event (tombstone-event approach)
 *   type: "assistant.thread.deleted"  — T-0384: delete tombstone (logical delete)
 *   type: "assistant.thread.pinned"   — T-0384: pin/unpin event
 *   type: "assistant.message"         — one row per user turn + one per assistant reply
 * Reconstruction (GET) is done by querying audit_event for these types.
 *
 * TOMBSTONE-EVENT MODEL (T-0384):
 *   The audit_event table is append-only (no UPDATE/DELETE). So thread management
 *   uses event-projection: the fetchThreads projection reads all thread-lifecycle
 *   events and applies them in occurrence order:
 *     - Last "assistant.thread.renamed" for a thread wins → effective title
 *     - Any "assistant.thread.deleted" → thread excluded from list
 *     - Last "assistant.thread.pinned" → effective pin state (pinned threads first)
 *   This keeps the audit chain intact and requires no schema migration.
 *
 * LAZY-CREATE (T-0384):
 *   Threads with zero messages are hidden from GET /api/assistant/threads
 *   (they are created eagerly but only surface in the list after the first
 *   message is sent). This avoids cluttering the list with empty threads from
 *   accidental "New" clicks.
 *
 * AUTO-TITLE (T-0384):
 *   When the first user message is sent to a thread (message_count was 0),
 *   a "assistant.thread.renamed" event is appended with a title derived from
 *   the first 60 chars of the user message text. The projection then uses this
 *   as the effective title instead of the creation-time default.
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

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError, type Router, readJsonBody, sendErrorEnvelope } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { makeDbGrantSource } from "../db/grants-dao.js";
import { makeIntersectionGrantSource } from "../core/agent-on-behalf.js";
import { makePgAuditWriter } from "../db/audit-writer.js";
import {
  intentDispatch,
  classifyIntent,
  type HandlerContext,
} from "../core/assistant-intent.js";
import { classifyLlmUnavailability, type LlmPort } from "../core/llm-port.js";
// T-0573 (ADR-T0573 §2.2 B3): shared honest-503 text for BOTH the dormant path
// (no LLM config at all) and the adapter-failure path (config exists, call
// failed) — one canonical human message, one canonical envelope.
// T-0595 (UX_REVIEW T-0573 F-1/F-2): the single constant is now two — admin
// gets a deep-link button + path-free prose, non-admin gets an honest
// "ask your admin" text (no dead door to an admin-only screen they can't reach).
import {
  ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN,
  ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN,
} from "../core/assistant-messages.js";
import { loadAdminContext, resolveActorSlugFromAuth, isGenesisOwnerForTenant } from "../db/org.js";
// T-0607 (в2/г): pure honest-reporting helpers — reconcile the assistant text
// with the REAL op outcomes, and the canonical in-thread dispatch-failure reply.
import {
  buildHonestOpsReport,
  buildDispatchFailureReply,
  type OpResult,
} from "../core/assistant-report.js";
import type { AncestryOracle } from "../core/grant-lattice.js";
import type { ResolveSubject } from "../core/object-handle.js";
// T-0477 [E-AGENTS L5]: spend-tracking port wrapper (non-fatal ledger write on chat()).
import {
  SpendTrackingLlmPort,
  type SpendTrackingContext,
} from "../adapters/spend-tracking-llm-port.js";
// T-0363 (d): import runConfigurator to execute approvedOps as DRAFT.
// T-0466 (D8-G5): AUTHORING_CAPTURE_CONFIRMATION appended after a successful capture.
import {
  runConfigurator,
  AUTHORING_CAPTURE_CONFIRMATION,
  type ApprovedOp,
  type RegistryListCandidate,
} from "../core/assistant-configurator.js";
import type { RegistryDefCandidate } from "../core/relation-cascade.js";
// T-0724: listRegistryDefs is the SAME DAO GET /api/registry-defs uses to serve
// the human bind-form's "Реестр результата" picker (T-0681) — reused verbatim
// (never a second query) so the configurator's list_registries tool can never
// see more than that picker already shows a human of this tenant.
import { reconcileCrossAppRefs, listRegistryDefs } from "./registry-defs.js";
// T-0464 (D8-G3): free-topology process generation loop (generate→validate→repair).
import { runProcessGenLoop } from "../core/process-gen-loop.js";
import type { GroundingContext } from "../core/process-gen-validator.js";
import { CONFIGURATOR_DEFAULT_SYSTEM_PROMPT } from "../core/assistant-configurator.js";
import { generateUniqueProcessKey } from "../core/slugify-process-key.js";
// T-0466 (D8-G5): capture-as-request — file a non-admin's config-request as a
// notification to authoring_draft holders (admins/owners). Reuses the EXISTING
// notification mechanism (choros.notification, migration 046) — NO new table.
import {
  getAuthoringDraftHolderEmployeeIds,
  findTenantOwnerEmployeeId,
} from "../db/grants-dao.js";
// T-0383 (D5): per-tenant configurator system prompt loader (neutral import path).
import { readPublishedAssistantPrompt } from "../db/assistant-prompt-dao.js";
// T-0743: the configurator's apply_form_document_op tool executes through the
// EXACT SAME function POST /api/forms/document-ops uses (T-0656/T-0725) — no
// second implementation of the op-apply / ambiguity / Floor-gate logic.
import { applyFormDocumentOp, type FormDocumentOpArgs } from "./forms-document-ops.js";
// T-0743: DRAFT-ONLY discriminant for apply_form_document_op — form_binding
// carries no tier column (unlike application/registry_def), so the tool's
// auth model substitutes the bound APPLICATION's tier instead (see
// docs/tasks/T-0743.spec.md §4.4). Reused verbatim — the SAME accessor
// forms-document-ops.ts uses for its own AMBIGUOUS_APPLICATION pre-flight.
import { listProcessAppBindingCandidates, type ProcessAppBindingCandidate } from "../db/live-form-schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

/**
 * Factory that returns the LLM port for a given tenant (or dormantLlmPort).
 * T-0382: made async so per-tenant DB config can be read at call time.
 */
export type LlmPortFactory = (tenantId: string) => LlmPort | Promise<LlmPort>;

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
  /**
   * T-0477 [E-AGENTS L5]: optional factory that resolves spend-tracking context
   * (connection_id + prices) for the current tenant. When present, the resolved
   * LlmPort is wrapped in SpendTrackingLlmPort so each chat() call records a
   * non-fatal spend_ledger row. When absent (or returns null), no tracking occurs.
   */
  spendTrackingFactory?: (tenantId: string) => Promise<SpendTrackingContext | null>;
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
// T-0607 (в1): identifier resolution for DRAFT ops.
//
// THE DEFECT (live acceptance): the configurator LLM has no id↔slug↔name
// catalogue, so it passes a SLUG where the executor's SQL requires a raw UUID
// (registry_def.id / application.id are uuid columns) → «invalid input syntax
// for type uuid: "<slug>"» — 4/4 ops silently failed while the report said
// «Все поля добавлены ✅». The executor must accept the identification the LLM
// actually knows (slug OR uuid) and resolve it in the tenant's own rights.
//
// Resolve rule: a valid UUID passes through unchanged; otherwise SELECT the id
// by slug (RLS-scoped). Not found → null → the caller returns an HONEST op-error
// string (surfaced in the changelog), never a 500.
//
// T-0611 (fixes T-0607 review F4, medium): `application` is UNIQUE(tenant_id,
// slug) — a slug can never collide within one tenant, so `application`
// resolution is (and remains) unambiguous. `registry_def` is UNIQUE(tenant_id,
// application_id, slug) — the SAME slug MAY legitimately exist under two
// different applications in one tenant. The former query did
// `WHERE tenant_id = $1 AND slug = $2 LIMIT 1` with NO application_id filter
// and NO ORDER BY — on a cross-app collision it silently resolved an
// ARBITRARY row, so the configurator could edit the WRONG registry while
// buildHonestOpsReport still reported a false ✓ (the op did succeed — on the
// wrong target). No dialogue-scoped "current application" context exists to
// disambiguate at the call sites (see ADR-T0611), so the fix is deterministic
// REFUSAL: return a typed "ambiguous" result instead of guessing, listing the
// candidate applications so a human/LLM can re-issue with the raw UUID
// (registry_def.id is a tenant-wide, unambiguous PK component).
// ---------------------------------------------------------------------------

export type SlugResolveResult =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "ambiguous";
      readonly slug: string;
      readonly candidates: ReadonlyArray<{
        readonly registryDefId: string;
        readonly applicationSlug: string;
        readonly applicationDisplayName: string;
      }>;
    };

export async function resolveIdBySlug(
  client: pg.PoolClient,
  tenantId: string,
  table: "registry_def" | "application",
  idOrSlug: string,
): Promise<SlugResolveResult> {
  if (UUID_RE.test(idOrSlug)) return { kind: "id", id: idOrSlug };

  if (table === "application") {
    // UNIQUE(tenant_id, slug) — at most one row can ever match. ORDER BY is
    // defensive documentation of intent, not a correctness requirement here.
    const res = await client.query<{ id: string }>(
      `SELECT id FROM choros.application WHERE tenant_id = $1 AND slug = $2 ORDER BY id`,
      [tenantId, idOrSlug],
    );
    if (res.rows.length === 0) return { kind: "not_found" };
    return { kind: "id", id: res.rows[0]!.id };
  }

  // table === "registry_def": UNIQUE(tenant_id, application_id, slug) — the
  // slug alone does NOT determine a unique row. Fetch ALL matches (deterministic
  // order) and detect the ambiguous case rather than LIMIT-1-guessing.
  const res = await client.query<{
    id: string;
    application_slug: string;
    application_display_name: string;
  }>(
    `SELECT rd.id AS id, a.slug AS application_slug, a.display_name AS application_display_name
       FROM choros.registry_def rd
       JOIN choros.application a
         ON a.tenant_id = rd.tenant_id AND a.id = rd.application_id
      WHERE rd.tenant_id = $1 AND rd.slug = $2
      ORDER BY rd.id`,
    [tenantId, idOrSlug],
  );
  if (res.rows.length === 0) return { kind: "not_found" };
  if (res.rows.length === 1) return { kind: "id", id: res.rows[0]!.id };
  return {
    kind: "ambiguous",
    slug: idOrSlug,
    candidates: res.rows.map((r) => ({
      registryDefId: r.id,
      applicationSlug: r.application_slug,
      applicationDisplayName: r.application_display_name,
    })),
  };
}

/**
 * T-0611: render the ambiguous-candidates list into the human message suffix
 * used by every registry_def call site that surfaces resolveIdBySlug results.
 */
function formatAmbiguousCandidates(
  candidates: ReadonlyArray<{ applicationSlug: string; applicationDisplayName: string }>,
): string {
  return candidates
    .map((c) => `${c.applicationDisplayName} [${c.applicationSlug}]`)
    .join(", ");
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

/**
 * T-0463 [D8-G2]: fetch the tenant's existing registry_defs as cascade-dedup
 * candidates (PD-5 "validate against existing"). Supplies the SAME list the
 * visual relation-picker fetches (GET /api/registry-defs), so the bot and the
 * picker dedup against identical data.
 */
async function fetchRegistryDefCandidates(
  pool: pg.Pool,
  tenantId: string,
): Promise<RegistryDefCandidate[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const res = await client.query<{ id: string; slug: string; display_name: string }>(
      `SELECT id, slug, display_name FROM choros.registry_def WHERE tenant_id = $1`,
      [tenantId],
    );
    await client.query("COMMIT");
    return res.rows.map((r) => ({ id: r.id, slug: r.slug, displayName: r.display_name }));
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    // Honest-degrade: no candidates → every cascade creates (no dedup). Non-fatal.
    return [];
  } finally {
    client.release();
  }
}

/**
 * T-0724 [E-FORMS, столп 5]: fetch this tenant's real registries for the
 * configurator's list_registries introspection tool. REUSES listRegistryDefs
 * (src/http/registry-defs.ts) — the EXACT DAO GET /api/registry-defs calls to
 * serve the human bind-form's "Реестр результата" picker (T-0681) — so the bot
 * can never see a registry the picker would not also show a human of this
 * tenant. No application_id filter here (null): the FULL tenant list is fetched
 * once per turn and processToolCall (pure core) filters it by the applicationId
 * arg the LLM supplies, mirroring how existingRegistryDefs (T-0463) is fetched
 * once and filtered in-core. Honest-degrade on failure: empty list, never a crash
 * (the tool then honestly reports zero registries rather than 500ing the turn).
 */
export async function fetchRegistryListCandidates(
  pool: pg.Pool,
  tenantId: string,
): Promise<RegistryListCandidate[]> {
  try {
    const rows = await listRegistryDefs(pool, tenantId, null);
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      displayName: r.display_name,
      applicationId: r.application_id,
    }));
  } catch {
    return [];
  }
}

/**
 * T-0464 (D8-G3): assemble the grounding context for process generation — the real
 * field keys (from the bound application's registry_def record_schema) and the real
 * role slugs in the tenant. The generation loop grounds gateway conditions on these
 * fields and lane roles on these role slugs (cascade/ask when a reference is missing).
 *
 * applicationId is optional: when given, only that app's section field keys are used;
 * when absent, the union of all tenant section field keys grounds the conditions (a
 * looser ground — the loop still asks when a condition references nothing real).
 */
async function fetchGroundingContext(
  pool: pg.Pool,
  tenantId: string,
  applicationId: string | null,
): Promise<GroundingContext> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");

    // Field keys: the record_schema.properties keys of the relevant registry_def(s).
    const defRes = applicationId
      ? await client.query<{ record_schema: Record<string, unknown> | null }>(
          `SELECT record_schema FROM choros.registry_def
             WHERE tenant_id = $1 AND application_id = $2`,
          [tenantId, applicationId],
        )
      : await client.query<{ record_schema: Record<string, unknown> | null }>(
          `SELECT record_schema FROM choros.registry_def WHERE tenant_id = $1`,
          [tenantId],
        );
    const fieldKeys = new Set<string>();
    for (const row of defRes.rows) {
      const schema = row.record_schema as { properties?: Record<string, unknown> } | null;
      const props = schema?.properties;
      if (props && typeof props === "object") {
        for (const key of Object.keys(props)) fieldKeys.add(key);
      }
    }

    // Role slugs: every role.slug in the tenant.
    const roleRes = await client.query<{ slug: string }>(
      `SELECT slug FROM choros.role WHERE tenant_id = $1`,
      [tenantId],
    );
    const roleSlugs = roleRes.rows.map((r) => r.slug);

    await client.query("COMMIT");
    return { fieldKeys: [...fieldKeys], roleSlugs };
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    // Honest-degrade: empty grounding → the loop surfaces needs_grounding rather than
    // emitting an ungrounded process. Non-fatal.
    return { fieldKeys: [], roleSlugs: [] };
  } finally {
    client.release();
  }
}

/**
 * T-0464 (D8-G3): execution context for the generate_process op — the live LLM port
 * (the bot that emits the BPMN) and the configurator system prompt. Threaded into
 * executeApprovedOpAsDraft only for the generate_process kind (other ops are pure DB).
 */
interface GenExecContext {
  readonly llm: LlmPort;
  readonly systemPrompt: string;
}

/**
 * Execute a single ApprovedOp as a DRAFT DB write. Returns null on success, an
 * honest error message on failure (a "DUPLICATE:"-prefixed string marks a benign
 * already-exists outcome). Exported for T-0607 (в1/в2) live DB tests.
 */
export async function executeApprovedOpAsDraft(
  pool: pg.Pool,
  tenantId: string,
  op: ApprovedOp,
  /** T-0464: present only when op.kind === 'generate_process' (the loop needs the LLM). */
  genCtx?: GenExecContext,
  /**
   * T-0465 (D8-G4): bundle grouping id. When the configurator generates a whole
   * solution in one confirmed turn, every DRAFT artifact (apps, sections, processes)
   * is tagged with this shared bundle_id so a single bundle-promote publishes them
   * together. undefined → not part of a bundle (column stays NULL).
   */
  bundleId?: string,
  /**
   * T-0743: the ACTING user's identity (employee slug) — present only when
   * op.kind === 'apply_form_document_op'. Required because that op reuses
   * checkRole (binding.ts) — the SAME process_designer/owner role-check the
   * human FormDesigner path enforces — which is keyed on an actor slug, not
   * just tenantId. Every other op kind writes without a per-op role check
   * (the earlier authoring_draft grant-ceiling gate already covers them), so
   * this stays optional/unused for those kinds.
   */
  actorSlug?: string,
): Promise<string | null> {
  try {
    const nowMs = Date.now();

    switch (op.kind) {
      // -----------------------------------------------------------------------
      // create_application — T-0462 (D8-G1): INSERT a NEW application (tier='draft')
      // + its primary registry_def "section", in ONE transaction.
      // Co-equal: same choros.application + choros.registry_def tables (and the
      // tier='draft' default) the visual constructor writes via applications.ts
      // POST /api/applications and registry-defs.ts POST /api/registry-defs.
      // -----------------------------------------------------------------------
      case "create_application": {
        const args = op.args;
        const appSlug      = typeof args["appSlug"]      === "string" ? args["appSlug"]      : null;
        const appDisplayName = typeof args["appDisplayName"] === "string" ? args["appDisplayName"] : null;
        const appDescription = typeof args["appDescription"] === "string" ? args["appDescription"] : null;
        const sectionSlug  = typeof args["sectionSlug"]  === "string" ? args["sectionSlug"]  : appSlug;
        const sectionDisplayName =
          typeof args["sectionDisplayName"] === "string" ? args["sectionDisplayName"] : appDisplayName;

        if (!appSlug || !appDisplayName) {
          return `create_application: missing appSlug or appDisplayName`;
        }

        // Parse the optional initial record_schema; default to an empty object schema.
        let recordSchema: Record<string, unknown> = { type: "object", properties: {} };
        if (typeof args["recordSchema"] === "string" && args["recordSchema"]) {
          try { recordSchema = JSON.parse(args["recordSchema"] as string) as Record<string, unknown>; }
          catch { /* keep default empty object schema */ }
        }

        const appId = randomUUID();
        const regId = randomUUID();
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await client.query("SET LOCAL search_path TO choros");

          // 1) Application — tier='draft' (column DEFAULT, but set explicitly for clarity).
          //    T-0465: bundle_id ties this app into the one-shot solution bundle.
          await client.query(
            `INSERT INTO choros.application
               (tenant_id, id, slug, display_name, description, tier, bundle_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $7)`,
            [tenantId, appId, appSlug, appDisplayName, appDescription, bundleId ?? null, nowMs],
          );

          // 2) Primary section (registry_def) under the new application.
          await client.query(
            `INSERT INTO choros.registry_def
               (tenant_id, id, application_id, slug, display_name, description,
                record_schema, bundle_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $9)`,
            [tenantId, regId, appId, sectionSlug, sectionDisplayName, null,
             JSON.stringify(recordSchema), bundleId ?? null, nowMs],
          );

          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          // 23505 = unique_violation → app/section slug already taken in this tenant.
          // Honest error string (NOT a 500) — surfaced in the changelog, not thrown.
          if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
            // T-0607 (в2): a DUPLICATE outcome — the app/section already exists.
            // Prefixed so the honest ops report shows «уже было», not «не создано».
            return `DUPLICATE:create_application: приложение со slug «${appSlug}» уже есть в этом пространстве`;
          }
          throw err;
        } finally {
          client.release();
        }
        return null;
      }

      // -----------------------------------------------------------------------
      // relate_application — T-0463 (D8-G2): add a relation field on the SOURCE
      // registry_def. For LINK: write x-relation.target_registry_id = existing id.
      // For CREATE (cascade): create the related app + section in the SAME tx,
      // then write the relation field pointing at the new section's registry_def id
      // — so a single promote brings BOTH the related app and the relation. After
      // the schema write, reconcileCrossAppRefs keeps cross_app_ref in sync.
      // -----------------------------------------------------------------------
      case "relate_application": {
        const args = op.args;
        const sourceRegistryDefId =
          typeof args["sourceRegistryDefId"] === "string" ? args["sourceRegistryDefId"] : null;
        const relationFieldKey =
          typeof args["relationFieldKey"] === "string" ? args["relationFieldKey"] : null;
        const relationFieldLabel =
          typeof args["relationFieldLabel"] === "string" ? args["relationFieldLabel"] : relationFieldKey;
        const cascade = (args["cascade"] ?? {}) as Record<string, unknown>;
        const mode = typeof cascade["mode"] === "string" ? cascade["mode"] : null;

        if (!sourceRegistryDefId || !relationFieldKey || (mode !== "link" && mode !== "create")) {
          return `relate_application: missing sourceRegistryDefId/relationFieldKey or invalid cascade mode`;
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await client.query("SET LOCAL search_path TO choros");

          // T-0607 (в1): accept slug OR uuid for the source registry_def.
          // T-0611: refuse deterministically on cross-app slug collision.
          const sourceResolved = await resolveIdBySlug(
            client, tenantId, "registry_def", sourceRegistryDefId,
          );
          if (sourceResolved.kind === "not_found") {
            await client.query("ROLLBACK");
            return `relate_application: исходный реестр «${sourceRegistryDefId}» не найден в этом пространстве`;
          }
          if (sourceResolved.kind === "ambiguous") {
            await client.query("ROLLBACK");
            return `relate_application: слаг «${sourceResolved.slug}» неоднозначен — существует в нескольких приложениях этого пространства (${formatAmbiguousCandidates(sourceResolved.candidates)}). Уточните: укажите raw UUID нужного реестра (sourceRegistryDefId).`;
          }
          const resolvedSourceId = sourceResolved.id;

          // 1) Resolve the target registry_def id.
          //    LINK → use the existing id directly.
          //    CREATE → create the related app + section (tier='draft'), use its id.
          let targetRegistryId: string;
          if (mode === "link") {
            const rawTarget = typeof cascade["targetRegistryId"] === "string"
              ? cascade["targetRegistryId"] : "";
            if (!rawTarget) {
              await client.query("ROLLBACK");
              return `relate_application(link): missing targetRegistryId`;
            }
            // T-0607 (в1): accept slug OR uuid for the link target too.
            // T-0611: refuse deterministically on cross-app slug collision.
            const targetResolved = await resolveIdBySlug(
              client, tenantId, "registry_def", rawTarget,
            );
            if (targetResolved.kind === "not_found") {
              await client.query("ROLLBACK");
              return `relate_application(link): целевой реестр «${rawTarget}» не найден в этом пространстве`;
            }
            if (targetResolved.kind === "ambiguous") {
              await client.query("ROLLBACK");
              return `relate_application(link): слаг «${targetResolved.slug}» неоднозначен — существует в нескольких приложениях этого пространства (${formatAmbiguousCandidates(targetResolved.candidates)}). Уточните: укажите raw UUID нужного реестра (targetRegistryId).`;
            }
            targetRegistryId = targetResolved.id;
          } else {
            const appSlug = typeof cascade["appSlug"] === "string" ? cascade["appSlug"] : null;
            const appDisplayName =
              typeof cascade["appDisplayName"] === "string" ? cascade["appDisplayName"] : null;
            if (!appSlug || !appDisplayName) {
              await client.query("ROLLBACK");
              return `relate_application(create): missing cascade appSlug/appDisplayName`;
            }
            const cascadedAppId = randomUUID();
            targetRegistryId = randomUUID();
            // Related application — same DRAFT bundle as the parent (tier='draft').
            // T-0465: same bundle_id as the parent → ONE promote brings both.
            await client.query(
              `INSERT INTO choros.application
                 (tenant_id, id, slug, display_name, description, tier, bundle_id, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $7)`,
              [tenantId, cascadedAppId, appSlug, appDisplayName, null, bundleId ?? null, nowMs],
            );
            // Primary section (registry_def) under the cascaded app — empty schema.
            await client.query(
              `INSERT INTO choros.registry_def
                 (tenant_id, id, application_id, slug, display_name, description,
                  record_schema, bundle_id, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $9)`,
              [tenantId, targetRegistryId, cascadedAppId, appSlug, appDisplayName, null,
               JSON.stringify({ type: "object", properties: {} }), bundleId ?? null, nowMs],
            );
          }

          // 2) Read the source schema, add the relation field (additive), write back.
          const srcRes = await client.query<{ record_schema: Record<string, unknown> | null }>(
            `SELECT record_schema FROM choros.registry_def WHERE tenant_id = $1 AND id = $2`,
            [tenantId, resolvedSourceId],
          );
          if (srcRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return `relate_application: source registry_def '${sourceRegistryDefId}' not found`;
          }
          const oldSchema = (srcRes.rows[0].record_schema ?? { type: "object", properties: {} }) as Record<string, unknown>;
          const relationFieldSchema = {
            type: "string",
            title: relationFieldLabel,
            "x-relation": { target_registry_id: targetRegistryId },
          };
          // Additive jsonb_set: properties[relationFieldKey] = relationFieldSchema.
          const updRes = await client.query<{ record_schema: Record<string, unknown> }>(
            `UPDATE choros.registry_def
                SET record_schema = jsonb_set(
                  COALESCE(record_schema, '{"type":"object","properties":{}}'::jsonb),
                  ARRAY['properties', $2],
                  $3::jsonb,
                  true
                ),
                updated_at = $4
              WHERE tenant_id = $1 AND id = $5
              RETURNING record_schema`,
            [tenantId, relationFieldKey, JSON.stringify(relationFieldSchema), nowMs, resolvedSourceId],
          );
          const newSchema = updRes.rows[0]?.record_schema ?? oldSchema;

          // 3) Reconcile cross_app_ref from the x-relation fields (same tx, atomic).
          await reconcileCrossAppRefs(client, tenantId, resolvedSourceId, oldSchema, newSchema);

          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
            return `relate_application: cascaded app slug already exists in this tenant`;
          }
          throw err;
        } finally {
          client.release();
        }
        return null;
      }

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
        // T-0681 (migration 119): optional per-binding target registry override. Empty
        // → null (default step-result slug, backward-compatible). Validated below.
        const targetRegistrySlugRaw = typeof args["targetRegistrySlug"] === "string"
          ? args["targetRegistrySlug"].trim()
          : "";
        const targetRegistrySlug = targetRegistrySlugRaw.length > 0 ? targetRegistrySlugRaw : null;

        if (!processKey || !applicationId) {
          return `author_binding: missing processKey or applicationId`;
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await client.query("SET LOCAL search_path TO choros");
          // T-0607 (в1): accept slug OR uuid for the application id.
          // T-0611: application is UNIQUE(tenant_id, slug) — "ambiguous" is not
          // reachable here, but the discriminated result is handled exhaustively.
          const appResolved = await resolveIdBySlug(client, tenantId, "application", applicationId);
          if (appResolved.kind === "not_found") {
            await client.query("ROLLBACK");
            return `author_binding: приложение «${applicationId}» не найдено в этом пространстве`;
          }
          if (appResolved.kind === "ambiguous") {
            await client.query("ROLLBACK");
            return `author_binding: слаг «${appResolved.slug}» неоднозначен в этом пространстве. Уточните: укажите raw UUID нужного приложения (applicationId).`;
          }
          const resolvedAppId = appResolved.id;
          // T-0681: fail-closed on an unresolvable target registry (same guard as
          // POST /api/process-app-bindings) — a non-empty slug must name a real
          // registry_def under this application, else the binding silently 409s later.
          if (targetRegistrySlug !== null) {
            const regRes = await client.query<{ one: number }>(
              `SELECT 1 AS one FROM choros.registry_def
                WHERE tenant_id = $1 AND application_id = $2 AND slug = $3 LIMIT 1`,
              [tenantId, resolvedAppId, targetRegistrySlug],
            );
            if (regRes.rows.length === 0) {
              await client.query("ROLLBACK");
              return `author_binding: реестр «${targetRegistrySlug}» не найден в приложении этого пространства`;
            }
          }
          await client.query(
            `INSERT INTO choros.process_app_binding
               (tenant_id, id, process_key, application_id, form_key,
                trigger_type, start_form_key, field_mapping, target_registry_slug,
                created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $10)
             ON CONFLICT (tenant_id, process_key, application_id)
             DO UPDATE SET
               trigger_type         = EXCLUDED.trigger_type,
               start_form_key       = EXCLUDED.start_form_key,
               field_mapping        = EXCLUDED.field_mapping,
               target_registry_slug = EXCLUDED.target_registry_slug,
               updated_at           = EXCLUDED.updated_at`,
            [tenantId, randomUUID(), processKey, resolvedAppId, startFormKey,
             triggerType, startFormKey, JSON.stringify(fieldMapping), targetRegistrySlug, nowMs],
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

          // T-0607 (в1): accept slug OR uuid — resolve to the real registry_def id.
          // T-0611: refuse deterministically on cross-app slug collision — never
          // silently mutate an arbitrary registry sharing this slug.
          const registryResolved = await resolveIdBySlug(
            client, tenantId, "registry_def", registryDefId,
          );
          if (registryResolved.kind === "not_found") {
            await client.query("ROLLBACK");
            return `edit_jsonschema_non_destructive: реестр «${registryDefId}» не найден в этом пространстве`;
          }
          if (registryResolved.kind === "ambiguous") {
            await client.query("ROLLBACK");
            return `edit_jsonschema_non_destructive: слаг «${registryResolved.slug}» неоднозначен — существует в нескольких приложениях этого пространства (${formatAmbiguousCandidates(registryResolved.candidates)}). Уточните: укажите raw UUID нужного реестра (registryDefId).`;
          }
          const resolvedRegistryId = registryResolved.id;

          // Merge the field into the existing record_schema using jsonb path operations.
          // For add_field: set properties[fieldKey] = fieldSchema (additive only).
          // T-0607 (в2): report a DUPLICATE distinctly — if the field already
          // exists, this is a no-op the report must show as «уже было», not «added».
          const dupRes = await client.query<{ exists: boolean }>(
            `SELECT (record_schema #> ARRAY['properties', $2]) IS NOT NULL AS exists
               FROM choros.registry_def WHERE tenant_id = $1 AND id = $3`,
            [tenantId, fieldKey, resolvedRegistryId],
          );
          const alreadyExists = dupRes.rows[0]?.exists === true;
          if (alreadyExists) {
            await client.query("ROLLBACK");
            return `DUPLICATE:edit_jsonschema_non_destructive: поле «${fieldKey}» уже есть в реестре`;
          }

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
            [tenantId, fieldKey, JSON.stringify(fieldSchema), nowMs, resolvedRegistryId],
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
      // apply_form_document_op — T-0743: patch an EXISTING form via the SAME
      // function POST /api/forms/document-ops calls (applyFormDocumentOp,
      // forms-document-ops.ts) — reuse, not a second implementation.
      //
      // AUTH MODEL (docs/tasks/T-0743.spec.md §4.4): form_binding has no
      // draft/published tier (unlike application/registry_def) — the human
      // FormDesigner save is ALWAYS live. This tool substitutes the BOUND
      // APPLICATION's tier as the DRAFT-ONLY discriminant: it may write only
      // when the process resolves (pin or single-binding) to a tier='draft'
      // application. Zero/unverifiable candidates fail closed (refuse, do
      // NOT call the shared function) rather than assume draft. A genuinely
      // ambiguous process (2+ bindings, no pin) is NOT resolved here — it is
      // handed to the shared function, whose EXISTING 422
      // AMBIGUOUS_APPLICATION (T-0725) becomes an honest per-op failure that
      // buildHonestOpsReport (T-0607 в2) surfaces as the assistant naming
      // every candidate — reads as an ASK, not a crash.
      //
      // This restriction is STRICTLY NARROWER than a human process_designer's
      // capability via the UI (unrestricted by application tier) — bot ≤
      // human — and the shared function ALSO re-runs checkRole (same
      // process_designer/owner gate the human path enforces), so the tool
      // cannot act for an actor who could not use FormDesigner either.
      // -----------------------------------------------------------------------
      case "apply_form_document_op": {
        if (!actorSlug) {
          return `apply_form_document_op: no actor identity wired`;
        }
        const args = op.args;
        const processKey = typeof args["processKey"] === "string" ? args["processKey"] : null;
        const stepKey = typeof args["stepKey"] === "string" ? args["stepKey"] : null;
        const applicationId =
          typeof args["applicationId"] === "string" && args["applicationId"].trim()
            ? args["applicationId"].trim()
            : null;
        const docOp = args["op"];

        if (!processKey || !stepKey || docOp === undefined || docOp === null) {
          return `apply_form_document_op: missing processKey, stepKey, or op`;
        }

        // Resolve the tier discriminant BEFORE touching form_binding at all —
        // reuses listProcessAppBindingCandidates (the SAME accessor the
        // shared function's own ambiguity pre-flight uses), extended (T-0743)
        // with applicationTier.
        let candidates: ProcessAppBindingCandidate[] = [];
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await client.query("SET LOCAL search_path TO choros");
          candidates = await listProcessAppBindingCandidates(client, tenantId, processKey);
          await client.query("COMMIT");
        } catch {
          await client.query("ROLLBACK").catch(() => {});
          candidates = [];
        } finally {
          client.release();
        }

        const resolved = applicationId
          ? candidates.find((c) => c.applicationId === applicationId)
          : candidates.length === 1
            ? candidates[0]
            : undefined;

        if (candidates.length > 0) {
          if (!resolved) {
            if (!(candidates.length > 1 && !applicationId)) {
              // A pin that names no real binding — cannot verify draft-tier
              // scope. Fail closed rather than let the shared function's own
              // (unrelated) 409 stand in for this refusal.
              return (
                `apply_form_document_op: applicationId "${applicationId}" is not a binding of ` +
                `process "${processKey}" — cannot verify draft-tier scope, refusing.`
              );
            }
            // else: candidates.length > 1 && no pin — genuinely ambiguous.
            // Deliberately NOT resolved here; fall through to the shared
            // function, whose own AMBIGUOUS_APPLICATION 422 is the ASK.
          } else if (resolved.applicationTier !== "draft") {
            return (
              `apply_form_document_op: приложение «${resolved.applicationDisplayName ?? resolved.applicationSlug ?? resolved.applicationId}» ` +
              `не в статусе черновик (tier=${resolved.applicationTier ?? "unknown"}) — ассистент может менять формы только ` +
              `НЕОПУБЛИКОВАННЫХ приложений; такие изменения делает человек через конструктор форм.`
            );
          }
        }
        // candidates.length === 0 → no binding at all; the shared function's
        // own 404/409 fail-closed path handles it (unrelated to tier).

        const docArgs: FormDocumentOpArgs = { processKey, stepKey, op: docOp, applicationId };
        try {
          await applyFormDocumentOp(pool, tenantId, actorSlug, docArgs);
          return null;
        } catch (err) {
          if (err instanceof HttpError) {
            return `${err.code}: ${err.message}`;
          }
          throw err;
        }
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

      // -----------------------------------------------------------------------
      // generate_process — T-0464 (D8-G3): run the generate→validate→repair loop
      // and persist the converged draft as a process_definition DRAFT row for human
      // review in the Modeler. NEVER auto-published. On lint-exhaustion or an
      // ungroundable reference, NO row is written (honest failure surfaced in text).
      // Co-equal: writes the SAME 'draft' process_definition the visual modeler /
      // process-defs POST writes.
      // -----------------------------------------------------------------------
      case "generate_process": {
        if (!genCtx) {
          // The dispatch site must supply the LLM context for this op kind.
          return `generate_process: no LLM execution context wired`;
        }
        const args = op.args;
        const processName = typeof args["processName"] === "string" ? args["processName"].trim() : "";
        const description = typeof args["description"] === "string" ? args["description"].trim() : "";
        const requestedKey = typeof args["processKey"] === "string" ? args["processKey"].trim() : "";
        const applicationId = typeof args["applicationId"] === "string" ? args["applicationId"].trim() : "";

        if (!processName || !description) {
          return `generate_process: missing processName or description`;
        }

        // Resolve a collision-safe process key (mirrors process-defs POST B19).
        const processKey = requestedKey
          ? requestedKey
          : await generateUniqueProcessKey(processName, async (candidate) => {
              const c = await pool.connect();
              try {
                await c.query("BEGIN");
                await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
                await c.query("SET LOCAL search_path TO choros");
                const r = await c.query(
                  `SELECT 1 FROM choros.process_definition
                     WHERE tenant_id = $1 AND process_key = $2 LIMIT 1`,
                  [tenantId, candidate],
                );
                await c.query("COMMIT");
                return r.rowCount !== null && r.rowCount > 0;
              } catch {
                await c.query("ROLLBACK").catch(() => {});
                return false;
              } finally {
                c.release();
              }
            });

        // T-0607 (в1): accept slug OR uuid for applicationId. A non-resolvable
        // slug degrades to null grounding (the loop asks) rather than crashing the
        // WHERE application_id = <uuid> query with «invalid input syntax».
        // T-0611: application is UNIQUE(tenant_id, slug) so "ambiguous" cannot
        // occur here in practice; treated the same as not-found (degrade to
        // null grounding) since this is a soft hint, never a write.
        let groundingAppId: string | null = null;
        if (applicationId) {
          const gc = await pool.connect();
          try {
            await gc.query("BEGIN");
            await gc.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
            await gc.query("SET LOCAL search_path TO choros");
            const appResolved = await resolveIdBySlug(gc, tenantId, "application", applicationId);
            groundingAppId = appResolved.kind === "id" ? appResolved.id : null;
            await gc.query("COMMIT");
          } catch {
            await gc.query("ROLLBACK").catch(() => {});
            groundingAppId = null;
          } finally {
            gc.release();
          }
        }

        // Grounding: real field keys + role slugs (cascade/ask when a reference misses).
        const grounding = await fetchGroundingContext(pool, tenantId, groundingAppId);

        // Run the loop. PURE core decides draft_ready / needs_grounding / exhausted.
        const outcome = await runProcessGenLoop({
          description,
          llm: genCtx.llm,
          systemPrompt: genCtx.systemPrompt,
          grounding,
          processKey,
          processName,
        });

        if (outcome.status !== "draft_ready") {
          // Honest non-emit: surface why, write NOTHING. The user sees this in the reply.
          return `generate_process[${outcome.status}]: ${outcome.message}`;
        }

        // Converged — persist as DRAFT (status='draft'). Human reviews/promotes in Modeler.
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await client.query("SET LOCAL search_path TO choros");
          await client.query(
            `INSERT INTO choros.process_definition
               (tenant_id, id, process_key, name, bpmn_xml, version, status, deployment_id,
                bundle_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 1, 'draft', NULL, $6, $7, $7)
             ON CONFLICT (tenant_id, process_key, version) DO UPDATE
               SET bpmn_xml   = EXCLUDED.bpmn_xml,
                   name       = EXCLUDED.name,
                   bundle_id  = EXCLUDED.bundle_id,
                   updated_at = EXCLUDED.updated_at`,
            [tenantId, randomUUID(), processKey, processName, outcome.bpmnXml, bundleId ?? null, nowMs],
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
// T-0465 (D8-G4): BUNDLE — one-shot solution as ONE promote unit.
//
// When the user CONFIRMS a proposed plan, the configurator generates the whole
// solution (application + cascaded apps + process) in ONE turn. Each DRAFT
// artifact is tagged with a shared bundle_id (minted here). After execution we:
//   (1) resolve the bundle's items (apps + sections + processes) from the tagged
//       rows, to build DEEP-LINKS into the actual sections (Приложения / Модельер)
//       — the user reviews the draft VISUALLY there, NOT a constructor in chat;
//   (2) surface a bundlePromote descriptor so the whole bundle can be published
//       together as one unit (POST /api/solution-bundles/:bundleId/promote).
// ---------------------------------------------------------------------------

/** ApprovedOp kinds that materialise a DRAFT artifact worth bundling. */
const BUNDLE_OP_KINDS: ReadonlySet<ApprovedOp["kind"]> = new Set([
  "create_application",
  "relate_application",
  "generate_process",
]);

/** A clickable deep-link surfaced in the assistant reply (rendered by the web chat). */
export interface DeepLink {
  /** Visible label, e.g. «Открыть приложение «Заявки на закупку»». */
  readonly label: string;
  /** SPA route path, e.g. "/app-schema/<uuid>" or "/processes/<key>/edit". */
  readonly path: string;
  /** Section kind — UI may badge it (app / process). */
  readonly kind: "app" | "process";
}

/** Bundle-promote descriptor — the whole bundle published as ONE unit. */
export interface BundlePromote {
  readonly bundleId: string;
  /** How many DRAFT items (apps + sections + processes) the bundle holds. */
  readonly itemCount: number;
  /** API endpoint the web chat POSTs to publish the whole bundle. */
  readonly path: string;
}

/**
 * T-0465 (D8-G4): PURE deep-link + bundle-promote construction (no DB).
 * Exported so the plan→generate→review→promote contract is testable at $0:
 *   - links point at the actual SECTIONS (/app-schema/:id, /processes/:key/edit) —
 *     the user reviews the draft VISUALLY there, the chat does NOT render a constructor;
 *   - the bundlePromote path targets the bundle-promote endpoint (ONE promote unit).
 */
export function buildBundleReview(
  apps: ReadonlyArray<{ id: string; display_name: string }>,
  procs: ReadonlyArray<{ process_key: string; name: string }>,
  sectionCount: number,
  bundleId: string,
): { deepLinks: DeepLink[]; bundlePromote: BundlePromote | null } {
  const deepLinks: DeepLink[] = [];
  for (const a of apps) {
    deepLinks.push({
      label: `Открыть приложение «${a.display_name}»`,
      path: `/app-schema/${a.id}`,
      kind: "app",
    });
  }
  for (const p of procs) {
    deepLinks.push({
      label: `Открыть процесс «${p.name}» в Модельере`,
      path: `/processes/${encodeURIComponent(p.process_key)}/edit`,
      kind: "process",
    });
  }
  const itemCount = apps.length + procs.length + sectionCount;
  const bundlePromote: BundlePromote | null =
    itemCount > 0
      ? { bundleId, itemCount, path: `/api/solution-bundles/${bundleId}/promote` }
      : null;
  return { deepLinks, bundlePromote };
}

/**
 * Resolve the deep-links + bundle-promote descriptor for a freshly-built bundle.
 * Reads the tagged DRAFT rows back (RLS-scoped) so the links point at the REAL
 * sections the user reviews visually. Returns honest-empty on any read failure.
 */
async function resolveBundleReview(
  pool: pg.Pool,
  tenantId: string,
  bundleId: string,
): Promise<{ deepLinks: DeepLink[]; bundlePromote: BundlePromote | null }> {
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client.query("SET LOCAL search_path TO choros");

      // Applications in this bundle → deep-link to the schema/fields editor.
      const apps = await client.query<{ id: string; display_name: string }>(
        `SELECT id, display_name FROM choros.application
           WHERE tenant_id = $1 AND bundle_id = $2
           ORDER BY created_at ASC`,
        [tenantId, bundleId],
      );
      // Processes in this bundle → deep-link to the Modeler (review the diagram).
      const procs = await client.query<{ process_key: string; name: string }>(
        `SELECT process_key, name FROM choros.process_definition
           WHERE tenant_id = $1 AND bundle_id = $2
           ORDER BY created_at ASC`,
        [tenantId, bundleId],
      );
      // Sections (registry_def) count toward the bundle item total (promoted too).
      const sectionCount = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM choros.registry_def
           WHERE tenant_id = $1 AND bundle_id = $2`,
        [tenantId, bundleId],
      );
      await client.query("COMMIT");

      // Pure construction (testable at $0) from the tagged rows.
      return buildBundleReview(
        apps.rows,
        procs.rows,
        Number(sectionCount.rows[0]?.n ?? "0"),
        bundleId,
      );
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`[T-0465] resolveBundleReview failed: ${String(err)}`);
    return { deepLinks: [], bundlePromote: null };
  }
}

// ---------------------------------------------------------------------------
// T-0466 (D8-G5): capture-as-request.
//
// When a non-admin (no authoring_draft grant) describes something to configure,
// runConfigurator returns a captureRequest. We file it as a config-request so the
// intent is NOT lost: a notification per admin/owner recipient, reusing the
// EXISTING notification center (choros.notification — migration 046, no new table).
//
// Recipients: human employees holding a confirmed authoring_draft grant
// (= the admins/owners who can act on the sandbox). Fallback to the tenant owner
// when no explicit holder exists, so the request is never dropped on the floor.
//
// NOTE: choros.notification.recipient_id is uuid with FK → employee(tenant_id,id)
// (migration 046), so recipients are EMPLOYEE IDs, not slugs.
//
// Returns the number of recipients notified (0 = nobody to route to — honest).
// ---------------------------------------------------------------------------

/** Notification event_kind for a captured config-request. */
const CONFIG_REQUEST_EVENT_KIND = "config_request";

async function captureConfigRequest(
  pool: pg.Pool,
  tenantId: string,
  requesterSlug: string,
  description: string,
): Promise<number> {
  const nowMs = Date.now();

  // Resolve admin/owner recipients: holders of a confirmed authoring_draft grant.
  let recipientIds = await getAuthoringDraftHolderEmployeeIds(pool, tenantId, nowMs).catch(
    () => [] as string[],
  );

  // Fallback: route to the tenant owner if no explicit holder exists.
  if (recipientIds.length === 0) {
    const ownerId = await findTenantOwnerEmployeeId(pool, tenantId, nowMs).catch(() => null);
    if (ownerId) recipientIds = [ownerId];
  }

  if (recipientIds.length === 0) return 0;

  // Truncate the body for the notification (keep the title short, body bounded).
  const trimmed = description.replace(/\s+/g, " ").trim();
  const title = "Заявка на настройку системы";

  // Insert one notification per recipient inside a tenant-scoped tx (RLS).
  // We write the SAME columns as PgNotificationStore.insert (migration 046),
  // but through the tx client so the choros.tenant_id GUC is set (RLS-safe).
  let notified = 0;
  await withTenantTx(pool, tenantId, async (client) => {
    // Resolve the requester's employee id so we (a) never notify them and
    // (b) can name them in the body. Best-effort: if unresolved, use the slug.
    const { rows: reqRows } = await client.query<{ id: string }>(
      `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
      [tenantId, requesterSlug],
    );
    const requesterId = reqRows.length > 0 ? reqRows[0]!.id : null;

    const body =
      `Сотрудник «${requesterSlug}» просит настроить систему:\n\n` +
      (trimmed.length <= 1000 ? trimmed : trimmed.slice(0, 1000) + "…") +
      `\n\nОткройте конструктор/ассистента, чтобы выполнить настройку.`;

    for (const recipientId of recipientIds) {
      // The request is FROM the requester, not TO them — skip self.
      if (requesterId !== null && recipientId === requesterId) continue;
      await client.query(
        `INSERT INTO choros.notification
           (tenant_id, id, recipient_id, event_kind, title, body, object_ref,
            is_read, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9)`,
        [
          tenantId,
          randomUUID(),
          recipientId,
          CONFIG_REQUEST_EVENT_KIND,
          title,
          body,
          null,
          nowMs,
          null,
        ],
      );
      notified++;
    }
  });

  return notified;
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

/** T-0384: Payload for assistant.thread.renamed events. */
interface ThreadRenamedPayload {
  thread_id: string;
  title: string;
  /** True when the title was auto-derived from the first message (lower priority than user renames). */
  auto?: boolean;
}

/** T-0384: Payload for assistant.thread.deleted events (tombstone). */
interface ThreadDeletedPayload {
  thread_id: string;
}

/** T-0384: Payload for assistant.thread.pinned events. */
interface ThreadPinnedPayload {
  thread_id: string;
  pinned: boolean;
}

interface MessagePayload {
  thread_id: string;
  role: "user" | "assistant";
  text: string;
  context_ref: unknown | null;
  intent?: string;
  streaming_done?: boolean;
}

// ---------------------------------------------------------------------------
// T-0573 (ADR-T0573 §2.2 B2/B3): shared honest "LLM unavailable" responder.
//
// Called from BOTH failure sites — (a) llmPortFactory() throwing before any
// port is even built, and (b) ctx.llm.chat()/complete() throwing mid-dispatch
// — so a tenant owner sees the EXACT SAME persisted assistant message and the
// EXACT SAME canonical HTTP envelope regardless of which site failed. Fixes
// the T-0571 F-1 lesson: the OLD dormant-only path emitted a non-canonical
// {error:"LLM_NOT_CONFIGURED", message} (string, not {code,message} object) —
// this responder always uses the canonical sendErrorEnvelope shape.
//
// T-0595 (ADR-T0595 §1.1/§1.2, UX_REVIEW T-0573 F-1/F-2): additionally
// resolves the CALLER's admin status via the existing `loadAdminContext`
// resolver — reusing the SAME predicate that gates the admin nav-zone itself
// (src/http/org.ts:379, `isGenesisOwner || adminGrants.length > 0`) — because
// `/llm-connections` lives in that zone. Admin callers get a clickable
// deep-link descriptor (`error.deepLinks`) + path-free prose (F-2); non-admin
// callers get neither (no dead door to a screen their own nav hides) and a
// text that honestly points them at their tenant admin instead.
// ---------------------------------------------------------------------------
async function respondLlmUnavailable(
  pool: pg.Pool,
  tenantId: string,
  threadId: string,
  actorSlug: string,
  agentSlug: string,
  res: ServerResponse,
): Promise<void> {
  const admin = await loadAdminContext(pool, tenantId, actorSlug, Date.now());
  const isAdmin = admin.isGenesisOwner || admin.adminGrants.length > 0;
  const text = isAdmin
    ? ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN
    : ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN;

  // Persist an assistant message so the thread stays consistent for the user.
  const dormantMsgId = randomUUID();
  const dormantTs = Date.now();
  await withTenantTx(pool, tenantId, async (client) => {
    const payload: MessagePayload = {
      thread_id: threadId,
      role: "assistant",
      text,
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

  if (isAdmin) {
    // T-0595 (ADR-T0595 §1.2): admin envelope carries a structured deep-link
    // so the web chat can render a clickable button (same pattern as the
    // bundle-review deep-links, :2080-2085) — NOT routed through
    // sendErrorEnvelope, which stays a fixed {error:{code,message}} shape for
    // its ~10 other call sites (additive-at-the-call-site, not
    // additive-to-the-shared-signature).
    const body = JSON.stringify({
      error: {
        code: "LLM_UNAVAILABLE",
        message: text,
        // UX_REVIEW T-0595 F-1: label matches the page's FACTUAL nav/h1 title
        // «LLM-соединения» (nav-config.js:162), not a paraphrase.
        deepLinks: [{ path: "/llm-connections", label: "Открыть LLM-соединения" }],
      },
    });
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(body);
    return;
  }

  sendErrorEnvelope(res, 503, "LLM_UNAVAILABLE", text);
}

// ---------------------------------------------------------------------------
// T-0607 (г): persist an honest in-thread reply for a NON-LLM-unavailable
// dispatch failure, then STILL surface the bug as a 500 INTERNAL envelope.
//
// This reconciles TWO invariants that pull in opposite directions:
//   (г, T-0607)  every user message must get an answer OR an honest error IN THE
//                THREAD — previously a non-LLM error fell through to a bare 500
//                with NO thread message, leaving the thread silent (user message,
//                no reply, no error bubble).
//   (anti-mask, T-0573 ADR §2.2)  a plain (non-LLM-classified) error is a REAL
//                BUG and must NOT be masked as a friendly 200 — it must stay
//                visible as an INTERNAL 500 so it is not swept under the rug.
//
// The reconciliation: persist a canonical, jargon-free assistant message into
// the thread (so the chat shows a reply bubble — the thread is never mute), AND
// respond with the SAME 500 INTERNAL envelope the router would have produced (so
// the bug is still loudly visible to operators/tests). The raw error is logged
// by the caller before this is invoked.
// ---------------------------------------------------------------------------
async function persistAssistantFailureReply(
  pool: pg.Pool,
  tenantId: string,
  threadId: string,
  actorSlug: string,
  agentSlug: string,
  res: ServerResponse,
): Promise<void> {
  const text = buildDispatchFailureReply();
  try {
    await withTenantTx(pool, tenantId, async (client) => {
      const payload: MessagePayload = {
        thread_id: threadId,
        role: "assistant",
        text,
        context_ref: null,
        intent: "unknown",
        streaming_done: true,
      };
      await auditWriter.appendAuditEvent(client, {
        id: randomUUID(),
        type: "assistant.message",
        actor: agentSlug,
        subject: actorSlug,
        scope: null,
        via: null,
        proposed_by: null,
        confirmed_by: null,
        payload,
        occurred_at: Date.now(),
      });
    });
  } catch (persistErr) {
    // Even the persist failed — do not mask; the 500 below still surfaces the bug.
    console.error(`[T-0607] failed to persist dispatch-failure reply: ${String(persistErr)}`);
  }
  // Anti-mask: the underlying error is a real bug — respond with INTERNAL 500
  // (the canonical envelope the router itself uses), NOT a friendly 200.
  sendErrorEnvelope(res, 500, "INTERNAL", "internal server error");
}

interface ThreadRow {
  id: string;
  title: string;
  created_at: string;
  context_ref: unknown | null;
  message_count: number;
  /** T-0384: pin state derived from tombstone-event projection. */
  pinned: boolean;
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

/**
 * T-0384: Derive a short thread title from the first user message text.
 * Takes the first 60 characters, strips newlines, and trims whitespace.
 */
export function deriveThreadTitle(firstMessageText: string): string {
  const cleaned = firstMessageText.replace(/\s+/g, " ").trim();
  // "…" counts as 1 character, so slice(0, 59) + "…" = 60 chars total.
  return cleaned.length <= 60 ? cleaned : cleaned.slice(0, 59) + "…";
}

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

  // T-0384: Count messages per thread.
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

  // T-0384: Fetch lifecycle events (rename/delete/pin) for tombstone-event projection.
  // We query for all three event types in one pass, ordered by occurrence time
  // so we can apply them in order (last-rename-wins, any-delete tombstones).
  const { rows: lifecycleRows } = await client.query<{
    type: string;
    occurred_at: string;
    payload: unknown;
  }>(
    `SELECT type, occurred_at, payload
       FROM choros.audit_event
      WHERE type IN ('assistant.thread.renamed', 'assistant.thread.deleted', 'assistant.thread.pinned')
        AND subject = $1
        AND payload->>'thread_id' = ANY($2::text[])
      ORDER BY occurred_at ASC`,
    [userSubject, threadIds],
  );

  // Build projection maps from lifecycle events.
  // T-0384: Two-level title priority:
  //   1. User renames (auto !== true) — highest priority, last one wins.
  //   2. Auto-titles (auto === true)  — lower priority, only used if no user rename exists.
  const deletedSet = new Set<string>();
  const titleOverrides = new Map<string, string>(); // thread_id → last user rename title
  const autoTitles = new Map<string, string>();      // thread_id → last auto-title
  const pinnedMap = new Map<string, boolean>();      // thread_id → last pin state

  for (const ev of lifecycleRows) {
    const payload = ev.payload as Record<string, unknown>;
    const tid = typeof payload["thread_id"] === "string" ? payload["thread_id"] : null;
    if (!tid) continue;
    if (ev.type === "assistant.thread.deleted") {
      deletedSet.add(tid);
    } else if (ev.type === "assistant.thread.renamed") {
      const title = typeof payload["title"] === "string" ? payload["title"] : null;
      const isAuto = payload["auto"] === true;
      if (title) {
        if (isAuto) {
          autoTitles.set(tid, title);
        } else {
          // User rename — always beats auto-title regardless of occurred_at.
          titleOverrides.set(tid, title);
        }
      }
    } else if (ev.type === "assistant.thread.pinned") {
      const pinned = payload["pinned"] === true;
      pinnedMap.set(tid, pinned);
    }
  }

  // Build result: exclude deleted threads and threads with 0 messages (lazy-create).
  const result: ThreadRow[] = [];
  for (const r of rows) {
    if (deletedSet.has(r.id)) continue; // T-0384: tombstone — exclude deleted
    const msgCount = countMap.get(r.id) ?? 0;
    if (msgCount === 0) continue; // T-0384: lazy-create — hide empty threads
    const p = r.payload as ThreadPayload;
    // T-0384: title priority: user rename > auto-title > creation title > fallback
    const effectiveTitle = titleOverrides.get(r.id) ?? autoTitles.get(r.id) ?? p.title ?? "Разговор";
    result.push({
      id: r.id,
      title: effectiveTitle,
      created_at: new Date(Number(r.occurred_at)).toISOString(),
      context_ref: p.context_ref ?? null,
      message_count: msgCount,
      pinned: pinnedMap.get(r.id) ?? false,
    });
  }

  // T-0384: Sort pinned threads first, then by creation time (ASC).
  result.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.created_at < b.created_at ? -1 : 1;
  });

  return result;
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

  // T-0384: Apply tombstone-event projection for this thread.
  const { rows: lifecycleRows } = await client.query<{
    type: string;
    payload: unknown;
  }>(
    `SELECT type, payload
       FROM choros.audit_event
      WHERE type IN ('assistant.thread.renamed', 'assistant.thread.deleted', 'assistant.thread.pinned')
        AND subject = $1
        AND payload->>'thread_id' = $2
      ORDER BY occurred_at ASC`,
    [userSubject, threadId],
  );

  let deleted = false;
  let userTitleOverride: string | null = null; // from user-explicit rename events
  let autoTitleOverride: string | null = null;  // from auto-title events
  let pinned = false;

  for (const ev of lifecycleRows) {
    const payload = ev.payload as Record<string, unknown>;
    if (ev.type === "assistant.thread.deleted") {
      deleted = true;
    } else if (ev.type === "assistant.thread.renamed") {
      const title = typeof payload["title"] === "string" ? payload["title"] : null;
      const isAuto = payload["auto"] === true;
      if (title) {
        if (isAuto) {
          autoTitleOverride = title;
        } else {
          userTitleOverride = title;
        }
      }
    } else if (ev.type === "assistant.thread.pinned") {
      pinned = payload["pinned"] === true;
    }
  }

  if (deleted) return null; // T-0384: tombstone — treat as not found

  const p = row.payload as ThreadPayload;
  // T-0384: title priority: user rename > auto-title > creation title > fallback
  const effectiveTitle = userTitleOverride ?? autoTitleOverride ?? p.title ?? "Разговор";
  return {
    id: row.id,
    title: effectiveTitle,
    created_at: new Date(Number(row.occurred_at)).toISOString(),
    context_ref: p.context_ref ?? null,
    message_count: 0, // caller fills if needed
    pinned,
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
  const { pool, resolveActorTenant, llmPortFactory, spendTrackingFactory } = deps;
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
  // PATCH /api/assistant/threads/:id — T-0384: rename and/or pin a thread
  //
  // Body: { title?: string, pinned?: boolean }
  // Appends "assistant.thread.renamed" and/or "assistant.thread.pinned" events.
  // Projection in fetchThreads/fetchThread applies them (last event wins).
  // =========================================================================
  router.register(
    "PATCH",
    "/api/assistant/threads/:id",
    withAuth(async (req, res, params) => {
      const threadId = params["id"] ?? "";
      if (!threadId) throw new HttpError(400, "VALIDATION", "thread id required");

      const actorSlug = await extractActorSlug(req, pool);
      const tenantId = await resolveActorTenant(actorSlug);

      const body = (await readJsonBody(req)) as {
        title?: string;
        pinned?: boolean;
      };

      const hasTitle = body.title !== undefined;
      const hasPinned = body.pinned !== undefined;
      if (!hasTitle && !hasPinned) {
        throw new HttpError(400, "VALIDATION", "at least one of title or pinned must be provided");
      }

      const newTitle = hasTitle ? String(body.title ?? "").slice(0, 256).trim() : null;
      if (hasTitle && !newTitle) {
        throw new HttpError(400, "VALIDATION", "title must be a non-empty string");
      }

      await withTenantTx(pool, tenantId, async (client) => {
        // Verify thread ownership (fetchThread returns null for deleted threads).
        const thread = await fetchThread(client, threadId, actorSlug);
        if (!thread) throw new HttpError(404, "NOT_FOUND", "thread not found");

        const now = Date.now();

        if (hasTitle && newTitle) {
          // Append a thread.renamed event (tombstone-event projection).
          const renamedPayload: ThreadRenamedPayload = { thread_id: threadId, title: newTitle };
          await auditWriter.appendAuditEvent(client, {
            id: randomUUID(),
            type: "assistant.thread.renamed",
            actor: actorSlug,
            subject: actorSlug,
            scope: null,
            via: null,
            proposed_by: null,
            confirmed_by: null,
            payload: renamedPayload,
            occurred_at: now,
          });
        }

        if (hasPinned) {
          // Append a thread.pinned event (tombstone-event projection).
          const pinnedPayload: ThreadPinnedPayload = { thread_id: threadId, pinned: Boolean(body.pinned) };
          await auditWriter.appendAuditEvent(client, {
            id: randomUUID(),
            type: "assistant.thread.pinned",
            actor: actorSlug,
            subject: actorSlug,
            scope: null,
            via: null,
            proposed_by: null,
            confirmed_by: null,
            payload: pinnedPayload,
            occurred_at: hasPinned && hasTitle ? now + 1 : now, // avoid same-ms ordering ambiguity
          });
        }
      });

      res.statusCode = 204;
      res.end();
    }),
  );

  // =========================================================================
  // DELETE /api/assistant/threads/:id — T-0384: logical delete (tombstone)
  //
  // Appends "assistant.thread.deleted" event. The thread is excluded from
  // GET /api/assistant/threads projections. Messages are NOT deleted — they
  // remain in audit_event (append-only invariant).
  // =========================================================================
  router.register(
    "DELETE",
    "/api/assistant/threads/:id",
    withAuth(async (req, res, params) => {
      const threadId = params["id"] ?? "";
      if (!threadId) throw new HttpError(400, "VALIDATION", "thread id required");

      const actorSlug = await extractActorSlug(req, pool);
      const tenantId = await resolveActorTenant(actorSlug);

      await withTenantTx(pool, tenantId, async (client) => {
        // Verify thread ownership (fetchThread returns null for already-deleted threads).
        const thread = await fetchThread(client, threadId, actorSlug);
        if (!thread) throw new HttpError(404, "NOT_FOUND", "thread not found");

        // Append a thread.deleted tombstone event.
        const deletedPayload: ThreadDeletedPayload = { thread_id: threadId };
        await auditWriter.appendAuditEvent(client, {
          id: randomUUID(),
          type: "assistant.thread.deleted",
          actor: actorSlug,
          subject: actorSlug,
          scope: null,
          via: null,
          proposed_by: null,
          confirmed_by: null,
          payload: deletedPayload,
          occurred_at: Date.now(),
        });
      });

      res.statusCode = 204;
      res.end();
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
      // 1. Verify thread ownership + check if this is the first message.
      // -----------------------------------------------------------------------
      let isFirstMessage = false;
      await withTenantTx(pool, tenantId, async (client) => {
        // fetchThread returns null for deleted threads (tombstone-event projection).
        const thread = await fetchThread(client, threadId, actorSlug);
        if (!thread) throw new HttpError(404, "NOT_FOUND", "thread not found");

        // T-0384: Check message count to detect first message for auto-title.
        const { rows: cntRows } = await client.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt
             FROM choros.audit_event
            WHERE type = 'assistant.message'
              AND payload->>'thread_id' = $1
              AND subject = $2`,
          [threadId, actorSlug],
        );
        isFirstMessage = (Number(cntRows[0]?.cnt ?? 0)) === 0;
      });

      // -----------------------------------------------------------------------
      // 2. Resolve the LLM port.
      // -----------------------------------------------------------------------
      // T-0382: factory is now async (per-tenant agent_card config lookup).
      // T-0477 [E-AGENTS L5]: wrap with spend-tracking (non-fatal ledger write).
      // T-0573 (ADR-T0573 §2.2 B2): the factory build itself can throw a
      // classifiable LLM-unavailability error (e.g. config-resolution failure)
      // — caught HERE too, not just around the dispatch call below, so BOTH
      // failure sites answer with the SAME honest 503 (never a raw INTERNAL).
      let llm: LlmPort;
      try {
        llm = await llmPortFactory(tenantId);
      } catch (err) {
        if (classifyLlmUnavailability(err) === "unavailable") {
          await respondLlmUnavailable(pool, tenantId, threadId, actorSlug, agentSlug, res);
          return;
        }
        throw err;
      }
      if (spendTrackingFactory) {
        try {
          const spendCtx = await spendTrackingFactory(tenantId);
          if (spendCtx !== null) {
            llm = new SpendTrackingLlmPort(llm, {
              ...spendCtx,
              actorSlug: actorSlug,
            });
          }
        } catch (err) {
          // Non-fatal: spend-tracking setup failure must never break chat.
          console.error(`[T-0477] spendTrackingFactory failed (non-fatal): ${String(err)}`);
        }
      }

      // -----------------------------------------------------------------------
      // 3. Persist the user message (outside LLM call — do not lose it if LLM fails).
      //    T-0384: If this is the first message, also append a thread.renamed event
      //    with a title derived from the message text (auto-title).
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

        // T-0384: Auto-title — fire a thread.renamed event on the first message.
        // auto: true marks it as system-generated (lower priority than user renames
        // in the projection, regardless of occurred_at ordering).
        if (isFirstMessage) {
          const autoTitle = deriveThreadTitle(userText);
          const renamedPayload: ThreadRenamedPayload = {
            thread_id: threadId,
            title: autoTitle,
            auto: true,
          };
          await auditWriter.appendAuditEvent(client, {
            id: randomUUID(),
            type: "assistant.thread.renamed",
            actor: actorSlug,
            subject: actorSlug,
            scope: null,
            via: null,
            proposed_by: null,
            confirmed_by: null,
            payload: renamedPayload,
            occurred_at: userMsgTs + 1, // +1ms so it sorts after the message
          });
        }
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
        // T-0607 (б): server-side owner predicate for the deterministic rights
        // gate — the SAME isGenesisOwnerForTenant resolver the honest-503 path
        // uses. Memoised per request. The configurator gate applies the owner
        // short-circuit so a genesis OWNER is never falsely refused.
        isTenantOwner: (() => {
          let cached: Promise<boolean> | null = null;
          return () => {
            if (cached === null) {
              cached = isGenesisOwnerForTenant(pool, tenantId, actorSlug, Date.now()).catch(
                () => false,
              );
            }
            return cached;
          };
        })(),
      };

      // -----------------------------------------------------------------------
      // 5. Dispatch to intent handler.
      //    T-0573: classifyLlmUnavailability(err) === "unavailable" → 503
      //    (no crash, honest-degrade; covers BOTH dormant AND adapter-failure).
      //    T-0363 (d): for CONFIGURATOR intent, call runConfigurator to get the
      //    full ConfiguratorResult so approvedOps can be persisted as DRAFT.
      //    For other intents, use the regular intentDispatch path.
      // -----------------------------------------------------------------------
      let handlerResult;
      try {
        const detectedIntent = classifyIntent(userText);
        if (detectedIntent === "configurator") {
          // T-0363 (d): run the full configurator loop to get approvedOps.
          // T-0383 (D5): load the per-tenant configurator system prompt override.
          const cfgPromptOverride = await readPublishedAssistantPrompt(pool, tenantId, "configurator").catch(() => null);
          // T-0463 (D8-G2): supply existing registry_defs so relation cascades dedup
          // against existing apps (PD-5) — same candidate list the visual picker uses.
          const cfgCandidates = await fetchRegistryDefCandidates(pool, tenantId).catch(() => []);
          // T-0724: same-turn data for the list_registries introspection tool
          // (reuses listRegistryDefs — the human bind-form picker's own DAO).
          const cfgRegistryList = await fetchRegistryListCandidates(pool, tenantId).catch(() => []);
          const cfgResult = await runConfigurator(
            userText,
            handlerCtx,
            cfgPromptOverride,
            cfgCandidates,
            cfgRegistryList,
          );
          handlerResult = { text: cfgResult.text, intent: "configurator" as const };

          // T-0466 (D8-G5): capture-as-request. When the user lacks authoring_draft
          // and described something configurable, runConfigurator returns a
          // captureRequest. File it as a config-request notification to admins so
          // the intent is not lost. Non-fatal — a routing failure must not 500 the
          // honest refusal the user already got.
          if (cfgResult.captureRequest) {
            try {
              const notified = await captureConfigRequest(
                pool,
                tenantId,
                actorSlug,
                cfgResult.captureRequest.description,
              );
              handlerResult = {
                // Truthful: confirm delivery only when someone actually received it.
                text:
                  notified > 0
                    ? cfgResult.text + " " + AUTHORING_CAPTURE_CONFIRMATION
                    : cfgResult.text +
                      "\n\n(Пока некому передать заявку — в пространстве нет администратора с правами настройки.)",
                intent: "configurator" as const,
              };
            } catch (capErr) {
              console.error(`[T-0466] capture-as-request failed: ${String(capErr)}`);
              handlerResult = {
                text:
                  cfgResult.text +
                  "\n\n(Не удалось автоматически передать заявку администратору — обратитесь к нему напрямую.)",
                intent: "configurator" as const,
              };
            }
          }

          // Execute approvedOps as DRAFT (non-destructive; destructive ops are in blockedOps).
          // T-0464 (D8-G3): generate_process needs the live LLM port + the resolved
          // configurator system prompt to run the generate→validate→repair loop.
          const genCtx = {
            llm,
            systemPrompt: cfgPromptOverride && cfgPromptOverride.trim()
              ? cfgPromptOverride
              : CONFIGURATOR_DEFAULT_SYSTEM_PROMPT,
          };

          // T-0465 (D8-G4): ONE-SHOT BUNDLE. If this confirmed turn generates any
          // bundle-worthy artifact, mint a single bundle_id so every DRAFT artifact
          // (app + cascaded apps + process) is tagged into ONE promote unit. Plan-only
          // turns (propose_plan, no approvedOps) mint NOTHING — no premature writes.
          const hasBundleOps = cfgResult.approvedOps.some((o) => BUNDLE_OP_KINDS.has(o.kind));
          const bundleId = hasBundleOps ? randomUUID() : undefined;

          // T-0607 (в2): collect the REAL per-op outcome (ok / fail / duplicate)
          // so the final report reflects what actually happened — not the LLM's
          // optimistic «✅» nor the pure-planner's pre-execution changelog.
          const opResults: OpResult[] = [];
          for (const op of cfgResult.approvedOps) {
            const err = await executeApprovedOpAsDraft(
              pool,
              tenantId,
              op,
              op.kind === "generate_process" ? genCtx : undefined,
              // Tag bundle-worthy ops with the shared id; others stay un-bundled.
              BUNDLE_OP_KINDS.has(op.kind) ? bundleId : undefined,
              // T-0743: apply_form_document_op reuses checkRole (process_designer/
              // owner) — needs the acting user's identity, not just tenantId.
              actorSlug,
            );
            if (err === null) {
              opResults.push({ description: op.description, ok: true });
            } else {
              console.error(`[T-0363] draft op failed (${op.kind}): ${err}`);
              // A "DUPLICATE:" prefix marks a benign already-exists outcome that
              // the report shows as «уже было», not «не создано».
              const isDup = err.startsWith("DUPLICATE:");
              const reason = isDup ? err.slice("DUPLICATE:".length).trim() : err;
              opResults.push({
                description: op.description,
                ok: false,
                error: reason,
                duplicate: isDup,
              });
            }
          }

          // T-0465: REVIEW-IN-SECTIONS — build deep-links + bundle-promote descriptor
          // from the tagged rows. Chat carries LINKS, not an in-chat constructor.
          if (bundleId) {
            const { deepLinks, bundlePromote } = await resolveBundleReview(pool, tenantId, bundleId);
            if (deepLinks.length > 0 || bundlePromote) {
              handlerResult = {
                ...handlerResult,
                deepLinks,
                bundlePromote: bundlePromote ?? undefined,
                // Append a plain-text fallback so non-structured clients still see links.
                text:
                  handlerResult.text +
                  "\n\nРешение собрано черновиком. Откройте разделы для визуального ревью:\n" +
                  deepLinks.map((l) => `• ${l.label} — ${l.path}`).join("\n") +
                  (bundlePromote
                    ? `\n\nКогда проверите — опубликуйте всё решение одним действием (${bundlePromote.itemCount} элементов).`
                    : ""),
              };
            }
          }

          // T-0607 (в2): reconcile the reply with the REAL op outcomes. When any
          // op failed, the honest report replaces the optimistic «✅»-style text
          // with a truthful partial-result summary (failed ops shown as failed,
          // duplicates shown as «уже было»). When everything succeeded the text
          // is unchanged. This is the fix for «Все поля добавлены ✅» over 4/4
          // FAILED ops.
          const honestText = buildHonestOpsReport(handlerResult.text, opResults);
          if (honestText !== handlerResult.text) {
            handlerResult = {
              ...handlerResult,
              text: honestText,
              intent: "configurator" as const,
            };
          }
        } else {
          handlerResult = await intentDispatch(userText, handlerCtx);
        }
      } catch (err) {
        // T-0573 (ADR-T0573 §2.2 B2, F5/AC-5): classify by TYPE — dormant (no
        // config) AND adapter-failure (config exists, call failed) both answer
        // with the SAME honest 503 (respondLlmUnavailable persists a thread
        // message AND returns the canonical envelope).
        if (classifyLlmUnavailability(err) === "unavailable") {
          await respondLlmUnavailable(pool, tenantId, threadId, actorSlug, agentSlug, res);
          return;
        }
        // T-0607 (г): every user message must get an answer OR an honest error
        // IN THE THREAD. Previously any OTHER error fell through to `throw err`,
        // which the router turned into a bare 500 WITHOUT persisting any assistant
        // message — the thread stayed silent (user message with no reply, no
        // error bubble). Now we persist a canonical, jargon-free assistant reply
        // into the thread (raw err logged server-side only) and respond with the
        // same honest text. The thread is never left mute.
        console.error(`[T-0607] assistant dispatch failed (non-LLM): ${String(err)}`);
        await persistAssistantFailureReply(
          pool, tenantId, threadId, actorSlug, agentSlug, res,
        );
        return;
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
          // T-0465 (D8-G4): REVIEW-IN-SECTIONS. Structured deep-links into the actual
          // sections (Приложения / Модельер) + a bundle-promote descriptor. Present
          // ONLY when a bundle was generated this turn. The web chat renders these as
          // clickable links + a "publish whole solution" button — NOT a chat constructor.
          ...("deepLinks" in handlerResult && handlerResult.deepLinks
            ? { deepLinks: handlerResult.deepLinks }
            : {}),
          ...("bundlePromote" in handlerResult && handlerResult.bundlePromote
            ? { bundlePromote: handlerResult.bundlePromote }
            : {}),
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
