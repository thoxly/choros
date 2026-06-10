-- 018 · actor_event (T-0019 E4.1) — the typed, append-only SoD substrate.
--
-- One row per governance-significant actor action against an object: the typed
-- verb trail {request, prepare, submit, approve, release} per object, the source
-- of truth Separation-of-Duties (T-0032/E4.2) queries fold over. NOT the audit
-- floor (T-0016): no hash chain, no head snapshot, no FK to audit_event (§2/AC-21).
--
-- Tenant table (T-0013 inherited verbatim): tenant_id NOT NULL leading PK column;
-- ENABLE + FORCE RLS; one default-DENY policy on the choros.tenant_id GUC;
-- choros_app NOBYPASSRLS. PK (tenant_id, seq); UNIQUE (tenant_id, id).
--
-- Append-only is enforced TWO ways (same dual mechanism as 006_audit_event):
--   (a) choros_app is granted SELECT, INSERT only — no UPDATE/DELETE (AC-4/5/7);
--   (b) BEFORE UPDATE / BEFORE DELETE triggers reject mutation for ALL roles,
--       including the owner choros_migrator (defence in depth — AC-6).
--
-- Ordering: per-tenant strictly-increasing `seq` (sparse-tolerant) assigned via a
-- per-tenant counter row actor_event_seq locked FOR UPDATE — NEVER a global
-- SEQUENCE/advisory lock (AC-8/9; §3.2). actor_event_seq is a bare cursor: no
-- row_hash, no chain → it is NOT a head/chain artefact, so AC-21 holds.
--
-- Identity: actor (= performed_by, NOT NULL, FK→employee) is the performer;
-- on_behalf_of (nullable, FK→employee) is the principal when ≠ performer; SoD
-- attributes to COALESCE(on_behalf_of, actor) (§3.3/AC-11/12). kind∈{human,agent}
-- is DELIBERATELY NOT a column here — human and agent are equal actors (AC-13).
-- role_at_event (NOT NULL uuid) is the point-in-time role; it carries NO FK to
-- `role` (undesigned — T-0022; mirrors grant.role_id in 008_grant.sql; AC-14).
--
-- object_ref: a denormalized opaque ResourceRef à la 009_object_handle (object_kind
-- CHECK + nullable, non-FK component ids; AC-15). References, never values — no
-- data/snapshot/view/payload column; the only jsonb is `detail` event-metadata
-- (FR-6/AC-17). Verbs are a CLOSED, vocab-versioned set (AC-18/19/20).

-- ---------------------------------------------------------------------------
-- Per-tenant ordinal counter (§3.2 / §4.2) — seq serialization primitive.
-- ---------------------------------------------------------------------------
CREATE TABLE choros.actor_event_seq (
  tenant_id uuid   NOT NULL,
  next_seq  bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id)
);

ALTER TABLE choros.actor_event_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.actor_event_seq FORCE ROW LEVEL SECURITY;

CREATE POLICY actor_event_seq_tenant_isolation ON choros.actor_event_seq
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

-- The append path advances the counter under SELECT … FOR UPDATE, so the runtime
-- role needs SELECT, INSERT (genesis row), UPDATE (advance) — but NEVER DELETE.
GRANT SELECT, INSERT, UPDATE ON choros.actor_event_seq TO choros_app;

-- ---------------------------------------------------------------------------
-- The ledger (§4.1).
-- ---------------------------------------------------------------------------
CREATE TABLE choros.actor_event (
  tenant_id      uuid     NOT NULL,
  seq            bigint   NOT NULL,
  id             uuid     NOT NULL,
  object_kind    text     NOT NULL CHECK (object_kind IN ('application', 'registry', 'record')),
  application_id uuid     NULL,
  registry_id    uuid     NULL,
  record_id      uuid     NULL,
  actor          uuid     NOT NULL,
  on_behalf_of   uuid     NULL,
  role_at_event  uuid     NOT NULL,
  event          text     NOT NULL CHECK (event IN ('request', 'prepare', 'submit', 'approve', 'release')),
  approve_level  smallint NULL,
  detail         jsonb    NULL,
  ts             bigint   NOT NULL,
  vocab_version  smallint NOT NULL,
  PRIMARY KEY (tenant_id, seq),
  UNIQUE (tenant_id, id),
  -- approve_level is non-null IFF event='approve' (§3.5 / AC-19) …
  CONSTRAINT actor_event_approve_level_iff
    CHECK ((event = 'approve') = (approve_level IS NOT NULL)),
  -- … and, when present, is an orderable level ≥ 1 (L1 < L2 < … multi-step chains).
  CONSTRAINT actor_event_approve_level_ge1
    CHECK (approve_level IS NULL OR approve_level >= 1),
  -- actor/on_behalf_of FK→employee, tenant-scoped on both sides (§3.3; buildable
  -- per T-0017). role_at_event carries NO FK (role undesigned — T-0022).
  FOREIGN KEY (tenant_id, actor)
    REFERENCES choros.employee (tenant_id, id),
  FOREIGN KEY (tenant_id, on_behalf_of)
    REFERENCES choros.employee (tenant_id, id)
);

ALTER TABLE choros.actor_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.actor_event FORCE ROW LEVEL SECURITY;

CREATE POLICY actor_event_tenant_isolation ON choros.actor_event
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

-- Object read path (§3.4 / AC-16): tenant_id leading (AC-3), object components,
-- trailing seq so the per-object trail is index-ordered (EXPLAIN → index scan).
CREATE INDEX actor_event_object_read
  ON choros.actor_event
     (tenant_id, object_kind, record_id, registry_id, application_id, seq);

-- No-mutate trigger function: rejects any UPDATE/DELETE on the ledger for ALL
-- roles, the owner included (defence in depth — AC-6).
CREATE OR REPLACE FUNCTION choros.actor_event_immutable()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'actor_event is append-only: % is forbidden', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER actor_event_no_update
  BEFORE UPDATE ON choros.actor_event
  FOR EACH ROW EXECUTE FUNCTION choros.actor_event_immutable();

CREATE TRIGGER actor_event_no_delete
  BEFORE DELETE ON choros.actor_event
  FOR EACH ROW EXECUTE FUNCTION choros.actor_event_immutable();

-- Append-only for the runtime role: SELECT/INSERT only (no UPDATE/DELETE).
GRANT SELECT, INSERT ON choros.actor_event TO choros_app;
