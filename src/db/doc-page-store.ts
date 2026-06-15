/**
 * T-0238 · T-0134a: doc_page / doc_ref / doc_log row type mirrors.
 *
 * TS mirror of the three tenant-tables defined in migrations/061_doc_page.sql.
 * Convention (T-0014): camelCase; string for uuid; number for bigint.
 *
 * These are read-only type mirrors — no store implementation (that belongs to
 * later tasks T-0134e/T-0134f). Additive only; no second authz mechanism.
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
