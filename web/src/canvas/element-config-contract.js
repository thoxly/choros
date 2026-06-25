/* ============================================================================
   CHOROS — element-config-contract.js
   T-0461 [D8-R6]: ONE typed per-element config contract — TWO drivers.

   This is the KEYSTONE for «настройка каждого элемента = бесшовность» (spec
   §3.7). The per-element configuration is a clean, driver-agnostic DATA
   structure persisted on the element businessObject (round-trips through
   saveXML/importXML via the choros moddle extension). BOTH drivers write the
   SAME structure:
     • the human properties panel (bpmn-properties-panel.jsx + sub-panels), and
     • the D8 text-first bot (a LATER task — text-first-solution-builder.spec.md).

   Because the contract is pure data + pure helpers (no React, no bpmn-js, no
   panel assumptions), the bot can construct the identical config the panel
   would have produced. Nothing here is panel-only.

   ----------------------------------------------------------------------------
   CONFIG KINDS (dispatch by BPMN element type → the typed config it carries)
   ----------------------------------------------------------------------------
   Mirrors the spec §3.7 table. Each kind names the typed config block an element
   of that kind owns. The panel mounts the matching sub-panel; the bot writes the
   matching fields.

     start      → trigger          (on_create / launcher / manual)        [seam]
     userTask   → role + form      (candidateGroups + form/field binding)
     agentTask  → agent + autonomy (agent ref, autonomy level, r/w fields)
     gateway    → condition        (routing var + per-flow branch value)
     parallel   → (none)           (split/join — no parameters)
     timer      → deadline         (deadline + escalation target)
     message    → correlation      (message name + correlation field)     [seam — T-0459]
     end        → finalize         (what is recorded)                     [seam]

   This module owns ONLY the dispatch + the agent/userTask-form binding contract
   that this task introduces. Gateway/timer config already live in their own
   modules (gateway-condition-panel.jsx, timer-deadline-panel.jsx) and are
   referenced here purely so the dispatch is total.
   ============================================================================ */

/* --------------------------------------------------------------------------
   Element-config kinds — the CLOSED dispatch set (spec §3.7).
   -------------------------------------------------------------------------- */
export const ELEMENT_CONFIG_KINDS = Object.freeze([
  'start',
  'userTask',
  'agentTask',
  'gateway',
  'parallel',
  'timer',
  'message',
  'end',
  // 'none' — selectable element with no typed config (e.g. a bare sequenceFlow
  // structural selection, a plain Task before an executor type is chosen).
  'none',
]);

/**
 * Detect whether a businessObject is a timer-bearing event (boundary /
 * intermediate-catch carrying a TimerEventDefinition). Kept here (not just in the
 * panel) so the dispatch is pure + bot-reachable.
 * @param {object} bo
 * @returns {boolean}
 */
export function isTimerEventBo(bo) {
  if (!bo) return false;
  if (bo.$type !== 'bpmn:BoundaryEvent' && bo.$type !== 'bpmn:IntermediateCatchEvent') {
    return false;
  }
  const defs = bo.eventDefinitions || [];
  return defs.some((d) => d && d.$type === 'bpmn:TimerEventDefinition');
}

/**
 * Detect a message/signal catch element. The message ELEMENT itself (projection,
 * correlation runtime) is T-0459 — NOT built here. We only recognise it so the
 * dispatch reserves the 'message' slot and the seam is clean: when T-0459 adds the
 * MessageCorrelationPanel, it plugs into the SAME dispatch with zero churn.
 * @param {object} bo
 * @returns {boolean}
 */
export function isMessageEventBo(bo) {
  if (!bo) return false;
  // receiveTask + message/signal catch events are the message-family carriers
  // (inflight-migration.ts already knows receiveTask / intermediateCatchEvent).
  if (bo.$type === 'bpmn:ReceiveTask') return true;
  if (bo.$type === 'bpmn:BoundaryEvent' || bo.$type === 'bpmn:IntermediateCatchEvent') {
    const defs = bo.eventDefinitions || [];
    return defs.some(
      (d) => d && (d.$type === 'bpmn:MessageEventDefinition' || d.$type === 'bpmn:SignalEventDefinition'),
    );
  }
  return false;
}

/**
 * Read the effective executor type for a task businessObject. Mirrors the panel's
 * effectiveExecType but lives here so the dispatch is pure. userTask → 'human';
 * an explicit choros:executorType (moddle prop or $attrs) wins; other tasks →
 * 'service'.
 * @param {object} bo
 * @returns {('human'|'agent'|'service'|null)}
 */
export function effectiveExecTypeOf(bo) {
  if (!bo) return null;
  if (bo.executorType) return bo.executorType;
  const explicit = bo.$attrs && bo.$attrs['choros:executorType'];
  if (explicit) return explicit;
  if (bo.$type === 'bpmn:UserTask') return 'human';
  const TASKish = new Set([
    'bpmn:Task', 'bpmn:ServiceTask', 'bpmn:SendTask', 'bpmn:ReceiveTask',
    'bpmn:BusinessRuleTask', 'bpmn:ScriptTask', 'bpmn:ManualTask',
  ]);
  if (TASKish.has(bo.$type)) return 'service';
  return null;
}

/**
 * THE DISPATCH. Map a selected element's businessObject → its element-config kind.
 * This is the single source of truth both drivers consult: the panel to decide
 * which typed sub-panel to mount, the bot to decide which typed fields to write.
 *
 * Order matters: timer/message events are detected before the generic task/event
 * fallbacks. An agentTask is a serviceTask (or task) whose executorType==='agent'.
 *
 * @param {object} bo - the selected element businessObject
 * @returns {string} one of ELEMENT_CONFIG_KINDS
 */
export function elementConfigKind(bo) {
  if (!bo) return 'none';
  const t = bo.$type;

  // Events first (timer/message are carried on boundary/intermediate-catch).
  if (isTimerEventBo(bo)) return 'timer';
  if (isMessageEventBo(bo)) return 'message';

  if (t === 'bpmn:StartEvent') return 'start';
  if (t === 'bpmn:EndEvent') return 'end';

  if (t === 'bpmn:ExclusiveGateway') return 'gateway';
  if (t === 'bpmn:ParallelGateway' || t === 'bpmn:InclusiveGateway') return 'parallel';

  if (t === 'bpmn:UserTask') return 'userTask';

  // agentTask = a service/plain task explicitly typed as an agent executor.
  const TASK_TYPES = new Set([
    'bpmn:Task', 'bpmn:ServiceTask', 'bpmn:SendTask', 'bpmn:ReceiveTask',
    'bpmn:BusinessRuleTask', 'bpmn:ScriptTask', 'bpmn:ManualTask',
  ]);
  if (TASK_TYPES.has(t)) {
    return effectiveExecTypeOf(bo) === 'agent' ? 'agentTask' : 'userTask';
    // Note: non-agent tasks still get the userTask config family (role + form
    // binding) — a human/service task is configured against role + fields the
    // same way. The exec-type selector inside the panel switches agentTask on.
  }

  return 'none';
}

/* --------------------------------------------------------------------------
   Dual-write attribute helpers — the persistence primitive shared by every
   typed config block. Writes BOTH the registered moddle property (round-trips
   via saveXML) and the $attrs fallback (importXML / raw-XML compat). Mirrors
   writeTimerAttr / writeBoAttr already in the codebase, centralised so the bot
   uses the exact same write path.
   -------------------------------------------------------------------------- */

/**
 * Read a choros:* attribute: registered moddle property first, $attrs fallback.
 * @param {object} bo
 * @param {string} propName  registered moddle property name (e.g. 'agentRef')
 * @param {string} attrName  qualified attr name (e.g. 'choros:agentRef')
 * @param {*} [fallback='']
 */
export function readConfigAttr(bo, propName, attrName, fallback = '') {
  if (!bo) return fallback;
  return bo[propName] ?? (bo.$attrs && bo.$attrs[attrName]) ?? fallback;
}

/**
 * Dual-write a choros:* attribute. Empty/falsey value CLEARS both sides so
 * saveXML omits the attribute entirely.
 * @param {object} bo
 * @param {string} propName
 * @param {string} attrName
 * @param {*} value
 */
export function writeConfigAttr(bo, propName, attrName, value) {
  if (!bo) return;
  if (!bo.$attrs) bo.$attrs = {};
  if (value) {
    bo[propName] = value;
    bo.$attrs[attrName] = value;
  } else {
    delete bo[propName];
    delete bo.$attrs[attrName];
  }
}

/* --------------------------------------------------------------------------
   agentTask config contract (NEW — this task)

   The agentTask carries (spec §3.7 row «agentTask»):
     • agentRef       — which agent (AgentPublic.id from GET /api/agents)
     • autonomyLevel  — how autonomous the agent may act on this step
     • readsFields    — which record fields it reads  (CSV of field keys)
     • writesFields   — which record fields it writes  (CSV of field keys)
   These ride as choros:* attributes on the task businessObject. The dispatcher
   (process-execution-model / D4) reads agentRef + autonomyLevel; the field lists
   reuse the D7 contract catalog for presentation.

   The full agent budget/autonomy floor is set on the agent itself in Оргструктуре
   (agent-hire MIN_AUTONOMY_THRESHOLD); autonomyLevel here is the PER-STEP ceiling
   choice, a coarse enum the bot can also set without server round-trips.
   -------------------------------------------------------------------------- */

/** Coarse per-step autonomy levels — both drivers pick from this closed set. */
export const AUTONOMY_LEVELS = Object.freeze([
  { value: 'suggest',  label: 'Только предлагает (всегда к человеку)' },
  { value: 'assisted', label: 'Действует, человек подтверждает' },
  { value: 'auto',     label: 'Действует сам (в пределах грантов)' },
]);

/** True iff value is a known autonomy level. */
export function isAutonomyLevel(value) {
  return typeof value === 'string' && AUTONOMY_LEVELS.some((l) => l.value === value);
}

/**
 * Read the full agentTask config block off a businessObject. Pure — the bot reads
 * the same shape. Field lists are returned as arrays of trimmed field keys.
 * @param {object} bo
 * @returns {{ agentRef: string, autonomyLevel: string, readsFields: string[], writesFields: string[] }}
 */
export function readAgentConfig(bo) {
  const agentRef = readConfigAttr(bo, 'agentRef', 'choros:agentRef', '');
  const rawLevel = readConfigAttr(bo, 'autonomyLevel', 'choros:autonomyLevel', '');
  const autonomyLevel = isAutonomyLevel(rawLevel) ? rawLevel : 'assisted';
  return {
    agentRef,
    autonomyLevel,
    readsFields: splitFieldList(readConfigAttr(bo, 'agentReadsFields', 'choros:agentReadsFields', '')),
    writesFields: splitFieldList(readConfigAttr(bo, 'agentWritesFields', 'choros:agentWritesFields', '')),
  };
}

/**
 * Write a PARTIAL agentTask config patch. Both drivers call this. Undefined keys
 * are left untouched; arrays are joined to the CSV storage form.
 * @param {object} bo
 * @param {{ agentRef?: string, autonomyLevel?: string, readsFields?: string[], writesFields?: string[] }} patch
 */
export function writeAgentConfig(bo, patch) {
  if (!bo || !patch) return;
  if ('agentRef' in patch) {
    writeConfigAttr(bo, 'agentRef', 'choros:agentRef', patch.agentRef || '');
  }
  if ('autonomyLevel' in patch) {
    const lvl = isAutonomyLevel(patch.autonomyLevel) ? patch.autonomyLevel : '';
    writeConfigAttr(bo, 'autonomyLevel', 'choros:autonomyLevel', lvl);
  }
  if ('readsFields' in patch) {
    writeConfigAttr(bo, 'agentReadsFields', 'choros:agentReadsFields', joinFieldList(patch.readsFields));
  }
  if ('writesFields' in patch) {
    writeConfigAttr(bo, 'agentWritesFields', 'choros:agentWritesFields', joinFieldList(patch.writesFields));
  }
}

/* --------------------------------------------------------------------------
   userTask form-binding contract (NEW — this task)

   The userTask carries (spec §3.7 row «userTask», беспрерывность процесс↔приложение):
     • formContractRef — which form / registry_def the step shows (the form key)
     • visibleFields    — which record fields are visible/editable on this step
   Role assignment (candidateGroups) stays where it already is
   (choros:assignedRoleId, reused from T-0325). These three together =
   role + форма + поля from the spec table.

   visibleFields reuse the D7 catalog only for PRESENTATION (resolveFieldContract);
   storage is just the field-key CSV so the bot writes it identically.
   -------------------------------------------------------------------------- */

/**
 * Read the userTask form-binding config block off a businessObject. Role lives in
 * choros:assignedRoleId (existing). Pure.
 * @param {object} bo
 * @returns {{ assignedRoleId: string, formContractRef: string, visibleFields: string[] }}
 */
export function readUserTaskConfig(bo) {
  return {
    assignedRoleId: readConfigAttr(bo, 'assignedRoleId', 'choros:assignedRoleId', ''),
    formContractRef: readConfigAttr(bo, 'formContractRef', 'choros:formContractRef', ''),
    visibleFields: splitFieldList(readConfigAttr(bo, 'visibleFields', 'choros:visibleFields', '')),
  };
}

/**
 * Write a PARTIAL userTask form-binding patch. Both drivers call this.
 * @param {object} bo
 * @param {{ assignedRoleId?: string, formContractRef?: string, visibleFields?: string[] }} patch
 */
export function writeUserTaskConfig(bo, patch) {
  if (!bo || !patch) return;
  if ('assignedRoleId' in patch) {
    writeConfigAttr(bo, 'assignedRoleId', 'choros:assignedRoleId', patch.assignedRoleId || '');
  }
  if ('formContractRef' in patch) {
    writeConfigAttr(bo, 'formContractRef', 'choros:formContractRef', patch.formContractRef || '');
  }
  if ('visibleFields' in patch) {
    writeConfigAttr(bo, 'visibleFields', 'choros:visibleFields', joinFieldList(patch.visibleFields));
  }
}

/* --------------------------------------------------------------------------
   message/signal correlation config contract (NEW — T-0459 [D8-R4])

   A message-catch carries (spec §3.7 row «message/signal»):
     • messageName            — the message/signal name the catch waits for
     • correlationField       — WHICH RECORD FIELD supplies the correlation key
                                (бесшовность: correlation is by a business key from
                                 the record, not an opaque token)
     • broadcast              — true iff a broadcast signal-catch (within tenant)
   The THROW side carries (spec §3.5 part 3 — send via invoke-grant on a channel):
     • throwChannelResourceId — effect_resource id of the messaging_channel/connector
     • throwPayloadFields      — record field keys whose values form the payload
   These ride as choros:* attributes; the runtime (process-projection.ts delivery +
   message-correlation.ts) reads messageName + correlationField; the throw side
   (authorizeThrowMessage → verifyEffectGrants T-0034) reads throwChannelResourceId.

   ONE contract, TWO drivers — the human panel (MessageCorrelationPanel) and the D8
   bot both call these helpers, so they write the identical structure.
   -------------------------------------------------------------------------- */

/**
 * Read the message correlation + throw config block off a businessObject. Pure.
 * @param {object} bo
 * @returns {{ messageName: string, correlationField: string, broadcast: boolean,
 *            throwChannelResourceId: string, throwPayloadFields: string[] }}
 */
export function readMessageConfig(bo) {
  const broadcastRaw = readConfigAttr(bo, 'messageBroadcast', 'choros:messageBroadcast', '');
  return {
    messageName: readConfigAttr(bo, 'messageName', 'choros:messageName', ''),
    correlationField: readConfigAttr(bo, 'correlationField', 'choros:correlationField', ''),
    broadcast: broadcastRaw === 'true' || broadcastRaw === true,
    throwChannelResourceId: readConfigAttr(bo, 'throwChannelResourceId', 'choros:throwChannelResourceId', ''),
    throwPayloadFields: splitFieldList(readConfigAttr(bo, 'throwPayloadFields', 'choros:throwPayloadFields', '')),
  };
}

/**
 * Write a PARTIAL message correlation + throw config patch. Both drivers call this.
 * Undefined keys are left untouched. broadcast is stored as the string "true"/"".
 * @param {object} bo
 * @param {{ messageName?: string, correlationField?: string, broadcast?: boolean,
 *          throwChannelResourceId?: string, throwPayloadFields?: string[] }} patch
 */
export function writeMessageConfig(bo, patch) {
  if (!bo || !patch) return;
  if ('messageName' in patch) {
    writeConfigAttr(bo, 'messageName', 'choros:messageName', patch.messageName || '');
  }
  if ('correlationField' in patch) {
    writeConfigAttr(bo, 'correlationField', 'choros:correlationField', patch.correlationField || '');
  }
  if ('broadcast' in patch) {
    // Only persist the attribute when broadcast is true (omit when false → clean XML).
    writeConfigAttr(bo, 'messageBroadcast', 'choros:messageBroadcast', patch.broadcast ? 'true' : '');
  }
  if ('throwChannelResourceId' in patch) {
    writeConfigAttr(bo, 'throwChannelResourceId', 'choros:throwChannelResourceId', patch.throwChannelResourceId || '');
  }
  if ('throwPayloadFields' in patch) {
    writeConfigAttr(bo, 'throwPayloadFields', 'choros:throwPayloadFields', joinFieldList(patch.throwPayloadFields));
  }
}

/* --------------------------------------------------------------------------
   Field-list serialisation — the storage form for the field bindings.
   CSV of trimmed, de-duplicated, non-empty field keys. Chosen because it is the
   simplest thing both an isAttr moddle attribute and a text-first bot can emit;
   richer per-field config (mode/contract) already lives in form_binding records
   (D7), so we keep the on-element binding to the field-KEY set + the form ref.
   -------------------------------------------------------------------------- */

/** Parse a CSV field-key list into a clean string[]. */
export function splitFieldList(csv) {
  if (Array.isArray(csv)) {
    return dedupe(csv.map((s) => String(s).trim()).filter(Boolean));
  }
  if (typeof csv !== 'string' || csv.trim() === '') return [];
  return dedupe(csv.split(',').map((s) => s.trim()).filter(Boolean));
}

/** Join a field-key list/array into the CSV storage form. */
export function joinFieldList(list) {
  if (!Array.isArray(list)) {
    if (typeof list === 'string') return splitFieldList(list).join(',');
    return '';
  }
  return splitFieldList(list).join(',');
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}
