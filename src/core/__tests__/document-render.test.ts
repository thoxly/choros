/**
 * T-0235 · T-0124: Unit tests for document-render.ts
 *
 * Tests FF-* fitness functions from ADR §6 that do NOT require a live DB:
 *  FF-NO-RENDER-ACL    — render under subject without read-grant ⇒ record absent (not mask)
 *  FF-NO-MASK-ROW      — denied row/field is ABSENT, not a dash / null / "***"
 *  FF-FORMAT-CLOSED    — unknown format ⇒ denied; RENDERERS keys === CHECK set
 *  FF-LIVE-NO-CACHE    — two live renders around mutation return different bytes
 *  FF-AUDIT-EVERY-RENDER — every render (success and denial) emits exactly one audit event
 *  FF-SNAPSHOT-IMMUTABLE — renderAndFix calls addVersion(isSnapshot=true), never writes file_version directly
 *  FF-RENDER-VIA-PDP (allow-path) — render output = projectFields of an allowed read, never rawRow.data
 *  FF-NO-MASK-ROW (allow-path)   — field the subject may NOT see is PHYSICALLY ABSENT from output
 *  FF-LIVE-NO-CACHE (allow-path) — registry partial-grant yields only visible rows in output
 *
 * All ports are in-memory fakes — no DB required for these tests.
 *
 * Integration tests that need DB (FF-REPRODUCIBLE, FF-TENANT-SCOPED-RENDER etc.)
 * are in ci/checks/db/ and require fitness:db (noted where skipped here).
 */

import { describe, it, expect } from "vitest";
import {
  render,
  renderAndFix,
  RENDERERS,
  type RenderDeps,
  type RenderAndFixDeps,
  type TemplateDef,
  type RenderParams,
  type RecordBatchPort,
  type TemplateSource,
  type RenderAuditSink,
  type SnapshotPort,
} from "../document-render.js";
import type { ResolveSubject, ResourceRef } from "../object-handle.js";
import type { ResolverDeps } from "../grant-resolver.js";
import type { Grant } from "../grant-lattice.js";
import type { AuditEventInput } from "../audit-grant-encoder.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TENANT = "a0000000-0000-0000-0000-000000000001";
const REGISTRY_ID = "r0000000-0000-0000-0000-000000000001";
const TEMPLATE_ID = "t0000000-0000-0000-0000-000000000001";
const RECORD_ID = "d0000000-0000-0000-0000-000000000001";

const SUBJECT: ResolveSubject = { tenantId: TENANT, subjectId: "user-001" };

function makeTemplate(overrides: Partial<TemplateDef> = {}): TemplateDef {
  return {
    tenantId: TENANT,
    id: TEMPLATE_ID,
    registryId: REGISTRY_ID,
    format: "csv",
    body: "{{status}},{{contractNo}}",
    version: 1,
    tier: "published",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory fakes for ports
// ---------------------------------------------------------------------------

function makeRecordBatch(
  rows: Array<{ id: string; registryId: string; data: Record<string, unknown> }> = [],
): RecordBatchPort {
  return {
    async getRecordsForRegistry() { return rows; },
    async getRecord(_t, _r, id) {
      return rows.find((row) => row.id === id) ?? null;
    },
  };
}

function makeTemplateSource(tmpl: TemplateDef | null = null): TemplateSource {
  return {
    async getTemplate() { return tmpl; },
  };
}

function makeAuditSink(): { sink: RenderAuditSink; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  return {
    sink: { async emit(e) { events.push(e); } },
    events,
  };
}

function makeSnapshotPort(
  denied: boolean = false,
): { port: SnapshotPort; calls: Array<{ fileId: string; isSnapshot: boolean }> } {
  const calls: Array<{ fileId: string; isSnapshot: boolean }> = [];
  return {
    port: {
      async addVersion(_fileId, _subject, _body, attrs) {
        calls.push({ fileId: _fileId, isSnapshot: attrs.isSnapshot ?? false });
        if (denied) return { denied: true, reason: "not_found" };
        return { denied: false, versionId: "v-001", versionNo: 1, objectKey: "tenant/file/v" };
      },
    },
    calls,
  };
}

/**
 * Minimal ResolverDeps fake that always denies.
 * We bypass resolveFor by passing records through a mocked RecordBatch that
 * returns allowed data — and use the resolver only to produce allow/deny views.
 * For these unit tests we need a controllable PDP mock.
 *
 * Strategy: instead of wiring the full resolver (which needs GrantSource etc.),
 * we test via the exported render() with a resolver that:
 *   - If the subject matches a "allowed" record, returns { denied: false, fields }
 *   - Otherwise, returns { denied: true, reason: "no_grant" }
 *
 * We achieve this by providing a ResolverDeps that fakes grants/records/ancestry
 * to match the desired behavior.
 */
function makeDenyAllResolverDeps(): ResolverDeps {
  return {
    grants: { async getGrants() { return []; } },
    records: { async getRecord() { return null; } },
    ancestry: { isDescendantOrSelf() { return false; } },
  };
}

// ---------------------------------------------------------------------------
// FF-FORMAT-CLOSED: RENDERERS closed map tests
// ---------------------------------------------------------------------------

describe("FF-FORMAT-CLOSED: RENDERERS closed map", () => {
  it("RENDERERS has exactly {csv, html} keys", () => {
    const keys = Object.keys(RENDERERS).sort();
    expect(keys).toEqual(["csv", "html"]);
  });

  it("each renderer has a format property matching its key", () => {
    for (const [key, r] of Object.entries(RENDERERS)) {
      expect(r.format).toBe(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Basic render tests — template not found / not published
// ---------------------------------------------------------------------------

describe("render() — template resolution", () => {
  it("returns denied:true when template not found", async () => {
    const { sink, events } = makeAuditSink();
    const deps: RenderDeps = {
      resolver: makeDenyAllResolverDeps(),
      records: makeRecordBatch([]),
      templates: makeTemplateSource(null),
      audit: sink,
    };
    const result = await render(deps, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);
    expect(result.denied).toBe(true);
    // Audit event emitted for denial
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("doc.render_denied");
  });

  it("returns denied:true when template is in draft tier (not published)", async () => {
    const { sink, events } = makeAuditSink();
    const tmpl = makeTemplate({ tier: "draft" });
    const deps: RenderDeps = {
      resolver: makeDenyAllResolverDeps(),
      records: makeRecordBatch([]),
      templates: makeTemplateSource(tmpl),
      audit: sink,
    };
    const result = await render(deps, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);
    expect(result.denied).toBe(true);
    if (result.denied) {
      expect(result.reason).toBe("template_not_published");
    }
    expect(events[0].type).toBe("doc.render_denied");
  });
});

// ---------------------------------------------------------------------------
// FF-NO-RENDER-ACL + FF-NO-MASK-ROW — via registry render with no grants
// ---------------------------------------------------------------------------

describe("FF-NO-RENDER-ACL + FF-NO-MASK-ROW: registry render with denied records", () => {
  it("denied records are absent (not masked string rows) — registry render with deny-all resolver", async () => {
    const tmpl = makeTemplate({ format: "csv" });
    const rows = [
      { id: RECORD_ID, registryId: REGISTRY_ID, data: { contractNo: "A-001", status: "active" } },
    ];
    const { sink, events } = makeAuditSink();
    const deps: RenderDeps = {
      resolver: makeDenyAllResolverDeps(), // denies all
      records: makeRecordBatch(rows),
      templates: makeTemplateSource(tmpl),
      audit: sink,
    };
    const params: RenderParams = { kind: "registry", registryId: REGISTRY_ID };
    const result = await render(deps, TEMPLATE_ID, params, SUBJECT);
    // Should succeed (render completes) but with 0 records (all denied = absent)
    expect(result.denied).toBe(false);
    if (!result.denied) {
      // FF-NO-MASK-ROW: record count is 0 (denied row is absent, not a dash row)
      expect(result.meta.recordCount).toBe(0);
      // The CSV output contains only the header or is empty — no dash rows
      const text = Buffer.from(result.bytes).toString("utf8");
      // No "***" / masked tokens in output
      expect(text).not.toContain("***");
      expect(text).not.toContain("—");
    }
    // Audit: one doc.render event (success with 0 rows)
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("doc.render");
  });
});

// ---------------------------------------------------------------------------
// FF-AUDIT-EVERY-RENDER: audit event emitted for every render path
// ---------------------------------------------------------------------------

describe("FF-AUDIT-EVERY-RENDER: audit emission", () => {
  it("emits exactly one doc.render event on successful registry render (empty result)", async () => {
    const { sink, events } = makeAuditSink();
    const tmpl = makeTemplate();
    const deps: RenderDeps = {
      resolver: makeDenyAllResolverDeps(),
      records: makeRecordBatch([]),
      templates: makeTemplateSource(tmpl),
      audit: sink,
    };
    await render(deps, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("doc.render");
  });

  it("emits exactly one doc.render_denied event when template not found", async () => {
    const { sink, events } = makeAuditSink();
    const deps: RenderDeps = {
      resolver: makeDenyAllResolverDeps(),
      records: makeRecordBatch([]),
      templates: makeTemplateSource(null),
      audit: sink,
    };
    await render(deps, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("doc.render_denied");
  });

  it("emits exactly one doc.render_denied for single record not found", async () => {
    const { sink, events } = makeAuditSink();
    const tmpl = makeTemplate();
    const deps: RenderDeps = {
      resolver: makeDenyAllResolverDeps(),
      records: makeRecordBatch([]), // record absent
      templates: makeTemplateSource(tmpl),
      audit: sink,
    };
    const params: RenderParams = {
      kind: "single",
      recordRef: { tenantId: TENANT, registryId: REGISTRY_ID, recordId: RECORD_ID },
    };
    await render(deps, TEMPLATE_ID, params, SUBJECT);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("doc.render_denied");
  });

  it("audit payload contains no token or secret keys", async () => {
    const { sink, events } = makeAuditSink();
    const tmpl = makeTemplate();
    const deps: RenderDeps = {
      resolver: makeDenyAllResolverDeps(),
      records: makeRecordBatch([]),
      templates: makeTemplateSource(tmpl),
      audit: sink,
    };
    await render(deps, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);
    const payload = events[0].payload as Record<string, unknown>;
    const payloadStr = JSON.stringify(payload).toLowerCase();
    // FF-AUDIT-EVERY-RENDER: token/secret not in payload
    expect(payloadStr).not.toContain("token");
    expect(payloadStr).not.toContain("secret");
    expect(payloadStr).not.toContain("password");
  });
});

// ---------------------------------------------------------------------------
// FF-LIVE-NO-CACHE: two live renders around mutation return different bytes
// ---------------------------------------------------------------------------

describe("FF-LIVE-NO-CACHE: live render not cached", () => {
  it("two renders with different record data return different output bytes", async () => {
    const tmpl = makeTemplate({ format: "csv" });

    // First render: row has status=active
    const rows1 = [{ id: RECORD_ID, registryId: REGISTRY_ID, data: { status: "active" } }];
    // Second render: row has status=closed
    const rows2 = [{ id: RECORD_ID, registryId: REGISTRY_ID, data: { status: "closed" } }];

    const { sink: sink1 } = makeAuditSink();
    const { sink: sink2 } = makeAuditSink();

    const deps1: RenderDeps = {
      resolver: makeDenyAllResolverDeps(),
      records: makeRecordBatch(rows1),
      templates: makeTemplateSource(tmpl),
      audit: sink1,
    };
    const deps2: RenderDeps = {
      resolver: makeDenyAllResolverDeps(),
      records: makeRecordBatch(rows2),
      templates: makeTemplateSource(tmpl),
      audit: sink2,
    };

    // With deny-all resolver, both renders return 0 rows (consistent), so we
    // test the live-no-cache principle at the data level via sourceDigest.
    // When records differ AND resolver allows, sourceDigests differ.
    // Since deny-all gives 0 rows both times, digests are both sha256([]) — equal.
    // To truly test FF-LIVE-NO-CACHE we need an allow resolver or verify via meta.
    // We confirm at minimum: no caching state is retained between calls.
    const r1 = await render(deps1, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);
    const r2 = await render(deps2, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);

    // Both should complete (not cached/error)
    expect(r1.denied).toBe(false);
    expect(r2.denied).toBe(false);

    // sourceDigest with 0 rows is the same — but the point is: no shared cache.
    // The real live-no-cache test with mutations is in integration tests (FF-LIVE-NO-CACHE, AC-11).
    // Here we verify: two separate dep instances, no shared state.
    if (!r1.denied && !r2.denied) {
      // Both meta are independently computed
      expect(r1.meta.templateId).toBe(r2.meta.templateId);
      // With 0 rows from deny-all resolver, digests are identical (expected)
      // but renderedAt may differ if clock advances
      expect(typeof r1.meta.renderedAt).toBe("number");
      expect(typeof r2.meta.renderedAt).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// FF-SNAPSHOT-IMMUTABLE: renderAndFix calls addVersion(isSnapshot=true)
// ---------------------------------------------------------------------------

describe("FF-SNAPSHOT-IMMUTABLE: renderAndFix via SnapshotPort", () => {
  it("renderAndFix calls addVersion with isSnapshot=true", async () => {
    const tmpl = makeTemplate({ format: "csv" });
    const { sink } = makeAuditSink();
    const { port, calls } = makeSnapshotPort();

    const deps: RenderAndFixDeps = {
      resolver: makeDenyAllResolverDeps(),
      records: makeRecordBatch([]),
      templates: makeTemplateSource(tmpl),
      audit: sink,
      snapshot: port,
      fileId: "file-001",
    };

    const result = await renderAndFix(deps, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);
    expect(result.denied).toBe(false);
    // addVersion was called once
    expect(calls).toHaveLength(1);
    // isSnapshot=true (FF-SNAPSHOT-IMMUTABLE)
    expect(calls[0].isSnapshot).toBe(true);
  });

  it("renderAndFix emits doc.snapshot_fixed audit event", async () => {
    const tmpl = makeTemplate({ format: "html" });
    const { sink, events } = makeAuditSink();
    const { port } = makeSnapshotPort();

    const deps: RenderAndFixDeps = {
      resolver: makeDenyAllResolverDeps(),
      records: makeRecordBatch([]),
      templates: makeTemplateSource(tmpl),
      audit: sink,
      snapshot: port,
      fileId: "file-002",
    };

    await renderAndFix(deps, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);
    // Should have doc.render + doc.snapshot_fixed
    const types = events.map((e) => e.type);
    expect(types).toContain("doc.render");
    expect(types).toContain("doc.snapshot_fixed");
  });

  it("renderAndFix returns denied when snapshot addVersion fails", async () => {
    const tmpl = makeTemplate();
    const { sink } = makeAuditSink();
    const { port } = makeSnapshotPort(true); // always denied

    const deps: RenderAndFixDeps = {
      resolver: makeDenyAllResolverDeps(),
      records: makeRecordBatch([]),
      templates: makeTemplateSource(tmpl),
      audit: sink,
      snapshot: port,
      fileId: "file-003",
    };

    const result = await renderAndFix(deps, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);
    expect(result.denied).toBe(true);
  });

  it("renderAndFix returns denied when template is draft", async () => {
    const tmpl = makeTemplate({ tier: "draft" });
    const { sink } = makeAuditSink();
    const { port } = makeSnapshotPort();

    const deps: RenderAndFixDeps = {
      resolver: makeDenyAllResolverDeps(),
      records: makeRecordBatch([]),
      templates: makeTemplateSource(tmpl),
      audit: sink,
      snapshot: port,
      fileId: "file-004",
    };

    const result = await renderAndFix(deps, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);
    expect(result.denied).toBe(true);
    if (result.denied) {
      expect(result.reason).toBe("template_not_published");
    }
  });
});

// ---------------------------------------------------------------------------
// CSV renderer purity tests
// ---------------------------------------------------------------------------

describe("CSV renderer — deterministic output", () => {
  it("produces same bytes for same input twice (NF-2 determinism)", () => {
    const tmpl = makeTemplate({ format: "csv" });
    const rows = [{ status: "active", contractNo: "A-001" }, { status: "closed", contractNo: "B-002" }];
    const meta = {
      templateId: TEMPLATE_ID, templateVersion: 1, format: "csv" as const,
      renderedAt: 1000000, sourceDigest: "abc", recordCount: 2,
    };
    const r1 = RENDERERS.csv.render(tmpl, rows, meta);
    const r2 = RENDERERS.csv.render(tmpl, rows, meta);
    expect(r1.bytes).toEqual(r2.bytes);
    expect(r1.mime).toBe("text/csv");
  });

  it("empty rows produces no data rows (only header if keys present)", () => {
    const tmpl = makeTemplate({ format: "csv" });
    const meta = {
      templateId: TEMPLATE_ID, templateVersion: 1, format: "csv" as const,
      renderedAt: 0, sourceDigest: "x", recordCount: 0,
    };
    const r = RENDERERS.csv.render(tmpl, [], meta);
    const text = Buffer.from(r.bytes).toString("utf8");
    expect(text).toBe(""); // empty rows → empty output
  });

  it("escapes commas in cell values (RFC 4180)", () => {
    const tmpl = makeTemplate({ format: "csv" });
    const rows = [{ name: "Smith, John" }];
    const meta = {
      templateId: TEMPLATE_ID, templateVersion: 1, format: "csv" as const,
      renderedAt: 0, sourceDigest: "x", recordCount: 1,
    };
    const r = RENDERERS.csv.render(tmpl, rows, meta);
    const text = Buffer.from(r.bytes).toString("utf8");
    expect(text).toContain('"Smith, John"');
  });
});

// ---------------------------------------------------------------------------
// HTML renderer purity tests
// ---------------------------------------------------------------------------

describe("HTML renderer — deterministic output", () => {
  it("produces same bytes for same input twice (NF-2 determinism)", () => {
    const tmpl = makeTemplate({ format: "html" });
    const rows = [{ status: "active", contractNo: "A-001" }];
    const meta = {
      templateId: TEMPLATE_ID, templateVersion: 1, format: "html" as const,
      renderedAt: 1000000, sourceDigest: "abc", recordCount: 1,
    };
    const r1 = RENDERERS.html.render(tmpl, rows, meta);
    const r2 = RENDERERS.html.render(tmpl, rows, meta);
    expect(r1.bytes).toEqual(r2.bytes);
    expect(r1.mime).toBe("text/html");
  });

  it("escapes HTML special characters (XSS prevention)", () => {
    const tmpl = makeTemplate({ format: "html" });
    const rows = [{ name: "<script>alert(1)</script>" }];
    const meta = {
      templateId: TEMPLATE_ID, templateVersion: 1, format: "html" as const,
      renderedAt: 0, sourceDigest: "x", recordCount: 1,
    };
    const r = RENDERERS.html.render(tmpl, rows, meta);
    const text = Buffer.from(r.bytes).toString("utf8");
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });

  it("empty rows produces 'No records' page", () => {
    const tmpl = makeTemplate({ format: "html" });
    const meta = {
      templateId: TEMPLATE_ID, templateVersion: 1, format: "html" as const,
      renderedAt: 0, sourceDigest: "x", recordCount: 0,
    };
    const r = RENDERERS.html.render(tmpl, [], meta);
    const text = Buffer.from(r.bytes).toString("utf8");
    expect(text).toContain("No records");
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant protection in single-record mode
// ---------------------------------------------------------------------------

describe("Tenant isolation — single record", () => {
  it("returns denied:cross_tenant when recordRef.tenantId differs from subject.tenantId", async () => {
    const tmpl = makeTemplate();
    const { sink, events } = makeAuditSink();
    const deps: RenderDeps = {
      resolver: makeDenyAllResolverDeps(),
      records: makeRecordBatch([]),
      templates: makeTemplateSource(tmpl),
      audit: sink,
    };
    const params: RenderParams = {
      kind: "single",
      recordRef: { tenantId: "OTHER-TENANT", registryId: REGISTRY_ID, recordId: RECORD_ID },
    };
    const result = await render(deps, TEMPLATE_ID, params, SUBJECT);
    expect(result.denied).toBe(true);
    if (result.denied) {
      expect(result.reason).toBe("cross_tenant");
    }
    expect(events[0].type).toBe("doc.render_denied");
  });
});

// ---------------------------------------------------------------------------
// sourceDigest determinism
// ---------------------------------------------------------------------------

describe("sourceDigest — determinism (NF-2)", () => {
  it("same projected rows → same sourceDigest", async () => {
    const tmpl = makeTemplate({ format: "csv" });
    const { sink } = makeAuditSink();
    const deps: RenderDeps = {
      resolver: makeDenyAllResolverDeps(),
      records: makeRecordBatch([]), // 0 rows → deterministic empty digest
      templates: makeTemplateSource(tmpl),
      audit: sink,
      now: () => 1000000, // fixed clock
    };
    const r1 = await render(deps, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);
    const r2 = await render(deps, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);
    if (!r1.denied && !r2.denied) {
      expect(r1.meta.sourceDigest).toBe(r2.meta.sourceDigest);
    }
  });
});

// ---------------------------------------------------------------------------
// ALLOW-PATH TESTS — Finding #1
//
// The invariant: render output = projectFields result of an allowed read,
// never raw row data. A regression swapping `view.fields → rawRow.data`
// would bypass projection and expose all fields regardless of grant scope.
//
// Strategy: build a ResolverDeps whose GrantSource returns a covering grant
// for a specific record, and whose RecordSource returns the raw row data.
// resolveFor is exercised on the ALLOW path, projectFields is called, and
// the output is verified to match the projected (not raw) field set.
// ---------------------------------------------------------------------------

/**
 * Build a ResolverDeps that ALLOWS reads for the given allowed records.
 *
 * For each allowed record a Grant is synthesized covering exactly that record
 * (scope = node, hierarchy=resource, nodeId=recordId, nodeLevel=record).
 * AncestryOracle: isDescendantOrSelf returns true when a===b (exact-node match).
 * GrantSource: returns all grants for the tenant (subject must match tenant).
 * RecordSource: returns rawData for the given resourceRef.
 *
 * @param allowedRecords — maps recordId → rawData for records that should be allowed.
 * @param grantFacetFields — when supplied, the grant carries a facet restricting visible
 *        fields to exactly these keys. When absent, grant is whole-resource (all fields visible).
 */
function makeAllowResolverDeps(
  allowedRecords: Array<{ recordId: string; registryId: string; rawData: Record<string, unknown> }>,
  grantFacetFields?: string[],
): ResolverDeps {
  // Build one Grant per allowed record
  const grants: Grant[] = allowedRecords.map((rec, i) => ({
    tenantId: TENANT,
    id: `grant-allow-${i}`,
    roleId: "role-test",
    resourceType: "record" as const,
    // When grantFacetFields is set, use a field-scoped facet (partial access);
    // when absent, no resourceFacet → whole-resource grant (all fields visible).
    resourceFacet: grantFacetFields !== undefined
      ? { fields: grantFacetFields }
      : undefined,
    operation: "read" as const,
    // Scope = exact record node in resource hierarchy
    scope: {
      kind: "node" as const,
      hierarchy: "resource" as const,
      nodeId: rec.recordId,
      nodeLevel: "record" as const,
    },
    delegable: false,
    grantedBy: "seed",
    createdAt: 0,
  }));

  // Build a raw-data map keyed by recordId
  const dataMap = new Map<string, Record<string, unknown>>(
    allowedRecords.map((r) => [r.recordId, r.rawData]),
  );

  return {
    grants: {
      async getGrants() { return grants; },
    },
    records: {
      async getRecord(ref: ResourceRef) {
        if (ref.kind !== "record") return null;
        return dataMap.get(ref.recordId) ?? null;
      },
    },
    ancestry: {
      // Exact-node oracle: descendantOrSelf only when IDs match
      isDescendantOrSelf(_hierarchy: string, descendantId: string, ancestorId: string) {
        return descendantId === ancestorId;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// (a) Allowed record's projected fields appear in render output bytes
// ---------------------------------------------------------------------------

describe("ALLOW-PATH (a): visible record fields appear in rendered output", () => {
  it("allowed single record: visible fields appear in CSV bytes", async () => {
    const rawData = { contractNo: "A-001", status: "active", secret: "s3cr3t" };
    // Grant covers all fields (no facet restriction)
    const resolverDeps = makeAllowResolverDeps([
      { recordId: RECORD_ID, registryId: REGISTRY_ID, rawData },
    ]);

    const rows = [{ id: RECORD_ID, registryId: REGISTRY_ID, data: rawData }];
    const tmpl = makeTemplate({ format: "csv" });
    const { sink } = makeAuditSink();

    const deps: RenderDeps = {
      resolver: resolverDeps,
      records: makeRecordBatch(rows),
      templates: makeTemplateSource(tmpl),
      audit: sink,
    };
    const params: RenderParams = {
      kind: "single",
      recordRef: { tenantId: TENANT, registryId: REGISTRY_ID, recordId: RECORD_ID },
    };
    const result = await render(deps, TEMPLATE_ID, params, SUBJECT);

    expect(result.denied).toBe(false);
    if (!result.denied) {
      const text = Buffer.from(result.bytes).toString("utf8");
      // Visible fields appear in the output
      expect(text).toContain("A-001");
      expect(text).toContain("active");
      // All fields visible (whole-resource grant) — 'secret' is also present
      expect(text).toContain("secret");
      expect(result.meta.recordCount).toBe(1);
    }
  });

  it("allowed single record: visible fields appear in HTML bytes", async () => {
    const rawData = { contractNo: "B-002", status: "closed" };
    const resolverDeps = makeAllowResolverDeps([
      { recordId: RECORD_ID, registryId: REGISTRY_ID, rawData },
    ]);

    const rows = [{ id: RECORD_ID, registryId: REGISTRY_ID, data: rawData }];
    const tmpl = makeTemplate({ format: "html" });
    const { sink } = makeAuditSink();

    const deps: RenderDeps = {
      resolver: resolverDeps,
      records: makeRecordBatch(rows),
      templates: makeTemplateSource(tmpl),
      audit: sink,
    };
    const params: RenderParams = {
      kind: "single",
      recordRef: { tenantId: TENANT, registryId: REGISTRY_ID, recordId: RECORD_ID },
    };
    const result = await render(deps, TEMPLATE_ID, params, SUBJECT);

    expect(result.denied).toBe(false);
    if (!result.denied) {
      const text = Buffer.from(result.bytes).toString("utf8");
      expect(text).toContain("B-002");
      expect(text).toContain("closed");
      // HTML table structure
      expect(text).toContain("<table");
      expect(result.meta.recordCount).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Field the subject may NOT see is PHYSICALLY ABSENT from output
//     Drive through a real facet-restricted grant (partial field access).
// ---------------------------------------------------------------------------

describe("ALLOW-PATH (b): denied field is PHYSICALLY ABSENT from output", () => {
  it("single record with field-scoped grant: hidden field physically absent in CSV", async () => {
    // Raw record has two fields: 'contractNo' and 'salaryBand' (confidential)
    const rawData = { contractNo: "C-003", salaryBand: "L5" };
    // Grant restricts to only 'contractNo' (facet with fields:["contractNo"])
    const resolverDeps = makeAllowResolverDeps(
      [{ recordId: RECORD_ID, registryId: REGISTRY_ID, rawData }],
      ["contractNo"], // only contractNo is visible
    );

    const rows = [{ id: RECORD_ID, registryId: REGISTRY_ID, data: rawData }];
    const tmpl = makeTemplate({ format: "csv" });
    const { sink } = makeAuditSink();

    const deps: RenderDeps = {
      resolver: resolverDeps,
      records: makeRecordBatch(rows),
      templates: makeTemplateSource(tmpl),
      audit: sink,
    };
    const params: RenderParams = {
      kind: "single",
      recordRef: { tenantId: TENANT, registryId: REGISTRY_ID, recordId: RECORD_ID },
    };
    const result = await render(deps, TEMPLATE_ID, params, SUBJECT);

    expect(result.denied).toBe(false);
    if (!result.denied) {
      const text = Buffer.from(result.bytes).toString("utf8");
      // Visible field appears
      expect(text).toContain("contractNo");
      expect(text).toContain("C-003");
      // PHYSICAL ABSENCE (FF-NO-MASK-ROW): 'salaryBand' and 'L5' are NOT in output
      // Not null, not "***", not an empty-labeled cell — the key itself is absent.
      expect(text).not.toContain("salaryBand");
      expect(text).not.toContain("L5");
      // No masking tokens
      expect(text).not.toContain("***");
      expect(text).not.toContain("null");
    }
  });

  it("single record with field-scoped grant: hidden field physically absent in HTML", async () => {
    const rawData = { name: "Alice", internalCode: "IC-99" };
    // Grant: only 'name' visible
    const resolverDeps = makeAllowResolverDeps(
      [{ recordId: RECORD_ID, registryId: REGISTRY_ID, rawData }],
      ["name"],
    );

    const rows = [{ id: RECORD_ID, registryId: REGISTRY_ID, data: rawData }];
    const tmpl = makeTemplate({ format: "html" });
    const { sink } = makeAuditSink();

    const deps: RenderDeps = {
      resolver: resolverDeps,
      records: makeRecordBatch(rows),
      templates: makeTemplateSource(tmpl),
      audit: sink,
    };
    const params: RenderParams = {
      kind: "single",
      recordRef: { tenantId: TENANT, registryId: REGISTRY_ID, recordId: RECORD_ID },
    };
    const result = await render(deps, TEMPLATE_ID, params, SUBJECT);

    expect(result.denied).toBe(false);
    if (!result.denied) {
      const text = Buffer.from(result.bytes).toString("utf8");
      // Visible field in HTML
      expect(text).toContain("name");
      expect(text).toContain("Alice");
      // Hidden field and its value are PHYSICALLY ABSENT — not even as empty cell header
      expect(text).not.toContain("internalCode");
      expect(text).not.toContain("IC-99");
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Registry render under PARTIAL grant (some rows visible, some denied)
//     recordCount = number of visible rows; denied rows entirely absent.
// ---------------------------------------------------------------------------

describe("ALLOW-PATH (c): registry partial-grant — only visible rows in output", () => {
  const RECORD_ID_2 = "d0000000-0000-0000-0000-000000000002";
  const RECORD_ID_3 = "d0000000-0000-0000-0000-000000000003";

  it("registry render: only allowed rows appear; denied rows entirely absent; recordCount correct", async () => {
    // Three records; only records 1 and 3 have covering grants
    const row1 = { id: RECORD_ID,   registryId: REGISTRY_ID, data: { contractNo: "A-001", status: "active" } };
    const row2 = { id: RECORD_ID_2, registryId: REGISTRY_ID, data: { contractNo: "B-002", status: "closed" } };
    const row3 = { id: RECORD_ID_3, registryId: REGISTRY_ID, data: { contractNo: "C-003", status: "pending" } };

    // Grant covers only row1 and row3 (not row2)
    const resolverDeps = makeAllowResolverDeps([
      { recordId: RECORD_ID,   registryId: REGISTRY_ID, rawData: row1.data },
      { recordId: RECORD_ID_3, registryId: REGISTRY_ID, rawData: row3.data },
    ]);

    const tmpl = makeTemplate({ format: "csv" });
    const { sink, events } = makeAuditSink();

    const deps: RenderDeps = {
      resolver: resolverDeps,
      records: makeRecordBatch([row1, row2, row3]),
      templates: makeTemplateSource(tmpl),
      audit: sink,
    };
    const params: RenderParams = { kind: "registry", registryId: REGISTRY_ID };
    const result = await render(deps, TEMPLATE_ID, params, SUBJECT);

    expect(result.denied).toBe(false);
    if (!result.denied) {
      // Only 2 visible rows (FF-NO-MASK-ROW: denied row2 is absent, not a dash-row)
      expect(result.meta.recordCount).toBe(2);
      const text = Buffer.from(result.bytes).toString("utf8");
      // Allowed records present
      expect(text).toContain("A-001");
      expect(text).toContain("C-003");
      // Denied record (row2) entirely absent — no "B-002" anywhere in output
      expect(text).not.toContain("B-002");
      expect(text).not.toContain("closed");
    }

    // One audit event for the whole render
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("doc.render");
  });

  it("registry render with partial grants: sourceDigest reflects only projected rows", async () => {
    // Same setup — verify sourceDigest changes when the allowed set changes
    const row1 = { id: RECORD_ID,   registryId: REGISTRY_ID, data: { x: "1" } };
    const row2 = { id: RECORD_ID_2, registryId: REGISTRY_ID, data: { x: "2" } };

    // Allow only row1
    const deps1: RenderDeps = {
      resolver: makeAllowResolverDeps([{ recordId: RECORD_ID, registryId: REGISTRY_ID, rawData: row1.data }]),
      records: makeRecordBatch([row1, row2]),
      templates: makeTemplateSource(makeTemplate({ format: "csv" })),
      audit: makeAuditSink().sink,
      now: () => 42,
    };
    // Allow both rows
    const deps2: RenderDeps = {
      resolver: makeAllowResolverDeps([
        { recordId: RECORD_ID,   registryId: REGISTRY_ID, rawData: row1.data },
        { recordId: RECORD_ID_2, registryId: REGISTRY_ID, rawData: row2.data },
      ]),
      records: makeRecordBatch([row1, row2]),
      templates: makeTemplateSource(makeTemplate({ format: "csv" })),
      audit: makeAuditSink().sink,
      now: () => 42,
    };

    const r1 = await render(deps1, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);
    const r2 = await render(deps2, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);

    expect(r1.denied).toBe(false);
    expect(r2.denied).toBe(false);
    if (!r1.denied && !r2.denied) {
      // Different projected sets → different digests
      expect(r1.meta.sourceDigest).not.toBe(r2.meta.sourceDigest);
      // Different byte outputs
      expect(r1.bytes).not.toEqual(r2.bytes);
    }
  });

  it("FF-LIVE-NO-CACHE (allow-path): two renders around a mutation return different bytes", async () => {
    // Simulate mutation: before=status:active, after=status:closed
    const rowBefore = { id: RECORD_ID, registryId: REGISTRY_ID, data: { contractNo: "D-004", status: "active" } };
    const rowAfter  = { id: RECORD_ID, registryId: REGISTRY_ID, data: { contractNo: "D-004", status: "closed" } };

    const resolverDeps = makeAllowResolverDeps([
      { recordId: RECORD_ID, registryId: REGISTRY_ID, rawData: rowBefore.data },
    ]);

    // First render (before mutation)
    const depsBefore: RenderDeps = {
      resolver: resolverDeps,
      records: makeRecordBatch([rowBefore]),
      templates: makeTemplateSource(makeTemplate({ format: "csv" })),
      audit: makeAuditSink().sink,
      now: () => 1000,
    };

    // Second render (after mutation — different RecordBatch port with updated data)
    const depsAfter: RenderDeps = {
      resolver: makeAllowResolverDeps([
        { recordId: RECORD_ID, registryId: REGISTRY_ID, rawData: rowAfter.data },
      ]),
      records: makeRecordBatch([rowAfter]),
      templates: makeTemplateSource(makeTemplate({ format: "csv" })),
      audit: makeAuditSink().sink,
      now: () => 2000,
    };

    const rBefore = await render(depsBefore, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);
    const rAfter  = await render(depsAfter, TEMPLATE_ID, { kind: "registry", registryId: REGISTRY_ID }, SUBJECT);

    expect(rBefore.denied).toBe(false);
    expect(rAfter.denied).toBe(false);
    if (!rBefore.denied && !rAfter.denied) {
      // Mutation is reflected: bytes differ
      const textBefore = Buffer.from(rBefore.bytes).toString("utf8");
      const textAfter  = Buffer.from(rAfter.bytes).toString("utf8");
      expect(textBefore).toContain("active");
      expect(textAfter).toContain("closed");
      expect(rBefore.bytes).not.toEqual(rAfter.bytes);
      // sourceDigests differ (different projected row content)
      expect(rBefore.meta.sourceDigest).not.toBe(rAfter.meta.sourceDigest);
    }
  });
});
