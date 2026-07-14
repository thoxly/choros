# ADR-T0727 — операционная гигиена деактивации (R-4/R-5 из ревью T-0702)

Status: ready
Task: T-0727 (substrate — users/гигиена; фикс-форвард ревью T-0702)
Base: `task/T-0727`, dev@294bfabc (T-0702 уже смержен)

## 1. Problem

См. спеку `docs/specs/T-0727-deactivation-hygiene.spec.md` §1. Коротко —
ревью T-0702 (`PATCH /api/users/:employee_id`, `src/http/user-mgmt.ts`,
ветка `active===false`: `setUserEnabled(false)` → `revokeUserSessions` →
DB-транзакция) оставило два открытых пункта:

- **R-4**: провал `revokeUserSessions` наблюдаем ТОЛЬКО в
  `audit_event.payload.kc_sessions_revoked:false` — не в логах. Оператор,
  мониторящий stdout/stderr сервиса (типовой первый инструмент диагностики),
  не видел деградацию в реальном времени.
- **R-5**: `setUserEnabled(false)` и `revokeUserSessions` уже успешно
  выполнились, а последующая DB-транзакция (ставит `deactivated_at` + пишет
  audit) падает — оставляет тенант в состоянии «KC-disabled, но
  choros-active» (`deactivated_at IS NULL`). Это pre-existing разрыв T-0583
  (не новый). Плюс отдельный, найденный при реализации этой задачи баг
  гигиены: ДО T-0727 повторный `PATCH {active:false}` на уже-деактивированной
  учётке безусловно писал ВТОРОЕ `user_account.deactivate` audit-событие и
  ПЕРЕЗАПИСЫВАЛ `deactivated_at` временем повтора, теряя исходную метку
  времени.

## 2. Decision — R-4 (лог при провале revoke)

Внутри существующего блока `PATCH ... active===false`, сразу после
`kc.revokeUserSessions(kcUserId)`, если возвращённое `revoked===false`:

```ts
console.warn(
  `[user-mgmt T-0727] KC revokeUserSessions failed for employee ${employeeId} ` +
    `(kcUserId=${kcUserId}) — session window-shrink degraded for this ` +
    `deactivation (best-effort, ADR-T0702 §2.2); the PDP gate ` +
    `(T-0658/T-0662 ACTOR_ACTIVE_SQL) remains the actual authorization ` +
    `guarantee regardless of this outcome. Recorded as ` +
    `payload.kc_sessions_revoked:false on the audit event too.`,
);
```

`console.warn`, НЕ `console.error` — это остаётся best-effort деградацией
(ADR-T0702 §2.2: деактивация НЕ падает целиком на этом исходе), а не
ошибкой сервиса. Мирроит существующую конвенцию кодовой базы (см.
`src/http/inbox.ts:1476`, `src/server/timer-firing-loop.ts:132` — оба
`console.warn` с префиксом `[<модуль> T-XXXX] ... (non-fatal)`). Не вводит
новую logger-абстракцию (нет ни одной в `src/` — `grep -rn "console\."`
единообразен по всему дереву).

Чисто аддитивно: audit-payload `{kc_sessions_revoked:false}` (T-0702)
остаётся неизменным — R-4 ДОБАВЛЯЕТ видимость в логах, не заменяет
audit-запись.

## 3. Decision — R-5 (идемпотентность повтора + recovery-путь)

### 3.1 Идемпотентный no-op

Существующий запрос, резолвящий целевого сотрудника под RLS актора
(`SELECT slug, kind FROM choros.employee WHERE tenant_id=$1 AND id=$2`),
расширен на `deactivated_at`. Сразу после него:

```ts
const alreadyInTargetState = (found.deactivated_at === null) === active;
if (alreadyInTargetState) {
  res.statusCode = 200;
  res.end(JSON.stringify({ employee_id: employeeId, active }));
  return;
}
```

Это происходит **ДО** LAST-OWNER guard и **ДО** любого вызова KC.
Обоснование порядка (не «после guard, до KC» и не «после всего»):

- **До LAST-OWNER guard.** Guard (T-0658 round 3) проверяет ТЕКУЩИЙ
  `role_assignment`, не текущее состояние деактивации цели. Если бы no-op
  срабатывал ПОСЛЕ guard, повторный PATCH на давно-деактивированной цели мог
  бы получить 409 `LAST_OWNER`, если ПОЗЖЕ (после оригинальной деактивации)
  все ДРУГИЕ владельцы тоже были деактивированы — редкий, но реальный
  сценарий, в котором истинно идемпотентный no-op вдруг начинает падать
  из-за НЕСВЯЗАННЫХ более поздних изменений. Проверка ДО guard делает
  no-op БЕЗУСЛОВНО безопасным.
- **До KC-вызовов.** Рассматривался вариант «всё равно звать
  `setUserEnabled`/`revokeUserSessions` на no-op, чтобы самопочинить
  обратный KC-дрейф» (кто-то вручную включил юзера в KC при уже
  деактивированной DB-записи) — отклонён (см. спека §4г): это НЕ тот
  recovery-сценарий, который просит ревью, и раздувает объём. Единственный
  ЗАПРОШЕННЫЙ recovery-путь (§3.2 ниже) не задет этим решением, потому что
  в НЁМ DB ещё честно читает «active» — no-op-гейт там НЕ срабатывает.

### 3.2 Recovery-путь: «KC-disabled + choros-active»

Сценарий: `setUserEnabled(false)` и `revokeUserSessions` уже отработали
успешно, DB-транзакция (SET `deactivated_at` + audit) упала ДО коммита
(обрыв соединения, падение процесса и т.п.) — `employee.deactivated_at`
остаётся `NULL` (честно «active», транзакция атомарна — либо UPDATE+audit
оба, либо ни один).

**Recovery = повторить ТОТ ЖЕ запрос `PATCH {active:false}`.** Поскольку DB
всё ещё читает «active», `alreadyInTargetState` вычисляется как `false` —
no-op-гейт (§3.1) НЕ срабатывает, запрос идёт ПОЛНЫМ потоком заново:
LAST-OWNER guard → `setUserEnabled(kcUserId, false)` (второй раз — KC просто
подтверждает уже `enabled:false`, не ошибка) → `revokeUserSessions` (второй
раз — POST `/logout` на уже разлогиненного пользователя — `204`, не ошибка,
ADR-T0702 §2.2 «никогда не бросает») → DB-транзакция (на этот раз, по
предположению, коммитится) → `deactivated_at` проставлен, audit-событие
записано. **Ни setUserEnabled, ни revokeUserSessions не требуют изменений
для этого — их идемпотентность уже существует** (см. §5 «Rejected
alternatives» ниже, почему код КС-порта не тронут).

Оператору: если замечен рассинхрон (например, через KC admin console видно
`enabled:false`, а в `/users` учётка показана активной) — просто повторить
деактивацию через тот же UI/API-вызов `PATCH {active:false}`; никакого
отдельного «recovery endpoint» не требуется.

### 3.3 Гонка на границе транзакции (defence-in-depth)

Между чтением `found.deactivated_at` (шаг из §3.1) и финальной DB-транзакцией
проходит LAST-OWNER guard + два KC-вызова — узкое окно, где КОНКУРЕНТНЫЙ
идентичный PATCH теоретически мог применить тот же переход первым. Финальный
`UPDATE` теперь заряжен предикатом состояния + `RETURNING`:

```sql
-- active===true (реактивация):
UPDATE choros.employee SET deactivated_at = NULL, updated_at = $3
 WHERE tenant_id = $1 AND id = $2 AND deactivated_at IS NOT NULL
 RETURNING id;

-- active===false (деактивация):
UPDATE choros.employee SET deactivated_at = $3, updated_at = $3
 WHERE tenant_id = $1 AND id = $2 AND deactivated_at IS NULL
 RETURNING id;
```

Пустой `RETURNING` (0 строк) означает «кто-то уже применил тот же переход
между чтением и этой транзакцией» — audit-событие в этом случае НЕ
пишется (иначе один и тот же переход задвоился бы в audit при гонке, тот
же класс бага, что и §3.1 решает для последовательного повтора).

## 4. Object model / contracts

Без миграции. Изменения только в `src/http/user-mgmt.ts` (PATCH handler) +
`ci/checks/db/user-mgmt.db.test.ts` (тесты). `src/keycloak/admin-port.ts` /
`src/keycloak/fake-user-port.ts` НЕ тронуты — их идемпотентность уже
существовала (ADR-T0702), эта задача на неё ОПИРАЕТСЯ.

Ответ HTTP (`{employee_id, active}`, 200) на no-op-повторе — БАЙТ-В-БАЙТ
такой же, как на реальном переходе (ADR-T0702 §8 «pure additive» инвариант
сохранён — ни один существующий вызывающий код не различит no-op от
реального перехода по форме ответа).

## 5. Fitness functions / tests

| id | rule | ci_check |
|----|------|----------|
| FF-727-WARN-LOG | Провал `revokeUserSessions` → `console.warn` вызван с текстом, содержащим `T-0727` и `employee_id`; деактивация всё равно 200; `payload.kc_sessions_revoked===false`. | `ci/checks/db/user-mgmt.db.test.ts` (extended, live PG) |
| FF-727-IDEMPOTENT-DEACT | Повтор `PATCH {active:false}` на уже-неактивной → 200, KC call-count не растёт, `deactivated_at` не меняется, ровно 1 audit-событие `user_account.deactivate`. | same file |
| FF-727-IDEMPOTENT-REACT | Повтор `PATCH {active:true}` на уже-активной → 200, KC не вызывается, audit-событие `user_account.reactivate` не пишется вовсе. | same file |
| FF-727-RECOVERY | `deactivated_at` сброшен в NULL «из-под капота» (модель упавшей DB-tx) → повторный PATCH НЕ короткое-замыкается, доводит переход до конца, KC-вызовы повторяются без ошибки. | same file |
| user-mgmt-reuses-kc-port (inherited) | Никакой второй KC-интеграции не введено. | `ci/checks/user-mgmt-reuses-kc-port.sh` |
| user-mgmt-no-secret-leak (inherited) | Новый лог не содержит `password`/секретов (проверено статически — лог несёт только `employee_id`/`kcUserId`). | `ci/checks/user-mgmt-no-secret-leak.sh` |
| actor-authority-deactivation-gate (inherited) | Новый `SELECT ... deactivated_at FROM choros.employee WHERE tenant_id=$1 AND id=$2` — это TARGET lookup по `id`, НЕ actor-slug lookup (`slug = $`-форма гейта его не матчит) — не добавляет неучтённый authority-резолвер. | `ci/checks/actor-authority-deactivation-gate.sh` |
| audit_append_only (inherited) | Гигиена не меняет DDL/grants на `audit_event`/`audit_head` — append-only инвариант не тронут. | `ci/checks/audit_append_only.sh` |
| anti-case-lock (inherited) | Ни одного нового литерала из D-064 §5 денилиста не введено. | `ci/checks/anti-case-lock.sh` |

## 6. Rejected alternatives

| option | why not |
|--------|---------|
| Автоматический ретрай/job-queue на DB-tx-провал | Нет job-queue инфраструктуры в кодовой базе (тот же вывод, что ADR-T0702 §2.1а для самого revoke-вызова) — заводить её ради редкого случая несоразмерно. Ручной повтор PATCH — уже существующий, минимальный интерфейс восстановления, который ЭТА задача делает безопасным для повтора (§3.1/§3.3). |
| Структурированный logger / новая зависимость для R-4 | В `src/` нет ни одной logger-абстракции — весь код использует `console.warn`/`console.error` с текстовым префиксом `[<модуль> T-XXXX]`. Вводить библиотеку ради одной строки лога — явное превышение объёма (соразмерность, coder red-line #5). |
| no-op-гейт ПОСЛЕ LAST-OWNER guard (текущее место guard'а не трогать) | Тогда повторный PATCH на давно-деактивированной цели мог бы 409 из-за несвязанной более поздней смены владельцев (§3.1) — идемпотентность была бы условной, не настоящей. Перемещение no-op-гейта РАНЬШЕ guard'а даёт безусловную гарантию за счёт нескольких строк, не структурного изменения guard'а самого. |
| Форс-вызов KC даже на no-op-повторе (самопочинка обратного KC-дрейфа) | Не тот сценарий, который называет ревью (recovery — «choros ещё active», не «choros уже inactive, KC разошёлся обратно»); добавляет инвариант, который никто не просил, и лишний KC round-trip на КАЖДЫЙ клик «деактивировать» после первого. Запрошенный recovery-путь и без этого решения работает (§3.2 — DB там честно «active», no-op не срабатывает). |
| Полная сериализация PATCH (`SELECT ... FOR UPDATE`) вместо WHERE-guarded UPDATE + RETURNING | `FOR UPDATE` — структурное изменение блокировочной модели существующего `withTenantTx`-паттерна (используется идентично во ВСЕХ write-модулях этого файла и соседних — `rights-intents.ts`, `seed-write.ts`), несоразмерно объёму этой задачи (гигиена одного эндпоинта). WHERE-guarded UPDATE + `RETURNING` даёт ту же гарантию («ровно один вызов реально применяет переход и пишет audit») БЕЗ явной блокировки — Postgres MVCC делает то же самое implicit через row-visibility правила UPDATE. |
| Отдельный HTTP-эндпоинт `/api/users/:id/reconcile` для recovery | Не нужен — существующий `PATCH {active:false}` УЖЕ и есть recovery-механизм после этой задачи (§3.2); второй эндпоинт дублировал бы ту же логику ради названия. |

## 7. Traceability

| AC (spec) | covered by |
|-----------|-----------|
| AC-1 (R-4 warn log) | FF-727-WARN-LOG |
| AC-2 (repeat deactivate no-op) | FF-727-IDEMPOTENT-DEACT |
| AC-3 (repeat reactivate no-op) | FF-727-IDEMPOTENT-REACT |
| AC-4 (recovery path completes) | FF-727-RECOVERY |
| AC-5 (no-op does not error) | FF-727-IDEMPOTENT-DEACT / FF-727-IDEMPOTENT-REACT (200, no throw) |
| AC-6 (gates green) | standard gates + 5 inherited fitness scripts (table §5) |
| AC-7 (recovery documented) | this ADR §3.2 |

## 8. Risks / compatibility

- **Pure additive on the HTTP contract.** Response shape, status codes
  (`503 AUTH_UNAVAILABLE`, `409 LAST_OWNER`, `404 NOT_FOUND`, `200`) —
  unchanged. A no-op PATCH now returns 200 the same as before (previously it
  ALSO returned 200, but with side effects — the side effects are what
  changed, not the HTTP contract).
- **`updated_at` no longer bumped on a no-op repeat.** Before this task, a
  redundant `PATCH {active:false}` on an already-inactive account silently
  advanced `employee.updated_at` on every call. That is now correctly
  suppressed too (the guarded `UPDATE`'s `WHERE` clause makes it a genuine
  no-op at the SQL level) — nothing else in this codebase currently reads
  `employee.updated_at` for a security or ordering decision (grep confirms
  the only consumers are display/list ordering), so this is a safe,
  intended side effect of the fix, not a separate silent behavior change.
- **Residual gap, explicitly out of scope (§3 spec §4б):** if the DB-tx
  ALSO fails on the recovery retry (e.g., Postgres itself is down), the
  mismatch persists and requires ANOTHER retry once the DB is back — this
  ADR does not add a background reconciler. Consistent with ADR-T0702's own
  no-job-queue stance.
- **`actor-authority-deactivation-gate.sh` compatibility**: the new
  `deactivated_at` column read added to the existing target-employee lookup
  is a `WHERE ... id = $2` shape (write-target existence, per the gate's own
  documented scope note — "Write-target existence by id... is a DIFFERENT
  shape and never matched by this gate at all"), not an actor `slug = $`
  lookup — confirmed green by running the gate (§5 table).
