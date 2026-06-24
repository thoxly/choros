/* ============================================================================
   CHOROS — choros-moddle-extension.js
   T-0099: bpmn-moddle descriptor for the choros namespace.

   Purpose:
     Registers the `choros` namespace (http://choros.io/bpmn) with bpmn-moddle
     so that `choros:executorType` is treated as a FIRST-CLASS serializable
     property rather than a raw unknown-namespace attribute stored in $attrs.

   Registration:
     Pass via `moddleExtensions: { choros: ChorosModdleDescriptor }` to BpmnModeler.

   Round-trip:
     1. Properties panel writes bo.$attrs['choros:executorType'] = 'agent'  (T-0098 legacy path)
        OR directly bo['choros:executorType'] via the registered property.
     2. saveXML({ format: true }) emits <serviceTask ... choros:executorType="agent">
     3. importXML reads the attribute back onto bo; execMarkerFor() reads
        bo.$attrs['choros:executorType'] (bpmn-moddle stores registered namespace
        attrs in $attrs for non-local properties) and colors the element.

   The serialized XML will contain:
     xmlns:choros="http://choros.io/bpmn"
     ...
     <serviceTask ... choros:executorType="agent">

   Descriptor format follows bpmn-moddle's JSON schema convention.
   See bpmn-js/node_modules/bpmn-moddle/resources/bpmn-io/json/bioc.json
   for the canonical pattern using "extends" to add attrs to existing types.
   ============================================================================ */

/**
 * bpmn-moddle JSON descriptor for the choros namespace.
 *
 * Strategy: extend bpmn:Activity (the superclass of all Task types and
 * SubProcess) with an `executorType` attribute in the choros namespace.
 * bpmn-moddle serialises it as `choros:executorType="..."` on the XML element.
 *
 * The `isAttr: true` flag tells moddle to treat it as an XML attribute
 * (not a child element), so the round-trip is a simple attribute read/write.
 *
 * T-0353 [E16] additions:
 *
 *   choros:outcomeName (on bpmn:SequenceFlow)
 *     The SEMANTIC outcome name that a human chose to route along this flow
 *     (e.g. "Согласовать", "На доработку"). Written by the properties panel
 *     on the selected SequenceFlow after the UserTask. Serialised as:
 *       <sequenceFlow ... choros:outcomeName="Согласовать"/>
 *     This is the NAMED BRANCH — NOT a DMN condition. DMN-gateway remains
 *     separate: outcome = human chooses; DMN = data chooses.
 *
 *   choros:outcomePreset (on bpmn:UserTask)
 *     The id of the active preset (e.g. "decision", "decision-rework", "custom").
 *     Tells the panel which outcome ladder is selected.
 *
 *   choros:outcomeButtonsJson (on bpmn:UserTask)
 *     JSON string encoding the per-outcome button styling overrides:
 *       [{ "name": "Согласовать", "label": "Утвердить", "color": "success",
 *          "requiresComment": false, "confirm": false,
 *          "targetKind": "next" }, ...]
 *     Styling lives OFF-canvas (in this attribute), not in the flow conditions.
 *     Round-trip: panel reads/writes this JSON blob; resolver reads targetKind.
 *
 * T-0325 additions:
 *
 *   choros:assignedRoleId (on bpmn:Activity)
 *     UUID of the org role assigned to execute this step.
 *     Sourced from GET /api/org/tenant-state → roles[].id (real data, no mock).
 *     Round-trip: panel writes → saveXML emits → importXML reads back.
 *     Dispatcher reads this to claim the step for the right role holder.
 *
 *   choros:byoEndpoint (on bpmn:Activity)
 *     BYO LLM base URL for agent tasks (e.g. "https://llm.internal/v1").
 *     Only meaningful when choros:executorType="agent".
 *
 *   choros:byoModel (on bpmn:Activity)
 *     Model identifier for the BYO LLM endpoint.
 *     Only meaningful when choros:executorType="agent".
 */
const ChorosModdleDescriptor = {
  name: 'Choros BPMN Extension',
  uri: 'http://choros.io/bpmn',
  prefix: 'choros',
  xml: {
    tagAlias: 'lowerCase',
  },
  types: [
    {
      /**
       * Extends bpmn:Activity so that all task subtypes (UserTask,
       * ServiceTask, SendTask, etc.) inherit the `executorType` attribute.
       * bpmn-moddle will serialize it as choros:executorType="<value>"
       * on the task XML element.
       */
      name: 'ExecutorTypeActivity',
      extends: ['bpmn:Activity'],
      properties: [
        {
          name: 'executorType',
          isAttr: true,
          type: 'String',
        },
        {
          /**
           * T-0325: UUID of the org role assigned to this step.
           * Written by the properties panel from the real /api/org/tenant-state
           * roles list. Serialised as choros:assignedRoleId="<uuid>" in XML.
           */
          name: 'assignedRoleId',
          isAttr: true,
          type: 'String',
        },
        {
          /**
           * T-0325: BYO LLM base URL for agent tasks.
           * Only meaningful when executorType="agent".
           */
          name: 'byoEndpoint',
          isAttr: true,
          type: 'String',
        },
        {
          /**
           * T-0325: BYO LLM model identifier.
           * Only meaningful when executorType="agent".
           */
          name: 'byoModel',
          isAttr: true,
          type: 'String',
        },
      ],
    },
    {
      /**
       * T-0353 [E16]: Extend bpmn:UserTask with outcome preset + button-styling
       * JSON blob. Both live on the UserTask element (off-canvas).
       *
       * choros:outcomePreset    — preset id: "done" | "decision" | "decision-rework" | "custom"
       * choros:outcomeButtonsJson — JSON-encoded ButtonDef[] (see jsdoc above)
       *
       * Only bpmn:UserTask carries these; service/send/etc. tasks are not
       * routed by human outcome (they have unconditional outgoing flows).
       */
      name: 'UserTaskOutcomes',
      extends: ['bpmn:UserTask'],
      properties: [
        {
          name: 'outcomePreset',
          isAttr: true,
          type: 'String',
        },
        {
          name: 'outcomeButtonsJson',
          isAttr: true,
          type: 'String',
        },
      ],
    },
    {
      /**
       * T-0353 [E16]: Extend bpmn:SequenceFlow with the SEMANTIC outcome name.
       *
       * choros:outcomeName — The human-readable outcome that causes routing
       *   along this flow (e.g. "Согласовать"). Serialised as an attribute
       *   on the <sequenceFlow> element. NOT a DMN condition expression.
       *
       * Round-trip:
       *   1. Panel writes bo.outcomeName = 'Согласовать'
       *   2. saveXML emits <sequenceFlow ... choros:outcomeName="Согласовать"/>
       *   3. importXML reads it back onto bo.outcomeName
       *   4. resolveOutcomeBranch() reads bo.outcomeName to find the target
       */
      name: 'SequenceFlowOutcome',
      extends: ['bpmn:SequenceFlow'],
      properties: [
        {
          name: 'outcomeName',
          isAttr: true,
          type: 'String',
        },
      ],
    },
    {
      /**
       * T-0434: Extend bpmn:ExclusiveGateway with the routing variable name.
       *
       * choros:routingVar — The process variable name that the gateway reads
       *   to select a branch (e.g. "approvalRequired").
       *   Serialised as an attribute on the <exclusiveGateway> element.
       *   The conditionExpression on each outgoing SequenceFlow uses this
       *   variable in a standard EL expression: ${routingVar == 'value'}.
       *
       * Round-trip:
       *   1. Panel writes bo.routingVar = 'approvalRequired'
       *   2. saveXML emits <exclusiveGateway ... choros:routingVar="approvalRequired"/>
       *   3. importXML reads it back onto bo.routingVar
       *   4. Panel reads it to populate the routing variable input.
       */
      name: 'GatewayConditionExtension',
      extends: ['bpmn:ExclusiveGateway'],
      properties: [
        {
          name: 'routingVar',
          isAttr: true,
          type: 'String',
        },
      ],
    },
  ],
  enumerations: [],
  associations: [],
};

export default ChorosModdleDescriptor;
