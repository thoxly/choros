/**
 * T-0239 · T-0134c — Unit tests for doc-live-snapshot.ts (LiveSnapshot collector).
 *
 * Coverage:
 *   1. collectCodeSymbols: export declarations → ${module}#${symbol} keys.
 *   2. collectRestEndpoints: router.register(...) → ${METHOD} ${path} keys.
 *   3. collectProcessKeys: <process id="..."> in .bpmn files → processKey strings.
 *   4. assembleStaticSnapshot: wires the three build/CI collectors.
 *   5. collectSchemaFields: injected fake client → ${defId}#${fieldKey} keys.
 *   6. collectConfigKeys: injected fake client → tool name keys.
 *   7. assembleFullSnapshot: wires all five sources via injected client.
 *   8. Integration: collector → checkDocRefs: broken ref is caught, good ref passes.
 *
 * All tests are synchronous or use fake clients — no real DB required.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  collectCodeSymbols,
  collectRestEndpoints,
  collectProcessKeys,
  assembleStaticSnapshot,
  collectSchemaFields,
  collectConfigKeys,
  assembleFullSnapshot,
  type PgQueryable,
} from '../doc-live-snapshot.js';
import { checkDocRefs, type DocRef } from '../doc-ref-lint.js';

// ---------------------------------------------------------------------------
// Helpers: temp directory for fixture files
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-live-snapshot-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a file into tmpDir, creating parent dirs as needed. */
function writeFixture(relPath: string, content: string): string {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

// ---------------------------------------------------------------------------
// 1. collectCodeSymbols
// ---------------------------------------------------------------------------

describe('collectCodeSymbols', () => {
  it('extracts export function declarations', () => {
    const srcDir = path.join(tmpDir, 'cs-fn', 'src');
    writeFixture('cs-fn/src/core/myModule.ts', [
      'export function myFn(): void {}',
      'export function anotherFn(x: number): string { return ""; }',
    ].join('\n'));

    const symbols = collectCodeSymbols(srcDir);
    expect(symbols.has('src/core/myModule#myFn')).toBe(true);
    expect(symbols.has('src/core/myModule#anotherFn')).toBe(true);
  });

  it('extracts export const, type, interface, class, enum', () => {
    const srcDir = path.join(tmpDir, 'cs-mixed', 'src');
    writeFixture('cs-mixed/src/core/things.ts', [
      'export const BOTTOM = 42;',
      'export type Foo = string;',
      'export interface Bar { x: number }',
      'export class Baz {}',
      'export enum Status { A = "a" }',
    ].join('\n'));

    const symbols = collectCodeSymbols(srcDir);
    expect(symbols.has('src/core/things#BOTTOM')).toBe(true);
    expect(symbols.has('src/core/things#Foo')).toBe(true);
    expect(symbols.has('src/core/things#Bar')).toBe(true);
    expect(symbols.has('src/core/things#Baz')).toBe(true);
    expect(symbols.has('src/core/things#Status')).toBe(true);
  });

  it('extracts named re-export { Foo, Bar as Qux }', () => {
    const srcDir = path.join(tmpDir, 'cs-reexport', 'src');
    writeFixture('cs-reexport/src/index.ts', [
      'export { Foo, Bar as Qux } from "./other.js";',
    ].join('\n'));

    const symbols = collectCodeSymbols(srcDir);
    expect(symbols.has('src/index#Foo')).toBe(true);
    expect(symbols.has('src/index#Qux')).toBe(true);
    expect(symbols.has('src/index#Bar')).toBe(false); // local name not exported
  });

  it('skips __tests__ directories', () => {
    const srcDir = path.join(tmpDir, 'cs-tests', 'src');
    writeFixture('cs-tests/src/__tests__/hidden.ts', 'export function shouldBeHidden() {}');
    writeFixture('cs-tests/src/visible.ts', 'export function visible() {}');

    const symbols = collectCodeSymbols(srcDir);
    expect(symbols.has('src/visible#visible')).toBe(true);
    // shouldBeHidden is in __tests__, must not appear
    let found = false;
    for (const s of symbols) {
      if (s.includes('shouldBeHidden')) found = true;
    }
    expect(found).toBe(false);
  });

  it('uses ${module}#${symbol} key form (module = relative path without extension)', () => {
    const srcDir = path.join(tmpDir, 'cs-keyform', 'src');
    writeFixture('cs-keyform/src/http/routes.ts', 'export function registerRoutes() {}');

    const symbols = collectCodeSymbols(srcDir);
    // key form: relative to srcDir's parent → "src/http/routes"
    expect(symbols.has('src/http/routes#registerRoutes')).toBe(true);
  });

  it('returns empty set for empty srcDir', () => {
    const srcDir = path.join(tmpDir, 'cs-empty', 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const symbols = collectCodeSymbols(srcDir);
    expect(symbols.size).toBe(0);
  });

  it('returns empty set for non-existent srcDir', () => {
    const symbols = collectCodeSymbols(path.join(tmpDir, 'does-not-exist'));
    expect(symbols.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. collectRestEndpoints
// ---------------------------------------------------------------------------

describe('collectRestEndpoints', () => {
  it('extracts GET and POST routes', () => {
    const srcDir = path.join(tmpDir, 're-basic', 'src');
    writeFixture('re-basic/src/http/org.ts', [
      '  router.register("GET", "/api/org", async (req, res) => {',
      '  router.register("POST", "/api/org/create", async (req, res) => {',
    ].join('\n'));

    const endpoints = collectRestEndpoints(srcDir);
    expect(endpoints.has('GET /api/org')).toBe(true);
    expect(endpoints.has('POST /api/org/create')).toBe(true);
  });

  it('handles all HTTP methods: PUT, PATCH, DELETE', () => {
    const srcDir = path.join(tmpDir, 're-methods', 'src');
    writeFixture('re-methods/src/http/things.ts', [
      '  router.register("PUT", "/api/x", handler);',
      '  router.register("PATCH", "/api/y", handler);',
      '  router.register("DELETE", "/api/z/:id", handler);',
    ].join('\n'));

    const endpoints = collectRestEndpoints(srcDir);
    expect(endpoints.has('PUT /api/x')).toBe(true);
    expect(endpoints.has('PATCH /api/y')).toBe(true);
    expect(endpoints.has('DELETE /api/z/:id')).toBe(true);
  });

  it('uses ${METHOD} ${path} key form', () => {
    const srcDir = path.join(tmpDir, 're-keyform', 'src');
    writeFixture('re-keyform/src/http/r.ts', [
      "  router.register('GET', '/api/users', h);",
    ].join('\n'));

    const endpoints = collectRestEndpoints(srcDir);
    expect(endpoints.has('GET /api/users')).toBe(true);
  });

  it('returns empty set for empty srcDir', () => {
    const srcDir = path.join(tmpDir, 're-empty', 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const endpoints = collectRestEndpoints(srcDir);
    expect(endpoints.size).toBe(0);
  });

  it('returns empty set for non-existent srcDir', () => {
    const endpoints = collectRestEndpoints(path.join(tmpDir, 'does-not-exist'));
    expect(endpoints.size).toBe(0);
  });

  it('deduplicates identical registrations', () => {
    const srcDir = path.join(tmpDir, 're-dedup', 'src');
    writeFixture('re-dedup/src/http/a.ts', '  router.register("GET", "/api/x", h);');
    writeFixture('re-dedup/src/http/b.ts', '  router.register("GET", "/api/x", h);');

    const endpoints = collectRestEndpoints(srcDir);
    // Set — only one entry regardless of how many files register the same route
    expect(endpoints.has('GET /api/x')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. collectProcessKeys
// ---------------------------------------------------------------------------

describe('collectProcessKeys', () => {
  it('extracts process id from simple BPMN', () => {
    const repoRoot = path.join(tmpDir, 'pk-simple');
    writeFixture('pk-simple/src/bpmn/approval.bpmn', [
      '<?xml version="1.0"?>',
      '<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">',
      '  <process id="invoice-approval" isExecutable="true">',
      '  </process>',
      '</definitions>',
    ].join('\n'));

    const keys = collectProcessKeys(repoRoot);
    expect(keys.has('invoice-approval')).toBe(true);
  });

  it('extracts process id with namespace prefix (bpmn:process)', () => {
    const repoRoot = path.join(tmpDir, 'pk-ns');
    writeFixture('pk-ns/flows/onboarding.bpmn', [
      '<bpmn:process id="onboarding" name="Employee Onboarding">',
    ].join('\n'));

    const keys = collectProcessKeys(repoRoot);
    expect(keys.has('onboarding')).toBe(true);
  });

  it('extracts multiple process keys from multiple files', () => {
    const repoRoot = path.join(tmpDir, 'pk-multi');
    writeFixture('pk-multi/p1.bpmn', '<process id="proc-a" />');
    writeFixture('pk-multi/sub/p2.bpmn', '<process id="proc-b" />');

    const keys = collectProcessKeys(repoRoot);
    expect(keys.has('proc-a')).toBe(true);
    expect(keys.has('proc-b')).toBe(true);
  });

  it('skips node_modules and .git directories', () => {
    const repoRoot = path.join(tmpDir, 'pk-skip');
    writeFixture('pk-skip/node_modules/lib/p.bpmn', '<process id="should-skip" />');
    writeFixture('pk-skip/src/p.bpmn', '<process id="included" />');

    const keys = collectProcessKeys(repoRoot);
    expect(keys.has('included')).toBe(true);
    expect(keys.has('should-skip')).toBe(false);
  });

  it('returns empty set when no BPMN files found', () => {
    const repoRoot = path.join(tmpDir, 'pk-empty');
    fs.mkdirSync(repoRoot, { recursive: true });
    const keys = collectProcessKeys(repoRoot);
    expect(keys.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. assembleStaticSnapshot
// ---------------------------------------------------------------------------

describe('assembleStaticSnapshot', () => {
  it('returns a LiveSnapshot with all 5 required fields', () => {
    const repoRoot = path.join(tmpDir, 'static-snap');
    writeFixture('static-snap/src/core/mod.ts', 'export function doThing() {}');
    writeFixture('static-snap/src/http/r.ts', 'router.register("GET", "/api/test", h);');
    writeFixture('static-snap/src/bpmn/p.bpmn', '<process id="test-proc" />');

    const snap = assembleStaticSnapshot(repoRoot);

    // All 5 fields present
    expect(snap.codeSymbols).toBeDefined();
    expect(snap.restEndpoints).toBeDefined();
    expect(snap.processKeys).toBeDefined();
    expect(snap.schemaFields).toBeDefined();
    expect(snap.configKeys).toBeDefined();

    // Build/CI-time fields populated
    expect(snap.codeSymbols.has('src/core/mod#doThing')).toBe(true);
    expect(snap.restEndpoints.has('GET /api/test')).toBe(true);
    expect(snap.processKeys.has('test-proc')).toBe(true);

    // Runtime-only fields empty (no DB)
    expect(snap.schemaFields.size).toBe(0);
    expect(snap.configKeys.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. collectSchemaFields (injected fake client)
// ---------------------------------------------------------------------------

describe('collectSchemaFields', () => {
  it('returns ${registryDefId}#${fieldKey} for each properties key', async () => {
    const fakeClient: PgQueryable = {
      query: async () => ({
        rows: [
          {
            id: 'reg-001',
            record_schema: {
              type: 'object',
              properties: { contractNo: { type: 'string' }, status: { type: 'string' } },
            },
          },
          {
            id: 'reg-002',
            record_schema: {
              type: 'object',
              properties: { amount: { type: 'number' } },
            },
          },
        ],
      }),
    };

    const fields = await collectSchemaFields(fakeClient);
    expect(fields.has('reg-001#contractNo')).toBe(true);
    expect(fields.has('reg-001#status')).toBe(true);
    expect(fields.has('reg-002#amount')).toBe(true);
  });

  it('degrades to empty set on DB error', async () => {
    const fakeClient: PgQueryable = {
      query: async () => { throw new Error('DB connection failed'); },
    };

    const fields = await collectSchemaFields(fakeClient);
    expect(fields.size).toBe(0);
  });

  it('skips rows with null or non-object record_schema', async () => {
    const fakeClient: PgQueryable = {
      query: async () => ({
        rows: [
          { id: 'reg-null', record_schema: null },
          { id: 'reg-noProps', record_schema: { type: 'object' } }, // no properties key
          { id: 'reg-ok', record_schema: { properties: { foo: {} } } },
        ],
      }),
    };

    const fields = await collectSchemaFields(fakeClient);
    expect(fields.has('reg-ok#foo')).toBe(true);
    expect(fields.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. collectConfigKeys (injected fake client)
// ---------------------------------------------------------------------------

describe('collectConfigKeys', () => {
  it('returns tool name strings from mcp_tool rows', async () => {
    const fakeClient: PgQueryable = {
      query: async () => ({
        rows: [
          { name: 'emit_form_code' },
          { name: 'edit_jsonschema' },
          { name: 'author_dmn' },
        ],
      }),
    };

    const keys = await collectConfigKeys(fakeClient);
    expect(keys.has('emit_form_code')).toBe(true);
    expect(keys.has('edit_jsonschema')).toBe(true);
    expect(keys.has('author_dmn')).toBe(true);
  });

  it('degrades to empty set on DB error', async () => {
    const fakeClient: PgQueryable = {
      query: async () => { throw new Error('Connection refused'); },
    };

    const keys = await collectConfigKeys(fakeClient);
    expect(keys.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. assembleFullSnapshot (wires all five sources via injected client)
// ---------------------------------------------------------------------------

describe('assembleFullSnapshot', () => {
  it('combines build/CI-time sources with DB-backed sources', async () => {
    const repoRoot = path.join(tmpDir, 'full-snap');
    writeFixture('full-snap/src/core/m.ts', 'export function myFn() {}');
    writeFixture('full-snap/src/http/r.ts', 'router.register("GET", "/api/full", h);');
    writeFixture('full-snap/flows/p.bpmn', '<process id="full-proc" />');

    const fakeClient: PgQueryable = {
      query: async (sql: string) => {
        if (sql.includes('registry_def')) {
          return { rows: [{ id: 'def-1', record_schema: { properties: { fieldA: {} } } }] };
        }
        if (sql.includes('mcp_tool')) {
          return { rows: [{ name: 'some_tool' }] };
        }
        return { rows: [] };
      },
    };

    const snap = await assembleFullSnapshot(repoRoot, fakeClient);

    expect(snap.codeSymbols.has('src/core/m#myFn')).toBe(true);
    expect(snap.restEndpoints.has('GET /api/full')).toBe(true);
    expect(snap.processKeys.has('full-proc')).toBe(true);
    expect(snap.schemaFields.has('def-1#fieldA')).toBe(true);
    expect(snap.configKeys.has('some_tool')).toBe(true);
  });

  it('degrades gracefully: schemaFields and configKeys empty when DB fails', async () => {
    const repoRoot = path.join(tmpDir, 'full-snap-degrade');
    writeFixture('full-snap-degrade/src/core/m.ts', 'export const X = 1;');

    const fakeClient: PgQueryable = {
      query: async () => { throw new Error('No DB'); },
    };

    const snap = await assembleFullSnapshot(repoRoot, fakeClient);

    expect(snap.codeSymbols.has('src/core/m#X')).toBe(true);
    expect(snap.schemaFields.size).toBe(0);
    expect(snap.configKeys.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Integration: collector → checkDocRefs
// ---------------------------------------------------------------------------

describe('Integration: collector → checkDocRefs', () => {
  it('catches a broken code_symbol ref', () => {
    const repoRoot = path.join(tmpDir, 'int-broken');
    writeFixture('int-broken/src/core/realModule.ts', 'export function realFn() {}');

    const snap = assembleStaticSnapshot(repoRoot);

    // A ref to a symbol that exists → ok
    const goodRef: DocRef = {
      refKind: 'code_symbol',
      refTarget: { module: 'src/core/realModule', symbol: 'realFn' },
    };
    expect(checkDocRefs([goodRef], snap).ok).toBe(true);

    // A ref to a symbol that does NOT exist → violation
    const badRef: DocRef = {
      refKind: 'code_symbol',
      refTarget: { module: 'src/core/realModule', symbol: 'goneFn' },
    };
    const result = checkDocRefs([badRef], snap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.type).toBe('missing_referent');
      expect(result.violations[0]!.refKind).toBe('code_symbol');
    }
  });

  it('catches a broken rest_endpoint ref', () => {
    const repoRoot = path.join(tmpDir, 'int-endpoint');
    writeFixture('int-endpoint/src/http/routes.ts', [
      'router.register("GET", "/api/widgets", h);',
    ].join('\n'));

    const snap = assembleStaticSnapshot(repoRoot);

    const goodRef: DocRef = {
      refKind: 'rest_endpoint',
      refTarget: { method: 'GET', path: '/api/widgets' },
    };
    expect(checkDocRefs([goodRef], snap).ok).toBe(true);

    const badRef: DocRef = {
      refKind: 'rest_endpoint',
      refTarget: { method: 'DELETE', path: '/api/widgets' },
    };
    const result = checkDocRefs([badRef], snap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]!.refKind).toBe('rest_endpoint');
    }
  });

  it('catches a broken schema_field ref via fake client', async () => {
    const repoRoot = path.join(tmpDir, 'int-schema');
    const fakeClient: PgQueryable = {
      query: async (sql: string) => {
        if (sql.includes('registry_def')) {
          return {
            rows: [{
              id: 'def-A',
              record_schema: { properties: { status: {}, amount: {} } },
            }],
          };
        }
        return { rows: [] };
      },
    };

    const snap = await assembleFullSnapshot(repoRoot, fakeClient);

    const goodRef: DocRef = {
      refKind: 'schema_field',
      refTarget: { registryDefId: 'def-A', fieldKey: 'status' },
    };
    expect(checkDocRefs([goodRef], snap).ok).toBe(true);

    const badRef: DocRef = {
      refKind: 'schema_field',
      refTarget: { registryDefId: 'def-A', fieldKey: 'deletedField' },
    };
    const result = checkDocRefs([badRef], snap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]!.refKind).toBe('schema_field');
    }
  });

  it('all-present: all 5 ref kinds resolve → ok', async () => {
    const repoRoot = path.join(tmpDir, 'int-all');
    writeFixture('int-all/src/core/m.ts', 'export function doWork() {}');
    writeFixture('int-all/src/http/r.ts', 'router.register("POST", "/api/do", h);');
    writeFixture('int-all/flows/p.bpmn', '<process id="my-proc" />');

    const fakeClient: PgQueryable = {
      query: async (sql: string) => {
        if (sql.includes('registry_def')) {
          return { rows: [{ id: 'def-1', record_schema: { properties: { fieldX: {} } } }] };
        }
        if (sql.includes('mcp_tool')) {
          return { rows: [{ name: 'tool_a' }] };
        }
        return { rows: [] };
      },
    };

    const snap = await assembleFullSnapshot(repoRoot, fakeClient);

    const refs: DocRef[] = [
      { refKind: 'code_symbol', refTarget: { module: 'src/core/m', symbol: 'doWork' } },
      { refKind: 'rest_endpoint', refTarget: { method: 'POST', path: '/api/do' } },
      { refKind: 'schema_field', refTarget: { registryDefId: 'def-1', fieldKey: 'fieldX' } },
      { refKind: 'process', refTarget: { processKey: 'my-proc' } },
      { refKind: 'config_key', refTarget: { key: 'tool_a' } },
    ];

    expect(checkDocRefs(refs, snap).ok).toBe(true);
  });
});
