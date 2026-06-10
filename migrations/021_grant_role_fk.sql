-- 021 · grant.role_id deferred FK (T-0022 FR-5) — promote to a real FK.
--
-- migration 008 created grant.role_id as a PLAIN uuid NOT NULL with NO FK,
-- because role/role_assignment were undesigned and a baseline FK to a
-- non-existent table would fail to apply. The T-0018 ADR (§1.2 / open-items #4)
-- and 008's header explicitly name THIS task as the one that adds it.
--
-- This is a pure additive ALTER (the table already exists), split into its own
-- file so 019 creates `role` first and this migration is independently appliable.
--
-- The FK is tenant-scoped (NF-2): (tenant_id, role_id) on both sides, targeting
-- the role PK (tenant_id, id). A grant in tenant-A referencing a role.id that
-- exists only in tenant-B is rejected (AC-14). A grant whose role_id names no
-- existing role is rejected with 23503 (AC-13) — the same insert SUCCEEDED before
-- this migration (regression guard).
--
-- SAFE ON EXISTING DATA: verified live against the dev base (migrations 001-016)
-- — the `grant` table is EMPTY (no seed rows in any migration), so the FK
-- validation pass finds no orphan role_id. Any FUTURE grant seed MUST reference a
-- role seeded in 019 (seed ordering: 019 role < grant seed).
--
-- The grant.role_id NOT NULL floor (the ratified T-0018 contract the resolver
-- T-0021 reads) is UNCHANGED; this migration only adds referential integrity.
-- The constraint is NAMED so the FF-FK-RESOLVE fitness check can assert it by name.

ALTER TABLE choros."grant"
  ADD CONSTRAINT grant_role_id_fkey
  FOREIGN KEY (tenant_id, role_id)
  REFERENCES choros.role(tenant_id, id);
