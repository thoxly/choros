# ADR-T0611 — resolveIdBySlug: deterministic refusal on registry_def slug ambiguity

Status: ACCEPTED
Task: T-0611 (bug, столп 5 — настройка через ИИ)
Stems from: T-0607 review F4 (docs/review/T-0607.review.json)
Spec: T-0611.spec.md

## Context

`resolveIdBySlug(client, tenantId, table, idOrSlug)` in `src/http/assistant.ts`
lets the assistant's DRAFT-op executor accept either a raw UUID or a slug for
two tables:

- `application` — `UNIQUE (tenant_id, slug)` → a slug can never collide within
  a tenant. Safe today, safe after this change.
- `registry_def` — `UNIQUE (tenant_id, application_id, slug)` → the SAME slug
  is allowed to exist under two different applications in one tenant. The
  current query (`WHERE tenant_id = $1 AND slug = $2 LIMIT 1`, no
  `ORDER BY`, no `application_id` filter) picks an ARBITRARY row on collision.

Five call sites use the resolver, all in `src/http/assistant.ts`:

| Line | Op | Table | On `null` today |
|---|---|---|---|
| 550 | `relate_application` (source) | registry_def | rollback + honest "не найден" |
| 570 | `relate_application` (link target) | registry_def | rollback + honest "не найден" |
| 678 | `author_binding` | application | rollback + honest "не найден" |
| 742 | `edit_jsonschema_non_destructive` | registry_def | rollback + honest "не найден" |
| 934 | `generate_process` grounding | application | degrade to null grounding (non-fatal) |

No call site has an `application_id` / "current application" available to
narrow the `registry_def` lookup — the configurator's tool schemas
(`relate_application`, `edit_jsonschema`) only pass a registry identifier
(slug or UUID), never an app scope, and there is no dialogue-scoped "current
application" concept in the assistant today. Introducing one is a larger
tool-schema/dialogue-state change (NEEDS-DESIGN-sized) — out of scope per the
spec's non-goals.

## Decision

Change `resolveIdBySlug`'s return type from `Promise<string | null>` to a
discriminated result:

```ts
export type SlugResolveResult =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "ambiguous";
      readonly slug: string;
      readonly candidates: ReadonlyArray<{
        readonly registryDefId: string;
        readonly applicationSlug: string;
        readonly applicationDisplayName: string;
      }>;
    };

export async function resolveIdBySlug(
  client: pg.PoolClient,
  tenantId: string,
  table: "registry_def" | "application",
  idOrSlug: string,
): Promise<SlugResolveResult>
```

Behavior:

1. UUID passthrough unchanged: `UUID_RE.test(idOrSlug)` → `{ kind: "id", id: idOrSlug }`
   immediately (no query) — this is the majority path (LLM was actually given
   a UUID) and stays a zero-cost no-op.
2. Otherwise, query **all** matching rows (no `LIMIT 1`), ordered
   deterministically (`ORDER BY id`) so behavior is reproducible even in the
   (currently impossible for `application`, possible for `registry_def`)
   multi-row case:
   - `application`: `SELECT id FROM choros.application WHERE tenant_id=$1 AND slug=$2 ORDER BY id`
   - `registry_def`: `SELECT rd.id, a.slug AS application_slug, a.display_name AS application_display_name FROM choros.registry_def rd JOIN choros.application a ON a.tenant_id = rd.tenant_id AND a.id = rd.application_id WHERE rd.tenant_id=$1 AND rd.slug=$2 ORDER BY rd.id`
3. Zero rows → `{ kind: "not_found" }`.
4. Exactly one row → `{ kind: "id", id: <that row's id> }` — identical
   observable behavior to today for the non-ambiguous case.
5. Two-or-more rows (`registry_def` only; `application` can never reach this
   branch given its schema constraint, but the code path is table-generic and
   handles it defensively rather than assuming) → `{ kind: "ambiguous", slug, candidates }`.
   For `application` the candidates list only carries `registryDefId`/app
   fields relevant to `registry_def`; since `application` never produces this
   branch in practice, the candidate shape is specialized to `registry_def`
   call sites (the two current `application` call sites never need to render
   an `application`-shaped ambiguous candidate list).

Call-site handling (all 5 sites updated to the new discriminated result):

- `kind === "id"` → unwrap `.id`, proceed exactly as before.
- `kind === "not_found"` → same honest "не найден" message as before (rollback,
  no mutation) — byte-identical user-facing text, so the T-0607 AC-6b db-test
  keeps passing unmodified.
- `kind === "ambiguous"` (only reachable for the three `registry_def` sites:
  550, 570, 742) → rollback (no mutation, no partial write), return an honest
  op-error string naming the slug and enumerating candidate applications by
  slug + display name, and instructing re-issue with the raw registry UUID:

  ```
  edit_jsonschema_non_destructive: слаг «items» неоднозначен — существует в
  нескольких приложениях этого пространства (Приложение А [app-a], Приложение
  Б [app-b]). Уточните: укажите raw UUID нужного реестра (registryDefId).
  ```

  The `generate_process` grounding call site (934, `application` table) keeps
  its existing degrade-to-null-on-any-non-"id" behavior — `ambiguous` is
  treated the same as `not_found` there (both degrade gracefully; this path
  is a soft grounding hint, not a write, so refusing is unnecessary — it
  already never throws).

## Why not thread application_id context instead

Considered per the review's alternative suggestion ("pass/resolve
application_id context"). Rejected for THIS task because:

- No dialogue-scoped "current application" exists in the assistant's thread
  model today — building one means new tool-schema parameters
  (`applicationId` added to `relate_application`/`edit_jsonschema`), new LLM
  prompt guidance to populate it correctly, and new dialogue-state plumbing.
  That is a genuine feature addition, not a bug fix, and risks the LLM
  passing a WRONG `application_id` just as easily as it passes an ambiguous
  slug (same class of "LLM has no ground truth" problem T-0607 already
  diagnosed) — it would need its own resolve+validate step, in which case the
  deterministic-refusal fallback below is still required as the safety net.
- The deterministic-refusal fix is strictly safer as a floor: it converts a
  SILENT wrong-target mutation into an HONEST no-op with actionable guidance,
  with no new tool-schema surface and no schema migration. It composes with a
  future `application_id`-context feature (that feature would just make the
  ambiguous branch rarer, not remove the need for it).

## Backward compatibility

- Exported type change (`Promise<string | null>` → `Promise<SlugResolveResult>`)
  is a breaking change to `resolveIdBySlug`'s signature, but it is NOT part of
  any public HTTP contract — it's an internal helper used only within
  `src/http/assistant.ts` (module-local call sites) plus the T-0607 db-test
  (`ci/checks/db/edit-jsonschema-slug-resolve.test.ts`), which calls the HTTP
  layer's `executeApprovedOpAsDraft` (unaffected signature) rather than
  `resolveIdBySlug` directly. All 5 in-module call sites are updated in the
  same commit.
- User/LLM-facing behavior for the two existing branches (`id`, `not_found`)
  is byte-identical to before — only the new `ambiguous` branch is new
  observable behavior, and it only fires for a precondition (`registry_def`
  slug collision across apps) that could previously only produce a WRONG
  silent mutation, never a correct one. There is no way for this change to
  turn a previously-correct resolution into a refusal: single-match resolution
  is untouched.

## Test plan

New live-Postgres test `ci/checks/db/registry-def-slug-ambiguity.test.ts`
(fitness:db job), mirroring `edit-jsonschema-slug-resolve.test.ts`'s harness
(`registerTenant` + `InMemoryKeycloakUserPort` + raw SQL seeding):

1. Seed TWO applications in one fresh tenant, each with a `registry_def` row
   sharing the SAME slug (`items`).
2. `executeApprovedOpAsDraft(edit_jsonschema_non_destructive, { registryDefId: 'items', ... })`
   → asserts: return is a non-null honest string, matches `/неоднознач/`,
   lists BOTH application slugs, and — critically — NEITHER registry's
   `record_schema` changed (proves no wrong-target mutation happened).
3. Resolving by the RAW UUID of one of the two ambiguous registries still
   works (unambiguous escape hatch) — the field lands on exactly that one
   registry, the other is untouched.
4. Existing `edit-jsonschema-slug-resolve.test.ts` (T-0607 AC-6a/b/c) reruns
   green, unmodified — proves the non-ambiguous path is unchanged.
