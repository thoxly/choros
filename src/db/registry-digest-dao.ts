/**
 * src/db/registry-digest-dao.ts — T-0607 (а): READ-PDP-scoped registry digest.
 *
 * THE DEFECT this closes (live acceptance, столп 6): the analyst never read
 * entity records — src/server.ts wired only the S3-journal ports, leaving
 * listRecords unwired (Defaults to []). So on «сколько заведено и как называется
 * хотя бы один?» the LLM saw an empty context and confidently reported «записей
 * нет», while the same user SEES the section in the UI.
 *
 * THIS DAO gives the analyst an honest, bounded digest of the registries the
 * actor may READ — in the ACTOR'S OWN RIGHTS, through the SAME grant-resolver +
 * READ-PDP path the records LIST endpoint uses (single-resolver, FR-7):
 *   - getGrantsForSubject (same DAO as every PDP consumer),
 *   - the composite resource-ancestry oracle (org delegate + resource
 *     root-sentinel/self-identity — same as src/server.ts's resolveReadVisibility),
 *   - isRecordReadable (the exact per-row predicate LIST records applies).
 * Nothing wider than the actor's READ grants; nothing bypassing RLS.
 *
 * MVP SCOPE (ADR-T0607 §1.1 / O1): a DIGEST — per readable registry: display
 * name, slug, count of readable records, and up to N sample values — NOT a full
 * paginated record-lister (that is a follow-up tool-use agent). This is enough
 * for the honest answer «сколько заведено и как называется хотя бы один».
 *
 * HONEST-DEGRADE: any read failure returns { degraded: true, registries: [] } —
 * the caller renders «не удалось прочитать разделы», never «записей нет» (which
 * would be a false factual claim).
 *
 * PURE-DB: this module imports pg + the DB ancestry loaders + the pure
 * read-visibility predicate. It performs NO business writes.
 *
 * T-0587 (§1.4 ADR-T0587): per-registry NUMERIC AGGREGATES (count/sum/avg/
 * min/max over one auto-detected numeric field) are accumulated INSIDE this
 * SAME per-row loop, strictly AFTER `isRecordReadable(...) === true` — the
 * identical branch that increments `visibleCount`/`samples`. No new SQL, no
 * new PDP path, no second scan: the pure accumulation logic lives in
 * src/core/visible-aggregate.ts (IO-free, independently unit-tested); this
 * DAO only wires it into the existing bounded scan.
 *
 * T-0613 (ADR-T0613, столп 6): the per-record SAMPLE value used to be the
 * first scalar in data's key order, regardless of what that field IS — a
 * code/number-shaped field earlier in the schema than the record's actual
 * name field would win, showing the LLM (and through it, the user) a code as
 * if it were the record's human-readable title. `pickTitleFieldKey`
 * (src/core/registry-title-field.ts, IO-free, independently unit-tested)
 * resolves ONE title-field key per registry from record_schema (explicit
 * annotation, then a name/title-shaped key, then the first plain-textual
 * field by deriveFieldType); `pickSampleValue` tries it first before falling
 * back, UNCHANGED, to the original data-only scan.
 */

import pg from "pg";
import { getGrantsForSubject } from "./grants-dao.js";
import { loadTenantOrgAncestry } from "./org-ancestry.js";
import { makeResourceAncestryOracle } from "./resource-ancestry.js";
import { isRecordReadable, type RowAncestry } from "../core/read-visibility.js";
import { sandboxReadPredicate } from "../core/sandbox-gate.js";
import {
  initNumericAccumulators,
  accumulateNumeric,
  finalizeNumeric,
  pickNumericFieldKeys,
  type NumericFieldAggregate,
} from "../core/visible-aggregate.js";
import { pickTitleFieldKey } from "../core/registry-title-field.js";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface ReadableRegistryEntry {
  /** URL-shaped slug of the registry_def. */
  readonly slug: string;
  /** Human-readable display name of the registry_def. */
  readonly displayName: string;
  /** Count of records in this registry the actor may READ (READ-PDP filtered). */
  readonly visibleCount: number;
  /** Up to sampleLimit short human-readable sample values (READ-PDP filtered). */
  readonly samples: readonly string[];
  /**
   * T-0587 (§1.4): per-registry numeric-field aggregates (count/sum/avg/min/
   * max), computed ONLY over records that already passed `isRecordReadable`
   * — the exact same visible subset that produced `visibleCount`/`samples`.
   * `undefined` when the registry's record_schema has no numeric field, or
   * no visible record contributed a finite value to any numeric field.
   * Aggregate-shaped as an ADDITIVE field: existing callers reading only
   * `slug`/`displayName`/`visibleCount`/`samples` are unaffected (AC-11).
   */
  readonly numericAggregates?: readonly NumericFieldAggregate[];
  /**
   * T-0587 (adversary-honesty fix, non-blocking): true when the per-registry
   * record scan hit `scanLimit` exactly — i.e. there MAY be more readable
   * records than this digest saw. `visibleCount`/`samples`/`numericAggregates`
   * are then only over the first `scannedLimit` records (by created_at DESC),
   * not necessarily the registry's full readable set. Additive/optional field
   * (existing callers reading only slug/displayName/visibleCount/samples are
   * unaffected). `undefined`/absent when the scan read fewer rows than
   * `scanLimit` (the scan therefore saw every record in the registry).
   */
  readonly truncated?: boolean;
  /**
   * T-0587 (adversary-honesty fix): the exact `scanLimit` bound in effect for
   * THIS scan — carried alongside `truncated` so a renderer never has to
   * duplicate the DAO's default/override scan bound as a second literal.
   * Present only when `truncated` is true (paired field).
   */
  readonly scannedLimit?: number;
}

export interface ReadableRegistryDigest {
  /**
   * True when the digest could NOT be read reliably (any error). The caller
   * MUST NOT claim «записей нет» when degraded — that would be a false fact.
   */
  readonly degraded: boolean;
  /** Readable registries (published tier), capped at registryLimit. */
  readonly registries: readonly ReadableRegistryEntry[];
}

export interface RegistryDigestOptions {
  /** Max registries to include (bounded context). Default 25. */
  readonly registryLimit?: number;
  /** Max sample values per registry. Default 3. */
  readonly sampleLimit?: number;
  /** Max records scanned per registry for the count+samples. Default 200. */
  readonly scanLimit?: number;
  /**
   * T-0587 (§1.4, NF-5): max number of auto-detected numeric fields to
   * aggregate per registry (bounded — a schema with many numeric properties
   * does not balloon the LLM context). Default 5.
   */
  readonly numericFieldLimit?: number;
}

const DEFAULT_REGISTRY_LIMIT = 25;
const DEFAULT_SAMPLE_LIMIT = 3;
const DEFAULT_SCAN_LIMIT = 200;
const DEFAULT_NUMERIC_FIELD_LIMIT = 5;

// ---------------------------------------------------------------------------
// Sample-value extraction (generic — D-064: no case-specific field names).
// ---------------------------------------------------------------------------

/**
 * Pick a short, human-readable representative value from a record's `data`.
 *
 * T-0613 (столп 6 — ассистент в контуре): `titleFieldKey`, when given, is the
 * registry's title-field key resolved ONCE per registry (schema-order pass,
 * see `pickTitleFieldKey` / `registry-title-field.ts`) — e.g. `name`/`title`
 * over a code/number-shaped field that happened to sit earlier in the schema.
 * Tried FIRST, before the pre-existing data-scan-order fallback, so the LLM's
 * example is the record's actual name, not an incidental first scalar (was:
 * an ИНН-shaped code field could win purely by key order — LIVE_PROOF T-0607).
 *
 * When `titleFieldKey` is absent, or the record's OWN data has no usable
 * value under that key (missing/blank for this particular row — schemas are
 * not enforced per-row), falls back UNCHANGED to the original generic scan:
 * first non-empty string scalar (by key order), then any scalar.
 */
function pickSampleValue(data: unknown, titleFieldKey: string | null): string | null {
  if (data === null || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  if (titleFieldKey !== null) {
    const v = obj[titleFieldKey];
    if (typeof v === "string" && v.trim().length > 0) return truncate(v.trim());
    if (typeof v === "number" || typeof v === "boolean") return truncate(String(v));
    // Blank/missing under the title key for THIS row — fall through to the
    // generic scan below rather than silently omitting the sample.
  }

  // Prefer a non-empty string value.
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) {
      return truncate(v.trim());
    }
  }
  // Else any scalar (number/boolean).
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === "number" || typeof v === "boolean") {
      return truncate(String(v));
    }
  }
  return null;
}

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// loadReadableRegistryDigest
// ---------------------------------------------------------------------------

/**
 * Load the actor's readable-registry digest for the analyst.
 *
 * @param pool       the grants/records pool
 * @param tenantId   the actor's resolved tenant UUID
 * @param actorSlug  the actor identity (employee slug / OIDC sub)
 * @param nowMs      grant validity-window instant
 * @param opts       bounding options (registryLimit / sampleLimit / scanLimit)
 */
export async function loadReadableRegistryDigest(
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
  nowMs: number,
  opts: RegistryDigestOptions = {},
): Promise<ReadableRegistryDigest> {
  const registryLimit = opts.registryLimit ?? DEFAULT_REGISTRY_LIMIT;
  const sampleLimit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const scanLimit = opts.scanLimit ?? DEFAULT_SCAN_LIMIT;
  const numericFieldLimit = opts.numericFieldLimit ?? DEFAULT_NUMERIC_FIELD_LIMIT;

  try {
    // 1) Resolve the actor's covering READ grants + composite ancestry — the SAME
    //    single-resolver path the records LIST endpoint uses (READ-PDP T-0570).
    const [grants, orgOracle] = await Promise.all([
      getGrantsForSubject(pool, tenantId, actorSlug, nowMs),
      loadTenantOrgAncestry(pool, tenantId),
    ]);
    const emptyRowIndex = new Map<string, RowAncestry>();
    const ancestry = makeResourceAncestryOracle(orgOracle, emptyRowIndex);

    // 2) List the tenant's PUBLISHED registries (draft/sandbox registries are not
    //    part of the actor's live data view). RLS-scoped read tx.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client.query("SET LOCAL search_path TO choros");

      // Sandbox gate via the canonical predicate module (FF-10 tier-isolation):
      // the digest is deliberately published-only for EVERY actor
      // (actorIsPrivileged:false) — draft/sandbox registries never feed the
      // LLM context, even for owners (conservative MVP, ADR-T0607 §1.1).
      const regRes = await client.query<{
        id: string;
        slug: string;
        display_name: string;
        application_id: string;
        record_schema: unknown;
      }>(
        `SELECT rd.id, rd.slug, rd.display_name, rd.application_id, rd.record_schema
           FROM choros.registry_def rd
           JOIN choros.application a
             ON a.tenant_id = rd.tenant_id AND a.id = rd.application_id
          WHERE rd.tenant_id = $1
            AND (${sandboxReadPredicate({ tierColumn: "a.tier", actorIsPrivileged: false }).sql})
          ORDER BY rd.created_at ASC
          LIMIT $2`,
        [tenantId, registryLimit],
      );

      const registries: ReadableRegistryEntry[] = [];
      for (const reg of regRes.rows) {
        // Scan a bounded window of this registry's records; filter each row
        // through the READ-PDP predicate (identical to LIST records).
        const recRes = await client.query<{
          id: string;
          registry_id: string;
          application_id: string;
          data: unknown;
        }>(
          `SELECT r.id, r.registry_id, rd.application_id, r.data
             FROM choros.record r
             JOIN choros.registry_def rd
               ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
            WHERE r.tenant_id = $1
              AND r.registry_id = $2
            ORDER BY r.created_at DESC, r.id ASC
            LIMIT $3`,
          [tenantId, reg.id, scanLimit],
        );

        // T-0587 (§1.4): numeric fields are derived ONCE per registry, from
        // its OWN record_schema — generic (D-064), bounded (NF-5).
        const numericFields = pickNumericFieldKeys(reg.record_schema, numericFieldLimit);
        const numericAccs = initNumericAccumulators(numericFields.map((f) => f.key));
        const numericLabels = new Map(numericFields.map((f) => [f.key, f.label]));

        // T-0613: the title-field key is ALSO derived ONCE per registry, from
        // the SAME record_schema pass — generic (D-064), see
        // registry-title-field.ts for the ordered heuristic + why no existing
        // signal was reusable.
        const titleFieldKey = pickTitleFieldKey(reg.record_schema);

        let visibleCount = 0;
        const samples: string[] = [];
        for (const row of recRes.rows) {
          const rowAncestry: RowAncestry = {
            recordId: row.id,
            registryId: row.registry_id,
            applicationId: row.application_id,
          };
          if (!isRecordReadable(rowAncestry, grants, ancestry, nowMs)) continue;
          // INVARIANT (FR-2/FF-2): everything below this line runs ONLY for a
          // row that just passed the READ-PDP predicate — visibleCount,
          // samples, and numericAggregates are all derived from the exact
          // same visible subset.
          visibleCount++;
          if (samples.length < sampleLimit) {
            const sample = pickSampleValue(row.data, titleFieldKey);
            if (sample !== null) samples.push(sample);
          }
          if (numericFields.length > 0) {
            accumulateNumeric(numericAccs, row.data, numericFields.map((f) => f.key));
          }
        }

        const numericAggregates = finalizeNumeric(numericAccs, numericLabels);

        // Adversary-honesty fix (non-blocking, T-0587): the scan is bounded by
        // `scanLimit` (LIMIT $3 above). When the DB returned EXACTLY that many
        // rows, there may be MORE readable records this digest never saw —
        // visibleCount/samples/numericAggregates would then understate the
        // true readable set. Flag it so the caller can render an honest
        // "possibly incomplete" note instead of implying a complete count.
        const truncated = recRes.rows.length === scanLimit;

        registries.push({
          slug: reg.slug,
          displayName: reg.display_name,
          visibleCount,
          samples,
          ...(numericAggregates.length > 0 ? { numericAggregates } : {}),
          ...(truncated ? { truncated: true, scannedLimit: scanLimit } : {}),
        });
      }

      await client.query("COMMIT");
      return { degraded: false, registries };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    // Honest-degrade: never throw into the analyst path; never let the caller
    // claim «записей нет» on a read failure.
    console.error(`[T-0607] loadReadableRegistryDigest failed (honest-degrade): ${String(err)}`);
    return { degraded: true, registries: [] };
  }
}
