/**
 * src/core/agent-task-external-mapper.ts — T-0460 [D8-R5]: authored agentTask → live agent-step job.
 *
 * Spec: docs/specs/process-element-runtime.spec.md §3.6 (R5);
 *       realises docs/specs/process-execution-model.spec.md §6 (D4) for a *real authored* agentTask.
 * ADR:  docs/design/T-0460-agenttask-runtime.adr.md.
 *
 *   «agentTask живой — диспетчер грузит гранты+LLM+мотор, порог автономии решает
 *    самозакрытие vs эскалация (defer→человек с предзаполненной формой). Весь D4
 *    диспетчер УЖЕ построен и завайрен; не хватало ОДНОГО провода — авторский
 *    agentTask никогда не становился внешней задачей на топике agent-step.»
 *
 * WHAT THIS MODULE DOES (the ONE missing wire — ADR §0 / §decision)
 *   Pure XML→XML transform applied at save/publish time, in the SAME publish pipeline
 *   as mapLanesToCandidateGroups (T-0457) and mapTimerEscalation (T-0458). For every
 *   `<serviceTask>` the author marked as an agent step (`choros:executorType="agent"`),
 *   it materialises the Flowable EXTERNAL-TASK shape the runtime keys off:
 *
 *     1. EXTERNAL-TASK TOPIC. Add `flowable:type="external"` + `flowable:topic="agent-step"`
 *        (AGENT_STEP_TOPIC) to the serviceTask open tag — mirrors the seeded triage task
 *        in config/flowable/processes/tel-linear.bpmn20.xml. Without this attribute pair
 *        Flowable never surfaces the task as an external task on the agent-step topic, so
 *        the bridge never fetchAndLocks it and the (already-wired) dispatcher never fires.
 *        This is the gap T-0460 closes.
 *
 *     2. THREAD THE DISPATCHER VARIABLES. Inject an `<extensionElements>` block of
 *        `<flowable:field>` entries that stamp the EXACT keys readJobVars /
 *        assembleAgentStepContext consume (agent-step-context.ts):
 *           agentEmployeeId  ← choros:agentRef          (the agent the step runs as)
 *           roleId           ← choros:assignedRoleId    (the agent's role for gate B)
 *           stepName         ← serviceTask/@name        (objective-compiler step label)
 *           agentReadsFields ← choros:agentReadsFields  (declared read field set)
 *           agentWritesFields← choros:agentWritesFields (declared write field set)
 *        The bridge enqueues a job carrying these (externalTaskBridge.ts: jobStore.enqueue
 *        (topic, task.variables, …)); the dispatcher reads them to load the agent's grants
 *        + LLM + objective. The `fields` record snapshot + instanceId/procKey are threaded
 *        by the engine at fetchAndLock from the live process variables (the form data), so
 *        they are NOT static-stamped here — only the AUTHORED, per-step config is.
 *
 * agentRef → agentEmployeeId RESOLUTION (ADR §3 contracts / object_model)
 *   `choros:agentRef` IS the addressing id of the agent registry entry (AgentPublic.id,
 *   GET /api/agents — agents-list.ts::serializeAgent). For an org-attached (workforce)
 *   agent — the only kind an agentTask can run as — that id IS the `employee_id`
 *   (serializeAgent: `id: hasOrgPlace ? row.employee_id! : row.agent_card_id`). So the
 *   mapping agentRef → agentEmployeeId is the IDENTITY: the published external task
 *   carries the agentRef value verbatim under the `agentEmployeeId` key the dispatcher
 *   reads — NO new lookup table, NO DB read in this pure transform (D-061 no-new-table).
 *   (An org-less/system agent has no employee row and cannot hold a process role, so it
 *   is not a valid agentTask executor; the linter coherence guard rejects an absent ref.)
 *
 * WHY A STRING MAPPER (not a moddle write) — mirrors lane / timer mappers exactly
 *   The BPMN round-trips through the modeler as raw XML; the publish path is a pure
 *   XML→XML pipeline (mapLanes → mapTimers → mapAgentTask → lint → deploy). Keeping this
 *   a string transform keeps it zero-dep, browser-free testable, and composable.
 *
 * DESIGN DISCIPLINE
 *   - Pure: no IO, no DB, no network, no process.env (no-env-in-core.sh / FF-R5-1).
 *   - Idempotent: a serviceTask already carrying flowable:type="external" is left
 *     untouched (explicit author/prior-run wins); re-running is a no-op (f(f(x))==f(x)).
 *   - Additive: a non-agent serviceTask is untouched; a diagram with no agent tasks is
 *     returned byte-identical.
 *   - Reads structure via the shared tokenizer (bpmn-xml-parser) so parsing is robust to
 *     attribute order / self-closing / whitespace; degrades to a no-op on malformed XML
 *     (lintBpmn is the authoritative fail-closed gate for malformed documents).
 *
 * T-0635 [P0-4 / LIVE_PROOF T-0586] AttributePrefixUnbound fix
 *   The modeler's choros-moddle-extension.js registers ONLY the `choros` namespace
 *   (associations: [] — it does not import/associate `flowable`), so saveXML() NEVER
 *   emits `xmlns:flowable` on `<definitions>`. Before this fix, this transform stamped
 *   `flowable:type` / `flowable:topic` / `<flowable:field>` onto the document WITHOUT
 *   ensuring that namespace was declared — an authored agent step therefore produced
 *   XML with an unbound `flowable` prefix, which real XML parsers (and Flowable's own
 *   deployment SAX parser) reject with "AttributePrefixUnbound". ensureFlowableNamespace
 *   below injects `xmlns:flowable="http://flowable.org/bpmn"` (the exact URI the
 *   hand-authored seed processes under config/flowable/processes/ already use, e.g.
 *   choros-smoke.bpmn20.xml) onto the `<definitions>` root, but ONLY when this
 *   transform is about to emit `flowable:*` content and the declaration is not
 *   already present — idempotent and additive, same discipline as the rest of the file.
 */

import { tokenize, type Attr } from "./bpmn-xml-parser.js";

// ---------------------------------------------------------------------------
// AGENT_STEP_TOPIC — the single source of truth for the dispatcher topic.
//
// MUST equal DEFAULT_AGENT_TOPIC (src/server/agent-dispatch-loop.ts) and be the
// topic the lifecycle bridge polls (FLOWABLE_TOPICS) — FF-R5-6 topic agreement.
// The dispatcher intentionally keys off this JOB TOPIC, not a BPMN attribute, so it
// never collides with the tel-intake DMN-triage seam (agent-dispatch-loop.ts §Topic).
// ---------------------------------------------------------------------------

/** The dedicated agent-step external-task topic the D4 dispatcher fires on. */
export const AGENT_STEP_TOPIC = "agent-step";

/** The choros executorType value that marks a serviceTask as an agent step. */
export const AGENT_EXECUTOR_TYPE = "agent";

// ---------------------------------------------------------------------------
// Authored agentTask config — read off the serviceTask open tag (choros:* attrs).
// ---------------------------------------------------------------------------

/**
 * One resolved authored agent serviceTask: its element id + the typed config the
 * publish transform threads into the external-task variables. Collected purely from
 * the tokenizer (no mutation).
 */
export interface AgentTaskConfig {
  /** serviceTask/@id ("" when absent — such a task cannot be wired/addressed). */
  readonly id: string;
  /** serviceTask/@name (the human step label → objective-compiler stepName). */
  readonly name: string;
  /** choros:agentRef — AgentPublic.id == agentEmployeeId (identity, see header). */
  readonly agentRef: string;
  /** choros:assignedRoleId — the role the agent holds for this step (gate B). */
  readonly roleId: string;
  /** choros:agentReadsFields — CSV of record field keys the agent reads ("" when absent). */
  readonly readsFields: string;
  /** choros:agentWritesFields — CSV of record field keys the agent writes ("" when absent). */
  readonly writesFields: string;
  /** Whether the serviceTask ALREADY carries flowable:type="external" (skip — author/prior wins). */
  readonly alreadyExternal: boolean;
  /** Whether the serviceTask ALREADY declares flowable:topic (preserve it). */
  readonly hasTopic: boolean;
}

/**
 * Extract the authored agent serviceTask configs from a BPMN document.
 *
 * Walks every `<serviceTask>` and keeps the ones carrying
 * `choros:executorType="agent"`. Pure — tokenizer-driven, no mutation. Degrades to
 * whatever was collected on a parse error (lintBpmn is the fail-closed gate).
 */
export function extractAgentTaskConfigs(bpmnXml: string): AgentTaskConfig[] {
  const configs: AgentTaskConfig[] = [];

  for (const token of tokenize(bpmnXml)) {
    if (token.kind === "parse-error") break;
    if (token.kind !== "open-tag" && token.kind !== "self-close-tag") continue;
    if (token.localName !== "serviceTask") continue;

    const { attrs } = token;
    // choros:executorType — the tokenizer strips the namespace prefix, so the local
    // attribute name is "executorType" (same convention the linter/lane mapper rely on).
    const executorType = attrFor(attrs, "executorType");
    if (executorType !== AGENT_EXECUTOR_TYPE) continue;

    const flowableType = attrFor(attrs, "type");
    configs.push({
      id: attrFor(attrs, "id"),
      name: attrFor(attrs, "name"),
      agentRef: attrFor(attrs, "agentRef"),
      roleId: attrFor(attrs, "assignedRoleId"),
      readsFields: attrFor(attrs, "agentReadsFields"),
      writesFields: attrFor(attrs, "agentWritesFields"),
      alreadyExternal: flowableType === "external",
      hasTopic: attrs.some((a) => a.name === "topic"),
    });
  }

  return configs;
}

/** Read an attribute's value by local name, or "" when absent. */
function attrFor(attrs: Attr[], name: string): string {
  return attrs.find((a) => a.name === name)?.value ?? "";
}

// ---------------------------------------------------------------------------
// Main transform.
// ---------------------------------------------------------------------------

/**
 * Convert every authored agentTask serviceTask into a live agent-step external task.
 *
 *   1. Stamp `flowable:type="external"` + `flowable:topic="agent-step"` onto the
 *      serviceTask open tag (unless it is already external — author/prior-run wins).
 *   2. Inject an `<extensionElements>` block of `<flowable:field>` entries carrying the
 *      authored dispatcher variables (agentEmployeeId/roleId/stepName/read/write fields)
 *      — the exact keys assembleAgentStepContext consumes.
 *
 * Pure — string in / string out. Idempotent and additive: a serviceTask already
 * external is untouched; non-agent serviceTasks are untouched; a diagram with no agent
 * tasks is returned byte-identical. The `agentRef → agentEmployeeId` mapping is the
 * identity (see module header) — no DB read.
 *
 * @param bpmnXml  the BPMN 2.0 XML (after the lane + timer mappers in the chain).
 * @returns        the transformed XML, or the input unchanged when no authored agent
 *                 serviceTask needs wiring.
 */
export function mapAgentTaskToExternal(bpmnXml: string): string {
  const configs = extractAgentTaskConfigs(bpmnXml);
  if (configs.length === 0) return bpmnXml;

  let result = bpmnXml;
  let wired = false;
  for (const cfg of configs) {
    if (!cfg.id) continue; // an id-less agent task cannot be addressed; linter flags it
    if (cfg.alreadyExternal) continue; // explicit external (author / prior run) wins
    result = wireAgentServiceTask(result, cfg);
    wired = true;
  }
  // T-0635: only inject the namespace declaration when we actually emitted new
  // flowable:* content in THIS call — a diagram whose agent tasks were all
  // already-external / id-less is returned untouched (additive, matches the
  // no-agent-tasks early return above).
  if (wired) {
    result = ensureFlowableNamespace(result);
  }
  return result;
}

// ---------------------------------------------------------------------------
// T-0635 [P0-4]: xmlns:flowable root-declaration guard.
// ---------------------------------------------------------------------------

/** The Flowable BPMN extension namespace URI (matches the seeded hand-authored
 *  processes under config/flowable/processes/, e.g. choros-smoke.bpmn20.xml —
 *  and Flowable 7.1's own bundled `flowable` moddle extension). */
export const FLOWABLE_NAMESPACE_URI = "http://flowable.org/bpmn";

/**
 * Ensure the `<definitions>` root declares `xmlns:flowable="http://flowable.org/bpmn"`.
 *
 * The bpmn-js modeler's choros-moddle-extension.js registers ONLY the `choros`
 * namespace (no `associations` importing `flowable`), so a modeler-authored diagram's
 * `<definitions>` root NEVER carries `xmlns:flowable` — even though the properties
 * panel lets an author mark a serviceTask as an agent step. Once this transform
 * stamps `flowable:type` / `flowable:topic` / `<flowable:field>` onto that document,
 * the `flowable` prefix would be UNBOUND unless this root declaration exists —
 * exactly the "AttributePrefixUnbound" failure a real XML parser (and Flowable's own
 * deployment SAX parser) raises.
 *
 * Idempotent: a document that already declares `xmlns:flowable` (any URI — an
 * explicit author/prior-run declaration wins, mirroring the attribute-level
 * precedence rules elsewhere in this module) is returned untouched. Pure string
 * injection on the FIRST `<definitions>` (or namespaced `<bpmn:definitions>`/
 * `<xxx:definitions>`) open tag; degrades to a no-op when no such tag is found
 * (malformed input — lintBpmn is the authoritative fail-closed gate).
 */
export function ensureFlowableNamespace(bpmnXml: string): string {
  // Already declared (any prefix binding target) — explicit wins, no-op.
  if (/\bxmlns:flowable\s*=/.test(bpmnXml)) return bpmnXml;

  // Match the opening `<definitions …>` tag (optionally namespace-prefixed, e.g.
  // `<bpmn:definitions>`), same convention as bpmn-deploy-normalizer's process-tag
  // matcher. `[^>]*?` keeps the match inside a single tag (no '>' inside).
  const definitionsRe = /(<(?:\w+:)?definitions\b)([^>]*?)(\s*>)/;
  if (!definitionsRe.test(bpmnXml)) return bpmnXml; // no <definitions> — no-op

  return bpmnXml.replace(definitionsRe, (_full, openName: string, attrs: string, close: string) => {
    return `${openName} xmlns:flowable="${FLOWABLE_NAMESPACE_URI}"${attrs}${close}`;
  });
}

/**
 * Rewrite ONE agent serviceTask: add the external-task attributes to its open tag and
 * inject the extensionElements field block as the first child of its body. Operates on
 * the raw string so the rest of the document (DI, namespaces, formatting) is preserved.
 *
 * Handles both a self-closing `<serviceTask .../>` (rewritten to a paired element with a
 * body) and a paired `<serviceTask ...> … </serviceTask>` (fields prepended to the body).
 * Pure string transform; idempotent (a tag already external is skipped by the caller, and
 * we never double-inject the attributes within a single tag).
 */
function wireAgentServiceTask(xml: string, cfg: AgentTaskConfig): string {
  const escId = escapeRegex(cfg.id);
  const fieldBlock = buildExtensionFieldBlock(cfg);

  // Case 1: self-closing <serviceTask ... id="X" ... /> → expand into a paired element
  // carrying the external attributes + the extensionElements body.
  const selfCloseRe = new RegExp(
    `(<serviceTask\\b[^>]*\\bid=["']${escId}["'][^>]*?)(\\s*)/>`,
  );
  if (selfCloseRe.test(xml)) {
    return xml.replace(selfCloseRe, (_full, body: string) => {
      const withAttrs = addExternalAttrs(body, cfg);
      return `${withAttrs}>${fieldBlock}</serviceTask>`;
    });
  }

  // Case 2: paired <serviceTask ... id="X" ...> … </serviceTask>. Add the external
  // attributes to the open tag, then prepend the extensionElements block to the body.
  const openTagRe = new RegExp(
    `(<serviceTask\\b[^>]*\\bid=["']${escId}["'][^>]*?)(\\s*)>`,
  );
  return xml.replace(openTagRe, (_full, body: string) => {
    const withAttrs = addExternalAttrs(body, cfg);
    return `${withAttrs}>${fieldBlock}`;
  });
}

/**
 * Add `flowable:type="external"` + `flowable:topic="agent-step"` to a serviceTask open-tag
 * body (the text between `<serviceTask` and the closing delimiter). Defensive: never
 * double-adds an attribute already present in this tag body (idempotent within a tag).
 */
function addExternalAttrs(tagBody: string, cfg: AgentTaskConfig): string {
  let out = tagBody;
  if (!/\btype=/.test(out)) {
    out = `${out} flowable:type="external"`;
  }
  // Preserve an existing topic if the author set one; otherwise stamp the agent-step topic.
  if (!cfg.hasTopic && !/\btopic=/.test(out)) {
    out = `${out} flowable:topic="${AGENT_STEP_TOPIC}"`;
  }
  return out;
}

/**
 * Build the `<extensionElements>` block of `<flowable:field>` entries that thread the
 * authored dispatcher variables. Only NON-EMPTY values are emitted (an absent read/write
 * field set produces no entry — the dispatcher defaults it). agentEmployeeId and roleId
 * are the load-bearing identity keys assembleAgentStepContext reads to resolve the agent.
 *
 * Field values are XML-escaped. The block is emitted compactly (single line) so the
 * targeted string injection stays simple and the document formatting is otherwise intact.
 */
function buildExtensionFieldBlock(cfg: AgentTaskConfig): string {
  const fields: Array<{ name: string; value: string }> = [];
  // agentEmployeeId ← agentRef (identity mapping, see header). The dispatcher reads
  // agentEmployeeId; we ALSO carry agentRef verbatim for traceability/debugging.
  if (cfg.agentRef) {
    fields.push({ name: "agentEmployeeId", value: cfg.agentRef });
    fields.push({ name: "agentRef", value: cfg.agentRef });
  }
  if (cfg.roleId) fields.push({ name: "roleId", value: cfg.roleId });
  if (cfg.name) fields.push({ name: "stepName", value: cfg.name });
  if (cfg.readsFields) fields.push({ name: "agentReadsFields", value: cfg.readsFields });
  if (cfg.writesFields) fields.push({ name: "agentWritesFields", value: cfg.writesFields });

  if (fields.length === 0) return "";

  const fieldXml = fields
    .map(
      (f) =>
        `<flowable:field name="${escapeXml(f.name)}"><flowable:string>${escapeXml(f.value)}</flowable:string></flowable:field>`,
    )
    .join("");
  return `<extensionElements>${fieldXml}</extensionElements>`;
}

/**
 * Minimal XML-text/attr escaper for injected values.
 * Exported (T-0642) so other publish-transform mappers that inject
 * attribute/text values into raw BPMN XML (user-task-role-mapper.ts)
 * reuse this single escaper rather than duplicating it.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
