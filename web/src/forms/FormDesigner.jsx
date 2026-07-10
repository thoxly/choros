/* ============================================================================
   CHOROS — FormDesigner.jsx  (T-0481 · E-FORMS F2 / rebuilt T-0544 / T-0656 DnD)

   THE INTERFACE BUILDER — "where layout is configured."

   T-0544 rebuild: the canvas now reads the ONE widget registry (widget-registry
   .js), supports NESTED drag (into section/columns/tabs, path-aware drop),
   reorder within a container, an always-visible LIVE preview side-by-side (not a
   <details>), undo/redo (history-stack.js), and multiselect. The palette and the
   inspector are DERIVED from the registry (descriptor.icon / .label /
   .paletteGroup / .editorProps) — no hardcoded GROUP_LABELS, no `if (node.type
   === 'text')` branches.

   T-0656 (founder order — "make DnD actually pleasant, for humans AND agents"):
   the visual feedback layer is rebuilt so a drag shows its RESULT, not a guess —
   DropIndicator (was DropSlot) renders a full-width placeholder bar computed from
   cursor position, the receiving container is highlighted, the canvas autoscrolls
   near its edges, a keyboard cut/paste path sits next to the existing Alt+Up/Down,
   a live-region announces every move, and the canvas can go fullscreen. NONE of
   this touches form-document-ops.js — every move still resolves to the same
   insertNode/removeNode/reorderNode/moveNode calls (the machine seam — T-0656
   §4 ADR — shares this exact op vocabulary on the server).

   This is still the HUMAN driver of the form-document (deliverable 2): a thin
   visual shell over the tested pure layer — the registry, the pure ops
   (form-document-ops.js), the authoring validator (validateDocument), the ONE
   renderer (FormDocumentRenderer.jsx) for the live preview.

   T-0533 PRESERVED: isDirty / savedDocRef / saveGen / useDirtyGuard / the
   route-guard ConfirmDialog are intact — `doc` is now `history.present` and
   undo-to-baseline correctly resets isDirty.

   Theming: --chs-* tokens + kit components only (gate G2/G6).
   ============================================================================ */

import React, { useState, useEffect, useMemo, useCallback, useRef, useId } from 'react';
import { Button, EmptyState, LoadingState, ErrorState, Select, ConfirmDialog } from '../components/components.jsx';
import { ConsequenceSummary } from '../util/confirm-helpers.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import { useDirtyGuard } from '../hooks/useDirtyGuard.js';
import { parseRecordSchema } from '../screens/apps-schema.js';
import { fetchProcessDef } from '../canvas/process-editor-api.js';
import { extractUserTasks } from './bpmn-user-tasks.js';
import FormDocumentRenderer from './FormDocumentRenderer.jsx';
import {
  buildDefaultDocument, validateDocument,
  nodeForField, childrenOf, WIDGET_COMPAT,
} from './form-document.js';
import {
  getWidget, byPaletteGroup,
} from './widget-registry.js';
import {
  insertNode, removeNode, reorderNode, updateNode, moveNode, nodeAtPath,
} from './form-document-ops.js';
import {
  initHistory, pushHistory, undo as undoHistory, redo as redoHistory, canUndo, canRedo,
} from './history-stack.js';
import { computeAutoscrollDelta, prefersReducedMotion } from './canvas-autoscroll.js';
import { announceMove, announceCut, announcePaste, cloneForClipboard } from './canvas-a11y.js';
import { containerIsDropTarget } from './canvas-path.js';
import './form-designer.css';

// T-0669: shared copy for both the picker's empty-state hint (process chosen,
// no app bound yet — normal authoring step) and the save-time defense-in-depth
// block (same fact, but blocking an action). One string, no drift risk.
const PROCESS_NOT_BOUND_HINT = 'Этот процесс не привязан ни к одному приложению — привяжите его на экране «Процессы».';

// T-0706: the binding fixes a specific registry_def but no match exists among
// the application's registryDefs (data desync — the registry the binding
// points to was renamed/removed). Honest text, no silent narrowing to nothing.
const REGISTRY_SLUG_NOT_FOUND_PREFIX = 'Набор полей «';
const REGISTRY_SLUG_NOT_FOUND_SUFFIX = '» из привязки процесса не найден среди наборов полей этого приложения.';

// T-0706: the binding does NOT fix a registry_def explicitly (target_registry_slug
// is null/empty) and the application carries more than one registry_def — the
// server will fall back to its own default slug, which the client cannot see
// (env-derived, not exposed by any GET). Warn instead of silently picking one.
const REGISTRY_NOT_FIXED_HINT = 'Привязка процесса не фиксирует конкретный набор полей — сервер применит набор по умолчанию. Если у приложения несколько наборов полей, зафиксируйте нужный на экране «Процессы», иначе сохранение может не пройти.';

// ---------------------------------------------------------------------------
// Path / drag helpers
// ---------------------------------------------------------------------------

/** Stable string key for a node position (containerPath + ':' + index[:tab]). */
function pathKey(containerPath, index, tabIndex) {
  const cp = containerPath.map((s) => (typeof s === 'number' ? s : `t${s.tab}.${s.index}`)).join('/');
  const t = tabIndex === undefined || tabIndex === null ? '' : `#${tabIndex}`;
  return `${cp}:${index}${t}`;
}

/** Append a child segment to a container path (tab-aware). */
function childContainerPath(containerPath, index, tabIndex) {
  if (tabIndex === undefined || tabIndex === null) return [...containerPath, index];
  return [...containerPath, { tab: tabIndex, index }];
}

function setDrag(e, payload) {
  // One JSON payload (design §2.1). Also set legacy mime types so any old
  // listener / test that reads them still sees the type.
  e.dataTransfer.setData('application/x-builder', JSON.stringify(payload));
  if (payload.kind === 'palette') e.dataTransfer.setData('application/x-palette', payload.widgetId);
  if (payload.kind === 'field') e.dataTransfer.setData('application/x-field', payload.fieldKey);
  e.dataTransfer.effectAllowed = 'move';
}

function readDrag(e) {
  const raw = e.dataTransfer.getData('application/x-builder');
  if (raw) { try { return JSON.parse(raw); } catch { /* fallthrough */ } }
  const pal = e.dataTransfer.getData('application/x-palette');
  if (pal) return { kind: 'palette', widgetId: pal };
  const fk = e.dataTransfer.getData('application/x-field');
  if (fk) return { kind: 'field', fieldKey: fk };
  return null;
}

/** Build a fresh node for a palette widget id (no live-schema binding). */
function defaultNodeForWidget(widgetId) {
  switch (widgetId) {
    case 'custom': return { type: 'custom', componentId: 'custom-widget', bindings: [], label: 'Код-виджет' };
    case 'columns': return { type: 'columns', count: 2, children: [] };
    case 'tabs': return { type: 'tabs', tabs: [{ title: 'Вкладка 1', children: [] }] };
    case 'section': return { type: 'section', title: 'Секция', children: [] };
    case 'text': return { type: 'text', content: 'Подсказка' };
    case 'divider': return { type: 'divider' };
    default: return { type: widgetId };
  }
}

// ---------------------------------------------------------------------------
// Palette — derived from the registry (no GROUP_LABELS hardcode)
// ---------------------------------------------------------------------------

function PaletteBlock({ descriptor, onAdd }) {
  return (
    <button
      type="button"
      className="chs-palette-block chs-btn chs-btn--ghost"
      style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--chs-space-2)', width: '100%', textAlign: 'left', marginBottom: 'var(--chs-space-2)' }}
      draggable
      onDragStart={(e) => setDrag(e, { kind: 'palette', widgetId: descriptor.id })}
      onClick={() => onAdd(descriptor.id)}
      title={descriptor.summary}
    >
      <span aria-hidden="true" style={{ fontSize: 'var(--chs-text-md)', lineHeight: 1.2 }}>{descriptor.icon}</span>
      <span style={{ flex: 1 }}>
        <strong>{descriptor.label}</strong>
        {descriptor.floor === 2 && (
          <span className="chs-chip" style={{ marginLeft: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-warning)' }}>код</span>
        )}
        <span style={{ display: 'block', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>{descriptor.summary}</span>
      </span>
    </button>
  );
}

function FieldChip({ field, used, onAdd }) {
  const usedHintId = used ? `field-used-${field.key}` : undefined;
  return (
    <>
      <button
        type="button"
        className="chs-field-chip chs-btn chs-btn--ghost"
        style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 'var(--chs-space-1)', opacity: used ? 0.5 : 1 }}
        draggable={!used}
        onDragStart={!used ? (e) => setDrag(e, { kind: 'field', fieldKey: field.key }) : undefined}
        onClick={!used ? () => onAdd(field.key) : undefined}
        aria-disabled={used || undefined}
        aria-describedby={usedHintId}
        title={`Поле «${field.key}» (${field.type})`}
      >
        {field.label || field.title || field.key}
        <span style={{ float: 'right', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>{field.type}</span>
      </button>
      {used && (
        <span id={usedHintId} className="chs-sr-only">Поле уже добавлено на форму</span>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// T-0656 — shared drag-hover state: WHICH container is the current drop target.
// A single canvas-wide value (not per-slot local state) so the CONTAINER itself
// (not just the thin slot) can be highlighted while a drag is over any of its
// insertion points — the "куда же оно вставится" question gets a whole-container
// answer, not a guess from a 6px sliver.
// ---------------------------------------------------------------------------

function containerKey(containerPath, tabIndex) {
  const cp = containerPath.map((s) => (typeof s === 'number' ? s : `t${s.tab}.${s.index}`)).join('/');
  return tabIndex === undefined || tabIndex === null ? cp : `${cp}#${tabIndex}`;
}

// ---------------------------------------------------------------------------
// Drop indicator — a path-aware insertion target that renders the RESULT of a
// drop (a full-width placeholder bar), not a guessable sliver. `active` (passed
// by the parent, derived from shared drag-hover state) drives both the bar's
// own emphasis and asks the CONTAINER to highlight via onContainerHover.
// ---------------------------------------------------------------------------

function DropIndicator({ containerPath, tabIndex, insertAt, onDrop, onHoverContainer, hover }) {
  const myKey = `${containerKey(containerPath, tabIndex)}:${insertAt}`;
  const active = hover?.key === myKey;
  return (
    <div
      className={`chs-drop-indicator${active ? ' chs-drop-indicator--active' : ''}`}
      role="presentation"
      data-drop-indicator="true"
      onDragOver={(e) => {
        e.preventDefault(); e.stopPropagation();
        onHoverContainer(myKey, containerPath, tabIndex);
      }}
      onDragLeave={(e) => { e.stopPropagation(); }}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation();
        onHoverContainer(null);
        onDrop({ containerPath, tabIndex, insertAt }, e);
      }}
    />
  );
}

function EmptyDropZone({ containerPath, tabIndex, onDrop, onHoverContainer, hover }) {
  const myKey = `${containerKey(containerPath, tabIndex)}:0`;
  const active = hover?.key === myKey;
  return (
    <div
      className={`chs-empty-drop${active ? ' chs-empty-drop--over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault(); e.stopPropagation();
        onHoverContainer(myKey, containerPath, tabIndex);
      }}
      onDragLeave={(e) => { e.stopPropagation(); }}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation();
        onHoverContainer(null);
        onDrop({ containerPath, tabIndex, insertAt: 0 }, e);
      }}
      style={{
        padding: 'var(--chs-space-3)', textAlign: 'center',
        color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)',
        border: `1px dashed ${active ? 'var(--chs-color-accent)' : 'var(--chs-color-border)'}`,
        borderRadius: 'var(--chs-radius-sm)',
        background: active ? 'var(--chs-color-accent-soft)' : 'transparent',
      }}
    >
      Перетащите сюда
    </div>
  );
}

// ---------------------------------------------------------------------------
// CanvasNode v2 — a visual block (icon/label from registry) with nested children
// ---------------------------------------------------------------------------

function CanvasNode({
  node, containerPath, index, tabIndex,
  selectedKeys, onSelectNode, onRemove, onDuplicate, onDrop, brokenKeys,
  siblingCount, onMoveUp, onMoveDown, onHoverContainer, hover,
}) {
  const descriptor = getWidget(node.type);
  const key = pathKey(containerPath, index, tabIndex);
  const selected = selectedKeys.has(key);
  const userLabel = node.label || node.title || '';
  const broken = node.fieldKey && brokenKeys.includes(node.fieldKey);
  const isContainer = descriptor && (descriptor.isContainer === true);

  const myPath = childContainerPath(containerPath, index, tabIndex);
  // STRUCTURAL container highlight (UX-1 fix): this container lights up iff the
  // drag hover is INSIDE it — its own children-path is a SEGMENT prefix of the
  // hover container path (canvas-path.js). The previous string.startsWith on
  // concatenated keys false-matched container 1 while dragging inside container
  // 10 (and nested [0,1] vs [0,10]); segment compare has real boundaries.
  const containerHighlighted = isContainer && containerIsDropTarget(myPath, hover?.path ?? null);

  // T-0529/T-0656: keyboard handler — Alt+Up/Down (legacy) and plain Up/Down
  // (T-0656 — the natural arrow-key expectation once a block is selected)
  // both reorder; Cmd/Ctrl+X cuts, Cmd/Ctrl+V pastes (wired by the parent via
  // window-level listeners so multi-node clipboard state stays in one place).
  const handleKeyDown = (e) => {
    const isArrowUp = e.key === 'ArrowUp';
    const isArrowDown = e.key === 'ArrowDown';
    if ((e.altKey || (!e.metaKey && !e.ctrlKey)) && isArrowUp) {
      e.preventDefault(); e.stopPropagation();
      if (onMoveUp && index > 0) onMoveUp(containerPath, index, tabIndex);
    } else if ((e.altKey || (!e.metaKey && !e.ctrlKey)) && isArrowDown) {
      e.preventDefault(); e.stopPropagation();
      if (onMoveDown && index < siblingCount - 1) onMoveDown(containerPath, index, tabIndex);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); e.stopPropagation();
      onSelectNode(key, e);
    }
  };

  return (
    <div
      className={`chs-canvas-node${selected ? ' chs-canvas-node--selected' : ''}${containerHighlighted ? ' chs-canvas-node--drop-target' : ''}`}
      role="treeitem"
      aria-selected={selected}
      aria-label={`${descriptor ? descriptor.label : node.type}: ${userLabel || node.fieldKey || 'без метки'}`}
      tabIndex={0}
      data-node-key={key}
      style={{
        border: broken ? '2px solid var(--chs-color-danger)'
          : selected ? '2px solid var(--chs-color-accent)'
          : containerHighlighted ? '2px dashed var(--chs-color-accent)' : '1px solid var(--chs-color-border)',
        borderRadius: 'var(--chs-radius-md)', padding: 'var(--chs-space-3)',
        background: containerHighlighted ? 'var(--chs-color-accent-soft)' : 'var(--chs-color-surface)',
        cursor: 'grab',
      }}
      draggable
      onDragStart={(e) => { e.stopPropagation(); setDrag(e, { kind: 'reorder', fromContainer: containerPath, fromIndex: index, fromTab: tabIndex ?? null }); }}
      onClick={(e) => { e.stopPropagation(); onSelectNode(key, e); }}
      onKeyDown={handleKeyDown}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--chs-space-2)' }}>
        <span className="chs-canvas-node__type" style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
          <span aria-hidden="true">{descriptor ? descriptor.icon : '?'}</span>
          {descriptor ? descriptor.label : node.type}
          {descriptor && descriptor.floor === 2 && (
            <span className="chs-chip" style={{ color: 'var(--chs-color-warning)' }}>код</span>
          )}
        </span>
        <span role="group" aria-label="Управление блоком" style={{ display: 'flex', gap: 'var(--chs-space-1)' }}>
          {onMoveUp && (
            <button type="button" className="chs-btn chs-btn--ghost chs-btn--sm"
              onClick={(e) => { e.stopPropagation(); onMoveUp(containerPath, index, tabIndex); }}
              disabled={index === 0}
              aria-label="Переместить блок выше (стрелка вверх)"
              title="Переместить выше">▲</button>
          )}
          {onMoveDown && (
            <button type="button" className="chs-btn chs-btn--ghost chs-btn--sm"
              onClick={(e) => { e.stopPropagation(); onMoveDown(containerPath, index, tabIndex); }}
              disabled={siblingCount !== undefined && index >= siblingCount - 1}
              aria-label="Переместить блок ниже (стрелка вниз)"
              title="Переместить ниже">▼</button>
          )}
          <button type="button" className="chs-btn chs-btn--ghost chs-btn--sm" onClick={(e) => { e.stopPropagation(); onDuplicate(containerPath, index, tabIndex); }} aria-label="Дублировать блок" title="Дублировать">⧉</button>
          <button type="button" className="chs-btn chs-btn--ghost chs-btn--sm" onClick={(e) => { e.stopPropagation(); onRemove(containerPath, index, tabIndex); }} aria-label="Удалить блок" title="Удалить">×</button>
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>{userLabel || (descriptor ? descriptor.label : node.type)}</strong>
        {node.fieldKey && (
          <span style={{ fontSize: 'var(--chs-text-xs)', color: broken ? 'var(--chs-color-danger)' : 'var(--chs-color-text-muted)' }}>↳ {node.fieldKey}{broken ? ' (битая)' : ''}</span>
        )}
      </div>

      {/* nested children for containers */}
      {isContainer && descriptor.isTabs && (
        <TabsCanvas node={node} containerPath={myPath} selectedKeys={selectedKeys}
          onSelectNode={onSelectNode} onRemove={onRemove} onDuplicate={onDuplicate} onDrop={onDrop}
          onMoveUp={onMoveUp} onMoveDown={onMoveDown}
          onHoverContainer={onHoverContainer} hover={hover}
          brokenKeys={brokenKeys} />
      )}
      {isContainer && !descriptor.isTabs && (
        <ChildrenCanvas node={node} containerPath={myPath} selectedKeys={selectedKeys}
          onSelectNode={onSelectNode} onRemove={onRemove} onDuplicate={onDuplicate} onDrop={onDrop}
          onMoveUp={onMoveUp} onMoveDown={onMoveDown}
          onHoverContainer={onHoverContainer} hover={hover}
          brokenKeys={brokenKeys} />
      )}
    </div>
  );
}

/** Render a container's children with interleaved DropIndicators (section/columns). */
function ChildrenCanvas({ node, containerPath, selectedKeys, onSelectNode, onRemove, onDuplicate, onDrop, onMoveUp, onMoveDown, onHoverContainer, hover, brokenKeys }) {
  const kids = Array.isArray(node.children) ? node.children : [];
  return (
    <div className="chs-canvas-children" role="group" style={{ marginTop: 'var(--chs-space-2)', marginLeft: 'var(--chs-space-3)', paddingLeft: 'var(--chs-space-2)', borderLeft: '2px solid var(--chs-color-border)' }}>
      {kids.length === 0 ? (
        <EmptyDropZone containerPath={containerPath} onDrop={onDrop} onHoverContainer={onHoverContainer} hover={hover} />
      ) : (
        <>
          <DropIndicator containerPath={containerPath} insertAt={0} onDrop={onDrop} onHoverContainer={onHoverContainer} hover={hover} />
          {kids.map((child, i) => (
            <React.Fragment key={child.id || `${child.type}-${i}`}>
              <CanvasNode
                node={child} containerPath={containerPath} index={i}
                siblingCount={kids.length}
                selectedKeys={selectedKeys} onSelectNode={onSelectNode}
                onRemove={onRemove} onDuplicate={onDuplicate} onDrop={onDrop}
                onMoveUp={onMoveUp} onMoveDown={onMoveDown}
                onHoverContainer={onHoverContainer} hover={hover}
                brokenKeys={brokenKeys}
              />
              <DropIndicator containerPath={containerPath} insertAt={i + 1} onDrop={onDrop} onHoverContainer={onHoverContainer} hover={hover} />
            </React.Fragment>
          ))}
        </>
      )}
    </div>
  );
}

/** Render a tabs node's children: a tab switcher + the active tab's children. */
function TabsCanvas({ node, containerPath, selectedKeys, onSelectNode, onRemove, onDuplicate, onDrop, onMoveUp, onMoveDown, onHoverContainer, hover, brokenKeys }) {
  const tabs = Array.isArray(node.tabs) ? node.tabs : [];
  const [active, setActive] = useState(0);
  const tabIdx = Math.min(active, Math.max(0, tabs.length - 1));
  const kids = Array.isArray(tabs[tabIdx]?.children) ? tabs[tabIdx].children : [];

  // T-0529: roving tabindex + arrow-key navigation for TabsCanvas tab buttons
  const handleTabKeyDown = (e, i) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault(); setActive((i + 1) % tabs.length);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault(); setActive((i - 1 + tabs.length) % tabs.length);
    }
  };

  return (
    <div className="chs-canvas-tabs" style={{ marginTop: 'var(--chs-space-2)', marginLeft: 'var(--chs-space-3)' }}>
      <div role="tablist" style={{ display: 'flex', gap: 'var(--chs-space-2)', marginBottom: 'var(--chs-space-2)' }}>
        {tabs.map((t, i) => (
          <button
            key={i} type="button" role="tab"
            id={`canvas-tab-${containerPath.join('-')}-${i}`}
            aria-selected={tabIdx === i}
            aria-controls={`canvas-tabpanel-${containerPath.join('-')}-${i}`}
            tabIndex={tabIdx === i ? 0 : -1}
            className={`chs-btn chs-btn--ghost chs-btn--sm${tabIdx === i ? ' chs-btn--active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setActive(i); }}
            onKeyDown={(e) => handleTabKeyDown(e, i)}
            onDragOver={(e) => { e.preventDefault(); setActive(i); }}
          >
            {t.title || `Вкладка ${i + 1}`}
          </button>
        ))}
      </div>
      <div
        id={`canvas-tabpanel-${containerPath.join('-')}-${tabIdx}`}
        role="tabpanel"
        aria-labelledby={`canvas-tab-${containerPath.join('-')}-${tabIdx}`}
        style={{ paddingLeft: 'var(--chs-space-2)', borderLeft: '2px solid var(--chs-color-border)' }}
      >
        {kids.length === 0 ? (
          <EmptyDropZone containerPath={containerPath} tabIndex={tabIdx} onDrop={onDrop} onHoverContainer={onHoverContainer} hover={hover} />
        ) : (
          <>
            <DropIndicator containerPath={containerPath} tabIndex={tabIdx} insertAt={0} onDrop={onDrop} onHoverContainer={onHoverContainer} hover={hover} />
            {kids.map((child, i) => (
              <React.Fragment key={child.id || `${child.type}-${i}`}>
                <CanvasNode
                  node={child} containerPath={containerPath} index={i} tabIndex={tabIdx}
                  siblingCount={kids.length}
                  selectedKeys={selectedKeys} onSelectNode={onSelectNode}
                  onRemove={onRemove} onDuplicate={onDuplicate} onDrop={onDrop}
                  onMoveUp={onMoveUp} onMoveDown={onMoveDown}
                  onHoverContainer={onHoverContainer} hover={hover}
                  brokenKeys={brokenKeys}
                />
                <DropIndicator containerPath={containerPath} tabIndex={tabIdx} insertAt={i + 1} onDrop={onDrop} onHoverContainer={onHoverContainer} hover={hover} />
              </React.Fragment>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector v2 — driven by descriptor.editorProps (no node.type branches)
// ---------------------------------------------------------------------------

function PropControl({ prop, node, schemaField, onPatch }) {
  const autoId = useId();
  const inputId = `chs-prop-${autoId}`;
  if (prop.control === 'text' && prop.multiline) {
    return (
      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-3)' }}>
        <label className="chs-label" htmlFor={inputId}>{prop.label}</label>
        <textarea id={inputId} className="chs-input" rows={2} value={node[prop.key] || ''}
          onChange={(e) => onPatch({ [prop.key]: e.target.value })}
          style={{ width: '100%' }} />
      </div>
    );
  }
  if (prop.control === 'text') {
    return (
      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-3)' }}>
        <label className="chs-label" htmlFor={inputId}>{prop.label}</label>
        <input id={inputId} className="chs-input" type="text" value={node[prop.key] || ''}
          onChange={(e) => onPatch({ [prop.key]: e.target.value })}
          style={{ width: '100%' }} />
      </div>
    );
  }
  if (prop.control === 'select' && prop.fromSchemaWidgets) {
    const choices = schemaField ? (WIDGET_COMPAT[schemaField.type] || []) : [];
    if (choices.length === 0) return null;
    return (
      <>
        <label className="chs-label">{prop.label}</label>
        <Select value={node[prop.key] || choices[0]}
          onChange={(e) => onPatch({ [prop.key]: e.target.value })}
          options={choices.map((w) => ({ value: w, label: w }))} />
      </>
    );
  }
  if (prop.control === 'select') {
    return (
      <>
        <label className="chs-label">{prop.label}</label>
        <Select value={String(node[prop.key] ?? prop.options?.[0]?.value ?? '')}
          onChange={(e) => onPatch({ [prop.key]: prop.key === 'count' ? Number(e.target.value) : e.target.value })}
          options={prop.options || []} />
      </>
    );
  }
  if (prop.control === 'mode') {
    return (
      <>
        <label className="chs-label" style={{ marginTop: 'var(--chs-space-3)' }}>{prop.label}</label>
        <Select value={node.mode || 'editable'}
          onChange={(e) => onPatch({ mode: e.target.value === 'editable' ? undefined : e.target.value })}
          options={[
            { value: 'editable', label: 'Редактируемое' },
            { value: 'readonly', label: 'Только чтение' },
            { value: 'required', label: 'Обязательное' },
            { value: 'hidden', label: 'Скрытое' },
          ]} />
      </>
    );
  }
  return null;
}

function Inspector({ node, schemaField, multiCount, onPatch }) {
  if (multiCount > 1) {
    return <p style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>Выбрано блоков: {multiCount}. Множественная настройка свойств появится позже — выберите один блок.</p>;
  }
  if (!node) {
    return <p style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>Выберите блок, чтобы настроить его.</p>;
  }
  const descriptor = getWidget(node.type);
  const props = descriptor ? (descriptor.editorProps || []) : [];
  return (
    <div className="chs-inspector">
      {props.map((prop) => (
        <PropControl key={prop.key} prop={prop} node={node} schemaField={schemaField} onPatch={onPatch} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The designer
// ---------------------------------------------------------------------------

/**
 * FormDesigner — interface-builder authoring (T-0544 rebuild).
 *
 * @param {object} [props]
 * @param {object} [props.initialDocument] optional document to load (e.g. AI-emitted)
 * @param {Array}  [props.initialFields]   optional live schema (testing/embedding)
 */
function FormDesigner({ initialDocument, initialFields } = {}) {
  const [applications, setApplications] = useState(initialFields ? [] : null);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [registryDefs, setRegistryDefs] = useState(null);
  const [selectedDefId, setSelectedDefId] = useState('');
  const [fields, setFields] = useState(initialFields || []);

  // T-0665 (F1/F2): the process+step this form binds to. FormDesigner used to
  // never set this — persistLayout() then always fell back to the hardcoded
  // process_key='record'/form_key='record-form', which has no
  // process_app_binding on any real tenant → save always 409'd (LIVE_PROOF
  // T-0656 P0). `stepKey` stays free text (same pattern as FormBuilder.jsx's
  // existing step field) — `bpmnUserTasks` only POPULATES a suggestion list,
  // it is never the sole way to set a value (best-effort, ADR §3.1).
  const [processCatalog, setProcessCatalog] = useState(null); // null = not loaded yet
  const [catalogError, setCatalogError] = useState(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [selectedProcessKey, setSelectedProcessKey] = useState('');
  const [stepKey, setStepKey] = useState('');
  // T-0669: process↔application bindings (GET /api/process-app-bindings, reused
  // from T-0681/screen-processes.jsx) — the SAME table classifyLayoutSave's
  // resolveLiveRecordSchema resolves against on save. `null` = not loaded yet
  // (fetch failed or still in flight); an empty array is an authoritative
  // "genuinely no bindings" answer (graceful-empty, not an error). Without this,
  // the "Приложение" picker below offered EVERY application in the tenant,
  // including ones with no process_app_binding row for the chosen process — the
  // pair authored cleanly and only failed on Save with an opaque 409 (T-0669).
  const [processAppBindings, setProcessAppBindings] = useState(null);
  const [bpmnUserTasks, setBpmnUserTasks] = useState([]); // best-effort suggestions
  // T-0665 (F3): whether an existing form_binding.layout was loaded for the
  // current (selectedProcessKey, stepKey) pair — drives whether the
  // registry-def-change effect below is allowed to rebuild a fresh document.
  const [loadingExistingBinding, setLoadingExistingBinding] = useState(false);
  const [existingBindingError, setExistingBindingError] = useState(null);
  // T-0544: the document lives inside a HistoryStack (undo/redo). doc = history.present.
  const [history, setHistory] = useState(() => (initialDocument ? initHistory(initialDocument) : null));
  // multiselect: a Set of path-keys.
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [saveState, setSaveState] = useState({ status: 'idle' });
  const [loadError, setLoadError] = useState(null);
  const [saveGen, setSaveGen] = useState(0);
  // T-0656: canvas-wide drag-hover state — which insertion point (and thus which
  // container) is the current drop target, so the WHOLE container highlights.
  // `key` (exact string) drives the hovered INDICATOR's own bar; `path` (segment
  // array + tab) drives the CONTAINER highlight via STRUCTURAL prefix compare
  // (canvas-path.js) — NOT string.startsWith, which false-matches "10" under "1".
  const [hover, setHover] = useState(null); // null | { key, path, tabIndex }
  // T-0656: fullscreen canvas toggle (local state, no routing).
  const [isFullscreen, setIsFullscreen] = useState(false);
  // T-0656: live-region announcement text for screen readers.
  const [announcement, setAnnouncement] = useState('');
  // T-0656: keyboard cut/paste clipboard (a single detached node).
  const clipboardRef = useRef(null);
  // T-0656: canvas DOM ref for autoscroll.
  const canvasRef = useRef(null);

  const doc = history ? history.present : null;

  // T-0533: last-saved snapshot for isDirty.
  const savedDocRef = useRef(initialDocument ?? null);

  // T-0656: shared hover handler passed to every DropIndicator/EmptyDropZone.
  // Stores the exact key (for the indicator) AND the structured path (for the
  // structural container-highlight compare). Called with null to clear.
  const onHoverContainer = useCallback((key, containerPath, tabIndex) => {
    if (key === null || key === undefined) { setHover(null); return; }
    setHover({ key, path: containerPath, tabIndex });
  }, []);

  // commit a doc transform through history (single source of truth for edits).
  const commit = useCallback((fn) => {
    setHistory((h) => {
      if (!h) return h;
      const next = fn(h.present);
      if (next === h.present) return h;
      return pushHistory(h, next);
    });
  }, []);

  // Load applications.
  useEffect(() => {
    if (initialFields) return;
    fetch('/api/applications', { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => setApplications(data.applications || []))
      .catch(() => setLoadError('Не удалось загрузить приложения.'));
  }, [initialFields]);

  // T-0665 (F1): load the process catalog for the process picker — the SAME
  // real tenant data FormBuilder.jsx already uses (/api/process-catalog).
  // T-0671: a bindable process is one that is REALLY executable — either a
  // modeler definition someone deliberately PUBLISHED (`status==='published'`,
  // a draft's BPMN can still change or lose the step being bound — false
  // promise), OR a `source==='engine'` definition (deployed straight to
  // Flowable, e.g. the canonical telLinear — buildCatalogDefinitions only
  // ever adds an `engine` row when a REAL instance was observed, so it is
  // live by construction and has NO `process_definition` row to carry a
  // 'published' status at all; excluding it hid every engine-deployed
  // process from the binding picker). Anti-case (D-064): the picker's
  // contents are DATA (this tenant's real definitions) filtered by the
  // GENERIC source/status predicate, never a hardcoded slug list.
  const loadProcessCatalog = useCallback(() => {
    if (initialFields) return; // embedding/test mode — no network (mirrors applications effect)
    setLoadingCatalog(true);
    setCatalogError(null);
    fetch('/api/process-catalog', { headers: authHeaders() })
      .then((r) => {
        if (r.status === 403) return { definitions: [] }; // legitimately empty, not a failure
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        const defs = (data.definitions || []).filter(
          (d) => d.source === 'engine' || d.status === 'published',
        );
        setProcessCatalog(defs);
      })
      .catch((err) => {
        setCatalogError(String(err?.message || err));
        setProcessCatalog([]);
      })
      .finally(() => setLoadingCatalog(false));
  }, [initialFields]);

  useEffect(() => { loadProcessCatalog(); }, [loadProcessCatalog]);

  // T-0669: load this tenant's real process↔application bindings (T-0681's
  // GET /api/process-app-bindings — reused, not reinvented) so the "Приложение"
  // picker below can be filtered to only the applications actually bound to the
  // chosen process. `403`/graceful-empty → `[]` (a real "nothing bound yet"
  // answer, not a failure). A genuine fetch failure leaves `processAppBindings`
  // at `null` — the picker then falls back to the unfiltered pre-T-0669 list
  // (fail-open on the UI hint only; the server's classifyLayoutSave gate is the
  // real fail-closed judge and is unchanged, ADR-T0665 §5).
  useEffect(() => {
    if (initialFields) return; // embedding/test mode — no network (mirrors applications effect)
    fetch('/api/process-app-bindings', { headers: authHeaders() })
      .then((r) => {
        if (r.status === 403) return { bindings: [] };
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => setProcessAppBindings(data.bindings || []))
      .catch(() => setProcessAppBindings(null));
  }, [initialFields]);

  // T-0665 (F1): best-effort userTask id/name suggestions for the chosen
  // process, parsed from its real bpmnXml (fetchProcessDef — the same call
  // the BPMN process editor uses). Failure/absence → empty list; the step-key
  // field stays free text either way (ADR §3.1).
  useEffect(() => {
    if (!selectedProcessKey) { setBpmnUserTasks([]); return; }
    let cancelled = false;
    fetchProcessDef(selectedProcessKey)
      .then((def) => {
        if (cancelled || !def) return;
        setBpmnUserTasks(extractUserTasks(def.bpmnXml));
      })
      .catch(() => { if (!cancelled) setBpmnUserTasks([]); });
    return () => { cancelled = true; };
  }, [selectedProcessKey]);

  // T-0665 (F3): when a process+step is chosen, load the EXISTING binding (if
  // any) for that (processKey, stepKey) pair. If it carries a `layout`, that
  // layout — NOT a freshly rebuilt document — becomes the designer's document,
  // so reopening the designer for an already-bound step shows what was really
  // saved (LIVE_PROOF T-0656 P0: reopening used to always discard the saved
  // layout and rebuild a flat one from the field-set schema). If the binding
  // has no layout (legacy) or does not exist (404), this is a no-op — the
  // existing schema-driven build effect below runs exactly as before.
  const skipNextSchemaRebuildRef = useRef(false);
  useEffect(() => {
    if (initialFields) return; // embedding/test mode — no network
    if (!selectedProcessKey || !stepKey.trim()) return;
    setLoadingExistingBinding(true);
    setExistingBindingError(null);
    fetch(
      `/api/forms/binding?processKey=${encodeURIComponent(selectedProcessKey)}&stepKey=${encodeURIComponent(stepKey.trim())}`,
      { headers: authHeaders() },
    )
      .then((r) => {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!data) return; // no binding yet — schema-driven build proceeds normally
        if (Array.isArray(data.fields)) setFields(data.fields);
        if (data.layout && typeof data.layout === 'object' && data.layout.root) {
          skipNextSchemaRebuildRef.current = true;
          setHistory(initHistory(data.layout));
          savedDocRef.current = data.layout;
          setSelectedKeys(new Set());
        }
        // legacy binding (fields but no layout) — fall through to the
        // schema-driven build effect below, unchanged behavior (NF3).
      })
      .catch((err) => setExistingBindingError(String(err?.message || err)))
      .finally(() => setLoadingExistingBinding(false));
  }, [initialFields, selectedProcessKey, stepKey]);

  // Load registry defs for the chosen app.
  useEffect(() => {
    if (!selectedAppId) { setRegistryDefs(null); return; }
    fetch(`/api/registry-defs?application_id=${encodeURIComponent(selectedAppId)}`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => setRegistryDefs(data.registry_defs || []))
      .catch(() => setLoadError('Не удалось загрузить наборы полей.'));
  }, [selectedAppId]);

  // Derive live schema + default document when the registry def changes.
  // T-0665 (F3): skipped ONCE right after an existing layout was loaded above
  // (skipNextSchemaRebuildRef) — otherwise picking the SAME app/def that the
  // loaded layout was built from would immediately overwrite it with a fresh
  // flat rebuild, defeating the whole point of loading the saved layout.
  useEffect(() => {
    if (!selectedDefId || !registryDefs) return;
    if (skipNextSchemaRebuildRef.current) { skipNextSchemaRebuildRef.current = false; return; }
    const def = registryDefs.find((d) => d.id === selectedDefId);
    if (!def) return;
    const parsed = parseRecordSchema(def.record_schema);
    setFields(parsed);
    const freshDoc = buildDefaultDocument({ applicationId: selectedAppId, registryDefId: selectedDefId }, parsed, { withIds: true });
    setHistory(initHistory(freshDoc));
    savedDocRef.current = freshDoc;
    setSelectedKeys(new Set());
  }, [selectedDefId, registryDefs, selectedAppId]);

  // T-0669: application ids validly bound to the SELECTED process, per the
  // real process_app_binding table (T-0681's GET /api/process-app-bindings) —
  // the SAME resolution classifyLayoutSave's resolveLiveRecordSchema runs on
  // save (process_key → application_id, src/db/live-form-schema.ts). `null`
  // = "no process picked yet" OR "bindings not loaded" — both mean "do not
  // filter" (the picker falls back to the unfiltered pre-T-0669 behavior).
  const boundAppIdsForProcess = useMemo(() => {
    if (!selectedProcessKey || !processAppBindings) return null;
    const ids = new Set(
      processAppBindings
        .filter((b) => b && b.process_key === selectedProcessKey && typeof b.application_id === 'string')
        .map((b) => b.application_id),
    );
    return ids;
  }, [selectedProcessKey, processAppBindings]);

  // T-0669: once bindings are known for the chosen process, an already-picked
  // application that is NOT among them is a stale/incompatible selection (the
  // process changed under it, or it was picked before bindings loaded) — clear
  // it rather than silently letting the author save toward a guaranteed 409.
  useEffect(() => {
    if (!boundAppIdsForProcess) return;
    if (selectedAppId && !boundAppIdsForProcess.has(selectedAppId)) {
      setSelectedAppId('');
      setSelectedDefId('');
    }
  }, [boundAppIdsForProcess, selectedAppId]);

  // T-0706: the SINGLE binding row for the selected (process, app) pair — the
  // natural key `UNIQUE (tenant_id, process_key, application_id)` (migration
  // 075) guarantees at most one. `null` = pair not (yet) known (bindings still
  // loading, or no process/app picked, or genuinely no binding for this pair —
  // T-0669's own filter/hint already covers that last case upstream).
  const selectedBinding = useMemo(() => {
    if (!selectedProcessKey || !selectedAppId || !processAppBindings) return null;
    return (
      processAppBindings.find(
        (b) => b && b.process_key === selectedProcessKey && b.application_id === selectedAppId,
      ) || null
    );
  }, [selectedProcessKey, selectedAppId, processAppBindings]);

  // T-0706: same resolution src/db/live-form-schema.ts's resolveLiveRecordSchema
  // runs server-side (WITHOUT reading the env-derived default — the client
  // cannot see CHOROS_DEFAULT_STEP_RESULT_SLUG; §3.2/AC-2 handles that gap
  // honestly instead of guessing it here). Non-empty only when the binding
  // itself fixes a slug.
  const boundRegistrySlug = useMemo(() => {
    const slug = selectedBinding?.target_registry_slug;
    return typeof slug === 'string' && slug.trim() !== '' ? slug.trim() : null;
  }, [selectedBinding]);

  // T-0706: the registry_def (among the currently loaded registryDefs for the
  // selected app) whose slug matches the binding's fixed target_registry_slug.
  // `undefined` = not applicable (no fixed slug / registryDefs not loaded yet)
  // vs `null` = a fixed slug exists but NO registryDefs.slug matches it (data
  // desync — AC-6) vs an object = the resolved match (AC-1).
  const boundRegistryDef = useMemo(() => {
    if (!boundRegistrySlug || !registryDefs) return undefined;
    return registryDefs.find((d) => d && d.slug === boundRegistrySlug) || null;
  }, [boundRegistrySlug, registryDefs]);

  // T-0706 (AC-1): once the binding's fixed registry resolves against the
  // loaded registryDefs, auto-select it — the author should not have to click
  // the one legitimate option by hand. Mirrors the boundAppIdsForProcess-reset
  // effect's spirit (T-0669): the machine's own resolved fact drives the UI
  // state, not a manual pick.
  useEffect(() => {
    if (boundRegistryDef && selectedDefId !== boundRegistryDef.id) {
      setSelectedDefId(boundRegistryDef.id);
    }
  }, [boundRegistryDef, selectedDefId]);

  const rootChildren = useMemo(() => (doc ? childrenOf(doc.root) : []), [doc]);

  const validation = useMemo(
    () => (doc ? validateDocument(doc, fields) : { ok: true, errors: [], brokenKeys: [] }),
    [doc, fields],
  );

  const usedKeys = useMemo(() => {
    const set = new Set();
    if (doc) {
      const walk = (n) => {
        if (n && n.fieldKey) set.add(n.fieldKey);
        childrenOf(n).forEach(walk);
      };
      walk(doc.root);
    }
    return set;
  }, [doc]);

  // T-0533: isDirty against last-saved snapshot. With history, undo-to-baseline
  // restores the saved doc → stringify equality → isDirty=false (design §5.4).
  const isDirty = useMemo(() => {
    if (!doc || !savedDocRef.current) return false;
    return JSON.stringify(doc) !== JSON.stringify(savedDocRef.current);
  }, [doc, saveGen]); // eslint-disable-line react-hooks/exhaustive-deps

  const guard = useDirtyGuard(isDirty);

  // --- selection ---
  const selectNode = useCallback((key, e) => {
    setSelectedKeys((prev) => {
      if (e && (e.metaKey || e.ctrlKey)) {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      }
      if (e && e.shiftKey) {
        const next = new Set(prev);
        next.add(key);
        return next;
      }
      return new Set([key]);
    });
  }, []);

  // --- editing ops (all through history.commit) ---
  const addPaletteBlock = useCallback((widgetId) => {
    const descriptor = getWidget(widgetId);
    if (!descriptor || descriptor.data === true) return; // data blocks come from a field drag
    commit((d) => insertNode(d, [], defaultNodeForWidget(widgetId)));
  }, [commit]);

  const addFieldBlock = useCallback((fieldKey) => {
    const field = fields.find((f) => f.key === fieldKey);
    if (!field) return;
    commit((d) => insertNode(d, [], nodeForField(field, { withId: true })));
  }, [commit, fields]);

  const removeAt = useCallback((containerPath, index, tabIndex) => {
    commit((d) => removeNode(d, containerPath, index, tabIndex));
    setSelectedKeys(new Set());
  }, [commit]);

  const duplicateAt = useCallback((containerPath, index, tabIndex) => {
    commit((d) => {
      const container = nodeAtPath(d, containerPath);
      if (!container) return d;
      const kids = container.type === 'tabs'
        ? (container.tabs?.[tabIndex]?.children || [])
        : (container.children || []);
      const orig = kids[index];
      if (!orig) return d;
      const copy = JSON.parse(JSON.stringify(orig));
      if (copy && typeof copy === 'object' && copy.id) delete copy.id; // editor-local id, not a binding
      return insertNode(d, containerPath, copy, index + 1, tabIndex);
    });
  }, [commit]);

  const patchSelected = useCallback((patch) => {
    // single-select patch: resolve the selected path-key back to (container,index,tab).
    if (selectedKeys.size !== 1) return;
    const key = Array.from(selectedKeys)[0];
    const target = resolveKey(doc, key);
    if (!target) return;
    commit((d) => updateNode(d, target.containerPath, target.index, patch, target.tabIndex));
  }, [commit, selectedKeys, doc]);

  // T-0656: children array at a container path (tab-aware) — for announcements.
  const childrenAt = useCallback((d, containerPath, tabIndex) => {
    const container = nodeAtPath(d, containerPath);
    if (!container) return [];
    return container.type === 'tabs'
      ? (container.tabs?.[tabIndex]?.children || [])
      : (container.children || []);
  }, []);

  // T-0656: announce a reorder in the live region (human sentence, not a path).
  const announceReorder = useCallback((d, containerPath, newIndex, tabIndex) => {
    const container = nodeAtPath(d, containerPath);
    const kids = childrenAt(d, containerPath, tabIndex);
    const moved = kids[newIndex];
    if (!moved) return;
    const containerLabel = containerPath.length === 0
      ? '' // root → announceMove falls back to "в форме"
      : (container?.label || container?.title || (getWidget(container?.type)?.label ?? ''));
    setAnnouncement(announceMove({
      label: moved.label || moved.title || moved.fieldKey || (getWidget(moved.type)?.label ?? moved.type),
      containerLabel,
      position: newIndex + 1,
      total: kids.length,
    }));
  }, [childrenAt]);

  // --- drop dispatch (nested, path-aware) ---
  const handleDrop = useCallback((dropTarget, e) => {
    const data = readDrag(e);
    setHover(null);
    if (!data) return;
    const { containerPath, tabIndex, insertAt } = dropTarget;
    if (data.kind === 'reorder') {
      const fromContainer = data.fromContainer || [];
      const fromTab = data.fromTab === null ? undefined : data.fromTab;
      const sameContainer = JSON.stringify(fromContainer) === JSON.stringify(containerPath) && (fromTab ?? null) === (tabIndex ?? null);
      if (sameContainer) {
        commit((d) => {
          const next = reorderNode(d, containerPath, data.fromIndex, insertAt ?? data.fromIndex, tabIndex);
          announceReorder(next, containerPath, Math.min(insertAt ?? data.fromIndex, Math.max(0, childrenAt(next, containerPath, tabIndex).length - 1)), tabIndex);
          return next;
        });
      } else {
        const fromPath = fromTab === undefined ? [...fromContainer, data.fromIndex] : [...fromContainer, { tab: fromTab, index: data.fromIndex }];
        const toPath = tabIndex === undefined ? [...containerPath, insertAt ?? 0] : [...containerPath, { tab: tabIndex, index: insertAt ?? 0 }];
        commit((d) => {
          const next = moveNode(d, fromPath, toPath, fromTab, tabIndex);
          announceReorder(next, containerPath, Math.min(insertAt ?? 0, Math.max(0, childrenAt(next, containerPath, tabIndex).length - 1)), tabIndex);
          return next;
        });
      }
    } else if (data.kind === 'field') {
      const field = fields.find((f) => f.key === data.fieldKey);
      if (field) commit((d) => insertNode(d, containerPath, nodeForField(field, { withId: true }), insertAt, tabIndex));
    } else if (data.kind === 'palette') {
      const descriptor = getWidget(data.widgetId);
      if (descriptor && descriptor.data !== true) {
        commit((d) => insertNode(d, containerPath, defaultNodeForWidget(data.widgetId), insertAt, tabIndex));
      }
    }
    setSelectedKeys(new Set());
  }, [commit, fields, announceReorder]);

  // root-level drop (drop onto canvas background → append at root).
  const handleRootDrop = useCallback((e) => {
    handleDrop({ containerPath: [], insertAt: rootChildren.length }, e);
  }, [handleDrop, rootChildren.length]);

  // T-0529/T-0656: keyboard-drag fallback — reorder via arrow keys / ▲▼ buttons.
  const moveNodeUp = useCallback((containerPath, index, tabIndex) => {
    if (index <= 0) return;
    commit((d) => {
      const next = reorderNode(d, containerPath, index, index - 1, tabIndex);
      announceReorder(next, containerPath, index - 1, tabIndex);
      return next;
    });
  }, [commit, announceReorder]);

  const moveNodeDown = useCallback((containerPath, index, tabIndex) => {
    commit((d) => {
      const next = reorderNode(d, containerPath, index, index + 1, tabIndex);
      // reorderNode clamps toIndex; recompute the actual landing index.
      const landed = Math.min(index + 1, Math.max(0, childrenAt(next, containerPath, tabIndex).length - 1));
      announceReorder(next, containerPath, landed, tabIndex);
      return next;
    });
  }, [commit, announceReorder, childrenAt]);

  // T-0656: keyboard cut/paste over the SAME ops (removeNode / insertNode).
  // Cut = detach the single-selected node into clipboardRef; Paste = insert the
  // clipboard node after the current selection (or at root end if nothing selected).
  const cutSelected = useCallback(() => {
    if (selectedKeys.size !== 1) return;
    const key = Array.from(selectedKeys)[0];
    const target = resolveKey(doc, key);
    if (!target) return;
    clipboardRef.current = cloneForClipboard(target.node);
    setAnnouncement(announceCut(target.node.label || target.node.title || target.node.fieldKey || getWidget(target.node.type)?.label));
    commit((d) => removeNode(d, target.containerPath, target.index, target.tabIndex));
    setSelectedKeys(new Set());
  }, [selectedKeys, doc, commit]);

  const pasteClipboard = useCallback(() => {
    const node = clipboardRef.current;
    if (!node) return;
    const copy = cloneForClipboard(node); // fresh copy so repeated paste works
    if (selectedKeys.size === 1) {
      const target = resolveKey(doc, Array.from(selectedKeys)[0]);
      if (target) {
        commit((d) => insertNode(d, target.containerPath, copy, target.index + 1, target.tabIndex));
        setAnnouncement(announcePaste(copy.label || copy.title || copy.fieldKey || getWidget(copy.type)?.label));
        return;
      }
    }
    commit((d) => insertNode(d, [], copy));
    setAnnouncement(announcePaste(copy.label || copy.title || copy.fieldKey || getWidget(copy.type)?.label));
  }, [selectedKeys, doc, commit]);

  // --- undo/redo ---
  const doUndo = useCallback(() => setHistory((h) => undoHistory(h) || h), []);
  const doRedo = useCallback(() => setHistory((h) => redoHistory(h) || h), []);

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const z = mod && e.key.toLowerCase() === 'z';
      const y = mod && e.key.toLowerCase() === 'y';
      const x = mod && e.key.toLowerCase() === 'x';
      const v = mod && e.key.toLowerCase() === 'v';
      // Don't hijack cut/paste while the user is editing an input/textarea.
      const inField = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '');
      if (z && e.shiftKey) { e.preventDefault(); doRedo(); }
      else if (z) { e.preventDefault(); doUndo(); }
      else if (y) { e.preventDefault(); doRedo(); }
      else if (x && !inField && selectedKeys.size === 1) { e.preventDefault(); cutSelected(); }
      else if (v && !inField && clipboardRef.current) { e.preventDefault(); pasteClipboard(); }
      else if (e.key === 'Escape' && isFullscreen) { setIsFullscreen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doUndo, doRedo, cutSelected, pasteClipboard, selectedKeys.size, isFullscreen]);

  // T-0656: autoscroll the canvas when a drag hovers near its top/bottom edge.
  // Reduced-motion (accessibility): skip the continuous rAF loop (that IS the
  // "motion") and do a single discrete nudge per dragover — the off-screen drop
  // target stays reachable without a continuously animated scroll.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const reduced = prefersReducedMotion();
    let raf = null;
    let delta = 0;
    const step = () => {
      if (delta !== 0) {
        el.scrollTop += delta;
        raf = requestAnimationFrame(step);
      } else {
        raf = null;
      }
    };
    const onDragOver = (e) => {
      delta = computeAutoscrollDelta(el.getBoundingClientRect(), e.clientY);
      if (delta === 0) return;
      if (reduced) {
        // discrete single nudge, no continuous loop
        el.scrollTop += delta;
        return;
      }
      if (raf === null) raf = requestAnimationFrame(step);
    };
    const stop = () => { delta = 0; if (raf !== null) { cancelAnimationFrame(raf); raf = null; } };
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', stop);
    el.addEventListener('drop', stop);
    el.addEventListener('dragend', stop);
    return () => {
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', stop);
      el.removeEventListener('drop', stop);
      el.removeEventListener('dragend', stop);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [doc]);

  // --- render ---
  if (loadError) return <ErrorState message={loadError} />;
  if (!initialFields && applications === null) return <LoadingState label="Загрузка приложений…" />;

  const groups = byPaletteGroup();
  // single-selected node (for the inspector).
  const selectedResolved = selectedKeys.size === 1 ? resolveKey(doc, Array.from(selectedKeys)[0]) : null;
  const selectedNode = selectedResolved ? selectedResolved.node : null;
  const selectedSchemaField = selectedNode && selectedNode.fieldKey ? fields.find((f) => f.key === selectedNode.fieldKey) : null;

  return (
    <div
      className={`chs-form-designer${isFullscreen ? ' chs-form-designer--fullscreen' : ''}`}
      style={{ display: 'grid', gridTemplateColumns: '240px 1fr 380px', gap: 'var(--chs-space-4)' }}
    >
      {/* ---- Palette + source picker ---- */}
      <aside className="chs-designer-palette">
        {/* T-0665 (F1): process+step binding picker — WITHOUT this, saving always
            fell back to the hardcoded process_key='record' (no such process on
            any tenant) → 409 every time (LIVE_PROOF T-0656 P0). The process
            list comes from /api/process-catalog (this tenant's real
            executable definitions — published modeler defs OR live
            source==='engine' defs, T-0671, D-064 anti-case) — the step stays
            free text (mirrors FormBuilder.jsx's existing pattern), with real
            userTask id/name suggestions parsed best-effort from the chosen
            process's BPMN. */}
        {!initialFields && (
          <section style={{ marginBottom: 'var(--chs-space-4)', paddingBottom: 'var(--chs-space-4)', borderBottom: '1px solid var(--chs-color-border)' }}>
            <h4 style={{ marginTop: 0 }}>Привязка</h4>
            <label className="chs-label">Процесс</label>
            <Select
              value={selectedProcessKey}
              onChange={(e) => { setSelectedProcessKey(e.target.value); setStepKey(''); setSaveState({ status: 'idle' }); }}
              options={[
                { value: '', label: '— выберите —' },
                ...(processCatalog || []).map((d) => ({ value: d.process_key, label: d.name || d.process_key })),
              ]}
            />
            {loadingCatalog && (
              <span style={{ display: 'block', marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                Загрузка процессов…
              </span>
            )}
            {catalogError && (
              <span style={{ display: 'block', marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
                Не удалось загрузить список процессов.{' '}
                <button
                  type="button"
                  onClick={loadProcessCatalog}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--chs-color-accent)', cursor: 'pointer', fontSize: 'inherit', textDecoration: 'underline' }}
                >
                  Повторить
                </button>
              </span>
            )}
            {!loadingCatalog && !catalogError && processCatalog && processCatalog.length === 0 && (
              <span style={{ display: 'block', marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                Нет опубликованных или запущенных процессов в этом тенанте.
              </span>
            )}

            <label className="chs-label" style={{ marginTop: 'var(--chs-space-3)' }}>Шаг процесса</label>
            <input
              className="chs-input"
              type="text"
              list="chs-form-designer-user-tasks"
              value={stepKey}
              onChange={(e) => { setStepKey(e.target.value); setSaveState({ status: 'idle' }); }}
              placeholder="Например, Проверка заявки"
              style={{ width: '100%' }}
              disabled={!selectedProcessKey}
            />
            {bpmnUserTasks.length > 0 && (
              <datalist id="chs-form-designer-user-tasks">
                {/* T-0665-e2e (P0 fix, #4 step-resolve): the datalist option's
                    VALUE is what fills the input on selection — it must be
                    t.name (the BPMN userTask's human-readable `name`
                    attribute), NOT t.id (the technical node id, e.g.
                    "Activity_0dsh0ls"). LIVE_PROOF T-0665-e2e found the
                    picker previously suggested t.id as the fillable value,
                    so a form saved via this picker's suggestion was keyed
                    on a value that NEVER matches a real inbox task's
                    item.step — src/http/process-start.ts's
                    `step: firstActiveTask.name` (T-0575 BUG-015) proves the
                    live engine surfaces the userTask's NAME, not its id, as
                    the inbox step label GET /api/forms/binding is looked up
                    by. Using the same string as both the visible label and
                    the fillable value keeps the picker's suggestion and the
                    real lookup key identical by construction. */}
                {bpmnUserTasks.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
              </datalist>
            )}
            <span style={{ display: 'block', marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
              Совпадает со значением поля «Шаг» в карточке задачи инбокса
              {bpmnUserTasks.length > 0 ? ' — подсказки из шагов процесса ниже' : ''}
            </span>
            {loadingExistingBinding && (
              <span style={{ display: 'block', marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                Загрузка существующей раскладки…
              </span>
            )}
            {existingBindingError && (
              <span style={{ display: 'block', marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
                Не удалось проверить существующую привязку: {existingBindingError}
              </span>
            )}
          </section>
        )}

        {!initialFields && (
          <>
            {/* T-0669: filter to applications actually bound to the chosen process
                (boundAppIdsForProcess, derived from GET /api/process-app-bindings —
                the SAME table the server's save-time gate resolves against). Without
                a process picked, or before bindings load, the list is unfiltered
                (pre-T-0669 behavior) — nothing to compare against yet. */}
            {selectedProcessKey && boundAppIdsForProcess && boundAppIdsForProcess.size === 0 ? (
              <p role="status" style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-xs)', marginTop: 'var(--chs-space-2)' }}>
                {PROCESS_NOT_BOUND_HINT}
              </p>
            ) : (
              <>
                <label className="chs-label">Приложение</label>
                <Select
                  value={selectedAppId}
                  onChange={(e) => { setSelectedAppId(e.target.value); setSelectedDefId(''); }}
                  options={[
                    { value: '', label: '— выберите —' },
                    ...(applications || [])
                      .filter((a) => !boundAppIdsForProcess || boundAppIdsForProcess.has(a.id))
                      .map((a) => ({ value: a.id, label: a.display_name || a.slug || a.id })),
                  ]}
                />
              </>
            )}
            {/* T-0706: the "Набор полей" picker follows the SAME single-source-
                of-truth discipline as the T-0669 app picker above — the real
                gate is src/db/live-form-schema.ts's resolveLiveRecordSchema,
                which resolves ONE registry off the binding's
                target_registry_slug (natural key guarantees at most one
                binding per process+app, migrations 075/119).

                Outer `registryDefs &&` guard restored (P0 fix-forward): before
                an application is picked, registryDefs is still its useState(null)
                initial value, and every branch below reads registryDefs.map —
                without this guard the FINAL else branch (no fixed slug / not
                yet resolved) rendered unconditionally and crashed the whole
                /forms mount with "Cannot read properties of null (reading
                'map')" (live-proof RED, T-0706 merge). Nothing to pick from
                yet, so nothing renders until an app is selected. */}
            {registryDefs && (
              boundRegistryDef ? (
                // AC-1: the binding fixes a slug AND it resolved against a real
                // registry_def — no open choice, show the fact (selectedDefId
                // is auto-set by the effect above).
                <p role="status" style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-xs)', marginTop: 'var(--chs-space-3)' }}>
                  Набор полей задан привязкой процесса: «{boundRegistryDef.display_name || boundRegistryDef.slug || boundRegistryDef.id}».
                </p>
              ) : boundRegistryDef === null ? (
                // AC-6: the binding fixes a slug but NO registry_def of this
                // application matches it (data desync) — say so honestly
                // instead of silently narrowing to nothing or picking a guess.
                // The picker stays open (fail-open on the UI hint only, same
                // posture as T-0669 §3.1's bindings-fetch-error fallback) so
                // authoring is not blocked by a data problem outside this task.
                <>
                  <p role="status" style={{ color: 'var(--chs-color-warning)', fontSize: 'var(--chs-text-xs)', marginTop: 'var(--chs-space-3)' }}>
                    {REGISTRY_SLUG_NOT_FOUND_PREFIX}{boundRegistrySlug}{REGISTRY_SLUG_NOT_FOUND_SUFFIX}
                  </p>
                  <label className="chs-label">Набор полей</label>
                  <Select
                    value={selectedDefId}
                    onChange={(e) => setSelectedDefId(e.target.value)}
                    options={[{ value: '', label: '— выберите —' }, ...registryDefs.map((d) => ({ value: d.id, label: d.display_name || d.slug || d.id }))]}
                  />
                </>
              ) : (
                <>
                  <label className="chs-label" style={{ marginTop: 'var(--chs-space-3)' }}>Набор полей</label>
                  <Select
                    value={selectedDefId}
                    onChange={(e) => setSelectedDefId(e.target.value)}
                    options={[{ value: '', label: '— выберите —' }, ...registryDefs.map((d) => ({ value: d.id, label: d.display_name || d.slug || d.id }))]}
                  />
                  {/* AC-2: binding is known (not still loading) but does not fix
                      a slug (NULL → server-side default fallback, invisible to
                      the client — §3.2/out-of-scope: we do not guess the env
                      default here), AND the app genuinely has >1 registry to
                      disambiguate between (AC-4: a single-registry app has no
                      ambiguity, no warning). */}
                  {selectedBinding && !boundRegistrySlug && registryDefs.length > 1 && (
                    <p role="status" style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-xs)', marginTop: 'var(--chs-space-2)' }}>
                      {REGISTRY_NOT_FIXED_HINT}
                    </p>
                  )}
                </>
              )
            )}
          </>
        )}

        {doc && (
          <>
            <h4 style={{ marginTop: 'var(--chs-space-4)' }}>Поля</h4>
            {fields.length === 0 ? (
              <p style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>Нет полей.</p>
            ) : fields.map((f) => (
              <FieldChip key={f.key} field={f} used={usedKeys.has(f.key)} onAdd={addFieldBlock} />
            ))}

            {Object.entries(groups).map(([group, entries]) => {
              const blocks = entries.filter((d) => d.data !== true);
              if (blocks.length === 0) return null;
              return (
                <div key={group}>
                  <h4 style={{ marginTop: 'var(--chs-space-4)' }}>{group}</h4>
                  {blocks.map((d) => (
                    <PaletteBlock key={d.id} descriptor={d} onAdd={addPaletteBlock} />
                  ))}
                </div>
              );
            })}
          </>
        )}
      </aside>

      {/* ---- Canvas (nested tree) ---- */}
      <main
        ref={canvasRef}
        className="chs-designer-canvas"
        role="tree"
        aria-label="Дерево конструктора"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleRootDrop}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setHover(null); }}
        style={{ minHeight: 200, padding: 'var(--chs-space-3)', border: '1px dashed var(--chs-color-border)', borderRadius: 'var(--chs-radius-md)' }}
      >
        {/* T-0656: canvas action bar — fullscreen toggle (works; not a stub).
            UX-2 fix: fullscreen expands the WHOLE workspace (palette + canvas +
            inspector), not just the canvas — so a field can still be dragged in
            and properties still edited. The on-screen hint is now TRUE. */}
        <div className="chs-designer-canvas__bar">
          <Button
            variant="ghost"
            onClick={() => setIsFullscreen((v) => !v)}
            title={isFullscreen ? 'Выйти из полноэкранного режима (Esc)' : 'Развернуть конструктор на весь экран'}
            aria-pressed={isFullscreen}
            aria-label={isFullscreen ? 'Свернуть конструктор' : 'Развернуть конструктор на весь экран'}
          >
            {isFullscreen ? '🗗 Свернуть' : '⛶ На весь экран'}
          </Button>
          {isFullscreen && (
            <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
              Палитра слева, свойства справа. Esc — выйти.
            </span>
          )}
        </div>

        {/* T-0656: live-region for move/cut/paste announcements (screen readers). */}
        <div aria-live="polite" className="chs-sr-only" data-testid="canvas-live-region">{announcement}</div>

        {!doc ? (
          <EmptyState title="Выберите набор полей" description="Слева выберите приложение и набор полей — форма соберётся из них." />
        ) : rootChildren.length === 0 ? (
          <EmptyDropZone containerPath={[]} onDrop={handleDrop} onHoverContainer={onHoverContainer} hover={hover} />
        ) : (
          <>
            <DropIndicator containerPath={[]} insertAt={0} onDrop={handleDrop} onHoverContainer={onHoverContainer} hover={hover} />
            {rootChildren.map((node, i) => (
              <React.Fragment key={node.id || `${node.type}-${i}`}>
                <CanvasNode
                  node={node} containerPath={[]} index={i}
                  siblingCount={rootChildren.length}
                  selectedKeys={selectedKeys} onSelectNode={selectNode}
                  onRemove={removeAt} onDuplicate={duplicateAt} onDrop={handleDrop}
                  onMoveUp={moveNodeUp} onMoveDown={moveNodeDown}
                  onHoverContainer={onHoverContainer} hover={hover}
                  brokenKeys={validation.brokenKeys}
                />
                <DropIndicator containerPath={[]} insertAt={i + 1} onDrop={handleDrop} onHoverContainer={onHoverContainer} hover={hover} />
              </React.Fragment>
            ))}
          </>
        )}

        {!validation.ok && (
          <div className="chs-designer-errors" role="alert" style={{ marginTop: 'var(--chs-space-3)', color: 'var(--chs-color-danger)', fontSize: 'var(--chs-text-sm)' }}>
            <strong>Ошибки авторинга:</strong>
            <ul>{validation.errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
          </div>
        )}
      </main>

      {/* ---- Live preview (always-on) + Inspector + save ---- */}
      <aside className="chs-designer-inspector">
        <div className="chs-designer-toolbar" style={{ display: 'flex', gap: 'var(--chs-space-2)', marginBottom: 'var(--chs-space-3)' }}>
          <Button variant="ghost" disabled={!canUndo(history)} onClick={doUndo} title="Отменить (Ctrl+Z)" aria-label="Отменить">↶ Отменить</Button>
          <Button variant="ghost" disabled={!canRedo(history)} onClick={doRedo} title="Повторить (Ctrl+Y)" aria-label="Повторить">↷ Повторить</Button>
        </div>

        {doc && (
          <section className="chs-designer-preview" aria-label="Живое превью" style={{ marginBottom: 'var(--chs-space-4)', padding: 'var(--chs-space-3)', border: '1px solid var(--chs-color-border)', borderRadius: 'var(--chs-radius-md)', background: 'var(--chs-color-surface)' }}>
            <h4 style={{ marginTop: 0 }}>Превью</h4>
            <FormDocumentRenderer document={doc} fields={fields} theme="light" />
          </section>
        )}

        <h4>Свойства</h4>
        <Inspector
          node={selectedNode}
          schemaField={selectedSchemaField}
          multiCount={selectedKeys.size}
          onPatch={patchSelected}
        />
        {doc && (
          <>
            {isDirty && (
              <p style={{ color: 'var(--chs-color-warning)', fontSize: 'var(--chs-text-xs)', marginTop: 'var(--chs-space-2)' }}>
                Несохранённые изменения
              </p>
            )}
            {/* T-0665 (F1): a step MUST be chosen before saving — a save without
                one falls back to the dead 'record'/'record-form' pair (no
                process on any tenant has it) and always 409s. `doc.step` from
                initialDocument (e.g. AI-emitted / embedded) satisfies this too,
                so the picker is not forced on a caller that already supplied it. */}
            {!(selectedProcessKey && stepKey.trim()) && !doc?.step && (
              <p role="alert" style={{ color: 'var(--chs-color-danger)', fontSize: 'var(--chs-text-xs)', marginTop: 'var(--chs-space-2)' }}>
                Выберите процесс и шаг выше, чтобы сохранить форму.
              </p>
            )}
            {/* T-0669: defense-in-depth — even with the picker filtered (above),
                a race (bindings not loaded yet when the process was picked) could
                still leave an unbound process selected. Block save with the SAME
                honest text rather than let it hit the server's opaque 409. */}
            {selectedProcessKey && boundAppIdsForProcess && boundAppIdsForProcess.size === 0 && (
              <p role="alert" style={{ color: 'var(--chs-color-danger)', fontSize: 'var(--chs-text-xs)', marginTop: 'var(--chs-space-2)' }}>
                {PROCESS_NOT_BOUND_HINT}
              </p>
            )}
            {/* T-0706 (AC-3): defense-in-depth — even with §3.1's auto-select,
                a race (selectedDefId picked before boundRegistryDef resolved,
                or a stale selection surviving a binding change) could still
                leave a registry_def chosen that does NOT match the binding's
                fixed target_registry_slug. Block save with the SAME honest
                text rather than let it hit the server's opaque 409. */}
            {Boolean(boundRegistryDef && selectedDefId && selectedDefId !== boundRegistryDef.id) && (
              <p role="alert" style={{ color: 'var(--chs-color-danger)', fontSize: 'var(--chs-text-xs)', marginTop: 'var(--chs-space-2)' }}>
                Выбранный набор полей не совпадает с набором из привязки процесса: «{boundRegistryDef.display_name || boundRegistryDef.slug || boundRegistryDef.id}».
              </p>
            )}
            <Button
              variant="primary"
              disabled={
                !validation.ok || saveState.status === 'saving'
                || !(doc?.step || (selectedProcessKey && stepKey.trim()))
                || Boolean(selectedProcessKey && boundAppIdsForProcess && boundAppIdsForProcess.size === 0)
                || Boolean(boundRegistryDef && selectedDefId && selectedDefId !== boundRegistryDef.id)
              }
              loading={saveState.status === 'saving'}
              onClick={() => persistLayout(
                doc,
                { processKey: selectedProcessKey, step: stepKey.trim() },
                setSaveState, savedDocRef, setSaveGen,
                selectedAppId,
              )}
              style={{ marginTop: 'var(--chs-space-2)', width: '100%' }}
            >
              Сохранить раскладку
            </Button>
          </>
        )}
        {saveState.status === 'saved' && <p style={{ color: 'var(--chs-color-success)', fontSize: 'var(--chs-text-sm)' }}>Сохранено.</p>}
        {saveState.status === 'error' && <p style={{ color: 'var(--chs-color-danger)', fontSize: 'var(--chs-text-sm)' }}>{saveState.message || 'Ошибка сохранения.'}</p>}
      </aside>

      {/* T-0533: route-guard dialog */}
      <ConfirmDialog
        open={guard.blockerState === 'blocked'}
        title="Несохранённые правки"
        message={
          <>
            <p>В редакторе форм есть несохранённые изменения.</p>
            <ConsequenceSummary
              who="Текущий сеанс редактирования формы"
              what="Все несохранённые правки будут потеряны"
              reversibility="Необратимо — восстановить из браузера невозможно"
            />
          </>
        }
        confirmLabel="Уйти без сохранения"
        cancelLabel="Остаться"
        tone="danger"
        onConfirm={guard.proceed}
        onClose={guard.reset}
      />
    </div>
  );
}

/**
 * Resolve a selection path-key back to { containerPath, index, tabIndex, node }.
 * The key is produced by pathKey(): "<cp>:<index>[#tab]". This walks the doc to
 * fetch the live node so the inspector edits the right place after history moves.
 */
function resolveKey(doc, key) {
  if (!doc || typeof key !== 'string') return null;
  const hashAt = key.lastIndexOf('#');
  const tabIndex = hashAt >= 0 ? Number(key.slice(hashAt + 1)) : undefined;
  const core = hashAt >= 0 ? key.slice(0, hashAt) : key;
  const colon = core.lastIndexOf(':');
  if (colon < 0) return null;
  const cpStr = core.slice(0, colon);
  const index = Number(core.slice(colon + 1));
  const containerPath = cpStr === '' ? [] : cpStr.split('/').map((seg) => {
    const m = /^t(\d+)\.(\d+)$/.exec(seg);
    return m ? { tab: Number(m[1]), index: Number(m[2]) } : Number(seg);
  });
  const container = nodeAtPath(doc, containerPath);
  if (!container) return null;
  const kids = container.type === 'tabs'
    ? (Array.isArray(container.tabs?.[tabIndex]?.children) ? container.tabs[tabIndex].children : [])
    : (Array.isArray(container.children) ? container.children : []);
  const node = kids[index];
  if (!node) return null;
  return { containerPath, index, tabIndex, node };
}

/**
 * Persist the form-document layout via POST /api/forms/binding.
 * T-0533: savedDocRef updated on success → isDirty resets; saveGen bump re-runs the memo.
 *
 * T-0665 (F1/F2): `step` ({processKey, step}) comes from the designer's own
 * process/step picker state — `doc.step` is used ONLY as a fallback for a
 * document that already carries one (e.g. an initialDocument supplied by an
 * embedding caller or an AI-emitted document), and 'record'/'record-form'
 * remain the last-resort default for the (now rare) case where neither is
 * set. Previously `doc.step` was NEVER populated by this component at all,
 * so every save silently hit that dead fallback (LIVE_PROOF T-0656 P0).
 *
 * T-0711 (P2, review T-0706 finding #37): `applicationId` is the designer's
 * `selectedAppId` — the SAME application the "Приложение" picker (T-0669)
 * resolved for `processKey`. A process can be bound to 2+ applications
 * (process_app_binding UNIQUE(tenant_id, process_key, application_id)); the
 * server's content gate (classifyLayoutSave → resolveLiveRecordSchema) used
 * to resolve the live schema by processKey ALONE and could silently validate
 * against a DIFFERENT binding than the one shown in this picker. Sent only
 * when non-empty (a design opened before an app is chosen, or a legacy
 * single-binding process, still saves — the server falls back to a
 * deterministic resolution, not an error).
 */
function persistLayout(doc, step, setSaveState, savedDocRef, setSaveGen, applicationId) {
  setSaveState({ status: 'saving' });
  const processKey = step?.processKey || doc.step?.processKey || 'record';
  const formKey = step?.step || doc.step?.step || 'record-form';
  const docWithStep = (step?.processKey && step?.step)
    ? { ...doc, step: { processKey: step.processKey, step: step.step } }
    : doc;
  const body = {
    process_key: processKey,
    form_key: formKey,
    layout: docWithStep,
    ...(applicationId ? { application_id: applicationId } : {}),
  };
  fetch('/api/forms/binding', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((r) => { if (!r.ok) throw new Error('save failed'); return r.json(); })
    .then(() => {
      if (savedDocRef) savedDocRef.current = docWithStep;
      if (setSaveGen) setSaveGen((g) => g + 1);
      setSaveState({ status: 'saved' });
    })
    .catch(() => setSaveState({ status: 'error', message: 'Не удалось сохранить.' }));
}

export default FormDesigner;
