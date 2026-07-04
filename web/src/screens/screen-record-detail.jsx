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
import { Button, Mono, LoadingState, ErrorState, EmptyState, KitIcon, ConfirmDialog } from '../components/components.jsx';
import { useToastContext } from '../app-shell/toast-context.jsx';
import { devHeaders, fetchWithAuthRetry } from '../app-shell/dev-auth.js';
import { formatDate, formatError, formatJsonReadable, formatPersonName } from '../lib/format.js';
import { fetchFileBlob, downloadFile } from '../lib/authed-file.js';
import { schemaToFormFields, formatCellValue, RELATION_CELL_ASYNC, FILE_CELL_ASYNC, deriveRecordLabel, computeComputedFieldValue } from './records-form.js';
// T-0608 (пункт г): resolve record.created_by (an employee SLUG — for a
// Keycloak-registered human, slug === the KC user UUID) to a display name.
import { fetchEmployees } from '../forms/field-renderer.jsx';
// T-0568: reuse the SAME create-drawer for editing (prefilled → PUT).
import { CreateRecordDrawer } from './screen-app-records.jsx';
import {
  groupLinksByLabel,
  isHopAllowed,
  isHopDenied,
  getRedactionReason,
  formatLinkedFields,
  buildLinkSectionTitle,
} from './record-links.js';


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
            <ErrorState compact title="Не удалось загрузить данные" />
          )}
          {!loading && !loadError && links && links.length === 0 && (
            <EmptyState compact title="—" />
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
// T-0579: FileFieldValue — resolves a fileVersionId to a download link + (for
// preview-safe mime types) an inline preview, in the record detail card.
//
// Resolution: GET /api/records/:recordId/files (the same listing FileField and
// FileCell consume) to get the display name + mime. Preview uses the inline-
// disposition route (?disposition=inline) which the server allowlists to a
// POSITIVE set of concrete-safe image subtypes (png/jpeg/gif/webp) and
// application/pdf — everything else (including any svg variant) is
// download-only.
//
// Honest states: loading / denied (not found in listing) / resolved (name link
// + optional preview).
// ---------------------------------------------------------------------------

/** Preview-safe mime allowlist mirrored from src/http/files.ts (client display
 * decision only — the SERVER re-validates and is the actual security boundary;
 * this just decides whether to render an <img>/<embed> at all).
 *
 * T-0579 fix-forward (review B1): normalize (trim + lowercase) before
 * comparing — a stored/served mime of `image/SVG+xml` must still be excluded
 * here, mirroring isInlineSafeMime server-side.
 *
 * T-0579 fix-forward (review B1-residual, blocking): trim+lowercase alone
 * missed two bypasses that the server-side hardening also closes: (a) a mime
 * carrying a parameter — `image/svg+xml;charset=utf-8` survives
 * normalization as-is, fails the exact `=== 'image/svg+xml'` compare, yet
 * still passed a bare `startsWith('image/')` check; (b) `image/svg` (no
 * `+xml`) was never excluded by that single negative check at all — browsers
 * still render it as SVG. Both are closed by stripping the `;param` suffix
 * at the comparison boundary AND switching to a POSITIVE allowlist of
 * concrete safe image subtypes (mirroring INLINE_SAFE_IMAGE_SUBTYPES
 * server-side) instead of a negative svg-exclusion — anything not
 * enumerated (svg, svg+xml, any future/unknown subtype) is denied by
 * construction. The two allowlists must agree so the client's rendering
 * DECISION never claims "safe" for something the server denies as unsafe. */
const PREVIEW_SAFE_IMAGE_SUBTYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function isPreviewSafeMime(mime) {
  if (typeof mime !== 'string') return false;
  const base = mime.trim().toLowerCase().split(';')[0].trim();
  if (base.length === 0) return false;
  return PREVIEW_SAFE_IMAGE_SUBTYPES.has(base) || base === 'application/pdf';
}

/**
 * Inline file field value for the record detail card: name-as-download-link,
 * plus an inline preview for image/*(non-svg)/pdf.
 *
 * T-0622 (P0 fix, re-LIVE_PROOF T-0579 real browser): a native `<img
 * src="...?disposition=inline">` / `<a href="...">` does not carry the SPA's
 * auth headers (Authorization: Bearer in keycloak mode) — 401. Both preview
 * and download now go through fetchFileBlob/downloadFile (lib/authed-file.js):
 * fetch WITH auth headers → blob → same-origin blob: object URL. The
 * anti-XSS mime allowlist (isPreviewSafeMime, unchanged) still gates WHICH
 * mimes get an <img> at all — this component only ever builds an <img> src
 * from a blob whose mime it already checked against PREVIEW_SAFE_IMAGE_SUBTYPES;
 * svg is never in that set, so it never reaches the <img> branch (it downloads
 * via the honest "Скачать файл" link instead, same as any other file).
 *
 * @param {string} versionId  fileVersionId stored as the field value.
 * @param {string} recordId   current record's id (listing fetch).
 */
function FileFieldValue({ versionId, recordId }) {
  // review m2: distinct honest states instead of one "denied" bucket that
  // conflated three different truths — 'empty' (no file attached at all,
  // NOT an access problem), 'forbidden' (listing fetch itself failed —
  // !res.ok, e.g. 403), 'notfound' (listing fetch succeeded but this
  // versionId is not in it — could be a stale/foreign value; we don't invent
  // a claim we can't verify, but at least don't call it "no access" when the
  // listing DID load), 'loading', 'resolved'.
  const [state, setState] = useState(versionId && recordId ? 'loading' : 'empty');
  const [meta, setMeta] = useState(null); // { originalName, mime }
  // T-0622: preview blob state, resolved SEPARATELY from the listing fetch
  // above (that fetch only gets name+mime; the actual bytes need their own
  // authed fetch). 'idle' (not attempted / not preview-safe) / 'loading' /
  // 'ok' (objectUrl ready) / 'error' (honest message, e.g. 401/403/404).
  const [previewState, setPreviewState] = useState('idle');
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [downloadError, setDownloadError] = useState(null);

  useEffect(() => {
    if (!versionId || !recordId) { setState('empty'); return; }
    let cancelled = false;
    setState('loading');
    fetch(`/api/records/${encodeURIComponent(recordId)}/files`, { headers: devHeaders() })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) { setState('forbidden'); return; }
        const files = await res.json();
        if (cancelled) return;
        // review m1: match against ALL versions of the file (versionIds), not
        // just the CURRENT one — a superseded-but-real version must still
        // resolve to its file's name, not be treated as unresolvable.
        const match = Array.isArray(files)
          ? files.find((f) => f && (
            f.currentVersionId === versionId
            || (Array.isArray(f.versionIds) && f.versionIds.includes(versionId))
          ))
          : null;
        if (!match) { setState('notfound'); return; }
        setMeta({ originalName: match.originalName, mime: match.mime });
        setState('resolved');
      })
      .catch(() => { if (!cancelled) setState('forbidden'); });
    return () => { cancelled = true; };
  }, [versionId, recordId]);

  const normalizedMime = typeof meta?.mime === 'string' ? meta.mime.trim().toLowerCase().split(';')[0].trim() : '';
  const previewSafe = state === 'resolved' && isPreviewSafeMime(meta?.mime);
  const isImagePreview = previewSafe && normalizedMime.startsWith('image/');
  const isPdfPreview = previewSafe && normalizedMime === 'application/pdf';

  // T-0622: fetch the preview blob (authed) once the listing has resolved a
  // preview-safe mime. Revokes its objectURL on versionId change/unmount so
  // no blob: URL leaks (NF — memory hygiene).
  useEffect(() => {
    if (!isImagePreview && !isPdfPreview) { setPreviewState('idle'); return; }
    let cancelled = false;
    let objectUrl = null;
    setPreviewState('loading');
    setPreviewError(null);
    const previewHref = `/api/files/${encodeURIComponent(versionId)}/download?disposition=inline`;
    fetchFileBlob(previewHref, fetchWithAuthRetry).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setPreviewState('error');
        setPreviewError(result.message);
        return;
      }
      objectUrl = URL.createObjectURL(result.blob);
      setPreviewUrl(objectUrl);
      setPreviewState('ok');
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setPreviewUrl(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId, isImagePreview, isPdfPreview]);

  const handleDownload = useCallback(async (e) => {
    e.preventDefault();
    setDownloadError(null);
    const downloadHref = `/api/files/${encodeURIComponent(versionId)}/download`;
    const result = await downloadFile(downloadHref, meta?.originalName, fetchWithAuthRetry);
    if (!result.ok) setDownloadError(result.message);
  }, [versionId, meta]);

  if (state === 'loading') {
    return <span style={{ color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}>…</span>;
  }

  if (state === 'empty') {
    return <span style={{ color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}>Файл не загружен</span>;
  }

  if (state === 'forbidden') {
    return <span style={{ color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}>Нет доступа</span>;
  }

  if (state === 'notfound' || !meta) {
    return <span style={{ color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}>Файл не найден</span>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)', alignItems: 'flex-start' }}>
      <a
        href="#"
        onClick={handleDownload}
        style={{ color: 'var(--chs-color-accent)', textDecoration: 'none' }}
        title="Скачать файл"
      >
        {meta.originalName || 'Скачать файл'}
      </a>
      {downloadError && (
        <span role="alert" style={{ color: 'var(--chs-color-danger)', fontSize: 'var(--chs-text-xs)' }}>
          {downloadError}
        </span>
      )}
      {previewState === 'loading' && (
        <span style={{ color: 'var(--chs-color-text-muted)', fontStyle: 'italic', fontSize: 'var(--chs-text-xs)' }}>
          Загрузка превью…
        </span>
      )}
      {previewState === 'error' && (
        <span role="alert" style={{ color: 'var(--chs-color-text-muted)', fontStyle: 'italic', fontSize: 'var(--chs-text-xs)' }}>
          {previewError || 'Не удалось загрузить превью'}
        </span>
      )}
      {previewState === 'ok' && isImagePreview && (
        <img
          src={previewUrl}
          alt={meta.originalName || 'Превью файла'}
          style={{ maxWidth: '320px', maxHeight: '320px', borderRadius: 'var(--chs-radius-2)', border: '1px solid var(--chs-color-border)' }}
        />
      )}
      {previewState === 'ok' && isPdfPreview && (
        <embed
          src={previewUrl}
          type="application/pdf"
          style={{ width: '100%', maxWidth: '480px', height: '360px', border: '1px solid var(--chs-color-border)', borderRadius: 'var(--chs-radius-2)' }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RecordDetailScreen
// ---------------------------------------------------------------------------

function RecordDetailScreen() {
  const { appId, id } = useParams();
  const navigate = useNavigate();
  const { push } = useToastContext();

  const [record, setRecord] = useState(null); // null = loading
  const [error, setError] = useState(null);   // string | { notFound: true }
  // T-0568: edit-drawer + confirm-delete state.
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // T-0608 (пункт г): slug → display-name map for record.created_by (an
  // employee SLUG, which for a Keycloak-registered human equals the KC user
  // UUID — rendering it raw is exactly the «АВТОР: 4c653940-…» bug). Loaded
  // once per screen mount (not per-record) — /api/org is tenant-wide and
  // cheap; a failed load degrades to the raw slug (fetchAuthorNames below),
  // never blocks the record itself from rendering.
  const [authorNames, setAuthorNames] = useState(() => new Map());

  useEffect(() => {
    let cancelled = false;
    fetchEmployees()
      .then((list) => {
        if (cancelled) return;
        setAuthorNames(new Map(list.map((e) => [e.id, e.name])));
      })
      .catch(() => { /* degrade to raw slug — non-fatal, see render below */ });
    return () => { cancelled = true; };
  }, []);

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
        let detail = formatError(res.status);
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

  // T-0568: edit committed (PUT 200) → close drawer + reload the fresh record.
  const handleSaved = useCallback((saved) => {
    setEditOpen(false);
    if (saved) setRecord(saved);
    push({ tone: 'success', message: 'Запись сохранена' });
  }, [push]);

  // T-0568: confirm-gated delete. DELETE /api/records/:id (T-0566 frozen contract
  // → 204 / 404 both settle to "gone") → toast + navigate back to the list.
  const confirmDelete = useCallback(async () => {
    if (!id) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/records/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: devHeaders(),
      });
      if (res.status === 204 || res.status === 404) {
        setConfirmDeleteOpen(false);
        push({ tone: 'success', message: 'Запись удалена' });
        navigate(appId ? `/app-records/${appId}` : '/apps');
      } else {
        push({ tone: 'error', title: 'Не удалось удалить запись', message: `HTTP ${res.status}` });
      }
    } catch (e) {
      push({ tone: 'error', title: 'Не удалось удалить запись', message: String(e?.message || e) });
    } finally {
      setDeleting(false);
    }
  }, [id, appId, navigate, push]);

  // Derive an ordered list of display fields from record_schema (may be null/missing)
  const formFields = record ? schemaToFormFields(record.record_schema) : [];
  const data = record?.data && typeof record.data === 'object' ? record.data : {};

  const backPath = appId ? `/app-records/${appId}` : '/apps';

  // T-0568: lightweight registryDef for the edit drawer — it needs record_schema
  // (drives the form fields); .id is unused on the PUT path, display_name is cosmetic.
  const editRegistryDef = record
    ? { id: record.registry_def_id, record_schema: record.record_schema, display_name: '' }
    : null;

  return (
    <div className="chs-inbox">
      {/* T-0568: edit drawer (reuses the create form, prefilled → PUT) + confirm-delete. */}
      {record && (
        <CreateRecordDrawer
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onCreated={handleSaved}
          applicationId={record.application_id}
          registryDef={editRegistryDef}
          existingRecord={record}
        />
      )}
      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Удалить запись?"
        message="Запись будет удалена без возможности восстановления."
        confirmLabel="Удалить"
        tone="danger"
        loading={deleting}
        onConfirm={confirmDelete}
        onClose={() => setConfirmDeleteOpen(false)}
      />
      {/* Header bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--chs-space-5)',
        padding: 'var(--chs-space-3) var(--chs-space-4)',
        borderBottom: '1px solid var(--chs-color-border)',
      }}>
        <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Детали записи
        </span>
        <div style={{ display: 'flex', gap: 'var(--chs-space-3)', alignItems: 'center' }}>
          {/* T-0568: edit + delete — only when a record is loaded. */}
          {record && !error && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)} glyph={<KitIcon name="pencil" className="chs-btn__glyph" />}>
                Редактировать
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteOpen(true)}>
                Удалить
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={() => navigate(backPath)} glyph={<KitIcon name="arrow-left" className="chs-btn__glyph" />}>
            Назад к списку
          </Button>
        </div>
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
                                ? formatJsonReadable(val)
                                : String(val)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div>
                  {formFields.map((f) => {
                    // T-0453/T-0580: computed fields derive their value EITHER from
                    // a sibling collection field (rollup mode, data[rollupSource])
                    // OR from a scalar formula over sibling fields (formula mode,
                    // T-0580) — computeComputedFieldValue dispatches on
                    // f.computedMode. The value is NEVER stored in data[f.key] —
                    // compute it on the fly here (client preview, NF-4).
                    if (f.type === 'computed') {
                      const computed = computeComputedFieldValue(f, data);
                      const display = formatCellValue(computed, 'computed');
                      return (
                        <div key={f.key} style={fieldRowStyle}>
                          <span style={labelStyle}>
                            {f.label}
                            <span
                              aria-hidden="true"
                              style={{
                                marginLeft: 'var(--chs-space-2)',
                                fontSize: 'var(--chs-text-xs)',
                                opacity: 0.7,
                              }}
                            >
                              (вычисляется)
                            </span>
                          </span>
                          <span style={{
                            ...valueStyle,
                            color: display === '—' ? 'var(--chs-color-text-muted)' : 'var(--chs-color-text)',
                            fontStyle: display === '—' ? 'italic' : 'normal',
                          }}>
                            {display}
                          </span>
                        </div>
                      );
                    }

                    const val = data[f.key];
                    // T-0447: relation fields render async label+link, not raw UUID.
                    const isRelation = f.type === 'relation';
                    const hasValue = val !== undefined && val !== null;
                    const isAsyncRelation = isRelation && hasValue &&
                      formatCellValue(val, f.type) === RELATION_CELL_ASYNC;
                    // T-0579: file fields render name-link + inline preview, not raw uuid.
                    const isFile = f.type === 'file';
                    const isAsyncFile = isFile && hasValue &&
                      formatCellValue(val, f.type) === FILE_CELL_ASYNC;
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
                              : isAsyncFile
                                ? (
                                  <FileFieldValue
                                    versionId={String(val)}
                                    recordId={record.id}
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
                  {formatDate(record.created_at)}
                </Mono>
              </div>
              <div style={fieldRowStyle}>
                <span style={labelStyle}>Обновлено</span>
                <Mono style={{ ...valueStyle, fontSize: 'var(--chs-text-xs)' }}>
                  {formatDate(record.updated_at)}
                </Mono>
              </div>
              {record.created_by && (
                <div style={fieldRowStyle}>
                  <span style={labelStyle}>Автор</span>
                  <Mono style={{ ...valueStyle, fontSize: 'var(--chs-text-xs)' }}>
                    {/* T-0608 (пункт г): resolve the slug to a display name via
                        the /api/org-backed map; fall back to the raw slug when
                        the lookup has no entry (e.g. still loading, or the
                        author has no position and /api/org's tree omits them)
                        — degrades to the PREVIOUS behaviour, never worse. */}
                    {formatPersonName(authorNames.get(record.created_by)) || record.created_by}
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
