/* ============================================================================
   CHOROS — screen-record-detail.jsx
   ЭКРАН: КОНСТРУКТОР · Детали записи (T-0295 + T-0352 cross-app links, read-only).

   Открывается по маршруту /apps/:appId/records/:id.
   Загружает одну запись через GET /api/records/:id (enriched — T-0295):
     { id, application_id, registry_def_id, record_schema_version,
       record_schema, data, created_at, updated_at, created_by }
   Рендерит все поля записи по их меткам из record_schema (schemaToFormFields)
   как читаемый список «метка → значение». Обрабатывает 404 честно.

   T-0352 (E16 §6): добавлены помеченные изолированные секции связанных приложений
   («Из договора» / «Из CRM»). Секции lazy-loaded: загружаются через
   GET /api/records/:id/links только при раскрытии пользователем. Политика резолюции:
     - список (screen-app-records) = без резолюции (snapshot only);
     - карточка (этот экран) = 1-хоп live lazy на раскрытие секции;
     - нет доступа → редактированная проекция (label/id only).

   READ-ONLY: форма редактирования и любые мутации НЕ входят в этот экран.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Button, Mono, LoadingState, ErrorState, EmptyState, KitIcon } from '../components/components.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';
import { schemaToFormFields, formatCellValue, RELATION_CELL_ASYNC, deriveRecordLabel } from './records-form.js';
import {
  groupLinksByLabel,
  isHopAllowed,
  isHopDenied,
  getRedactionReason,
  formatLinkedFields,
  buildLinkSectionTitle,
} from './record-links.js';

function fmtTs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fieldRowStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--chs-space-2)',
  padding: 'var(--chs-space-5) 0',
  borderBottom: '1px solid var(--chs-color-border)',
};

const labelStyle = {
  fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const valueStyle = {
  fontSize: 'var(--chs-text-sm)',
  color: 'var(--chs-color-text)',
  wordBreak: 'break-word',
};

// 2-column detail layout (audit #11): the old maxWidth:640 cap wasted ~40-50%
// of desktop width. Per principles §5 (use the width on wide B2B screens), the
// record fields take the flexible left column (≈2/3) and metadata sits in a
// right sidebar (≈1/3). minmax(0,…) lets long field values wrap instead of
// overflowing; the sidebar floor keeps it from collapsing too thin.
const detailGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 2fr) minmax(220px, 1fr)',
  gap: 'var(--chs-space-7) var(--chs-space-9)',
  alignItems: 'start',
};

// Metadata sidebar: a contained surface so it reads as secondary chrome, not a
// second field list. Token-only colors (G6).
const metaSidebarStyle = {
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-4)',
  background: 'var(--chs-color-surface)',
  padding: 'var(--chs-space-3) var(--chs-space-6)',
};

// ---------------------------------------------------------------------------
// T-0352 (E16 §6): LinkedSection — labeled isolated section for a cross-app ref.
//
// §6 card policy: 1-hop live, lazy on expand. The section is collapsed by default;
// opening it triggers GET /api/records/:id/links (once per card load). ACL-denied
// hops render the redacted label-only sentinel («label · Нет доступа»).
//
// Token-only colors (G6); no hardcoded hex. OBLIK kit alignment.
// ---------------------------------------------------------------------------

const linkedSectionHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  cursor: 'pointer',
  padding: 'var(--chs-space-4) 0',
  borderBottom: '1px solid var(--chs-color-border)',
  background: 'none',
  border: 'none',
  width: '100%',
  textAlign: 'left',
};

const linkedSectionTitleStyle = {
  fontSize: 'var(--chs-text-sm)',
  fontWeight: '500',
  color: 'var(--chs-color-text)',
};

const linkedSectionBodyStyle = {
  borderLeft: '2px solid var(--chs-color-border)',
  paddingLeft: 'var(--chs-space-4)',
  marginTop: 'var(--chs-space-2)',
  marginBottom: 'var(--chs-space-4)',
};

const redactedRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--chs-space-2)',
  padding: 'var(--chs-space-3) 0',
  color: 'var(--chs-color-text-muted)',
  fontSize: 'var(--chs-text-sm)',
  fontStyle: 'italic',
};

/**
 * A single labeled isolated section for one cross-app ref.
 * Renders allowed hop fields OR a redacted sentinel.
 */
function LinkedSection({ title, links, loading, loadError }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ borderTop: '1px solid var(--chs-color-border)' }}>
      {/* Section header — clicking expands the section (lazy load trigger is in parent) */}
      <button
        type="button"
        style={linkedSectionHeaderStyle}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={linkedSectionTitleStyle}>{title}</span>
        <KitIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} />
      </button>

      {/* Body — rendered only when expanded */}
      {expanded && (
        <div style={linkedSectionBodyStyle}>
          {loading && <LoadingState label="Загрузка связанных данных…" compact />}
          {!loading && loadError && (
            <p style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
              Не удалось загрузить данные
            </p>
          )}
          {!loading && !loadError && links && links.length === 0 && (
            <p style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
              —
            </p>
          )}
          {!loading && !loadError && links && links.map((link) => {
            if (isHopAllowed(link.hop)) {
              // Allowed: show resolved fields
              const displayFields = formatLinkedFields(link.hop.fields);
              if (displayFields.length === 0) {
                return (
                  <p key={link.refId} style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
                    —
                  </p>
                );
              }
              return (
                <div key={link.refId}>
                  {displayFields.map(({ key, displayValue }) => (
                    <div key={key} style={fieldRowStyle}>
                      <span style={labelStyle}>{key}</span>
                      <span style={valueStyle}>{displayValue}</span>
                    </div>
                  ))}
                </div>
              );
            }
            if (isHopDenied(link.hop)) {
              // Denied: redacted label/id only sentinel
              const reason = getRedactionReason(link.hop);
              return (
                <div key={link.refId} style={redactedRowStyle}>
                  <KitIcon name="lock" size={13} />
                  <span>{link.label} · {reason}</span>
                </div>
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

/**
 * CrossAppLinksPanel — T-0352 §6 lazy link-section loader.
 *
 * Fetches GET /api/records/:id/links once on first render and renders one
 * labeled isolated section per label group (§6: «Из договора» / «Из CRM»).
 * Empty links → nothing rendered (no section chrome for records without cross refs).
 */
function CrossAppLinksPanel({ recordId }) {
  const [links, setLinks] = useState(null);  // null = not yet loaded
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    if (!recordId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetch(`/api/records/${encodeURIComponent(recordId)}/links`, {
      headers: devHeaders(),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          // 404 = record gone; other errors = degrade silently (don't block native fields)
          setLinks([]);
          setLoading(false);
          return;
        }
        const body = await res.json();
        if (cancelled) return;
        setLinks(Array.isArray(body.links) ? body.links : []);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError('fetch_error');
          setLoading(false);
          setLinks([]);
        }
      });
    return () => { cancelled = true; };
  }, [recordId]);

  // No sections if no links (clean degradation for records with no cross refs)
  if (!loading && (!links || links.length === 0)) return null;

  // Group by label (per §6: each label → one isolated section)
  const groups = links ? groupLinksByLabel(links) : new Map();

  if (!loading && groups.size === 0) return null;

  return (
    <div style={{ marginTop: 'var(--chs-space-5)' }}>
      <p style={{ ...labelStyle, marginBottom: 'var(--chs-space-3)' }}>
        СВЯЗАННЫЕ ДАННЫЕ
      </p>
      {loading ? (
        // Show one placeholder section while loading
        <div style={{ borderTop: '1px solid var(--chs-color-border)', padding: 'var(--chs-space-4) 0' }}>
          <LoadingState label="Загрузка связей…" compact />
        </div>
      ) : (
        [...groups.entries()].map(([label, sectionLinks]) => (
          <LinkedSection
            key={label}
            title={buildLinkSectionTitle(label)}
            links={sectionLinks}
            loading={false}
            loadError={loadError}
          />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// T-0447: RelationFieldValue — resolves a UUID relation value to label + link.
//
// Used in the record detail card for each relation field. Resolution path:
//   1. First try GET /api/records/:id/links (fast path when a cross_app_ref def
//      exists — T-0445 registers these for user-authored relations). If the
//      links response contains a hop whose hop.targetRecordId === targetId and
//      hop.allowed === true, derive the label from hop.fields.
//   2. Fallback: GET /api/records/:targetId directly (always works, whether or
//      not a cross_app_ref def row exists yet). Derive label via deriveRecordLabel.
//
// Resolution is done directly via fetch — the detail card already loads the
// record; this component is called per-field after the card loads.
//
// Honest states:
//   loading  → subtle placeholder (not a full spinner — field layout stays stable)
//   resolved → label + navigable Link to /apps/:targetAppId/records/:targetId
//   dangling/denied (404/403/error/null value) → «— / Нет доступа» sentinel
//
// Token-only colors (G6); no hardcoded hex.
// ---------------------------------------------------------------------------

/**
 * Inline async relation value for the record detail card.
 *
 * @param {string} targetId   UUID stored as the relation value.
 * @param {string} recordId   Current record's id (for the links endpoint fast path).
 * @param {string} appId      Current app id (fallback link construction).
 */
function RelationFieldValue({ targetId, recordId, appId }) {
  const [state, setState] = useState('loading'); // 'loading'|'resolved'|'denied'
  const [resolved, setResolved] = useState(null); // { text, targetAppId }

  useEffect(() => {
    if (!targetId) { setState('denied'); return; }
    let cancelled = false;
    setState('loading');

    // Fast path: check the links projection for this record — if a cross_app_ref
    // def exists the hop already has the resolved fields.
    const fastPath = fetch(
      `/api/records/${encodeURIComponent(recordId)}/links`,
      { headers: devHeaders() },
    ).then(async (res) => {
      if (cancelled) return null;
      if (!res.ok) return null;
      const body = await res.json();
      const links = Array.isArray(body.links) ? body.links : [];
      for (const link of links) {
        const hop = link.hop;
        if (!hop) continue;
        // Match the hop whose target is our targetId.
        if (hop.targetRecordId === targetId && hop.allowed === true) {
          const data = hop.fields && typeof hop.fields === 'object' ? hop.fields : {};
          // Derive label from the hop's field projection.
          const fakeRecord = { id: targetId, data };
          return { text: deriveRecordLabel(fakeRecord), targetAppId: appId };
        }
      }
      return null;
    }).catch(() => null);

    fastPath.then(async (hit) => {
      if (cancelled) return;
      if (hit) {
        setResolved(hit);
        setState('resolved');
        return;
      }
      // Fallback: fetch the target record directly.
      try {
        const res = await fetch(
          `/api/records/${encodeURIComponent(targetId)}`,
          { headers: devHeaders() },
        );
        if (cancelled) return;
        if (res.status === 404 || res.status === 403) { setState('denied'); return; }
        if (!res.ok) { setState('denied'); return; }
        const data = await res.json();
        if (cancelled) return;
        const targetAppId = data.application_id || appId;
        setResolved({ text: deriveRecordLabel(data), targetAppId });
        setState('resolved');
      } catch {
        if (!cancelled) setState('denied');
      }
    });

    return () => { cancelled = true; };
  }, [targetId, recordId, appId]);

  if (state === 'loading') {
    return (
      <span style={{ color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}>
        …
      </span>
    );
  }

  if (state === 'denied' || !resolved) {
    // Redacted sentinel — mirrors CrossAppLinksPanel's denied-hop treatment (T-0352).
    return (
      <span style={{ color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}>
        — / Нет доступа
      </span>
    );
  }

  return (
    <Link
      to={`/apps/${resolved.targetAppId}/records/${targetId}`}
      style={{ color: 'var(--chs-color-accent)', textDecoration: 'none' }}
      title={`Открыть запись ${targetId}`}
    >
      {resolved.text}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// RecordDetailScreen
// ---------------------------------------------------------------------------

function RecordDetailScreen() {
  const { appId, id } = useParams();
  const navigate = useNavigate();

  const [record, setRecord] = useState(null); // null = loading
  const [error, setError] = useState(null);   // string | { notFound: true }

  const loadRecord = useCallback(async () => {
    if (!id) { setError('Не указан идентификатор записи'); return; }
    setError(null);
    setRecord(null);
    try {
      const res = await fetch(`/api/records/${encodeURIComponent(id)}`, {
        headers: devHeaders(),
      });
      if (res.status === 404) {
        setError({ notFound: true });
        return;
      }
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); detail = j?.message || detail; } catch { /* ignore */ }
        setError(detail);
        return;
      }
      const data = await res.json();
      setRecord(data);
    } catch (e) {
      setError(String(e?.message || e));
    }
  }, [id]);

  useEffect(() => { loadRecord(); }, [loadRecord]);

  // Derive an ordered list of display fields from record_schema (may be null/missing)
  const formFields = record ? schemaToFormFields(record.record_schema) : [];
  const data = record?.data && typeof record.data === 'object' ? record.data : {};

  const backPath = appId ? `/app-records/${appId}` : '/apps';

  return (
    <div className="chs-inbox">
      {/* Header bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--chs-space-5)',
        padding: 'var(--chs-space-3) var(--chs-space-4)',
        borderBottom: '1px solid var(--chs-color-border)',
      }}>
        <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Детали записи
        </span>
        <Button variant="ghost" size="sm" onClick={() => navigate(backPath)}>
          ← Назад к списку
        </Button>
      </div>

      <div className="chs-inbox__scroll" style={{ padding: 'var(--chs-space-4, 16px) var(--chs-space-5, 20px)' }}>
        {/* Loading */}
        {!error && record === null && (
          <LoadingState label="Загрузка записи…" />
        )}

        {/* Not found */}
        {error && typeof error === 'object' && error.notFound && (
          <EmptyState
            icon={<KitIcon name="inbox" size={28} />}
            title="Запись не найдена"
            description="Запись не найдена или у вас нет к ней доступа."
            action={
              <Button variant="primary" onClick={() => navigate(backPath)}>
                Вернуться к списку
              </Button>
            }
          />
        )}

        {/* Generic error */}
        {error && typeof error === 'string' && (
          <ErrorState
            message={`Не удалось загрузить запись: ${error}`}
            onRetry={loadRecord}
          />
        )}

        {/* Detail view — 2-column layout (principles §5: use the width).
            Left = the record's fields (the content); right = metadata sidebar.
            Collapses to a single column on narrow viewports. */}
        {record && !error && (
          <div style={detailGridStyle}>
            {/* Fields column */}
            <div style={{ minWidth: 0 }}>
              <div style={{ marginBottom: 'var(--chs-space-6)' }}>
                <Mono style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                  {record.id}
                </Mono>
              </div>

              {/* Schema-driven field list */}
              {formFields.length === 0 ? (
                <div>
                  {/* Fallback: no schema / empty schema — render raw data keys */}
                  {Object.keys(data).length === 0 ? (
                    <p style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
                      Запись не содержит полей.
                    </p>
                  ) : (
                    Object.entries(data).map(([key, val]) => (
                      <div key={key} style={fieldRowStyle}>
                        <span style={labelStyle}>{key}</span>
                        <span style={valueStyle}>
                          {val === null || val === undefined
                            ? '—'
                            : typeof val === 'boolean'
                              ? (val ? 'Да' : 'Нет')
                              : typeof val === 'object'
                                ? JSON.stringify(val)
                                : String(val)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div>
                  {formFields.map((f) => {
                    const val = data[f.key];
                    // T-0447: relation fields render async label+link, not raw UUID.
                    const isRelation = f.type === 'relation';
                    const hasValue = val !== undefined && val !== null;
                    const isAsyncRelation = isRelation && hasValue &&
                      formatCellValue(val, f.type) === RELATION_CELL_ASYNC;
                    return (
                      <div key={f.key} style={fieldRowStyle}>
                        <span style={labelStyle}>{f.label}</span>
                        <span style={valueStyle}>
                          {!hasValue
                            ? '—'
                            : isAsyncRelation
                              ? (
                                <RelationFieldValue
                                  targetId={String(val)}
                                  recordId={record.id}
                                  appId={appId}
                                />
                              )
                              : formatCellValue(val, f.type)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* T-0352 (E16 §6): Cross-app link sections.
                  Lazy: fetches GET /api/records/:id/links once per card load.
                  Hidden when record has no cross_app_ref definitions (empty degrade). */}
              <CrossAppLinksPanel recordId={record.id} />
            </div>

            {/* Metadata sidebar */}
            <aside style={metaSidebarStyle} aria-label="Метаданные записи">
              <div style={fieldRowStyle}>
                <span style={labelStyle}>Создано</span>
                <Mono style={{ ...valueStyle, fontSize: 'var(--chs-text-xs)' }}>
                  {fmtTs(record.created_at)}
                </Mono>
              </div>
              <div style={fieldRowStyle}>
                <span style={labelStyle}>Обновлено</span>
                <Mono style={{ ...valueStyle, fontSize: 'var(--chs-text-xs)' }}>
                  {fmtTs(record.updated_at)}
                </Mono>
              </div>
              {record.created_by && (
                <div style={fieldRowStyle}>
                  <span style={labelStyle}>Автор</span>
                  <Mono style={{ ...valueStyle, fontSize: 'var(--chs-text-xs)' }}>
                    {record.created_by}
                  </Mono>
                </div>
              )}
              <div style={{ ...fieldRowStyle, borderBottom: 'none' }}>
                <span style={labelStyle}>Версия схемы</span>
                <Mono style={{ ...valueStyle, fontSize: 'var(--chs-text-xs)' }}>
                  {record.record_schema_version}
                </Mono>
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

export default RecordDetailScreen;
