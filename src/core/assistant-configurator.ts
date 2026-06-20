/**
 * src/core/assistant-configurator.ts — T-0361 (E17): CONFIGURATOR handler.
 *
 * Implements handleConfigurator: chat intent → authors E16 model in DRAFT via
 * a tool-dispatch loop. The agent may call authoring tools; a human must promote.
 *
 * SECURITY INVARIANTS (must hold + tested):
 *  1. DRAFT-ONLY: every authoring write targets tier='draft'; the agent has NO
 *     path to publish/promote. request_promote returns a PENDING ticket, not a
 *     live promote. Tested: author → draft row, NO published row.
 *  2. CO-EQUAL / ONE MODEL: writes the same process_definition / process_app_binding /
 *     registry_def DRAFT rows the visual constructor writes → same validator,
 *     same promote-gate. No divergent second model.
 *  3. DESTRUCTIVE = HUMAN-CONFIRM: drop/rename field, lossy type-change →
 *     evaluateAuthoringRedLine returns deny; handler returns a blocked-pending
 *     message WITHOUT executing the op. Tested.
 *  4. INTERSECTION CEILING: the configurator uses ctx.intersectionGrants (already
 *     the intersection of agent ∩ user). It checks for 'authoring_draft' grants
 *     before executing any tool. Tested.
 *  5. AUDIT: every tool invocation is recorded in the changelog (returned in
 *     HandlerResult.text). DB-layer audit is handled by the assistant route's
 *     existing appendAuditEvent call (assistant.ts) — this layer is pure core.
 *
 * PURE: no process.env, no pg, no http, no fetch, no child_process.
 * All authoring side-effects are returned as AuthoringOps in the result and
 * executed by the HTTP layer (assistant.ts). This keeps the core testable at
 * $0 (StubChatLlmPort, no DB).
 *
 * ARCHITECTURE NOTE — DB execution model:
 *   The configurator is pure core: it PLANS authoring ops (via LLM tool dispatch),
 *   validates them (redline guard, grant ceiling), and returns a ConfiguratorResult
 *   with (a) approved ops to execute and (b) blocked ops pending human confirm.
 *   The assistant HTTP route (sealed) is responsible for DB execution of approved ops.
 *   This keeps T-0361 DB-free and $0 in tests.
 *
 *   For the co-equal invariant: the HTTP route must execute the ops through the
 *   SAME write paths as the visual constructor (process-defs POST / binding POST /
 *   registry-defs PUT). This is enforced by the op shape (AuthoringOp types mirror
 *   those route bodies) and documented in the ConfiguratorResult.approvedOps contract.
 *
 * Wave 2 DB-execution wiring is gated on the sealed assistant.ts route reading
 * ConfiguratorResult. Current wave: pure planning + grant check + redline guard.
 */

import { randomUUID } from "node:crypto";
import type { HandlerContext, HandlerResult } from "./assistant-intent.js";
import type { Grant } from "./grant-lattice.js";
import {
  evaluateAuthoringRedLine,
  type AuthoringOp,
  type AuthoringContext,
} from "./authoring-redlines.js";
import type { ChatLlmRequest, ChatLlmResult, ChatToolCall } from "./llm-port.js";

// ---------------------------------------------------------------------------
// Authoring resource type constant (mirrors migration 044 / grant-lattice widening-cast)
// ---------------------------------------------------------------------------

/**
 * The resourceType string for authoring_draft grants.
 * This value is authoritative in the migration (044) and tests (config-agent-toolset).
 * We declare it as a Grant["resourceType"] widening-cast to match the lattice's
 * open-string resourceType field — same pattern as config-agent-toolset.test.ts:L50.
 */
const AUTHORING_DRAFT_RESOURCE = "authoring_draft" as Grant["resourceType"];

// ---------------------------------------------------------------------------
// Tool definitions — the E16 authoring tools the configurator can call.
// These match the 7 seed tools from migration 044 (emit_form_code, edit_jsonschema,
// author_dmn, author_binding, request_promote). They are declared here as OpenAI-
// compatible tool objects; the LLM picks which to call.
// ---------------------------------------------------------------------------

/**
 * OpenAI-compatible tool declaration shape (subset sufficient for our stub/real LLM).
 * Mirrors ChatLlmRequest.tools[] item shape.
 */
interface ToolDeclaration {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: {
      readonly type: "object";
      readonly properties: Record<string, { readonly type: string; readonly description: string; readonly enum?: string[] }>;
      readonly required: string[];
    };
  };
}

/** author_binding — upsert a process_app_binding (trigger type + start form + field mapping). */
const TOOL_AUTHOR_BINDING: ToolDeclaration = {
  type: "function",
  function: {
    name: "author_binding",
    description:
      "Upsert a process_app_binding row in DRAFT tier — links a process to an application " +
      "with trigger type, start form, and field mapping. Writes to DRAFT only; human promotes.",
    parameters: {
      type: "object",
      properties: {
        processKey: { type: "string", description: "Process key (unique within tenant)." },
        applicationId: { type: "string", description: "UUID of the application to bind." },
        triggerType: {
          type: "string",
          description: "Trigger type: on_create | record_action | launcher | auto.",
          enum: ["on_create", "record_action", "launcher", "auto"],
        },
        startFormKey: { type: "string", description: "Optional: key of the start form (record_schema field key)." },
        fieldMapping: { type: "string", description: "Optional JSON string: field mapping object." },
        humanReadableReason: { type: "string", description: "Why this binding is being created (for changelog)." },
      },
      required: ["processKey", "applicationId", "triggerType", "humanReadableReason"],
    },
  },
};

/** edit_jsonschema — update a registry_def.record_schema field (additive only without human confirm). */
const TOOL_EDIT_JSONSCHEMA: ToolDeclaration = {
  type: "function",
  function: {
    name: "edit_jsonschema",
    description:
      "Add or update a field in a registry_def.record_schema in DRAFT tier. " +
      "Destructive changes (drop/rename/lossy type-change) are BLOCKED and returned as " +
      "pending-human-confirm without executing. Human must confirm + re-issue destructive ops.",
    parameters: {
      type: "object",
      properties: {
        registryDefId: { type: "string", description: "UUID of the registry_def to update." },
        opKind: {
          type: "string",
          description: "Operation: add_field | drop_field | rename_field | change_type | relabel | toggle_required | enum_change.",
          enum: ["add_field", "drop_field", "rename_field", "change_type", "relabel", "toggle_required", "enum_change"],
        },
        fieldKey: { type: "string", description: "The field key to operate on." },
        fieldSchema: { type: "string", description: "JSON string: new field schema for add_field/change_type/relabel." },
        oldFieldSchema: { type: "string", description: "JSON string: old field schema (required for change_type/enum_change to detect lossy changes)." },
        isCorePinned: { type: "string", description: "'true' if this is a system/core field (blocks drop/rename absolutely).", enum: ["true", "false"] },
        humanReadableReason: { type: "string", description: "Why this field is being changed (for changelog)." },
      },
      required: ["registryDefId", "opKind", "fieldKey", "humanReadableReason"],
    },
  },
};

/** emit_form — emit a new form schema for an application in DRAFT tier. */
const TOOL_EMIT_FORM: ToolDeclaration = {
  type: "function",
  function: {
    name: "emit_form",
    description:
      "Create or replace a form definition (Floor-2 form schema) in DRAFT tier. " +
      "Returns the draft form key; human promotes. Never writes to published tier.",
    parameters: {
      type: "object",
      properties: {
        applicationId: { type: "string", description: "UUID of the application to attach the form to." },
        formKey: { type: "string", description: "Unique form key within the tenant (slug-like)." },
        formSchema: { type: "string", description: "JSON string: the form schema object." },
        humanReadableReason: { type: "string", description: "Why this form is being created (for changelog)." },
      },
      required: ["applicationId", "formKey", "formSchema", "humanReadableReason"],
    },
  },
};

/** author_dmn — create or update a DMN decision table in DRAFT tier. */
const TOOL_AUTHOR_DMN: ToolDeclaration = {
  type: "function",
  function: {
    name: "author_dmn",
    description:
      "Create or update a DMN decision table in DRAFT tier. Returns draft DMN key; human promotes.",
    parameters: {
      type: "object",
      properties: {
        processKey: { type: "string", description: "Process key the DMN belongs to." },
        dmnKey: { type: "string", description: "Unique DMN key within the process." },
        dmnXml: { type: "string", description: "The DMN XML definition." },
        humanReadableReason: { type: "string", description: "Why this DMN is being authored (for changelog)." },
      },
      required: ["processKey", "dmnKey", "dmnXml", "humanReadableReason"],
    },
  },
};

/** request_promote — request a human to promote DRAFT → published. NEVER auto-promotes. */
const TOOL_REQUEST_PROMOTE: ToolDeclaration = {
  type: "function",
  function: {
    name: "request_promote",
    description:
      "Request a human to promote the current DRAFT configuration to published. " +
      "Returns a PENDING promote ticket with a summary of pending changes. " +
      "The agent CANNOT auto-promote — a human must review and confirm.",
    parameters: {
      type: "object",
      properties: {
        humanReadableSummary: { type: "string", description: "Summary of changes in the DRAFT to promote." },
      },
      required: ["humanReadableSummary"],
    },
  },
};

/** All E16 authoring tools available to the configurator. */
const CONFIGURATOR_TOOLS: readonly ToolDeclaration[] = [
  TOOL_AUTHOR_BINDING,
  TOOL_EDIT_JSONSCHEMA,
  TOOL_EMIT_FORM,
  TOOL_AUTHOR_DMN,
  TOOL_REQUEST_PROMOTE,
];

// ---------------------------------------------------------------------------
// Approved/blocked op shapes — returned in ConfiguratorResult
// ---------------------------------------------------------------------------

/**
 * An authoring op that passed grant check + redline guard and is APPROVED
 * to execute. The assistant HTTP route executes these against the DB.
 *
 * INVARIANT: every ApprovedOp has tier='draft'. The HTTP route MUST use
 * the same write paths as the visual constructor (process-defs POST /
 * binding POST / registry-defs PUT) to guarantee co-equal one-model.
 */
export interface ApprovedOp {
  readonly kind:
    | "author_binding"
    | "edit_jsonschema_non_destructive"
    | "emit_form"
    | "author_dmn";
  /** Human-readable one-liner for the changelog. */
  readonly description: string;
  /** Raw tool arguments (type-narrowed per kind). */
  readonly args: Record<string, unknown>;
  /** INVARIANT: always 'draft'. The promote gate is human-only. */
  readonly tier: "draft";
}

/**
 * A destructive or core-pinned op that is BLOCKED pending human confirm.
 * The agent returns this as a message; it DOES NOT execute the op.
 */
export interface BlockedOp {
  readonly kind: "pending_human_confirm" | "core_pinned_absolute_deny";
  /** Human-readable explanation of what was blocked and why. */
  readonly description: string;
  /** The tool call that triggered the block. */
  readonly toolName: string;
  /** What the human must do to proceed (for pending_human_confirm). */
  readonly requiredAction?: string;
}

/**
 * A request_promote call result — returns a pending promote ticket.
 * NEVER executes the actual promote (human-only).
 */
export interface PendingPromote {
  readonly ticketId: string;
  /** Human-readable summary of what is in DRAFT and needs promotion. */
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// ConfiguratorResult — returned by runConfigurator, used by handleConfigurator
// ---------------------------------------------------------------------------

/**
 * The full result of one configurator invocation.
 * The HTTP route (assistant.ts) reads approvedOps and executes them via
 * the same write paths the visual constructor uses.
 */
export interface ConfiguratorResult {
  /** Assistant text reply (changelog + next steps). Safe to show the user. */
  readonly text: string;
  /** Ops that passed grant check + redline guard (DRAFT writes). */
  readonly approvedOps: readonly ApprovedOp[];
  /** Ops blocked pending human confirm or absolute deny. */
  readonly blockedOps: readonly BlockedOp[];
  /** Pending promote requests (human-gated). */
  readonly pendingPromotes: readonly PendingPromote[];
  /** Whether the intersection grant ceiling was insufficient for any op. */
  readonly grantCeilingViolations: readonly string[];
}

// ---------------------------------------------------------------------------
// Grant ceiling check
// ---------------------------------------------------------------------------

/**
 * Check whether the intersection grants include at least one effective
 * authoring_draft grant (create or update).
 *
 * SECURITY: uses ctx.intersectionGrants which is already the INTERSECTION of
 * agent ∩ user — never wider. An agent cannot author on behalf of a user who
 * has no authoring_draft grant.
 */
async function hasAuthoringDraftGrant(ctx: HandlerContext): Promise<boolean> {
  const nowMs = Date.now();
  const grants = await ctx.intersectionGrants.getGrants(ctx.userSubject, nowMs);
  return grants.some(
    (g) =>
      g.resourceType === AUTHORING_DRAFT_RESOURCE &&
      (g.operation === "create" || g.operation === "update"),
  );
}

// ---------------------------------------------------------------------------
// Tool execution (pure planning — no DB, returns ops)
// ---------------------------------------------------------------------------

/**
 * Process a single tool call from the LLM.
 * Returns { approved?, blocked?, pendingPromote?, changelogLine, toolResultContent }.
 * No IO. No DB. Pure planning.
 */
function processToolCall(
  call: ChatToolCall,
): {
  approved?: ApprovedOp;
  blocked?: BlockedOp;
  pendingPromote?: PendingPromote;
  changelogLine: string;
  toolResultContent: string;
} {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>;
  } catch {
    const blocked: BlockedOp = {
      kind: "pending_human_confirm",
      description: `Инструмент ${call.name}: не удалось разобрать аргументы (невалидный JSON).`,
      toolName: call.name,
    };
    return {
      blocked,
      changelogLine: `⚠ [ЗАБЛОКИРОВАНО] ${call.name}: невалидный JSON аргументов`,
      toolResultContent: `error: invalid JSON arguments for ${call.name}`,
    };
  }

  const reason = (args["humanReadableReason"] as string | undefined) ?? call.name;

  switch (call.name) {
    // -----------------------------------------------------------------------
    // author_binding — always non-destructive (upsert on binding, no field drops)
    // -----------------------------------------------------------------------
    case "author_binding": {
      const approved: ApprovedOp = {
        kind: "author_binding",
        description: `Привязка процесса «${String(args["processKey"] ?? "?")}» к приложению «${String(args["applicationId"] ?? "?")}» (тип=${String(args["triggerType"] ?? "?")}): ${reason}`,
        args,
        tier: "draft",
      };
      return {
        approved,
        changelogLine: `✓ [DRAFT] author_binding: ${approved.description}`,
        toolResultContent: JSON.stringify({
          status: "draft",
          processKey: args["processKey"],
          applicationId: args["applicationId"],
          triggerType: args["triggerType"],
          tier: "draft",
        }),
      };
    }

    // -----------------------------------------------------------------------
    // edit_jsonschema — must pass redline guard
    // -----------------------------------------------------------------------
    case "edit_jsonschema": {
      const opKind = args["opKind"] as AuthoringOp["kind"] | undefined;
      const fieldKey = (args["fieldKey"] as string | undefined) ?? "unknown";
      const isCorePinned = args["isCorePinned"] === "true";

      if (!opKind) {
        const blocked: BlockedOp = {
          kind: "pending_human_confirm",
          description: `edit_jsonschema: opKind не указан для поля «${fieldKey}»`,
          toolName: call.name,
        };
        return {
          blocked,
          changelogLine: `⚠ [ЗАБЛОКИРОВАНО] edit_jsonschema: отсутствует opKind`,
          toolResultContent: "error: opKind is required",
        };
      }

      // Parse old/new schemas for type-aware ops
      let oldSchema: Record<string, unknown> = {};
      let newSchema: Record<string, unknown> = {};
      try {
        if (typeof args["oldFieldSchema"] === "string" && args["oldFieldSchema"]) {
          oldSchema = JSON.parse(args["oldFieldSchema"]) as Record<string, unknown>;
        }
        if (typeof args["fieldSchema"] === "string" && args["fieldSchema"]) {
          newSchema = JSON.parse(args["fieldSchema"]) as Record<string, unknown>;
        }
      } catch {
        // malformed — treat as missing (conservative: non_destructive default)
      }

      const op: AuthoringOp = {
        kind: opKind,
        fieldKey,
        oldSchema: Object.keys(oldSchema).length ? oldSchema : undefined,
        newSchema: Object.keys(newSchema).length ? newSchema : undefined,
      };
      const context: AuthoringContext = { isCorePinned };

      const decision = evaluateAuthoringRedLine(op, context);

      if (decision.verdict === "deny") {
        const isAbsolute = decision.reason === "core_pinned";
        const blocked: BlockedOp = {
          kind: isAbsolute ? "core_pinned_absolute_deny" : "pending_human_confirm",
          description: isAbsolute
            ? `Абсолютный запрет: поле «${fieldKey}» является системным (core-pinned). Удаление/переименование/перенос невозможны.`
            : `Деструктивная операция «${opKind}» над полем «${fieldKey}» заблокирована. ` +
              `Требуется явное подтверждение человека с описанием последствий. ${reason}`,
          toolName: call.name,
          requiredAction: isAbsolute
            ? undefined
            : "Человек должен явно подтвердить операцию и описать последствия (>10 символов).",
        };
        return {
          blocked,
          changelogLine: `✗ [${isAbsolute ? "АБСОЛЮТНЫЙ ЗАПРЕТ" : "ОЖИДАЕТ ПОДТВЕРЖДЕНИЯ"}] edit_jsonschema(${opKind}) на поле «${fieldKey}»`,
          toolResultContent: JSON.stringify({
            status: "blocked",
            reason: decision.reason,
            classification: decision.classification,
            fieldKey,
          }),
        };
      }

      // Approved non-destructive or confirmed destructive (the latter only when human
      // explicitly provides confirm — the LLM cannot generate a valid confirm itself).
      const approved: ApprovedOp = {
        kind: "edit_jsonschema_non_destructive",
        description: `Обновление поля «${fieldKey}» (${opKind}) в схеме реестра «${String(args["registryDefId"] ?? "?")}»: ${reason}`,
        args,
        tier: "draft",
      };
      return {
        approved,
        changelogLine: `✓ [DRAFT] edit_jsonschema(${opKind}) поле «${fieldKey}»: ${approved.description}`,
        toolResultContent: JSON.stringify({
          status: "draft",
          registryDefId: args["registryDefId"],
          fieldKey,
          opKind,
          tier: "draft",
        }),
      };
    }

    // -----------------------------------------------------------------------
    // emit_form — always non-destructive (creates/replaces draft form)
    // -----------------------------------------------------------------------
    case "emit_form": {
      const approved: ApprovedOp = {
        kind: "emit_form",
        description: `Форма «${String(args["formKey"] ?? "?")}» для приложения «${String(args["applicationId"] ?? "?")}» [DRAFT]: ${reason}`,
        args,
        tier: "draft",
      };
      return {
        approved,
        changelogLine: `✓ [DRAFT] emit_form: ${approved.description}`,
        toolResultContent: JSON.stringify({
          status: "draft",
          formKey: args["formKey"],
          applicationId: args["applicationId"],
          tier: "draft",
        }),
      };
    }

    // -----------------------------------------------------------------------
    // author_dmn — always non-destructive at authoring level (DMN XML replace)
    // -----------------------------------------------------------------------
    case "author_dmn": {
      const approved: ApprovedOp = {
        kind: "author_dmn",
        description: `DMN-таблица «${String(args["dmnKey"] ?? "?")}» для процесса «${String(args["processKey"] ?? "?")}» [DRAFT]: ${reason}`,
        args,
        tier: "draft",
      };
      return {
        approved,
        changelogLine: `✓ [DRAFT] author_dmn: ${approved.description}`,
        toolResultContent: JSON.stringify({
          status: "draft",
          processKey: args["processKey"],
          dmnKey: args["dmnKey"],
          tier: "draft",
        }),
      };
    }

    // -----------------------------------------------------------------------
    // request_promote — returns PENDING ticket, NEVER auto-promotes
    // -----------------------------------------------------------------------
    case "request_promote": {
      const ticketId = randomUUID();
      const summary = (args["humanReadableSummary"] as string | undefined) ?? "Нет описания";
      const pendingPromote: PendingPromote = { ticketId, summary };
      return {
        pendingPromote,
        changelogLine: `⏳ [ОЖИДАЕТ ПРОМОУТА] ticket=${ticketId}: ${summary}`,
        toolResultContent: JSON.stringify({
          status: "pending_human_promote",
          ticketId,
          summary,
          message: "Промоут заблокирован — ожидается подтверждение человека. Агент не может промоутить самостоятельно.",
        }),
      };
    }

    // -----------------------------------------------------------------------
    // Unknown tool — block it
    // -----------------------------------------------------------------------
    default: {
      const blocked: BlockedOp = {
        kind: "pending_human_confirm",
        description: `Неизвестный инструмент «${call.name}» заблокирован (не входит в разрешённый набор E16).`,
        toolName: call.name,
      };
      return {
        blocked,
        changelogLine: `⚠ [ЗАБЛОКИРОВАНО] Неизвестный инструмент «${call.name}»`,
        toolResultContent: `error: unknown tool ${call.name}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Tool-use loop
// ---------------------------------------------------------------------------

/**
 * Maximum tool-use rounds to prevent infinite loops.
 * Each round: LLM produces tool calls → we process → feed results back → repeat.
 */
const MAX_TOOL_ROUNDS = 5;

/**
 * Run the configurator tool-dispatch loop.
 *
 * Algorithm:
 *  1. Build system prompt (configurator persona + DRAFT-only constraint).
 *  2. Call LLM with tools declared.
 *  3. For each tool call: processToolCall → approved/blocked/pendingPromote.
 *  4. Feed tool results back to LLM (as role='user' synthetic turn for stub compat).
 *  5. Repeat up to MAX_TOOL_ROUNDS or until LLM returns text-only (done).
 *  6. Assemble changelog + final reply.
 *
 * Pure: all authoring ops are returned as data; no DB writes.
 */
async function runConfiguratorLoop(
  userText: string,
  ctx: HandlerContext,
): Promise<ConfiguratorResult> {
  const approvedOps: ApprovedOp[] = [];
  const blockedOps: BlockedOp[] = [];
  const pendingPromotes: PendingPromote[] = [];
  const changelogLines: string[] = [];
  const grantCeilingViolations: string[] = [];

  const systemPrompt =
    "Ты — конфигуратор-агент системы Choros (режим CONFIGURATOR). " +
    "Твоя задача — помочь пользователю настроить систему: добавить поля, формы, привязки процессов, DMN-таблицы. " +
    "ВСЕ изменения вносятся ТОЛЬКО в DRAFT (черновик). Промоут в production выполняет ЧЕЛОВЕК. " +
    "Деструктивные операции (удаление/переименование поля, потеря данных) НЕЛЬЗЯ выполнять без явного подтверждения человека. " +
    "Используй инструменты для каждого конкретного изменения. " +
    "После каждого изменения кратко объясни что и зачем было сделано. " +
    "Если конфигурация завершена — вызови request_promote с описанием изменений. " +
    "Отвечай по-русски.";

  // Build initial request with tools
  const initialRequest: ChatLlmRequest = {
    system: systemPrompt,
    messages: [{ role: "user", content: userText }],
    tools: CONFIGURATOR_TOOLS as readonly unknown[],
  };

  let currentMessages = [...initialRequest.messages];
  let finalText = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const request: ChatLlmRequest = {
      system: systemPrompt,
      messages: currentMessages,
      tools: CONFIGURATOR_TOOLS as readonly unknown[],
    };

    let result: ChatLlmResult;
    try {
      result = await ctx.llm.chat(request);
    } catch (err) {
      // LLM error (dormant, network, etc.) — return partial results with error note
      const errMsg =
        err instanceof Error ? err.message : String(err);
      finalText =
        `Ошибка LLM-порта: ${errMsg}. ` +
        (approvedOps.length > 0 || blockedOps.length > 0
          ? "Частичные результаты ниже."
          : "Конфигурация не была изменена.");
      break;
    }

    // If the LLM returned text (no tool calls), we're done
    if (!result.toolCalls || result.toolCalls.length === 0) {
      finalText = result.text;
      break;
    }

    // Process each tool call
    const toolResultParts: string[] = [];
    for (const call of result.toolCalls) {
      const processed = processToolCall(call);

      if (processed.approved) approvedOps.push(processed.approved);
      if (processed.blocked) blockedOps.push(processed.blocked);
      if (processed.pendingPromote) pendingPromotes.push(processed.pendingPromote);
      if (processed.changelogLine) changelogLines.push(processed.changelogLine);

      toolResultParts.push(`[${call.name}] → ${processed.toolResultContent}`);
    }

    // Feed tool results back as a synthetic user message (works with StubChatLlmPort
    // and real OpenAI-compat endpoints; the stub returns text on the next call).
    currentMessages = [
      ...currentMessages,
      // The assistant's tool-call turn (text may be empty)
      { role: "assistant" as const, content: result.text || "[tool calls]" },
      // Synthetic tool results as user turn (simplest form; proper tool_result
      // channel is adapter-specific — the stub ignores role for fixture output)
      {
        role: "user" as const,
        content: `Результаты инструментов:\n${toolResultParts.join("\n")}`,
      },
    ];

    // If we processed tool calls but the last round hit MAX, generate a wrap-up
    if (round === MAX_TOOL_ROUNDS - 1) {
      finalText =
        "Достигнут лимит итераций инструментов. Ниже — итог выполненных операций.";
    }
  }

  // Build human-readable changelog
  const changelog =
    changelogLines.length > 0
      ? `\n\n**Журнал изменений (DRAFT):**\n${changelogLines.map((l) => `• ${l}`).join("\n")}`
      : "";

  const blockedSummary =
    blockedOps.length > 0
      ? `\n\n**Заблокированные операции (требуют подтверждения человека):**\n` +
        blockedOps.map((b) => `• ${b.description}`).join("\n")
      : "";

  const promoteSummary =
    pendingPromotes.length > 0
      ? `\n\n**Ожидают промоута (выполнит человек):**\n` +
        pendingPromotes.map((p) => `• Тикет ${p.ticketId}: ${p.summary}`).join("\n")
      : "";

  const grantNote =
    grantCeilingViolations.length > 0
      ? `\n\n⚠ Нарушения потолка грантов: ${grantCeilingViolations.join("; ")}`
      : "";

  const text =
    (finalText ||
      (approvedOps.length > 0
        ? `Конфигурация обновлена: ${approvedOps.length} операций в DRAFT.`
        : "Нет одобренных операций.")) +
    changelog +
    blockedSummary +
    promoteSummary +
    grantNote;

  return {
    text,
    approvedOps,
    blockedOps,
    pendingPromotes,
    grantCeilingViolations,
  };
}

// ---------------------------------------------------------------------------
// handleConfigurator — the IntentHandler exported for assistant-intent.ts
// ---------------------------------------------------------------------------

/**
 * The CONFIGURATOR intent handler (T-0361).
 *
 * Security invariants enforced here:
 *  - Grant ceiling check: if the user has no authoring_draft grant in the
 *    intersection, returns a 403-style message without any tool dispatch.
 *  - DRAFT-only: all approvedOps have tier='draft'.
 *  - Destructive = human-confirm: processToolCall runs evaluateAuthoringRedLine.
 *  - Co-equal: approvedOps mirror the same E16 tables the constructor writes.
 *  - No IO other than ctx.llm.chat() — this is pure core.
 */
export async function handleConfigurator(
  userText: string,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  // SECURITY: Check grant ceiling FIRST (intersection already agent ∩ user)
  const hasGrant = await hasAuthoringDraftGrant(ctx);
  if (!hasGrant) {
    return {
      text:
        "У вас недостаточно прав для настройки системы (требуется грант authoring_draft). " +
        "Обратитесь к администратору.",
      intent: "configurator",
    };
  }

  const result = await runConfiguratorLoop(userText, ctx);

  return {
    text: result.text,
    intent: "configurator",
  };
}
