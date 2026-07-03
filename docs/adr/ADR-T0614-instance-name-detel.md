# ADR-T0614 — деТЭЛизация `projectionToInstance` (имя/прогресс/исполнители)

**Status:** ready
**Phase:** DESIGN
**Task:** T-0614 [P1, деТЭЛизация]
**Date:** 2026-07-03
**Спека:** `docs/specs/T-0614-instance-name-detel.spec.md` + `docs/specs/T-0614.spec.contract.json` (AC-1..AC-10)
**База:** dev @ `6fe5d7b` (ветка `task/T-0614-instance-name-detel`)

---

## 1. Решение

`InstanceProjection` (`src/http/process-projection.ts`) — единственный `pg`-несущий
модуль в цепочке `processes.ts → process-projection.ts → choros.audit_event`
(`processes.ts` помечен display-plane-pure, FF-DISPLAY-4/FF-7-3, не может импортировать
`pg`/`src/db/*` напрямую) — получает ТРИ новых honest-резолвленных поля вместо трёх
литералов, зашитых в `projectionToInstance` (`processes.ts:201-231`).

### 1.1. `definitionName` — имя из `process_definition`, фолбэк уже существует

```ts
// src/http/process-projection.ts — InstanceProjection получает:
readonly definitionName: string;
```

Резолв — ОДИН batched `SELECT DISTINCT ON (process_key) process_key, name FROM
choros.process_definition WHERE tenant_id=$1 AND process_key = ANY($2) ORDER BY
process_key, version DESC` (латест версия на process_key, tenant-scoped RLS) — ТОТ ЖЕ
паттерн, что `src/http/process-catalog.ts:190-198` (`listProcessDefRows`), только
отфильтрованный по встреченным в текущей выборке `process_key` (не весь каталог тенанта).
Строится Map `procKey → name`; на каждый `InstanceProjection` строки: `definitionName =
defNameByKey.get(procKey) ?? fallbackDefinitionName(procKey)`.

`fallbackDefinitionName` **переиспользуется** из `src/core/process-catalog-view.ts:82-86`
— НЕ дублируется вторым хардкодом. Он уже честно решает движковый-only случай (например
`"telLinear"` → «Канонический линейный ТЭЛ», прочий ключ → сам ключ как есть).

Запрос выполняется ВНУТРИ уже открытого `withTenant` tenant-scoped клиента в
`readEvents` (`process-projection.ts:720-795`) — не нужен новый пул/новая транзакция,
только один дополнительный `SELECT` в той же функции.

### 1.2. `stepsDone`/`stepsKnownTotal` — честный "known so far" счётчик, не BPMN-total

```ts
readonly stepsDone: number;
readonly stepsKnownTotal: number;
```

Вычисляются в `listInstanceProjections`'s per-row map из данных, УЖЕ прочитанных этой же
функцией (никакого нового запроса):

- `stepsDone` = (`baseApproved` ? 1 : 0) + число APPROVED `process.next_task` строк для
  этого инстанса (`nextTaskRows.filter(r => inst matches && approvedTaskIds.has(r.id))`
  — сегодня фолд считает только PENDING next_task через `pendingNextTaskInstanceIds`;
  APPROVED next_task строки легко посчитать из тех же уже прочитанных `nextTaskRows` +
  `approvedTaskIds`, симметрично существующему pending-фолду).
- `stepsKnownTotal` = `done` ? `stepsDone` (нет более шагов, которые проекция могла бы
  честно утверждать) : `stepsDone + concurrentSteps.length` (текущие ожидающие
  параллельные шаги — уже вычисленный `concurrentSteps` массив, `:867-876`).

`projectionToInstance` строит `progress = { done: p.stepsDone, total: p.stepsKnownTotal
}`. Это НЕ полный BPMN-граф-прогресс (не знает НЕпройденных узлов дальше по графу,
которые ещё не стали активными шагами) — сознательно неполно, зафиксировано как §4
follow-up вместо фабрикации точности, которой проекция не имеет (ADR T-0278 §2.3 явно
отвергла live-Flowable запрос на каждый read/парсинг BPMN как disproportionate — полный
total потребовал бы ровно такого похода).

### 1.3. `starterActorKind` — честно известный один исполнитель, не пара

```ts
readonly starterActorKind: "human" | "agent";
```

Резолв — `findEmployeeById(pool, tenantId, row.actor)` (`src/db/org.ts:191-224`), ТОТ ЖЕ
паттерн, что уже канонический в `src/http/inbox.ts:1370-1379` (`actorKind`): `emp?.type
=== "agent" ? "agent" : "human"`, non-fatal degrade к `"human"` на любую ошибку резолва
(актёр не найден / DB-недоступна) — try/catch, ЕСТЬ отдельный batched-запрос
(`findEmployeeById` уже tenant-scoped через `withTenant` внутри себя; батчинг по
distinct-actor делается на уровне `Promise.all` за один проход дедуплицированных
`row.actor` значений, не N+1 на каждый инстанс с одним и тем же актёром).

`projectionToInstance` строит `execs: [p.starterActorKind]` — ОДИН честно известный
исполнитель (тот, кто СТАРТОВАЛ инстанс — единственный actor, привязанный к
`InstanceProjection` сегодня), не безусловная зашитая пара `["human","agent"]`.

**`"service"` НЕ фабрикуется.** `choros.employee.kind` реально принимает только
`"human" | "agent"` (нет `"service"`-значения нигде в org-модели;
`migrations/093_agent_taxonomy_employee_nullable.sql:60` вводит `agent_type IN
('workforce','system','assistant')` — под-классификация ВНУТРИ `"agent"`, не отдельный
kind). Возвращать `"service"` без источника правды было бы НОВЫМ кейс-хардкодом —
отвергнуто, зафиксировано как §4 follow-up O2.

## 2. Отвергнутые альтернативы

1. **Читать `process_definition`/`employee` напрямую в `processes.ts` (новый `pg`
   импорт в этом файле).** Отвергнуто — файл ЯВНО помечен display-plane-pure
   (комментарий `:10-15`, FF-DISPLAY-4/FF-7-3), гейты `pack-serve-no-write.sh` /
   `start-route-isolation.sh` проверяют отсутствие `pg`/`src/db/*` импортов в этом
   файле. Все новые данные идут ЧЕРЕЗ `InstanceProjection`, экспортированный уже
   `pg`-несущим `process-projection.ts` — ровно канонический паттерн, каким уже
   протянут весь остальной проекционный контракт (ADR T-0278 §2.3).
2. **Полный BPMN-парсинг для точного `progress.total`.** Отвергнуто в РАМКАХ этой
   задачи — требует либо live-запроса к движку на каждый `GET /api/processes` (ADR
   T-0278 §2.3 уже отвергла live-Flowable запрос на read-путь как disproportionate),
   либо парсинга и кеширования BPMN XML определения на user-task-узлы — заметно
   бОльшая работа (нужно решить: откуда/когда парсить, где кешировать, что при смене
   версии определения). Честный "known so far" счётчик — минимально-честный шаг
   вместо фабрикации; полный total — follow-up O1.
3. **Оставить `execs` двух-элементным (человек+агент) как "безопасный дефолт".**
   Отвергнуто — это ровно та фабрикация, которую задача просит убрать (D-064): показ
   несуществующего исполнителя вводит в заблуждение о том, кто РЕАЛЬНО ведёт процесс.
   Один честно резолвленный `starterActorKind` — меньше, но правдиво.
4. **Протянуть actor-kind ПО КАЖДОМУ шагу инстанса (не только стартовавшему).**
   Отвергнуто в рамках этой задачи — потребовало бы менять `appendTaskApproved`/
   `appendNextTaskEvent`, чтобы каждое событие несло resolved actor-kind, и менять
   `InstanceProjection`, чтобы execs стал массивом ПО шагам, а не одним значением.
   Больший периметр правки write-пути ради UI-поля, которое сегодня используется как
   агрегированный список типов, — follow-up O3.
5. **Считать `stepsKnownTotal` через число UNIQUE `task_step` меток, встреченных за
   всё время жизни инстанса (включая ранее approved-и-заменённые ветки).** Отвергнуто —
   на AND-split ветки параллельны (не последовательны), простое уникальное множество
   меток переоценивало бы total на инстансах с повторно эскалированным/переоткрытым
   шагом (`escalated`-строки того же `task_step`). Текущая формула
   (`done + concurrentSteps.length`) явно ограничена «известно СЕЙЧАС», без попытки
   восстановить историческую уникальность меток — проще и не переоценивает.

## 3. Fitness-функции и трассируемость

См. `docs/adr/T-0614.adr.contract.json` (FF-1..FF-6, traceability AC↔FF).

## 4. Follow-up (зафиксировано, не в этой задаче)

- **O1** — точный `progress.total` = полное число user-task узлов BPMN-определения
  (движковая интроспекция / парсинг+кеш BPMN XML). Текущий шаг — честный "known so
  far" счётчик вместо фабрикации; полный BPMN-total — отдельная задача (нужно решить
  источник: live-запрос к Flowable per-инстанс vs парсинг+кеш определения по
  process_key+version).
- **O2** — `execs` с `"service"` — появится источник правды (движковый service-task
  исполнитель / отдельная сущность в org-модели помимо `human`/`agent`), можно
  честно расширить union и резолв.
- **O3** — `execs` по КАЖДОМУ шагу инстанса отдельно (актёр approve + актёры каждого
  next_task), а не только стартовавший actor — требует протянуть actor-kind через
  approve/next_task события в `InstanceProjection` как массив по шагам.

## 5. Эскалация

Нет. Чисто READ-путь honest-резолва трёх полей вместо трёх литералов; новые запросы —
read-only `SELECT` внутри уже открытой tenant-scoped транзакции + переиспользование
существующего `findEmployeeById`. Display-plane-purity `processes.ts` не нарушена (новый
`pg`-импорт не добавлен в этот файл). Никакого нового authority/write-пути.
