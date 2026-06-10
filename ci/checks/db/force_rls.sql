-- FF-RLS (AC-5): every choros base table (the known tenant tables) MUST have
-- ENABLE + FORCE row level security. This query returns the offending tables;
-- a non-empty result = a violation. The db CI job asserts 0 rows.
--
-- (The authoritative gating check is ci/checks/db/schema.test.ts FF-RLS; this
-- SQL is the ADR-named human-runnable probe — `psql -f force_rls.sql`.)
SELECT cls.relname AS table_missing_force_rls
  FROM pg_class cls
  JOIN pg_namespace ns ON cls.relnamespace = ns.oid
 WHERE ns.nspname = 'choros'
   AND cls.relkind = 'r'
   AND cls.relname <> 'schema_migrations'
   AND NOT (cls.relrowsecurity AND cls.relforcerowsecurity)
 ORDER BY cls.relname;
