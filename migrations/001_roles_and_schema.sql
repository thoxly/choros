-- 001 · Schema + DB roles (T-0053, E0.3 · ADR §1.1/§4.3)
--
-- Provisions the load-bearing schema/role layout as the FIRST ordered file, so
-- the role arrangement is part of the same ordered, skip-applied, CI-replayed
-- migration history as the tables (NF-4 one bring-up path) — portable to any
-- Postgres, not tied to the container entrypoint.
--
-- The runner connects as choros_migrator (the container bootstrap superuser),
-- which therefore owns the schema and every table created by 002–009.
-- This migration creates only the non-owner runtime role choros_app.
--
-- Idempotent: CREATE SCHEMA IF NOT EXISTS + a DO-block guarded CREATE ROLE.
-- The choros_app password is a DEV-ONLY default; prod injects CHOROS_APP_PASSWORD
-- at deploy time (RL-1/NF-5) — the runner expands ${...} before executing.

-- All baseline tables live in the dedicated `choros` schema (NOT public), which
-- leaves the ACT_* namespace free for a future Flowable's Liquibase on the same
-- instance without collision (FR-6 / AC-16). Flowable is NOT installed here.
CREATE SCHEMA IF NOT EXISTS choros AUTHORIZATION CURRENT_USER;

-- choros_app — the runtime connection role.
-- NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE: cannot bypass RLS, owns no
-- table, holds no DDL. Per-table DML is granted by each table's own migration;
-- audit_event is SELECT/INSERT only, audit_head has no DELETE (T-0016 §3.1).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'choros_app') THEN
    CREATE ROLE choros_app LOGIN
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
      PASSWORD '${CHOROS_APP_PASSWORD:-choros_app_dev_pw}';
  END IF;
END
$$;

-- USAGE only — never CREATE: choros_app can reference objects in the schema but
-- cannot run DDL against it (AC-11/AC-16 "lacks CREATE on any schema").
GRANT USAGE ON SCHEMA choros TO choros_app;
