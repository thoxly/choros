-- T-0054: Create dedicated 'keycloak' schema for Keycloak's internal tables.
-- Runs once on Postgres first-init via docker-entrypoint-initdb.d.
-- The choros_migrator bootstrap user (POSTGRES_USER) owns this schema.
-- Keycloak connects as choros_migrator and writes to the 'keycloak' schema only.
-- The choros_app runtime role has NO access to the keycloak schema (schema isolation).
CREATE SCHEMA IF NOT EXISTS keycloak;
