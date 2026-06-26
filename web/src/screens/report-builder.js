/* ============================================================================
   web/src/screens/report-builder.js — T-0492

   PURE (no React, no fetch) helpers for the «Построитель отчёта» — the UI that
   lets a user assemble a Floor-1 report from their data WITHOUT a programmer.

   The single load-bearing job of this module is buildPageDef(): it emits the
   EXACT `page_def` shape that the server's renderer parses. The contract is
   FROZEN by src/http/report-page-render.ts → parseMetrics():

     page_def = Array<{
       source_registry_def_id: <uuid string>,   // metrics[i].source_registry_def_id
       field_key:              <schema-key string>,
       agg:                    'count'|'sum'|'avg'|'min'|'max'|'list',
       group_by?:              <schema-key string>,   // optional
       title?:                 <string>,              // optional display label
     }>

   parseMetrics() requirements (cited, render WILL 400 otherwise):
     - page_def MUST be an array ("page_def must be an array of metric objects").
     - each metric MUST be a plain object.
     - source_registry_def_id MUST be a string (and a UUID — renderFloor1 checks).
     - field_key MUST be a string matching [a-zA-Z0-9_-]+ AND exist in the
       registry_def's record_schema.properties (whitelist, else 422).
     - agg MUST be one of the six Floor-1 verbs.
     - group_by (when present) MUST be a string in the same charset + schema.

   deriveDepsFromPageDef() in report-pages.ts auto-registers one dep per metric
   (agg='list' → 'read', else 'aggregate'), so the builder need NOT send deps[]
   for a floor=1 page — the server derives them from page_def.

   Server create contract (src/http/report-pages.ts):
     POST /api/report-pages  body { app_id, slug, title, floor:'1', page_def }
       → 201 { id, app_id, slug, title, floor, tier, created_at }
       floor='1' REQUIRES page_def (400 VALIDATION otherwise).
   ============================================================================ */

// ---------------------------------------------------------------------------
// Aggregator vocabulary — human labels ↔ Floor-1 keys.
//
// 'list' is intentionally NOT offered in the builder UI as a metric kind: it is
// a raw value-collector rather than a numeric aggregate and is awkward in the
// scalar/grouped card view. count/sum/avg/min/max are the day-1 building blocks.
// (The label map still includes 'list' so a list-agg page authored elsewhere
// renders with a human label.)
// ---------------------------------------------------------------------------

/** agg key → human (ru) label. */
export const AGG_LABELS = {
  count: 'Количество',
  sum: 'Сумма',
  avg: 'Среднее',
  min: 'Минимум',
  max: 'Максимум',
  list: 'Список',
};

/** Ordered list of aggregators offered in the builder dropdown. */
export const BUILDER_AGGS = ['count', 'sum', 'avg', 'min', 'max'];

/** The strict field-key charset the server enforces (parseMetrics → assertFieldKeySafe). */
export const FIELD_KEY_SAFE_RE = /^[a-zA-Z0-9_-]+$/;

/** Aggregators that operate on a numeric field (everything except count). */
const NUMERIC_AGGS = new Set(['sum', 'avg', 'min', 'max']);

/** Schema field types we treat as numeric for sum/avg/min/max suggestions. */
const NUMERIC_SCHEMA_TYPES = new Set(['number', 'integer']);

// ---------------------------------------------------------------------------
// Field extraction — turn a registry_def.record_schema into a flat field list.
// ---------------------------------------------------------------------------

/**
 * Extract the selectable scalar fields of a record_schema for the builder.
 *
 * record_schema is { type:'object', properties: { <key>: { type, title?, enum?, ... } } }.
 * We return { key, label, type, numeric } for each property whose key passes the
 * server charset guard (a key the renderer would reject is useless — drop it so
 * the user can never pick a doomed field).
 *
 * `collection` (type:'array') fields are SKIPPED: the Floor-1 renderer aggregates
 * over `data->>'key'` scalar JSON paths; an array column has no scalar value to
 * sum/group. `computed` (x-rollup) fields are also skipped — they are never
 * stored in record.data (T-0453), so the aggregate would always be empty/null.
 *
 * @param {unknown} recordSchema
 * @returns {{ key:string, label:string, type:string, numeric:boolean }[]}
 */
export function extractSchemaFields(recordSchema) {
  if (!recordSchema || typeof recordSchema !== 'object') return [];
  const props = recordSchema.properties;
  if (!props || typeof props !== 'object') return [];

  const out = [];
  for (const key of Object.keys(props)) {
    if (!FIELD_KEY_SAFE_RE.test(key)) continue; // server would reject — hide it
    const prop = props[key];
    const type = prop && typeof prop === 'object' && typeof prop.type === 'string'
      ? prop.type
      : 'string';

    // Skip array (collection) fields and x-rollup computed fields — neither has a
    // scalar value the Floor-1 renderer can aggregate.
    if (type === 'array') continue;
    if (prop && typeof prop === 'object' && prop['x-rollup']) continue;

    const title = prop && typeof prop === 'object' && typeof prop.title === 'string'
      ? prop.title.trim()
      : '';
    out.push({
      key,
      label: title.length > 0 ? title : key,
      type,
      numeric: NUMERIC_SCHEMA_TYPES.has(type),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Slug derivation — server requires a non-empty slug; we derive from the title.
// ---------------------------------------------------------------------------

const CYRILLIC_SLUG_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Cyrillic-aware slug from a free-text title (mirrors relation-cascade.slugFromName).
 * A uniqueness suffix is appended by callers (the server has no per-app slug
 * uniqueness constraint surfaced to us, but a stable+unique slug avoids surprises).
 *
 * @param {string} name
 * @returns {string} non-empty slug (falls back to 'report')
 */
export function slugFromTitle(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => (ch in CYRILLIC_SLUG_MAP ? CYRILLIC_SLUG_MAP[ch] : ch))
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug || 'report';
}

// ---------------------------------------------------------------------------
// Validation — produce honest, human errors BEFORE hitting the API.
// ---------------------------------------------------------------------------

/**
 * Validate the builder draft state. Returns { valid, errors } where errors is a
 * map of field-id → ru message (rendered inline; never a raw key/UUID to the user).
 *
 * @param {{
 *   title?: string,
 *   registryDefId?: string,
 *   groupBy?: string,               // '' = no grouping
 *   metrics?: { agg:string, fieldKey:string }[],
 *   countFallbackKey?: string,      // passed through to buildPageDef for emptiness check
 * }} state
 * @returns {{ valid: boolean, errors: Record<string,string>, metricErrors: Record<number,string> }}
 */
export function validateBuilder(state) {
  const errors = {};
  const metricErrors = {};
  const title = String(state?.title || '').trim();
  if (title.length === 0) {
    errors.title = 'Укажите заголовок отчёта';
  }
  if (!state?.registryDefId) {
    errors.registryDefId = 'Выберите набор полей (что считаем)';
  }

  const metrics = Array.isArray(state?.metrics) ? state.metrics : [];
  if (metrics.length === 0) {
    errors.metrics = 'Добавьте хотя бы одну метрику';
  }
  metrics.forEach((m, i) => {
    const agg = String(m?.agg || '');
    if (!BUILDER_AGGS.includes(agg)) {
      metricErrors[i] = 'Выберите тип подсчёта';
      return;
    }
    // count may have no field; numeric aggs require a field.
    if (NUMERIC_AGGS.has(agg)) {
      const fk = String(m?.fieldKey || '');
      if (fk.length === 0) {
        metricErrors[i] = 'Выберите поле для подсчёта';
      } else if (!FIELD_KEY_SAFE_RE.test(fk)) {
        metricErrors[i] = 'Недопустимое поле';
      }
    }
  });

  // Check the resulting page_def is non-empty. This catches the case where all
  // metrics are count with no countFallbackKey (no scalar fields in the dataset),
  // or all metrics have an invalid field — the server would accept [] but render
  // an empty phantom report.
  if (Object.keys(errors).length === 0 && Object.keys(metricErrors).length === 0) {
    const pageDef = buildPageDef(state);
    if (pageDef.length === 0) {
      const countFallbackKey = String(state?.countFallbackKey || '').trim();
      if (countFallbackKey.length === 0) {
        errors.metrics = 'В этом наборе нет полей для подсчёта — добавьте поля в конструкторе';
      } else {
        errors.metrics = 'Добавьте хотя бы одну метрику с полем';
      }
    }
  }

  const valid = Object.keys(errors).length === 0 && Object.keys(metricErrors).length === 0;
  return { valid, errors, metricErrors };
}

// ---------------------------------------------------------------------------
// buildPageDef — THE contract emitter. Maps builder state → page_def array.
// ---------------------------------------------------------------------------

/**
 * Build the `page_def` array for POST/PATCH from the builder's draft state.
 *
 * Emits exactly the shape parseMetrics() reads (see module header). One element
 * per metric. group_by (when chosen) is attached to EVERY metric so the grouped
 * card view applies consistently. `count` metrics carry a stable placeholder
 * field_key (the count agg ignores it, but parseMetrics requires field_key to be
 * a present, charset-valid, schema-whitelisted string).
 *
 * @param {{
 *   registryDefId: string,                 // source_registry_def_id (uuid)
 *   groupBy?: string,                       // '' / falsy = no grouping
 *   metrics: { agg:string, fieldKey?:string, title?:string }[],
 *   countFallbackKey?: string,              // a real schema key to attach to count metrics
 * }} state
 * @returns {Array<object>} page_def
 */
export function buildPageDef(state) {
  const registryDefId = String(state?.registryDefId || '');
  const groupBy = String(state?.groupBy || '').trim();
  const metrics = Array.isArray(state?.metrics) ? state.metrics : [];
  const countFallbackKey = String(state?.countFallbackKey || '').trim();

  const pageDef = [];
  for (const m of metrics) {
    const agg = String(m?.agg || '');
    if (!BUILDER_AGGS.includes(agg)) continue;

    // field_key: numeric aggs use the chosen field; count uses the chosen field
    // if any, else the provided fallback schema key (count ignores the value).
    let fieldKey = String(m?.fieldKey || '').trim();
    if (agg === 'count' && fieldKey.length === 0) {
      fieldKey = countFallbackKey;
    }
    if (fieldKey.length === 0) continue; // can't emit a metric without a field_key

    const metric = {
      source_registry_def_id: registryDefId,
      field_key: fieldKey,
      agg,
    };
    if (groupBy.length > 0) {
      metric.group_by = groupBy;
    }
    const title = String(m?.title || '').trim();
    if (title.length > 0) {
      metric.title = title;
    } else {
      // Default human label so the rendered card isn't "<key> (agg)" jargon.
      metric.title = defaultMetricTitle(agg, fieldKey, groupBy);
    }
    pageDef.push(metric);
  }
  return pageDef;
}

/**
 * A human default title for a metric, e.g. «Сумма» / «Количество по статусу».
 * Pure — used by buildPageDef and reusable by the UI preview.
 */
export function defaultMetricTitle(agg, fieldKey, groupBy) {
  const aggLabel = AGG_LABELS[agg] || agg;
  if (agg === 'count') {
    return groupBy ? `${aggLabel} по «${groupBy}»` : aggLabel;
  }
  const base = `${aggLabel}: ${fieldKey}`;
  return groupBy ? `${base} по «${groupBy}»` : base;
}

// ---------------------------------------------------------------------------
// buildCreateBody — full POST /api/report-pages body from builder state.
// ---------------------------------------------------------------------------

/**
 * Assemble the create-request body. floor is always '1' (the builder authors
 * Floor-1 aggregate pages only); page_def is the emitted contract array.
 *
 * @param {{
 *   appId: string,
 *   title: string,
 *   slug?: string,                  // when omitted, derived from title (+ uniqueness suffix)
 *   registryDefId: string,
 *   groupBy?: string,
 *   metrics: { agg:string, fieldKey?:string, title?:string }[],
 *   countFallbackKey?: string,
 * }} state
 * @returns {{ app_id:string, slug:string, title:string, floor:'1', page_def:object[] }}
 */
export function buildCreateBody(state) {
  const title = String(state?.title || '').trim();
  const slug = String(state?.slug || '').trim() || `${slugFromTitle(title)}-${shortId()}`;
  return {
    app_id: String(state?.appId || ''),
    slug,
    title,
    floor: '1',
    page_def: buildPageDef({
      registryDefId: state?.registryDefId,
      groupBy: state?.groupBy,
      metrics: state?.metrics,
      countFallbackKey: state?.countFallbackKey,
    }),
  };
}

/**
 * Assemble the PATCH /api/report-pages/:id body — title + page_def (the two
 * editable parts of a floor=1 draft; deps are re-derived server-side).
 */
export function buildPatchBody(state) {
  return {
    title: String(state?.title || '').trim(),
    page_def: buildPageDef({
      registryDefId: state?.registryDefId,
      groupBy: state?.groupBy,
      metrics: state?.metrics,
      countFallbackKey: state?.countFallbackKey,
    }),
  };
}

/** Short, URL-safe, low-collision suffix for slugs (no crypto dependency). */
export function shortId() {
  return Math.random().toString(36).slice(2, 8);
}

/** A blank metric row for the builder (defaults to count, no field). */
export function blankMetric() {
  return { agg: 'count', fieldKey: '', title: '' };
}
