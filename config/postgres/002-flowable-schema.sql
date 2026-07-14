-- T-0058: Create dedicated 'flowable' schema for Flowable's ACT_* tables.
-- Runs once on Postgres first-init via docker-entrypoint-initdb.d (ordered
-- lexicographically after 001-keycloak-schema.sql).
-- The choros_migrator bootstrap user (POSTGRES_USER) owns this schema.
-- Flowable connects as choros_migrator and its Liquibase run creates all
-- ACT_* tables inside the 'flowable' schema — never colliding with choros_*
-- tables in the 'public' schema.
-- The choros_app runtime role has NO access to the flowable schema.
CREATE SCHEMA IF NOT EXISTS flowable;
