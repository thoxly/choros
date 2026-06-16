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
      ],
    },
  ],
  enumerations: [],
  associations: [],
};

export default ChorosModdleDescriptor;
