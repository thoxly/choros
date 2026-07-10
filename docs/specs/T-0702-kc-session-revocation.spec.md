# T-0702 — Спека: отзыв KC-сессий при деактивации сотрудника

**Status:** ready
**Phase:** SPEC (compressed S+D+B, coder-authored — followup строителя T-0662,
родитель T-0569)
**Task:** T-0702 [security/substrate, столп 4 — агенты/сотрудники с правами]
**Date:** 2026-07-10
**База:** ветка `task/T-0702`

---

## 1. Контекст

T-0658 закрыл PDP-резолюцию: деактивированный сотрудник теперь резолвится в
`[]` грантов в КАЖДОМ из семи authority-резолверов (T-0662 систематизировал их
под одним предикатом `ACTOR_ACTIVE_SQL`, `src/db/actor-authority-gate.ts`, с
фитнес-гейтом `ci/checks/actor-authority-deactivation-gate.sh`, ловящим любой
НОВЫЙ authority-резолв без предиката). `PATCH /api/users/:employee_id`
(`src/http/user-mgmt.ts`) уже вызывает `kc.setUserEnabled(kcUserId, false)`
KC-first — это блокирует ТОЛЬКО выдачу НОВОГО KC-токена.

ADR-T0658 §9 сам называет остаток честно:

> «KC-токен всё ещё жив до TTL» ... держатель токена по-прежнему может пройти
> AUTHENTICATION ... Отзыв самого KC-токена (session revocation API) —
> отдельная, более крупная задача вне рамок T-0658.

Это и есть T-0702: PDP уже закрыт (авторизация деактивированного = `[]`
грантов на любом пути), но окно AUTHENTICATION (KC признаёт токен валидным до
TTL) остаётся открытым — деактивированный с уже выданным токеном может
достучаться до `withAuth`-гейта (проходит проверку подписи/exp), после чего
КАЖДЫЙ authority-резолвер уже отдаёт ему `[]` — но не-authority эндпоинты
(display/read-only без authority-резолва) в этом окне всё ещё отвечают, и
authentication сама по себе — сигнал, которым не стоит разбрасываться.
Задача — СЖАТЬ окно: явно оборвать уже выданные KC-сессии в момент
деактивации, а не просто ждать TTL.

## 2. Разведка (что уже есть, что переиспользуем)

- `KeycloakUserPort` (`src/keycloak/admin-port.ts`) — единственный
  KC-интеграционный порт для человеческих учёток (N5, `ci/checks/
  user-mgmt-reuses-kc-port.sh` требует, чтобы `user-mgmt.ts` не заводил
  вторую точку интеграции). Уже несёт `createHumanUser` / `deleteUser` /
  `setUserEnabled`.
- Живой Keycloak REST: `POST /admin/realms/<realm>/users/<id>/logout`.
  Подтверждено live-запросом на стенде `t-0633-keycloak-1` (:8180, realm
  `choros`, `choros-registrar` service-account, роль `manage-users` уже
  выдана тому же клиенту, что используется для `setUserEnabled`):
  существующий пользователь → `204`; несуществующий `id` → `404`. Тот же
  registrar-токен (`getRegistrarToken`), которым уже пользуется
  `setUserEnabled`, авторизует и logout-эндпоинт — новых KC-ролей/клиентов не
  требуется.
- `PATCH /api/users/:employee_id` (`src/http/user-mgmt.ts:563-692`) —
  единственный write-путь, ставящий `employee.deactivated_at` (подтверждено
  ADR-T0658 §2.2: `grep -rn "SET deactivated_at" src/` находит ровно эту одну
  строку) — единственная точка, где нужен новый вызов.
- Аудит: `userMgmtAuditWriter.appendAuditEvent` уже пишет
  `user_account.deactivate` / `.reactivate` с пустым `payload: {}`
  (`user-mgmt.ts:675-686`). `payload` — `jsonb`, произвольная форма
  (`src/db/audit-writer.ts`) — расширение полем не требует миграции.

## 3. Объём (что строим)

1. Новый метод порта `KeycloakUserPort.revokeUserSessions(userId): Promise<{
   revoked: boolean }>` — `POST /admin/realms/<realm>/users/<userId>/logout`
   через тот же registrar-токен. **Best-effort**: НИКОГДА не бросает — любая
   ошибка (сеть, 404, 5xx) ловится внутри порта и превращается в
   `{revoked:false}` (симметрично `deleteUser`'s best-effort семантике в этом
   же файле, но с явным булевым результатом вместо молчаливого swallow —
   вызывающая сторона должна знать исход для аудита).
2. `PATCH /api/users/:employee_id`, ветка `active===false`, СРАЗУ ПОСЛЕ
   успешного `kc.setUserEnabled(kcUserId, false)` (which remains
   NOT-best-effort — недоступность KC на ЭТОМ шаге по-прежнему 503,
   деактивация не происходит, поведение T-0583 не меняется) — вызывает
   `kc.revokeUserSessions(kcUserId)` и передаёт булевый исход в тот же
   audit-event `user_account.deactivate`: `payload.kc_sessions_revoked:
   boolean`.
3. Ветка `active===true` (реактивация) — БЕЗ изменений, `revokeUserSessions`
   не вызывается (см. §4в).
4. Три реализации порта (`makeHttpKeycloakUserPort`, `InMemoryKeycloakUserPort`,
   inline honest-degrade объект в `server.ts`) + 2 inline тестовых мока в
   `src/__tests__/register.test.ts` получают метод (TS проверяет полноту
   контракта структурно — компилятор не даст забыть реализацию).

## 4. Вне объёма / решённые вопросы (см. ADR §2 для обоснования)

- (а) Синхронный вызов внутри того же HTTP-запроса — НЕ отдельная
  fire-and-forget очередь с ретраем (в кодовой базе нет job-queue
  инфраструктуры; вводить её ради одного best-effort вызова — превышение
  объёма задачи).
- (б) Деградация при недоступном KC на шаге revoke — best-effort, деактивация
  ЗАВЕРШАЕТСЯ (200, `deactivated_at` проставлен), `kc_sessions_revoked:false`
  в аудите. PDP-слой (T-0658/T-0662) уже закрывает права независимо от исхода
  этого вызова — это ТОЛЬКО сжатие окна AUTHENTICATION, не security-гейт.
- (в) Реактивация НЕ отражает revoke обратно — новый вход создаёт новую
  сессию сам по себе; `revokeUserSessions` при `active:true` не вызывается и
  не нужен.

## 5. Acceptance criteria

| id | текст | verifiable_as |
|----|-------|----------------|
| AC-1 | При `PATCH {active:false}` успеха `setUserEnabled` — `revokeUserSessions(kcUserId)` вызывается РОВНО 1 раз. | test |
| AC-2 | Успешный revoke → `audit_event` для `user_account.deactivate` несёт `payload.kc_sessions_revoked===true`. | test |
| AC-3 | KC недоступен на шаге revoke (после того как `setUserEnabled` уже прошёл) → деактивация ВСЁ РАВНО завершается 200, `deactivated_at` проставлен, `payload.kc_sessions_revoked===false` — деактивация не падает целиком. | test |
| AC-4 | `PATCH {active:true}` (реактивация) — `revokeUserSessions` НЕ вызывается (call count не растёт). | test |
| AC-5 | `setUserEnabled` сам по себе падает (KC недоступен на ЭТОМ шаге, до revoke) → 503, `deactivated_at` НЕ меняется, `revokeUserSessions` не вызывается — регрессия T-0583 не введена. | test |
| AC-6 | Все существующие implementers контракта порта (live/fake/honest-degrade/test-inline ×2) реализуют новый метод — `tsc --noEmit` зелёный. | test |
| AC-7 | `ci/checks/user-mgmt-reuses-kc-port.sh` / `ci/checks/user-mgmt-no-secret-leak.sh` остаются зелёными (никакой второй KC-интеграции, никакого нового секрета). | fitness |
| AC-8 | Живой KC (`POST /admin/realms/choros/users/:id/logout`) отвечает `204` на существующего пользователя тем же registrar-токеном — подтверждено вручную (см. §2), формальный e2e через UI — live_proof_plan (стенд offline на момент задачи). | manual |

## 6. Out of scope

- Отзыв сессий агентов (`kind='agent'`) — `deactivated_at` структурно
  недостижим для агентских строк (ADR-T0658 §2.2), нет активного write-пути.
- Общий механизм "отозвать все сессии по любой причине" (например, смена
  пароля, security-инцидент) — только путь деактивации.
- Отражение revoke в UI (кнопка/индикатор) — только backend + аудит.
