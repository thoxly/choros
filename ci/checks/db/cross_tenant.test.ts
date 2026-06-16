// T-0115 · Cross-tenant CI-blocker — 152-FZ invariant.
//
// Verifies from the real choros_app role (NOBYPASSRLS) that a query executing
// in the context of TENANT_A CANNOT read or mutate rows belonging to TENANT_B.
//
// Covers: AC-1 · AC-2 · AC-3 · AC-4 · AC-5 · AC-6 · AC-9
// (AC-7/AC-8 are in pgJobStore.integration.test.ts; AC-10..AC-12 in cross-tenant-fitness.sh)
//
// Seed strategy: all INSERT operations go through migratorUrl() (bypasses RLS).
// All cross-tenant probes go through appUrl() (choros_app, NOBYPASSRLS).
// Post-mutation verification goes through migratorUrl() to confirm physical integrity.
//
// NF-2: this file MUST use appUrl() — only choros_app proves the 152-FZ invariant.
// NF-3: iterates over KNOWN_TENANT_TABLES (not a hardcoded subset).

import { describe, it, expect, beforeAll } from 'vitest';
import pg from 'pg';
import {
  appUrl,
  migratorUrl,
  withClient,
  TENANT_A,
  TENANT_B,
  KNOWN_TENANT_TABLES,
  uuid,
} from './_helpers.js';

// ---------------------------------------------------------------------------
// Seed helpers — insert minimal valid rows into each tenant table.
// All seeds use migratorUrl() to bypass RLS.
// ---------------------------------------------------------------------------

/** Seed one row into choros.application for the given tenant. Returns the app id. */
async function seedApplication(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const slug = `ct-app-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, slug],
  );
  return id;
}

/** Seed one row into choros.registry_def. Returns the registry_def id. */
async function seedRegistryDef(c: pg.Client, tenantId: string, applicationId: string): Promise<string> {
  const id = uuid();
  const slug = `ct-reg-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '{}'::jsonb, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, applicationId, slug],
  );
  return id;
}

/** Seed one row into choros.record. Returns the record id. */
async function seedRecord(c: pg.Client, tenantId: string, registryId: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.record
       (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, '{}'::jsonb, 0, 0, 'ct-tester')`,
    [tenantId, id, registryId],
  );
  return id;
}

/** Seed one row into choros.audit_event. Returns the event id. */
async function seedAuditEvent(c: pg.Client, tenantId: string, seq: number): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.audit_event
       (tenant_id, seq, id, type, actor, payload, occurred_at,
        prev_hash, row_hash, vocab_version)
     VALUES ($1, $2, $3, 'ct-test', 'ct-tester', '{}'::jsonb, 0,
             '\\x00'::bytea, '\\x01'::bytea, 1)
     ON CONFLICT DO NOTHING`,
    [tenantId, seq, id],
  );
  return id;
}

/** Seed one row into choros.audit_head. */
async function seedAuditHead(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.audit_head
       (tenant_id, seq, row_hash, updated_at, vocab_version)
     VALUES ($1, 0, '\\x00'::bytea, 0, 1)
     ON CONFLICT DO NOTHING`,
    [tenantId],
  );
}

/**
 * Seed one row into choros.grant. Returns the grant id.
 *
 * T-0022 (migration 021) promoted grant.role_id to a real FK → role, so the
 * grant's role_id MUST name an existing role. `grant` is iterated BEFORE `role`
 * in KNOWN_TENANT_TABLES order, so we seed a dedicated role inline here rather
 * than depend on seedState (which isn't populated yet at this point).
 */
async function seedGrant(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const roleId = await seedRoleRow(c, tenantId);
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, operation, scope, granted_by, created_at)
     VALUES ($1, $2, $3, 'application', 'read', '{}'::jsonb, 'ct-tester', 0)`,
    [tenantId, id, roleId],
  );
  return id;
}

/** Seed one row into choros.object_handle. Returns the handle id. */
async function seedObjectHandle(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.object_handle
       (tenant_id, id, ref_kind, created_at)
     VALUES ($1, $2, 'application', 0)`,
    [tenantId, id],
  );
  return id;
}

/** Seed a tenant row for the given tenant (tenant_id = id = tenantId). */
async function seedTenantRow(c: pg.Client, tenantId: string): Promise<void> {
  const slug = `ct-tenant-${tenantId.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, slug],
  );
}

/** Seed one row into choros.department. Returns the department id. */
async function seedDepartmentRow(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const slug = `ct-dept-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.department
       (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, slug],
  );
  return id;
}

/** Seed one row into choros.position. Returns the position id. */
async function seedPositionRow(c: pg.Client, tenantId: string, departmentId: string): Promise<string> {
  const id = uuid();
  const slug = `ct-pos-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.position
       (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, departmentId, slug],
  );
  return id;
}

/** Seed one row into choros.employee. */
async function seedEmployeeRow(c: pg.Client, tenantId: string, positionId: string): Promise<string> {
  const id = uuid();
  const slug = `ct-emp-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, 'human', $4, $4, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, positionId, slug],
  );
  return id;
}

/** Seed one row into choros.actor_event (T-0019). Needs a seeded employee (actor FK). */
async function seedActorEvent(
  c: pg.Client,
  tenantId: string,
  seq: number,
  actorId: string,
): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.actor_event
       (tenant_id, seq, id, object_kind, record_id, actor, role_at_event,
        event, approve_level, ts, vocab_version)
     VALUES ($1, $2, $3, 'record', $4, $5, $4, 'submit', NULL, 0, 1)
     ON CONFLICT DO NOTHING`,
    [tenantId, seq, id, uuid(), actorId],
  );
  return id;
}

/** Seed one row into choros.role. Returns the role id (T-0022). */
async function seedRoleRow(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const slug = `ct-role-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.role
       (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, slug],
  );
  return id;
}

/** Seed the per-tenant counter row choros.actor_event_seq (T-0019). */
async function seedActorEventSeq(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.actor_event_seq (tenant_id, next_seq)
     VALUES ($1, 1)
     ON CONFLICT DO NOTHING`,
    [tenantId],
  );
}

/**
 * Seed one row into choros.role_assignment, wiring the already-seeded employee
 * to the new role with a valid org-node org_scope (the existing grant-lattice
 * ScopeElement shape) and confirmed_by set (an effective assignment). (T-0022)
 */
async function seedRoleAssignmentRow(
  c: pg.Client,
  tenantId: string,
  employeeId: string,
  roleId: string,
  departmentId: string,
): Promise<string> {
  const id = uuid();
  const orgScope = JSON.stringify({
    kind: 'node',
    hierarchy: 'org',
    nodeId: departmentId,
    nodeLevel: 'department',
  });
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
        source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL,
             'ct-test', 'ct-tester', NULL, 'ct-tester', 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, employeeId, roleId, orgScope],
  );
  return id;
}

/** Seed one row into choros.job. Returns the job id. */
async function seedJobRow(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const now = Date.now();
  await c.query(
    `INSERT INTO choros.job
       (tenant_id, id, topic, variables, state, retries,
        lock_owner, lock_expiry, created_at, available_at)
     VALUES ($1, $2, 'ct-test', '{}'::jsonb, 'CREATED', 0,
             NULL, NULL, $3, $3)`,
    [tenantId, id, now],
  );
  return id;
}

/** Seed one row into choros.app_timer. Returns the timer id. */
async function seedAppTimer(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const now = Date.now();
  await c.query(
    `INSERT INTO choros.app_timer
       (tenant_id, id, due_at, state, kind, payload, created_at)
     VALUES ($1, $2, $3, 'pending', 'ct-test', '{}'::jsonb, $3)`,
    [tenantId, id, now + 60000],
  );
  return id;
}

/**
 * Seed one row into choros.outbox (T-0062). Minimal valid row: state defaults to
 * 'pending', idempotency_key is NOT NULL (unique per row to avoid any accidental
 * collision), created_at/available_at = 0. aggregate_id is opaque (no FK).
 */
async function seedOutboxRow(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.outbox
       (tenant_id, id, aggregate_kind, aggregate_id, event_type, payload,
        idempotency_key, created_at, available_at)
     VALUES ($1, $2, 'ct-test', $3, 'ct-event', '{}'::jsonb, $4, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, uuid(), `ct-outbox-${id.slice(0, 8)}`],
  );
  return id;
}

/**
 * Seed one row into choros.data_classification (T-0033). PK is
 * (tenant_id, resource_type, facet_field, facet_schema_version); a per-tenant
 * unique facet_field keeps both tenants' seeds independent under their own RLS.
 */
async function seedDataClassification(c: pg.Client, tenantId: string): Promise<void> {
  const field = `ct-field-${uuid().slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.data_classification
       (tenant_id, resource_type, facet_field, facet_schema_version, class, created_at, updated_at)
     VALUES ($1, 'record', $2, 0, 'confidential', 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, field],
  );
}

/**
 * Seed one row into choros.effect_resource (T-0034). PK is (tenant_id, id);
 * a fresh uuid id per call keeps both tenants' seeds independent under RLS.
 */
async function seedEffectResource(c: pg.Client, tenantId: string): Promise<void> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.effect_resource
       (tenant_id, id, kind, scope, metadata, created_at)
     VALUES ($1, $2, 'integration_endpoint', '{}'::jsonb, NULL, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id],
  );
}

/**
 * Seed one row into choros.egress_policy (T-0041). PK is (tenant_id, id); a fresh
 * uuid id per call plus a per-row unique allowed_endpoint keeps both tenants'
 * seeds independent under RLS and clear of the (tenant_id, class, allowed_endpoint)
 * UNIQUE constraint. A NAMED policy row (class 'confidential', a specific endpoint)
 * — never a catch-all (deny-by-default, AC-14).
 */
async function seedEgressPolicy(c: pg.Client, tenantId: string): Promise<void> {
  const id = uuid();
  const endpoint = `https://ct-llm-${id.slice(0, 8)}.example/v1`;
  await c.query(
    `INSERT INTO choros.egress_policy
       (tenant_id, id, class, allowed_endpoint, description, created_at, updated_at)
     VALUES ($1, $2, 'confidential', $3, NULL, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, endpoint],
  );
}

/**
 * Seed one row into choros.mcp_tool (T-0043). PK is (tenant_id, id);
 * a pure-compute tool (empty declares, pure_compute=true, empty resource_ops)
 * has no FKs — self-contained, keeps both tenants' seeds independent under RLS.
 */
async function seedMcpTool(c: pg.Client, tenantId: string): Promise<void> {
  const id = uuid();
  const name = `ct-mcp-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.mcp_tool
       (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
     VALUES ($1, $2, $3, NULL, '[]'::jsonb, true, '[]'::jsonb, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, name],
  );
}

/**
 * Seed one row into choros.sod_constraint (T-0032). PK is (tenant_id, id);
 * a fresh uuid id per call keeps both tenants' seeds independent under RLS. A
 * valid `dynamic` row (self_record separation) needs no role pair, so it is
 * self-contained — no FK to role (role_a/role_b carry no FK).
 */
async function seedSodConstraint(c: pg.Client, tenantId: string): Promise<void> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.sod_constraint
       (tenant_id, id, kind, role_a, role_b, self_record, scope, detail, created_at)
     VALUES ($1, $2, 'dynamic', NULL, NULL, true, '{}'::jsonb, NULL, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id],
  );
}

/** Seed one row into choros.instance_budget (T-0023). Returns the instance_budget id. */
async function seedInstanceBudget(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.instance_budget
       (tenant_id, id, process_instance_id, currency, ceiling, remaining_cache,
        created_at, updated_at)
     VALUES ($1, $2, NULL, 'USD', 100.000000, 100.000000, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id],
  );
  return id;
}

/** Seed one row into choros.agent_budget (T-0023). Requires a seeded employee id. */
async function seedAgentBudget(c: pg.Client, tenantId: string, employeeId: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.agent_budget
       (tenant_id, id, employee_id, window_kind, window_ref, currency,
        ceiling, remaining_cache, created_at, updated_at)
     VALUES ($1, $2, $3, 'total', NULL, 'USD', 50.000000, 50.000000, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, employeeId],
  );
  return id;
}

/** Seed one row into choros.reservation (T-0023). Requires a seeded instance_budget id. */
async function seedReservation(c: pg.Client, tenantId: string, instanceBudgetId: string): Promise<string> {
  const id = uuid();
  const toolCallId = `ct-tcid-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.reservation
       (tenant_id, id, tool_call_id, instance_budget_id, agent_budget_id,
        held, currency, status, expires_at, created_at, finalized_at)
     VALUES ($1, $2, $3, $4, NULL, 1.000000, 'USD', 'open', 9999999999999, 0, NULL)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, toolCallId, instanceBudgetId],
  );
  return id;
}

/** Seed one row into choros.spend_ledger (T-0023). Requires seeded reservation + employee ids. */
async function seedSpendLedger(
  c: pg.Client,
  tenantId: string,
  reservationId: string,
  employeeId: string,
  instanceBudgetId: string,
): Promise<void> {
  const id = uuid();
  const toolCallId = `ct-sl-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.spend_ledger
       (tenant_id, id, reservation_id, tool_call_id, employee_id,
        instance_budget_id, agent_budget_id, amount, currency,
        description, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, 0.500000, 'USD', NULL, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, reservationId, toolCallId, employeeId, instanceBudgetId],
  );
}

/** Seed one row into choros.invoke_proposal (T-0024 migration 043).
 * caller_id and target_id are logical employee references — no FK is declared.
 */
async function seedInvokeProposal(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.invoke_proposal
       (tenant_id, id, caller_id, target_id, goal, context, status, created_at)
     VALUES ($1, $2, $3, $4, 'ct-goal', NULL, 'proposed', 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, uuid(), uuid()],
  );
  return id;
}

/** Seed one row into choros.notification (T-0168 migration 046).
 * FK: (tenant_id, recipient_id) → employee(tenant_id, id).
 * Must be seeded after employee.
 */
async function seedNotification(
  c: pg.Client,
  tenantId: string,
  recipientId: string,
): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.notification
       (tenant_id, id, recipient_id, event_kind, title, body,
        object_ref, is_read, created_at, expires_at)
     VALUES ($1, $2, $3, 'ct-event', 'ct-title', 'ct-body',
             NULL, false, 0, NULL)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, recipientId],
  );
  return id;
}

/** Seed one row into choros.email_channel_config (T-0168 migration 047).
 * PK is (tenant_id) — single row per tenant; idempotent via ON CONFLICT DO NOTHING.
 * No FK deps beyond tenant_id.
 */
async function seedEmailChannelConfig(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.email_channel_config
       (tenant_id, smtp_host, smtp_port, smtp_tls, from_address, from_name,
        smtp_handle, is_enabled, updated_by, updated_at)
     VALUES ($1, 'ct-smtp.example', 587, false, 'ct@example.com', NULL,
             'ct-handle', false, 'ct-seed', 0)
     ON CONFLICT DO NOTHING`,
    [tenantId],
  );
}

/** Seed one row into choros.notification_preference (T-0168 migration 048).
 * PK is (tenant_id, event_kind, recipient_scope) — no cross-table FK (T-0017 discipline).
 */
async function seedNotificationPreference(c: pg.Client, tenantId: string): Promise<void> {
  const scope = `actor:${uuid()}`;
  await c.query(
    `INSERT INTO choros.notification_preference
       (tenant_id, event_kind, recipient_scope, channels, updated_by, updated_at)
     VALUES ($1, 'ct-event', $2, ARRAY['in_app'], 'ct-seed', 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, scope],
  );
}

/** Seed one row into choros.connector (T-0128 migration 054).
 * PK is (tenant_id, id); a fresh uuid id per call keeps both tenants' seeds independent
 * under RLS. No cross-table FK (backs_effect_resource_id is a logical link, not a FK).
 */
async function seedConnector(c: pg.Client, tenantId: string): Promise<void> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.connector
       (tenant_id, id, kind, display_name, config, secret_handle, status,
        backs_effect_resource_id, created_by, created_at, updated_by, updated_at)
     VALUES ($1, $2, 'http_generic', $3, '{}'::jsonb, NULL, 'disabled',
             NULL, 'ct-seed', 0, 'ct-seed', 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, `ct-conn-${id.slice(0, 8)}`],
  );
}

/** Seed one row into choros.file (T-0201 migration 058). Returns the file id.
 * Composite tenant-leading FK: (tenant_id, record_id) → record(tenant_id, id).
 * Must be seeded after a record exists for the tenant. current_version is left
 * NULL here (it's an intra-tenant pointer maintained by addVersion, not a DB FK).
 */
async function seedFile(
  c: pg.Client,
  tenantId: string,
  recordId: string,
): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.file
       (tenant_id, id, record_id, original_name, current_version,
        retention_state, retention_policy_ref, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, 'active', NULL, 'ct-seed', 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, recordId, `ct-file-${id.slice(0, 8)}.txt`],
  );
  return id;
}

/** Seed one row into choros.file_version (T-0201 migration 058).
 * Composite tenant-leading FK: (tenant_id, file_id) → file(tenant_id, id).
 * Must be seeded after a file exists for the tenant. object_key is unique per
 * tenant (UNIQUE (tenant_id, object_key)) — uuid-derived to keep both tenants'
 * seeds independent.
 */
async function seedFileVersion(
  c: pg.Client,
  tenantId: string,
  fileId: string,
): Promise<void> {
  const id = uuid();
  const objectKey = `${tenantId}/${fileId}/${id}`;
  await c.query(
    `INSERT INTO choros.file_version
       (tenant_id, id, file_id, version_no, object_key, mime_type, size_bytes,
        content_hash, data_class, is_snapshot, cycle_ref, content_erased_at,
        uploaded_by, uploaded_at)
     VALUES ($1, $2, $3, 1, $4, 'text/plain', 1,
             $5, 'internal', false, NULL, NULL,
             'ct-seed', 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, fileId, objectKey, `ct-hash-${id.slice(0, 8)}`],
  );
}

/** Seed one row into choros.report_page (T-0175 migration 051).
 * FK: (tenant_id, app_id) → application(tenant_id, id).
 * Must be seeded after application. Returns the report_page id.
 */
async function seedReportPage(
  c: pg.Client,
  tenantId: string,
  appId: string,
): Promise<string> {
  const id = uuid();
  const slug = `ct-rp-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.report_page
       (tenant_id, id, app_id, slug, title, floor, tier,
        page_def, page_code, bundle_ref, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'ct-title', '1', 'draft',
             '{}'::jsonb, NULL, NULL, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, appId, slug],
  );
  return id;
}

/** Seed one row into choros.report_page_dep (T-0175 migration 052).
 * FK: (tenant_id, page_id) → report_page(tenant_id, id)
 * FK: (tenant_id, registry_def_id) → registry_def(tenant_id, id)
 * Must be seeded after both report_page and registry_def.
 */
async function seedReportPageDep(
  c: pg.Client,
  tenantId: string,
  pageId: string,
  registryDefId: string,
): Promise<void> {
  const id = uuid();
  const fieldKey = `ct-field-${id.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.report_page_dep
       (tenant_id, id, page_id, registry_def_id, field_key, dep_kind, stale, created_at)
     VALUES ($1, $2, $3, $4, $5, 'read', false, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, pageId, registryDefId, fieldKey],
  );
}

async function seedSubstitutionRule(
  c: pg.Client,
  tenantId: string,
  absentEmployeeId: string,
  roleId: string,
): Promise<void> {
  // Substitute must differ from absent (CHECK constraint). Create a dedicated
  // substitute employee inline (no position FK needed for kind='agent').
  const subId = uuid();
  const slug = `ct-sub-${subId.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.employee (tenant_id,id,position_id,kind,slug,display_name,created_at,updated_at)
     VALUES ($1,$2,NULL,'agent',$3,$3,0,0) ON CONFLICT DO NOTHING`,
    [tenantId, subId, slug],
  );
  const id = uuid();
  await c.query(
    `INSERT INTO choros.substitution_rule
       (tenant_id, id, absent_employee_id, substitute_employee_id, role_id,
        org_scope, ttl_grant_id, non_inheritable_excluded, proposed_by, confirmed_by,
        valid_from, valid_until, source, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5,
             '{"kind":"global"}'::jsonb, NULL, TRUE, NULL, 'ct-seed',
             NULL, NULL, 'ct-test', 'ct-seed', 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, id, absentEmployeeId, subId, roleId],
  );
}

// ---------------------------------------------------------------------------
// Seed dispatcher: routes to the correct seed function per table name.
// Returns the seeded row id.
// ---------------------------------------------------------------------------

// Per-tenant seed state (populated in beforeAll).
const seedState = {
  appIdA: '',
  appIdB: '',
  regIdA: '',
  regIdB: '',
  // track audit_event seq per tenant to avoid PK collision
  auditSeqA: 1,
  auditSeqB: 1,
  // org-structure FK chain: dept → position (needed for employee seed)
  deptIdA: '',
  deptIdB: '',
  posIdA: '',
  posIdB: '',
  // employee id per tenant (the actor FK target for actor_event)
  empIdA: '',
  empIdB: '',
  // track actor_event seq per tenant to avoid PK collision
  actorSeqA: 1,
  actorSeqB: 1,
  // T-0022 chain: employee + role (needed for role_assignment seed)
  roleIdA: '',
  roleIdB: '',
  // T-0023 chain: instance_budget → reservation → spend_ledger
  instanceBudgetIdA: '',
  instanceBudgetIdB: '',
  reservationIdA: '',
  reservationIdB: '',
  // T-0175 chain: report_page → report_page_dep (page_id FK)
  reportPageIdA: '',
  reportPageIdB: '',
  // T-0201 chain: record → file → file_version (file FKs record; file_version FKs file)
  recordIdA: '',
  recordIdB: '',
  fileIdA: '',
  fileIdB: '',
  // T-0235 chain: template_def → template_dep (template_dep FKs template_def)
  templateDefIdA: '',
  templateDefIdB: '',
  // T-0238 chain: doc_page → doc_ref / doc_log (both FK doc_page)
  docPageIdA: '',
  docPageIdB: '',
};

/**
 * Seed ≥1 row under both tenants for the given table.
 * Must be called inside a BEGIN/COMMIT block by the caller.
 */
async function seedRowForTable(c: pg.Client, tableName: string, tenantId: string): Promise<void> {
  switch (tableName) {
    case 'application':
      await seedApplication(c, tenantId);
      break;
    case 'registry_def':
      // Needs an application to exist; use pre-seeded app ids.
      await seedRegistryDef(
        c,
        tenantId,
        tenantId === TENANT_A ? seedState.appIdA : seedState.appIdB,
      );
      break;
    case 'record': {
      // Store the record id for the downstream file seed (T-0201 FK target).
      const recId = await seedRecord(
        c,
        tenantId,
        tenantId === TENANT_A ? seedState.regIdA : seedState.regIdB,
      );
      if (tenantId === TENANT_A) seedState.recordIdA = recId;
      else seedState.recordIdB = recId;
      break;
    }
    case 'audit_event': {
      const seq = tenantId === TENANT_A ? seedState.auditSeqA++ : seedState.auditSeqB++;
      await seedAuditEvent(c, tenantId, seq);
      break;
    }
    case 'audit_head':
      await seedAuditHead(c, tenantId);
      break;
    case 'grant':
      await seedGrant(c, tenantId);
      break;
    case 'object_handle':
      await seedObjectHandle(c, tenantId);
      break;
    case 'job':
      await seedJobRow(c, tenantId);
      break;
    case 'app_timer':
      await seedAppTimer(c, tenantId);
      break;
    case 'tenant':
      // tenant_id = id for the tenant row (self-anchoring per T-0017 ADR §3.1)
      await seedTenantRow(c, tenantId);
      break;
    case 'department': {
      // Must seed after tenant. Store dept id for downstream position seed.
      const deptId = await seedDepartmentRow(c, tenantId);
      if (tenantId === TENANT_A) seedState.deptIdA = deptId;
      else seedState.deptIdB = deptId;
      break;
    }
    case 'position': {
      // Must seed after department. Store position id for downstream employee seed.
      const deptId = tenantId === TENANT_A ? seedState.deptIdA : seedState.deptIdB;
      const posId = await seedPositionRow(c, tenantId, deptId);
      if (tenantId === TENANT_A) seedState.posIdA = posId;
      else seedState.posIdB = posId;
      break;
    }
    case 'employee': {
      // Must seed after position. Store emp id for downstream actor_event seed.
      // Must seed after position. Store employee id for downstream role_assignment seed.
      const posId = tenantId === TENANT_A ? seedState.posIdA : seedState.posIdB;
      const empId = await seedEmployeeRow(c, tenantId, posId);
      if (tenantId === TENANT_A) seedState.empIdA = empId;
      else seedState.empIdB = empId;
      break;
    }
    case 'role': {
      // T-0022 — seed after tenant (no other dep). Store role id for role_assignment.
      const roleId = await seedRoleRow(c, tenantId);
      if (tenantId === TENANT_A) seedState.roleIdA = roleId;
      else seedState.roleIdB = roleId;
      break;
    }
    case 'role_assignment': {
      // T-0022 — must seed after employee + role (FK targets) and department
      // (org_scope references a real department node). KNOWN_TENANT_TABLES order
      // (…, department, …, employee, role, role_assignment) guarantees all are
      // already seeded by the time this case runs.
      const empId = tenantId === TENANT_A ? seedState.empIdA : seedState.empIdB;
      const roleId = tenantId === TENANT_A ? seedState.roleIdA : seedState.roleIdB;
      const deptId = tenantId === TENANT_A ? seedState.deptIdA : seedState.deptIdB;
      await seedRoleAssignmentRow(c, tenantId, empId, roleId, deptId);
      break;
    }
    case 'actor_event': {
      // Must seed after employee (actor FK). Per-tenant seq avoids PK collision.
      const empId = tenantId === TENANT_A ? seedState.empIdA : seedState.empIdB;
      const seq = tenantId === TENANT_A ? seedState.actorSeqA++ : seedState.actorSeqB++;
      await seedActorEvent(c, tenantId, seq, empId);
      break;
    }
    case 'actor_event_seq':
      await seedActorEventSeq(c, tenantId);
      break;
    case 'data_classification':
      await seedDataClassification(c, tenantId);
      break;
    case 'effect_resource':
      await seedEffectResource(c, tenantId);
      break;
    case 'outbox':
      await seedOutboxRow(c, tenantId);
      break;
    case 'egress_policy':
      await seedEgressPolicy(c, tenantId);
      break;
    case 'sod_constraint':
      await seedSodConstraint(c, tenantId);
      break;
    case 'mcp_tool':
      await seedMcpTool(c, tenantId);
      break;
    case 'agent_card': {
      // self-sufficient: seed a dedicated kind='agent' employee + its card.
      // Does NOT depend on KNOWN_TENANT_TABLES order or on the shared human empId.
      const id = uuid();
      const slug = `ct-agent-${id.slice(0,8)}`;
      await c.query(
        `INSERT INTO choros.employee (tenant_id,id,position_id,kind,slug,display_name,created_at,updated_at)
         VALUES ($1,$2,NULL,'agent',$3,$3,0,0) ON CONFLICT DO NOTHING`, [tenantId, id, slug]);
      await c.query(
        `INSERT INTO choros.agent_card (tenant_id,employee_id,kc_client_id,created_at,updated_at)
         VALUES ($1,$2,$3,0,0) ON CONFLICT DO NOTHING`, [tenantId, id, `ct-kc-${id.slice(0,8)}`]);
      break;
    }
    case 'agent_instruction': {
      // T-0123 (migration 057) — FK (tenant_id, employee_id, employee_kind)
      // → employee(tenant_id, id, kind), kind='agent' only. Self-sufficient: seed a
      // dedicated kind='agent' employee + its instruction. Does NOT depend on
      // KNOWN_TENANT_TABLES order or on the shared human empId (mirrors agent_card).
      const id = uuid();
      const slug = `ct-aiagent-${id.slice(0, 8)}`;
      await c.query(
        `INSERT INTO choros.employee (tenant_id,id,position_id,kind,slug,display_name,created_at,updated_at)
         VALUES ($1,$2,NULL,'agent',$3,$3,0,0) ON CONFLICT DO NOTHING`,
        [tenantId, id, slug],
      );
      await c.query(
        `INSERT INTO choros.agent_instruction
           (tenant_id, id, employee_id, employee_kind, tier, instruction_text,
            answer_form, instruction_meta, bundle_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'agent', 'draft', 'ct-instruction',
                 NULL, '{}'::jsonb, NULL, 0, 0)
         ON CONFLICT DO NOTHING`,
        [tenantId, uuid(), id],
      );
      break;
    }
    case 'instance_budget': {
      // T-0023 — no deps beyond tenant. Store id for downstream reservation seed.
      const ibId = await seedInstanceBudget(c, tenantId);
      if (tenantId === TENANT_A) seedState.instanceBudgetIdA = ibId;
      else seedState.instanceBudgetIdB = ibId;
      break;
    }
    case 'agent_budget': {
      // T-0023 — requires seeded employee (FK). KNOWN_TENANT_TABLES order
      // (…, employee, …, instance_budget, agent_budget) guarantees employee is seeded.
      const empId = tenantId === TENANT_A ? seedState.empIdA : seedState.empIdB;
      await seedAgentBudget(c, tenantId, empId);
      break;
    }
    case 'reservation': {
      // T-0023 — requires seeded instance_budget (FK).
      const ibId = tenantId === TENANT_A ? seedState.instanceBudgetIdA : seedState.instanceBudgetIdB;
      const resId = await seedReservation(c, tenantId, ibId);
      if (tenantId === TENANT_A) seedState.reservationIdA = resId;
      else seedState.reservationIdB = resId;
      break;
    }
    case 'spend_ledger': {
      // T-0023 — requires seeded reservation + employee + instance_budget (FKs).
      // KNOWN_TENANT_TABLES order guarantees all are seeded before this case runs.
      const resId = tenantId === TENANT_A ? seedState.reservationIdA : seedState.reservationIdB;
      const empId = tenantId === TENANT_A ? seedState.empIdA : seedState.empIdB;
      const ibId  = tenantId === TENANT_A ? seedState.instanceBudgetIdA : seedState.instanceBudgetIdB;
      await seedSpendLedger(c, tenantId, resId, empId, ibId);
      break;
    }
    case 'substitution_rule': {
      // T-0035 — requires seeded employee (absent_employee_id FK) + role (role_id FK).
      // KNOWN_TENANT_TABLES order (…, employee, role, …, substitution_rule) guarantees
      // both are seeded before this case runs.
      const empId = tenantId === TENANT_A ? seedState.empIdA : seedState.empIdB;
      const roleId = tenantId === TENANT_A ? seedState.roleIdA : seedState.roleIdB;
      await seedSubstitutionRule(c, tenantId, empId, roleId);
      break;
    }
    case 'form_binding': {
      // T-0072 — self-contained (no FK deps beyond tenant_id).
      // process_key + form_key uniqueness per tenant: use uuid slices to avoid
      // collision between TENANT_A / TENANT_B seeds.
      const id = uuid();
      const procKey = `ct-proc-${id.slice(0, 8)}`;
      const formKey = `ct-form-${id.slice(0, 8)}`;
      await c.query(
        `INSERT INTO choros.form_binding
           (tenant_id, id, process_key, form_key, fields, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, '[{"key":"ctField","type":"string","required":false}]'::jsonb, 1, 0, 0)
         ON CONFLICT DO NOTHING`,
        [tenantId, id, procKey, formKey],
      );
      break;
    }
    case 'invoke_proposal':
      // T-0024 (migration 043) — no FK deps; caller_id/target_id are logical.
      await seedInvokeProposal(c, tenantId);
      break;
    case 'notification': {
      // T-0168 (migration 046) — FK to employee via recipient_id.
      // KNOWN_TENANT_TABLES order (…, employee, …, notification) guarantees employee is seeded.
      const empId = tenantId === TENANT_A ? seedState.empIdA : seedState.empIdB;
      await seedNotification(c, tenantId, empId);
      break;
    }
    case 'email_channel_config':
      // T-0168 (migration 047) — PK=(tenant_id), single row per tenant, no FK deps.
      await seedEmailChannelConfig(c, tenantId);
      break;
    case 'notification_preference':
      // T-0168 (migration 048) — PK=(tenant_id, event_kind, recipient_scope), no FK deps.
      await seedNotificationPreference(c, tenantId);
      break;
    case 'report_page': {
      // T-0175 (migration 051) — FK to application via app_id.
      // Store page id for downstream report_page_dep seed.
      const appId = tenantId === TENANT_A ? seedState.appIdA : seedState.appIdB;
      const pageId = await seedReportPage(c, tenantId, appId);
      if (tenantId === TENANT_A) seedState.reportPageIdA = pageId;
      else seedState.reportPageIdB = pageId;
      break;
    }
    case 'report_page_dep': {
      // T-0175 (migration 052) — FK to report_page (page_id) + registry_def (registry_def_id).
      // KNOWN_TENANT_TABLES order (…, registry_def, …, report_page, report_page_dep)
      // guarantees both FK targets are already seeded.
      const pageId = tenantId === TENANT_A ? seedState.reportPageIdA : seedState.reportPageIdB;
      const regId  = tenantId === TENANT_A ? seedState.regIdA : seedState.regIdB;
      await seedReportPageDep(c, tenantId, pageId, regId);
      break;
    }
    case 'connector':
      // T-0128 (migration 054) — PK=(tenant_id, id), no cross-table FK
      // (backs_effect_resource_id is a logical link, not a FK).
      await seedConnector(c, tenantId);
      break;
    case 'file': {
      // T-0201 (migration 058) — FK (tenant_id, record_id) → record.
      // KNOWN_TENANT_TABLES order (…, record, …, file, file_version) guarantees
      // a record is already seeded. Store file id for downstream file_version seed.
      const recId = tenantId === TENANT_A ? seedState.recordIdA : seedState.recordIdB;
      const fileId = await seedFile(c, tenantId, recId);
      if (tenantId === TENANT_A) seedState.fileIdA = fileId;
      else seedState.fileIdB = fileId;
      break;
    }
    case 'file_version': {
      // T-0201 (migration 058) — FK (tenant_id, file_id) → file.
      // KNOWN_TENANT_TABLES order guarantees the file is seeded before this case.
      const fileId = tenantId === TENANT_A ? seedState.fileIdA : seedState.fileIdB;
      await seedFileVersion(c, tenantId, fileId);
      break;
    }
    case 'template_def': {
      // T-0235 (migration 060) — FK (tenant_id, registry_id) → registry_def(tenant_id, id).
      // KNOWN_TENANT_TABLES order (…, registry_def, …, template_def) guarantees
      // registry_def is already seeded. Store id for downstream template_dep seed.
      const regId = tenantId === TENANT_A ? seedState.regIdA : seedState.regIdB;
      const id = uuid();
      await c.query(
        `INSERT INTO choros.template_def
           (tenant_id, id, registry_id, format, body, version, tier, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'html', '<p>ct-template</p>', 1, 'draft', 'ct-tester', 0, 0)
         ON CONFLICT DO NOTHING`,
        [tenantId, id, regId],
      );
      if (tenantId === TENANT_A) seedState.templateDefIdA = id;
      else seedState.templateDefIdB = id;
      break;
    }
    case 'template_dep': {
      // T-0235 (migration 060) — FK (tenant_id, template_id) → template_def(tenant_id, id);
      // FK (tenant_id, registry_def_id) → registry_def(tenant_id, id).
      // KNOWN_TENANT_TABLES order (…, template_def, template_dep) guarantees both are seeded.
      const templateId = tenantId === TENANT_A ? seedState.templateDefIdA : seedState.templateDefIdB;
      const regId = tenantId === TENANT_A ? seedState.regIdA : seedState.regIdB;
      const id = uuid();
      const fieldKey = `ct-field-${id.slice(0, 8)}`;
      await c.query(
        `INSERT INTO choros.template_dep
           (tenant_id, id, template_id, registry_def_id, field_key, dep_kind, stale, created_at)
         VALUES ($1, $2, $3, $4, $5, 'read', false, 0)
         ON CONFLICT DO NOTHING`,
        [tenantId, id, templateId, regId, fieldKey],
      );
      break;
    }
    case 'doc_page': {
      // T-0238 (migration 061) — app_id nullable; no required FK deps beyond tenant.
      // Store id for downstream doc_ref / doc_log seeds.
      const id = uuid();
      const slug = `ct-doc-${id.slice(0, 8)}`;
      await c.query(
        `INSERT INTO choros.doc_page
           (tenant_id, id, slug, title, body, scope, catalog_version, app_id,
            stale, authored_by, authored_at, updated_at)
         VALUES ($1, $2, $3, 'ct-doc-title', 'ct-body', 'tenant', NULL, NULL,
                 false, 'ct-tester', 0, 0)
         ON CONFLICT DO NOTHING`,
        [tenantId, id, slug],
      );
      if (tenantId === TENANT_A) seedState.docPageIdA = id;
      else seedState.docPageIdB = id;
      break;
    }
    case 'doc_ref': {
      // T-0238 (migration 061) — FK (tenant_id, page_id) → doc_page(tenant_id, id) CASCADE.
      // KNOWN_TENANT_TABLES order (…, doc_page, doc_ref) guarantees doc_page is seeded.
      const pageId = tenantId === TENANT_A ? seedState.docPageIdA : seedState.docPageIdB;
      const id = uuid();
      const refTarget = JSON.stringify({ symbol: `ct-sym-${id.slice(0, 8)}` });
      await c.query(
        `INSERT INTO choros.doc_ref
           (tenant_id, id, page_id, ref_kind, ref_target, broken, created_at)
         VALUES ($1, $2, $3, 'code_symbol', $4::jsonb, false, 0)
         ON CONFLICT DO NOTHING`,
        [tenantId, id, pageId, refTarget],
      );
      break;
    }
    case 'doc_log': {
      // T-0238 (migration 061) — FK (tenant_id, page_id) → doc_page(tenant_id, id) CASCADE.
      // KNOWN_TENANT_TABLES order (…, doc_page, doc_ref, doc_log) guarantees doc_page is seeded.
      const pageId = tenantId === TENANT_A ? seedState.docPageIdA : seedState.docPageIdB;
      const id = uuid();
      await c.query(
        `INSERT INTO choros.doc_log
           (tenant_id, id, page_id, op, agent_actor, diff_summary, at)
         VALUES ($1, $2, $3, 'create', 'ct-tester', NULL, 0)
         ON CONFLICT DO NOTHING`,
        [tenantId, id, pageId],
      );
      break;
    }
    case 'dmn_rule_table': {
      // T-0075 (migration 066) — no FK deps beyond tenant_id; self-contained.
      // definition holds a minimal valid DmnRuleTable JSON; process_def_id is nullable.
      const id = uuid();
      const name = `ct-dmn-${id.slice(0, 8)}`;
      const definition = JSON.stringify({ id, name, hitPolicy: 'FIRST', rules: [] });
      await c.query(
        `INSERT INTO choros.dmn_rule_table
           (tenant_id, id, name, definition, process_def_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, NULL, 'draft', now(), now())
         ON CONFLICT DO NOTHING`,
        [tenantId, id, name, definition],
      );
      break;
    }
    case 'nav_version': {
      // T-0079 (migration 067) — no FK deps beyond tenant; version >= 0.
      const version = 0;
      const config = JSON.stringify({ sections: [] });
      await c.query(
        `INSERT INTO choros.nav_version
           (tenant_id, version, config, created_at)
         VALUES ($1, $2, $3::jsonb, 0)
         ON CONFLICT DO NOTHING`,
        [tenantId, version, config],
      );
      break;
    }
    case 'catalog_field_spec': {
      // T-0079 (migration 067) — no FK deps beyond tenant; kind='custom' to avoid
      // colliding with the 14 seeded standard rows (unique on tenant_id, catalog_name, field_key).
      const fieldKey = `ct-custom-${tenantId.slice(0, 8)}`;
      await c.query(
        `INSERT INTO choros.catalog_field_spec
           (tenant_id, catalog_name, field_key, label, kind, created_at)
         VALUES ($1, 'counterparty', $2, 'CT Custom Field', 'custom', 0)
         ON CONFLICT DO NOTHING`,
        [tenantId, fieldKey],
      );
      break;
    }
    case 'cross_app_ref': {
      // T-0080 (migration 068) — FK deps: source_registry_id and target_registry_id → registry_def.
      // KNOWN_TENANT_TABLES order (…, registry_def, …, cross_app_ref) guarantees registry_def is seeded.
      // Uses the same regId that was seeded for registry_def (stored in seedState).
      const regId = tenantId === TENANT_A ? seedState.regIdA : seedState.regIdB;
      const id = uuid();
      await c.query(
        `INSERT INTO choros.cross_app_ref
           (tenant_id, id, source_registry_id, target_registry_id, ref_field, label, ref_strength, created_at, updated_at)
         VALUES ($1, $2, $3, $3, 'counterparty_id', 'Counterparty', 'weak', 0, 0)
         ON CONFLICT DO NOTHING`,
        [tenantId, id, regId],
      );
      break;
    }
    case 'bundle_commit': {
      // T-0083 (migration 069) — content-addressed bundle commit; no FK deps beyond tenant_id.
      // content_hash must be exactly 64 hex chars (SHA-256); use fresh random UUID-derived value.
      const contentHash = uuid().replace(/-/g, '').padEnd(64, '0').slice(0, 64);
      const parentHash = '0'.repeat(64);
      await c.query(
        `INSERT INTO choros.bundle_commit
           (tenant_id, bundle_id, content_hash, parent_hash, author, message,
            committed_at,
            snapshot_object_schema, snapshot_grants, snapshot_bpmn_process,
            snapshot_form_code, snapshot_form_json_schema)
         VALUES ($1, 'ct-bundle', $2, $3, 'ct-tester', '', 0, '', '', '', '', '')
         ON CONFLICT DO NOTHING`,
        [tenantId, contentHash, parentHash],
      );
      break;
    }
    case 'bundle_ref': {
      // T-0083 (migration 069) — named bundle ref; no FK deps (content_hash not FK-constrained).
      const contentHash = '0'.repeat(64);
      await c.query(
        `INSERT INTO choros.bundle_ref
           (tenant_id, bundle_id, ref_name, content_hash, updated_at)
         VALUES ($1, 'ct-bundle', 'HEAD', $2, 0)
         ON CONFLICT DO NOTHING`,
        [tenantId, contentHash],
      );
      break;
    }
    default:
      throw new Error(`seedRowForTable: unknown table ${tableName}`);
  }
}

// ---------------------------------------------------------------------------
// Global beforeAll: seed rows under both tenants for every table.
// Uses migrator (bypasses RLS). FK ordering: application → registry_def → record.
// ---------------------------------------------------------------------------
beforeAll(async () => {
  await withClient(migratorUrl(), async (c) => {
    // 1. Seed application for both tenants (other tables may FK-depend on it).
    await c.query('BEGIN');
    seedState.appIdA = await seedApplication(c, TENANT_A);
    await c.query('COMMIT');

    await c.query('BEGIN');
    seedState.appIdB = await seedApplication(c, TENANT_B);
    await c.query('COMMIT');

    // 2. Seed registry_def for both tenants.
    await c.query('BEGIN');
    seedState.regIdA = await seedRegistryDef(c, TENANT_A, seedState.appIdA);
    await c.query('COMMIT');

    await c.query('BEGIN');
    seedState.regIdB = await seedRegistryDef(c, TENANT_B, seedState.appIdB);
    await c.query('COMMIT');

    // 3. Seed remaining tables for both tenants.
    const remainingTables = KNOWN_TENANT_TABLES.filter(
      (t) => t !== 'application' && t !== 'registry_def',
    );
    for (const tableName of remainingTables) {
      for (const tenantId of [TENANT_A, TENANT_B]) {
        await c.query('BEGIN');
        await seedRowForTable(c, tableName, tenantId);
        await c.query('COMMIT');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC-1: cross-tenant SELECT with explicit WHERE tenant_id = TENANT_B → 0 rows
// (choros_app, context = TENANT_A)
// ---------------------------------------------------------------------------
describe('AC-1 · FF-CT1: cross-tenant SELECT (explicit WHERE tenant_id=B) → 0 rows from app role', () => {
  for (const tableName of KNOWN_TENANT_TABLES) {
    it(`table: ${tableName}`, async () => {
      await withClient(appUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
        // audit_head uses quoted identifier to avoid PK collision issues
        const quotedTable = tableName === 'grant' ? '"grant"' : tableName;
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM choros.${quotedTable} WHERE tenant_id = $1`,
          [TENANT_B],
        );
        await c.query('COMMIT');
        expect(rows[0].n, `${tableName}: expected 0 rows with tenant_id=TENANT_B`).toBe(0);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-2: cross-tenant SELECT without WHERE → all returned rows have tenant_id=A
// (no TENANT_B rows leak)
// ---------------------------------------------------------------------------
describe('AC-2 · FF-CT2: cross-tenant SELECT (no WHERE) → only TENANT_A rows visible', () => {
  for (const tableName of KNOWN_TENANT_TABLES) {
    it(`table: ${tableName}`, async () => {
      await withClient(appUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
        const quotedTable = tableName === 'grant' ? '"grant"' : tableName;
        const { rows } = await c.query(
          `SELECT tenant_id FROM choros.${quotedTable}`,
        );
        await c.query('COMMIT');
        // Every returned row must belong to TENANT_A.
        for (const row of rows) {
          expect(row.tenant_id, `${tableName}: leaked TENANT_B row`).toBe(TENANT_A);
        }
        // Additionally, no TENANT_B rows should be present.
        const tenantBCount = rows.filter((r) => r.tenant_id === TENANT_B).length;
        expect(tenantBCount, `${tableName}: TENANT_B rows leaked`).toBe(0);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-3: cross-tenant UPDATE on choros.application → 0 rows affected
// Verification via migrator confirms the value was NOT changed.
// ---------------------------------------------------------------------------
describe('AC-3 · FF-CT3: cross-tenant UPDATE → 0 rows affected, TENANT_B data intact', () => {
  it('UPDATE choros.application WHERE tenant_id=TENANT_B from TENANT_A context', async () => {
    // Capture original display_name of TENANT_B application via migrator.
    const originalName = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT display_name FROM choros.application WHERE tenant_id = $1 LIMIT 1`,
        [TENANT_B],
      );
      return rows[0]?.display_name as string | undefined;
    });
    expect(originalName, 'TENANT_B app row must exist before UPDATE test').toBeDefined();

    // Attempt UPDATE from app role in TENANT_A context.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const result = await c.query(
        `UPDATE choros.application SET display_name = 'HACKED' WHERE tenant_id = $1`,
        [TENANT_B],
      );
      await c.query('COMMIT');
      expect(result.rowCount, 'UPDATE rows affected must be 0').toBe(0);
    });

    // Verify value unchanged via migrator.
    const afterName = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT display_name FROM choros.application WHERE tenant_id = $1 LIMIT 1`,
        [TENANT_B],
      );
      return rows[0]?.display_name as string | undefined;
    });
    expect(afterName, 'TENANT_B display_name must be unchanged after cross-tenant UPDATE').toBe(originalName);
  });
});

// ---------------------------------------------------------------------------
// AC-4: cross-tenant DELETE on choros.application → 0 rows affected
// Verification via migrator confirms the row still exists.
// ---------------------------------------------------------------------------
describe('AC-4 · FF-CT4: cross-tenant DELETE → 0 rows affected, TENANT_B row survives', () => {
  it('DELETE choros.application WHERE tenant_id=TENANT_B from TENANT_A context', async () => {
    // Count TENANT_B rows before DELETE.
    const countBefore = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.application WHERE tenant_id = $1`,
        [TENANT_B],
      );
      return rows[0].n as number;
    });
    expect(countBefore, 'TENANT_B application rows must exist').toBeGreaterThan(0);

    // Attempt DELETE from app role in TENANT_A context.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const result = await c.query(
        `DELETE FROM choros.application WHERE tenant_id = $1`,
        [TENANT_B],
      );
      await c.query('COMMIT');
      expect(result.rowCount, 'DELETE rows affected must be 0').toBe(0);
    });

    // Verify row count unchanged via migrator.
    const countAfter = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.application WHERE tenant_id = $1`,
        [TENANT_B],
      );
      return rows[0].n as number;
    });
    expect(countAfter, 'TENANT_B row count must be unchanged after cross-tenant DELETE').toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// AC-5: post-condition integrity — TENANT_B rows physically intact after
// cross-tenant UPDATE/DELETE attempts on choros.application (AC-3/AC-4).
//
// Scope: only the tables touched by AC-3/AC-4 (choros.application).
// The job table is intentionally excluded: pgJobStore.integration.test.ts uses
// TRUNCATE choros.job in beforeEach and may run concurrently in a separate
// vitest fork against the same shared Postgres, creating a race condition.
// AC-5's spec says "затронутые таблицы" (affected tables) — application is the
// table mutated by the cross-tenant DML attempts in AC-3 and AC-4.
// ---------------------------------------------------------------------------
describe('AC-5 · FF-CT5: post-condition integrity — TENANT_B rows unchanged after AC-3/AC-4', () => {
  it('choros.application TENANT_B rows still present after cross-tenant UPDATE attempt (AC-3)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.application WHERE tenant_id = $1`,
        [TENANT_B],
      );
      expect(rows[0].n, 'application: TENANT_B rows must still exist after cross-tenant UPDATE attempt').toBeGreaterThanOrEqual(1);
    });
  });

  it('choros.application TENANT_B rows still present after cross-tenant DELETE attempt (AC-4)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.application WHERE tenant_id = $1`,
        [TENANT_B],
      );
      expect(rows[0].n, 'application: TENANT_B rows must still exist after cross-tenant DELETE attempt').toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-6: fail-closed DML without tenant context → Postgres error (GUC undefined)
// INSERT using current_setting('choros.tenant_id', false)::uuid without SET LOCAL.
// ---------------------------------------------------------------------------
describe('AC-6 · FF-CT6: fail-closed DML without tenant context → Postgres error', () => {
  it('INSERT INTO choros.job without SET LOCAL throws Postgres error (GUC undefined)', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      // Deliberately do NOT set choros.tenant_id.
      const now = Date.now();
      await expect(
        c.query(
          `INSERT INTO choros.job
             (tenant_id, id, topic, variables, state, retries,
              lock_owner, lock_expiry, created_at, available_at)
           VALUES
             (current_setting('choros.tenant_id', false)::uuid,
              $1, 'ct-fail-closed', '{}', 'CREATED', 0,
              NULL, NULL, $2, $2)`,
          [uuid(), now],
        ),
      ).rejects.toBeDefined();
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-9: SET LOCAL scope isolation — GUC is transaction-scoped, not session-scoped.
// After COMMIT, the GUC is cleared. On a fresh connection (no prior SET),
// count(*) returns 0 — confirming no cross-transaction data leak.
// ---------------------------------------------------------------------------
describe('AC-9 · FF-CT9: SET LOCAL scope isolation — GUC cleared after COMMIT', () => {
  it('choros_app: rows visible inside BEGIN/SET LOCAL; 0 rows on fresh connection without GUC', async () => {
    // Step 1: Verify rows are visible inside BEGIN + SET LOCAL.
    let insideCount = 0;
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.application`,
      );
      await c.query('COMMIT');
      insideCount = rows[0].n as number;
    });
    expect(insideCount, 'rows must be visible inside transaction with SET LOCAL').toBeGreaterThanOrEqual(1);

    // Step 2: On a NEW connection (no GUC set), rows must be 0.
    // This verifies GUC scope: once the connection that had SET LOCAL is closed,
    // a fresh connection has no GUC → RLS default-DENY → 0 rows.
    // (Using a fresh connection avoids the Postgres quirk where after SET LOCAL +
    // COMMIT the session-level GUC value becomes '' which causes ''::uuid error.)
    await withClient(appUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.application`,
      );
      expect(rows[0].n, 'fresh connection without GUC must see 0 rows (RLS default-DENY)').toBe(0);
    });
  });

  it('choros_app: cross-tenant isolation holds even with session-level SET (TENANT_B rows not exposed)', async () => {
    // Session-level SET (not SET LOCAL). Even if session-level GUC makes TENANT_A
    // rows visible, TENANT_B rows must never appear when context = TENANT_A.
    await withClient(appUrl(), async (c) => {
      await c.query(`SET choros.tenant_id = '${TENANT_A}'`);
      await c.query('BEGIN');
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.application WHERE tenant_id = $1`,
        [TENANT_B],
      );
      await c.query('COMMIT');
      // With session-level GUC = TENANT_A, TENANT_B rows must NOT be visible.
      expect(rows[0].n, 'session-level SET for TENANT_A must not expose TENANT_B rows').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-CT-4 · Seeder completeness guard (T-0188)
//
// Every table listed in known_tenant_tables.txt MUST have an explicit case in
// seedRowForTable. This describe block encodes that invariant statically: any
// future table added to known_tenant_tables.txt without a matching seeder will
// immediately produce a failing (not skipped) test, catching the gap before
// CI runs live DB probes.
//
// SEEDED_TABLES must be kept in sync with the switch cases above.
// ---------------------------------------------------------------------------

/**
 * The exhaustive list of tables with seeder cases in seedRowForTable above.
 * If a table appears in KNOWN_TENANT_TABLES but NOT here, the guard test below
 * will fail (red), preventing silent skip masking.
 */
const SEEDED_TABLES = new Set<string>([
  'agent_card',
  'job',
  'application',
  'registry_def',
  'record',
  'audit_event',
  'audit_head',
  'grant',
  'mcp_tool',
  'object_handle',
  'app_timer',
  'tenant',
  'department',
  'position',
  'employee',
  'actor_event',
  'actor_event_seq',
  'data_classification',
  'role',
  'role_assignment',
  'effect_resource',
  'egress_policy',
  'outbox',
  'sod_constraint',
  'instance_budget',
  'agent_budget',
  'reservation',
  'spend_ledger',
  'substitution_rule',
  'invoke_proposal',
  'form_binding',
  'notification',
  'email_channel_config',
  'notification_preference',
  'report_page',
  'report_page_dep',
  'connector',
  'file',
  'file_version',
  'agent_instruction',
  'template_def',
  'template_dep',
  'doc_page',
  'doc_ref',
  'doc_log',
  'dmn_rule_table',
  'nav_version',
  'catalog_field_spec',
  'cross_app_ref',
  'bundle_commit',
  'bundle_ref',
]);

describe('AC-CT-4 · T-0188: seeder completeness guard — every known_tenant table has a seeder', () => {
  for (const tableName of KNOWN_TENANT_TABLES) {
    it(`table ${tableName} has a seeder in seedRowForTable`, () => {
      expect(
        SEEDED_TABLES.has(tableName),
        `Table '${tableName}' is in known_tenant_tables.txt but has no case in seedRowForTable. ` +
        `Add a seeder function and a case entry, then add '${tableName}' to SEEDED_TABLES.`,
      ).toBe(true);
    });
  }
});
