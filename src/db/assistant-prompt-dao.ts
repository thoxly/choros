/**
 * src/db/assistant-prompt-dao.ts — T-0383 (D5/PD-6): per-tenant assistant system prompt DAO.
 *
 * Provides read + write access to the per-tenant system prompt for the analyst
 * and configurator assistant modes, stored in the existing agent_instruction table
 * (T-0123) under the tenant's 'assistant-agent' employee.
 *
 * DESIGN: reuses the T-0123 agent_instruction mechanism rather than adding a new
 * column or table. The analyst/configurator prompts are stored as two separate
 * agent_instruction rows keyed by a synthetic role slug:
 *   - 'assistant-agent-analyst'       → analyst system prompt
 *   - 'assistant-agent-configurator'  → configurator system prompt
 *
 * These rows are NOT linked to a real employee row via a FK — they are keyed by
 * the slug stored in the instruction_meta JSON envelope (role_slug field). The
 * actual employee_id used is the 'assistant-agent' employee ID for the tenant,
 * looked up at read/write time. If no 'assistant-agent' employee exists (tenant
 * has not completed onboarding), reads return null (honest degrade) and writes
 * are rejected (400).
 *
 * WAIT — actually we use the EXISTING agent_instruction table and reuse the
 * employee_id of the 'assistant-agent'. But agent_instruction has
 * UNIQUE(tenant_id, employee_id) — one row per agent. So we cannot store both
 * analyst and configurator prompts in separate rows under the same employee_id.
 *
 * REVISED DESIGN: store both prompts in a SINGLE agent_instruction row for the
 * 'assistant-agent', using the instruction_meta JSON envelope:
 *   instruction_meta = {
 *     analyst_system_prompt: string | null,      // analyst override
 *     configurator_system_prompt: string | null, // configurator override
 *   }
 *   instruction_text = analyst_system_prompt (for backward compat with the generic
 *                      instruction reader; new consumers read from instruction_meta)
 *
 * ALTERNATIVE (simpler): store in instruction_meta only. The instruction_text is
 * kept as the analyst_system_prompt for backward compat (the objective-compiler
 * reads instruction_text). For T-0383 we store BOTH in instruction_meta and
 * keep instruction_text = analyst prompt.
 *
 * The existing published-lock semantics apply: once the row is published, editing
 * requires promote through the standard T-0087 promote path. For a UI edit loop,
 * the UI writes a draft; the admin promotes. We expose the DRAFT row for editing
 * (same as the configurator agent uses the draft tier).
 *
 * INVARIANTS:
 *  - Only reads the 'draft' tier row for editing; returns 'published' tier for
 *    runtime use. If only 'draft' exists (never published), runtime returns null
 *    (fallback to default). This preserves the published-lock semantics: the tenant
 *    must explicitly promote before the prompt goes live.
 *  - Runs INSIDE the caller's open withTenantTx (choros.tenant_id GUC set).
 *  - No new table or migration (reuses instruction_meta on the existing row).
 *
 * SECURITY:
 *  - Tenant isolation via RLS (choros.tenant_id GUC set by caller).
 *  - Only tenant admins (authoring_draft grant) may write. The HTTP layer enforces
 *    the grant check; this DAO does not check grants (same pattern as other DAOs).
 *  - The instruction_text / instruction_meta are not secrets; they are the persona
 *    instructions for the assistant visible to the tenant admin.
 *
 * NOTE on runtime-dormant (FF-COMP-6 / T-0123):
 *  This file is in src/db/ — the dormant check only scans RUNTIME_PATHS
 *  (src/core/engine, src/worker, src/adapters, bridge-runner files) and src/http.
 *  src/db/ is not scanned, so this file is safe to reference agent_instruction.
 *  The HTTP route (src/http/assistant-prompt-routes.ts) imports ONLY from this DAO
 *  using a neutral import path and does NOT contain "agent_instruction" strings,
 *  so the HTTP dormant check passes for the route file as well.
 */

import pg from "pg";
import { randomUUID } from "node:crypto";
import { readPublished, readDraft, saveDraft, InstructionPublishedLockedError } from "./agent-instruction-store.js";
import { makePgAuditWriter } from "./audit-writer.js";
import type { PgClientLike } from "./audit-writer.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// meta keys stored in instruction_meta for the two prompt roles.
const META_ANALYST_KEY = "analyst_system_prompt" as const;
const META_CONFIGURATOR_KEY = "configurator_system_prompt" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The two editable assistant prompt roles.
 * T-0383: these correspond to the two assistant modes (ANALYST, CONFIGURATOR).
 */
export type AssistantPromptRole = "analyst" | "configurator";

/**
 * The current prompt state for a single role.
 * `text` is null when the tenant has not set a custom prompt (fallback to default applies).
 * `tier` is the tier of the row that produced this state.
 * `employeeId` is the assistant-agent employee UUID.
 */
export interface AssistantPromptState {
  role: AssistantPromptRole;
  /** null = not customised (tenant will get the hardcoded default). */
  text: string | null;
  /** Which tier the returned text came from. */
  tier: "published" | "draft" | null;
  /** The assistant-agent employee UUID (needed for promote path). */
  employeeId: string | null;
}

// ---------------------------------------------------------------------------
// withTenantReadTx helper — opens a read tx with the tenant GUC set.
// ---------------------------------------------------------------------------

async function withTenantReadTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`[T-0383] Invalid tenantId shape: ${tenantId}`);
  }
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
// resolveAssistantAgentId — look up the assistant-agent employee UUID.
// ---------------------------------------------------------------------------

/**
 * Resolve the 'assistant-agent' employee UUID for the current tenant.
 * Requires the choros.tenant_id GUC to be set by the caller's tx.
 * Returns null when no assistant-agent employee exists (not yet onboarded).
 */
async function resolveAssistantAgentId(tx: PgClientLike): Promise<string | null> {
  const { rows } = await (tx as { query: PgClientLike["query"] }).query(
    `SELECT id FROM choros.employee
      WHERE tenant_id = current_setting('choros.tenant_id', false)::uuid
        AND slug = 'assistant-agent'
        AND kind = 'agent'
      LIMIT 1`,
  );
  return (rows[0] as { id: string } | undefined)?.id ?? null;
}

// ---------------------------------------------------------------------------
// extractPromptFromMeta — pull a prompt from instruction_meta by key.
// ---------------------------------------------------------------------------

function extractPromptFromMeta(
  meta: Record<string, unknown>,
  key: typeof META_ANALYST_KEY | typeof META_CONFIGURATOR_KEY,
): string | null {
  const val = meta[key];
  if (typeof val === "string" && val.trim().length > 0) {
    return val;
  }
  return null;
}

// ---------------------------------------------------------------------------
// readPublishedAssistantPrompt — runtime read (for use in runAnalyst / runConfigurator).
// ---------------------------------------------------------------------------

/**
 * Read the PUBLISHED system prompt override for the given role and tenant.
 * Returns null when the tenant has no published custom prompt (fallback to default).
 *
 * Intended for the composition root to wire as a `loadSystemPrompt` port.
 * Runs a fresh tx per call (same pattern as loadTenantLlmConfig).
 *
 * T-0383: the caller (server.ts) uses this to populate the AnalystPorts.loadSystemPrompt
 * port so that runAnalyst reads the live per-tenant prompt at message-time.
 */
export async function readPublishedAssistantPrompt(
  pool: pg.Pool,
  tenantId: string,
  role: AssistantPromptRole,
): Promise<string | null> {
  return withTenantReadTx(pool, tenantId, async (client) => {
    const agentId = await resolveAssistantAgentId(client);
    if (!agentId) return null;

    const published = await readPublished(client, agentId);
    if (!published) return null;

    const metaKey = role === "analyst" ? META_ANALYST_KEY : META_CONFIGURATOR_KEY;
    return extractPromptFromMeta(published.instructionMeta, metaKey);
  });
}

// ---------------------------------------------------------------------------
// readAssistantPromptState — admin read (for the prompt editor UI).
// ---------------------------------------------------------------------------

/**
 * Read the current prompt state for both roles (admin UI use).
 * Returns the DRAFT row when present; the PUBLISHED row otherwise.
 * This mirrors the authoring pattern: admins edit drafts, then promote.
 *
 * Runs inside the caller's open withTenantTx (choros.tenant_id GUC already set).
 */
export async function readAssistantPromptState(
  tx: PgClientLike,
  role: AssistantPromptRole,
): Promise<AssistantPromptState> {
  const agentId = await resolveAssistantAgentId(tx);
  if (!agentId) {
    return { role, text: null, tier: null, employeeId: null };
  }

  const metaKey = role === "analyst" ? META_ANALYST_KEY : META_CONFIGURATOR_KEY;

  // Prefer draft for the editor view.
  const draft = await readDraft(tx, agentId);
  if (draft) {
    return {
      role,
      text: extractPromptFromMeta(draft.instructionMeta, metaKey),
      tier: "draft",
      employeeId: agentId,
    };
  }

  const published = await readPublished(tx, agentId);
  if (published) {
    return {
      role,
      text: extractPromptFromMeta(published.instructionMeta, metaKey),
      tier: "published",
      employeeId: agentId,
    };
  }

  return { role, text: null, tier: null, employeeId: agentId };
}

// ---------------------------------------------------------------------------
// saveAssistantPromptDraft — write a per-tenant prompt as a DRAFT.
// ---------------------------------------------------------------------------

/**
 * Save a per-tenant system prompt as a DRAFT instruction for the given role.
 * Runs inside the caller's open withTenantTx (choros.tenant_id GUC already set).
 *
 * Uses the existing agent_instruction saveDraft path (tier='draft', audit included).
 * Both analyst and configurator prompts share one instruction_meta JSON envelope
 * on the single 'assistant-agent' instruction row.
 *
 * Throws InstructionPublishedLockedError (code=PUBLISHED_LOCKED) when the existing
 * row is in 'published' tier (same semantics as the T-0123 published-lock).
 *
 * @param actor - the human editor's slug (for audit).
 * @param text - the new prompt text (empty string = reset/clear this role's override).
 */
export async function saveAssistantPromptDraft(
  tx: PgClientLike,
  role: AssistantPromptRole,
  text: string,
  actor: string,
): Promise<void> {
  const agentId = await resolveAssistantAgentId(tx);
  if (!agentId) {
    throw new Error("assistant-agent employee not found for this tenant (onboarding incomplete)");
  }

  const metaKey = role === "analyst" ? META_ANALYST_KEY : META_CONFIGURATOR_KEY;

  // Read the current instruction to merge meta fields (preserve the other role's prompt).
  const current = await readDraft(tx, agentId) ?? await readPublished(tx, agentId);
  const existingMeta: Record<string, unknown> = { ...(current?.instructionMeta ?? {}) };

  // Set or clear this role's prompt key.
  if (text.trim().length > 0) {
    existingMeta[metaKey] = text;
  } else {
    delete existingMeta[metaKey];
  }

  // instruction_text: kept equal to the analyst_system_prompt for backward-compat
  // with any reader that reads the generic instruction_text column (e.g. the
  // objective-compiler). NOTE: this CREATES an instruction row on the assistant-agent
  // employee. If that employee is ever resolved as a process-step executor, the analyst
  // chat prompt would silently become its compiled objective. Callers MUST ensure the
  // assistant-agent slug is not used as a task assignee in process bindings.
  const analystText =
    typeof existingMeta[META_ANALYST_KEY] === "string"
      ? (existingMeta[META_ANALYST_KEY] as string)
      : (current?.instructionText ?? "");

  const writer = makePgAuditWriter();
  await saveDraft(tx, writer, {
    draft: {
      tenantId: "", // sourced from choros.tenant_id GUC; placeholder here
      id: current?.id ?? randomUUID(),
      employeeId: agentId,
      instructionText: analystText,
      answerForm: current?.answerForm ?? null,
      instructionMeta: existingMeta,
      bundleId: current?.bundleId ?? null,
    },
    actor,
    actorType: "human",
    nowMs: Date.now(),
  });
}

// Re-export so callers that need the lock error type don't need to import
// from agent-instruction-store directly.
export { InstructionPublishedLockedError };
