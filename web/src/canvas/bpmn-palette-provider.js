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
   ============================================================================ */

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

  /* Helper: create a palette drag/click action for a BPMN shape with attrs */
  function createAction(type, group, cssClass, title, attrs) {
    function createListener(event) {
      const shape = elementFactory.createShape(
        Object.assign({ type }, attrs || {})
      );
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
      // Pre-stamp the choros:executorType attribute.
      // bpmn-js stores this in businessObject.$attrs at creation time.
      { 'choros:executorType': 'agent' }
    ),

    'create.choros-service-task': createAction(
      'bpmn:ServiceTask',
      'choros-tasks',
      'bpmn-icon-service-task chs-palette-service',
      'External Task — сервис',
      { 'choros:executorType': 'service' }
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
