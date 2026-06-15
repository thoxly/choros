/**
 * src/core/document-render.ts — T-0235 / T-0124
 *
 * Document-on-demand render module. Implements the one-layer render primitive:
 *   render(template, params, subject) → { bytes, format, meta }
 *   renderAndFix(...)               → versionId (snapshot via T-0119 addVersion)
 *
 * ADR: docs/design/T-0124-document-on-demand.adr.md §2.2/§2.3/§2.4/§2.5/§2.6
 *
 * DESIGN INVARIANTS (enforced by ci/checks/document-render-*.sh):
 *  FF-NO-RENDER-ACL    — Право рендера = resolveFor(...,"read"). Нет render_acl /
 *                        document_visibility / canRender / own permission-store.
 *  FF-RENDER-VIA-PDP   — Каждое чтение записи-источника идёт через resolveFor+projectFields.
 *                        Нет прямого SELECT из record мимо PDP.
 *  FF-NO-MASK-ROW      — Недоступная запись/поле отсутствует физически (drop=omit key),
 *                        не маскированная строка и не строка-прочерк.
 *  FF-FORMAT-CLOSED    — Набор форматов закрыт: {csv, html}. RENDERERS = closed map.
 *                        Расширение = миграция CHECK + Renderer, не ветка кода.
 *  FF-SNAPSHOT-IMMUTABLE — Снапшот только через addVersion(isSnapshot=true) (T-0119).
 *                          Render-модуль не пишет в file_version напрямую.
 *  FF-AUDIT-EVERY-RENDER — Каждый рендер (успех И отказ) → audit_event open-vocab.
 *                          Секрет токена не пишется в payload.
 *  FF-NO-DUP-SUBSYSTEM — Нет file-store, нет внешнего канала, нет render_log таблицы,
 *                        нет 4-го механизма согласованности.
 *  FF-LIVE-NO-CACHE    — live-рендер не кэшируется: два render вокруг мутации отражают
 *                        новое состояние.
 *  FF-TENANT-SCOPED-RENDER — Все record-чтения под choros.tenant_id GUC / FORCE RLS.
 *                            Внешний tenant из токена (T-0122), не из запроса.
 *
 * PURE CORE principle: no pg / fs / net / http / fetch / child_process imports.
 * All IO is behind injected ports (RecordSource, AuditSink, AddVersionPort, clock).
 */

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

import type { ResolveSubject } from "./object-handle.js";
import { resolveFor, type ResolverDeps } from "./grant-resolver.js";
import { makeHandle } from "./object-handle.js";
import type { AuditEventInput } from "./audit-grant-encoder.js";
import type { AddVersionAttrs, AddVersionResult } from "./file-attachment.js";

// ---------------------------------------------------------------------------
// DocFormat — closed set day-1 (FF-FORMAT-CLOSED)
// ---------------------------------------------------------------------------

/** Closed format set day-1 per ADR §2.4. Расширение = Renderer + CHECK строка. */
export type DocFormat = "csv" | "html";

// ---------------------------------------------------------------------------
// RenderMeta — determinism trace (NF-2)
// ---------------------------------------------------------------------------

/**
 * Metadata attached to every render result.
 * sourceDigest = детерминированный хэш отобранного (после projection) набора.
 * При фиксированных (templateVersion, projected-rows, renderedAt)
 * render производит байт-идентичный выход (NF-2).
 */
export interface RenderMeta {
  templateId: string;
  templateVersion: number;
  format: DocFormat;
  /** epoch-ms bigint as TS number (safe for 2^53). */
  renderedAt: number;
  /** SHA-256 hex over the sorted, projected row set. */
  sourceDigest: string;
  recordCount: number;
}

// ---------------------------------------------------------------------------
// RenderResult
// ---------------------------------------------------------------------------

export type RenderResult =
  | { denied: true; reason: string; meta?: never }
  | { denied: false; bytes: Uint8Array; format: DocFormat; meta: RenderMeta };

// ---------------------------------------------------------------------------
// Template model (matches template_def row; no DB import — ports inject data)
// ---------------------------------------------------------------------------

export interface TemplateDef {
  tenantId: string;
  id: string;
  registryId: string;
  format: DocFormat;
  body: string;
  version: number;
  tier: "draft" | "published";
}

// ---------------------------------------------------------------------------
// RenderParams — what the caller supplies (§2.2)
// ---------------------------------------------------------------------------

/** For single-record (QR-case): recordRef identifies the one record. */
export interface SingleRecordParams {
  kind: "single";
  recordRef: { tenantId: string; registryId: string; recordId: string };
}

/** For registry export (реестр-case): filter selects a batch. */
export interface RegistryParams {
  kind: "registry";
  registryId: string;
  filter?: Record<string, unknown>;
}

export type RenderParams = SingleRecordParams | RegistryParams;

// ---------------------------------------------------------------------------
// Injected ports — all IO behind seams (pure-core discipline)
// ---------------------------------------------------------------------------

/** Resolves a batch of records for a given registry under tenant RLS. */
export interface RecordBatchPort {
  /**
   * Returns records for the registry, ordered deterministically (tenant_id, id ASC).
   * RLS enforcement is the port implementation's responsibility (T-0013).
   * Only records visible under the GUC for subject.tenantId are returned.
   */
  getRecordsForRegistry(
    tenantId: string,
    registryId: string,
    filter?: Record<string, unknown>,
  ): Promise<Array<{ id: string; registryId: string; data: Record<string, unknown> }>>;

  /**
   * Returns a single record by id. Returns null when absent or cross-tenant.
   */
  getRecord(
    tenantId: string,
    registryId: string,
    recordId: string,
  ): Promise<{ id: string; registryId: string; data: Record<string, unknown> } | null>;
}

/** Template persistence seam — fetch by id+tenant. */
export interface TemplateSource {
  getTemplate(tenantId: string, templateId: string): Promise<TemplateDef | null>;
}

/** Audit sink (T-0016 open-vocab). */
export interface RenderAuditSink {
  emit(event: AuditEventInput): Promise<void>;
}

/**
 * Snapshot port — wraps addVersion (T-0119).
 * The render module calls this port; it NEVER writes file_version directly (FF-SNAPSHOT-IMMUTABLE).
 */
export interface SnapshotPort {
  addVersion(
    fileId: string,
    subject: ResolveSubject,
    body: Uint8Array,
    attrs: AddVersionAttrs,
  ): Promise<AddVersionResult>;
}

// ---------------------------------------------------------------------------
// Deps for render() and renderAndFix()
// ---------------------------------------------------------------------------

export interface RenderDeps {
  /** T-0021 PDP deps — resolveFor + projectFields per record (FF-RENDER-VIA-PDP). */
  resolver: ResolverDeps;
  /** Record batch port (RLS-enforced by the DB adapter). */
  records: RecordBatchPort;
  /** Template source. */
  templates: TemplateSource;
  /** Audit sink (T-0016). OPTIONAL: when absent, no audit is emitted. */
  audit?: RenderAuditSink;
  now?: () => number;
}

export interface RenderAndFixDeps extends RenderDeps {
  /** Snapshot port (T-0119 addVersion). Required for renderAndFix. */
  snapshot: SnapshotPort;
  /** The file object id to attach the new version to. */
  fileId: string;
}

// ---------------------------------------------------------------------------
// Renderers — closed map (FF-FORMAT-CLOSED)
// ---------------------------------------------------------------------------

export interface Renderer {
  format: DocFormat;
  /**
   * Pure, deterministic render function.
   * Given (template, projectedRows, meta) → produces byte-identical output
   * for the same inputs (NF-2 determinism).
   */
  render(
    template: TemplateDef,
    rows: Array<Record<string, unknown>>,
    meta: RenderMeta,
  ): { bytes: Uint8Array; mime: string };
}

/**
 * CSV renderer (табличный формат, реестр-case).
 * Hand-written deterministic string building, no template-engine dependency.
 * Columns = union of all keys from the first row; rows sorted by insertion
 * order (already deterministic from RecordBatchPort ORDER BY tenant_id,id).
 */
const csvRenderer: Renderer = {
  format: "csv",
  render(template, rows, _meta) {
    void template; // template.body may carry column hints in Stage-2; unused day-1
    if (rows.length === 0) {
      return { bytes: new Uint8Array(Buffer.from("", "utf8")), mime: "text/csv" };
    }
    // Collect all keys deterministically: union in first-seen order across all rows
    const keyOrder: string[] = [];
    const keySet = new Set<string>();
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (!keySet.has(k)) { keySet.add(k); keyOrder.push(k); }
      }
    }

    const escapeCell = (v: unknown): string => {
      const s =
        v === null || v === undefined
          ? ""
          : typeof v === "object"
          ? JSON.stringify(v)
          : String(v);
      // RFC 4180: quote cells containing comma, double-quote, or newline
      if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };

    const lines: string[] = [];
    lines.push(keyOrder.map(escapeCell).join(","));
    for (const row of rows) {
      lines.push(keyOrder.map((k) => escapeCell(row[k])).join(","));
    }
    const content = lines.join("\r\n");
    return { bytes: new Uint8Array(Buffer.from(content, "utf8")), mime: "text/csv" };
  },
};

/**
 * HTML renderer (человекочитаемый формат, QR-справка).
 * Hand-written deterministic table. No external template engine (zero new deps).
 */
const htmlRenderer: Renderer = {
  format: "html",
  render(template, rows, meta) {
    void template; // template.body may carry layout hints in Stage-2; unused day-1
    const escape = (s: unknown): string => {
      const str =
        s === null || s === undefined
          ? ""
          : typeof s === "object"
          ? JSON.stringify(s)
          : String(s);
      return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    };

    if (rows.length === 0) {
      const html =
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Document</title></head>` +
        `<body><p>No records</p>` +
        `<p><small>Generated at ${new Date(meta.renderedAt).toISOString()}</small></p>` +
        `</body></html>`;
      return { bytes: new Uint8Array(Buffer.from(html, "utf8")), mime: "text/html" };
    }

    const keyOrder: string[] = [];
    const keySet = new Set<string>();
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (!keySet.has(k)) { keySet.add(k); keyOrder.push(k); }
      }
    }

    const header = keyOrder.map((k) => `<th>${escape(k)}</th>`).join("");
    const body = rows
      .map((row) => `<tr>${keyOrder.map((k) => `<td>${escape(row[k])}</td>`).join("")}</tr>`)
      .join("\n");

    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Document</title></head>` +
      `<body><table border="1"><thead><tr>${header}</tr></thead>` +
      `<tbody>\n${body}\n</tbody></table>` +
      `<p><small>Generated at ${new Date(meta.renderedAt).toISOString()} | ` +
      `template ${escape(meta.templateId)} v${meta.templateVersion} | ` +
      `digest ${escape(meta.sourceDigest.slice(0, 16))}...</small></p>` +
      `</body></html>`;
    return { bytes: new Uint8Array(Buffer.from(html, "utf8")), mime: "text/html" };
  },
};

/**
 * RENDERERS — closed map (FF-FORMAT-CLOSED).
 * Расширение = добавить Renderer + строку в closed-set CHECK, не новый код-путь.
 */
export const RENDERERS: Record<DocFormat, Renderer> = {
  csv: csvRenderer,
  html: htmlRenderer,
};

// ---------------------------------------------------------------------------
// sourceDigest — deterministic hash of projected rows (NF-2)
// ---------------------------------------------------------------------------

/**
 * SHA-256 over the JSON-serialization of projected rows (sorted by row order,
 * which is deterministic because RecordBatchPort ORDER BY tenant_id,id).
 * Same projected-rows set → same digest → same document (NF-2).
 */
function computeSourceDigest(projectedRows: Array<Record<string, unknown>>): string {
  return createHash("sha256")
    .update(JSON.stringify(projectedRows))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// mimeOf — format → MIME type
// ---------------------------------------------------------------------------

function mimeOf(format: DocFormat): string {
  if (format === "csv") return "text/csv";
  if (format === "html") return "text/html";
  // Exhaustive check — TypeScript ensures format ∈ {csv, html}
  throw new Error(`Unknown format: ${String(format)}`);
}

// ---------------------------------------------------------------------------
// Audit helpers — open-vocab (T-0016 §2.6)
// ---------------------------------------------------------------------------

function makeAuditEvent(
  type: "doc.render" | "doc.render_denied" | "doc.snapshot_fixed",
  subject: ResolveSubject,
  params: RenderParams,
  template: TemplateDef,
  extra: Record<string, unknown>,
): AuditEventInput {
  return {
    id: randomUUID(),
    type,
    actor: subject.subjectId,
    subject: template.id,
    scope: null,
    via: null,
    proposed_by: null,
    confirmed_by: null,
    payload: {
      templateId: template.id,
      templateVersion: template.version,
      params: sanitizeParams(params),
      // NOTE: token secrets are NEVER written (T-0122 §2.8 contract, FF-AUDIT-EVERY-RENDER)
      ...extra,
    },
    occurred_at: extra["renderedAt"] as number ?? Date.now(),
  };
}

/** Strip any secret-looking keys from params before audit write. */
function sanitizeParams(params: RenderParams): Record<string, unknown> {
  if (params.kind === "single") {
    return { kind: "single", recordId: params.recordRef.recordId, registryId: params.recordRef.registryId };
  }
  return { kind: "registry", registryId: params.registryId, filter: params.filter };
}

// ---------------------------------------------------------------------------
// render — core operation (§2.2, §2.3, §2.4)
// ---------------------------------------------------------------------------

/**
 * Main render operation (FR-1 / ADR §2.2).
 *
 * For each source record:
 *  1. resolveFor(deps, handle, subject, "read") — THE PDP (FF-RENDER-VIA-PDP).
 *  2. denied ⇒ record is ABSENT from the document (FF-NO-MASK-ROW).
 *     For single-record: denied single → RenderResult{ denied:true } (NF-3).
 *  3. allowed ⇒ projectFields(raw, visibleFieldSet) — physical omission (drop=omit key).
 *
 * No render_acl / document_visibility / canRender introduced (FF-NO-RENDER-ACL).
 * No caching (FF-LIVE-NO-CACHE).
 *
 * Tenant isolation: all record reads under subject.tenantId; port enforces RLS.
 * For single record: cross-tenant ref → resolveFor returns cross_tenant → denied.
 */
export async function render(
  deps: RenderDeps,
  templateId: string,
  params: RenderParams,
  subject: ResolveSubject,
): Promise<RenderResult> {
  const now = (deps.now ?? Date.now)();

  // 1. Resolve template
  const template = await deps.templates.getTemplate(subject.tenantId, templateId);
  if (template === null) {
    // Emit denied audit
    const fakeTemplate: TemplateDef = {
      tenantId: subject.tenantId, id: templateId, registryId: "", format: "csv",
      body: "", version: 0, tier: "draft",
    };
    await deps.audit?.emit(makeAuditEvent("doc.render_denied", subject, params, fakeTemplate, {
      reason: "not_found", renderedAt: now,
    }));
    return { denied: true, reason: "not_found" };
  }

  // Only published templates are renderable (human-gated promote, §2.9)
  if (template.tier !== "published") {
    await deps.audit?.emit(makeAuditEvent("doc.render_denied", subject, params, template, {
      reason: "template_not_published", renderedAt: now,
    }));
    return { denied: true, reason: "template_not_published" };
  }

  // 2. Validate format is in closed set (FF-FORMAT-CLOSED)
  if (!(template.format in RENDERERS)) {
    await deps.audit?.emit(makeAuditEvent("doc.render_denied", subject, params, template, {
      reason: "unknown_format", format: template.format, renderedAt: now,
    }));
    return { denied: true, reason: "unknown_format" };
  }

  // 3. Batch-read records via PDP (FF-RENDER-VIA-PDP, FF-NO-MASK-ROW, §2.3)
  const projectedRows: Array<Record<string, unknown>> = [];

  if (params.kind === "single") {
    // Single-record case (QR-справка): resolve one record
    const { tenantId, registryId, recordId } = params.recordRef;

    // Cross-tenant protection: tenant_id of the ref must match subject
    if (tenantId !== subject.tenantId) {
      await deps.audit?.emit(makeAuditEvent("doc.render_denied", subject, params, template, {
        reason: "cross_tenant", renderedAt: now,
      }));
      return { denied: true, reason: "cross_tenant" };
    }

    const rawRow = await deps.records.getRecord(tenantId, registryId, recordId);
    if (rawRow === null) {
      await deps.audit?.emit(makeAuditEvent("doc.render_denied", subject, params, template, {
        reason: "not_found", renderedAt: now,
      }));
      return { denied: true, reason: "not_found" };
    }

    // PDP via resolveFor: build an ObjectHandle for this record
    const handle = makeHandle({
      kind: "record",
      tenantId: subject.tenantId,
      registryId: rawRow.registryId,
      recordId: rawRow.id,
    }, subject.tenantId);

    const view = await resolveFor(deps.resolver, handle, subject, "read");
    if (view.denied) {
      await deps.audit?.emit(makeAuditEvent("doc.render_denied", subject, params, template, {
        reason: view.reason, renderedAt: now,
      }));
      return { denied: true, reason: view.reason };
    }

    // resolveFor already calls projectFields internally (the single projection point).
    // view.fields = physical projection of rawRow.data: invisible fields are ABSENT
    // (drop = omit key, FF-NO-MASK-ROW, capability-not-text, data-classification.ts:127).
    projectedRows.push(view.fields);

  } else {
    // Registry batch case (реестр): per-row PDP
    const rawRows = await deps.records.getRecordsForRegistry(
      subject.tenantId,
      params.registryId,
      params.filter,
    );

    for (const rawRow of rawRows) {
      const handle = makeHandle({
        kind: "record",
        tenantId: subject.tenantId,
        registryId: rawRow.registryId,
        recordId: rawRow.id,
      }, subject.tenantId);

      const view = await resolveFor(deps.resolver, handle, subject, "read");
      if (view.denied) {
        // Record is ABSENT (FF-NO-MASK-ROW): denied row simply not included, never a dash-row.
        continue;
      }

      // resolveFor already calls projectFields internally (the single projection point).
      // view.fields = physical projection: invisible fields ABSENT (drop=omit key).
      projectedRows.push(view.fields);
    }
  }

  // 4. Compute sourceDigest (NF-2 reproducibility)
  const sourceDigest = computeSourceDigest(projectedRows);

  // 5. Build RenderMeta
  const meta: RenderMeta = {
    templateId: template.id,
    templateVersion: template.version,
    format: template.format,
    renderedAt: now,
    sourceDigest,
    recordCount: projectedRows.length,
  };

  // 6. Format-engine dispatch (closed map, FF-FORMAT-CLOSED)
  const renderer = RENDERERS[template.format];
  const { bytes } = renderer.render(template, projectedRows, meta);

  // 7. Audit: doc.render (FF-AUDIT-EVERY-RENDER)
  await deps.audit?.emit(makeAuditEvent("doc.render", subject, params, template, {
    format: template.format,
    record_count: projectedRows.length,
    source_digest: sourceDigest,
    renderedAt: now,
  }));

  return { denied: false, bytes, format: template.format, meta };
}

// ---------------------------------------------------------------------------
// renderAndFix — composition: render → addVersion(isSnapshot=true) → audit (§2.5)
// ---------------------------------------------------------------------------

export type RenderAndFixResult =
  | { denied: true; reason: string }
  | { denied: false; versionId: string; meta: RenderMeta };

/**
 * Render and immediately fix as an immutable snapshot (FR-3, §2.5).
 *
 * 1. render(...) — produce bytes.
 * 2. addVersion(isSnapshot=true) via SnapshotPort (T-0119 contract, FF-SNAPSHOT-IMMUTABLE).
 * 3. doc.snapshot_fixed audit event linking (templateId, templateVersion, sourceDigest) ↔ versionId.
 *
 * After fixation, download (doc_mode='snapshot') = presignGet(file_version) — byte-identical
 * even after source record mutations (NF-2 / FF-REPRODUCIBLE / AC-13).
 */
export async function renderAndFix(
  deps: RenderAndFixDeps,
  templateId: string,
  params: RenderParams,
  subject: ResolveSubject,
): Promise<RenderAndFixResult> {
  // 1. render
  const result = await render(deps, templateId, params, subject);
  if (result.denied) {
    return { denied: true, reason: result.reason };
  }

  // 2. addVersion(isSnapshot=true) — via T-0119 port (FF-SNAPSHOT-IMMUTABLE)
  const snapResult = await deps.snapshot.addVersion(
    deps.fileId,
    subject,
    result.bytes,
    {
      mime: mimeOf(result.format),
      isSnapshot: true,
      dataClass: "internal",
    },
  );

  if (snapResult.denied) {
    return { denied: true, reason: snapResult.reason };
  }

  // 3. doc.snapshot_fixed audit (FF-AUDIT-EVERY-RENDER)
  const template = await deps.templates.getTemplate(subject.tenantId, templateId);
  if (template !== null) {
    await deps.audit?.emit(makeAuditEvent("doc.snapshot_fixed", subject, params, template, {
      version_id: snapResult.versionId,
      is_snapshot: true,
      source_digest: result.meta.sourceDigest,
      renderedAt: result.meta.renderedAt,
      record_count: result.meta.recordCount,
    }));
  }

  return { denied: false, versionId: snapResult.versionId, meta: result.meta };
}
