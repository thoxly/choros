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
import {
  evaluateAuthoringRedLine,
  type AuthoringOp,
  type AuthoringContext,
} from "./authoring-redlines.js";
import {
  resolveRelationTarget,
  type RegistryDefCandidate,
  type RelationCascadeDecision,
} from "./relation-cascade.js";

/**
 * T-0724: a registry candidate for the list_registries introspection tool — carries
 * applicationId (unlike RegistryDefCandidate above, the narrower relation-cascade
 * dedup shape that has no application scoping concept). Populated by the HTTP layer
 * from the SAME DAO the human registry picker uses (listRegistryDefs,
 * src/http/registry-defs.ts, reused verbatim — see fetchRegistryListCandidates in
 * src/http/assistant.ts) — never a bespoke query, never a wider result than what
 * GET /api/registry-defs already returns for that tenant.
 */
export interface RegistryListCandidate {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly applicationId: string;
}
import { generateSlugFromName } from "./slug-generator.js";
import type { ChatLlmRequest, ChatLlmResult, ChatToolCall } from "./llm-port.js";
// T-0600: canonical, jargon-free error text for a caught LLM failure — never
// echo the raw err.message (may embed a provider's raw JSON body).
import { canonicalizeLlmError } from "./llm-port.js";
// T-0475 [E-AGENTS L4]: operating a SYSTEM agent (the configurator IS one) is the
// capability axis canOperateSystemAgent — authoring_draft OR system_agent:operate.
import { canOperateSystemAgent } from "./capability-authz.js";

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

// slug validation: lowercase alphanumerics + dashes, 1..64 — mirrors
// applications.ts SLUG_RE / registry-defs.ts so a bot-authored slug is the
// same URL-shaped identifier the visual constructor produces (co-equal).
const CONFIGURATOR_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * create_application — T-0462 (D8-G1): create a NEW section + application in DRAFT.
 *
 * Unlike edit_jsonschema (which edits an EXISTING registry_def by id), this tool
 * CREATES a brand-new application + a primary registry_def "section" under it.
 * Both land in DRAFT tier (application.tier='draft'); a human promotes later.
 * Co-equal: writes the SAME application + registry_def tables the visual
 * constructor writes (applications.ts POST / registry-defs.ts POST).
 */
const TOOL_CREATE_APPLICATION: ToolDeclaration = {
  type: "function",
  function: {
    name: "create_application",
    description:
      "Create a NEW application (and its primary section/registry) in DRAFT tier. " +
      "Use this when the user asks to BUILD a new app that does NOT exist yet " +
      "(«построй приложение …», «собери CRM», «создай раздел …»). " +
      "Both the application and its section land in DRAFT; a human promotes later. " +
      "To EDIT an existing application's fields, use edit_jsonschema instead.",
    parameters: {
      type: "object",
      properties: {
        appSlug: { type: "string", description: "URL-shaped slug for the application (lowercase a-z0-9-, 1..64)." },
        appDisplayName: { type: "string", description: "Human-readable application name (e.g. «Заявки на закупку»)." },
        appDescription: { type: "string", description: "Optional one-line description of the application." },
        sectionSlug: { type: "string", description: "Optional slug for the primary section/registry (defaults to appSlug)." },
        sectionDisplayName: { type: "string", description: "Optional display name for the primary section (defaults to appDisplayName)." },
        recordSchema: { type: "string", description: "Optional JSON string: initial record_schema for the section (defaults to an empty object schema)." },
        humanReadableReason: { type: "string", description: "Why this application is being created (for changelog)." },
      },
      required: ["appSlug", "appDisplayName", "humanReadableReason"],
    },
  },
};

/**
 * relate_application — T-0463 (D8-G2): add a RELATION field whose target may not
 * exist yet, cascading the related application into the SAME draft bundle.
 *
 * The bot describes the relation target by slug and/or display name. The cascade
 * primitive (resolveRelationTarget) then DEDUPS against existing registry_defs:
 *   - found one     → LINK (no duplicate app) and the relation field gets its id.
 *   - found none    → CREATE the related app in the same draft bundle (one promote).
 *   - ambiguous     → ASK (returned as a clarification; no guess).
 *   - too deep      → STOP (hop-cap=3, no runaway fan-out).
 *
 * This is the SAME primitive the visual relation-picker uses (Развилка-5: one
 * primitive, two drivers).
 */
const TOOL_RELATE_APPLICATION: ToolDeclaration = {
  type: "function",
  function: {
    name: "relate_application",
    description:
      "Add a RELATION field on an application that points to ANOTHER application " +
      "(«поле-связь на Контрагентов»). If that target application does NOT exist " +
      "yet, it is CREATED in the same DRAFT bundle (one promote brings both). " +
      "If it already exists, the field LINKS to it (no duplicate). If the match is " +
      "ambiguous, you are asked to clarify. Use this instead of edit_jsonschema " +
      "when the relation target may need to be created.",
    parameters: {
      type: "object",
      properties: {
        sourceRegistryDefId: { type: "string", description: "UUID of the registry_def to add the relation field to (the SOURCE)." },
        relationFieldKey: { type: "string", description: "Field key for the new relation field (e.g. «contractor»)." },
        relationFieldLabel: { type: "string", description: "Human label for the relation field (e.g. «Контрагент»)." },
        targetAppSlug: { type: "string", description: "Slug of the target application to relate to (optional if name given)." },
        targetAppDisplayName: { type: "string", description: "Display name of the target application (e.g. «Контрагенты»)." },
        humanReadableReason: { type: "string", description: "Why this relation is being created (for changelog)." },
      },
      required: ["sourceRegistryDefId", "relationFieldKey", "humanReadableReason"],
    },
  },
};

/**
 * list_registries — T-0724 (E-FORMS, столп 5 «бот==человек»): introspection tool,
 * READ-ONLY, no DRAFT write. Lists the REAL registry_def rows (slug + human
 * display_name) the acting user can see — the SAME data the human bind-form's
 * "Реестр результата" picker fetches (GET /api/registry-defs, T-0681). Closes the
 * gap T-0700 left open: T-0700 let the bot NAME a targetRegistrySlug in
 * author_binding, but the bot still had to GUESS the exact slug — a human always
 * sees the real options in a dropdown, the bot had no equivalent. This tool is
 * that equivalent: call it BEFORE author_binding to learn real slugs instead of
 * guessing (a guessed slug the tenant does not have is honestly rejected server-
 * side, T-0681 — this tool prevents the guess in the first place).
 */
const TOOL_LIST_REGISTRIES: ToolDeclaration = {
  type: "function",
  function: {
    name: "list_registries",
    description:
      "Перечислить РЕАЛЬНЫЕ реестры (registry_def: slug + человеко-читаемое название) — " +
      "ТЕ ЖЕ данные, что видит человек в пикере «Реестр результата» при привязке процесса " +
      "(нельзя показать больше, чем видит человек). Вызывай этот инструмент ПЕРЕД author_binding, " +
      "когда нужно указать targetRegistrySlug — чтобы взять РЕАЛЬНЫЙ slug, а не угадывать его " +
      "(угаданный slug, которого нет у приложения, сервер честно отклонит). Ничего не пишет " +
      "и не требует прав сверх тех, что уже нужны для работы с конфигуратором.",
    parameters: {
      type: "object",
      properties: {
        applicationId: {
          type: "string",
          description:
            "Необязательно: UUID приложения, чьи реестры перечислить. Пусто — перечисляются " +
            "реестры ВСЕХ приложений этого пространства (то же, чем GET /api/registry-defs " +
            "отвечает без фильтра). Приложение без реестров даёт честный пустой список, не ошибку.",
        },
      },
      required: [],
    },
  },
};

/** author_binding — upsert a process_app_binding (trigger type + start form + field mapping). */
const TOOL_AUTHOR_BINDING: ToolDeclaration = {
  type: "function",
  function: {
    name: "author_binding",
    description:
      "Upsert a process_app_binding row in DRAFT tier — links a process to an application " +
      "with trigger type, start form, field mapping, and (optionally) the target registry " +
      "the step result is written into. Writes to DRAFT only; human promotes.",
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
        // T-0700 (E-FORMS, столп 5): mirrors the visual constructor's "Реестр результата"
        // picker (T-0681) — an agent without this parameter could not reach a non-default
        // registry that a human could always pick in the UI (bot≠human asymmetry).
        targetRegistrySlug: {
          type: "string",
          description:
            "Необязательно: slug реестра (registry_def) внутри приложения этой привязки, " +
            "куда должен попасть результат шага процесса — если он должен отличаться от " +
            "реестра приложения по умолчанию. Укажите только когда пользователь явно " +
            "просит направить результат в ДРУГОЙ, конкретный реестр этого приложения. " +
            "Пусто или не указано — используется реестр по умолчанию (прежнее поведение). " +
            "Значение должно быть slug'ом РЕАЛЬНОГО реестра этого приложения — иначе сервер " +
            "честно отклонит привязку, а не создаст её вслепую.",
        },
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

/**
 * apply_form_document_op — T-0743 (E-FORMS, столпы 2+5, follow-up T-0725):
 * apply ONE form-document mutation (insert/remove/reorder/update/move) to an
 * EXISTING form layout — the SAME op vocabulary + content gate the human
 * canvas (FormDesigner.jsx) and the agent HTTP seam (POST /api/forms/
 * document-ops, T-0656/T-0725) already share. This tool is the LLM-facing
 * registration ADR-T0656 §4.4 deferred as a FINDING — the machine seam
 * existed as raw HTTP but was NOT reachable from the configurator's tool
 * loop.
 *
 * AUTH MODEL (docs/tasks/T-0743.spec.md §4.4 mini-ADR, r2): `form_binding`
 * (the table this op ultimately writes) carries NO draft/published tier — a
 * human process_designer's FormDesigner save is ALWAYS live, immediately.
 * Every OTHER configurator tool's DRAFT-ONLY invariant (file header,
 * SECURITY INVARIANT 1) is enforced via a `tier='draft'` column on the
 * table it writes; this op has no such column to gate on. The executor
 * (src/http/assistant.ts, case "apply_form_document_op") substitutes the
 * BOUND APPLICATIONS' tiers as the discriminant instead — and because
 * form_binding is keyed (tenant_id, process_key, form_key) with NO
 * application dimension, EVERY application a process is bound to renders
 * the SAME row. The gate is therefore over ALL bindings, not just the
 * pinned one (r2 after the judge's live-PG adversarial probe: on a mixed
 * draft+published process a valid draft pin would mutate the very layout
 * the published app serves to real users): the tool may patch a form ONLY
 * when EVERY application the process is bound to is DRAFT-tier. This is
 * STRICTLY NARROWER than what a human process_designer may do via the UI
 * (unrestricted by application tier) — bot ≤ human, never the reverse —
 * and changes NOTHING about the human path or the existing HTTP route's
 * contract.
 *
 * applicationId mirrors T-0700's targetRegistrySlug pattern: optional, only
 * needed when the process is bound to 2+ applications. Omitting it on an
 * ambiguous process is NOT a silent guess — the executor surfaces the
 * route's existing 422 AMBIGUOUS_APPLICATION (T-0725) as an honest per-op
 * failure naming every candidate, which reads as the assistant ASKING which
 * application, not failing outright (buildHonestOpsReport, T-0607 в2).
 */
const TOOL_APPLY_FORM_DOCUMENT_OP: ToolDeclaration = {
  type: "function",
  function: {
    name: "apply_form_document_op",
    description:
      "Изменить ОДНИМ действием уже существующую форму процесса — вставить, удалить, " +
      "переместить, обновить или переупорядочить блок. Это ТА ЖЕ операция, что делает " +
      "канвас конструктора форм. Форма должна УЖЕ существовать (создать форму с нуля — " +
      "инструмент emit_form). Работает ТОЛЬКО когда ВСЕ приложения, к которым привязан " +
      "процесс, в статусе ЧЕРНОВИК (неопубликованы): форма у процесса ОДНА на все его " +
      "привязки, поэтому если хотя бы одно из привязанных приложений уже опубликовано — " +
      "правка запрещена, её делает человек через конструктор форм. Если процесс привязан " +
      "к НЕСКОЛЬКИМ приложениям (все черновики), укажи applicationId — иначе система " +
      "честно попросит уточнить, какое приложение имеется в виду, вместо того чтобы угадывать.",
    parameters: {
      type: "object",
      properties: {
        processKey: { type: "string", description: "Ключ процесса, форма которого меняется." },
        stepKey: { type: "string", description: "Ключ шага/формы (form_key) внутри процесса." },
        op: {
          type: "string",
          description:
            "JSON-строка ОДНОЙ операции: {kind, ...}. kind ∈ insert | remove | reorder | update | move. " +
            "insert: {containerPath, node, index?, tabIndex?}; remove: {containerPath, index, tabIndex?}; " +
            "reorder: {containerPath, fromIndex, toIndex, tabIndex?}; update: {containerPath, index, patch, tabIndex?}; " +
            "move: {fromPath, toPath, fromTab?, toTab?}.",
        },
        applicationId: {
          type: "string",
          description:
            "Необязательно: UUID приложения, чью привязку процесса использовать — нужно, " +
            "только если процесс привязан к НЕСКОЛЬКИМ приложениям (иначе система честно " +
            "попросит уточнить, а не угадает). ВСЕ привязанные приложения процесса должны " +
            "быть черновиками — если хотя бы одно опубликовано, правка запрещена даже с " +
            "указанным черновичным applicationId (форма общая на все привязки).",
        },
        humanReadableReason: { type: "string", description: "Зачем меняется форма (для журнала)." },
      },
      required: ["processKey", "stepKey", "op", "humanReadableReason"],
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

/**
 * generate_process — T-0464 (D8-G3): generate a FREE-TOPOLOGY BPMN process from a
 * text description. The HTTP layer runs the generate→validate→repair loop
 * (runProcessGenLoop), grounding gateway conditions + lane roles on the app's real
 * fields/roles. The converged draft lands as a process_definition DRAFT for human
 * review in the Modeler — NEVER auto-published. On lint-exhaustion or an ungroundable
 * reference, the loop surfaces honestly (no broken process is emitted).
 *
 * Use this when the user describes a PROCESS / WORKFLOW in words («процесс: подача →
 * согласование → если сумма большая → доп. согласование, иначе закрыть»), as opposed
 * to authoring a single field/form/binding by hand.
 */
const TOOL_GENERATE_PROCESS: ToolDeclaration = {
  type: "function",
  function: {
    name: "generate_process",
    description:
      "Generate a NEW executable BPMN process (free topology — branches, parallel, " +
      "timers, lanes) from a text description. The system runs a generate→validate→" +
      "repair loop and grounds gateway conditions + lane roles on the bound app's real " +
      "fields/roles. The result lands as a DRAFT for human review in the Modeler; it is " +
      "NEVER auto-published. Use this when the user describes a workflow/process in words.",
    parameters: {
      type: "object",
      properties: {
        processName: { type: "string", description: "Human-readable name for the process (e.g. «Согласование закупок»)." },
        processKey: { type: "string", description: "Optional slug for the process (auto-generated from name when absent)." },
        description: { type: "string", description: "The user's text description of the process to generate." },
        applicationId: { type: "string", description: "Optional UUID of the application whose fields ground the gateway conditions." },
        humanReadableReason: { type: "string", description: "Why this process is being generated (for changelog)." },
      },
      required: ["processName", "description", "humanReadableReason"],
    },
  },
};

/**
 * propose_plan — T-0465 (D8-G4): PLAN-IN-DIALOGUE. The bot describes, in plain
 * human language, the WHOLE solution it intends to build (which application + fields,
 * which related apps it would CREATE vs LINK, which process steps + roles) BEFORE
 * generating anything. This tool writes NOTHING — it is a proposal the user can refine
 * by text. The user must CONFIRM («да», «давай», «генерируй») before the bot calls the
 * generating tools (create_application / relate_application / generate_process).
 *
 * INVARIANT: a propose_plan call produces NO ApprovedOp (no DRAFT write). It surfaces
 * a PlanProposal the HTTP layer renders as the plan-step of the flow.
 */
const TOOL_PROPOSE_PLAN: ToolDeclaration = {
  type: "function",
  function: {
    name: "propose_plan",
    description:
      "Propose, in plain human language, the WHOLE solution you intend to build, " +
      "BEFORE generating anything. Use this FIRST when the user describes a problem/solution " +
      "(«у нас бардак с закупками…», «построй CRM», «собери приложение заявок»). " +
      "Describe: which application + fields; which RELATED apps you would CREATE vs LINK to existing; " +
      "the process steps + branching + roles. Writes NOTHING — it is editable by the user's next message. " +
      "Only AFTER the user confirms the plan («да», «давай», «генерируй») call the generating tools.",
    parameters: {
      type: "object",
      properties: {
        planText: {
          type: "string",
          description:
            "The human-language plan, e.g. «Создам приложение «Заявки на закупку» с полями …; " +
            "приложения «Контрагенты» у вас нет — создам связанное; процесс: подача → согласование → " +
            "если сумма большая → доп. согласование, иначе закрыть». Multi-line is fine.",
        },
        humanReadableReason: {
          type: "string",
          description: "Why this is the right plan for the user's described problem.",
        },
      },
      required: ["planText"],
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

// ---------------------------------------------------------------------------
// CONFIGURATOR_DEFAULT_SYSTEM_PROMPT — hardcoded fallback (T-0383: B10).
//
// Exported so the HTTP layer can surface it as the pre-fill default in the UI.
// ---------------------------------------------------------------------------

/**
 * The default (hardcoded) configurator system prompt.
 * Tenants that have not set a custom prompt get this text verbatim.
 * T-0383: this constant is the single source of truth for the default; the
 * UI shows it in the prompt editor as placeholder/pre-fill when unset.
 */
export const CONFIGURATOR_DEFAULT_SYSTEM_PROMPT =
  "Ты — конфигуратор-агент системы Choros (режим CONFIGURATOR). " +
  "Твоя задача — помочь пользователю настроить систему: добавить поля, формы, привязки процессов, DMN-таблицы. " +
  "ВСЕ изменения вносятся ТОЛЬКО в DRAFT (черновик). Промоут в production выполняет ЧЕЛОВЕК. " +
  "Деструктивные операции (удаление/переименование поля, потеря данных) НЕЛЬЗЯ выполнять без явного подтверждения человека. " +
  // T-0465 (D8-G4): PLAN-IN-DIALOGUE — план словами ПЕРЕД генерацией.
  "ВАЖНО (порядок работы со сквозным решением): когда пользователь ОПИСЫВАЕТ задачу/проблему словами " +
  "(«у нас бардак с закупками», «построй приложение заявок», «собери CRM») — СНАЧАЛА вызови propose_plan " +
  "и опиши ВЕСЬ план человеческим языком (какое приложение и поля; какие связанные приложения СОЗДАТЬ, а какие " +
  "ВЗЯТЬ существующие; шаги процесса, ветвление, роли). propose_plan НИЧЕГО НЕ ПИШЕТ — это предложение, " +
  "которое пользователь правит текстом. НЕ вызывай create_application / relate_application / generate_process, " +
  "пока пользователь ЯВНО не подтвердит план («да», «давай», «генерируй», «поехали»). " +
  "Когда план подтверждён — собери ВСЁ решение за ОДИН заход (приложение + связанные приложения + процесс) единым бандлом. " +
  "Используй инструменты для каждого конкретного изменения. " +
  "Если поле-связь ссылается на приложение, которого ещё нет — используй relate_application: " +
  "система сама создаст связанное приложение в том же черновике или сошлётся на существующее (без дубликатов). " +
  // T-0724 (столп 5): list_registries FIRST — never guess a targetRegistrySlug.
  "Если пользователь просит направить результат шага процесса в КОНКРЕТНЫЙ (не дефолтный) реестр — " +
  "СНАЧАЛА вызови list_registries (реестры того приложения), чтобы узнать РЕАЛЬНЫЕ slug'и, и только " +
  "потом вызывай author_binding с targetRegistrySlug из этого списка. Никогда не угадывай slug реестра. " +
  "list_registries ничего не пишет — только показывает то, что видит человек в своём пикере. " +
  // T-0743 (столп 2+5): apply_form_document_op — patch an EXISTING form via
  // the closed op vocabulary; ALL-bindings-draft-only (r2), honest ask on ambiguity.
  "Если нужно изменить УЖЕ существующую форму процесса (добавить/убрать/переместить/обновить блок) — " +
  "используй apply_form_document_op ОДНИМ действием на операцию. Он работает, только когда ВСЕ " +
  "приложения, к которым привязан процесс, — ЧЕРНОВИКИ (форма у процесса одна на все привязки; " +
  "если хотя бы одно привязанное приложение опубликовано — правка запрещена, её делает человек). " +
  "Если процесс привязан к нескольким приложениям-черновикам, укажи applicationId " +
  "или система честно попросит уточнить, какое приложение имеется в виду. " +
  "Если пользователь описывает ПРОЦЕСС/маршрут словами (подача → согласование → если сумма большая → доп. согласование) — " +
  "используй generate_process: система соберёт BPMN циклом генерация→проверка→починка, заземлит условия и роли на реальные поля, " +
  "и положит черновик в Модельер на ревью (без авто-публикации). " +
  "После генерации НЕ пытайся показать конструктор в чате — дай пользователю ссылки на разделы (Приложения / Модельер), " +
  "ревью происходит ВИЗУАЛЬНО там, и там же человек публикует весь бандл одним действием. " +
  "После каждого изменения кратко объясни что и зачем было сделано. " +
  "Если конфигурация завершена — вызови request_promote с описанием изменений. " +
  "Отвечай по-русски.";

/** All E16 authoring tools available to the configurator. */
const CONFIGURATOR_TOOLS: readonly ToolDeclaration[] = [
  // T-0465 (D8-G4): propose_plan FIRST — plan-in-dialogue precedes any generation.
  TOOL_PROPOSE_PLAN,
  TOOL_CREATE_APPLICATION,
  TOOL_RELATE_APPLICATION,
  // T-0724: introspection BEFORE author_binding — lets the bot learn real
  // targetRegistrySlug values instead of guessing (T-0700 declared the param;
  // this tool answers "what are the real slugs?").
  TOOL_LIST_REGISTRIES,
  TOOL_AUTHOR_BINDING,
  TOOL_EDIT_JSONSCHEMA,
  TOOL_EMIT_FORM,
  // T-0743: patches an EXISTING form (emit_form above creates one) — declared
  // right after emit_form to mirror that create-then-edit ordering.
  TOOL_APPLY_FORM_DOCUMENT_OP,
  TOOL_AUTHOR_DMN,
  TOOL_GENERATE_PROCESS,
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
    | "create_application"
    | "relate_application"
    | "author_binding"
    | "edit_jsonschema_non_destructive"
    | "emit_form"
    | "apply_form_document_op"
    | "author_dmn"
    | "generate_process";
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

/**
 * T-0465 (D8-G4): PLAN-IN-DIALOGUE. A propose_plan result — the bot's human-language
 * plan for the whole solution, surfaced BEFORE anything is generated. Carries NO write.
 * The HTTP layer renders this as the plan-step (user confirms/refines by text).
 */
export interface PlanProposal {
  /** The human-language plan text the user reviews + refines. */
  readonly planText: string;
}

// ---------------------------------------------------------------------------
// ConfiguratorResult — returned by runConfigurator, used by handleConfigurator
// ---------------------------------------------------------------------------

/**
 * T-0466 [D8-G5]: when a non-holder is refused the authoring sandbox, we offer
 * to CAPTURE their description as a config-request (заявка на настройку) directed
 * to an admin/owner so the intent is not lost. This is the signal the pure core
 * returns; the HTTP layer (assistant.ts) persists it via the EXISTING notification
 * mechanism (PgNotificationStore — migration 046), routed to authoring_draft
 * holders. No new table.
 *
 * The core stays pure: it does NOT decide recipients or write anything; it only
 * surfaces the verbatim user description that should be captured.
 */
export interface CaptureRequest {
  /** The verbatim description the non-holder gave (what they want configured). */
  readonly description: string;
}

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
  /**
   * T-0465 (D8-G4): plan-in-dialogue proposals. Non-empty when the bot proposed a
   * plan (via propose_plan) instead of (or before) generating. When present, the
   * HTTP layer surfaces the plan and does NOT expect DRAFT writes this turn.
   */
  readonly planProposals: readonly PlanProposal[];
  /** Whether the intersection grant ceiling was insufficient for any op. */
  readonly grantCeilingViolations: readonly string[];
  /**
   * T-0466 [D8-G5]: set ONLY when the user was refused for lacking the
   * authoring_draft grant AND their message described something to configure.
   * The HTTP layer persists this as a config-request notification to admins.
   * undefined → nothing to capture (holder, or empty/trivial message).
   */
  readonly captureRequest?: CaptureRequest;
}

// ---------------------------------------------------------------------------
// T-0466 [D8-G5]: human-friendly access-refusal text (spec §3.5, PD-21).
//
// The non-holder must NOT see a raw 503/opaque error. They see this warm,
// plain-language message. When their message describes something to configure,
// we ALSO offer to capture it as a config-request to an admin (capture-as-request).
// ---------------------------------------------------------------------------

/** Base human refusal — no jargon front-and-center, points at the administrator. */
export const AUTHORING_ACCESS_DENIED_MESSAGE =
  "У вас нет прав настраивать систему — это может сделать администратор или владелец. " +
  "Обратитесь к администратору вашего пространства.";

/** Appended when we captured the user's description as a config-request. */
export const AUTHORING_CAPTURE_CONFIRMATION =
  "Я передал ваше описание администратору как заявку на настройку — он увидит его и сможет всё сделать. " +
  "Вам ничего больше делать не нужно.";

/**
 * T-0466: does a non-holder's message carry an actual description worth
 * capturing? Trivial pings («привет», «?») are not captured. Heuristic:
 * non-empty after trim and at least a few characters of substance.
 */
export function isCaptureWorthy(text: string): boolean {
  return text.trim().length >= 5;
}

// ---------------------------------------------------------------------------
// T-0465 (D8-G4): plan confirmation heuristic.
//
// PLAN-IN-DIALOGUE: the bot proposes a plan first (propose_plan, no writes); the
// user confirms with a short affirmation, after which the bot generates the bundle.
// This heuristic lets the HTTP layer (and tests) detect a confirmation turn so the
// plan-vs-generate boundary is observable. It is intentionally conservative — short
// affirmative messages confirm; a fresh problem description does NOT.
// ---------------------------------------------------------------------------

/** Whether `text` reads as a user confirming a previously-proposed plan. */
export function confirmsPlan(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length === 0) return false; // empty never confirms
  // Affirmation tokens (RU + EN). Matched as whole words / common phrasings.
  const AFFIRM = [
    "да", "давай", "давайте", "генерируй", "генерируйте", "собери", "собирай",
    "поехали", "go", "подтверждаю", "подтвердить", "ок", "окей", "согласен",
    "согласна", "верно", "всё верно", "все верно", "делай", "делайте",
    "погнали", "ага", "угу", "yes", "confirm", "approve", "build it", "let's go",
  ];
  // Exact short answer, or message that starts with an affirmation token.
  for (const a of AFFIRM) {
    if (t === a) return true;
    if (t.startsWith(a + " ") || t.startsWith(a + ",") || t.startsWith(a + ".") || t.startsWith(a + "!")) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Grant ceiling check
// ---------------------------------------------------------------------------

/**
 * Check whether the caller may OPERATE the configurator system agent (spec §6,
 * T-0475). The decision is SERVER-SIDE and DETERMINISTIC — made here, BEFORE any
 * LLM call — so the LLM never decides rights (T-0607 defect б).
 *
 * Authority = EITHER:
 *   1. the on-behalf-of user is the tenant OWNER — the owner short-circuit that
 *      `canOperateSystemAgent`'s contract explicitly assigns to the CALLER
 *      (capability-authz.ts: "The owner short-circuit (isGenesisOwner) is applied
 *      by the caller"). Resolved via ctx.isTenantOwner (wired by the composition
 *      root to the SAME isGenesisOwnerForTenant resolver the honest-503 path uses).
 *      This closes the live defect: a genesis OWNER whose authority flows from
 *      OWNERSHIP (not an explicit intersecting grant) was falsely refused, because
 *      the OLD check looked ONLY at the agent∩user intersection — which could be
 *      empty for the owner and flap by the seeded agent's grant scope; OR
 *   2. an effective authoring_draft (create/update) / system_agent:operate grant
 *      in the intersection — the SAME canOperateSystemAgent predicate.
 *
 * SECURITY: the owner short-circuit does NOT widen non-owners' rights (a
 * non-owner without the capability still returns false). For non-owners the check
 * uses ctx.intersectionGrants (agent ∩ user, never wider) — the agent still
 * cannot author on behalf of a user who holds neither capability. When
 * ctx.isTenantOwner is undefined (tests / stub) the owner branch does not fire —
 * fail-closed to the prior behaviour.
 */
async function hasAuthoringDraftGrant(ctx: HandlerContext): Promise<boolean> {
  // 1) Owner short-circuit (deterministic, server-side) — the live defect (б).
  if (ctx.isTenantOwner) {
    try {
      if (await ctx.isTenantOwner()) return true;
    } catch {
      // Owner resolution failed → fall through to the grant check (fail-closed).
    }
  }
  // 2) Capability via the intersection grants (agent ∩ user, never wider).
  const nowMs = Date.now();
  const grants = await ctx.intersectionGrants.getGrants(ctx.userSubject, nowMs);
  return canOperateSystemAgent(grants);
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
  /**
   * T-0463: existing registry_defs to dedup relation cascades against (PD-5).
   * Injected pure from the loop; the HTTP layer supplies the real tenant list.
   * Empty array → every relation target cascades a new app (no dedup possible).
   */
  existingRegistryDefs: readonly RegistryDefCandidate[] = [],
  /**
   * T-0724: this tenant's real registries (id/slug/displayName/applicationId) for
   * the list_registries introspection tool. Injected pure from the loop; the HTTP
   * layer supplies the SAME data the human registry picker fetches (never wider).
   * Empty array → list_registries honestly reports zero registries (not an error).
   */
  registryListCandidates: readonly RegistryListCandidate[] = [],
): {
  approved?: ApprovedOp;
  blocked?: BlockedOp;
  pendingPromote?: PendingPromote;
  /** T-0465 (D8-G4): a plan proposal (propose_plan) — NO write. */
  planProposal?: PlanProposal;
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
    // create_application — T-0462 (D8-G1): create a NEW app + section in DRAFT.
    // Non-destructive (pure creation). Validates the slug so a bad slug returns
    // an honest blocked message rather than a 500 at the DB layer.
    // -----------------------------------------------------------------------
    case "create_application": {
      const appDisplayName =
        typeof args["appDisplayName"] === "string" ? args["appDisplayName"].trim() : "";

      if (appDisplayName.length === 0) {
        const blocked: BlockedOp = {
          kind: "pending_human_confirm",
          description: `create_application: не указано название приложения (appDisplayName).`,
          toolName: call.name,
          requiredAction: "Укажите название приложения и повторите.",
        };
        return {
          blocked,
          changelogLine: `⚠ [ЗАБЛОКИРОВАНО] create_application: пустое название`,
          toolResultContent: `error: empty appDisplayName`,
        };
      }

      // T-0650 [столп 5 / UX-study §7]: the assistant does not have to invent a
      // machine-shaped slug — it uses the SAME generator the human-facing
      // SlugField mirrors (src/core/slug-generator.ts). A missing/invalid
      // appSlug arg auto-derives from appDisplayName instead of blocking the
      // operation with "please provide a valid slug". An EXPLICIT valid slug
      // (the LLM tool-called with one) is still honored as before.
      const rawAppSlug = typeof args["appSlug"] === "string" ? args["appSlug"] : "";
      const appSlug = CONFIGURATOR_SLUG_RE.test(rawAppSlug)
        ? rawAppSlug
        : generateSlugFromName(appDisplayName);

      // Section defaults to the application's own slug/name when not specified.
      const sectionSlug =
        typeof args["sectionSlug"] === "string" && CONFIGURATOR_SLUG_RE.test(args["sectionSlug"])
          ? args["sectionSlug"]
          : appSlug;
      const sectionDisplayName =
        typeof args["sectionDisplayName"] === "string" && args["sectionDisplayName"].trim()
          ? args["sectionDisplayName"].trim()
          : appDisplayName;

      const approved: ApprovedOp = {
        kind: "create_application",
        description:
          `Создание приложения «${appDisplayName}» (slug=${appSlug}) ` +
          `с разделом «${sectionDisplayName}» (slug=${sectionSlug}) [DRAFT]: ${reason}`,
        // Normalize args so the executor sees resolved section fields.
        args: { ...args, appSlug, appDisplayName, sectionSlug, sectionDisplayName },
        tier: "draft",
      };
      return {
        approved,
        changelogLine: `✓ [DRAFT] create_application: ${approved.description}`,
        toolResultContent: JSON.stringify({
          status: "draft",
          appSlug,
          appDisplayName,
          sectionSlug,
          tier: "draft",
        }),
      };
    }

    // -----------------------------------------------------------------------
    // relate_application — T-0463 (D8-G2): add a relation field, cascading the
    // target application into the same DRAFT bundle when it doesn't exist.
    // Uses the SHARED resolveRelationTarget primitive (same as the visual picker).
    // -----------------------------------------------------------------------
    case "relate_application": {
      const sourceRegistryDefId =
        typeof args["sourceRegistryDefId"] === "string" ? args["sourceRegistryDefId"] : "";
      const relationFieldKey =
        typeof args["relationFieldKey"] === "string" ? args["relationFieldKey"].trim() : "";
      const relationFieldLabel =
        typeof args["relationFieldLabel"] === "string" && args["relationFieldLabel"].trim()
          ? args["relationFieldLabel"].trim()
          : relationFieldKey;
      const targetAppSlug =
        typeof args["targetAppSlug"] === "string" ? args["targetAppSlug"].trim() : "";
      const targetAppDisplayName =
        typeof args["targetAppDisplayName"] === "string" ? args["targetAppDisplayName"].trim() : "";

      if (!sourceRegistryDefId || !relationFieldKey) {
        const blocked: BlockedOp = {
          kind: "pending_human_confirm",
          description:
            `relate_application: не указан исходный набор полей или ключ поля-связи.`,
          toolName: call.name,
          requiredAction: "Укажите sourceRegistryDefId и relationFieldKey и повторите.",
        };
        return {
          blocked,
          changelogLine: `⚠ [ЗАБЛОКИРОВАНО] relate_application: отсутствует источник/ключ`,
          toolResultContent: `error: missing sourceRegistryDefId or relationFieldKey`,
        };
      }
      if (!targetAppSlug && !targetAppDisplayName) {
        const blocked: BlockedOp = {
          kind: "pending_human_confirm",
          description: `relate_application: не указан целевой приложение-цель (slug/название).`,
          toolName: call.name,
          requiredAction: "Укажите targetAppSlug или targetAppDisplayName и повторите.",
        };
        return {
          blocked,
          changelogLine: `⚠ [ЗАБЛОКИРОВАНО] relate_application: нет цели связи`,
          toolResultContent: `error: missing relation target slug/name`,
        };
      }

      // Resolve the relation target via the SHARED cascade primitive.
      // depth=1: the first cascade off a top-level relation creates an app at depth 1.
      const decision: RelationCascadeDecision = resolveRelationTarget(
        { targetSlug: targetAppSlug || undefined, targetDisplayName: targetAppDisplayName || undefined },
        existingRegistryDefs,
        1,
      );

      if (decision.decision === "ask") {
        const blocked: BlockedOp = {
          kind: "pending_human_confirm",
          description: decision.question,
          toolName: call.name,
          requiredAction:
            "Уточните, на какое существующее приложение ссылаться, или подтвердите создание нового.",
        };
        return {
          blocked,
          changelogLine: `❓ [ОЖИДАЕТ УТОЧНЕНИЯ] relate_application: неоднозначная цель «${targetAppDisplayName || targetAppSlug}»`,
          toolResultContent: JSON.stringify({
            status: "ask",
            question: decision.question,
            candidates: decision.candidates.map((c) => ({ id: c.id, slug: c.slug, name: c.displayName })),
          }),
        };
      }

      if (decision.decision === "hop_cap_exceeded") {
        const blocked: BlockedOp = {
          kind: "pending_human_confirm",
          description:
            `relate_application: каскад связей глубже лимита (${decision.cap}) — ` +
            `создание прекращено во избежание лавины приложений.`,
          toolName: call.name,
          requiredAction: "Сократите цепочку связанных приложений (макс. глубина 3).",
        };
        return {
          blocked,
          changelogLine: `🛑 [ЛИМИТ ГЛУБИНЫ] relate_application: глубина ${decision.attemptedDepth} > ${decision.cap}`,
          toolResultContent: JSON.stringify({
            status: "hop_cap_exceeded",
            attemptedDepth: decision.attemptedDepth,
            cap: decision.cap,
          }),
        };
      }

      // decision is LINK or CREATE — both produce an approved relate_application op.
      // The HTTP executor: for LINK, writes the relation field pointing at the
      // existing target_registry_id; for CREATE, creates the app+section in the
      // SAME bundle, then writes the relation field at the new section's id (atomic).
      const isCreate = decision.decision === "create";
      const approved: ApprovedOp = {
        kind: "relate_application",
        description: isCreate
          ? `Связь «${relationFieldLabel}»: целевое приложение «${decision.appDisplayName}» (slug=${decision.appSlug}) НЕ найдено → создаётся в том же DRAFT-бандле; поле-связь добавляется в исходный набор [DRAFT]: ${reason}`
          : `Связь «${relationFieldLabel}»: найдено существующее приложение (${decision.matchReason}) → ссылка без дубликата [DRAFT]: ${reason}`,
        args: {
          ...args,
          sourceRegistryDefId,
          relationFieldKey,
          relationFieldLabel,
          // Resolved cascade plan — the executor reads this discriminant.
          cascade: isCreate
            ? { mode: "create", appSlug: decision.appSlug, appDisplayName: decision.appDisplayName, depth: decision.depth }
            : { mode: "link", targetRegistryId: decision.targetRegistryId, matchReason: decision.matchReason },
        },
        tier: "draft",
      };
      return {
        approved,
        changelogLine: isCreate
          ? `✓ [DRAFT] relate_application(create): ${approved.description}`
          : `✓ [DRAFT] relate_application(link): ${approved.description}`,
        toolResultContent: JSON.stringify(
          isCreate
            ? { status: "draft", mode: "create_cascade", appSlug: decision.appSlug, relationFieldKey, tier: "draft" }
            : { status: "draft", mode: "link", targetRegistryId: decision.targetRegistryId, matchReason: decision.matchReason, relationFieldKey, tier: "draft" },
        ),
      };
    }

    // -----------------------------------------------------------------------
    // list_registries — T-0724: READ-ONLY introspection, NO ApprovedOp, NO write.
    // Filters the pre-fetched registryListCandidates (tenant-scoped, the SAME data
    // GET /api/registry-defs returns to the human picker) by applicationId when
    // given. Returns slug + human display_name — never more than the human sees.
    // -----------------------------------------------------------------------
    case "list_registries": {
      const rawApplicationId =
        typeof args["applicationId"] === "string" ? args["applicationId"].trim() : "";
      const scoped = rawApplicationId.length > 0
        ? registryListCandidates.filter((r) => r.applicationId === rawApplicationId)
        : registryListCandidates;

      const registries = scoped.map((r) => ({ slug: r.slug, displayName: r.displayName }));
      const scopeNote = rawApplicationId.length > 0 ? ` для приложения «${rawApplicationId}»` : "";
      return {
        // No approved/blocked/pendingPromote/planProposal — this tool writes nothing.
        changelogLine: `ℹ [СПРАВКА] list_registries${scopeNote}: ${registries.length} реестр(ов)`,
        toolResultContent: JSON.stringify({
          status: "ok",
          applicationId: rawApplicationId.length > 0 ? rawApplicationId : null,
          count: registries.length,
          registries,
        }),
      };
    }

    // -----------------------------------------------------------------------
    // author_binding — always non-destructive (upsert on binding, no field drops)
    // -----------------------------------------------------------------------
    case "author_binding": {
      // T-0700: surface a non-default target registry in the audit description,
      // same as the visual constructor's bind-form shows it (parity, not a new op).
      const targetRegistrySlugArg =
        typeof args["targetRegistrySlug"] === "string" ? args["targetRegistrySlug"].trim() : "";
      const registrySuffix = targetRegistrySlugArg.length > 0 ? `, реестр результата=«${targetRegistrySlugArg}»` : "";
      const approved: ApprovedOp = {
        kind: "author_binding",
        description: `Привязка процесса «${String(args["processKey"] ?? "?")}» к приложению «${String(args["applicationId"] ?? "?")}» (тип=${String(args["triggerType"] ?? "?")}${registrySuffix}): ${reason}`,
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
          ...(targetRegistrySlugArg.length > 0 ? { targetRegistrySlug: targetRegistrySlugArg } : {}),
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
    // apply_form_document_op — T-0743: patch an EXISTING form via the SAME op
    // vocabulary the human canvas / HTTP seam use. PURE structural validation
    // only (no IO here — the file stays PURE, per its own header): the op is
    // JSON-parsed and required to be an object carrying a string `kind`, but
    // the CLOSED vocabulary check (insert|remove|reorder|update|move) and the
    // real shape validation are NOT duplicated here — they live solely in
    // applyDocumentOp (src/core/form-document-op-apply.ts), run once, at
    // execution time (src/http/assistant.ts), so there is exactly one place
    // that decides what a valid op is. A garbled kind still reaches
    // execution and fails there with an honest per-op error (T-0607 в2) —
    // fail-closed, not fail-fast-and-silently-wrong.
    // -----------------------------------------------------------------------
    case "apply_form_document_op": {
      const processKey = typeof args["processKey"] === "string" ? args["processKey"].trim() : "";
      const stepKey = typeof args["stepKey"] === "string" ? args["stepKey"].trim() : "";
      const applicationIdArg =
        typeof args["applicationId"] === "string" ? args["applicationId"].trim() : "";
      const rawOp = args["op"];

      if (!processKey || !stepKey) {
        const blocked: BlockedOp = {
          kind: "pending_human_confirm",
          description: `apply_form_document_op: не указан processKey или stepKey.`,
          toolName: call.name,
          requiredAction: "Укажите processKey и stepKey и повторите.",
        };
        return {
          blocked,
          changelogLine: `⚠ [ЗАБЛОКИРОВАНО] apply_form_document_op: нет processKey/stepKey`,
          toolResultContent: `error: missing processKey or stepKey`,
        };
      }

      let parsedOp: Record<string, unknown> | null = null;
      if (typeof rawOp === "string") {
        try {
          const candidate = JSON.parse(rawOp) as unknown;
          if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
            parsedOp = candidate as Record<string, unknown>;
          }
        } catch {
          parsedOp = null;
        }
      }
      const opKind = parsedOp && typeof parsedOp["kind"] === "string" ? parsedOp["kind"] : "";
      if (!parsedOp || !opKind) {
        const blocked: BlockedOp = {
          kind: "pending_human_confirm",
          description: `apply_form_document_op: op не разобран (ожидается JSON-объект с полем kind).`,
          toolName: call.name,
          requiredAction: "Передайте op валидным JSON-объектом с полем kind.",
        };
        return {
          blocked,
          changelogLine: `⚠ [ЗАБЛОКИРОВАНО] apply_form_document_op: невалидный op`,
          toolResultContent: `error: op must be a JSON object with a string "kind"`,
        };
      }

      const approved: ApprovedOp = {
        kind: "apply_form_document_op",
        description:
          `Изменение формы процесса «${processKey}» (шаг «${stepKey}», операция «${opKind}»)` +
          `${applicationIdArg ? `, приложение=«${applicationIdArg}»` : ""} ` +
          `[только для приложений-черновиков]: ${reason}`,
        args: {
          processKey,
          stepKey,
          op: parsedOp,
          ...(applicationIdArg ? { applicationId: applicationIdArg } : {}),
        },
        tier: "draft",
      };
      return {
        approved,
        changelogLine: `✓ [DRAFT] apply_form_document_op: ${approved.description}`,
        toolResultContent: JSON.stringify({
          status: "queued",
          processKey,
          stepKey,
          opKind,
          note:
            "Изменение будет применено, только если ВСЕ приложения, к которым привязан процесс, — " +
            "черновики (форма общая на все привязки); если хотя бы одно опубликовано — честный отказ " +
            "даже с черновичным applicationId; неоднозначная привязка без applicationId — честная " +
            "просьба уточнить, а не выполнение вслепую.",
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
    // generate_process — T-0464 (D8-G3): plan a free-topology process generation.
    // The CORE only PLANS it (validates inputs); the HTTP layer runs the actual
    // generate→validate→repair loop (runProcessGenLoop) and persists the converged
    // draft (status='draft') for human review in the Modeler. Co-equal with the
    // visual modeler: it writes the SAME process_definition draft row.
    // -----------------------------------------------------------------------
    case "generate_process": {
      const processName =
        typeof args["processName"] === "string" ? args["processName"].trim() : "";
      const description =
        typeof args["description"] === "string" ? args["description"].trim() : "";

      if (!processName || !description) {
        const blocked: BlockedOp = {
          kind: "pending_human_confirm",
          description: `generate_process: не указано название процесса или его описание.`,
          toolName: call.name,
          requiredAction: "Укажите processName и description процесса и повторите.",
        };
        return {
          blocked,
          changelogLine: `⚠ [ЗАБЛОКИРОВАНО] generate_process: нет названия/описания`,
          toolResultContent: `error: missing processName or description`,
        };
      }

      const approved: ApprovedOp = {
        kind: "generate_process",
        description:
          `Генерация процесса «${processName}» из текстового описания (цикл генерация→` +
          `проверка→починка; заземление условий/ролей на реальные поля; черновик в Модельер ` +
          `на ревью — без авто-публикации) [DRAFT]: ${reason}`,
        args,
        tier: "draft",
      };
      return {
        approved,
        changelogLine: `✓ [DRAFT] generate_process: ${approved.description}`,
        toolResultContent: JSON.stringify({
          status: "queued_generation",
          processName,
          tier: "draft",
          note: "Процесс будет собран циклом генерация→проверка→починка и положен черновиком в Модельер.",
        }),
      };
    }

    // -----------------------------------------------------------------------
    // propose_plan — T-0465 (D8-G4): PLAN-IN-DIALOGUE. Returns a plan proposal.
    // NO ApprovedOp, NO write — the user reviews/refines by text, then confirms.
    // -----------------------------------------------------------------------
    case "propose_plan": {
      const planText =
        typeof args["planText"] === "string" ? (args["planText"] as string).trim() : "";
      if (!planText) {
        const blocked: BlockedOp = {
          kind: "pending_human_confirm",
          description: "propose_plan: пустой план — нечего предложить.",
          toolName: "propose_plan",
        };
        return {
          blocked,
          changelogLine: "⚠ [ПЛАН] propose_plan без текста — пропущено",
          toolResultContent: "error: propose_plan requires non-empty planText",
        };
      }
      const planProposal: PlanProposal = { planText };
      return {
        planProposal,
        // The plan is NOT a draft write — it is a proposal awaiting confirmation.
        changelogLine: `📋 [ПЛАН — подтвердите, чтобы собрать] ${planText.split("\n")[0]!.slice(0, 80)}`,
        toolResultContent: JSON.stringify({
          status: "plan_proposed",
          message:
            "План предложен — НИЧЕГО не создано. Дождись подтверждения пользователя («да»/«генерируй»), " +
            "затем собери всё решение одним бандлом.",
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
/**
 * T-0383: resolve the effective system prompt for the configurator.
 * Uses the per-tenant override when present; falls back to CONFIGURATOR_DEFAULT_SYSTEM_PROMPT.
 */
function resolveConfiguratorSystemPrompt(override: string | null): string {
  if (override !== null && override.trim().length > 0) {
    return override;
  }
  return CONFIGURATOR_DEFAULT_SYSTEM_PROMPT;
}

async function runConfiguratorLoop(
  userText: string,
  ctx: HandlerContext,
  /** T-0383: per-tenant system prompt override (null → use default). */
  systemPromptOverride: string | null = null,
  /** T-0463: existing registry_defs for relation-cascade dedup (PD-5). */
  existingRegistryDefs: readonly RegistryDefCandidate[] = [],
  /** T-0724: this tenant's real registries for the list_registries tool. */
  registryListCandidates: readonly RegistryListCandidate[] = [],
): Promise<ConfiguratorResult> {
  const approvedOps: ApprovedOp[] = [];
  const blockedOps: BlockedOp[] = [];
  const pendingPromotes: PendingPromote[] = [];
  const planProposals: PlanProposal[] = [];
  const changelogLines: string[] = [];
  const grantCeilingViolations: string[] = [];

  const systemPrompt = resolveConfiguratorSystemPrompt(systemPromptOverride);

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
      // T-0600: LLM error (dormant, provider auth failure, network, etc.) —
      // return partial results with an HONEST, canonical note. The raw err
      // (which for a provider 4xx embeds the provider's full raw response
      // body, see openai-llm-port.ts::_post) is logged server-side ONLY —
      // never interpolated into user-visible text (that was the T-0600 leak:
      // a prior revision embedded err.message verbatim here).
      console.error(`[T-0600] configurator LLM call failed: ${String(err)}`);
      const canonical = canonicalizeLlmError(err);
      finalText =
        `${canonical} ` +
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
      const processed = processToolCall(call, existingRegistryDefs, registryListCandidates);

      if (processed.approved) approvedOps.push(processed.approved);
      if (processed.blocked) blockedOps.push(processed.blocked);
      if (processed.pendingPromote) pendingPromotes.push(processed.pendingPromote);
      if (processed.planProposal) planProposals.push(processed.planProposal);
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

  // T-0465 (D8-G4): PLAN-IN-DIALOGUE. When the bot proposed a plan (no writes this
  // turn), surface the plan prominently and ask for confirmation. This is the
  // plan-step text the user reviews/refines before any generation happens.
  const planSection =
    planProposals.length > 0
      ? `\n\n**План решения (ничего ещё не создано):**\n${planProposals
          .map((p) => p.planText)
          .join("\n\n")}\n\nПодтвердите («да» / «генерируй»), и я соберу всё одним черновиком-бандлом. Или поправьте план текстом.`
      : "";

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
      (planProposals.length > 0
        ? "Вот план — подтвердите, чтобы я собрал решение."
        : approvedOps.length > 0
          ? `Конфигурация обновлена: ${approvedOps.length} операций в DRAFT.`
          : "Нет одобренных операций.")) +
    planSection +
    changelog +
    blockedSummary +
    promoteSummary +
    grantNote;

  return {
    text,
    approvedOps,
    blockedOps,
    pendingPromotes,
    planProposals,
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
 *
 * T-0383: accepts optional per-tenant system prompt override (null → default).
 */
export async function handleConfigurator(
  userText: string,
  ctx: HandlerContext,
  systemPromptOverride: string | null = null,
  /** T-0463: existing registry_defs for relation-cascade dedup (PD-5). */
  existingRegistryDefs: readonly RegistryDefCandidate[] = [],
  /** T-0724: this tenant's real registries for the list_registries tool. */
  registryListCandidates: readonly RegistryListCandidate[] = [],
): Promise<HandlerResult> {
  // SECURITY: Check grant ceiling FIRST (intersection already agent ∩ user)
  const hasGrant = await hasAuthoringDraftGrant(ctx);
  if (!hasGrant) {
    // T-0466 [D8-G5]: HUMAN refusal (no raw 503/jargon front-and-centre).
    // handleConfigurator is the analyst-side IntentHandler contract (text+intent
    // only); the capture-as-request side-effect runs through runConfigurator
    // (which the HTTP route calls for configurator intent). Here we still offer
    // the human "ask an admin" message; capture is wired in runConfigurator.
    const captureNote = isCaptureWorthy(userText)
      ? " Хотите — я передам это администратору как заявку на настройку."
      : "";
    return {
      text: AUTHORING_ACCESS_DENIED_MESSAGE + captureNote,
      intent: "configurator",
    };
  }

  const result = await runConfiguratorLoop(
    userText,
    ctx,
    systemPromptOverride,
    existingRegistryDefs,
    registryListCandidates,
  );

  return {
    text: result.text,
    intent: "configurator",
  };
}

// ---------------------------------------------------------------------------
// runConfigurator — exported for the HTTP layer (T-0363 draft execution)
// ---------------------------------------------------------------------------

/**
 * T-0363: Run the configurator planning loop and return the FULL ConfiguratorResult
 * (including approvedOps, blockedOps, etc.). Called by the assistant HTTP route
 * so it can execute approvedOps as DRAFT via the same DB paths the constructor uses.
 *
 * The grant ceiling check is included here (mirrors handleConfigurator).
 * When the user lacks authoring_draft, returns a result with empty approvedOps/blockedOps
 * and a single grant-ceiling message in text.
 *
 * Security: all approvedOps have tier='draft'; destructive ops land in blockedOps.
 * Pure core — no DB, no process.env. DB execution is the HTTP layer's responsibility.
 *
 * T-0383: accepts optional per-tenant system prompt override (null → default).
 */
export async function runConfigurator(
  userText: string,
  ctx: HandlerContext,
  systemPromptOverride: string | null = null,
  /** T-0463: existing registry_defs for relation-cascade dedup (PD-5). */
  existingRegistryDefs: readonly RegistryDefCandidate[] = [],
  /** T-0724: this tenant's real registries for the list_registries tool. */
  registryListCandidates: readonly RegistryListCandidate[] = [],
): Promise<ConfiguratorResult> {
  const hasGrant = await hasAuthoringDraftGrant(ctx);
  if (!hasGrant) {
    // T-0466 [D8-G5]: human refusal + capture-as-request.
    //  - text is the warm "ask an admin" message (NOT a raw 503).
    //  - when the message describes something configurable, captureRequest is set
    //    so the HTTP layer files it as a config-request notification to admins.
    //
    // We do NOT bake the "передал администратору" confirmation into the text here:
    // whether the request was actually routed depends on a DB side-effect the
    // pure core cannot perform. The HTTP layer appends AUTHORING_CAPTURE_CONFIRMATION
    // ONLY after a successful capture (and an honest note if nobody could receive
    // it). This keeps the message truthful — no claim of delivery the core can't make.
    const worthy = isCaptureWorthy(userText);
    return {
      text: AUTHORING_ACCESS_DENIED_MESSAGE,
      approvedOps: [],
      blockedOps: [],
      pendingPromotes: [],
      planProposals: [],
      grantCeilingViolations: ["authoring_draft grant absent for intersection subject"],
      captureRequest: worthy ? { description: userText.trim() } : undefined,
    };
  }
  return runConfiguratorLoop(
    userText,
    ctx,
    systemPromptOverride,
    existingRegistryDefs,
    registryListCandidates,
  );
}
