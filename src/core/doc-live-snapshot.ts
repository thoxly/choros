/**
 * T-0239 · T-0134c: LiveSnapshot Collector
 *
 * Assembles a LiveSnapshot (from doc-ref-lint.ts) by introspecting the live system.
 * This is the I/O layer — it is NOT pure. The pure core (checkDocRefs) lives in
 * doc-ref-lint.ts and does not depend on this module.
 *
 * Design seam (R-3, ADR §3.2):
 *
 *   BUILD/CI-TIME sources (no DB, no runtime):
 *   - codeSymbols: static grep of `export` declarations in src/ TypeScript files.
 *     Form: `${module}#${symbol}` where module = relative path without extension
 *     (e.g. `src/core/grant-lattice#BOTTOM`).
 *   - restEndpoints: static grep of `router.register(METHOD, path)` call sites in src/.
 *     Form: `${METHOD} ${path}` (e.g. `GET /api/org`).
 *
 *   RUNTIME sources (degrade to empty when no client is supplied):
 *   - schemaFields: reads registry_def.record_schema.properties from DB.
 *     Form: `${registryDefId}#${fieldKey}`.
 *   - processKeys: parses <process id="..."> from *.bpmn files found in src/ tree.
 *     Rationale: the BPMN files ARE committed to the repo and available at build/CI time.
 *     There is no live Flowable deploy-registry query path in day-1; BPMN keys come from
 *     committed *.bpmn files. If a pg client is injected, this could be extended to a
 *     live Flowable API probe in Stage-2.
 *   - configKeys: reads mcp_tool.name values from DB (seed migration 044 = config-agent tools).
 *     Degrades to empty when no client supplied — acceptable for CI without DB.
 *
 * For CI without DB, call assembleStaticSnapshot() which returns all build/CI-time fields
 * and empty sets for the runtime-only fields (schemaFields, configKeys).
 *
 * The assembled LiveSnapshot is consumed by checkDocRefs (doc-ref-lint.ts).
 * This module must NOT be imported by doc-ref-lint.ts (direction: collector → core).
 *
 * Conventions:
 *   - Zero external deps (only node:fs, node:path, node:readline — stdlib).
 *   - pg client is injected (not constructed here) for testability.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LiveSnapshot } from './doc-ref-lint.js';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * A pg-compatible client interface (subset of pg.Client / pg.Pool).
 * Injected for schemaFields and configKeys queries. Not imported from pg
 * to keep this module free of hard pg coupling.
 */
export interface PgQueryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

// ---------------------------------------------------------------------------
// BUILD/CI-TIME: codeSymbols
// ---------------------------------------------------------------------------

/**
 * Extracts exported symbol names from all *.ts files under `srcDir`.
 * Parses lines matching `export (function|class|const|let|type|interface|enum|abstract class) <name>`
 * and `export { <name>` (re-exports). Returns Set<`${module}#${symbol}`>.
 *
 * Module key = relative path from srcDir parent (e.g. `src/core/grant-lattice`), no extension.
 *
 * This is a conservative regex scan — it does NOT require compiling the project.
 * Unknown export forms (e.g. `export default`) are skipped (not a correctness risk:
 * doc_ref.ref_kind='code_symbol' only catches named exports).
 *
 * @param srcDir  absolute path to the `src/` directory.
 */
export function collectCodeSymbols(srcDir: string): ReadonlySet<string> {
  const symbols = new Set<string>();
  const srcParent = path.dirname(srcDir);

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip __tests__ directories — they are not part of the public surface.
        if (entry.name === '__tests__') continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const module = path
          .relative(srcParent, fullPath)
          .replace(/\.ts$/, '');
        extractExportsFromFile(fullPath, module, symbols);
      }
    }
  };

  walk(srcDir);
  return symbols;
}

/**
 * Extracts exported names from one TS file and adds `${module}#${name}` to the set.
 */
function extractExportsFromFile(filePath: string, module: string, out: Set<string>): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  const lines = content.split('\n');
  for (const line of lines) {
    // Named export declarations: export (function|class|const|let|type|interface|enum|abstract class) <name>
    const declMatch = line.match(
      /^export\s+(?:declare\s+)?(?:abstract\s+class|function\s*\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    );
    if (declMatch) {
      out.add(`${module}#${declMatch[1]}`);
      continue;
    }

    // Named re-exports: export { Foo, Bar, Baz as Qux }
    // We only capture names that are exported (not the `as` aliases target — capture both).
    const namedMatch = line.match(/^export\s+\{([^}]+)\}/);
    if (namedMatch) {
      const names = namedMatch[1]!.split(',');
      for (const segment of names) {
        // Handle `Foo as Bar` — the exported name is `Bar`; local name is `Foo`.
        const parts = segment.trim().split(/\s+as\s+/);
        const exportedName = (parts[1] ?? parts[0] ?? '').trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportedName)) {
          out.add(`${module}#${exportedName}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// BUILD/CI-TIME: restEndpoints
// ---------------------------------------------------------------------------

/**
 * Extracts registered REST endpoints from all *.ts files under `srcDir`.
 * Scans for `router.register("METHOD", "path"` call patterns.
 * Returns Set<`${METHOD} ${path}`>.
 *
 * @param srcDir  absolute path to the `src/` directory.
 */
export function collectRestEndpoints(srcDir: string): ReadonlySet<string> {
  const endpoints = new Set<string>();

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        extractRoutesFromFile(fullPath, endpoints);
      }
    }
  };

  walk(srcDir);
  return endpoints;
}

/**
 * Scans one file for `router.register("METHOD", "path"` patterns.
 */
function extractRoutesFromFile(filePath: string, out: Set<string>): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  // Pattern: router.register("METHOD", "/path" or 'METHOD', '/path'
  // Allow whitespace between args. Capture method and path.
  const pattern = /router\.register\(\s*["'](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["']\s*,\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const method = match[1]!.toUpperCase();
    const routePath = match[2]!;
    out.add(`${method} ${routePath}`);
  }
}

// ---------------------------------------------------------------------------
// BUILD/CI-TIME: processKeys (from committed *.bpmn files)
// ---------------------------------------------------------------------------

/**
 * Extracts process keys from all *.bpmn files under `repoRoot`.
 * Parses `<process id="..."` attributes (whitespace-tolerant).
 * Returns Set<string> of process keys.
 *
 * R-3 note: BPMN files are committed to the repo and available at CI time.
 * Live Flowable deploy-registry query is deferred to Stage-2.
 *
 * @param repoRoot  absolute path to the repo root.
 */
export function collectProcessKeys(repoRoot: string): ReadonlySet<string> {
  const keys = new Set<string>();

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules and .git
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.bpmn')) {
        extractProcessKeysFromFile(fullPath, keys);
      }
    }
  };

  walk(repoRoot);
  return keys;
}

/**
 * Parses `<process id="..."` from a BPMN file and adds process key to the set.
 */
function extractProcessKeysFromFile(filePath: string, out: Set<string>): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  // Match <process id="key"> or <bpmn:process id="key"> (with optional namespace prefix).
  const pattern = /<(?:[a-zA-Z0-9_]+:)?process\s[^>]*\bid=["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const key = match[1]!.trim();
    if (key) out.add(key);
  }
}

// ---------------------------------------------------------------------------
// RUNTIME: schemaFields (requires DB)
// ---------------------------------------------------------------------------

/**
 * Queries registry_def.record_schema.properties from DB.
 * Returns Set<`${registryDefId}#${fieldKey}`> where registryDefId is the registry_def.id.
 *
 * Degrades to empty set if the client query fails or if client is undefined.
 *
 * @param client   injected pg-compatible queryable (Pool or Client).
 * @param tenantId optional tenant_id filter; if omitted, reads all tenants' registry_defs
 *                 (appropriate for CI/admin contexts with bypass_rls).
 */
export async function collectSchemaFields(
  client: PgQueryable,
  tenantId?: string,
): Promise<ReadonlySet<string>> {
  const fields = new Set<string>();
  try {
    const sql = tenantId
      ? `SELECT id, record_schema FROM choros.registry_def WHERE tenant_id = $1`
      : `SELECT id, record_schema FROM choros.registry_def`;
    const values = tenantId ? [tenantId] : undefined;
    const result = await client.query(sql, values);
    for (const row of result.rows) {
      const defId = row['id'] as string;
      const schema = row['record_schema'] as Record<string, unknown> | null;
      if (!schema || typeof schema !== 'object') continue;
      const properties = schema['properties'] as Record<string, unknown> | null;
      if (!properties || typeof properties !== 'object') continue;
      for (const fieldKey of Object.keys(properties)) {
        fields.add(`${defId}#${fieldKey}`);
      }
    }
  } catch {
    // Degrade gracefully — schemaFields empty when DB unavailable.
  }
  return fields;
}

// ---------------------------------------------------------------------------
// RUNTIME: configKeys (mcp_tool names from DB; degrades to empty)
// ---------------------------------------------------------------------------

/**
 * Queries mcp_tool.name values from DB as the set of valid config keys.
 * These are the tool names seeded by migration 044 (config-agent tools).
 *
 * In doc_ref terms: a ref_kind='config_key' with key='emit_form_code' is valid
 * if 'emit_form_code' is present in the mcp_tool registry.
 *
 * Degrades to empty set if the client query fails or if client is undefined.
 *
 * @param client   injected pg-compatible queryable.
 * @param tenantId optional tenant_id filter.
 */
export async function collectConfigKeys(
  client: PgQueryable,
  tenantId?: string,
): Promise<ReadonlySet<string>> {
  const keys = new Set<string>();
  try {
    const sql = tenantId
      ? `SELECT name FROM choros.mcp_tool WHERE tenant_id = $1`
      : `SELECT name FROM choros.mcp_tool`;
    const values = tenantId ? [tenantId] : undefined;
    const result = await client.query(sql, values);
    for (const row of result.rows) {
      const name = row['name'] as string;
      if (name) keys.add(name);
    }
  } catch {
    // Degrade gracefully — configKeys empty when DB unavailable.
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Composite assemblers
// ---------------------------------------------------------------------------

/**
 * Assembles a LiveSnapshot from build/CI-time sources only (no DB required).
 *
 * - codeSymbols:    exported symbols from src/
 * - restEndpoints:  router.register calls in src/
 * - processKeys:    <process id> in *.bpmn files under repoRoot
 * - schemaFields:   empty (no DB at CI time without infrastructure)
 * - configKeys:     empty (no DB at CI time without infrastructure)
 *
 * Suitable for CI lint with a purely static fixture.
 *
 * @param repoRoot  absolute path to repo root.
 */
export function assembleStaticSnapshot(repoRoot: string): LiveSnapshot {
  const srcDir = path.join(repoRoot, 'src');
  return {
    codeSymbols: collectCodeSymbols(srcDir),
    restEndpoints: collectRestEndpoints(srcDir),
    processKeys: collectProcessKeys(repoRoot),
    schemaFields: new Set<string>(),
    configKeys: new Set<string>(),
  };
}

/**
 * Assembles a full LiveSnapshot including DB-backed fields.
 *
 * - codeSymbols:    exported symbols from src/
 * - restEndpoints:  router.register calls in src/
 * - processKeys:    <process id> in *.bpmn files under repoRoot
 * - schemaFields:   registry_def.record_schema.properties (from DB)
 * - configKeys:     mcp_tool.name values (from DB)
 *
 * schemaFields and configKeys degrade to empty if the client query fails.
 *
 * @param repoRoot  absolute path to repo root.
 * @param client    injected pg-compatible queryable.
 * @param tenantId  optional tenant_id filter for DB queries.
 */
export async function assembleFullSnapshot(
  repoRoot: string,
  client: PgQueryable,
  tenantId?: string,
): Promise<LiveSnapshot> {
  const srcDir = path.join(repoRoot, 'src');
  const [schemaFields, configKeys] = await Promise.all([
    collectSchemaFields(client, tenantId),
    collectConfigKeys(client, tenantId),
  ]);
  return {
    codeSymbols: collectCodeSymbols(srcDir),
    restEndpoints: collectRestEndpoints(srcDir),
    processKeys: collectProcessKeys(repoRoot),
    schemaFields,
    configKeys,
  };
}
