-- 077 · TEL process role seed (T-0336 / E15-S2)
--
-- Adds the two canonical TEL-linear roles that are referenced by
-- config/flowable/processes/tel-linear.bpmn20.xml via candidateGroups:
--   - role-initiator  (U1/U2 «Подача заявки» user-task pool)
--   - role-approver   (U4 «Согласование» user-task pool)
--
-- These roles exist in the in-process DEV_USER_ROLES fixture (inbox.ts)
-- but were missing from the SQL migration set. The candidateGroups →
-- role.slug linter (ci/checks/candidategroups-role-slug-linter.sh, T-0336)
-- caught this gap: production BPMN files MUST reference seeded role slugs.
--
-- Idempotent: ON CONFLICT DO NOTHING (UNIQUE(tenant_id, slug)).
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
-- Role UUIDs use prefix e0000000 with sequential suffixes:
--   role-initiator = e0000000-0000-0000-0000-000000000003
--   role-approver  = e0000000-0000-0000-0000-000000000004

INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
VALUES
  (
    'a0000000-0000-0000-0000-000000000001',
    'e0000000-0000-0000-0000-000000000003',
    'role-initiator',
    'Инициатор заявки',
    'TEL-linear pool — U1/U2 task «Подача заявки»: employees who may initiate purchase requests',
    0, 0
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'e0000000-0000-0000-0000-000000000004',
    'role-approver',
    'Согласующий',
    'TEL-linear pool — U4 task «Согласование»: employees with budget-approval authority',
    0, 0
  )
ON CONFLICT DO NOTHING;
