# ADR-T0702 — отзыв KC-сессий при деактивации сотрудника (сжатие TTL-окна)

Status: ready
Task: T-0702 (security/substrate — столп 4, агенты/сотрудники с правами;
followup строителя T-0662, родитель T-0569)
Base: `task/T-0702`

## 1. Problem

См. спеку `docs/specs/T-0702-kc-session-revocation.spec.md` §1. Коротко:
T-0658/T-0662 закрыли PDP-резолюцию деактивированного (все семь authority-
резолверов отдают `[]` грантов). `PATCH /api/users/:employee_id`
(`src/http/user-mgmt.ts`) уже гасит KC-логин `kc.setUserEnabled(kcUserId,
false)` — но это блокирует только выдачу НОВОГО токена. Уже выданный
access-токен деактивированного остаётся криптографически валиден до
собственного `exp` (Keycloak default access-token TTL — минуты), и в этом
окне держатель проходит `withAuth` (подпись/exp корректны). Дальше PDP уже
закрыт — но сама AUTHENTICATION деактивированного всё ещё проходит, и это
именно то окно, которое просит сжать задача.

## 2. Decision

Добавить `revokeUserSessions(userId): Promise<{revoked:boolean}>` в
существующий `KeycloakUserPort` (`src/keycloak/admin-port.ts`) — ЕДИНСТВЕННЫЙ
KC-интеграционный порт для человеческих учёток (N5) — и вызвать его из
`PATCH /api/users/:employee_id`, ветка `active===false`, СРАЗУ после
успешного `setUserEnabled(kcUserId, false)`.

Live-реализация: `POST /admin/realms/<realm>/users/<userId>/logout` (Keycloak
admin REST — "Remove all user sessions associated with the user") через тот
же `getRegistrarToken`/`choros-registrar` service-account, который уже
авторизует `setUserEnabled`. Подтверждено живым запросом на стенде
`t-0633-keycloak-1` (см. спека §2): `204` на существующего пользователя,
`404` на несуществующего — никакой новой KC-роли не требуется (`manage-users`
уже выдана `choros-registrar`, realm-choros.json:501-503).

### 2.1 (а) Синхронный вызов, не fire-and-forget с ретраем

Вызывается СИНХРОННО внутри того же HTTP-запроса `PATCH`, между
`setUserEnabled` и DB-транзакцией, что ставит `deactivated_at` + пишет
audit-event. Обоснование:

- В кодовой базе НЕТ job-queue/ретрай-инфраструктуры (grep по `src/` —
  единственные "фоновые" механизмы — таймер-воркер Flowable и
  message-ingest, оба chuжого домена, заводить job-queue ради одного
  best-effort HTTP-вызова — явное превышение объёма задачи, соразмерность).
- Синхронный вызов даёт возможность ОДНОЙ атомарной DB-транзакцией записать
  и `deactivated_at`, и `kc_sessions_revoked`-исход в ОДНОМ audit-event —
  без второй мутации/второго прохода.
- Задержка приемлема: `setUserEnabled` уже синхронный сетевой вызов к тому
  же KC в том же хендлере (T-0583 прецедент) — второй короткий вызов к тому
  же хосту не меняет порядок величины латентности PATCH.

### 2.2 (б) Деградация при недоступном KC — best-effort, НЕ ва-банк

`revokeUserSessions` НИКОГДА не бросает — любая ошибка (сеть, 5xx, 404)
ловится ВНУТРИ порта и возвращает `{revoked:false}`. Деактивация ВСЕГДА
завершается (200, `deactivated_at` проставлен), независимо от исхода этого
вызова. Обоснование:

- `setUserEnabled` (шаг ДО revoke) остаётся NOT-best-effort — если KC
  недоступен НА ЭТОМ шаге, деактивация по-прежнему падает 503 и
  `deactivated_at` не меняется (T-0583 поведение НЕ тронуто — деактивация
  логина остаётся жёстким инвариантом, revoke — нет).
- `revokeUserSessions` — сжатие ОКНА, а не security-ГЕЙТ. Реальная
  авторизация уже закрыта PDP-резолверами (T-0658/T-0662) НЕЗАВИСИМО от
  того, отозвана ли сессия. Если бы `revokeUserSessions` был жёстким (503
  при недоступности), деактивация оказалась бы заблокированной транзиентным
  сбоем ВТОРОСТЕПЕННОГО механизма — HR/owner не смог бы уволить сотрудника
  из-за временной проблемы с одним KC-эндпоинтом, хотя главный инвариант
  (PDP) уже закрыт первым, обязательным вызовом. Это неверный trade-off:
  задача прямо предписывает best-effort + аудит-запись о неудаче.
- Аудит фиксирует исход (`kc_sessions_revoked: boolean` в payload
  `user_account.deactivate`) — неудача НЕ скрывается, она наблюдаема
  (оператор может вручную дожать через KC admin console при инциденте).

### 2.3 (в) Реактивация не отражает revoke обратно

Ветка `active===true` не вызывает `revokeUserSessions` — обоснование: вход
создаёт НОВУЮ сессию сам по себе (Keycloak login flow), отзывать
несуществующие "reactivation sessions" нечего. Симметрия с деактивацией была
бы избыточной операцией без эффекта.

## 3. Where the call sits (точный контракт)

```
PATCH /api/users/:employee_id, active===false:
  1. LAST_OWNER guard (unchanged, T-0658 round 3)
  2. kc.setUserEnabled(kcUserId, false)   — UNCHANGED, still throws 503 on KC-down
  3. NEW: sessionsRevoked = await kc.revokeUserSessions(kcUserId)
          (never throws — catches internally, returns {revoked:boolean})
  4. DB tx: SET deactivated_at + appendAuditEvent(
       type: 'user_account.deactivate',
       payload: { kc_sessions_revoked: sessionsRevoked }
     )
```

Ветка `active===true` — шаги 2 и 4 (без revoke), без изменений в остальном.

## 4. Object model / contracts

Без миграции — `audit_event.payload` уже `jsonb` (`src/db/audit-writer.ts`),
новое поле `kc_sessions_revoked` — additive расширение существующего
`user_account.deactivate` payload (было `{}`, стало `{kc_sessions_revoked:
boolean}`).

- `src/keycloak/admin-port.ts` — `KeycloakUserPort` interface: новый метод
  `revokeUserSessions(userId: string): Promise<{revoked: boolean}>`.
  `makeHttpKeycloakUserPort`: live implementation, `POST
  /admin/realms/<realm>/users/<userId>/logout`, try/catch swallowing ALL
  errors → `{revoked:false}`; `204`/`200` → `{revoked:true}`.
- `src/keycloak/fake-user-port.ts` — `InMemoryKeycloakUserPort`: new capture
  log `revokeSessionsCalls: string[]` + `revokeSessionsCallCount` + one-shot
  `failOnRevokeSessions` switch (mirrors `failOnSetEnabled` pattern) — even
  the "failure" path returns `{revoked:false}` (never throws, matching the
  live port's never-throw contract).
- `src/http/user-mgmt.ts` — PATCH handler: call site (§3) + audit payload
  field.
- `src/server.ts` — inline honest-degrade `KeycloakUserPort` literal (no
  registrar secret configured): `revokeUserSessions` always returns
  `{revoked:false}` (consistent with the honest-degrade posture — no KC
  reachable at all).
- `src/__tests__/register.test.ts` — 2 inline test-local `KeycloakUserPort`
  literals get a no-op `revokeUserSessions` (not exercised by those tests,
  mirrors the existing `setUserEnabled` no-op comment pattern already there).

## 5. Fitness functions / tests

| id | rule | ci_check |
|----|------|----------|
| FF-702-CALLED-ONCE | Deactivation (`active:false`) success path → `revokeUserSessions` called exactly once with the KC userId. | `ci/checks/db/user-mgmt.db.test.ts` (extended, live PG) |
| FF-702-AUDIT-SUCCESS | Successful revoke → `audit_event` row for `user_account.deactivate` carries `payload.kc_sessions_revoked===true`. | same file |
| FF-702-DEGRADE | `revokeUserSessions` fails (KC down for THAT call specifically, `setUserEnabled` already succeeded) → deactivation still returns 200, `deactivated_at` is set, audit payload carries `kc_sessions_revoked===false`. | same file |
| FF-702-REACTIVATE-NOOP | `active:true` → `revokeUserSessions` call count does not increase. | same file |
| FF-702-SETENABLED-REGRESSION | `setUserEnabled` itself fails (KC down before revoke is ever reached) → 503, `deactivated_at` unchanged, `revokeUserSessions` never called (T-0583 behavior preserved). | same file |
| FF-702-PORT-UNIT | `makeHttpKeycloakUserPort().revokeUserSessions` posts to `/admin/realms/<realm>/users/<id>/logout` with the registrar bearer token; never throws on a non-2xx stub response. | `src/__tests__/admin-port.test.ts` (extended, stub HTTP server, no live KC) |
| user-mgmt-reuses-kc-port (inherited, unchanged) | `user-mgmt.ts` still has no literal `/admin/realms` and still imports `KeycloakUserPort` from `admin-port.js` — the new call goes through the port, not a new HTTP call in `user-mgmt.ts`. | `ci/checks/user-mgmt-reuses-kc-port.sh` |
| user-mgmt-no-secret-leak (inherited, unchanged) | No new hardcoded secret introduced; audit payload never carries a password. | `ci/checks/user-mgmt-no-secret-leak.sh` |

## 6. Rejected alternatives

| option | why not |
|--------|---------|
| Fire-and-forget with a retry queue | No job-queue infra exists in this codebase; introducing one for a single best-effort call is a scope blow-up disproportionate to the task (соразмерность, coder red-line #5). A synchronous best-effort call inside the same request achieves the goal (window-shrink) with zero new infrastructure. |
| Hard-fail deactivation if `revokeUserSessions` fails | Would make an IRREVERSIBLE HR action (firing someone) depend on the availability of a SECONDARY mechanism whose PRIMARY security property (PDP denial) is already guaranteed by `setUserEnabled` + T-0658/T-0662, independent of session revocation. Turns a defense-in-depth window-shrink into a new availability dependency — rejected per the task's own explicit degrade-policy instruction. |
| Revoke sessions from `getGrantsForSubject` (resolver-level, T-0662 style) | Session revocation is not a PDP predicate — it's an imperative KC side-effect (kill a live token), not a read-time SQL filter. The `ACTOR_ACTIVE_SQL` resolver pattern (T-0662) already closes the AUTHORIZATION side; this task closes the AUTHENTICATION side, which is structurally a KC admin-API call, not a query predicate. The two are complementary, not the same mechanism. |
| Reflect revoke on reactivation too (symmetry) | No sessions exist to revoke at reactivation time (the account was disabled, KC issues no tokens while `enabled:false`) — a symmetric call would be a no-op with zero observable effect, adding a call for its own sake. Rejected (§2.3). |
| New dedicated audit event type `user_account.sessions_revoked` | The revoke is not an independent business event — it's an attribute of the SAME deactivation act (same actor, same subject, same `occurred_at`). A field on the existing `user_account.deactivate` payload is the minimal, correctly-scoped representation (mirrors how `user_account.create` already carries `{login,email,display_name}` fields rather than three separate events). |

## 7. Traceability

| AC (spec) | covered by |
|-----------|-----------|
| AC-1 (called once) | FF-702-CALLED-ONCE |
| AC-2 (audit success) | FF-702-AUDIT-SUCCESS |
| AC-3 (degrade, deactivation still completes) | FF-702-DEGRADE |
| AC-4 (reactivation no-op) | FF-702-REACTIVATE-NOOP |
| AC-5 (setUserEnabled regression guard) | FF-702-SETENABLED-REGRESSION |
| AC-6 (tsc — all implementers complete) | standard gate (`tsc --noEmit`) |
| AC-7 (inherited fitness scripts stay green) | `user-mgmt-reuses-kc-port.sh` / `user-mgmt-no-secret-leak.sh` |
| AC-8 (live KC endpoint sanity) | §2 (manual curl proof, this ADR) + `live_proof_plan` (full UI→KC e2e, stand offline at task time) |

## 8. Risks / compatibility

- **Pure additive**: no existing behavior changes for any caller that does
  not hit the `active:false` branch of `PATCH /api/users/:employee_id`. The
  `setUserEnabled` contract, response shape (`{employee_id, active}`), and
  error codes (`503 AUTH_UNAVAILABLE`, `409 LAST_OWNER`, `404 NOT_FOUND`) are
  unchanged.
- **Still not a hard guarantee**: this narrows the AUTHENTICATION window but
  does not eliminate it instantaneously — Keycloak's `/logout` endpoint
  invalidates the SSO session and refresh tokens; a short-lived access token
  already cached by the KC adapter on the client side may still validate
  locally against its own `exp` until the adapter's own session check next
  round-trips to KC (implementation detail of the specific OIDC client, out
  of this task's control — Keycloak's own admin-console "Sign out" carries
  the identical limitation). This is a WINDOW-SHRINK, not a
  cryptographically instantaneous revocation — consistent with ADR-T0658 §9's
  own framing of this as the acknowledged remaining gap.
- **No migration** — `audit_event.payload` is already `jsonb`; the new field
  is read-add-only.
- **Agent employees unaffected** — `revokeUserSessions` is only reached from
  the `active===false` branch of `PATCH /api/users/:employee_id`, which is
  structurally restricted to `kind='human'` rows (ADR-T0658 §2.2 — unchanged
  by this task).
