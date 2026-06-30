/* ============================================================================
   CHOROS — gateway-condition-panel.jsx
   T-0434: Gateway Condition Panel for bpmn:ExclusiveGateway.

   Responsibility:
     - Shown when a bpmn:ExclusiveGateway is selected in the modeler.
     - Lets the user declare a ROUTING VARIABLE NAME (default: approvalRequired)
       that is persisted via choros:routingVar on the gateway businessObject.
     - For each outgoing SequenceFlow, lets the user set a BRANCH VALUE which
       is written as conditionExpression "${<var> == '<value>'}" on that flow's
       businessObject via modeling.updateProperties().
     - Exactly one flow can be marked as the DEFAULT flow — its conditionExpression
       is cleared (gateway.default points to it structurally in the BPMN model).
     - After every write, fires element.changed so the canvas repaints.

   API (bpmn-js conditionExpression write pattern):
     moddle.create('bpmn:FormalExpression', { body: `\${<var> == '<value>'}` })
     modeling.updateProperties(flowElement, { conditionExpression: formalExpression })
     For clearing: modeling.updateProperties(flowElement, { conditionExpression: undefined })

   Seam (Rule-9):
     This file is NEW. The ONLY edit to bpmn-properties-panel.jsx is one
     additive import + one conditional mount line (no other existing code touched).

   Round-trip persistence:
     choros:routingVar on bpmn:ExclusiveGateway — persisted via moddle extension
     (GatewayConditionExtension type in choros-moddle-extension.js).
     conditionExpression on bpmn:SequenceFlow — standard BPMN 2.0 attribute,
     serialised by bpmn-js saveXML natively (no custom moddle needed).

   Product language: Russian labels throughout (per D-062 OBLIK).
   ============================================================================ */

import React, { useState, useCallback, useEffect } from 'react';

/* --------------------------------------------------------------------------
   Exported pure helpers — unit-testable without DOM or bpmn-js
   -------------------------------------------------------------------------- */

/**
 * Build a BPMN conditionExpression body string.
 * Output: `${<varName> == '<branchValue>'}` — well-formed EL expression
 * that passes lintBpmn (SCOPED_ELEMENTS conditionExpression text check).
 *
 * @param {string} varName      - Routing variable name (e.g. "approvalRequired")
 * @param {string} branchValue  - Branch value (e.g. "yes")
 * @returns {string}
 */
export function buildConditionBody(varName, branchValue) {
  // Sanitise: strip characters that would break the EL expression.
  // Only allow identifiers for varName and simple printable chars for value.
  // Apply fallback AFTER stripping (stripped result may be empty).
  // Fix 5: also strip leading digits so the identifier always starts with [A-Za-z_].
  const stripped = (varName || '').replace(/[^A-Za-z0-9_]/g, '').replace(/^[0-9]+/, '');
  const safeVar = stripped || 'approvalRequired';
  // Fix 4: strip apostrophes (and other EL-breaking chars) from value so every
  // stored value round-trips cleanly through parseConditionBody.
  const safeVal = (branchValue || '').replace(/['"\\]/g, '');
  return `\${${safeVar} == '${safeVal}'}`;
}

/**
 * Parse a conditionExpression body back into { varName, branchValue }.
 * Handles the canonical form `${<varName> == '<value>'}`.
 * Returns null if the expression does not match the expected pattern.
 *
 * @param {string} body
 * @returns {{ varName: string; branchValue: string } | null}
 */
export function parseConditionBody(body) {
  if (!body) return null;
  // Match: ${someVar == 'someValue'}
  const m = body.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\s*==\s*'([^']*)'\}$/);
  if (!m) return null;
  return { varName: m[1], branchValue: m[2] };
}

/**
 * Read the routing variable name from a gateway businessObject.
 * Primary: bo.routingVar (registered moddle property, T-0434 round-trip path).
 * Fallback: bo.$attrs['choros:routingVar'] (raw attribute path).
 *
 * @param {object} bo - bpmn:ExclusiveGateway businessObject
 * @returns {string}
 */
export function readRoutingVar(bo) {
  if (!bo) return 'approvalRequired';
  return bo.routingVar
    ?? (bo.$attrs && bo.$attrs['choros:routingVar'])
    ?? 'approvalRequired';
}

/**
 * Write the routing variable name to a gateway businessObject.
 * Dual-write: registered property + $attrs fallback (mirrors the existing pattern).
 *
 * @param {object} bo    - bpmn:ExclusiveGateway businessObject
 * @param {string} value - New variable name
 */
export function writeRoutingVar(bo, value) {
  if (!bo) return;
  if (!bo.$attrs) bo.$attrs = {};
  if (value) {
    bo.routingVar = value;
    bo.$attrs['choros:routingVar'] = value;
  } else {
    delete bo.routingVar;
    delete bo.$attrs['choros:routingVar'];
  }
}

/**
 * Read the conditionExpression body string from a SequenceFlow businessObject.
 * Returns '' if none set.
 *
 * @param {object} flowBo - bpmn:SequenceFlow businessObject
 * @returns {string}
 */
export function readFlowConditionBody(flowBo) {
  if (!flowBo) return '';
  const ce = flowBo.conditionExpression;
  if (!ce) return '';
  // bpmn-js stores the body as ce.body (bpmn:FormalExpression)
  return ce.body || '';
}

/* --------------------------------------------------------------------------
   Internal sub-components
   -------------------------------------------------------------------------- */

/**
 * One row per outgoing sequence flow: shows the flow label/id, a branch value
 * text input, and a "default flow" radio button.
 */
function FlowRow({ flow, varName, defaultFlowId, onBranchValueChange, onSetDefault }) {
  const bo = flow.businessObject || flow;
  const flowId = bo.id || '';
  const flowName = bo.name || flowId;

  // Parse current conditionExpression body to extract branch value
  const body = readFlowConditionBody(bo);
  const parsed = parseConditionBody(body);
  const currentValue = parsed ? parsed.branchValue : '';

  const isDefault = defaultFlowId === flowId;

  // Fix 4: warn user if they type an apostrophe (or other stripped char)
  const [stripWarning, setStripWarning] = useState(false);

  const handleValueInput = (e) => {
    if (isDefault) return;
    const raw = e.target.value;
    const hadStrippable = /['"\\]/.test(raw);
    setStripWarning(hadStrippable);
    onBranchValueChange(flowId, raw);
  };

  return (
    <div
      style={{
        border: '1px solid var(--chs-color-border)',
        borderRadius: 'var(--chs-radius-md)',
        padding: 'var(--chs-space-4)',
        marginBottom: 'var(--chs-space-3)',
        background: isDefault
          ? 'var(--chs-color-surface-alt, var(--chs-color-surface))'
          : 'var(--chs-color-surface)',
      }}
    >
      {/* Flow label */}
      <div
        className="bio-properties-panel-entry"
        style={{ marginBottom: 'var(--chs-space-2)' }}
      >
        <label className="bio-properties-panel-label" style={{ fontWeight: 600 }}>
          {flowName !== flowId ? `${flowName} (${flowId})` : flowId}
        </label>
      </div>

      {/* Branch value input — disabled when this flow is the default */}
      {/* Fix 3: label renamed to «При каком значении идти по этой ветке» */}
      <div className="bio-properties-panel-entry">
        <label className="bio-properties-panel-label">При каком значении идти по этой ветке</label>
        <div className="bio-properties-panel-textfield">
          <input
            className="bio-properties-panel-input"
            value={isDefault ? '' : currentValue}
            placeholder={isDefault ? '(ветка по умолчанию)' : 'например, да'}
            readOnly={isDefault}
            disabled={isDefault}
            onChange={handleValueInput}
            style={{ cursor: isDefault ? 'default' : undefined }}
          />
        </div>
        {/* Fix 4: inline hint when EL-breaking chars are stripped */}
        {stripWarning && !isDefault && (
          <p className="bio-properties-panel-description" style={{ marginTop: 'var(--chs-space-1)', color: 'var(--chs-color-warning)' }}>
            Кавычки и обратный слэш в значении не допускаются и будут удалены.
          </p>
        )}
      </div>

      {/* Fix 2: condition PREVIEW — human-readable, no raw EL on screen */}
      {!isDefault && currentValue && (
        <p
          className="bio-properties-panel-description"
          style={{ marginTop: 'var(--chs-space-2)', fontStyle: 'italic', fontSize: 'var(--chs-text-xs)' }}
        >
          {`Эта ветка сработает, когда «${varName}» равно «${currentValue}».`}
        </p>
      )}

      {/* Default flow radio */}
      <div
        className="bio-properties-panel-entry"
        style={{ marginTop: 'var(--chs-space-3)', flexDirection: 'row', alignItems: 'center', gap: 'var(--chs-space-2)' }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--chs-space-2)',
            fontSize: 'var(--chs-text-sm)',
            cursor: 'pointer',
          }}
        >
          <input
            type="radio"
            name={`gateway-default`}
            checked={isDefault}
            onChange={() => onSetDefault(flowId)}
          />
          Ветка по умолчанию
        </label>
        {isDefault && (
          <span
            style={{
              fontSize: 'var(--chs-text-xs)',
              color: 'var(--chs-color-text-muted)',
            }}
          >
            (условие не нужно)
          </span>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   GatewayConditionPanel — main export (panel component)

   Props:
     bo       — bpmn:ExclusiveGateway businessObject (non-null when shown)
     modeler  — BpmnModeler instance
     element  — the selected bpmn-js element (shape)
   -------------------------------------------------------------------------- */
export function GatewayConditionPanel({ bo, modeler, element }) {
  // Routing variable name state — initialised from bo, editable
  const [varName, setVarName] = useState(() => readRoutingVar(bo));

  // Default flow id state — initialised from bo.default (standard BPMN gateway default)
  const [defaultFlowId, setDefaultFlowId] = useState(() => {
    if (!bo) return '';
    // bo.default is a SequenceFlow businessObject (reference)
    const def = bo.default;
    return (def && def.id) ? def.id : '';
  });

  // When the selected element changes (different gateway), reset state from bo.
  // We key on bo.id to detect changes in the parent render cycle.
  useEffect(() => {
    setVarName(readRoutingVar(bo));
    const def = bo && bo.default;
    setDefaultFlowId((def && def.id) ? def.id : '');
  }, [bo && bo.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Fire element.changed on the gateway so canvas repaints. */
  const fireChanged = useCallback(() => {
    try {
      if (modeler && element) {
        const eventBus = modeler.get('eventBus');
        eventBus.fire('element.changed', { element });
      }
    } catch (_) { /* non-fatal */ }
  }, [modeler, element]);

  /** Get the modeling service (bpmn-js Modeling module). */
  const getModeling = useCallback(() => {
    try { return modeler && modeler.get('modeling'); } catch { return null; }
  }, [modeler]);

  /** Get the moddle service for creating bpmn:FormalExpression instances. */
  const getModdle = useCallback(() => {
    try { return modeler && modeler.get('moddle'); } catch { return null; }
  }, [modeler]);

  /**
   * Handle routing variable name change — persists to bo, then RE-EMITS
   * conditionExpression for every outgoing flow that has a parseable condition,
   * replacing the old var name with the new one (Fix 1).
   */
  const handleVarNameChange = useCallback((rawVar) => {
    // Fix 5: sanitise on input — strip non-identifier chars and leading digits
    const sanitised = rawVar.replace(/[^A-Za-z0-9_]/g, '').replace(/^[0-9]+/, '');
    setVarName(sanitised);
    writeRoutingVar(bo, sanitised);

    // Fix 1: re-emit conditionExpression for every parseable outgoing flow
    const modeling = getModeling();
    const moddle = getModdle();
    if (modeling && moddle && bo && bo.outgoing) {
      try {
        const elementRegistry = modeler.get('elementRegistry');
        for (const flow of bo.outgoing) {
          const flowBo = flow.businessObject || flow;
          const existingBody = readFlowConditionBody(flowBo);
          const parsed = parseConditionBody(existingBody);
          if (!parsed) continue; // default flow or unparseable — skip
          const newBody = buildConditionBody(sanitised, parsed.branchValue);
          const flowElement = elementRegistry.get(flowBo.id);
          if (!flowElement) continue;
          const formalExpression = moddle.create('bpmn:FormalExpression', { body: newBody });
          modeling.updateProperties(flowElement, { conditionExpression: formalExpression });
        }
      } catch (_) { /* non-fatal if elementRegistry unavailable */ }
    }

    fireChanged();
  }, [bo, modeler, getModeling, getModdle, fireChanged]);

  /**
   * Handle branch value change for a specific outgoing flow.
   * Writes conditionExpression to the flow via modeling.updateProperties.
   * This integrates with bpmn-js undo/redo.
   */
  const handleBranchValueChange = useCallback((flowId, value) => {
    if (!bo || !bo.outgoing) return;
    const modeling = getModeling();
    const moddle = getModdle();
    if (!modeling || !moddle) return;

    // Find the flow element in the modeler's elementRegistry
    let flowElement = null;
    try {
      const elementRegistry = modeler.get('elementRegistry');
      flowElement = elementRegistry.get(flowId);
    } catch { /* non-fatal */ }

    if (!flowElement) return;

    if (value && value.trim()) {
      // Write conditionExpression as bpmn:FormalExpression
      const body = buildConditionBody(varName, value.trim());
      const formalExpression = moddle.create('bpmn:FormalExpression', { body });
      modeling.updateProperties(flowElement, { conditionExpression: formalExpression });
    } else {
      // Clear the condition expression
      modeling.updateProperties(flowElement, { conditionExpression: undefined });
    }

    fireChanged();
  }, [bo, varName, modeler, getModeling, getModdle, fireChanged]);

  /**
   * Handle default flow change.
   * Sets the gateway's `default` attribute to the selected flow via
   * modeling.updateProperties on the GATEWAY element.
   * Clears the conditionExpression on the new default flow.
   */
  const handleSetDefault = useCallback((flowId) => {
    if (!bo || !bo.outgoing) return;
    const modeling = getModeling();
    const moddle = getModdle();
    if (!modeling || !moddle) return;

    let flowElement = null;
    try {
      const elementRegistry = modeler.get('elementRegistry');
      flowElement = elementRegistry.get(flowId);
    } catch { /* non-fatal */ }

    if (!flowElement) return;

    // 1. Clear conditionExpression on the new default flow (BPMN spec requirement)
    modeling.updateProperties(flowElement, { conditionExpression: undefined });

    // 2. Update the gateway's default reference
    modeling.updateProperties(element, { default: flowElement.businessObject });

    setDefaultFlowId(flowId);
    fireChanged();
  }, [bo, element, modeler, getModeling, getModdle, fireChanged]);

  // Guard: no outgoing flows → nothing to show
  const outgoing = (bo && bo.outgoing) || [];

  if (outgoing.length === 0) {
    return (
      <div className="bio-properties-panel-group">
        <div className="bio-properties-panel-group-header">
          <span className="bio-properties-panel-group-header-title">Условия ветвления</span>
        </div>
        <div className="bio-properties-panel-group-entries">
          <div className="bio-properties-panel-entry">
            <p className="bio-properties-panel-description">
              Нет исходящих потоков. Соедините шлюз с элементами диаграммы.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bio-properties-panel-group">
      <div
        className="bio-properties-panel-group-header"
        role="heading"
        aria-level={3}
      >
        <span className="bio-properties-panel-group-header-title">Условия ветвления</span>
      </div>

      <div className="bio-properties-panel-group-entries">

        {/* Fix 3: label renamed to «Поле, по которому выбирается ветка» */}
        <div className="bio-properties-panel-entry">
          <label className="bio-properties-panel-label">Поле, по которому выбирается ветка</label>
          <div className="bio-properties-panel-textfield">
            <input
              className="bio-properties-panel-input"
              value={varName}
              placeholder="например, решение"
              onChange={(e) => handleVarNameChange(e.target.value)}
            />
          </div>
          {/* Fix 2: no e.g., no UserTask / ServiceTask class names on screen */}
          <p className="bio-properties-panel-description" style={{ marginTop: 'var(--chs-space-2)' }}>
            Эту переменную задаёт один из предыдущих шагов процесса (например, шаг-форма или шаг-сервис).
          </p>
        </div>

        {/* Per-flow rows */}
        <div className="bio-properties-panel-entry">
          <div style={{ width: '100%' }}>
            {outgoing.map((flow) => {
              const flowBo = flow.businessObject || flow;
              return (
                <FlowRow
                  key={flowBo.id}
                  flow={flow}
                  varName={varName}
                  defaultFlowId={defaultFlowId}
                  onBranchValueChange={handleBranchValueChange}
                  onSetDefault={handleSetDefault}
                />
              );
            })}
          </div>
        </div>

        {/* Hint */}
        <div className="bio-properties-panel-entry">
          <p className="bio-properties-panel-description">
            Ровно одна ветка должна быть «по умолчанию» — она активируется когда
            ни одно из условий не совпало. Остальным веткам задайте значение переменной.
          </p>
        </div>

      </div>
    </div>
  );
}

export default GatewayConditionPanel;
