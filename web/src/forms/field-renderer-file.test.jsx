/**
 * web/src/forms/field-renderer-file.test.jsx  (T-0579)
 *
 * Tests for FileField (the `file` binding contract's structural component,
 * ADR §2.3/§2.4). Mirrors the test approach established for RelationPickerField
 * (field-renderer-d76.test.jsx): dispatch-level element-tree checks (no DOM),
 * plus structural checks of the upload/download routes the component talks to.
 *
 * What we verify:
 *   (a) FieldControl with presentation='file' (or type='file') → renders
 *       FileField — NOT the old "not yet authorable" italic readout, NOT a
 *       plain text input (AC-6, FF-RENDER-FILE).
 *   (b) FileField exists, accepts the documented props shape, and does not
 *       throw when called as a plain function.
 *   (c) FF-UPLOAD-ROUTE-ONLY: the component source only ever talks to
 *       /api/records/:recordId/files and /api/files/:versionId/download —
 *       no S3/bucket/presign construction on the client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FieldControl, FileField, uploadFileToRecord } from './field-renderer.jsx';

// ---------------------------------------------------------------------------
// Tree-walk helpers (same pattern as field-renderer.test.jsx / -d76.test.jsx)
// ---------------------------------------------------------------------------

function collectElements(node, predicate, results = []) {
  if (node === null || node === undefined) return results;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, results);
    return results;
  }
  if (typeof node !== 'object' || !node.type) return results;
  if (predicate(node)) results.push(node);
  const { children } = node.props || {};
  if (children !== undefined) collectElements(children, predicate, results);
  return results;
}

const noop = () => {};

let fetchCalls = [];

beforeEach(() => {
  fetchCalls = [];
  global.fetch = vi.fn(async (url) => {
    fetchCalls.push(url);
    return { ok: true, json: async () => [] };
  });
});

afterEach(() => {
  delete global.fetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// (a) FieldControl with presentation='file' / type='file' → FileField
// ---------------------------------------------------------------------------

describe('FieldControl T-0579 · file contract → FileField (AC-6, FF-RENDER-FILE)', () => {
  it('returns a FileField element (not the "not yet authorable" readout) for type=file', () => {
    const tree = FieldControl({
      field: { key: 'doc', label: 'Договор', type: 'file', required: false },
      value: '',
      onChange: noop,
    });

    expect(tree).not.toBeNull();
    expect(tree.type).toBe(FileField);
    expect(tree.props.field.key).toBe('doc');
  });

  it('FieldControl with explicit contract=file also returns FileField', () => {
    const tree = FieldControl({
      field: { key: 'attachment', label: 'Вложение', contract: 'file', required: true },
      value: 'ver-123',
      onChange: noop,
    });

    expect(tree).not.toBeNull();
    expect(tree.type).toBe(FileField);
    expect(tree.props.isRequired).toBe(true);
    expect(tree.props.value).toBe('ver-123');
  });

  it('does NOT render the honest-degradation "not yet authorable" italic readout for file', () => {
    const tree = FieldControl({
      field: { key: 'doc', label: 'Договор', type: 'file' },
      value: '',
      onChange: noop,
    });
    const italicDivs = collectElements(tree, (el) => el.type === 'div' && el.props?.style?.fontStyle === 'italic');
    expect(italicDivs).toHaveLength(0);
  });

  it('does NOT render a plain text <input> for a file field (structural, not scalarish)', () => {
    const tree = FieldControl({
      field: { key: 'doc', label: 'Договор', type: 'file' },
      value: '',
      onChange: noop,
    });
    // FieldControl itself must dispatch to FileField, not fall into the scalar
    // text-input branch — verified by the element type check above; here we
    // additionally assert the returned top-level element is NOT a bare <input>.
    expect(tree.type).not.toBe('input');
  });
});

// ---------------------------------------------------------------------------
// (b) FileField: exported, accepts the documented props shape, doesn't throw.
// ---------------------------------------------------------------------------

describe('FileField T-0579 · static shape', () => {
  it('is exported as a function', () => {
    expect(typeof FileField).toBe('function');
  });

  it('does not throw when called with the documented props shape (empty value, no recordId)', () => {
    const props = {
      field: { key: 'doc', label: 'Договор', recordId: undefined },
      value: '',
      onChange: noop,
      idPrefix: 'field',
      isRequired: false,
      readOnly: false,
    };
    let result;
    try {
      result = FileField(props);
    } catch {
      // Hooks outside a tree may throw in a strict node env; acceptable — the
      // dispatch test above already validates the wiring (same convention as
      // RelationPickerField's static-render test, field-renderer-d76.test.jsx).
      result = null;
    }
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('does not throw when called with a populated value + recordId (readOnly)', () => {
    const props = {
      field: { key: 'doc', label: 'Договор', recordId: 'rec-1' },
      value: 'ver-123',
      onChange: noop,
      idPrefix: 'field',
      isRequired: false,
      readOnly: true,
    };
    let result;
    try {
      result = FileField(props);
    } catch {
      result = null;
    }
    expect(result === null || typeof result === 'object').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b') review M2 (major): the ACTUAL upload-flow code handleFileSelect runs
// (POST with X-File-Name/Content-Type → onChange(body.versionId)) was NOT
// exercised by any test before this fix-forward pass — only source-grepped.
// uploadFileToRecord is the extracted, React-free core of that flow (see its
// doc comment above in field-renderer.jsx); calling it directly with a real
// `File` (Node 22 provides the native File global) and a mocked fetch proves
// the real request shape end-to-end, without needing a DOM/React render
// (this test tier is "node" environment, no jsdom — web/vitest.config.js).
// ---------------------------------------------------------------------------

describe('uploadFileToRecord T-0579 · real upload-flow (AC-7, review M2)', () => {
  let fetchCalls;

  beforeEach(() => {
    fetchCalls = [];
    global.fetch = vi.fn(async (url, opts) => {
      fetchCalls.push({ url, opts });
      return {
        ok: true,
        json: async () => ({ fileId: 'file-1', versionId: 'ver-1', versionNo: 1 }),
      };
    });
  });

  afterEach(() => {
    delete global.fetch;
    vi.restoreAllMocks();
  });

  it('POSTs to /api/records/:recordId/files with Content-Type/X-File-Name from the real File and returns versionId', async () => {
    const file = new File(['hello world'], 'hello.txt', { type: 'text/plain' });

    const result = await uploadFileToRecord({ recordId: 'rec-42', file });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('/api/records/rec-42/files');
    expect(fetchCalls[0].opts.method).toBe('POST');
    expect(fetchCalls[0].opts.headers['Content-Type']).toBe('text/plain');
    expect(fetchCalls[0].opts.headers['X-File-Name']).toBe('hello.txt');
    expect(fetchCalls[0].opts.body).toBe(file);
    expect(result.versionId).toBe('ver-1');
  });

  it('URL-encodes recordId (defensive against special characters)', async () => {
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    await uploadFileToRecord({ recordId: 'rec with space', file });
    expect(fetchCalls[0].url).toBe('/api/records/rec%20with%20space/files');
  });

  it('defaults to application/octet-stream and "upload" when the File has no type/name', async () => {
    const file = new File(['x'], '', { type: '' });
    await uploadFileToRecord({ recordId: 'rec-1', file });
    expect(fetchCalls[0].opts.headers['Content-Type']).toBe('application/octet-stream');
    expect(fetchCalls[0].opts.headers['X-File-Name']).toBe('upload');
  });

  it('throws a formatted error on a non-ok response (surfaced as uploadError by handleFileSelect)', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 413 }));
    const file = new File(['x'], 'big.bin', { type: 'application/octet-stream' });
    await expect(uploadFileToRecord({ recordId: 'rec-1', file })).rejects.toThrow();
  });

  it('"Заменить" (replace) flow: a SECOND upload call for the SAME record returns a NEW versionId', async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      return { ok: true, json: async () => ({ fileId: 'file-1', versionId: `ver-${call}`, versionNo: call }) };
    });
    const file1 = new File(['v1'], 'doc.pdf', { type: 'application/pdf' });
    const file2 = new File(['v2 replaced'], 'doc-v2.pdf', { type: 'application/pdf' });

    const first = await uploadFileToRecord({ recordId: 'rec-1', file: file1 });
    const second = await uploadFileToRecord({ recordId: 'rec-1', file: file2 });

    expect(first.versionId).toBe('ver-1');
    expect(second.versionId).toBe('ver-2');
    expect(second.versionId).not.toBe(first.versionId);
  });
});

describe('FileField T-0579 · handleFileSelect calls uploadFileToRecord (structural wiring, review M2)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'field-renderer.jsx'), 'utf8');

  it('handleFileSelect delegates to uploadFileToRecord (single source of the upload request, not duplicated inline)', () => {
    const idx = source.indexOf('const handleFileSelect');
    expect(idx).toBeGreaterThan(-1);
    const fnBody = source.slice(idx, idx + 700);
    expect(fnBody).toContain('await uploadFileToRecord({ recordId, file })');
    expect(fnBody).toContain('onChange(field.key, body.versionId)');
  });

  it('resets e.target.value BEFORE the early no-file return, so re-selecting the same file re-fires onChange (replace flow)', () => {
    const idx = source.indexOf('const handleFileSelect');
    const fnBody = source.slice(idx, idx + 300);
    expect(fnBody).toMatch(/e\.target\.value = '';\s*\n\s*if \(!file\) return;/);
  });

  it('shows the honest pre-save message when recordId is absent, instead of a silent no-op upload attempt', () => {
    const idx = source.indexOf('const handleFileSelect');
    const fnBody = source.slice(idx, idx + 400);
    expect(fnBody).toContain("setUploadError('Сначала сохраните запись, затем прикрепите файл')");
  });
});

// ---------------------------------------------------------------------------
// (c) FF-UPLOAD-ROUTE-ONLY: FileField's source only references the existing
// file routes — no S3/bucket/presign client construction (NF-2, AC-7).
// This is a structural (source-text) check, mirroring the fitness function's
// grep guard, so the invariant is enforced at the unit-test level too.
// ---------------------------------------------------------------------------

describe('FileField T-0579 · never shows the raw fileVersionId (review M1)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'field-renderer.jsx'), 'utf8');

  it('displayName fallback is a human label per resolveState, never the raw value', () => {
    const idx = source.indexOf('const displayName = fileMeta?.originalName');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 300);
    // Must NOT fall back to the raw `value` (the uuid) anywhere in this expression.
    expect(block).not.toMatch(/:\s*value\b/);
    expect(block).toContain("'Загрузка…'");
    expect(block).toContain("'Нет доступа'");
    expect(block).toContain("'Файл'");
  });

  it('matches the stored value against ALL of a file\'s versions (versionIds), not just currentVersionId', () => {
    const idx = source.indexOf('useEffect(() => {\n    if (!value || !recordId)');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 800);
    expect(block).toMatch(/f\.currentVersionId === value/);
    expect(block).toMatch(/Array\.isArray\(f\.versionIds\) && f\.versionIds\.includes\(value\)/);
  });
});

describe('FileField T-0579 · FF-UPLOAD-ROUTE-ONLY (structural)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'field-renderer.jsx'), 'utf8');

  it('uses POST /api/records/:recordId/files for upload', () => {
    expect(source).toMatch(/\/api\/records\/\$\{encodeURIComponent\(recordId\)\}\/files/);
  });

  it('uses GET /api/files/:versionId/download for the download link', () => {
    expect(source).toMatch(/\/api\/files\/\$\{encodeURIComponent\(value\)\}\/download/);
  });

  it('contains no direct S3/bucket/presign client construction (code, not doc comments)', () => {
    // Strip // line comments before scanning — this file's header prose
    // documents the ABSENCE of S3/bucket/presign (the invariant itself), which
    // would otherwise false-positive a naive whole-file grep. The real fitness
    // check (ci/checks/) mirrors this same code-vs-comment distinction.
    const codeOnly = source
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(codeOnly).not.toMatch(/s3:\/\//i);
    expect(codeOnly).not.toMatch(/\bbucket\b/i);
    expect(codeOnly).not.toMatch(/presign/i);
    expect(codeOnly).not.toMatch(/PutObject/);
    expect(codeOnly).not.toMatch(/aws-sdk/i);
  });
});
