# Spec · T-0174 — Notifications E-N.7: audit wiring confirmation + e2e delivery test

**Phase:** SPEC → BUILD · **Status:** ready · **Date:** 2026-06-12
**Task:** T-0174 (product=choros, type=standard_code, prio 50)
**ADR consumed:** `docs/design/T-0120-notifications.adr.md` §2.8 (audit), §2.6 (delivery via outbox), §5 E-N.7
**Deps done:** T-0168 (migrations), T-0169 (router+fanout), T-0170 (email driver+wiring), T-0171 (prefs+audit), T-0172 (templates), T-0173 (REST API)

---

## 0. Gap table (E-N.7 ↔ already-done ↔ remaining)

| E-N.7 ADR line | Already done (task / file) | Remaining |
|---|---|---|
| `notif.email_config.set` via `appendAuditEvent` | T-0170 `notification-email.ts:193-214` | — (DONE) |
| `notif.email_config.revoke` via `appendAuditEvent` | T-0170 `notification-email.ts:225-258` | — (DONE) |
| `notif.preference.changed` via `appendAuditEvent` on admin PUT | T-0171 `http/notification-prefs.ts:283-300` | — (DONE) |
| `notif.preference.changed` via `appendAuditEvent` on self PUT | T-0171 `http/notification-prefs.ts:373-390` | — (DONE) |
| Delivery = `outbox.dispatched_at`, NOT `audit_event` per-delivery | T-0170 (FF-NO-DELIVERY-AUDIT grepped; no `appendAuditEvent` in `makeNotificationDeliver`/email-driver) | — (DONE) |
| `is_read` NOT audited | T-0173 `http/notifications.ts` (FF-NO-ISREAD-AUDIT grepped) | — (DONE) |
| `notif.email_config.set` audit unit test (without smtp_handle in payload) | T-0170 `notification-email.test.ts:314-390` | — (DONE) |
| `notif.preference.changed` audit unit test | **MISSING** — notification-prefs.test.ts has no audit-event test | **ADD unit test** |
| e2e: `publishNotificationEvent → fanout → notification row + outbox → runOutboxOnce → in-app noop + email via FakeSmtpSender` | **MISSING** — all tests are unit-level with fake stores; no wired pipeline test | **ADD wired-pipeline unit test** |

**Conclusion:** config-audit wiring for `email_config.*` is fully done and unit-tested (T-0170). The two
remaining gaps are:
1. A unit test proving `notif.preference.changed` audit event is emitted (the wiring exists in T-0171 code
   but is not tested).
2. A wired-pipeline test driving `publishNotificationEvent → fanout (prefs T-0171 + templates T-0172) →
   notification INSERT + outbox-row → runOutboxOnce → in-app noop + FakeSmtpSender deliver` — verifying
   that every link in the chain is real (same pattern as `main-wired-entry.test.ts` for lifecycle audit).

---

## 1. Summary

T-0174 closes the final E-N.7 gap: adds a unit test proving `notif.preference.changed` audit is emitted,
and adds a wired-pipeline test that drives the full notification delivery chain with real fanout logic and
fake boundary IO (InMemoryAuditWriter + FakeSmtpSender + in-memory stores + `runOutboxOnce`). No new
production code is expected — all wiring was done by T-0168..T-0173. If any link in the chain is broken,
the pipeline test fails (integration-honesty gate, same pattern as T-0068 `main-wired-entry.test.ts`).

---

## 2. Functional requirements

- **FR-1** Add a unit test for `notif.preference.changed` audit: calling the admin-PUT handler code path
  (or calling `appendAuditEvent` at the same call-site as `notification-prefs.ts`) emits an `audit_event`
  with `type='notif.preference.changed'`, carrying `event_kind`/`recipient_scope`/`channels`; `smtp_handle`
  absent. Tests `InMemoryAuditWriter` to capture the row.

- **FR-2** Add a wired-pipeline test `notification-e2e.test.ts` (unit-level, no live DB, no real SMTP):
  drives the full delivery chain:

  ```
  publishNotificationEvent
    ├─ reads prefs (in-memory PrefStore with one 'in_app' + one 'email' preference)
    ├─ reads templates (notification-templates renderTemplate, code-bundled)
    ├─ INSERTs notification row (in-memory NotifStore)
    ├─ enqueues outbox rows (in-memory OutboxStore)
  runOutboxOnce(fakeOutboxStore, makeNotificationDeliver(registry))
    ├─ in_app row → inAppNoOpDriver → {ok:true} → markDispatched
    └─ email row → EmailChannelDriver(configStore, resolver, FakeSmtpSender)
                     → FakeSmtpSender captures the sent message
                     → {ok:true} → markDispatched
  ```

  Assertions:
  - `inAppCreated=1, outboxEnqueued=2` after `publishNotificationEvent` (1 in_app + 1 email)
  - `runOutboxOnce` returns `{ dispatched: 2, failed: 0, dead: 0 }`
  - `FakeSmtpSender.sent` contains exactly one email with correct `from`, `to`, `subject`
  - No `appendAuditEvent` in the deliver path (FF-NO-DELIVERY-AUDIT confirmed by observation)

- **FR-3** The test must use `FakeSmtpSender` (already in `src/adapters/smtp-sender.ts`) — no real network,
  no real SMTP. `EmailChannelDriver` is constructed with `makeDirectStringSmtpResolver()` (day-1 stub) +
  an in-memory `EmailConfigWritePort` returning a valid config (is_enabled=true, smtp_handle=valid-handle).

- **FR-4** The test must use real production modules (not mocks) for: `publishNotificationEvent`,
  `makeNotificationDeliver`, `inAppNoOpDriver`, `EmailChannelDriver`, `renderTemplate` (from templates),
  `runOutboxOnce`. Only boundary IO is faked (stores, SMTP sender).

- **FR-5** `retryable:false → immediate-dead` path: add one additional assertion in the pipeline test
  that when `FakeSmtpSender` is replaced with `FailingSmtpSender("permanent", false)`, the email outbox
  row becomes `dead` on first attempt (dispatched=0, dead=1, via `perRowMaxAttempts=1` wiring from
  `IMMEDIATE_DEAD_ERROR_PREFIX`).

---

## 3. Non-functional requirements

- **NF-1** No real SMTP, no DATABASE_URL, no live Postgres in these tests. All DB boundary = in-memory
  stores. Test runs in `npm test` (vitest run), not in `fitness:db`.

- **NF-2** Test file location: `src/__tests__/notification-e2e.test.ts`. The preference-audit test may
  be appended to `src/__tests__/notification-prefs.test.ts` (as a new describe block) or added as a
  separate section in the e2e test file.

- **NF-3** No new production files. All changes are test files only (unless a tiny seam is discovered
  missing — unlikely given all wiring was done by T-0170).

- **NF-4** `runOutboxOnce` is imported from the real `outboxDispatcher.ts`; `makeNotificationDeliver`
  from the real `notification-router.ts`; `EmailChannelDriver` from `notification-email.ts`. The chain
  must not stub any of these.

- **NF-5** In-memory fake stores must honour the minimal interface required by `runOutboxOnce`
  (`pendingBuckets`, `claimBatch`, `markDispatched`, `markRetry`) and by `publishNotificationEvent`
  (`prefStore.getPreferences`, `notifStore.insertNotification`, `outboxStore.enqueueInTx`).

---

## 4. Out of scope

- SLA-watchdog / escalations as producers of `NotificationEvent` — T-0095/E7
- Full notification center UI — Stage-2 / zone 7
- Tenant-configurable templates — Stage-2
- Real `SmtpSecretResolver` (vault/env) — Stage-2
- Bounce-webhook handling — Stage-2
- Live Postgres e2e test (DB boundary) — not needed: wiring correctness is proven by pure unit pipeline
  (same principle as `main-wired-entry.test.ts`); live DB schema / cross-tenant probes already in
  `ci/checks/db/notifications.test.ts`, `notification-preferences.test.ts`, `notification-center.test.ts`

---

## 5. Acceptance criteria

| id | text | verifiable_as |
|---|---|---|
| AC-1 | `notif.preference.changed` audit test: calling the audit path emits an `audit_event` row with `type='notif.preference.changed'`; payload contains `event_kind`, `recipient_scope`, `channels`; `smtp_handle` absent from payload | test |
| AC-2 | Pipeline test: after `publishNotificationEvent` with one `actor:user1` scope and channels `[in_app, email]`, `inAppCreated=1` and `outboxEnqueued=2` (one per channel) | test |
| AC-3 | Pipeline test: `runOutboxOnce` with `makeNotificationDeliver(registry)` processes both rows: `dispatched=2, failed=0, dead=0`; `FakeSmtpSender.sent` has one email with correct `from`/`to` fields | test |
| AC-4 | Pipeline test (immediate-dead path): with `FailingSmtpSender(retryable=false)`, email outbox row becomes `dead` on first attempt (`dead=1`); `perRowMaxAttempts` callback correctly triggers `maxAttempts=1` | test |
| AC-5 | No new production modules or migrations added (test-only change confirmed by `git diff --name-only`) | manual |
| AC-6 | `tsc --noEmit` and `npm test` (vitest run) pass without new errors | fitness |
| AC-7 | `npm run fitness` (including `notification-isolation.sh`, `notification-email.sh`, `notification-pref-isolation.sh`) passes | fitness |
