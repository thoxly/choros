/**
 * T-0238 · T-0134a: doc_page / doc_ref / doc_log row type mirrors.
 *
 * TS mirror of the three tenant-tables defined in migrations/061_doc_page.sql.
 * Convention (T-0014): camelCase; string for uuid; number for bigint.
 *
 * These are read-only type mirrors — no store implementation (that belongs to
 * later tasks T-0134e/T-0134f). Additive only; no second authz mechanism.
 *
 * T-0211 · P-3: REGEN write/read layer added here (§7 of T-0211 ADR).
 * Single-writer discipline — all doc SQL lives in this module; no raw doc SQL elsewhere.
 * Helpers take a caller-owned transaction (never open their own connection).
 */

// ---------------------------------------------------------------------------
// DocPage — unit of content in the agent-maintained wiki (ADR §2.1)
// ---------------------------------------------------------------------------

/** Row mirror of choros.doc_page (migration 061). */
export interface DocPage {
  tenantId: string;
  id: string;
  slug: string;
  title: string;
  body: string;
  /** 'system' = common product doc projected per-tenant; 'tenant' = per-tenant doc. */
  scope: 'system' | 'tenant';
  /** Version of system-docs package for scope='system' projections; null for scope='tenant'. */
  catalogVersion: string | null;
  /** Nullable FK → application(tenant_id, id): navigation section binding. */
  appId: string | null;
  /** Set to true by lint-pass when a doc_ref referent is missing in the live system. */
  stale: boolean;
  /** Agent that authored this page (nature of task: docs are written by agents). */
  authoredBy: string;
  authoredAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// DocRef — registry of typed references to live system elements (ADR §2.2)
// Sibling of report_page_dep (T-0121): «doc_page ↔ referent in live system».
// ---------------------------------------------------------------------------

/** Row mirror of choros.doc_ref (migration 061). */
export interface DocRef {
  tenantId: string;
  id: string;
  /** FK → doc_page(tenant_id, id) ON DELETE CASCADE. */
  pageId: string;
  /** Closed vocab: code_symbol | rest_endpoint | schema_field | process | config_key. */
  refKind: string;
  /** Typed machine-resolvable identifier per ref_kind — NOT free text (FF-DOCREF-TYPED). */
  refTarget: Record<string, string>;
  /** Set to true by lint-pass when the referent is absent from the live system. */
  broken: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// DocLog — changelog of doc edits — LLM-wiki 'log' member (ADR §2.3)
// op is open-vocab (pattern T-0016 audit_event.type); no closed CHECK in DB.
// ---------------------------------------------------------------------------

/** Row mirror of choros.doc_log (migration 061). */
export interface DocLog {
  tenantId: string;
  id: string;
  /** FK → doc_page(tenant_id, id) ON DELETE CASCADE. */
  pageId: string;
  /**
   * Open-vocab operation label — e.g. 'authored' | 'updated' | 'marked_stale' |
   * 'ref_fixed' | 'system_doc_projected'. Not a closed CHECK (pattern T-0016).
   */
  op: string;
  /** Agent actor that performed the operation. */
  agentActor: string;
  /** Human/machine-readable change summary (optional). */
  diffSummary: string | null;
  at: number;
}

// ---------------------------------------------------------------------------
// T-0211 · P-3: Minimal pg-client surface (caller-owned transaction)
// Mirrors AuditWriter.PgClientLike — no hard pg dependency in this module.
// ---------------------------------------------------------------------------

/** Minimal pg client surface compatible with pg.PoolClient / pg.Client. */
export interface DocStoreClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

// ---------------------------------------------------------------------------
// T-0211 · P-3 · §7.1 — Read helpers
// ---------------------------------------------------------------------------

/**
 * Reads all doc_page rows for `tenantId` from the current connection.
 * The caller must have SET LOCAL choros.tenant_id before calling (RLS).
 * The explicit tenant_id predicate is belt-and-suspenders (NF-1).
 */
export async function readDocPages(
  client: DocStoreClient,
  tenantId: string,
): Promise<DocPage[]> {
  const { rows } = await client.query(
    `SELECT tenant_id, id, slug, title, body, scope, catalog_version, app_id,
            stale, authored_by, authored_at, updated_at
       FROM choros.doc_page
      WHERE tenant_id = $1
      ORDER BY slug`,
    [tenantId],
  );
  return rows.map((r) => ({
    tenantId: r['tenant_id'] as string,
    id: r['id'] as string,
    slug: r['slug'] as string,
    title: r['title'] as string,
    body: r['body'] as string,
    scope: r['scope'] as 'system' | 'tenant',
    catalogVersion: r['catalog_version'] as string | null,
    appId: r['app_id'] as string | null,
    stale: r['stale'] as boolean,
    authoredBy: r['authored_by'] as string,
    authoredAt: Number(r['authored_at']),
    updatedAt: Number(r['updated_at']),
  }));
}

/**
 * Reads all doc_ref rows for `tenantId` from the current connection.
 * Returns rows with pageId populated (denormalized from the DB join key).
 */
export async function readDocRefs(
  client: DocStoreClient,
  tenantId: string,
): Promise<(DocRef)[]> {
  const { rows } = await client.query(
    `SELECT tenant_id, id, page_id, ref_kind, ref_target, broken, created_at
       FROM choros.doc_ref
      WHERE tenant_id = $1
      ORDER BY page_id, ref_kind`,
    [tenantId],
  );
  return rows.map((r) => ({
    tenantId: r['tenant_id'] as string,
    id: r['id'] as string,
    pageId: r['page_id'] as string,
    refKind: r['ref_kind'] as string,
    refTarget: r['ref_target'] as Record<string, string>,
    broken: r['broken'] as boolean,
    createdAt: Number(r['created_at']),
  }));
}

// ---------------------------------------------------------------------------
// T-0211 · P-3 · §7.2 — Write helpers (idempotent, single-writer)
// All SQL stays in this module — no raw doc SQL outside (single-writer discipline).
// Helpers run INSIDE the caller's transaction; they never BEGIN/COMMIT/ROLLBACK.
// ---------------------------------------------------------------------------

/** Action outcome for an upserted page. */
export type UpsertAction = 'inserted' | 'updated' | 'unchanged';

export interface UpsertDocPageResult {
  id: string;
  action: UpsertAction;
}

/**
 * Upserts a doc_page row, preserving id/authored_at/scope on conflict.
 * Uses change-guard: if body and title are byte-identical, the row is not bumped
 * (updated_at is NOT changed, action='unchanged'). This avoids log spam on
 * true no-op re-runs (ADR §6.2 SHOULD).
 *
 * ON CONFLICT (tenant_id, slug): preserves id, authored_at, scope.
 * id minting: caller supplies a candidate id (for inserts); on conflict the
 * existing id is kept (returned). The candidate id is ignored on update.
 *
 * @param client    caller's open transaction (choros.tenant_id GUC set)
 * @param tenantId  explicit tenantId (belt-and-suspenders, RLS already set)
 * @param page      page data (id is candidate for insert; slug is the idempotency key)
 */
export async function upsertDocPage(
  client: DocStoreClient,
  tenantId: string,
  page: {
    id: string;
    slug: string;
    title: string;
    body: string;
    authoredBy: string;
    authoredAt: number;
    updatedAt: number;
  },
): Promise<UpsertDocPageResult> {
  // INSERT ... ON CONFLICT (tenant_id, slug) DO UPDATE with change-guard.
  // We use a RETURNING clause to get the resolved id and whether a change occurred.
  //
  // Change-guard: EXCLUDED.body IS DISTINCT FROM doc_page.body
  //   OR EXCLUDED.title IS DISTINCT FROM doc_page.title
  // → only updates (and bumps updated_at) when content actually changed.
  //
  // authored_at is preserved on conflict (keeps original creation time).
  // scope is always 'tenant' for REGEN (ADR §5.2).
  // stale is always false for REGEN (ADR §5.2).
  // catalog_version and app_id are NULL (ADR §5.2).

  const { rows } = await client.query(
    `INSERT INTO choros.doc_page
       (tenant_id, id, slug, title, body, scope, catalog_version, app_id,
        stale, authored_by, authored_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'tenant', NULL, NULL, false, $6, $7, $8)
     ON CONFLICT (tenant_id, slug) DO UPDATE
       SET title      = EXCLUDED.title,
           body       = EXCLUDED.body,
           authored_by = EXCLUDED.authored_by,
           updated_at  = CASE
             WHEN doc_page.body IS DISTINCT FROM EXCLUDED.body
               OR doc_page.title IS DISTINCT FROM EXCLUDED.title
             THEN EXCLUDED.updated_at
             ELSE doc_page.updated_at
           END
       WHERE doc_page.tenant_id = $1
     RETURNING
       id,
       (xmax = 0)                                       AS was_inserted,
       (doc_page.updated_at = $8
        AND (xmax <> 0))                                AS was_updated
    `,
    [tenantId, page.id, page.slug, page.title, page.body, page.authoredBy, page.authoredAt, page.updatedAt],
  );

  if (rows.length === 0) {
    // Should not happen with ON CONFLICT DO UPDATE, but guard defensively.
    throw new Error(`upsertDocPage: no row returned for slug=${page.slug}, tenant=${tenantId}`);
  }
  const row = rows[0]!;
  const id = row['id'] as string;
  const wasInserted = row['was_inserted'] as boolean;
  const wasUpdated = row['was_updated'] as boolean;

  let action: UpsertAction;
  if (wasInserted) {
    action = 'inserted';
  } else if (wasUpdated) {
    action = 'updated';
  } else {
    action = 'unchanged';
  }

  return { id, action };
}

/**
 * Set-replaces doc_ref rows for one page:
 * 1. Deletes refs for this page NOT in the new set (removed referents).
 * 2. Upserts each ref in the new set (DO NOTHING on exact-match conflict).
 *
 * Scoped to ONE page_id — never touches other pages' refs (ADR §6.4).
 * Caller must pass the correct resolved page id (from upsertDocPage result).
 *
 * @param client   caller's open transaction
 * @param tenantId explicit tenantId
 * @param pageId   resolved page UUID (from upsertDocPage)
 * @param refs     planned refs for this page (ref_kind + ref_target + candidate id + created_at)
 */
export async function setDocRefs(
  client: DocStoreClient,
  tenantId: string,
  pageId: string,
  refs: ReadonlyArray<{
    id: string;
    refKind: string;
    refTarget: Record<string, string>;
    createdAt: number;
  }>,
): Promise<{ set: number; deleted: number }> {
  if (refs.length === 0) {
    // Delete all existing refs for this page (page now has no refs).
    const delResult = await client.query(
      `DELETE FROM choros.doc_ref WHERE tenant_id = $1 AND page_id = $2`,
      [tenantId, pageId],
    );
    // pg returns rowCount on DELETE; work around the type.
    const deleted = (delResult as unknown as { rowCount: number }).rowCount ?? 0;
    return { set: 0, deleted };
  }

  // Build JSON array of planned ref_targets for the DELETE (exclude planned refs).
  // We delete refs whose (ref_kind, ref_target) pair is NOT in the planned set.
  const plannedPairs = refs.map((r) => ({ ref_kind: r.refKind, ref_target: r.refTarget }));

  // Delete refs not in the planned set for this page.
  // Strategy: delete WHERE (ref_kind, ref_target::text) NOT IN planned set.
  // We use a NOT EXISTS approach with a json array for type-safety.
  //
  // Build the NOT IN clause via an unnested array of (ref_kind, ref_target) composites.
  // Postgres can compare jsonb equality: ref_target = ANY(ARRAY[...]).
  // We use a loop of OR NOT conditions via jsonb matching.
  //
  // Simpler and safe: delete refs for this page that don't match ANY planned pair.
  // We pass the planned pairs as a JSONB array and check with @> (jsonb containment).
  const plannedPairsJson = JSON.stringify(plannedPairs);
  const delResult = await client.query(
    `DELETE FROM choros.doc_ref
      WHERE tenant_id = $1
        AND page_id   = $2
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements($3::jsonb) AS p
           WHERE p->>'ref_kind' = ref_kind
             AND (p->'ref_target') = ref_target
        )`,
    [tenantId, pageId, plannedPairsJson],
  );
  const deleted = (delResult as unknown as { rowCount: number }).rowCount ?? 0;

  // Upsert each planned ref (DO NOTHING on exact conflict).
  let set = 0;
  for (const ref of refs) {
    await client.query(
      `INSERT INTO choros.doc_ref
         (tenant_id, id, page_id, ref_kind, ref_target, broken, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, false, $6)
       ON CONFLICT (tenant_id, page_id, ref_kind, ref_target) DO NOTHING`,
      [tenantId, ref.id, pageId, ref.refKind, JSON.stringify(ref.refTarget), ref.createdAt],
    );
    set++;
  }

  return { set, deleted };
}

/**
 * Marks a doc_page row stale (or clears the stale flag) WITHOUT touching body/title/refs.
 * Used by RECONCILE's orphan branch (ADR §2.2 / §7): marks a page stale=true when all
 * its backing members have vanished from the live system (tombstone — page is kept, not deleted).
 * Also used to clear stale=false (though upsertDocPage already does that on regenerate).
 *
 * UPDATE choros.doc_page SET stale = $3, updated_at = $4 WHERE tenant_id = $1 AND id = $2
 *
 * Scoped to ONE page_id; tenant-scoped (RLS + explicit predicate, NF-1).
 * Runs INSIDE the caller's transaction; never opens its own connection.
 *
 * @param client    caller's open transaction (choros.tenant_id GUC set)
 * @param tenantId  explicit tenantId (belt-and-suspenders, RLS already set)
 * @param pageId    the specific page to update
 * @param stale     true = mark stale (orphan); false = clear stale
 * @param updatedAt epoch-ms timestamp for the update
 */
export async function markPageStale(
  client: DocStoreClient,
  tenantId: string,
  pageId: string,
  stale: boolean,
  updatedAt: number,
): Promise<void> {
  await client.query(
    `UPDATE choros.doc_page
        SET stale = $3, updated_at = $4
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, pageId, stale, updatedAt],
  );
}

/**
 * Appends a doc_log row (append-only; no upsert — log is history).
 *
 * @param client      caller's open transaction
 * @param tenantId    explicit tenantId
 * @param pageId      the page this log entry belongs to
 * @param id          log row UUID (caller-minted)
 * @param op          open-vocab operation (e.g. 'regenerated')
 * @param agentActor  agent actor label (e.g. 'docs-author')
 * @param diffSummary optional human/machine summary of the change
 * @param at          epoch-ms timestamp
 */
export async function appendDocLog(
  client: DocStoreClient,
  tenantId: string,
  pageId: string,
  id: string,
  op: string,
  agentActor: string,
  diffSummary: string | null,
  at: number,
): Promise<void> {
  await client.query(
    `INSERT INTO choros.doc_log
       (tenant_id, id, page_id, op, agent_actor, diff_summary, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, id, pageId, op, agentActor, diffSummary, at],
  );
}
