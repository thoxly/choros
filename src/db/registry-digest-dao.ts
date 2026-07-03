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
 */

import pg from "pg";
import { getGrantsForSubject } from "./grants-dao.js";
import { loadTenantOrgAncestry } from "./org-ancestry.js";
import { makeResourceAncestryOracle } from "./resource-ancestry.js";
import { isRecordReadable, type RowAncestry } from "../core/read-visibility.js";
import { sandboxReadPredicate } from "../core/sandbox-gate.js";

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
}

const DEFAULT_REGISTRY_LIMIT = 25;
const DEFAULT_SAMPLE_LIMIT = 3;
const DEFAULT_SCAN_LIMIT = 200;

// ---------------------------------------------------------------------------
// Sample-value extraction (generic — D-064: no case-specific field names).
// ---------------------------------------------------------------------------

/**
 * Pick a short, human-readable representative value from a record's `data`.
 * Generic: prefers the first non-empty string scalar (by key order), then any
 * scalar, else a compact JSON fallback. Truncated to keep the LLM context lean.
 */
function pickSampleValue(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
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
      }>(
        `SELECT rd.id, rd.slug, rd.display_name, rd.application_id
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

        let visibleCount = 0;
        const samples: string[] = [];
        for (const row of recRes.rows) {
          const rowAncestry: RowAncestry = {
            recordId: row.id,
            registryId: row.registry_id,
            applicationId: row.application_id,
          };
          if (!isRecordReadable(rowAncestry, grants, ancestry, nowMs)) continue;
          visibleCount++;
          if (samples.length < sampleLimit) {
            const sample = pickSampleValue(row.data);
            if (sample !== null) samples.push(sample);
          }
        }

        registries.push({
          slug: reg.slug,
          displayName: reg.display_name,
          visibleCount,
          samples,
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
