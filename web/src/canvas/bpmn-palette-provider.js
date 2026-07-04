/* ============================================================================
   CHOROS — bpmn-palette-provider.js
   T-0098: Custom Palette provider that replaces the generic bpmn:Task entry
   with three Choros-typed task entries (human / agent / service).

   Registration:
     Pass this module via `additionalModules` in BpmnModeler constructor.
     The module overrides the built-in 'create.task' entry key and adds
     'create.choros-user-task', 'create.choros-agent-task', and
     'create.choros-service-task'.

   Step-type mapping (T-0098 spec):
     userTask             → chs-exec-human    (bpmn:UserTask)
     serviceTask + agent  → chs-exec-agent    (bpmn:ServiceTask, choros:executorType="agent")
     serviceTask/external → chs-exec-service  (bpmn:ServiceTask, choros:executorType="service")

   The provider injects into bpmn-js' DI container via $inject. bpmn-js v17
   supports multiple palette providers (highest priority wins for duplicate keys).

   T-0634 [W3/P0-2] fix note:
     elementFactory.createShape(attrs) does NOT copy arbitrary keys onto the
     created element's businessObject — bpmn-js's ElementFactory.createElement
     (node_modules/bpmn-js/lib/features/modeling/ElementFactory.js) only lifts a
     small allow-list of attrs (processRef / isInterrupting / eventDefinitionType /
     isExpanded / …) onto the businessObject; everything else (including a raw
     'choros:executorType' key) is assigned onto the returned SHAPE object itself
     via the final `assign({id...}, size, attrs, {businessObject, di})` in
     diagram-js — never onto businessObject.$attrs. So the previous
     `{ 'choros:executorType': 'agent' }` passed straight into createShape() was
     silently inert: the exported XML was an untyped serviceTask.
     Fix: create the shape first, then write the executorType onto
     shape.businessObject using the SAME dual-write pattern as every other
     choros:* attribute in this codebase (writeConfigAttr in
     element-config-contract.js — registered moddle property + $attrs fallback),
     so saveXML() actually serialises choros:executorType="agent"/"service".
   ============================================================================ */

import { writeConfigAttr } from './element-config-contract.js';

/* --------------------------------------------------------------------------
   ChorosPaletteProvider — the custom module class
   -------------------------------------------------------------------------- */
export function ChorosPaletteProvider(palette, create, elementFactory, translate) {
  this._create = create;
  this._elementFactory = elementFactory;
  this._translate = translate;

  // Register with priority 1500 so our entries take precedence over the
  // default bpmn-js PaletteProvider (registered at 1000).
  palette.registerProvider(1500, this);
}

ChorosPaletteProvider.$inject = [
  'palette',
  'create',
  'elementFactory',
  'translate',
];

ChorosPaletteProvider.prototype.getPaletteEntries = function () {
  const create = this._create;
  const elementFactory = this._elementFactory;
  const translate = this._translate;

  /* Helper: create a palette drag/click action for a BPMN shape.

     `shapeAttrs` — extra options forwarded verbatim into
       elementFactory.createShape({ type, ...shapeAttrs }). ONLY use this for
       keys bpmn-js' ElementFactory actually understands (e.g.
       eventDefinitionType, isExpanded, processRef — see the allow-list in
       node_modules/bpmn-js/lib/features/modeling/ElementFactory.js). Anything
       NOT on that allow-list is silently dropped onto the shape instead of the
       businessObject — that was exactly the T-0634 [P0-2] bug for
       'choros:executorType'.

     `executorType` — when given ("agent" | "service"), the choros:executorType
       value to stamp onto the CREATED shape's businessObject *after* creation,
       via the same dual-write helper every other choros:* property uses
       (writeConfigAttr — registered moddle property + $attrs fallback), so
       saveXML() actually emits choros:executorType="…" in the XML. */
  function createAction(type, group, cssClass, title, shapeAttrs, executorType) {
    function createListener(event) {
      const shape = elementFactory.createShape(
        Object.assign({ type }, shapeAttrs || {}),
      );
      if (executorType && shape.businessObject) {
        writeConfigAttr(
          shape.businessObject,
          'executorType',
          'choros:executorType',
          executorType,
        );
      }
      create.start(event, shape);
    }

    return {
      group,
      className: cssClass,
      title: translate(title),
      action: {
        dragstart: createListener,
        click: createListener,
      },
    };
  }

  /* T-0457 [D8-R2]: lane → role swimlane action.
     A BPMN lane cannot live on the canvas on its own — it must sit inside a
     swimlane container (an expanded Participant). bpmn-js' ElementFactory exposes
     createParticipantShape() which builds that container WITH a default
     bpmn:Lane already inside it. The user renames that lane to a ROLE (e.g.
     «Бухгалтер») and drops userTasks into it; on save the lane→candidateGroups
     mapper (src/core/lane-role-mapper.ts) wires each contained userTask to
     flowable:candidateGroups="<role-slug>", which executor-resolver.ts consumes.

     We expose ONLY this single-container lane affordance. The generic multi-pool
     entry (create.participant-expanded) stays removed below — v1 has no
     cross-pool semantics (one process = one swimlane container). */
  function createLaneAction(group, cssClass, title) {
    function createListener(event) {
      // createParticipantShape() returns an expanded pool seeded with one lane.
      // Guard for older/newer factory shapes: fall back to a plain Participant.
      const shape =
        typeof elementFactory.createParticipantShape === 'function'
          ? elementFactory.createParticipantShape({ type: 'bpmn:Participant' })
          : elementFactory.createShape({ type: 'bpmn:Participant', isExpanded: true });
      create.start(event, shape);
    }

    return {
      group,
      className: cssClass,
      title: translate(title),
      action: {
        dragstart: createListener,
        click: createListener,
      },
    };
  }

  return {
    // ---- Override the generic "Create task" entry with our typed entries ----
    // Return null/undefined to REMOVE the original generic task entry.
    // bpmn-js merges providers: entries from higher-priority providers
    // override same-key entries from lower ones.
    'create.task': null, // removes generic untyped task from default provider

    // ---- Choros executor-typed task entries ---------------------------------
    'create.choros-user-task': createAction(
      'bpmn:UserTask',
      'choros-tasks',
      'bpmn-icon-user-task chs-palette-human',
      'User Task — человек',
    ),

    'create.choros-agent-task': createAction(
      'bpmn:ServiceTask',
      'choros-tasks',
      'bpmn-icon-service-task chs-palette-agent',
      'Agent Task — ИИ-агент',
      /* shapeAttrs */ undefined,
      // Stamps choros:executorType="agent" onto the created shape's
      // businessObject (see createAction / writeConfigAttr above) — the
      // attribute publish-transform (agent-task-external-mapper) and
      // agent-dispatch read to route this step to the agent runtime.
      /* executorType */ 'agent',
    ),

    'create.choros-service-task': createAction(
      'bpmn:ServiceTask',
      'choros-tasks',
      'bpmn-icon-service-task chs-palette-service',
      'External Task — сервис',
      /* shapeAttrs */ undefined,
      /* executorType */ 'service',
    ),

    // Keep a separator between Choros tasks and the rest
    'choros-task-separator': {
      group: 'choros-tasks',
      separator: true,
    },

    // ---- T-0457 [D8-R2]: lane → role swimlane (WORKING element) ------------
    // Drops an expanded swimlane container (Participant) seeded with one lane.
    // Rename the lane to a ROLE; userTasks placed in it are wired to that role's
    // candidateGroups on save (src/core/lane-role-mapper.ts → executor-resolver).
    'create.choros-lane': createLaneAction(
      'choros-tasks',
      'bpmn-icon-lane chs-palette-lane',
      'Дорожка — роль',
    ),

    // ---- T-0458 [D8-R3]: timer / deadline (WORKING element) ----------------
    // Drops an intermediate timer catch event. Flowable schedules the timer
    // natively from the <timerEventDefinition> body. To make it a boundary
    // DEADLINE on a task, drop it onto the task border (bpmn-js auto-converts an
    // IntermediateCatchEvent attached to an activity into a BoundaryEvent). The
    // timer properties panel (bpmn-properties-panel.jsx → TimerDeadlinePanel) then
    // configures the deadline (duration / fixed date / record-field date) and the
    // escalation target. On save the publish mapper (src/core/timer-escalation-mapper.ts)
    // materialises the native <timeDuration>/<timeDate>/<timeCycle> body so the
    // engine schedules it; when it fires Flowable routes the token to the escalation
    // user-task, which the inbox projection surfaces (T-0443/T-0456 engine-drive).
    'create.choros-timer': createAction(
      'bpmn:IntermediateCatchEvent',
      'choros-events',
      'bpmn-icon-intermediate-event-catch-timer chs-palette-timer',
      'Таймер — дедлайн / эскалация',
      // Pre-stamp the timer event definition so the created event is a timer
      // (bpmn-js ElementFactory reads eventDefinitionType to seed the definition).
      { eventDefinitionType: 'bpmn:TimerEventDefinition' },
    ),

    // ---- T-0459 [D8-R4]: message catch event (WORKING element) ------------
    // Drops an intermediate message catch event. The instance PARKS here waiting
    // for a correlated message (envelope { tenant, messageName, correlationKey,
    // payload, source }); correlation is by a business key taken from a record field
    // (configured in bpmn-properties-panel.jsx → MessageCorrelationPanel). v1 sources:
    // external human (T-0122 token surface) + internal signal (broadcast within
    // tenant). The waiting instance shows «Ожидает сообщения» in the inbox
    // (process-projection.ts surfaceMessageCatchWaits); when a correlated message
    // arrives the catch fires (deliverMessageEnvelope, tenant-fail-closed). A
    // message-catch MUST have a guarding timeout (publish linter
    // checkMessageEventCoherence) — drop a timer boundary on it to avoid an infinite
    // wait.
    'create.choros-message-catch': createAction(
      'bpmn:IntermediateCatchEvent',
      'choros-events',
      'bpmn-icon-intermediate-event-catch-message chs-palette-message',
      'Сообщение — ожидание (корреляция по полю)',
      // Pre-stamp the message event definition so the created event is a message catch.
      { eventDefinitionType: 'bpmn:MessageEventDefinition' },
    ),

    // Separator between the events and the rest of the palette.
    'choros-event-separator': {
      group: 'choros-events',
      separator: true,
    },

    // ---- Remove default bpmn-js no-op elements (B13 / T-0375) -------------
    // These elements are decorative no-ops in this product: they can be placed
    // on the canvas but the engine does not process them at runtime.  Returning
    // null removes them from the merged palette so users are only offered
    // elements that actually execute.
    'create.data-object':          null, // DataObjectReference  — no engine binding
    'create.data-store':           null, // DataStoreReference   — no engine binding
    'create.subprocess-expanded':  null, // SubProcess           — not supported by runtime
    // T-0457: the GENERIC multi-pool entry stays removed — there is no cross-pool
    // semantics in v1. The single role-lane swimlane is offered via
    // 'create.choros-lane' above (one process = one swimlane container).
    'create.participant-expanded': null, // generic Pool/Participant — use create.choros-lane
    'create.group':                null, // Group (artifact)     — no engine binding
    'create.intermediate-event':   null, // IntermediateThrowEvent — not wired
  };
};

/* --------------------------------------------------------------------------
   Module descriptor for bpmn-js additionalModules injection.
   -------------------------------------------------------------------------- */
export const ChorosPaletteModule = {
  __init__: ['chorosPaletteProvider'],
  chorosPaletteProvider: ['type', ChorosPaletteProvider],
};

export default ChorosPaletteModule;
