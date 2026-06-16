/**
 * T-0238 · T-0134b: Doc-Ref Lint Core
 *
 * Pure function — no I/O, no DB, no network, no filesystem, no env reads.
 * Зеркалит purity-дисциплину report-page-compat.ts (T-0121 · checkReportPageDepFields)
 * и binding-compat.ts (T-0072 · checkBindingCompat).
 *
 * Exports:
 *   - DocRefKind        — closed vocab of typed reference kinds
 *   - DocRef            — one typed reference (mirror of doc_ref row input shape)
 *   - LiveSnapshot      — snapshot of live system state (collected by T-0134c, not here)
 *   - DocRefViolation   — one lint violation (type: 'missing_referent')
 *   - DocLintResult     — union result type (ok | violations)
 *   - checkDocRefs      — core pure checker function (ADR §3.2)
 *
 * Прецедентная ссылка (NF-6 ADR §3, обязательна):
 *   checkDocRefs является расширением паттерна checkReportPageDepFields (T-0121)
 *   и checkBindingCompat (T-0072). Это один контрол-плейн согласованности класса
 *   «производный артефакт ↔ живой источник», не четвёртый параллельный механизм.
 *   FF-1 T-0132-класс: вход = ссылки + снимок, выход = список нарушений, пусто = ок.
 *
 * Граница источника LiveSnapshot (R-3, ADR §3.2):
 *   - codeSymbols = build/CI-time source (no runtime introspection here)
 *   - restEndpoints, processKeys, configKeys, schemaFields = runtime-resolvable
 *   Сборщик снимка — impl-зона T-0134c; ядро детерминировано и тестируемо без БД.
 *
 * НЕ является публичной точкой расширения для Stage-2 hard-gate (SEAM-2):
 *   Реакция на устаревание (broken/stale/log/audit) принадлежит T-0134d.
 *   Пайплайн генерации принадлежит исследованию №3 / T-0134h (SEAM-3).
 */

// ---------------------------------------------------------------------------
// Exported types (frozen public surface — ADR §9 T-0134b)
// ---------------------------------------------------------------------------

/**
 * Closed vocab of reference kinds (ADR §3.1 / §2.2).
 * Extended additively via migration — not via TS type change.
 */
export type DocRefKind =
  | 'code_symbol'    // ref_target: { module: string; symbol: string }
  | 'rest_endpoint'  // ref_target: { method: string; path: string }
  | 'schema_field'   // ref_target: { registryDefId: string; fieldKey: string }
  | 'process'        // ref_target: { processKey: string }
  | 'config_key';    // ref_target: { key: string }

/**
 * One typed reference from a doc_page to an element in the live system.
 * refTarget is a typed machine-resolvable identifier, NOT free text (FF-DOCREF-TYPED).
 * Shape mirrors doc_ref row — but is pure (no DB ids needed for lint).
 */
export interface DocRef {
  refKind: DocRefKind;
  refTarget: Record<string, string>;
}

/**
 * Snapshot of the live system's current state.
 * Collected by the LiveSnapshot importer (T-0134c) — NOT assembled inside this core module.
 * Core remains pure: input = refs + snapshot; output = violations.
 *
 * Set membership conventions (ADR §3.2):
 *   codeSymbols:    `${module}#${symbol}`
 *   restEndpoints:  `${method} ${path}`   (e.g. 'GET /api/users')
 *   schemaFields:   `${registryDefId}#${fieldKey}`
 *   processKeys:    processKey string
 *   configKeys:     key string
 */
export interface LiveSnapshot {
  codeSymbols: ReadonlySet<string>;
  restEndpoints: ReadonlySet<string>;
  schemaFields: ReadonlySet<string>;
  processKeys: ReadonlySet<string>;
  configKeys: ReadonlySet<string>;
}

/**
 * One lint violation: the referenced element is absent from the live snapshot.
 * type='missing_referent' — only violation type in day-1 (SEAM-2 hard-gate deferred).
 */
export interface DocRefViolation {
  type: 'missing_referent';
  refKind: DocRefKind;
  refTarget: Record<string, string>;
}

/**
 * Result of checkDocRefs.
 * { ok: true }  — all referents present (empty refs ⇒ ok).
 * { ok: false } — at least one referent absent from live system.
 */
export type DocLintResult =
  | { ok: true }
  | { ok: false; violations: DocRefViolation[] };

// ---------------------------------------------------------------------------
// checkDocRefs — core pure function (ADR §3.2, FF-LINT-PURE, FF-LINT-BEHAVIOR)
// ---------------------------------------------------------------------------

/**
 * Checks each typed reference in `refs` against the live system snapshot.
 *
 * For each ref:
 *   - 'code_symbol'   → `${module}#${symbol}` ∈ live.codeSymbols
 *   - 'rest_endpoint' → `${method} ${path}` ∈ live.restEndpoints
 *   - 'schema_field'  → `${registryDefId}#${fieldKey}` ∈ live.schemaFields
 *   - 'process'       → processKey ∈ live.processKeys
 *   - 'config_key'    → key ∈ live.configKeys
 *
 * Absent referent → DocRefViolation{ type:'missing_referent', refKind, refTarget }.
 * All present → { ok: true }.
 * Empty refs → { ok: true }.
 *
 * PURE. NO I/O. No pg, fs, net, http, child process, meta, or env access.
 * (FF-LINT-PURE: no forbidden imports in this file.)
 *
 * Прецедент: checkReportPageDepFields (T-0121) — аналогичная pure-функция для report_page_dep.
 * Этот модуль — расширение того же fitness-класса «артефакт ↔ живой источник», не четвёртый
 * механизм (NF-6, ADR §3). Зеркалит форму checkBindingCompat (T-0072).
 *
 * @param refs - Array of DocRef from doc_ref table (or fixtures for testing).
 * @param live - LiveSnapshot assembled by T-0134c (or test fixture).
 * @returns DocLintResult — { ok: true } or { ok: false; violations: DocRefViolation[] }.
 */
export function checkDocRefs(
  refs: readonly DocRef[],
  live: LiveSnapshot,
): DocLintResult {
  const violations: DocRefViolation[] = [];

  for (const ref of refs) {
    const absent = !resolveRef(ref, live);
    if (absent) {
      violations.push({
        type: 'missing_referent',
        refKind: ref.refKind,
        refTarget: ref.refTarget,
      });
    }
  }

  if (violations.length === 0) {
    return { ok: true };
  }
  return { ok: false, violations };
}

// ---------------------------------------------------------------------------
// Internal: referent resolution per ref_kind (ADR §3.2)
// ---------------------------------------------------------------------------

/**
 * Resolves one ref against the live snapshot.
 * Returns true if the referent is present, false if absent.
 * Unknown ref_kind (future extension) → treated as absent (fail-closed).
 */
function resolveRef(ref: DocRef, live: LiveSnapshot): boolean {
  switch (ref.refKind) {
    case 'code_symbol': {
      const key = `${ref.refTarget['module'] ?? ''}#${ref.refTarget['symbol'] ?? ''}`;
      return live.codeSymbols.has(key);
    }
    case 'rest_endpoint': {
      const key = `${ref.refTarget['method'] ?? ''} ${ref.refTarget['path'] ?? ''}`;
      return live.restEndpoints.has(key);
    }
    case 'schema_field': {
      const key = `${ref.refTarget['registryDefId'] ?? ''}#${ref.refTarget['fieldKey'] ?? ''}`;
      return live.schemaFields.has(key);
    }
    case 'process': {
      return live.processKeys.has(ref.refTarget['processKey'] ?? '');
    }
    case 'config_key': {
      return live.configKeys.has(ref.refTarget['key'] ?? '');
    }
    default: {
      // Unknown future kind — fail-closed (not present in current snapshot).
      return false;
    }
  }
}
