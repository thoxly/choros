-- FF-FK-RESOLVE (AC-14): every baseline FK MUST resolve to a baseline-created
-- table; no FK may target role/assignment (undesigned) or any non-baseline
-- table; grant.role_id MUST carry NO FK (the §1.2 deferral). This query returns
-- offending FKs; a non-empty result = a violation. The db CI job asserts 0 rows.
--
-- (Authoritative gating check: ci/checks/db/schema.test.ts FF-FK-RESOLVE.)
SELECT cls.relname  AS src_table,
       ref.relname  AS dst_table,
       con.conname  AS constraint_name
  FROM pg_constraint con
  JOIN pg_class cls ON cls.oid = con.conrelid
  JOIN pg_class ref ON ref.oid = con.confrelid
  JOIN pg_namespace ns ON ns.oid = cls.relnamespace
 WHERE ns.nspname = 'choros'
   AND con.contype = 'f'
   AND (
        ref.relname IN ('role', 'assignment')                    -- undesigned target
     OR ref.relname NOT IN (                                      -- non-baseline target
          'job', 'application', 'registry_def', 'record',
          'audit_event', 'audit_head', 'grant', 'object_handle'
        )
     OR (cls.relname = 'grant')                                   -- grant must have NO FK
   );
