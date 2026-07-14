# ADR-T0621 — PgFileStore executor-threading for real transaction atomicity

Status: ready
Task: T-0621 (P0 — substrate, changes_product=0)
Base: dev@c25fdc8, branch `task/T-0621-filestore-tx`

## 1. Problem

`POST /api/records/:recordId/files` (src/http/files.ts) wraps `insertFile` +
`addVersion` in a `withTenantTx(pool, tenantId, async (client) => {...})` block —
a dedicated `pg.PoolClient` with `BEGIN` / `SET LOCAL choros.tenant_id` /
`COMMIT` / `ROLLBACK`. The intent is that a failure anywhere in the callback
rolls back the WHOLE sequence.

But every `PgFileStore` method (`insertFile`, `getFile`, `getVersion`,
`maxVersionNo`, `insertVersion`, `setCurrentVersion`, ...) queried
`this.pool.query(...)` directly — **a separate, autocommitting connection**,
not the `client` the tx callback received (which the route, until this task,
never even passed anywhere — the callback parameter was named `_client` and
was unused). Each PgFileStore call therefore committed the instant it ran,
independent of what happened later in the callback and independent of whether
the outer `withTenantTx` ultimately COMMITted or ROLLBACK'd.

T-0620 already fixed the **PDP-deny** instance of the orphan this caused:
decide the write authority BEFORE calling `insertFile` at all, so a clean 403
deny never reaches `insertFile` — zero orphan by construction on that path.
T-0620's own pr-handoff named the **residual** gap explicitly:

> "withTenantTx is cosmetic for PgFileStore" — insertFile/insertVersion/
> setCurrentVersion still each run on their own pooled connection. A genuine
> mid-transaction DB error (not a PDP deny) between insertFile committing and
> insertVersion committing is still unrecoverable: insertFile's row survives
> as an orphan (`current_version = NULL`, zero versions) regardless of the
> outer ROLLBACK, because insertFile was never really PART of that
> transaction — it ran and committed on a different connection entirely.

This task closes that residual gap.

## 2. Decision

**Thread the tx client through PgFileStore as an optional trailing
`executor` parameter — additive, mirroring the T-0636 P0-6 precedent
(`PostgresJobStore.enqueue`'s `executor?: Queryable` seam) exactly.**

Concretely:

1. **`Queryable`** — a new interface in `pgFileStore.ts`, structurally
   identical to `pgJobStore.ts`'s own `Queryable`
   (`{ query<T>(text, values?): Promise<{rows: T[]}> }`). Satisfied by both
   `pg.Pool` and `pg.PoolClient` — no new dependency, no `pg` import added
   anywhere it wasn't already present (`pgFileStore.ts` already imports `pg`
   for its `Pool` constructor type).

2. **Every `PgFileStore` method** (`insertFile`, `getFile`, `getVersion`,
   `maxVersionNo`, `insertVersion`, `setCurrentVersion`, `markContentErased`,
   `updateRetentionState`) gains an **optional trailing** `executor?:
   Queryable` parameter. Body: `const q = executor ?? this.pool; await
   q.query(...)`. Omitting the parameter reproduces exactly today's
   behaviour for every existing caller — this is purely additive, not a
   breaking signature change (TypeScript: a function with an extra optional
   parameter is assignable wherever the shorter signature is expected).

3. **`PgFileStore.boundTo(executor): FileMetaSource`** — a new method
   returning a plain object where every `FileMetaSource` method delegates to
   `this.<method>(...args, executor)`. This is the seam that lets a
   **pure-core** caller — `addVersion` in `core/file-attachment.ts`, which
   must NOT import `pg` (FF-PURE, `ci/checks/file-attachment-isolation.sh`)
   — be handed a metadata source that transparently runs every query on a
   specific connection/transaction, without `core/file-attachment.ts` ever
   knowing `pg.PoolClient` exists. `core/file-attachment.ts` itself has
   **zero diff** in this task.

4. **`src/http/files.ts`'s upload route**: the `withTenantTx` callback
   parameter (previously unused, `_client`) is now `client`, used as:
   - `fileStore.insertFile(file, client)` — explicit executor.
   - `addVersion({ ..., meta: fileStore.boundTo(client), ... }, ...)` —
     `addVersion`'s internal `getFile`/`maxVersionNo`/`insertVersion`/
     `setCurrentVersion` calls all run on `client` via the bound view.

   Net effect: insertFile + every DAO call addVersion makes now run on
   **one** Postgres transaction. A throw anywhere in the callback (a PDP
   deny inside addVersion, a DB constraint violation, a connection error)
   rolls back the ENTIRE sequence — no DML above it has committed
   independently on a separate connection, so nothing can survive as an
   orphan.

Tenant-scoping is inherited, not re-derived: `withTenantTx` already runs `SET
LOCAL choros.tenant_id = '<tenantId>'` on `client` before the callback starts,
so every query the bound view runs on `client` is subject to the same RLS
scope — no change to tenant isolation semantics, only to which connection the
query physically runs on.

## 3. Rejected alternatives

| option | why not |
|--------|---------|
| Change `FileMetaSource`'s interface (in `core/file-attachment.ts`) to require an executor param on every method | Would force a `pg.PoolClient`-shaped type into the pure-core module's public contract, or force every OTHER `FileMetaSource` implementer (e.g. an in-memory test double, `document-render.ts`'s snapshot port) to plumb an executor they don't need. `boundTo` keeps the pure-core interface untouched and confines the tx-awareness to the adapter + composition-root layers, exactly where DB-specific concerns belong. |
| Have `addVersion` (core) accept an explicit `client`/executor argument itself | Same problem — leaks a `pg`-shaped type into pure-core's public API and violates FF-PURE (no pg import; an executor TYPE reference, even structural, would still couple the core's public signature to a DB-transaction concept it should not need to know about). `boundTo`'s delegation happens entirely on the `FileMetaSource` object the core already accepts as an opaque port — the core's code is unchanged. |
| Open a SECOND withTenantTx-style wrapper inside PgFileStore itself (PgFileStore manages its own transaction across insertFile+insertVersion) | PgFileStore does not know about `addVersion`'s S3 `store.put` call sandwiched between `insertFile`/`getFile` and `insertVersion` — the DAO cannot own a transaction that spans a call it does not make. The transaction must be opened by the caller (the HTTP route), which is exactly what `withTenantTx` already does; the fix is to make PgFileStore's ops actually PARTICIPATE in that already-opened transaction, not to give the DAO a second, competing transaction of its own. |
| Silent post-hoc cleanup (a periodic sweep deleting `current_version IS NULL` orphan rows) | A second, asynchronous mechanism papering over a synchronous bug — leaves a window where the orphan row is visible (e.g. to `listFilesByRecord`) before the sweep runs, and does not close the root cause. Real transaction atomicity is the direct fix; T-0620's ADR already rejected an analogous "cleanup after the fact" option for the same reason. |

## 4. Object model / contracts

No schema change. No migration. Contracts:

- `src/core/postgres/pgFileStore.ts` — NEW: `Queryable` interface,
  `PgFileStore.boundTo(executor): FileMetaSource`. CHANGED (additive):
  every existing method signature gains an optional trailing `executor?:
  Queryable` parameter; body resolves `this.pool` vs the supplied executor.
- `src/http/files.ts` — the `withTenantTx` callback in the upload route now
  uses its `client` parameter (previously unused) to call
  `fileStore.insertFile(file, client)` and to build
  `fileStore.boundTo(client)` as `addVersion`'s `meta` dependency. No other
  route in this file changes.
- `core/file-attachment.ts` — **unchanged** (`addVersion`, `FileMetaSource`,
  `authorizeFileOp`, `getFileContentUrl` all as-is; the `FileMetaSource`
  interface signature is not touched — `boundTo`'s returned object satisfies
  it structurally without any interface-level change).
- `src/__tests__/files-http.test.ts` — the `FakeFileStore` test double
  (already implementing `insertFile`, a PgFileStore-specific method not on
  the `FileMetaSource` interface, because it is cast to `PgFileStore` at the
  deps site) gains a `boundTo(executor)` method returning `this` (the fake
  has one shared in-memory Map with no real transaction/executor concept —
  `this` already IS the one store every op reads/writes, so binding to an
  executor is a no-op for the fake, while still satisfying the same call
  shape the real route now uses).

## 5. Fitness functions

| id | rule | ci_check |
|----|------|----------|
| FF-621-ATOMIC-FAIL | a mid-transaction DB error (insertVersion throws AFTER insertFile ran in the SAME callback) rolls back BOTH — zero orphan `choros.file` rows survive. Live DB test (`ci/checks/db/file-store-tx-atomicity.db.test.ts`): a `PgFileStore` subclass whose `insertVersion` always throws is wired into the real HTTP route; the upload request fails and `SELECT count(*) FROM choros.file` for that record is unchanged. | `npm run fitness:db` |
| FF-621-ATOMIC-OK | the happy path is unchanged: a successful upload still commits file+version together, `file.current_version` points at the new version. | `npm run fitness:db` |
| FF-621-TENANT | the bound executor inherits the SAME `SET LOCAL choros.tenant_id` GUC `withTenantTx` already set — no tenant-scoping regression from threading the client through PgFileStore. | `npm run fitness:db` |
| FF-621-BOUNDTO-UNIT | `PgFileStore.boundTo(client)` demonstrably runs every op on `client`: insert via `boundTo` is visible to a read via `boundTo` on the SAME (uncommitted) transaction, and invisible after `ROLLBACK` via a separate `PgFileStore` instance. | `npm run fitness:db` |
| FF-NOACL / FF-PURE (inherited) | `core/file-attachment.ts` introduces no pg/fs/net/http/fetch import and no second file-permission authority — unchanged core keeps this green (zero diff to the file). | `ci/checks/file-attachment-isolation.sh` |
| FF-620-* (regression) | T-0620's authz-parity + PDP-deny orphan-fix tests (`ci/checks/db/file-write-authz.db.test.ts`) stay green, unmodified. | `npm run fitness:db` |

## 6. Traceability

| AC (task) | covered by |
|-----------|-----------|
| mid-way DB error rolls back both insertFile+insertVersion (no orphan) | §2 executor-threading + FF-621-ATOMIC-FAIL db test |
| successful upload still atomic | §2 unchanged happy-path tx + FF-621-ATOMIC-OK db test |
| regression: T-0619/T-0620/T-0622/T-0624 upload/download/preview unaffected | full existing suite (unit + db) green; only additive `boundTo` fixture change in files-http.test.ts |
| tenant-isolation intact | §2 GUC inherited via the same client + FF-621-TENANT db test |
| 0 migrations | §4 — no schema/DDL touched |
| anti-case discipline | no case-specific literal in the diff; `anti-case-lock.sh` green |

## 7. Runtime target

Local + server (GT-4 dev stack /srv/choros). No new external resource. DB
tests run against the real PG on :55432, `--no-file-parallelism` (T-0147
isolation harness, unchanged).
