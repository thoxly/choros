/* ============================================================================
   CHOROS — field-renderer.jsx  (T-0399 · D7-K)

   THE ONE UNIFIED FIELD RENDERER.

   Before this module the codebase had four independent type→control maps
   (spec §2): FormBuilder.jsx (config), screen-inbox.jsx (InboxTaskForm/FormField),
   screen-app-records.jsx (CreateRecordDrawer, via records-form.js) and the
   FormViewer.jsx/form-defs.js iframe path. Each invented its own dictionary; the
   inbox one silently dropped enum options and rendered a text input (the snapshot
   bug). This module is the single React renderer the schema-driven form screens
   call. It keys EVERY control off the binding-contract catalog
   (src/core/binding-contract-catalog.ts, PD-18) so there is one place that
   decides "this field → this control", and one place to extend when D7-6/7/8 add
   structural contracts (relation/collection/…).

   Inputs it understands — a "renderable field" (the shape both InboxTaskForm's
   BindingField and records-form's form-field descriptor reduce to):
     { key, label, required, type?, contract?, presentation?, options? }
   `type` is the legacy scalar FieldType ("string"/"text"/"number"/… or "select").
   `contract` is the explicit PD-18 contract kind (wins when present).

   What it renders:
     scalar  → text / textarea / number / checkbox / date  (per presentation)
     enum    → <select> (or radio)                          (options[] required)
     relation / collection / date-range / file (T-0579)     → dedicated structural
       components (RelationPickerField / CollectionField / DateRangeField /
       FileField) — each owns its own fetch/local state.
     money / matrix-lookup not-yet-authorable contracts      → honest "not yet
       authorable here" readout (degrades visibly rather than pretending a text
       box captures them)
     rollup / matrix-lookup (editable:false)                → read-only readout

   Per-step field MODE (T-0404 [D7-9]): each renderable field may carry a `mode`
   (read-only / required-to-advance / hidden) bound to the BPMN node via
   form_binding.fields. The renderer ENFORCES it: hidden → not rendered; read-only →
   rendered disabled; required-to-advance → marked required. This is DISTINCT from
   per-role visibility (server-side field-visibility.ts) — both apply. The mode is
   ALSO enforced server-side on submit (form-submit-validator.ts); the render here is
   the cosmetic-consistent half, not the authoritative boundary.

   Theming: --chs-* tokens + .chs-input/.chs-label only (gate G2/G6). No hardcoded
   colors. The control is theme-agnostic (works light/dark via tokens).
   ============================================================================ */

import React, { useState, useEffect } from 'react';
import { KitIcon, ActorChip } from '../components/components.jsx';
// Pure contract-resolution lives in a React-free sibling (field-contract.js) so
// the load-bearing logic is unit-testable without a React runtime (codebase
// convention — cf. records-form.js). Re-export it for callers/tests.
import { resolveFieldContract, resolveFieldMode } from './field-contract.js';
import { formatError, formatShortDate, formatShortDateTime } from '../lib/format.js';
// Auth headers — same helper every screen uses (mode-aware: dev X-Dev-User /
// keycloak Bearer). RelationPickerField needs it to attach auth to the
// tenant-scoped GET /api/records?registry_def_id= candidate fetch.
import { devHeaders, fetchWithAuthRetry } from '../app-shell/dev-auth.js';
import { downloadFile } from '../lib/authed-file.js';
// deriveRecordLabel — first non-empty string value in record.data (T-0447).
// Already in records-form.js (canonical); re-used here to avoid duplicating the
// label-derivation logic. Cross-boundary import is intentional: field-renderer is
// a web/src/forms module that depends on the records-form label helper.
import { deriveRecordLabel } from '../screens/records-form.js';

export { resolveFieldContract, resolveFieldMode };

// ---------------------------------------------------------------------------
// T-0512: PersonPicker — employee picker sourced from GET /api/org.
//
// Mirrors RelationPicker in screen-app-records.jsx: fetches the employee list
// once (on mount), renders a <select> of human employees (display name, value =
// employee id). Stores the employee id as a plain string (same as relation).
//
// Employee endpoint: GET /api/org returns { departments: [ { positions: [
//   { people: [{ id, name, type }] } ] } ] }. We flatten and filter type:"human".
// The endpoint is already used by bpmn-properties-panel.jsx, screen-agents.jsx,
// and the hire-employee form in screen-org.jsx.
//
// Honest states: loading / error (surface the failure, not an empty dropdown) /
// empty (no human employees in org) / populated (select).
// ---------------------------------------------------------------------------

/**
 * Fetch human employees from GET /api/org and flatten to [{id, name}].
 * Returns a promise that resolves to the employee list or throws on error.
 *
 * Exported (T-0608, пункт г): screen-record-detail.jsx reuses this exact
 * fetch to resolve a record's `created_by` (an employee SLUG — for a
 * Keycloak-registered human, slug === the KC user UUID) into a display name,
 * instead of rendering the raw slug/UUID. One source of truth for "slug → name
 * via /api/org" rather than a second parallel fetcher.
 *
 * P1 FIX (T-0649, UX study 2026-07-05 §2): this used to call bare
 * `fetch('/api/org')` with NO auth headers at all, on the mistaken assumption
 * that "the browser sends cookies automatically" in keycloak mode. Choros's
 * keycloak auth is Bearer-JWT-only (src/http/auth.ts `authenticate()` requires
 * an `Authorization` header and 401s BEFORE any identity resolution runs when
 * it's absent) — there is no cookie-based session. That made this the ONLY
 * fetch in this file with no auth headers (RelationPickerField/FileField below
 * both attach devHeaders()) and PersonPicker DETERMINISTICALLY 401'd on every
 * call in keycloak mode, even for a legitimate admin with a live session (the
 * live symptom: "GET /api/org → 401" while a POST record create in the same
 * moment succeeded — that POST went through a code path that DID attach
 * headers). fetchWithAuthRetry (dev-auth.js, T-0608) attaches the correct
 * mode-aware headers on every call AND additionally self-heals a genuinely
 * TRANSIENT 401 (an access token that expires mid-session) via one silent
 * refresh + one retry before falling back to a login redirect — so this same
 * fix also covers "no auto-retry on a transient 401" for the case where the
 * token really did expire between render and click.
 */
export async function fetchEmployees() {
  const res = await fetchWithAuthRetry('/api/org', { headers: devHeaders() });
  if (!res.ok) throw new Error(formatError(res.status));
  const data = await res.json();
  const employees = [];
  const departments = Array.isArray(data.departments) ? data.departments : [];
  for (const dept of departments) {
    const positions = Array.isArray(dept.positions) ? dept.positions : [];
    for (const pos of positions) {
      const people = Array.isArray(pos.people) ? pos.people : [];
      for (const p of people) {
        if (p && p.type === 'human' && p.id) {
          // T-0649: carry the position title additively — PersonPicker's search
          // matches "имя + должность" (UX study §2). Existing callers (e.g.
          // screen-record-detail.jsx's created_by resolver) only read .id/.name
          // and are unaffected by the extra field.
          //
          // T-0698: carry `deactivated` additively too — this is the batch map
          // screen-app-records.jsx's PersonCell reads (T-0673) to show a
          // deactivated-executor marker on record cells, mirroring the signal
          // ActorChip already renders elsewhere via T-0648's batchResolveActors.
          // Before this fix GET /api/org's `people[]` carried no deactivation
          // signal at all, so this line always dropped it — PersonCell's
          // `deactivated` prop was permanently false in production regardless
          // of the real employee.deactivated_at. Boolean(...) normalizes both
          // the DB-backed shape (always a real boolean, see src/db/org.ts) and
          // the dev-no-db ORG_SEED fallback shape (no `deactivated` key at all
          // → undefined → false, the correct "active" default).
          employees.push({
            id: p.id,
            name: p.name || p.id,
            position: pos.title || '',
            deactivated: Boolean(p.deactivated),
          });
        }
      }
    }
  }
  return employees;
}

/**
 * buildEmployeesById — the ONE canonical "fetchEmployees() list → lookup Map"
 * step (T-0698 B1/N1). Both record screens batch-load employees once per page
 * and then resolve person-typed values against a Map keyed by employee
 * id/slug; before this helper each screen hand-rolled its own Map with its
 * own value shape (screen-app-records kept whole entries,
 * screen-record-detail kept only the name STRING — which is exactly how the
 * `deactivated` signal got dropped a third time on the detail screen,
 * invisible to tests that copied the screen's Map-literal instead of calling
 * shared code). One exported function means the screens AND their e2e tests
 * all consume the SAME construction — a screen can no longer drift to a
 * narrower value shape without its tests exercising that exact drift.
 *
 * @param {Array<{id:string,name:string,position:string,deactivated:boolean}>} list
 *   the fetchEmployees() result ([] / non-array tolerated → empty Map).
 * @returns {Map<string, {id:string,name:string,position:string,deactivated:boolean}>}
 */
export function buildEmployeesById(list) {
  return new Map((Array.isArray(list) ? list : []).map((e) => [e.id, e]));
}

// ---------------------------------------------------------------------------
// T-0673/T-0728: PersonCell — cell/card renderer that resolves a person-type
// field's value (an employee id/slug) to a human-readable name via ActorChip.
//
// Canonical home (T-0728, N2 of T-0698's review): originally lived ONLY in
// screen-app-records.jsx (the record table). kanban-board.jsx's cards needed
// the IDENTICAL resolve-and-render step for person-type card fields and had
// none at all — records-form.js's formatCellValue returns the PERSON_CELL_ASYNC
// sentinel for a non-empty person value (mirrors RELATION_CELL_ASYNC/
// FILE_CELL_ASYNC), but kanban-board.jsx's cell loop only knew `typeof
// rendered === 'string' ? rendered : '—'` — so every person-typed sentinel
// (relation/file too, out of THIS task's scope) silently fell to "—", and the
// board never showed WHO a card's executor was. Moved here — the file that
// already owns fetchEmployees()/buildEmployeesById (T-0698's "ONE canonical"
// helper) — so the table AND the kanban board render a person value through
// this exact component instead of a second per-screen hand-rolled ActorChip
// wrapper. screen-app-records.jsx imports it from here (no local definition
// anymore) and re-exports it for backward-compat callers.
//
// NOT YET consolidated (out of THIS task's scope): screen-record-detail.jsx's
// PersonFieldValue is a near-identical SEPARATE implementation (same
// ActorChip contract, different prop name `authorNames` vs `employees`) —
// T-0698 B1 gave it the same deactivated-threading fix but did not merge it
// with PersonCell. A future cleanup could fold it into this one too.
//
// UNLIKE RelationCell/FileCell, resolution needs NO per-cell fetch: `employees`
// is a single Map<id, {id,name,deactivated}> BATCH-loaded ONCE per screen
// (screen-app-records.jsx's employeesById state / kanban-board.jsx's
// employeesById prop, T-0728) and passed down by the caller — a page/board of
// N records stays at ONE request total, never N+1.
//
// Honest fallback (D2): an id absent from the map (deleted/never-synced
// employee, or the map not loaded yet) renders the RAW SLUG via ActorChip's
// own `resolved:false` contract — never blank, never a fabricated name
// (anti-uuid-actor-render discipline: the id is still shown, just not as a
// bare unwrapped string).
// ---------------------------------------------------------------------------

/**
 * @param {string} personId  the employee id/slug stored as the field value.
 * @param {Map<string, {id:string,name:string,deactivated?:boolean}>} employees
 *   batch-resolved employee map (id/slug → display shape), loaded once by the caller.
 */
export function PersonCell({ personId, employees }) {
  const hit = employees instanceof Map ? employees.get(personId) : null;
  return (
    <ActorChip
      type="human"
      name={hit ? hit.name : personId}
      id={personId}
      deactivated={Boolean(hit && hit.deactivated)}
    />
  );
}

/**
 * PersonPicker — inline employee selector for a record form.
 * Renders a search box + a <select> of human employees from the org (filtered
 * by name OR position — T-0649, UX study §2 "поиск по имени, «имя +
 * должность»"); stores the employee id.
 *
 * Honest error state (T-0649 P1): a failed fetch shows the reason (not a mute
 * grey box) AND a «Повторить» button that re-runs the fetch — the original
 * live bug (GET /api/org 401 for a live-session admin) left the field
 * permanently dead with no way to recover short of a full page reload.
 *
 * @param {{ field, value, onChange, error, idPrefix, isRequired, readOnly, invalid }} props
 */
export function PersonPicker({ field, value, onChange, error, idPrefix = 'field', isRequired = false, readOnly = false }) {
  const id = `${idPrefix}-${field.key}`;
  const errorId = error ? `${id}-error` : undefined;
  const label = field.label || field.title || field.key;
  const invalid = Boolean(error);

  const [employees, setEmployees] = useState(null); // null=loading
  const [fetchError, setFetchError] = useState(null);
  const [filter, setFilter] = useState('');
  // T-0649: bump to re-trigger the fetch effect from the "Повторить" button
  // without duplicating the fetch logic in a second callback.
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFetchError(null);
    fetchEmployees()
      .then((list) => { if (!cancelled) setEmployees(list); })
      .catch((err) => { if (!cancelled) { setFetchError(String(err?.message || err)); setEmployees([]); } });
    return () => { cancelled = true; };
  }, [retryTick]);

  const handleRetry = () => {
    setEmployees(null); // back to the honest "Загрузка…" state while retrying
    setRetryTick((t) => t + 1);
  };

  const inputStyle = { display: 'block', width: '100%', boxSizing: 'border-box' };
  const inputClass = `chs-input${invalid ? ' chs-input--invalid' : ''}`;

  const labelNode = (
    <label className="chs-label" htmlFor={id}>
      {label}
      {isRequired && (
        <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
      )}
    </label>
  );
  // T-0529: role=alert + id for aria-describedby (WCAG 1.3.1 / 4.1.3)
  const errorNode = error ? (
    <span id={errorId} role="alert" style={{ display: 'block', marginTop: 'var(--chs-space-1)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
      {error}
    </span>
  ) : null;

  let control;
  if (fetchError) {
    control = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-2)', flexWrap: 'wrap' }}>
        <div
          className="chs-input"
          style={{ ...inputStyle, width: 'auto', flex: 1, color: 'var(--chs-color-danger)', fontSize: 'var(--chs-text-sm)' }}
          role="alert"
        >
          Не удалось загрузить список сотрудников: {fetchError}
        </div>
        <button
          type="button"
          className="chs-input"
          onClick={handleRetry}
          style={{ width: 'auto', cursor: 'pointer', color: 'var(--chs-color-accent)', background: 'none' }}
        >
          Повторить
        </button>
      </div>
    );
  } else if (employees === null) {
    control = (
      <div className="chs-input" style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontStyle: 'italic', fontSize: 'var(--chs-text-sm)' }} aria-live="polite">
        Загрузка…
      </div>
    );
  } else if (employees.length === 0) {
    control = (
      <div className="chs-input" style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
        В организации нет сотрудников
      </div>
    );
  } else {
    // T-0649: search filters by name OR position (case-insensitive substring).
    const filterLower = filter.trim().toLowerCase();
    const filtered = filterLower
      ? employees.filter((emp) => (
        emp.name.toLowerCase().includes(filterLower)
        || (emp.position || '').toLowerCase().includes(filterLower)
      ))
      : employees;

    control = (
      <>
        <input
          type="text"
          className="chs-input"
          placeholder="Поиск по имени или должности…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label={`Поиск: ${label}`}
          style={{ ...inputStyle, marginBottom: 'var(--chs-space-2)' }}
          disabled={readOnly || undefined}
          aria-disabled={readOnly || undefined}
        />
        <select
          id={id}
          className={inputClass}
          value={value ?? ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          aria-required={isRequired || undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={errorId}
          disabled={readOnly || undefined}
          aria-disabled={readOnly || undefined}
          style={inputStyle}
          size={Math.min(filtered.length + 1, 6)}
        >
          <option value="">— выберите сотрудника —</option>
          {filtered.map((emp) => (
            <option key={emp.id} value={emp.id}>
              {emp.position ? `${emp.name} — ${emp.position}` : emp.name}
            </option>
          ))}
        </select>
        {filtered.length === 0 && (
          <span style={{ display: 'block', marginTop: 'var(--chs-space-1)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
            Никого не найдено по «{filter}»
          </span>
        )}
      </>
    );
  }

  return (
    <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
      {labelNode}
      {control}
      {errorNode}
    </div>
  );
}

// ---------------------------------------------------------------------------
// T-0579: FileField — upload/download control for a `file` contract.
//
// The ONLY new structural component this task adds. Talks EXCLUSIVELY to the
// already-built file routes (src/http/files.ts, T-0518):
//   POST /api/records/:recordId/files              — upload (raw body)
//   GET  /api/records/:recordId/files               — list (resolve display name)
//   GET  /api/files/:versionId/download[?disposition=inline] — download/preview
//
// Stored value: fileVersionId (a plain string — same pattern as person=id,
// relation=uuid). No client-side S3/bucket/presign call, no client file-ACL
// (FF-UPLOAD-ROUTE-ONLY / NF-2) — visibility/authorization is a pure derivative
// of the owning record's PDP grant, enforced entirely server-side.
//
// field.recordId — the CURRENT record's id (required to know where to POST/GET
// the file list; absent on a not-yet-created record → upload disabled with an
// honest message, matching the "create record first" constraint any file-attach
// UI has).
//
// Honest states (NF-5/D-062): Empty (upload affordance) / Loading (upload
// in-flight, disabled) / Error (size_exceeded / mime rejection / network,
// surfaced by message) / Populated (file name + Скачать + Заменить).
// ---------------------------------------------------------------------------

/**
 * uploadFileToRecord — the actual upload call FileField's handleFileSelect
 * makes: POST /api/records/:recordId/files with the raw File as the body,
 * Content-Type/X-File-Name headers derived from the File object, auth headers
 * from devHeaders(). Extracted as a standalone, React-free async function
 * (review M2 — codebase convention: "pure logic lives in a testable sibling",
 * cf. this file's own header note re: field-contract.js) so the real
 * upload-flow code path (headers built, endpoint hit, response parsed) is
 * exercisable by a unit test WITHOUT a DOM/React render — this project's
 * vitest tier runs "node" environment with no jsdom (web/vitest.config.js),
 * so hooks-bearing components cannot be invoked directly; this function has
 * none of that constraint.
 *
 * @param {{ recordId: string, file: File }} args
 * @returns {Promise<{ fileId: string, versionId: string, versionNo: number }>}
 * @throws {Error} formatError(status) message on a non-ok response
 */
export async function uploadFileToRecord({ recordId, file }) {
  const res = await fetch(`/api/records/${encodeURIComponent(recordId)}/files`, {
    method: 'POST',
    headers: {
      ...devHeaders(),
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': file.name || 'upload',
    },
    body: file,
  });
  if (!res.ok) {
    throw new Error(formatError(res.status));
  }
  return res.json();
}

/**
 * Upload/download control for a `file` contract field. Stores the uploaded
 * file's versionId as the field value; resolves the display name via the
 * record's file listing (GET /api/records/:recordId/files).
 *
 * @param {{ key, label?, title?, required?, recordId? }} field
 * @param {string} value  current value (fileVersionId or "")
 * @param {(key, value) => void} onChange
 * @param {string|undefined} error
 * @param {string} idPrefix
 * @param {boolean} isRequired
 * @param {boolean} readOnly
 */
export function FileField({ field, value, onChange, error, idPrefix = 'field', isRequired = false, readOnly = false }) {
  const id = `${idPrefix}-${field.key}`;
  const errorId = error ? `${id}-error` : undefined;
  const label = field.label || field.title || field.key;
  const invalid = Boolean(error);
  const recordId = field.recordId;

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  // T-0622 (P0 fix): a native <a href="..."> load does not carry the SPA's
  // auth headers (401 in keycloak mode) — download goes through downloadFile
  // (fetch WITH auth headers → blob → programmatic <a download> click).
  const [downloadError, setDownloadError] = useState(null);
  // fileMeta: { originalName, mime } for the CURRENT value's versionId, resolved
  // from the record's file listing. null = not yet resolved / no listing available.
  const [fileMeta, setFileMeta] = useState(null);
  // resolveState (review M1/m2): distinguishes WHY fileMeta is null — never
  // conflate "still loading", "listing came back but this version wasn't in
  // it" (no read access to that specific file, or a stale/foreign
  // fileVersionId) and "no record context at all" (true pre-save create).
  // 'idle' = nothing to resolve (no value or no recordId); 'loading' =
  // fetch in flight; 'resolved' = found in the listing; 'unresolved' = fetch
  // completed (ok or not) but no matching version — honest, not "— / no
  // access" conflated with "still loading".
  const [resolveState, setResolveState] = useState('idle');

  // Resolve the display name + mime for the current value from the record's
  // file listing (the same endpoint the list/card cells use — one source of
  // metadata, no duplicate resolution logic).
  //
  // review m1: match against ALL versions of every file (not just
  // currentVersionId) — `value` is whatever fileVersionId was stored at
  // upload time, which may since have been superseded by a "Заменить"
  // re-upload on the SAME file row (new currentVersionId, old value still
  // valid history). Matching only the current version would falsely show
  // "unresolved" for an old-but-real version.
  useEffect(() => {
    if (!value || !recordId) { setFileMeta(null); setResolveState('idle'); return; }
    let cancelled = false;
    setResolveState('loading');
    fetch(`/api/records/${encodeURIComponent(recordId)}/files`, { headers: devHeaders() })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) { setFileMeta(null); setResolveState('unresolved'); return; }
        const files = await res.json();
        if (cancelled) return;
        if (!Array.isArray(files)) { setFileMeta(null); setResolveState('unresolved'); return; }
        const match = files.find((f) => f && (
          f.currentVersionId === value
          || (Array.isArray(f.versionIds) && f.versionIds.includes(value))
        ));
        if (match) {
          setFileMeta({ originalName: match.originalName, mime: match.mime });
          setResolveState('resolved');
        } else {
          setFileMeta(null);
          setResolveState('unresolved');
        }
      })
      .catch(() => { if (!cancelled) { setFileMeta(null); setResolveState('unresolved'); } });
    return () => { cancelled = true; };
  }, [value, recordId]);

  const handleFileSelect = async (e) => {
    const file = e.target.files && e.target.files[0];
    // Reset the input so selecting the SAME file again still fires onChange
    // (replace flow) — browsers dedupe change events on identical selections.
    e.target.value = '';
    if (!file) return;
    if (!recordId) {
      setUploadError('Сначала сохраните запись, затем прикрепите файл');
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const body = await uploadFileToRecord({ recordId, file });
      setFileMeta({ originalName: file.name, mime: file.type });
      onChange(field.key, body.versionId);
    } catch (err) {
      setUploadError(String(err?.message || err));
    } finally {
      setUploading(false);
    }
  };

  const inputStyle = { display: 'block', width: '100%', boxSizing: 'border-box' };

  const labelNode = (
    <label className="chs-label" htmlFor={id}>
      {label}
      {isRequired && (
        <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
      )}
    </label>
  );
  const errorNode = error ? (
    <span id={errorId} role="alert" style={{ display: 'block', marginTop: 'var(--chs-space-1)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
      {error}
    </span>
  ) : null;
  const uploadErrorNode = uploadError ? (
    <span role="alert" style={{ display: 'block', marginTop: 'var(--chs-space-1)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
      {uploadError}
    </span>
  ) : null;

  // review M1(a)/m2: NEVER fall back to the raw fileVersionId (a meaningless
  // uuid to a human) — always a human-legible label per honest resolveState.
  // 'resolved' → the real name; 'loading' → "загрузка…"; 'unresolved' (fetch
  // completed but no match — could be a listing miss OR no read access to
  // that specific file; we cannot distinguish those two from this endpoint's
  // response, so the label says "no access" rather than pretending it found
  // nothing) → "нет доступа"; 'idle' with no recordId → generic "файл".
  const displayName = fileMeta?.originalName
    || (resolveState === 'loading' ? 'Загрузка…'
      : resolveState === 'unresolved' ? 'Нет доступа'
        : 'Файл');
  const downloadHref = value ? `/api/files/${encodeURIComponent(value)}/download` : null;

  const handleDownload = async (e) => {
    e.preventDefault();
    if (!downloadHref) return;
    setDownloadError(null);
    const result = await downloadFile(downloadHref, fileMeta?.originalName, fetchWithAuthRetry);
    if (!result.ok) setDownloadError(result.message);
  };

  let control;
  if (uploading) {
    // Loading — upload in flight, control disabled (honest, no dead affordance).
    control = (
      <div id={id} className="chs-input" aria-live="polite" aria-busy="true"
        style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontStyle: 'italic', fontSize: 'var(--chs-text-sm)' }}>
        Загрузка файла…
      </div>
    );
  } else if (value) {
    // Populated — show the resolved name, a real download link, and (unless
    // readOnly) a "Заменить" re-upload control.
    control = (
      <div id={id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-3)', flexWrap: 'wrap' }}>
          <a
            href="#"
            onClick={handleDownload}
            className="chs-input"
            style={{ ...inputStyle, width: 'auto', flex: 1, textDecoration: 'none', color: 'var(--chs-color-accent)' }}
            aria-describedby={errorId}
          >
            {displayName || 'Скачать файл'}
          </a>
          {!readOnly && (
            <label
              className="chs-label"
              style={{ margin: 0, cursor: 'pointer', color: 'var(--chs-color-accent)', fontSize: 'var(--chs-text-sm)' }}
            >
              Заменить
              <input
                type="file"
                onChange={handleFileSelect}
                style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}
                aria-label={`Заменить файл: ${label}`}
              />
            </label>
          )}
        </div>
        {downloadError && (
          <span role="alert" style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
            {downloadError}
          </span>
        )}
      </div>
    );
  } else if (readOnly) {
    // Empty + read-only: no upload affordance (nothing to download either) — honest.
    control = (
      <div id={id} className="chs-input" aria-readonly="true"
        style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontStyle: 'italic', fontSize: 'var(--chs-text-sm)' }}>
        Файл не загружен
      </div>
    );
  } else {
    // Empty — the upload affordance (Empty state).
    control = (
      <input
        id={id}
        type="file"
        className="chs-input"
        onChange={handleFileSelect}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        style={inputStyle}
      />
    );
  }

  return (
    <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
      {labelNode}
      {control}
      {uploadErrorNode}
      {errorNode}
    </div>
  );
}

// ---------------------------------------------------------------------------
// T-0403 (D7-6): RelationPickerField — record-picker for a `relation` contract.
//
// Fetches GET /api/records?registry_def_id=<targetRegistryId> (the same
// tenant-scoped endpoint used by RelationPicker in screen-app-records.jsx) and
// renders a text-filtered <select> of the target registry's records.
// Stored value: target record UUID. Displayed value: deriveRecordLabel (first
// non-empty string/number field in record.data — T-0447 resolution reuse).
//
// TENANT-SAFETY: the /api/records endpoint is RLS-enforced at the server: every
// query is scoped to the authenticated actor's tenant (session + server-side WHERE
// tenant_id = actor.tenantId). We pass devHeaders() to carry the auth credential
// (X-Dev-User in dev mode, Bearer in keycloak mode). No additional tenant filter
// is needed client-side — the server rejects cross-tenant access.
//
// field.targetRegistryId — the registry_def UUID to fetch records from
//   (set from the cross_app_ref definition at form-binding time).
//
// Honest states: loading / error / empty / populated — consistent with PersonPicker
// and the RelationPicker in screen-app-records.jsx (OBLIK principle).
// ---------------------------------------------------------------------------

/**
 * Record-picker for a `relation` contract field. Fetches the target registry's
 * records tenant-scoped via GET /api/records?registry_def_id=<id>, shows a
 * text-filtered <select>. Stores the selected record's UUID; displays its label
 * (deriveRecordLabel — first non-empty data value). Owns label + wrapper.
 *
 * @param {{ key, label?, title?, required?, targetRegistryId? }} field
 * @param {string} value  current value (record UUID or "")
 * @param {(key, value) => void} onChange
 * @param {string|undefined} error
 * @param {string} idPrefix
 * @param {boolean} isRequired
 * @param {boolean} readOnly
 */
export function RelationPickerField({ field, value, onChange, error, idPrefix = 'field', isRequired = false, readOnly = false }) {
  const id = `${idPrefix}-${field.key}`;
  const errorId = error ? `${id}-error` : undefined;
  const label = field.label || field.title || field.key;
  const invalid = Boolean(error);

  const [candidates, setCandidates] = useState(null); // null=loading
  const [fetchError, setFetchError] = useState(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!field.targetRegistryId) {
      // No target configured — render an empty picker rather than crashing.
      setCandidates([]);
      return;
    }
    let cancelled = false;
    setCandidates(null);
    setFetchError(null);
    // Tenant-scoped endpoint: the server enforces RLS so only records belonging
    // to the authenticated actor's tenant are returned. devHeaders() carries the
    // auth credential (X-Dev-User dev / Bearer keycloak).
    fetch(
      `/api/records?registry_def_id=${encodeURIComponent(field.targetRegistryId)}`,
      { headers: devHeaders() },
    )
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) throw new Error(formatError(res.status));
        const data = await res.json();
        if (!cancelled) setCandidates(Array.isArray(data.records) ? data.records : []);
      })
      .catch((err) => {
        if (!cancelled) { setFetchError(String(err?.message || err)); setCandidates([]); }
      });
    return () => { cancelled = true; };
  }, [field.targetRegistryId]);

  const inputStyle = { display: 'block', width: '100%', boxSizing: 'border-box' };
  const inputClass = `chs-input${invalid ? ' chs-input--invalid' : ''}`;

  const labelNode = (
    <label className="chs-label" htmlFor={id}>
      {label}
      {isRequired && (
        <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
      )}
    </label>
  );
  // T-0529: role=alert + id for aria-describedby (WCAG 1.3.1 / 4.1.3)
  const errorNode = error ? (
    <span id={errorId} role="alert" style={{ display: 'block', marginTop: 'var(--chs-space-1)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
      {error}
    </span>
  ) : null;

  let control;
  if (fetchError) {
    control = (
      <div className="chs-input" style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }} aria-live="polite">
        Не удалось загрузить связанные записи
      </div>
    );
  } else if (candidates === null) {
    control = (
      <div className="chs-input" style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontStyle: 'italic', fontSize: 'var(--chs-text-sm)' }} aria-live="polite">
        Загрузка…
      </div>
    );
  } else if (candidates.length === 0) {
    control = (
      <div className="chs-input" style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
        В связанном приложении пока нет записей
      </div>
    );
  } else {
    // Build display labels; filter by user search text.
    const labeled = candidates.map((rec) => ({
      id: rec.id,
      display: deriveRecordLabel(rec),
    }));
    const filterLower = filter.toLowerCase();
    const filtered = filterLower
      ? labeled.filter((c) => c.display.toLowerCase().includes(filterLower) || c.id.toLowerCase().startsWith(filterLower))
      : labeled;

    control = (
      <>
        <input
          type="text"
          className="chs-input"
          placeholder="Поиск…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label={`Поиск: ${label}`}
          style={{ ...inputStyle, marginBottom: 'var(--chs-space-2)' }}
          disabled={readOnly || undefined}
          aria-disabled={readOnly || undefined}
        />
        <select
          id={id}
          className={inputClass}
          value={value ?? ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          aria-required={isRequired || undefined}
          aria-invalid={invalid || undefined}
          disabled={readOnly || undefined}
          aria-disabled={readOnly || undefined}
          style={inputStyle}
          size={Math.min(filtered.length + 1, 6)}
        >
          <option value="">— выберите запись —</option>
          {filtered.map((c) => (
            <option key={c.id} value={c.id}>{c.display}</option>
          ))}
        </select>
      </>
    );
  }

  return (
    <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
      {labelNode}
      {control}
      {errorNode}
    </div>
  );
}

// ---------------------------------------------------------------------------
// T-0403 (D7-6): DateRangeField — two-date picker for a `date-range` contract.
//
// Renders two <input type="date"> controls (Начало / Конец) as one logical field.
// Serialization: value is an object { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }.
// Both are nullable (empty string = not set). Validation: start > end → inline
// error (client-side hint; the server re-validates on submit).
//
// onChange contract: called as onChange(field.key, { start, end }). The caller
// stores the object as the field value.
// ---------------------------------------------------------------------------

/**
 * Two-date range picker for a `date-range` contract field.
 * Value shape: `{ start: string, end: string }` (ISO date strings or "").
 * Validation: inline error when start > end (non-empty both set, start after end).
 *
 * @param {{ key, label?, title?, required? }} field
 * @param {{ start?: string, end?: string }|undefined} value
 * @param {(key, { start, end }) => void} onChange
 * @param {string|undefined} error  external validation error from the form
 * @param {string} idPrefix
 * @param {boolean} isRequired
 * @param {boolean} readOnly
 */
export function DateRangeField({ field, value, onChange, error, idPrefix = 'field', isRequired = false, readOnly = false }) {
  const idStart = `${idPrefix}-${field.key}-start`;
  const idEnd = `${idPrefix}-${field.key}-end`;
  const label = field.label || field.title || field.key;
  const invalid = Boolean(error);

  const startVal = (value && typeof value.start === 'string') ? value.start : '';
  const endVal = (value && typeof value.end === 'string') ? value.end : '';

  // Inline validation: both dates present and start is after end.
  const rangeError = (startVal && endVal && startVal > endVal)
    ? 'Дата начала не может быть позже даты окончания'
    : null;

  const inputStyle = { display: 'block', width: '100%', boxSizing: 'border-box' };
  const inputClass = `chs-input${(invalid || rangeError) ? ' chs-input--invalid' : ''}`;

  const handleStart = (e) => {
    onChange(field.key, { start: e.target.value, end: endVal });
  };
  const handleEnd = (e) => {
    onChange(field.key, { start: startVal, end: e.target.value });
  };

  return (
    <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
      <label className="chs-label" htmlFor={idStart}>
        {label}
        {isRequired && (
          <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
        )}
      </label>
      <div style={{ display: 'flex', gap: 'var(--chs-space-2)', alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <label className="chs-label" htmlFor={idStart} style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginBottom: 'var(--chs-space-1)' }}>
            Начало
          </label>
          <input
            id={idStart}
            className={inputClass}
            type="date"
            value={startVal}
            onChange={handleStart}
            aria-required={isRequired || undefined}
            aria-invalid={(invalid || Boolean(rangeError)) || undefined}
            readOnly={readOnly || undefined}
            aria-disabled={readOnly || undefined}
            style={inputStyle}
          />
        </div>
        <span aria-hidden="true" style={{ paddingTop: 'calc(var(--chs-space-4) + var(--chs-text-xs))', color: 'var(--chs-color-text-muted)' }}>—</span>
        <div style={{ flex: 1 }}>
          <label className="chs-label" htmlFor={idEnd} style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginBottom: 'var(--chs-space-1)' }}>
            Конец
          </label>
          <input
            id={idEnd}
            className={inputClass}
            type="date"
            value={endVal}
            onChange={handleEnd}
            aria-required={isRequired || undefined}
            aria-invalid={(invalid || Boolean(rangeError)) || undefined}
            readOnly={readOnly || undefined}
            aria-disabled={readOnly || undefined}
            style={inputStyle}
          />
        </div>
      </div>
      {rangeError && (
        <span
          role="alert"
          style={{ display: 'block', marginTop: 'var(--chs-space-1)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}
        >
          {rangeError}
        </span>
      )}
      {error && (
        <span style={{ display: 'block', marginTop: 'var(--chs-space-1)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
          {error}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// T-0406 (D7-7): CollectionField — editable line-items table for a `collection`
// contract (schemaSlot: child-rows).
//
// Renders a repeatable rows table where each row is an object with sub-fields.
// Sub-field types come from field.subFields (built by schemaToFormFields in
// records-form.js from the array items.properties — T-0448/T-0449). Each cell
// is rendered via FieldControl recursively (hideLabel=true) so every scalar/enum
// sub-field type is supported without duplication.
//
// onChange contract: onChange(field.key, rows[]) — the caller receives the
// updated array of row objects and stores it as the field value.
//
// Value shape: Array<Record<string, string|boolean|number>> — same as
// serializeRecordData's output for a collection field (records-form.js L732-778).
//
// UX-честность:
//   - Empty collection → one empty row pre-added so the table is never blank;
//     alternatively, a clear "Добавить строку" button when rows[] is empty.
//     The component starts with an empty array (blankRecordValues gives [])
//     and the "добавить" button is always visible (not hidden).
//   - Validation errors per cell: passed via `error` shape
//     { rows: [ { [subKey]: "message" } | undefined, … ], _collection?: string }
//     (matches validateRecordValues output for collection — records-form.js L504-562).
//     _collection error is shown as a top-level error (field-level); per-row/cell
//     errors are shown inline under the cell.
//   - add/remove buttons: always functional (add → new blank row; remove → splices row).
//   - tokens: --chs-* only; .chs-input/.chs-label classes.
// ---------------------------------------------------------------------------

/**
 * Editable line-items table for a `collection` contract field.
 * Each row is an object with sub-fields; each cell renders via FieldControl.
 *
 * @param {{ key, label?, title?, required?, subFields?: Array }} field
 * @param {Array<Record<string,unknown>>} value  current rows array ([] = empty)
 * @param {(key, rows) => void} onChange
 * @param {{ rows?: Array<object|undefined>, _collection?: string }|string|undefined} error
 * @param {string} idPrefix
 * @param {boolean} isRequired
 * @param {boolean} readOnly
 */
export function CollectionField({ field, value, onChange, error, idPrefix = 'field', isRequired = false, readOnly = false }) {
  const id = `${idPrefix}-${field.key}`;
  const label = field.label || field.title || field.key;
  const subFields = Array.isArray(field.subFields) ? field.subFields : [];
  const rows = Array.isArray(value) ? value : [];

  // Normalise the error prop:
  //   string → top-level field error (e.g. "Добавьте хотя бы одну строку")
  //   object → { rows: […], _collection?: string } shape from validateRecordValues
  const collectionError = error && typeof error === 'object' && !Array.isArray(error)
    ? (error._collection || null)
    : (typeof error === 'string' ? error : null);
  const rowErrors = error && typeof error === 'object' && Array.isArray(error.rows)
    ? error.rows
    : [];

  // Add a blank row to the rows array. The row carries a non-enumerable, stable
  // __rowKey so React can key <tr> on identity (not index) — removing a non-last
  // row then no longer makes React reuse the wrong DOM (the value-flicker trap).
  // The key is non-enumerable so serializeRecordData (records-form.js) never sees
  // it (Object.keys / for…of over entries skip it) — the data payload stays clean.
  const handleAdd = () => {
    if (readOnly) return;
    const blankRow = {};
    for (const sf of subFields) {
      blankRow[sf.key] = sf.type === 'boolean' ? false : '';
    }
    Object.defineProperty(blankRow, '__rowKey', {
      value: `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      enumerable: false,
      writable: false,
      configurable: true,
    });
    onChange(field.key, [...rows, blankRow]);
  };

  // Remove a row at index i.
  const handleRemove = (i) => {
    if (readOnly) return;
    const next = rows.filter((_, idx) => idx !== i);
    onChange(field.key, next);
  };

  // Update a single cell in a row. Preserve the non-enumerable __rowKey (a plain
  // `{ ...row }` spread would drop it, since spread only copies enumerable props)
  // so the row keeps its stable React identity across edits.
  const handleCellChange = (rowIdx, cellKey, cellValue) => {
    if (readOnly) return;
    const next = rows.map((row, idx) => {
      if (idx !== rowIdx) return row;
      const updated = { ...row, [cellKey]: cellValue };
      const rowKey = row && typeof row === 'object' ? row.__rowKey : undefined;
      if (typeof rowKey === 'string') {
        Object.defineProperty(updated, '__rowKey', {
          value: rowKey, enumerable: false, writable: false, configurable: true,
        });
      }
      return updated;
    });
    onChange(field.key, next);
  };

  const tableStyle = {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 'var(--chs-text-sm)',
  };
  const thStyle = {
    textAlign: 'left',
    padding: 'var(--chs-space-2) var(--chs-space-2)',
    borderBottom: '1px solid var(--chs-color-border)',
    color: 'var(--chs-color-text-muted)',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
  const tdStyle = {
    padding: 'var(--chs-space-1) var(--chs-space-2)',
    verticalAlign: 'top',
    borderBottom: '1px solid var(--chs-color-border)',
  };
  const removeBtnStyle = {
    background: 'none',
    border: 'none',
    cursor: readOnly ? 'default' : 'pointer',
    color: readOnly ? 'var(--chs-color-text-muted)' : 'var(--chs-color-danger)',
    fontSize: 'var(--chs-text-sm)',
    padding: '0 var(--chs-space-1)',
    opacity: readOnly ? 0.4 : 1,
  };
  const addBtnStyle = {
    marginTop: 'var(--chs-space-2)',
    padding: 'var(--chs-space-2) var(--chs-space-3)',
    background: 'none',
    border: '1px dashed var(--chs-color-border)',
    borderRadius: 'var(--chs-radius-2)',
    cursor: readOnly ? 'default' : 'pointer',
    color: readOnly ? 'var(--chs-color-text-muted)' : 'var(--chs-color-accent)',
    fontSize: 'var(--chs-text-sm)',
    opacity: readOnly ? 0.5 : 1,
  };

  // Helper: make a cell onChange handler for a given row index.
  // Returns (cellKey, cellValue) => void — matches FieldControl's onChange contract.
  const makeCellOnChange = (rowIdx) => (cellKey, cellValue) => {
    handleCellChange(rowIdx, cellKey, cellValue);
  };

  return (
    <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
      {/* Field label — a real <label htmlFor> bound to the line-items table
          (WCAG 1.3.1 / OBLIK G6), consistent with RelationPickerField/DateRangeField
          and the scalar controls in this file (not a bare div). */}
      <label className="chs-label" htmlFor={id} style={{ marginBottom: 'var(--chs-space-2)' }}>
        {label}
        {isRequired && (
          <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
        )}
      </label>

      {/* Top-level collection error (e.g. "Добавьте хотя бы одну строку") */}
      {collectionError && (
        <span
          role="alert"
          style={{ display: 'block', marginBottom: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}
        >
          {collectionError}
        </span>
      )}

      {/* Table */}
      {subFields.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table id={id} style={tableStyle} aria-label={label}>
            <thead>
              <tr>
                {subFields.map((sf) => (
                  <th key={sf.key} scope="col" style={thStyle}>
                    {sf.label || sf.key}
                    {sf.required && (
                      <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
                    )}
                  </th>
                ))}
                {/* Remove-button column header */}
                <th scope="col" style={{ ...thStyle, width: '2.5rem' }} aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={subFields.length + 1}
                    style={{ ...tdStyle, color: 'var(--chs-color-text-muted)', fontStyle: 'italic', textAlign: 'center', paddingTop: 'var(--chs-space-4)', paddingBottom: 'var(--chs-space-4)' }}
                  >
                    Нет строк — нажмите «Добавить строку»
                  </td>
                </tr>
              ) : (
                rows.map((row, rowIdx) => {
                  const rowErr = rowErrors[rowIdx];
                  // Stable React key: prefer the row's own __rowKey (set at handleAdd),
                  // fall back to the index for rows loaded from data (no key). Stable
                  // identity stops React reusing the wrong <tr> DOM when a non-last
                  // row is removed (the value-flicker trap).
                  const rowKey = (row && typeof row === 'object' && typeof row.__rowKey === 'string')
                    ? row.__rowKey
                    : `idx-${rowIdx}`;
                  return (
                    <tr key={rowKey}>
                      {subFields.map((sf) => {
                        const cellErr = rowErr && typeof rowErr === 'object' ? rowErr[sf.key] : undefined;
                        const cellValue = row && typeof row === 'object' ? row[sf.key] : undefined;
                        // B-1: thread readOnly down to the cell. FieldControl derives
                        // its disabled state from resolveFieldMode(field).mode, but a
                        // sub-field descriptor carries no `mode` — so the cell input
                        // would render editable in a read-only collection. Stamp
                        // mode:'read-only' onto the cell field so the <input> is really
                        // disabled (not just the add/remove buttons).
                        const cellField = readOnly ? { ...sf, mode: 'read-only' } : sf;
                        return (
                          <td key={sf.key} style={tdStyle}>
                            {/* Reuse FieldControl for each cell — hideLabel=true since <th> carries the label */}
                            <FieldControl
                              field={cellField}
                              value={cellValue}
                              onChange={makeCellOnChange(rowIdx)}
                              error={cellErr}
                              idPrefix={`${idPrefix}-${field.key}-row${rowIdx}`}
                              hideLabel={true}
                            />
                          </td>
                        );
                      })}
                      <td style={{ ...tdStyle, textAlign: 'center' }}>
                        <button
                          type="button"
                          aria-label={`Удалить строку ${rowIdx + 1}`}
                          onClick={() => handleRemove(rowIdx)}
                          style={removeBtnStyle}
                          disabled={readOnly || undefined}
                        >
                          <KitIcon name="close" size="0.9em" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : (
        /* No sub-fields configured — honest empty state */
        <div
          className="chs-input"
          aria-readonly="true"
          style={{ color: 'var(--chs-color-text-muted)', fontStyle: 'italic', fontSize: 'var(--chs-text-sm)' }}
        >
          Структура строк не настроена
        </div>
      )}

      {/* Add row button */}
      {subFields.length > 0 && (
        <button
          type="button"
          onClick={handleAdd}
          style={addBtnStyle}
          disabled={readOnly || undefined}
          aria-disabled={readOnly || undefined}
        >
          + Добавить строку
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// T-0649: MoneyInput — money contract's control (₽ inside the field, thousands
// separators while typing, kopecks preserved exactly on input AND display).
//
// THE P1 BUG THIS FIXES (data integrity, caught live 2026-07-05): storage was
// ALWAYS exact — serializeRecordData (records-form.js) does `Number(str)` with
// no rounding, a plain JS number round-trips through JSONB exactly. The loss
// was 100% a DISPLAY bug: formatCellValue's money branch passed
// `maximumFractionDigits: 0` to toLocaleString, so 150000.5 (150 000 rubles 50
// kopecks) rendered as "150 001 ₽" — kopecks silently rounded away on EVERY
// read (list/kanban/detail, all three call formatCellValue). That is fixed in
// records-form.js (minimumFractionDigits:0, maximumFractionDigits:2). This
// component is the INPUT side: same value/onChange contract the old bare
// `<input type="number">` had (a numeric string, e.g. "150000.5" — unchanged,
// so serializeRecordData needs no change), but rendered with a live
// thousands-grouped display ("150 000,5") and the ₽ glyph positioned INSIDE
// the input (an absolutely-positioned decorator + left padding) instead of
// floating outside the border where it visibly clipped.
//
// Implementation note: the control keeps ONE source of truth — the numeric
// string passed in as `value` (same shape serializeRecordData expects) — and
// derives a grouped display string from it for rendering. On focus it shows
// the RAW value (so editing mid-number doesn't fight the user's cursor with
// live-inserted separators); on blur it re-renders grouped. This avoids the
// classic "cursor jumps to the end on every keystroke" bug that live
// re-formatting while typing causes.
// ---------------------------------------------------------------------------

/**
 * Group the integer part of a numeric string with narrow no-break spaces
 * (ru-RU thousands separator convention) while leaving the fractional part
 * (kopecks) untouched — never rounds, never truncates digits.
 *
 * @param {string} raw - a numeric string, e.g. "150000.5" or "150000,50"
 * @returns {string} - e.g. "150 000,5"
 */
export function groupThousands(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  // Accept both '.' and ',' as the decimal separator on input; always DISPLAY
  // with ',' (ru-RU convention) — never touches the fractional digits.
  const normalized = raw.replace(',', '.');
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [intPart, fracPart] = unsigned.split('.');
  const groupedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sign = negative ? '-' : '';
  return fracPart !== undefined ? `${sign}${groupedInt},${fracPart}` : `${sign}${groupedInt}`;
}

/**
 * MoneyInput — the `money` contract's editable control.
 *
 * @param {{ id, inputClass, value, onChange, isRequired, invalid, errorId, readOnly, style }} props
 * @param {string} props.value - numeric string (same shape as a plain number
 *   input — "" when empty), e.g. "150000.5". NEVER pre-formatted with grouping.
 * @param {(nextValue: string) => void} props.onChange - called with the RAW
 *   numeric string (no grouping) — same contract serializeRecordData expects.
 */
export function MoneyInput({ id, inputClass, value, onChange, isRequired = false, invalid = false, errorId, readOnly = false, style }) {
  // Deliberately HOOK-FREE (no useState/useEffect): this codebase's web test
  // tier runs vitest in a plain "node" environment with no jsdom/react-dom/
  // react-test-renderer — components that use hooks cannot be reliably
  // invoked as plain functions outside a real React tree in that harness
  // (see field-renderer.test.jsx / screen-llm-connections.states.test.jsx).
  // The grouped display is derived PURELY from the `value` prop on every
  // render (a fully controlled input) — no separate "focused" state.
  const rawValue = value ?? '';
  const displayValue = groupThousands(String(rawValue));

  const handleChange = (e) => {
    // Strip grouping characters (spaces/no-break-spaces) a user might paste;
    // keep digits, one decimal separator (,  or .), and a leading '-'.
    const cleaned = e.target.value.replace(/\s/g, '').replace(',', '.');
    onChange(cleaned);
  };

  return (
    <div style={{ position: 'relative', display: 'block', width: '100%', boxSizing: 'border-box' }}>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 'var(--chs-space-3)',
          top: '50%',
          transform: 'translateY(-50%)',
          fontSize: 'var(--chs-text-sm)',
          color: 'var(--chs-color-text-muted)',
          pointerEvents: 'none',
        }}
      >
        ₽
      </span>
      <input
        id={id}
        className={inputClass}
        type="text"
        inputMode="decimal"
        value={displayValue}
        onChange={handleChange}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        readOnly={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        style={{ ...style, paddingLeft: 'calc(var(--chs-space-3) + 1.2em)' }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// T-0649: DateInput — the `date`/`datetime` presentation's control.
//
// THE BUG THIS FIXES (UX study §2): a bare <input type="date"> renders its
// TEXT in the browser/OS's own locale/format — "серое dd/mm/yyyy, вид зависит
// от браузера/локали". Keyboard entry into the native control already worked
// live ("05072026 → принялось") — that path is NOT touched (this stays a real
// <input type="date">/<input type="datetime-local">, full native keyboard +
// picker-affordance + a11y semantics). What changes is DISPLAY: the native
// input's own text is made transparent (CSS `color: transparent`; the
// browser's calendar-picker-indicator icon is UNAFFECTED by color and stays
// visible/clickable) and a locale-independent "05.07.2026[ 14:32]" label is
// rendered on top via an absolutely-positioned overlay — so the visible text
// is ALWAYS дд.мм.гггг regardless of the visiting browser's OS locale.
// ---------------------------------------------------------------------------

/**
 * DateInput — `date`/`datetime` contract control. Native `<input type="date">`
 * (or `type="datetime-local"` when `withTime`) with a locale-independent
 * "дд.мм.гггг[ чч:мм]" overlay + a calendar glyph decoration.
 *
 * @param {{ id, inputClass, value, onChange, isRequired, invalid, errorId, readOnly, style, withTime }} props
 * @param {string} props.value - ISO date ("YYYY-MM-DD") or ISO datetime
 *   ("YYYY-MM-DDTHH:mm") string — SAME shape the native input already used;
 *   storage/serialization is unchanged.
 * @param {(nextValue: string) => void} props.onChange
 * @param {boolean} [props.withTime] - datetime-local instead of date.
 */
export function DateInput({ id, inputClass, value, onChange, isRequired = false, invalid = false, errorId, readOnly = false, style, withTime = false }) {
  const rawValue = value ?? '';
  const displayLabel = rawValue
    ? (withTime ? formatShortDateTime(rawValue) : formatShortDate(rawValue))
    : '';

  return (
    <div style={{ position: 'relative', display: 'block', width: '100%', boxSizing: 'border-box' }}>
      <input
        id={id}
        className={inputClass}
        type={withTime ? 'datetime-local' : 'date'}
        value={rawValue}
        onChange={(e) => onChange(e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        readOnly={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        // The native text render is made transparent — the browser's own
        // calendar-picker-indicator affordance is a separate pseudo-element
        // that ignores `color` and stays visible/clickable. Keyboard focus,
        // typing, and the native picker popover are all fully preserved; only
        // the OS-locale-dependent TEXT is hidden in favour of the overlay
        // below. paddingRight leaves room for the calendar glyph decoration.
        style={{ ...style, color: 'transparent', paddingRight: 'calc(var(--chs-space-3) + 1.2em)' }}
      />
      {displayLabel && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 'var(--chs-space-3)',
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: 'var(--chs-text-sm)',
            color: 'var(--chs-color-text)',
            pointerEvents: 'none',
          }}
        >
          {displayLabel}
        </span>
      )}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          right: 'var(--chs-space-3)',
          top: '50%',
          transform: 'translateY(-50%)',
          color: 'var(--chs-color-text-muted)',
          pointerEvents: 'none',
        }}
      >
        <KitIcon name="calendar" size="1em" />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FieldControl — the single field component the schema-driven forms render.
// ---------------------------------------------------------------------------

/**
 * Render one form field as a labelled control, chosen from the binding-contract
 * catalog. The caller owns the value/onChange (controlled input). `onChange` is
 * called with (key, nextValue): a string for text/number/select/date, a boolean
 * for checkbox.
 *
 * T-0450 Fix 2 (G7): `hideLabel` — when true, omits the `<label>` element and the
 * bottom-margin wrapper div (renders the bare control only). Designed for table-cell
 * contexts (LineItemsField `<td>`) where the column `<th>` header already provides
 * the label; repeating it per-cell stacks a "form-in-a-form" anti-pattern and adds
 * unwanted margin that breaks table rhythm.
 * Default: false → backward-compatible; all existing callers keep their labels.
 *
 * @param {object} props
 * @param {{ key: string, label?: string, title?: string, required?: boolean,
 *           type?: string, contract?: string, presentation?: string,
 *           options?: string[] }} props.field
 * @param {string|boolean|undefined} props.value
 * @param {(key: string, value: string|boolean) => void} props.onChange
 * @param {string} [props.error]   per-field error message
 * @param {string} [props.idPrefix] id namespace (default "field")
 * @param {boolean} [props.hideLabel] when true, omit label + wrapper margin (default false)
 */
export function FieldControl({ field, value, onChange, error, idPrefix = 'field', hideLabel = false }) {
  const id = `${idPrefix}-${field.key}`;
  const errorId = error ? `${id}-error` : undefined;
  const label = field.label || field.title || field.key;
  // T-0404 [D7-9]: per-step field mode (read-only / required-to-advance / hidden),
  // bound to the BPMN node via form_binding.fields. Distinct from per-role
  // visibility (server-side field-visibility.ts) — both apply. hidden → not rendered;
  // read-only → rendered disabled; required-to-advance → marked required.
  const { hidden, readOnly, required: modeRequired } = resolveFieldMode(field);
  // hidden: the field is not rendered AT ALL at this step. Server-side submit
  // validation rejects any write to it (form-submit-validator.ts), so dropping the
  // control here is cosmetic-consistent, not the security boundary.
  if (hidden) return null;
  // required marker is the union of the legacy per-field `required` flag and the
  // step-bound `required-to-advance` mode.
  const isRequired = Boolean(field.required) || modeRequired;
  const invalid = Boolean(error);
  const { presentation, descriptor, editable } = resolveFieldContract(field);

  const inputStyle = { display: 'block', width: '100%', boxSizing: 'border-box' };
  const inputClass = `chs-input${invalid ? ' chs-input--invalid' : ''}`;

  // T-0529: error span has id + role=alert so AT reads it immediately on appearance.
  // aria-describedby on the control links to errorId for full WCAG 1.3.1/4.1.3 compliance.
  const errorNode = error ? (
    <span id={errorId} role="alert" style={{ display: 'block', marginTop: 'var(--chs-space-1)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }}>
      {error}
    </span>
  ) : null;

  // ----- read-only / not-yet-authorable contracts (honest degradation) -------
  // Editable structural contracts (relation/collection/date-range/money/file)
  // do not have an authoring control here yet (delivered by D7-6/7/8). Rather
  // than silently render a text box that captures nothing useful, surface what
  // the field IS so the gap is visible, not hidden.
  // T-0403 (D7-6): relation (presentation='reference') → RelationPickerField.
  if (presentation === 'reference') {
    return (
      <RelationPickerField
        field={field}
        value={value}
        onChange={onChange}
        error={error}
        idPrefix={idPrefix}
        isRequired={isRequired}
        readOnly={readOnly}
      />
    );
  }

  // T-0403 (D7-6): date-range (presentation='range') → DateRangeField.
  if (presentation === 'range') {
    return (
      <DateRangeField
        field={field}
        value={value}
        onChange={onChange}
        error={error}
        idPrefix={idPrefix}
        isRequired={isRequired}
        readOnly={readOnly}
      />
    );
  }

  // T-0406 (D7-7): collection (presentation='table') → CollectionField.
  // Renders an editable line-items table; delegates cell rendering back to
  // FieldControl (hideLabel=true). Replaces the old "not yet" italic readout.
  if (presentation === 'table') {
    return (
      <CollectionField
        field={field}
        value={value}
        onChange={onChange}
        error={error}
        idPrefix={idPrefix}
        isRequired={isRequired}
        readOnly={readOnly}
      />
    );
  }

  // T-0579: file (presentation='file') → FileField.
  // Structural contract with fetch/local state (resolves the display name via
  // the record's file listing) — same category as relation/collection, not a
  // scalarish inline input. Talks ONLY to the existing file routes (§2.3/§2.4
  // of the ADR); no client-side S3/bucket/presign, no client file-ACL.
  if (presentation === 'file') {
    return (
      <FileField
        field={field}
        value={value}
        onChange={onChange}
        error={error}
        idPrefix={idPrefix}
        isRequired={isRequired}
        readOnly={readOnly}
      />
    );
  }

  // T-0512: multi-select and person are scalarish (rendered inline by FieldControl).
  // T-0516: url and email are also scalarish (rendered as typed text inputs).
  const isScalarish = presentation === 'text' || presentation === 'textarea'
    || presentation === 'number' || presentation === 'checkbox'
    || presentation === 'date' || presentation === 'datetime' || presentation === 'select' || presentation === 'radio'
    || presentation === 'money' || presentation === 'multi-select' || presentation === 'person'
    || presentation === 'url' || presentation === 'email';

  if (!isScalarish) {
    const note = editable
      ? `Поле типа «${descriptor.label}» пока заполняется в другом месте`
      : `«${descriptor.label}» — только для чтения (вычисляется автоматически)`;
    // hideLabel: omit label + margin wrapper when caller manages the label externally.
    if (hideLabel) {
      return (
        <>
          <div
            id={id}
            className="chs-input"
            aria-readonly="true"
            style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}
          >
            {note}
          </div>
          {errorNode}
        </>
      );
    }
    return (
      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
        <label className="chs-label" htmlFor={id}>
          {label}
          {isRequired && (
            <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
          )}
        </label>
        <div
          id={id}
          className="chs-input"
          aria-readonly="true"
          style={{ ...inputStyle, color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}
        >
          {note}
        </div>
        {errorNode}
      </div>
    );
  }

  // ----- enum (select) -------------------------------------------------------
  if (presentation === 'select' || presentation === 'radio') {
    const options = Array.isArray(field.options) ? field.options : [];
    const control = (
      <select
        id={id}
        className={inputClass}
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        disabled={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        style={inputStyle}
      >
        <option value="">— выберите —</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
    // T-0450 Fix 2: hideLabel → bare control, no .chs-field wrapper or label.
    if (hideLabel) {
      return <>{control}{errorNode}</>;
    }
    return (
      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
        <label className="chs-label" htmlFor={id}>
          {label}
          {isRequired && (
            <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
          )}
        </label>
        {control}
        {errorNode}
      </div>
    );
  }

  // ----- multi-select (T-0512) ------------------------------------------------
  // Renders a set of checkboxes, one per option. Value is a string[].
  // On change: toggle the option in/out of the array.
  if (presentation === 'multi-select') {
    const options = Array.isArray(field.options) ? field.options : [];
    const selected = Array.isArray(value) ? value : [];
    const handleToggle = (opt) => {
      const next = selected.includes(opt)
        ? selected.filter((s) => s !== opt)
        : [...selected, opt];
      onChange(field.key, next);
    };
    const control = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)' }}>
        {options.length === 0 && (
          <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}>
            Нет вариантов
          </span>
        )}
        {options.map((opt) => (
          <label key={opt} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--chs-space-2)', fontSize: 'var(--chs-text-sm)' }}>
            <input
              type="checkbox"
              checked={selected.includes(opt)}
              onChange={() => handleToggle(opt)}
              disabled={readOnly || undefined}
              aria-disabled={readOnly || undefined}
            />
            {opt}
          </label>
        ))}
      </div>
    );
    if (hideLabel) {
      return <>{control}{errorNode}</>;
    }
    return (
      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
        <label className="chs-label" htmlFor={id}>
          {label}
          {isRequired && (
            <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
          )}
        </label>
        {control}
        {errorNode}
      </div>
    );
  }

  // ----- person (T-0512) -------------------------------------------------------
  // Renders a PersonPicker component (async employee select from GET /api/org).
  // PersonPicker owns its own label+wrapper so we return it directly.
  if (presentation === 'person') {
    return (
      <PersonPicker
        field={field}
        value={value}
        onChange={onChange}
        error={error}
        idPrefix={idPrefix}
        isRequired={isRequired}
        readOnly={readOnly}
      />
    );
  }

  // ----- boolean (checkbox) — label is part of the control -------------------
  if (presentation === 'checkbox') {
    // T-0450 Fix 2: hideLabel → bare checkbox (label text removed; th header is the label).
    if (hideLabel) {
      return (
        <>
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(field.key, e.target.checked)}
            aria-required={isRequired || undefined}
            aria-invalid={invalid || undefined}
            disabled={readOnly || undefined}
            aria-disabled={readOnly || undefined}
          />
          {errorNode}
        </>
      );
    }
    return (
      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--chs-space-2)', fontSize: 'var(--chs-text-sm)' }}>
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(field.key, e.target.checked)}
            aria-required={isRequired || undefined}
            aria-invalid={invalid || undefined}
            disabled={readOnly || undefined}
            aria-disabled={readOnly || undefined}
          />
          {label}
          {isRequired && (
            <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
          )}
        </label>
        {errorNode}
      </div>
    );
  }

  // ----- scalar inputs: text / textarea / number / date ----------------------
  // T-0529: all scalar inputs carry aria-describedby={errorId} for WCAG 1.3.1.
  let control;
  if (presentation === 'textarea') {
    control = (
      <textarea
        id={id}
        className={inputClass}
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        readOnly={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        rows={3}
        style={inputStyle}
      />
    );
  } else if (presentation === 'number') {
    control = (
      <input
        id={id}
        className={inputClass}
        type="number"
        step={field.type === 'integer' ? '1' : 'any'}
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        readOnly={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        style={inputStyle}
      />
    );
  } else if (presentation === 'money') {
    // T-0509/T-0649: MoneyInput — ₽ INSIDE the field (was floating outside the
    // border, where it visibly clipped — live bug from the UX study), thousands
    // separators while typing, kopecks preserved exactly (P1 data-integrity:
    // the ONLY prior rounding was in formatCellValue's DISPLAY formatting, not
    // storage/input — this control does not introduce any new rounding either).
    control = (
      <MoneyInput
        id={id}
        inputClass={inputClass}
        value={value}
        onChange={(v) => onChange(field.key, v)}
        isRequired={isRequired}
        invalid={invalid}
        errorId={errorId}
        readOnly={readOnly}
        style={inputStyle}
      />
    );
  } else if (presentation === 'date') {
    // T-0649: DateInput — was a bare <input type="date">, whose text rendering
    // is browser/OS-locale-dependent (the UX study's "серое dd/mm/yyyy, вид
    // зависит от браузера/локали"). Keyboard entry already worked live
    // ("05072026 → принялось") — DateInput keeps the SAME native input (zero
    // regression to that keyboard path or to a11y) but overlays a
    // locale-INDEPENDENT "05.07.2026" label so the visible text is always
    // дд.мм.гггг regardless of OS locale.
    control = (
      <DateInput
        id={id}
        inputClass={inputClass}
        value={value}
        onChange={(v) => onChange(field.key, v)}
        isRequired={isRequired}
        invalid={invalid}
        errorId={errorId}
        readOnly={readOnly}
        style={inputStyle}
      />
    );
  } else if (presentation === 'datetime') {
    // T-0649: datetime — <input type="datetime-local"> + дд.мм.гггг чч:мм overlay.
    control = (
      <DateInput
        id={id}
        inputClass={inputClass}
        value={value}
        onChange={(v) => onChange(field.key, v)}
        isRequired={isRequired}
        invalid={invalid}
        errorId={errorId}
        readOnly={readOnly}
        style={inputStyle}
        withTime
      />
    );
  } else if (presentation === 'url') {
    // T-0516: url — <input type="url"> for browser-native URL validation hint.
    control = (
      <input
        id={id}
        className={inputClass}
        type="url"
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        readOnly={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        style={inputStyle}
      />
    );
  } else if (presentation === 'email') {
    // T-0516: email — <input type="email"> for browser-native email validation hint.
    control = (
      <input
        id={id}
        className={inputClass}
        type="email"
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        readOnly={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        style={inputStyle}
      />
    );
  } else {
    // text (default)
    control = (
      <input
        id={id}
        className={inputClass}
        type="text"
        value={value ?? ''}
        onChange={(e) => onChange(field.key, e.target.value)}
        aria-required={isRequired || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        readOnly={readOnly || undefined}
        aria-disabled={readOnly || undefined}
        style={inputStyle}
      />
    );
  }

  // T-0450 Fix 2: hideLabel → bare control without .chs-field wrapper or label.
  if (hideLabel) {
    return <>{control}{errorNode}</>;
  }
  return (
    <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
      <label className="chs-label" htmlFor={id}>
        {label}
        {isRequired && (
          <span aria-hidden="true" style={{ marginLeft: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}>*</span>
        )}
      </label>
      {control}
      {errorNode}
    </div>
  );
}

export default FieldControl;
