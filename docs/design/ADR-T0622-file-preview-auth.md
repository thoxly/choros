# ADR-T0622 — browser-auth fix for file preview/download (blob-fetch path)

Status: ready
Task: T-0622 (P0 — file preview/download 401 in keycloak mode, real browser)
Base: dev@296ae1b, branch `task/T-0622-file-preview-auth`

## 1. Problem (from re-LIVE_PROOF T-0579, real browser)

The file listing resolves (`GET /api/records/:id/files` → 200, name shown),
but the actual bytes never arrive:

- **Preview**: the record-detail card renders `<img
  src="/api/files/:vid/download?disposition=inline">`. The browser's native
  image load does not carry the SPA's session headers → 401 → broken image
  icon.
- **Download**: a click on `<a href="/api/files/:vid/download">` navigates
  natively — again no auth header attached → 401.

Root cause: `GET /api/files/:fileVersionId/download` is wrapped in `withAuth`
(src/http/files.ts), which in keycloak mode requires
`Authorization: Bearer <token>`. Every fetch() call in this SPA attaches that
header via `authHeaders()`/`fetchWithAuthRetry()` (dev-auth.js) — but `<img
src>` and `<a href>` are native browser loads, not fetch() calls, so they
never carry it. Dev mode happened not to show this (no Bearer required
there), so it only surfaced against the real keycloak stack.

## 2. Decision — option (b): route preview + download through fetch()→blob

No new token surface (no query-string token, no auth cookie, no second auth
mechanism). Every place that used to set a native `src`/`href` straight to
`/api/files/:versionId/download[...]` now:

1. calls `fetchWithAuthRetry(url)` (dev-auth.js, T-0608) — the SAME
   mode-aware header builder (`X-Dev-User` / `Authorization: Bearer`) every
   other screen already uses, with keycloak's existing mid-session
   self-heal (one silent refresh + one retry on 401) as a bonus;
2. turns the response into a `Blob`;
3. hands the browser a same-origin `blob:` object URL instead of the bare
   API path — an `<img src={blobUrl}>` for previews, or a programmatic
   `<a download>` click for downloads (the exact pattern already
   established by `downloadReportExport` in screen-reports.jsx (T-0492),
   `bpmn-save-load.js`, and `shell.jsx` — this task generalizes it into a
   shared helper instead of a 4th copy-paste).

New shared module: **`web/src/lib/authed-file.js`**
- `fetchFileBlob(url, fetcher)` → `{ ok: true, blob, mime } | { ok: false,
  status, message }`. Never throws. Honest messages for 401/403/404/network
  error, distinct from each other (no "denied" catch-all).
- `downloadFile(url, filename, fetcher)` → fetches the blob, then does the
  createObjectURL → `<a download>` click → `revokeObjectURL` dance. Always
  sets `download` on the anchor — the browser never renders the blob's
  content, regardless of mime (this is also why it is safe for svg/html:
  the anchor never navigates to/embeds the blob URL as a document).

Both take an injectable `fetcher` (defaults to `fetchWithAuthRetry` at the
call site, not baked into the module) so the unit tests can mock it without
needing jsdom/DOM globals beyond what's stubbed.

### Wiring (3 components, all client-only)

| component | file | before | after |
|---|---|---|---|
| `FileFieldValue` | `web/src/screens/screen-record-detail.jsx` | `<img src={previewHref}>` (bare API path) + `<a href={downloadHref}>` | preview: `fetchFileBlob` → `<img src={previewUrl}>` (blob) with loading/error states; download: `<a href="#" onClick=…downloadFile…>` |
| `FileCell` | `web/src/screens/screen-app-records.jsx` | `<a href={...download}>` | `<a href="#" onClick=…downloadFile…>`, honest inline download-error span, `stopPropagation` preserved |
| `FileField` | `web/src/forms/field-renderer.jsx` | `<a href={downloadHref}>` | `<a href="#" onClick=…downloadFile…>`, honest inline download-error span |

`FileField` (the form control) never rendered an inline image preview before
T-0622 and still doesn't — only the record-detail card (`FileFieldValue`)
does. That scope is unchanged; only its download path moved to the blob
helper.

## 3. Anti-XSS (B1) — unaffected, verified

The T-0579 positive mime allowlist (`PREVIEW_SAFE_IMAGE_SUBTYPES` in
screen-record-detail.jsx, mirroring the server's
`INLINE_SAFE_IMAGE_SUBTYPES`/`isInlineSafeMime` in src/http/files.ts) is
**unchanged** and still gates which mimes get an `<img>`/`<embed>` at all.
`fetchFileBlob` only fetches bytes — it has no opinion on "safe to render."
The caller (`FileFieldValue`) still checks `isPreviewSafeMime(meta.mime)`
BEFORE it even attempts the preview blob fetch; svg never reaches the `<img>`
branch (mime resolved from the listing endpoint, same as before). The
`isImagePreview`/`isPdfPreview` booleans gate the preview `useEffect` itself
— a non-preview-safe mime never calls `fetchFileBlob` for inline display at
all, it only ever gets the honest "Скачать файл" download link.

`downloadFile` is separately safe by construction: it never builds an
`<img>`/`<embed>`, only a `download`-anchor click — a blob URL opened that
way is saved, not executed/rendered, regardless of mime. This holds for
every file type (svg included) without relying on the client's mime
allowlist as the only guard — the server still forces `attachment` for
unsafe mimes independently (belt-and-suspenders, unchanged).

## 4. Honest states (NF-5/D-062 convention, extended)

- **Preview**: `idle` (not preview-safe / no fetch attempted) → `loading`
  ("Загрузка превью…") → `ok` (blob rendered) → `error` (401 → "Сессия
  истекла — войдите снова", 403 → "Нет доступа", 404 → "Файл не найден",
  network → "Сетевая ошибка…", any other → HTTP-coded message). Never a
  silently broken `<img>`.
- **Download**: click always resolves; on failure an inline `role="alert"`
  message appears next to the (still-clickable, retryable) link — never a
  dead click with no feedback.

## 5. Rejected alternatives

| option | why not |
|---|---|
| Query-string token on the `<img src>`/`<a href>` URL (`?token=...`) | New auth surface (token leaks into browser history, server logs, Referer headers); duplicates the auth mechanism instead of reusing the existing header-based one; the task explicitly asked for "no new token surface." |
| Auth cookie mirroring the Bearer token | Same new-surface objection, plus CSRF exposure this app does not currently need to reason about (it is header-only auth today). |
| Make `withAuth` optionally accept query/cookie auth for this one route | Widens the server's auth surface for a client-side problem; the fix belongs entirely in the browser (native loads vs. fetch), not in relaxing server auth. |
| Leave `<img>`/`<a>` native, catch the 401 via a `<img onError>` handler and show a message but still don't fetch bytes | Does not fix downloads at all (a native `<a>` click cannot be intercepted into a fetch without preventDefault + JS anyway) — same amount of code, but leaves the actual bug (no bytes ever loaded) unfixed for images too. |

## 6. Object model / contracts

No schema change, no migration, no server change. Client-only fix:
- New: `web/src/lib/authed-file.js` (`fetchFileBlob`, `downloadFile`).
- Changed: `web/src/screens/screen-record-detail.jsx` (`FileFieldValue`),
  `web/src/screens/screen-app-records.jsx` (`FileCell`),
  `web/src/forms/field-renderer.jsx` (`FileField`).
- The frozen fitness check `ci/checks/file-field-catalog-isolation.sh`
  (FF-UPLOAD-ROUTE-ONLY) still passes unmodified: `field-renderer.jsx` still
  contains the literal `/api/records/${encodeURIComponent(recordId)}/files`
  (upload) and `/api/files/${encodeURIComponent(value)}/download` (the
  `downloadHref` string built for the fetch call, no longer a raw `href=`)
  — no second file-route surface was introduced, no S3/bucket/presign
  client code, just the SAME two routes now fetched with auth instead of
  loaded natively.

## 7. Fitness functions / gates

| id | rule | ci_check |
|---|---|---|
| FF-CATALOG / FF-UPLOAD-ROUTE-ONLY (inherited, T-0579) | file dispatch stays single-catalog; upload/download still only ever touch the two existing routes | `bash ci/checks/file-field-catalog-isolation.sh` (verified green, unmodified) |
| (new, unit) | `fetchFileBlob`/`downloadFile` behavioral contract: exact URL passed to the fetcher, honest 401/403/404/network/5xx messages, blob mime resolution, no throw | `web/src/lib/authed-file.test.js` (13 tests) |
| (new, unit) | `downloadFile` never renders inline (svg/pdf/any mime) — always `download=filename`, creates+revokes the object URL, does not touch the DOM on error | `web/src/lib/authed-file.test.js` |
| (new, structural) | `FileField`/`FileFieldValue`/`FileCell` never set a native `href`/`src` straight to the download API; import + call the shared helper; surface inline errors | `web/src/forms/field-renderer-file.test.jsx`, `web/src/screens/screen-record-detail.test.jsx`, `web/src/screens/screen-app-records.test.jsx` |
| G5 jargon denylist (inherited) | no new dev-jargon in visible product text | `bash ci/checks/ux/ux-g5-jargon-denylist.sh` (informational, unaffected) |

## 8. Traceability

| AC | covered by |
|---|---|
| Preview shows the actual image (not a broken icon) in keycloak mode | §2 blob-fetch preview path + FileFieldValue preview states |
| Download works via a click (not a dead 401) | §2 blob-fetch download path in all 3 components |
| svg is never inline-rendered as `<img>` | §3 — allowlist unchanged, gates the fetch itself now, not just the render |
| No new token surface | §2 — same `fetchWithAuthRetry`/header mechanism reused verbatim |
| Honest error states, not silence | §4 |
| Raw UUID never shown | unchanged from T-0579 (resolved name still used as filename/label) |

## 9. Runtime target

Client-only. Verified: `npm run build` (root/server, unaffected), `cd web &&
npm run build`, `tsc --noEmit` (root), `cd web && npx vitest run` (1996/1996
green), `npm run fitness` (root, exit 0 — 1199 PASS; the ~15 lines containing
the string "FAIL" are self-test fixtures asserting the DETECTOR catches a
planted bad case, immediately followed by `SELF-TEST PASS`/`PASS
self-test`; no real check failed). No DB touched — `fitness:db` not
applicable (no server/schema change).
