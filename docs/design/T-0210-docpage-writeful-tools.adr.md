# T-0210 / P-2 — Internal writeful doc mcp_tools (ADR)

> **Status:** DESIGN — thin slot-pinning addendum.
> **Parent ADRs:** `docs/design/T-0134-agent-docs.adr.md` (docs-layer frame),
> `docs/design/T-0209-docsauthor-seed.adr.md` (P-1 principal + grants).
> **Pipeline spec:** `playbooks/research-3-docs-pipeline.md` §8 (P-2 row), §4.1/§4.3
> (read/write split is structural), §1.1 invariant "ноль новых механизмов прав".
> **Scope:** ONE data-seed migration `063_docpage_writeful_tools.sql` that materialises
> two internal writeful mcp_tools: `doc_page_author` and `doc_ref_set`.
> **Zero DDL. Zero new grants. Zero new resource_types.**

---

## 1. Context

P-1 (`migrations/062_docs_author_seed.sql`, T-0209) seeded the DocsAuthorAgent principal:
- Role `docs-author` UUID `e0000000-0000-0000-0000-000000000005`
- Employee `d0000000-0000-0000-0000-000000000015` (kind=agent, dormant LLM)
- Exactly two grants on `resource_type='doc_page'`: `{create}` (e2...018) and `{update}` (e2...019),
  both `delegable=false`

P-1 explicitly deferred mcp_tool materialisation to P-2 (its comment: "mcp_tool namespace NOT
consumed by P-1 — P-2 task for doc_page_author tool").

P-2 is ONLY a data seed: insert the two `mcp_tool` rows that the DocsAuthorAgent's writeful
procedures (P-3 REGEN, P-4 RECONCILE) will call at runtime. No schema change. No new grants.

### Dependency state (verified on branch, off `dev` at 9be007d)

- `mcp_tool` table: present since migration 040.
- `doc_page`/`doc_ref`/`doc_log` tables: present since migration 061 (T-0238).
- `known_tenant_tables.txt`: already lists `doc_page`, `doc_ref`, `doc_log` — **P-2 does not touch it**.
- Frozen files: `migrations/040_mcp_tool.sql` (frozen), `src/core/mcp-tool-registry.ts` (frozen) —
  P-2 does not touch either.
- read-only docs-MCP surface (`docs_list`/`docs_read`/`docs_search`): **NOT YET SEEDED** — T-0134f/g
  are pending tasks. There are no `mcp_tool` rows with `operation:'read'` on `doc_page` in any
  migration up to and including 062. See §3.2 for fitness implication.

---

## 2. The authority decision: `doc_ref_set` rides `{doc_page, update}`

### Decision: RIDES doc_page:update — no new resource_type, no new grant

**Justification:**

Setting a page's typed references (`doc_ref` rows) is semantically equivalent to updating the page's
content. In the LLM-wiki model, `doc_ref` rows are *children of* `doc_page` (FK `page_id → doc_page
ON DELETE CASCADE`, migration 061). The REGEN/RECONCILE agent always writes refs as part of authoring
or updating a page — never in isolation. "Set this page's refs" is therefore a sub-operation of
"update this page."

**Resolver semantics confirm the ride-on model is correct.** From
`src/core/mcp-tool-registry.ts::isToolReachable` (lines 139–161):

```
return tool.resourceOps.every((op) =>
  effectiveGrants.some(
    (g) => g.resourceType === op.resourceType && g.operation === op.operation,
  ),
);
```

For `doc_ref_set` with `resourceOps = [{resourceType:"doc_page", operation:"update"}]`:
- The docs-author role has an effective grant `{resourceType:"doc_page", operation:"update"}` (e2...019,
  seeded by P-1). `isEffective` passes (no valid_until).
- `every` over one pair → `some` over grants hits e2...019 → **reachable: true**.

No new `doc_ref` resource_type, no new grant row. P-1's two grants are **necessary and sufficient** for
both P-2 tools.

**Why not a separate `doc_ref` resource_type?**

The research invariant ("ноль новых механизмов прав") forbids new resource_types when the semantic
coverage is already provided by an existing one. Introducing `{doc_ref, create/update/delete}` would:
1. Re-open P-1's grant set (new rows in `grant` table → not "pure data seed for mcp_tool").
2. Require extending `isToolReachable`'s implicit contract (still works, but adds a third resource_type
   for no semantic gain).
3. Split authority that should be unified: an agent that can update a doc_page must also be able to set
   its refs — they are one conceptual write operation.

The ride-on model is therefore correct, minimal, and resolver-compatible.

---

## 3. Tool granularity decision: two tools, NOT one combined

### Decision: `doc_page_author` (create + update) + `doc_ref_set` (update only)

**Rationale (mirrors config-agent pattern):**

`migrations/044_config_agent_seed.sql` models emit/edit as *separate tools* per operation
(`emit_form_code` = create, `edit_jsonschema` = update, etc.) even when they share the same
resource_type. This is the established pattern in Choros. Agents select specific tools at call time
— separate tools give the runtime (P-3/P-4) precise, auditable action granularity.

`doc_page_author` carries both `create` AND `update` in its `resource_ops`, mirroring `author_template`
in migration 060 (which also bundles `create+update` for the template authoring lifecycle in a single
tool). The distinction between create and update for a page is a runtime concern (slug exists or not),
not a separate tool concern. One `doc_page_author` tool for the full page-authoring lifecycle is correct.

`doc_ref_set` is a separate tool because setting refs is a distinct agent action with its own semantic
(replace/reconcile the typed reference set of a given page). Keeping it separate gives the REGEN/
RECONCILE procedures a named, auditable action for ref management.

### Tool specifications

| Tool | `resource_ops` | Semantics |
|---|---|---|
| `doc_page_author` | `[{doc_page,create},{doc_page,update}]` | Create a new doc_page or update an existing one (body/title/slug/scope/stale/authored_by). Full lifecycle of page authoring. |
| `doc_ref_set` | `[{doc_page,update}]` | Set/replace the typed `doc_ref` rows for a given page (ref_kind, ref_target, broken). Rides doc_page:update authority. |

Both tools: `declares='[]'::jsonb`, `pure_compute=true` (satisfies `mcp_tool_pure_empty_chk`).

---

## 4. Migration plan: `063_docpage_writeful_tools.sql`

### 4.1 UUID namespace reconciliation

**mcp_tool UUIDs consumed up to migration 062:**

| Migration | UUIDs |
|---|---|
| 040 | 10…001, 10…002, 10…003 |
| 044 | 10…004 .. 10…00a (7 tools) |
| 053 | 10…00b |
| 059 | 10…00c .. 10…011 (6 tools) |
| 060 | 10…012 (author_template) |
| 062 | *(zero — explicitly deferred to P-2)* |

**Next free: `10000000-0000-0000-0000-000000000013`** (doc_page_author) and
**`10000000-0000-0000-0000-000000000014`** (doc_ref_set).

**grant UUIDs consumed up to migration 062:** e2…001..e2…019 (062 used 018 and 019).
**P-2 adds ZERO new grant rows.** Next free remains e2…01a for future migrations.

### 4.2 Exact rows to INSERT

```sql
-- Step 1. mcp_tool — doc_page_author
INSERT INTO choros.mcp_tool
  (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000013',
   'doc_page_author',
   'Create or update a doc_page in the agent-maintained wiki. Writes body/title/slug/scope/stale/authored_by. Paired with doc_ref_set for typed references. Draft-first: no promote authority (SEAM-2).',
   '[]'::jsonb,
   true,
   '[{"resourceType":"doc_page","operation":"create"},{"resourceType":"doc_page","operation":"update"}]'::jsonb,
   0, 0)
ON CONFLICT DO NOTHING;

-- Step 2. mcp_tool — doc_ref_set
INSERT INTO choros.mcp_tool
  (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000014',
   'doc_ref_set',
   'Set/replace the typed doc_ref rows for a given doc_page (ref_kind, ref_target, broken flag). Rides doc_page:update authority (doc_ref = child of doc_page, FK CASCADE). No separate doc_ref resource_type (research §1.1 NF-1).',
   '[]'::jsonb,
   true,
   '[{"resourceType":"doc_page","operation":"update"}]'::jsonb,
   0, 0)
ON CONFLICT DO NOTHING;
```

**No grant INSERTs.** P-1's grants e2...018 (create) and e2...019 (update) are sufficient.

### 4.3 ON CONFLICT discipline

`ON CONFLICT DO NOTHING` on every INSERT (AC-09, idempotent re-run pattern from 044/059/060/062).
The `mcp_tool` table has `PRIMARY KEY (tenant_id, id)` — conflict fires on exact UUID match.
Repeating the migration is safe.

### 4.4 Scope: PURE DATA SEED

- No `CREATE TABLE`.
- No `ALTER TABLE`.
- No changes to `ci/checks/known_tenant_tables.txt`.
- No changes to frozen files (`src/core/mcp-tool-registry.ts`, `migrations/040_mcp_tool.sql`).
- No changes to `ci/checks/frozen-sanctions.jsonl`.

---

## 5. Read-only docs-MCP surface: NOT YET BUILT

`docs_list`/`docs_read`/`docs_search` tools (T-0134f/g) do **not exist** in any migration up to 062
(confirmed by grep over `src/` and `migrations/`). There are no `mcp_tool` rows with
`operation:'read'` on `doc_page`.

**Fitness implication:** The "not in read-only surface" invariant (FF-DOCS-READONLY) cannot be
checked by asserting absence of a tool *name* in a populated table (no such rows exist yet). Instead,
the fitness check is structural:

- **Neither P-2 tool carries `operation:'read'`** in its `resource_ops`.
- A principal with ONLY `{doc_page, read}` grants (a future read-only external role, T-0134g) will
  NOT be able to reach `doc_page_author` or `doc_ref_set` via `isToolReachable`, because neither
  `{doc_page,create}` nor `{doc_page,update}` would be matched.

This is structurally enforced by the resolver — no runtime gatekeeping needed.

When T-0134g lands (docs-MCP mcp_tool seed), the fitness check upgrades to: "no row in `mcp_tool`
with name in {docs_list, docs_read, docs_search} has `operation` ∈ {create, update, delete} in
its resource_ops."

---

## 6. Reachability argument

### 6.1 Reachable by docs-author (e0…005)

Call `resolveAgentToolset({tenantId, employeeId: 'd0…015', nowMs})`:

1. Grants for employee d0…015 (via role e0…005 / role_assignment f0…004):
   - e2…018: `{doc_page, create}`, isEffective=true (no valid_until)
   - e2…019: `{doc_page, update}`, isEffective=true

2. `isToolReachable(doc_page_author, grants, tenantId, nowMs)`:
   - resourceOps = [{doc_page,create},{doc_page,update}]
   - every: {doc_page,create} → some(grants) hits e2…018 ✓; {doc_page,update} → hits e2…019 ✓
   - Result: **true**

3. `isToolReachable(doc_ref_set, grants, tenantId, nowMs)`:
   - resourceOps = [{doc_page,update}]
   - every: {doc_page,update} → hits e2…019 ✓
   - Result: **true**

**Necessary condition:** if grant e2…019 (`{doc_page,update}`) is removed, `doc_ref_set` becomes
unreachable. If both e2…018 and e2…019 are removed, both tools become unreachable (AC-12: zero
grants → zero tools). This is the correct structural dependency.

### 6.2 NOT reachable by a read-only principal

A read-only external principal (future T-0134g) would have grants only on `{doc_page, read}`:

1. `isToolReachable(doc_page_author, [{doc_page,read}], ...)`:
   - {doc_page,create} → no grant matches → some() = false → every() = **false**
   - Result: unreachable ✓

2. `isToolReachable(doc_ref_set, [{doc_page,read}], ...)`:
   - {doc_page,update} → no grant matches → some() = false → every() = **false**
   - Result: unreachable ✓

No runtime gatekeeping needed — structural grant mismatch makes write tools invisible to read-only
principals.

---

## 7. Machine-checkable fitness checklist

The tester/CI must assert ALL of the following after `063_docpage_writeful_tools.sql` runs:

### F-1 Tools exist with correct resource_ops
```sql
SELECT COUNT(*) FROM choros.mcp_tool
WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
  AND name = 'doc_page_author'
  AND resource_ops = '[{"resourceType":"doc_page","operation":"create"},{"resourceType":"doc_page","operation":"update"}]'::jsonb;
-- expect: 1
```
```sql
SELECT COUNT(*) FROM choros.mcp_tool
WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
  AND name = 'doc_ref_set'
  AND resource_ops = '[{"resourceType":"doc_page","operation":"update"}]'::jsonb;
-- expect: 1
```

### F-2 pure_compute=true and declares='[]' (mcp_tool_pure_empty_chk pattern)
```sql
SELECT COUNT(*) FROM choros.mcp_tool
WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
  AND name IN ('doc_page_author', 'doc_ref_set')
  AND pure_compute = true
  AND declares = '[]'::jsonb;
-- expect: 2
```

### F-3 Reachable by docs-author role via isToolReachable
Unit test (TypeScript, pure): construct `McpToolRow` objects for both tools, construct `Grant[]`
from P-1's two grants (e2…018 create, e2…019 update, same tenantId, nowMs within validity), call
`isToolReachable` — expect `true` for both.

Necessary-condition sub-test: remove grant e2…019 (update) → `doc_ref_set` returns `false`.
Remove both grants → both tools return `false` (AC-12).

### F-4 NOT reachable by read-only principal
Unit test (TypeScript, pure): construct `Grant[]` with ONLY `{doc_page, read}` (any UUID). Call
`isToolReachable(doc_page_author, ...)` and `isToolReachable(doc_ref_set, ...)` — expect `false`
for both.

### F-5 Tool names absent from docs-MCP read-only surface
```sql
-- No mcp_tool row named docs_list/docs_read/docs_search with a write operation exists.
SELECT COUNT(*) FROM choros.mcp_tool
WHERE name IN ('docs_list', 'docs_read', 'docs_search')
  AND resource_ops::text LIKE '%"create"%' OR resource_ops::text LIKE '%"update"%';
-- expect: 0
```
*(Forward-looking guard for when T-0134g is seeded. Currently trivially true — no such rows exist.)*

Also assert: `doc_page_author` and `doc_ref_set` are NOT in the docs-MCP surface:
```sql
SELECT COUNT(*) FROM choros.mcp_tool
WHERE name IN ('docs_list', 'docs_read', 'docs_search')
  AND id IN (
    '10000000-0000-0000-0000-000000000013',
    '10000000-0000-0000-0000-000000000014'
  );
-- expect: 0
```

### F-6 Idempotent re-run
Run migration 063 twice: no error, no duplicate rows. Assert counts remain 1/1 after second run.

### F-7 known_tenant_tables.txt unchanged
Assert no line added/removed from `ci/checks/known_tenant_tables.txt` by this migration.

### F-8 Frozen files unchanged
`src/core/mcp-tool-registry.ts` byte-hash unchanged. `migrations/040_mcp_tool.sql` byte-hash
unchanged. `ci/checks/frozen-sanctions.jsonl` unchanged.

### F-9 No new grants
```sql
SELECT COUNT(*) FROM choros."grant"
WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
  AND id NOT IN (
    SELECT id FROM choros."grant"
    WHERE created_at = 0  -- seed rows only
  )
  AND id >= 'e2000000-0000-0000-0000-00000000001a';
-- expect: 0 (no grant row at or beyond the next-free boundary introduced by P-2)
```
Simplified alternative: assert total grant count for docs-author role (e0…005) = 2 (unchanged from P-1).

---

## 8. Decisions summary

| Decision | Choice | Rationale |
|---|---|---|
| doc_ref_set authority | Rides `{doc_page,update}` | doc_ref = child of doc_page; isToolReachable matches on resourceType+operation; P-1's grants sufficient; no new resource_type |
| New grants needed | **None** | P-1's two grants cover both P-2 tools |
| Tool granularity | `doc_page_author` (create+update) + `doc_ref_set` (update) | Mirrors 044/060 pattern; distinct semantic actions; audit granularity |
| doc_page_author resource_ops | `[{doc_page,create},{doc_page,update}]` | Full page authoring lifecycle (mirrors author_template in 060) |
| doc_ref_set resource_ops | `[{doc_page,update}]` | Ride-on model; ref-set = update-page sub-operation |
| UUIDs | 10…013 (doc_page_author), 10…014 (doc_ref_set) | Next-free after 10…012 (060/author_template); 062 consumed zero mcp_tool slots |
| Grant UUIDs | None consumed | Next free remains e2…01a |
| Frozen / known_tables | Untouched | Pure data seed |
