# ADR-T0620 — file-write authorization parity with record-write

Status: ready
Task: T-0620 (P0 — file upload/delete 403 for everyone, incl. tenant owner)
Base: dev@598abb1, branch `task/T-0620-file-write-authz`

## 1. Problem (from live sweep, wave-2, real browser)

Uploading a file through the product — `POST /api/records/:id/files` — returns
`403 {"reason":"no_grant"}` for **everyone**, including the tenant owner. The
file-path (and the B1 anti-XSS svg check on download) is fully blocked.

Root cause = an **authorization asymmetry** between record-write and file-write:

| surface            | authority actually enforced today                                   |
|--------------------|---------------------------------------------------------------------|
| record READ (GET)  | `record/read` PDP grant (T-0570 `resolveReadVisibility`→`isRecordReadable`). Everyone has it via T-0619 `role-reader`. ✅ |
| record WRITE (POST/PUT) | **tenant-membership only** — `resolveWriteFacet` (field-mask) is OPTIONAL and **NOT wired** in `server.ts`, so it honest-degrades to whole-resource `undefined` → `checkWriteMask` never denies. There is **no `resolveFor`/PDP call** on the record write-path at all. ✅ (writes succeed) |
| file READ (download) | `authorizeFileOp(...,"read")`→`resolveFor(...,"read")` = `record/read` grant. Everyone has it. ✅ |
| file WRITE (upload/delete) | `authorizeFileOp(...,"update"/"delete")`→`resolveFor(...,"update"/"delete")` = **`record/update` / `record/delete` grant**. **Nobody holds one** in any of the 11 tenants (the only record-grant anywhere is `role-reader/record/read`). ❌ **403 no_grant for all.** |

So file-write is gated by a **stricter, non-existent** grant than the write it
mirrors. Record-write is allow-all-for-tenant-members (write-PDP not connected
yet); file-write demands a `record/update` grant that the write-PDP would issue
— but the write-PDP is not connected. The two are out of phase.

### Secondary bug — orphan `choros.file` row on deny

`POST /files` inserts the `choros.file` row (via `fileStore.insertFile`) and
THEN calls `addVersion`. On a PDP deny, `addVersion` **returns** `{denied}` (it
does not throw). Because the tx fn returns normally, `withTenantTx` **COMMITs**
— leaving an orphan `choros.file` row (`current_version = NULL`, 0 versions).

## 2. Decision

**Option (a) — a single shared write barrier.** File upload / replace / delete
pass through the **exact same authorization barrier** as record-write, by
wiring the file-routes' write authority to the **same honest-degrade write path**
record-write uses — NOT the full `record/update` PDP.

Concretely:

1. **file READ stays on the real `record/read` PDP** (unchanged). Download must
   give exactly the record's read authority — no more (T-0619 `role-reader`),
   no less. This is already correct and is preserved verbatim.

2. **file WRITE (update/delete) is gated by a new injectable
   `WriteAuthorizer` seam** on `FileRoutesDeps`, mirroring records.ts's
   `resolveWriteFacet?` honest-degrade discipline:
   - `server.ts` wires it to the **same tenant-membership authority record-write
     uses today** (allow for a resolved tenant member — the write-PDP is not
     connected). When, in a later task, the write-PDP is connected, BOTH
     record-write and file-write connect to it **in the same commit** and gate
     together, consistently.
   - The tenant-gate is **unconditional and first** (fail-closed): a subject
     whose tenant ≠ the file's tenant is denied `cross_tenant` before any
     authority call. Tenant isolation of files is NOT relaxed.

   This is realized at the composition root: the file-routes are given a
   `FileRecordResolver` whose `resolveRecordOp` returns the **record-write
   parity verdict for write ops** (`update`/`delete`) and delegates **read ops
   to the real `resolveFor(...,"read")` PDP**. `authorizeFileOp` in the pure core
   is **untouched** — it still translates each file op to its record op and
   asks the injected resolver; the *composition root* decides what authority
   that resolver carries for writes (exactly how record-write's authority is a
   composition-root wiring choice, not baked into the record write core).

   Why not gut `authorizeFileOp`'s per-op mapping in core: that primitive has a
   frozen contract + unit tests (`read≠update≠delete`, FF-DERIVED-AUTHZ,
   file-attachment-isolation.sh FF-NOACL). The asymmetry is a **wiring** defect
   (file-write wired to a grant class record-write is not wired to), so the fix
   belongs at the wiring seam, leaving the reusable core intact for the day the
   write-PDP lands.

3. **Orphan fix.** In `POST /files`, do the **PDP/authority check BEFORE
   `insertFile`**. On deny, throw (→ `withTenantTx` ROLLBACK), so no
   `choros.file` row is committed. Successful upload still commits file+version
   atomically inside the one tx. `addVersion` re-checks the same authority (it
   loads the file it just inserted) — belt-and-suspenders; on the success path
   both agree.

## 3. Rejected alternatives

| option | why not |
|--------|---------|
| (b) Map `authorizeFileOp` update/delete to the `read` op | Would let a read-only grant erase content once the write-PDP lands — a privilege escalation that the T-0119 FF-DERIVED-AUTHZ unit tests explicitly forbid (`read≠update≠delete`). We want parity with record-*write*, not collapse-to-read. |
| Issue a `record/update` grant to `role-reader` (migration) | Grants a write-class capability to a read role in the grant table — the exact over-grant that field-visibility / RBAC forbids. And it would make file-write STRICTER than record-write (which needs no grant at all). Data-grant is the wrong layer; the fix is code. |
| Gut `authorizeFileOp` to allow-all for writes in core | Breaks the frozen T-0119 per-op contract + FF-NOACL; loses the day-the-write-PDP-lands consistency. |
| Silent `return` orphan cleanup by deleting the row after deny | A second DB round-trip that races; ROLLBACK-before-commit is the atomic, canonical fix (check before insert). |

## 4. Object model / contracts

No schema change. No migration. (The fix is in the authorization *wiring*, not
in grants or tables — confirmed: nobody needs a new grant; parity means
file-write demands the SAME nothing record-write demands.)

New/changed contracts:

- `src/core/file-attachment.ts` — **unchanged** (`authorizeFileOp`,
  `addVersion`, `FileRecordResolver` all as-is).
- `src/http/files.ts` —
  - `POST /files`: resolve write authority **before** `insertFile`; on deny,
    respond 403 and DO NOT insert (throw inside tx → ROLLBACK). Success path
    unchanged (file+version atomic in one tx).
- `src/server.ts` — the `FileRecordResolver` wired into `registerFileRoutes`
  becomes a **split resolver**:
  - `op === "read"` → `resolveFor(deps, handle, subject, "read")` (real PDP,
    unchanged).
  - `op === "update" | "delete"` → **record-write parity**: tenant-gate
    fail-closed, then the same authority record-write applies today (allow for a
    resolved tenant member; honest-degrade until the write-PDP is connected).

## 5. Fitness functions

| id | rule | ci_check |
|----|------|----------|
| FF-620-PARITY | file-write must not require a grant class record-write does not require. Machine proof: a live DB test (`ci/checks/db/file-write-authz.db.test.ts`) — owner AND a plain `role-reader` employee upload a file → 201, file+version present, download 200. Mirrors the exact grant state record-write runs under. | `npm run fitness:db` |
| FF-620-TENANT | cross-tenant file access stays denied. Live DB test: employee of tenant A cannot upload to / download a file of tenant B (403/404, no bytes). | `npm run fitness:db` |
| FF-620-ORPHAN | a denied upload commits ZERO `choros.file` rows. Live DB test: construct a deny (cross-tenant), assert `SELECT count(*) FROM choros.file` unchanged. | `npm run fitness:db` |
| FF-NOACL (inherited) | file-attachment.ts introduces no second file-permission authority; still routes through resolveFor/resolveRecordOp. Unchanged core keeps this green. | `ci/checks/file-attachment-isolation.sh` |
| FF-READ-PRESERVED | file download read-auth = record/read PDP (unchanged). Existing `files-http.test.ts` AC-download-2 (resolver deny→403) + AC-download-3 (cross-tenant→404) stay green. | `npm run test` |

## 6. Traceability

| AC (task) | covered by |
|-----------|-----------|
| owner AND plain employee upload → success | §2.2 split resolver write-parity + FF-620-PARITY db test |
| tenant isolation of files held | §2.2 unconditional tenant-gate first + FF-620-TENANT db test |
| orphan not committed on deny | §2.3 check-before-insert + FF-620-ORPHAN db test |
| success still atomic (file+version) | POST /files one-tx unchanged + FF-620-PARITY asserts version present |
| download read-auth unchanged | §2.1 read stays on real PDP + FF-READ-PRESERVED |

## 7. Runtime target

Local + server (GT-4 dev stack /srv/choros). No new external resource. DB tests
run against the real PG on :55432.
