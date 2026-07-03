/**
 * src/core/assistant-analyst.ts — T-0360 (E17): ANALYST mode handler.
 *
 * PURE ORCHESTRATION — given a HandlerContext (with intersectionGrants, ancestry,
 * llm) + the S3 transition-journal types, assembles an ephemeral ReportDraft by:
 *   1. Asking the LLM to classify the analytical query and extract entity context.
 *   2. Reading records (within the asker's ACL via intersectionGrants) using
 *      ResolveSubject + a minimal RecordSource shim that lists tenant records.
 *   3. Reading S3 journal metrics (cycle-time / actor-type) — passed in via
 *      AnalystReadPorts so the pure core never imports pg directly.
 *   4. Composing a structured ReportDraft for the LLM synthesis call.
 *   5. Returning an ephemeral HandlerResult with a save-proposal hint.
 *
 * SECURITY INVARIANTS (must hold — enforced structurally):
 *   - NO business writes: this module has ZERO create/update/delete calls.
 *     The only write surface exported is the optional audit-emit callback.
 *     A test can assert this by mocking the write ports as throw-if-called.
 *   - ACL-scoped: all record lists go through `resolveRecordList`, which accepts
 *     only the intersection GrantSource from HandlerContext. Callers that bypass
 *     intersectionGrants cannot call into this module.
 *   - Audited: every analyst read emits one "assistant.analyst.read" audit event
 *     via the injected `emitAudit` callback — same pattern as assistant.ts.
 *   - $0 cost: LLM calls go through the injected LlmPort; in test mode the
 *     caller injects StubChatLlmPort (zero network, deterministic).
 *   - No IO imports: this module MUST NOT import pg, node:http, node:https,
 *     node:net, node:fetch, child_process, or process.env.
 *     DB-bound ports arrive as injected function parameters.
 *
 * DB PATHS: `loadCycleTimeByActivity` and `loadActorTypeBreakdown` from
 * src/db/transition-journal.ts need a live Postgres pool. Tests that exercise the
 * ACL logic pass in-memory stubs; DB-path integration is marked NOT TESTED (needs
 * server PG — same caveat as fitness:db tests).
 *
 * WAVE 2 PARALLELISM: only `handleAnalyst` (the IntentHandler) is exported.
 * The sibling T-0361 (configurator) fills `handleConfigurator`; neither touches
 * assistant.ts.
 */

import { canonicalizeLlmError, classifyLlmUnavailability, type LlmPort } from "./llm-port.js";
import type { GrantSource } from "./grant-resolver.js";
import type { HandlerContext, HandlerResult } from "./assistant-intent.js";
import type { AncestryOracle } from "./grant-lattice.js";
import type { ResolveSubject } from "./object-handle.js";
import type {
  CycleTimeAnalytics,
  ActorTypeBreakdown,
} from "../db/transition-journal.js";
// T-0607 (а): the actor-rights registry digest — the analyst's honest view of
// the entity data the asker may READ (счёт + примеры в правах), through the SAME
// READ-PDP path the records LIST endpoint uses.
import type { ReadableRegistryDigest } from "../db/registry-digest-dao.js";

// ---------------------------------------------------------------------------
// ReportDraft — ephemeral in-memory shape; never persisted here.
// Saved to report_page via the EXISTING POST /api/report-pages route (T-0121).
// ---------------------------------------------------------------------------

/**
 * Ephemeral report draft produced by the analyst for a single query.
 * The LLM synthesizes the final text from this draft; the handlerResult.text
 * includes a save-proposal hint ("сохранить как Отчёт?").
 */
export interface ReportDraft {
  /** The user's original query (for context in the LLM synthesis call). */
  readonly userQuery: string;
  /** Records visible to the asker (ACL-filtered), as field maps. */
  readonly records: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** Cycle-time analytics from the S3 journal (may be null if no journal data). */
  readonly cycleTime: CycleTimeAnalytics | null;
  /** Actor-type breakdown from the S3 journal (may be empty). */
  readonly actorBreakdown: readonly ActorTypeBreakdown[];
  /**
   * T-0607 (а): the actor-rights registry digest — readable registries with
   * count + samples. `null` when the digest port is not wired (test/stub);
   * `degraded:true` when the read failed (the context must NOT then claim
   * «записей нет»). This is the ENTITY-data view the analyst was previously
   * blind to (столп 6).
   */
  readonly registryDigest: ReadableRegistryDigest | null;
  /**
   * T-0607 (д): whether the user's query is explicitly about PROCESS analytics
   * (cycle time / bottleneck / stages). Only then does the S3-journal telemetry
   * enter the LLM context — internal telemetry is not offered to the user as an
   * explanation for a plain data question.
   */
  readonly isProcessAnalytics: boolean;
  /** Tenant ID these results are scoped to. */
  readonly tenantId: string;
}

// ---------------------------------------------------------------------------
// AnalystReadPorts — injected DB ports (no pg import in this module).
// ---------------------------------------------------------------------------

/**
 * Minimal listing port: returns raw field maps for records in the given tenant
 * that the asker's intersectionGrants allow reading. MUST be filtered by ACL
 * before returning — see makeAclRecordLister() below.
 *
 * DB-untested note: in production this is wired to the PG records table via
 * the records.ts READ path. In tests, callers supply an in-memory stub.
 */
export type RecordLister = (
  tenantId: string,
  intersectionGrants: GrantSource,
  ancestry: AncestryOracle,
  userSubject: ResolveSubject,
) => Promise<ReadonlyArray<Readonly<Record<string, unknown>>>>;

/**
 * Cycle-time analytics loader from S3 journal.
 * DB-untested: wired to loadCycleTimeByActivity in production.
 */
export type CycleTimeLister = (tenantId: string) => Promise<CycleTimeAnalytics>;

/**
 * Actor-type breakdown loader from S3 journal.
 * DB-untested: wired to loadActorTypeBreakdown in production.
 */
export type ActorBreakdownLister = (tenantId: string) => Promise<ActorTypeBreakdown[]>;

/**
 * T-0607 (а): actor-rights registry-digest loader. Returns the readable-registry
 * digest for the asker (count + samples), through the READ-PDP path. `null` when
 * not wired (test/stub → the analyst has no entity view, and must NOT claim
 * «записей нет»). DB-wired in production to loadReadableRegistryDigest.
 */
export type RegistryDigestLister = (
  tenantId: string,
  actorSlug: string,
) => Promise<ReadableRegistryDigest | null>;

/**
 * Optional audit emitter. Called ONCE per analyst invocation with a structured
 * read-event payload. The same pattern as appendAuditEvent in assistant.ts:
 * callers supply the tx-aware writer; the pure core only calls the callback.
 */
export type AnalystAuditEmitter = (event: {
  type: string;
  actor: string;
  subject: string;
  payload: Record<string, unknown>;
  occurred_at: number;
}) => Promise<void>;

/**
 * All injected ports for the analyst handler.
 * Every port has a safe no-op default for $0 / stub mode (see defaults below).
 */
export interface AnalystPorts {
  /** List records accessible to the asker. Default: returns []. */
  listRecords?: RecordLister;
  /** Load cycle-time analytics. Default: returns null (no journal data). */
  loadCycleTime?: CycleTimeLister;
  /** Load actor-type breakdown. Default: returns []. */
  loadActorBreakdown?: ActorBreakdownLister;
  /**
   * T-0607 (а): load the actor-rights registry digest. Default: returns null
   * (analyst has no entity view). Production wiring: assistant-analyst reads the
   * READ-PDP-scoped digest via loadReadableRegistryDigest.
   */
  loadRegistryDigest?: RegistryDigestLister;
  /**
   * Emit an audit event for the analyst read. Default: no-op.
   * Production wiring: assistant.ts supplies the auditWriter.appendAuditEvent
   * bound to the current tenant tx — the same audit pattern as every other route.
   */
  emitAudit?: AnalystAuditEmitter;
  /**
   * Load the per-tenant system prompt override for the analyst.
   * Default: null (falls back to ANALYST_DEFAULT_SYSTEM_PROMPT).
   * Production wiring: composition root supplies a loader that reads the published
   * agent_instruction for the tenant's primary assistant-agent, if present.
   * T-0383 (D5/PD-6): per-tenant editable system prompt (B10).
   */
  loadSystemPrompt?: (tenantId: string) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Safe port defaults (used when a port is not injected — $0 / test mode).
// ---------------------------------------------------------------------------

const defaultListRecords: RecordLister = async () => [];

const defaultLoadCycleTime: CycleTimeLister = async (tenantId) => ({
  tenant_id: tenantId,
  bottleneck: null,
  rows: [],
});

const defaultLoadActorBreakdown: ActorBreakdownLister = async () => [];

// T-0607 (а): default digest port returns null → the analyst has NO entity view
// and MUST NOT claim «записей нет» (buildDraftContext honours registryDigest===null).
const defaultLoadRegistryDigest: RegistryDigestLister = async () => null;

const defaultLoadSystemPrompt = async (_tenantId: string): Promise<string | null> => null;

const defaultEmitAudit: AnalystAuditEmitter = async () => {
  // no-op in test/stub mode
};

// ---------------------------------------------------------------------------
// ANALYST_DEFAULT_SYSTEM_PROMPT — hardcoded fallback (T-0383: backward-compat).
//
// Used when the tenant has no per-tenant override stored in agent_instruction.
// Exported so the HTTP route can display the default for tenants that haven't
// customised it yet.
// ---------------------------------------------------------------------------

/**
 * The default (hardcoded) analyst system prompt.
 * Tenants that have not set a custom prompt get this text verbatim.
 * T-0383: this constant is the single source of truth for the default; the
 * UI shows it in the prompt editor as placeholder/pre-fill when unset.
 */
export const ANALYST_DEFAULT_SYSTEM_PROMPT =
  "Ты аналитик-ассистент в системе Choros.\n" +
  "Твоя роль — ТОЛЬКО читать и анализировать данные. " +
  "Ты НИКОГДА не создаёшь, не обновляешь и не удаляешь бизнес-записи.\n" +
  "Если пользователь просит выполнить действие (например, запустить процесс), " +
  "ты можешь ПРЕДЛОЖИТЬ («запустить процесс X?»), но НЕ выполняешь его — " +
  "это подтверждает человек через существующий интерфейс.\n" +
  "Отвечай по-русски, структурированно и честно. " +
  "В конце добавь предложение сохранить отчёт, если анализ был содержательным.";

// ---------------------------------------------------------------------------
// buildAnalystSystemPrompt — system context for the LLM synthesis call.
// T-0383: now accepts a per-tenant override (from agent_instruction published row).
// Falls back to ANALYST_DEFAULT_SYSTEM_PROMPT when override is absent/null.
// The tenantId suffix appended to the default is kept for context; the override
// is used verbatim so the tenant can include or omit tenantId as they choose.
// ---------------------------------------------------------------------------

function buildAnalystSystemPrompt(tenantId: string, override: string | null): string {
  if (override !== null && override.trim().length > 0) {
    return override;
  }
  // Default: append tenantId for orientation (backward-compatible behaviour).
  return (
    "Ты аналитик-ассистент в системе Choros (тенант: " +
    tenantId +
    ").\n" +
    "Твоя роль — ТОЛЬКО читать и анализировать данные. " +
    "Ты НИКОГДА не создаёшь, не обновляешь и не удаляешь бизнес-записи.\n" +
    "Если пользователь просит выполнить действие (например, запустить процесс), " +
    "ты можешь ПРЕДЛОЖИТЬ («запустить процесс X?»), но НЕ выполняешь его — " +
    "это подтверждает человек через существующий интерфейс.\n" +
    "Отвечай по-русски, структурированно и честно. " +
    "В конце добавь предложение сохранить отчёт, если анализ был содержательным."
  );
}

// ---------------------------------------------------------------------------
// isProcessAnalyticsQuery — T-0607 (д): gate S3-journal telemetry by INTENT.
//
// The S3 journal (cycle-time by activity, actor-type breakdown) is INTERNAL
// telemetry. It must NOT be pasted into the user-facing LLM context — and thus
// offered to the user as an explanation — for a plain data question («сколько
// поставщиков заведено?»). It enters the context ONLY when the user explicitly
// asks about PROCESS analytics (cycle time / bottleneck / stages / durations).
// Generic keyword detector (no case literals — D-064).
// ---------------------------------------------------------------------------

export function isProcessAnalyticsQuery(userText: string): boolean {
  const t = userText.toLowerCase();
  const KEYWORDS = [
    "цикл",          // цикловое время
    "время",         // время выполнения
    "узкое место",
    "узкие места",
    "этап",          // по этапам
    "процесс",       // процессная аналитика
    "длительност",   // длительность
    "производительн", // производительность
    "bottleneck",
    "cycle",
    "duration",
    "throughput",
    "stage",
  ];
  return KEYWORDS.some((k) => t.includes(k));
}

// ---------------------------------------------------------------------------
// buildDraftContext — stringify the ReportDraft for the LLM context message.
//
// T-0607 (а): renders the actor-rights registry digest — the entity data the
// analyst was previously blind to. «Записей нет» is asserted ONLY when the
// digest is KNOWN and empty (not degraded, not unwired) — otherwise the analyst
// must not claim absence as fact.
// T-0607 (д): S3-journal telemetry sections are included ONLY when the query is
// explicitly about process analytics (draft.isProcessAnalytics).
// ---------------------------------------------------------------------------

function buildDraftContext(draft: ReportDraft): string {
  const parts: string[] = [];

  // ---- Entity data — the actor-rights registry digest (T-0607 а). -----------
  const digest = draft.registryDigest;
  if (digest === null) {
    // Digest port not wired — the analyst has no entity view. Do NOT claim
    // «записей нет»; state the honest limitation instead.
    parts.push(
      "=== Данные разделов недоступны для чтения в этом ответе (нет источника данных) ===",
    );
  } else if (digest.degraded) {
    // Read failed — honest-degrade. Never claim absence as fact.
    parts.push(
      "=== Не удалось прочитать разделы (временная ошибка чтения). НЕ утверждай, что записей нет ===",
    );
  } else if (digest.registries.length === 0) {
    parts.push("=== В доступных пользователю разделах нет ни одного раздела ===");
  } else {
    const totalVisible = digest.registries.reduce((s, r) => s + r.visibleCount, 0);
    parts.push(
      `=== Разделы и записи (в правах пользователя) — всего разделов: ${digest.registries.length}, ` +
      `видимых записей суммарно: ${totalVisible} ===`,
    );
    for (const reg of digest.registries) {
      const sampleStr =
        reg.samples.length > 0 ? `; примеры: ${reg.samples.join(", ")}` : "";
      parts.push(
        `  • «${reg.displayName}» (${reg.slug}): записей — ${reg.visibleCount}${sampleStr}`,
      );
    }
    if (totalVisible === 0) {
      parts.push(
        "  (в доступных разделах пока нет записей — это достоверный факт, а не ограничение прав)",
      );
    }
  }

  // ---- Ad-hoc records passed directly (legacy port, may be empty). ----------
  if (draft.records.length > 0) {
    parts.push(`\n=== Записи (${draft.records.length} шт., видимые пользователю) ===`);
    const visible = draft.records.slice(0, 20);
    for (const rec of visible) {
      parts.push(JSON.stringify(rec));
    }
    if (draft.records.length > 20) {
      parts.push(`... ещё ${draft.records.length - 20} записей (не показаны)`);
    }
  }

  // ---- S3-journal telemetry — ONLY for explicit process-analytics queries (д).
  if (draft.isProcessAnalytics) {
    // Cycle-time analytics section.
    if (draft.cycleTime && draft.cycleTime.rows.length > 0) {
      parts.push("\n=== Цикловое время по активностям (S3 журнал) ===");
      if (draft.cycleTime.bottleneck) {
        parts.push(`Узкое место: ${draft.cycleTime.bottleneck}`);
      }
      for (const row of draft.cycleTime.rows.slice(0, 10)) {
        const avgMs =
          row.avg_duration_ms != null ? `${Math.round(row.avg_duration_ms)} мс` : "нет данных";
        parts.push(
          `  ${row.activity}: avg=${avgMs}, всего=${row.count}, ` +
          `человек=${row.human_count}, агент=${row.agent_count}, сервис=${row.service_count}`,
        );
      }
    }

    // Actor-breakdown section.
    if (draft.actorBreakdown.length > 0) {
      parts.push("\n=== Разбивка по типу актора ===");
      for (const row of draft.actorBreakdown.slice(0, 10)) {
        parts.push(`  ${row.activity} / ${row.actor_type}: ${row.count}`);
      }
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// buildSaveHint — appended to the LLM output so the user knows they can save.
// ---------------------------------------------------------------------------

const SAVE_HINT =
  "\n\n---\n" +
  "Хотите сохранить этот отчёт как именованный Отчёт/Рекомендацию? " +
  "Нажмите «Сохранить как отчёт» в интерфейсе — он будет доступен и другим участникам команды.";

// ---------------------------------------------------------------------------
// runAnalyst — main orchestration function (called by handleAnalyst below).
//
// STRUCTURALLY READ-ONLY CONTRACT:
//   This function calls only:
//     - ctx.llm.chat()        — LLM inference (no business DB write)
//     - ports.listRecords()   — READ records (filtered by ACL)
//     - ports.loadCycleTime() — READ S3 journal (no write)
//     - ports.loadActorBreakdown() — READ S3 journal (no write)
//     - ports.loadRegistryDigest() — READ registry digest (READ-PDP, no write)
//     - ports.emitAudit()     — AUDIT write (metadata only, not business data)
//   The ABSENCE of any record.create / record.update / record.delete / registry
//   mutation call is the structural no-business-write enforcement.
// ---------------------------------------------------------------------------

export async function runAnalyst(
  userText: string,
  ctx: HandlerContext,
  ports: AnalystPorts = {},
): Promise<HandlerResult> {
  const listRecords = ports.listRecords ?? defaultListRecords;
  const loadCycleTime = ports.loadCycleTime ?? defaultLoadCycleTime;
  const loadActorBreakdown = ports.loadActorBreakdown ?? defaultLoadActorBreakdown;
  const loadRegistryDigest = ports.loadRegistryDigest ?? defaultLoadRegistryDigest;
  const emitAudit = ports.emitAudit ?? defaultEmitAudit;
  const loadSystemPrompt = ports.loadSystemPrompt ?? defaultLoadSystemPrompt;

  const nowMs = Date.now();

  // T-0607 (д): decide ONCE whether the S3-journal telemetry is relevant to this
  // query. Plain data questions never see internal process telemetry.
  const isProcessAnalytics = isProcessAnalyticsQuery(userText);

  // -------------------------------------------------------------------------
  // 1. Read records within the asker's ACL (intersection grants ceiling).
  //    SECURITY: listRecords MUST only return records reachable via
  //    ctx.intersectionGrants — never the raw base GrantSource.
  // -------------------------------------------------------------------------
  const records = await listRecords(
    ctx.tenantId,
    ctx.intersectionGrants,
    ctx.ancestry,
    ctx.userSubject,
  );

  // -------------------------------------------------------------------------
  // 2a. Read the actor-rights registry digest (T-0607 а) — the entity data the
  //     analyst was previously blind to. Honest-degrade to null on any failure.
  // -------------------------------------------------------------------------
  const registryDigest = await loadRegistryDigest(
    ctx.tenantId,
    ctx.userSubject.subjectId,
  ).catch(() => null);

  // -------------------------------------------------------------------------
  // 2b. Read S3 journal metrics (read-only, tenant-scoped) — ONLY when the query
  //     is about process analytics (T-0607 д). Plain data questions never load
  //     internal telemetry (and thus never leak it into the answer).
  // -------------------------------------------------------------------------
  const [cycleTime, actorBreakdown] = isProcessAnalytics
    ? await Promise.all([
        loadCycleTime(ctx.tenantId).catch(() => null),
        loadActorBreakdown(ctx.tenantId).catch(() => []),
      ])
    : [null, [] as ActorTypeBreakdown[]];

  // -------------------------------------------------------------------------
  // 3. Build the ephemeral ReportDraft (no DB write here).
  // -------------------------------------------------------------------------
  const draft: ReportDraft = {
    userQuery: userText,
    records,
    cycleTime,
    actorBreakdown,
    registryDigest,
    isProcessAnalytics,
    tenantId: ctx.tenantId,
  };

  // -------------------------------------------------------------------------
  // 4. Emit an audit event for this analyst read.
  //    Type: "assistant.analyst.read" — distinguishes from user/assistant message events.
  //    Payload carries METADATA (query + counts), NOT the raw record data itself,
  //    to keep the audit log lean. The full data is in the LLM prompt (ephemeral).
  // -------------------------------------------------------------------------
  await emitAudit({
    type: "assistant.analyst.read",
    actor: ctx.agentSubject.subjectId,
    subject: ctx.userSubject.subjectId,
    payload: {
      thread_id: ctx.threadId,
      message_id: ctx.messageId,
      tenant_id: ctx.tenantId,
      records_read: records.length,
      has_cycle_time: cycleTime !== null && cycleTime.rows.length > 0,
      has_actor_breakdown: actorBreakdown.length > 0,
      query_snippet: userText.slice(0, 120),
    },
    occurred_at: nowMs,
  });

  // -------------------------------------------------------------------------
  // 5. Synthesize the report using the injected LLM port.
  //    System: analyst persona (read-only, propose-not-execute).
  //    Context message: stringified ReportDraft data.
  //    User message: the original query.
  //    T-0383: load per-tenant system prompt override; fallback to default.
  // -------------------------------------------------------------------------
  const promptOverride = await loadSystemPrompt(ctx.tenantId);
  const systemPrompt = buildAnalystSystemPrompt(ctx.tenantId, promptOverride);
  const draftContext = buildDraftContext(draft);

  // T-0607 (г): wrap the LLM call — every user message must get an answer OR an
  // honest error IN THE THREAD, never a silent no-reply. Previously runAnalyst
  // let a non-"unavailable" LLM error propagate → the route returned a bare 500
  // WITHOUT persisting any assistant message, so the thread stayed silent. Now
  // any caught LLM error becomes a canonical, jargon-free reply (same discipline
  // as the configurator loop, T-0600); the raw error is logged server-side only.
  let llmText: string;
  try {
    const llmResult = await (ctx.llm as LlmPort).chat({
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content:
            `Контекст данных (видимые пользователю):\n${draftContext}\n\n` +
            `Запрос пользователя: ${userText}`,
        },
      ],
    });
    llmText = llmResult.text + SAVE_HINT;
  } catch (err) {
    // T-0573: a dormant/unavailable LLM must still reach the route's honest-503
    // path (respondLlmUnavailable — admin/non-admin deep-links). We RE-THROW
    // those so that richer 503 UX is preserved; we only swallow OTHER errors
    // (timeout / network / malformed) into a canonical in-thread reply (г).
    if (classifyLlmUnavailability(err) === "unavailable") {
      throw err;
    }
    console.error(`[T-0607] analyst LLM call failed: ${String(err)}`);
    // Honest canonical text (no raw provider body, no dev-jargon) — the thread
    // gets a real reply instead of silence.
    return { text: canonicalizeLlmError(err), intent: "analyst" };
  }

  // -------------------------------------------------------------------------
  // 6. The save-hint was already appended to the LLM output above.
  //    This is a static text hint, NOT a DB write; the user chooses to save
  //    by clicking the FE "Сохранить как отчёт" control.
  // -------------------------------------------------------------------------
  const replyText = llmText;

  return {
    text: replyText,
    intent: "analyst",
  };
}

// ---------------------------------------------------------------------------
// handleAnalyst — the IntentHandler exported for assistant-intent.ts.
//
// This is the ONLY symbol that assistant-intent.ts imports from this module.
// The default ports (no-op / empty) are used when the handler is called without
// explicit port injection (e.g. from the T-0359 stub path). Production wiring
// passes real ports via the HandlerContext extensions.
//
// PORTS INJECTION NOTE: HandlerContext does not carry AnalystPorts directly
// (adding optional fields to a frozen interface would risk a sibling-task merge
// conflict with T-0361). Instead, we use a module-level port registry that the
// production composition root populates via setAnalystPorts(). This keeps
// assistant-intent.ts and assistant.ts both unmodified.
// ---------------------------------------------------------------------------

let _activePorts: AnalystPorts = {};

/**
 * Set the ports used by handleAnalyst. Called once at composition-root startup
 * (before any requests arrive). Safe to call multiple times (replaces previous).
 *
 * Usage in production (src/http/index.ts or composition root):
 *   import { setAnalystPorts } from "./core/assistant-analyst.js";
 *   setAnalystPorts({ listRecords: myLister, loadCycleTime: myLoader, ... });
 *
 * Usage in tests: inject stubs before calling handleAnalyst.
 */
export function setAnalystPorts(ports: AnalystPorts): void {
  _activePorts = { ..._activePorts, ...ports };
}

/**
 * Reset ports to defaults (test teardown helper).
 */
export function resetAnalystPorts(): void {
  _activePorts = {};
}

/**
 * The real analyst IntentHandler — replaces the stub in assistant-intent.ts.
 *
 * No-business-write: structurally enforced — calls only runAnalyst which
 * calls only READ ports + LLM. The only mutation is the audit emitter
 * (metadata only, not business data).
 */
export const handleAnalyst = async (
  userText: string,
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  return runAnalyst(userText, ctx, _activePorts);
};
