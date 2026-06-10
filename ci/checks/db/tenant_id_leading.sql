-- FF-LEAD (AC-7): tenant_id MUST be column 1 of every composite index and every
-- FK on a choros tenant table. This query returns the offending objects; a
-- non-empty result = a violation. The db CI job asserts 0 rows.
--
-- (Authoritative gating check: ci/checks/db/schema.test.ts FF-LEAD.)

-- Composite indexes whose leading column is not tenant_id.
SELECT cls.relname AS table_name,
       'index'      AS kind,
       att.attname  AS leading_col
  FROM pg_index idx
  JOIN pg_class cls ON cls.oid = idx.indrelid
  JOIN pg_namespace ns ON ns.oid = cls.relnamespace
  JOIN pg_attribute att ON att.attrelid = idx.indrelid AND att.attnum = idx.indkey[0]
 WHERE ns.nspname = 'choros'
   AND cls.relname <> 'schema_migrations'
   AND array_length(idx.indkey::int[], 1) > 1
   AND att.attname <> 'tenant_id'
UNION ALL
-- Foreign keys whose first key column is not tenant_id.
SELECT cls.relname AS table_name,
       'fk'         AS kind,
       att.attname  AS leading_col
  FROM pg_constraint con
  JOIN pg_class cls ON cls.oid = con.conrelid
  JOIN pg_namespace ns ON ns.oid = cls.relnamespace
  JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
 WHERE ns.nspname = 'choros'
   AND con.contype = 'f'
   AND att.attname <> 'tenant_id';
