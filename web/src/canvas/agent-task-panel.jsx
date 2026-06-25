/* ============================================================================
   CHOROS — agent-task-panel.jsx
   T-0461 [D8-R6]: typed config panel for an agentTask element.

   Shown when the selected task's element-config kind is 'agentTask'
   (a service/plain task with choros:executorType="agent"). Spec §3.7 row
   «agentTask»: агент · порог автономии · какие поля читает/пишет.

   Responsibility:
     - Loads the tenant's agents once (GET /api/agents — the T-0473 registry) and
       lets the author PICK the agent that runs this step. Persists the choice as
       choros:agentRef (= AgentPublic.id) on the task businessObject.
     - Lets the author pick the per-step AUTONOMY LEVEL (suggest / assisted / auto),
       persisted as choros:autonomyLevel.
     - Lets the author declare which record fields the agent READS / WRITES,
       persisted as choros:agentReadsFields / choros:agentWritesFields (CSV).

   ALL writes go through the driver-agnostic contract (element-config-contract.js
   writeAgentConfig) so the D8 bot writes the IDENTICAL structure — no panel-only
   assumptions baked into the persisted config.

   Honest error handling (mirrors useRoles / T-0484):
     - 401 → «войдите в систему» (auth), empty list.
     - any other non-ok (500 / engine-unavailable) → a typed error surfaced in the
       panel — never a misleading empty agent dropdown.

   Seam (Rule-9): this file is NEW. The properties panel mounts it through the
   typed dispatch; no ad-hoc agent block remains in bpmn-properties-panel.jsx.

   Product language: Russian labels throughout (D-062 OBLIK).
   ============================================================================ */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { authHeaders } from '../app-shell/dev-auth.js';
import { Field, Select } from '../components/components.jsx';
import {
  AUTONOMY_LEVELS,
  readAgentConfig,
  writeAgentConfig,
  joinFieldList,
} from './element-config-contract.js';

/* --------------------------------------------------------------------------
   useAgents — loads the tenant's agents once (panel lifetime).
   Returns { agents, loading, error }. agents = AgentPublic[] (id, slug,
   display_name, agent_type, status). Honest-empty vs honest-error per T-0484.
   -------------------------------------------------------------------------- */
export function useAgents() {
  const [agents, setAgents] = useState(null); // null = not yet fetched
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/agents', { headers: authHeaders() });
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 401) {
            // Not authenticated → honest empty (not a hard error here).
            setAgents([]);
            setLoading(false);
            return;
          }
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            detail = body?.error?.message || body?.message || detail;
          } catch { /* non-JSON body */ }
          setError(`Не удалось загрузить агентов: ${detail}`);
          setAgents([]);
          setLoading(false);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setAgents(Array.isArray(data.agents) ? data.agents : []);
      } catch (err) {
        if (!cancelled) {
          setError(`Не удалось загрузить агентов: ${err?.message || 'сеть недоступна'}`);
          setAgents([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return { agents: agents || [], loading, error };
}

/** Build the <select> options for agents, with a sentinel "not chosen" row. */
export function agentSelectOptions(agents) {
  return [
    { value: '', label: '— агент не выбран —' },
    ...(agents || []).map((a) => ({
      value: a.id,
      label: a.display_name || a.slug || a.id,
    })),
  ];
}

/* --------------------------------------------------------------------------
   AgentTaskPanel — main export.

   Props:
     bo       — the agentTask businessObject
     modeler  — BpmnModeler instance
     element  — the selected bpmn-js element (shape)
     PanelGroup / PPEntry — chrome components passed from the parent panel.

   The agent list is fetched ONCE per panel lifetime via useAgents (the panel is
   only mounted while an agentTask is selected, and the fetch is memoised across
   re-selections by the fetchedRef guard inside useAgents).
   -------------------------------------------------------------------------- */
export function AgentTaskPanel({ bo, modeler, element, PanelGroup, PPEntry }) {
  const { agents, loading: agentsLoading, error: agentsError } = useAgents();

  const initial = readAgentConfig(bo);
  const [agentRef, setAgentRef] = useState(initial.agentRef);
  const [autonomyLevel, setAutonomyLevel] = useState(initial.autonomyLevel);
  const [readsFields, setReadsFields] = useState(joinFieldList(initial.readsFields));
  const [writesFields, setWritesFields] = useState(joinFieldList(initial.writesFields));

  // Re-sync when a different agentTask is selected.
  useEffect(() => {
    const next = readAgentConfig(bo);
    setAgentRef(next.agentRef);
    setAutonomyLevel(next.autonomyLevel);
    setReadsFields(joinFieldList(next.readsFields));
    setWritesFields(joinFieldList(next.writesFields));
  }, [bo && bo.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fireChanged = useCallback(() => {
    try {
      if (modeler && element) modeler.get('eventBus').fire('element.changed', { element });
    } catch (_) { /* non-fatal */ }
  }, [modeler, element]);

  const commit = useCallback((patch) => {
    writeAgentConfig(bo, patch);
    fireChanged();
  }, [bo, fireChanged]);

  const handleAgentRef = (val) => { setAgentRef(val); commit({ agentRef: val }); };
  const handleAutonomy = (val) => { setAutonomyLevel(val); commit({ autonomyLevel: val }); };
  const handleReads = (val) => { setReadsFields(val); commit({ readsFields: val }); };
  const handleWrites = (val) => { setWritesFields(val); commit({ writesFields: val }); };

  return (
    <PanelGroup title="Агент-исполнитель" defaultOpen>
      {/* Agent selection */}
      <PPEntry>
        {agentsLoading ? (
          <p className="bio-properties-panel-description">Загрузка агентов…</p>
        ) : agentsError ? (
          <p
            className="bio-properties-panel-description"
            role="alert"
            style={{ color: 'var(--chs-color-danger)' }}
          >
            {agentsError} — выбор агента недоступен. Повторите позже.
          </p>
        ) : (
          <Select
            label="Агент"
            options={agentSelectOptions(agents)}
            value={agentRef}
            onChange={(e) => handleAgentRef(e.target.value)}
            aria-label="Агент-исполнитель шага"
            hint={
              (agents || []).length === 0
                ? 'Агентов нет — подключите их в разделе «Агенты».'
                : undefined
            }
          />
        )}
      </PPEntry>

      {/* Autonomy level */}
      <PPEntry>
        <div className="bio-properties-panel-select">
          <label className="bio-properties-panel-label">Порог автономии</label>
          <select value={autonomyLevel} onChange={(e) => handleAutonomy(e.target.value)}>
            {AUTONOMY_LEVELS.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
        </div>
        <p className="bio-properties-panel-description" style={{ marginTop: 'var(--chs-space-2)' }}>
          Базовый предел автономии и бюджет агента задаются на уровне агента в
          Оргструктуре. Здесь — потолок для ЭТОГО шага.
        </p>
      </PPEntry>

      {/* Fields the agent reads */}
      <PPEntry>
        <Field
          label="Поля, которые агент читает"
          mono
          value={readsFields}
          placeholder="amount, vendor, dueDate"
          onChange={(e) => handleReads(e.target.value)}
          aria-label="Поля записи, которые агент читает"
        />
      </PPEntry>

      {/* Fields the agent writes */}
      <PPEntry>
        <Field
          label="Поля, которые агент пишет"
          mono
          value={writesFields}
          placeholder="decision, comment"
          onChange={(e) => handleWrites(e.target.value)}
          aria-label="Поля записи, которые агент пишет"
        />
        <p className="bio-properties-panel-description" style={{ marginTop: 'var(--chs-space-2)' }}>
          Перечислите ключи полей приложения через запятую. Если порога автономии
          не хватит, шаг уходит человеку (fallback) с этими полями.
        </p>
      </PPEntry>
    </PanelGroup>
  );
}

export default AgentTaskPanel;
