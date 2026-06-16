/* ============================================================================
   CHOROS — bpmn-exec-markers.js
   T-0097: Executor-type marker layer for the embedded bpmn-js modeler.

   Responsibility:
     Reads each shape's BPMN $type (and optional Choros extension attribute
     `choros:executorType`) and calls `canvas.addMarker(element, 'chs-exec-*')`
     so that bpmn-theme.css can color-code each task by executor:

       • chs-exec-human   — User Task (bpmn:UserTask)
       • chs-exec-agent   — Agent Task  (bpmn:ServiceTask where choros:executorType
                            === "agent", OR any task with that attribute)
       • chs-exec-service — External Task (bpmn:SendTask, bpmn:BusinessRuleTask,
                            bpmn:ScriptTask, bpmn:ManualTask, or bpmn:ServiceTask
                            WITHOUT the agent override)

   Choros executor convention (from screen-editor.jsx + bpmn-theme.css):
     The product maps BPMN task types to three visual executor buckets:
       human   → bpmn:UserTask                        (human performer)
       agent   → bpmn:ServiceTask with choros:executorType="agent"
                  — OR any task element carrying choros:executorType="agent"
       service → bpmn:ServiceTask (plain), bpmn:SendTask,
                 bpmn:BusinessRuleTask, bpmn:ScriptTask, bpmn:ManualTask,
                 bpmn:ReceiveTask
     A plain bpmn:Task (untyped) gets no exec marker (acts as a generic task).

   Re-application triggers:
     1. Post-importXML — applied synchronously after the promise resolves.
     2. EventBus 'import.render.complete' — handles future re-imports (T-0099).
     3. EventBus 'shape.added'            — handles shapes added by the palette.
     4. EventBus 'element.updateLabel'    — no action needed (labels only).

   No new npm dependencies. Uses only bpmn-js internal services (canvas,
   elementRegistry, eventBus) obtained via modeler.get().
   ============================================================================ */

/* --------------------------------------------------------------------------
   EXEC_MARKER_CLASSES — the three CSS marker classes applied to .djs-element
   -------------------------------------------------------------------------- */
export const EXEC_CLASSES = ['chs-exec-human', 'chs-exec-agent', 'chs-exec-service'];

/* --------------------------------------------------------------------------
   execMarkerFor(element)
   Returns the chs-exec-* class string for a bpmn-js shape element, or null
   for non-task elements (events, gateways, connections, etc.).

   `element` is a bpmn-js Shape — its `businessObject` is the bpmn-moddle
   object with $type and optional extension attributes.
   -------------------------------------------------------------------------- */
export function execMarkerFor(element) {
  // Only classify shapes (not connections, labels, root)
  if (!element || element.waypoints || element.labelTarget) return null;

  const bo = element.businessObject;
  if (!bo) return null;

  const type = bo.$type;

  // --- Check Choros extension attribute first (highest priority) -----------
  // T-0098 (properties panel) will write choros:executorType onto businessObject.
  // We read it here defensively so the renderer is already wired for that.
  const chorosExecType =
    (bo.$attrs && bo.$attrs['choros:executorType']) ||
    (bo.extensionElements && _findChorosExecType(bo.extensionElements));

  if (chorosExecType) {
    if (chorosExecType === 'human')   return 'chs-exec-human';
    if (chorosExecType === 'agent')   return 'chs-exec-agent';
    if (chorosExecType === 'service') return 'chs-exec-service';
  }

  // --- BPMN $type mapping (product convention) -----------------------------
  switch (type) {
    case 'bpmn:UserTask':
      return 'chs-exec-human';

    case 'bpmn:ServiceTask':
      // bpmn:ServiceTask is the carrier for Agent Tasks in Choros convention.
      // Without a choros:executorType override it defaults to service (external).
      // When T-0098 sets choros:executorType="agent" on it, the $attrs branch
      // above will short-circuit here.
      return 'chs-exec-service';

    case 'bpmn:SendTask':
    case 'bpmn:ReceiveTask':
    case 'bpmn:BusinessRuleTask':
    case 'bpmn:ScriptTask':
    case 'bpmn:ManualTask':
      return 'chs-exec-service';

    default:
      // bpmn:Task (untyped), bpmn:SubProcess, events, gateways → no exec class
      return null;
  }
}

/* --------------------------------------------------------------------------
   _findChorosExecType(extensionElements)
   Scan bpmn-moddle extensionElements.values for a Choros property bag.
   Tolerant — returns null if nothing found.
   -------------------------------------------------------------------------- */
function _findChorosExecType(extensionElements) {
  if (!extensionElements || !Array.isArray(extensionElements.values)) return null;
  for (const ext of extensionElements.values) {
    // Support a simple <choros:Properties> with executorType attribute
    if (ext.$type && ext.$type.includes('choros') && ext.executorType) {
      return ext.executorType;
    }
    // Support <camunda:Properties> or <zeebe:Properties> bags with name=choros:executorType
    if (ext.values && Array.isArray(ext.values)) {
      for (const prop of ext.values) {
        if (prop.name === 'choros:executorType' && prop.value) {
          return prop.value;
        }
      }
    }
  }
  return null;
}

/* --------------------------------------------------------------------------
   applyExecMarkers(modeler)
   Full pass: iterates all elements in the elementRegistry, removes any stale
   chs-exec-* markers, then applies the correct one.

   Called:
     - after importXML resolves
     - on 'import.render.complete' EventBus event
   -------------------------------------------------------------------------- */
export function applyExecMarkers(modeler) {
  const canvas          = modeler.get('canvas');
  const elementRegistry = modeler.get('elementRegistry');

  elementRegistry.forEach((element) => {
    _applyMarkerToElement(canvas, element);
  });
}

/* --------------------------------------------------------------------------
   applyExecMarkerToElement(modeler, element)
   Single-element variant — used on 'shape.added' for incremental updates.
   -------------------------------------------------------------------------- */
export function applyExecMarkerToElement(modeler, element) {
  const canvas = modeler.get('canvas');
  _applyMarkerToElement(canvas, element);
}

/* --------------------------------------------------------------------------
   _applyMarkerToElement(canvas, element)
   Internal: clear stale exec classes then set the correct one.
   -------------------------------------------------------------------------- */
function _applyMarkerToElement(canvas, element) {
  // Remove any previously applied chs-exec-* markers first (idempotent)
  for (const cls of EXEC_CLASSES) {
    canvas.removeMarker(element, cls);
  }

  const marker = execMarkerFor(element);
  if (marker) {
    canvas.addMarker(element, marker);
  }
}

/* --------------------------------------------------------------------------
   attachExecMarkerListeners(modeler)
   Registers EventBus listeners for:
     - 'import.render.complete' → full pass (re-import via T-0099)
     - 'shape.added'            → single-element pass (palette drop)

   Returns an unsubscribe function (call on modeler destroy or React unmount).
   -------------------------------------------------------------------------- */
export function attachExecMarkerListeners(modeler) {
  const eventBus = modeler.get('eventBus');

  function onImportComplete() {
    applyExecMarkers(modeler);
  }

  function onShapeAdded(event) {
    const { element } = event;
    if (element) {
      applyExecMarkerToElement(modeler, element);
    }
  }

  eventBus.on('import.render.complete', onImportComplete);
  eventBus.on('shape.added', onShapeAdded);

  return function detach() {
    eventBus.off('import.render.complete', onImportComplete);
    eventBus.off('shape.added', onShapeAdded);
  };
}
