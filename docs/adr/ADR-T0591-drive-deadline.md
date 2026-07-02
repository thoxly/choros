# ADR T-0591 — Общий deadline-бюджет на post-approve engine-drive путь (F-2, T-0571 review)

- **Status:** READY — design-only (продуктовый код не меняется здесь; edits — отдельный BUILD-таск).
- **Date:** 2026-07-02
- **Task:** T-0591 [W2/шов-latency] — верхняя граница латентности синхронного approve→движок.
- **Предшественники:** T-0571 (BUG-014 fix — синхронное завершение движковой задачи к HTTP-ответу approve, `ADR-T0571-engine-drive-seam.md`), T-0522 (idempotent reconcile-on-read).
- **Источник:** `docs/review/T-0571.review.json` finding F-2 (nit, resolved-by-followup → эта задача); `docs/specs/T-0591-drive-deadline.spec.md`.
- **Автор:** ARCHITECT (design only).
- **runtime_target:** `src/http/process-projection.ts` (`reconcileInstanceEngineDrive`, ~1282-1517), `src/http/inbox.ts` (approve handler 502-ветки, ~1680-1727), `web/src/screens/screen-inbox.jsx` (`ENGINE_DRIVE_ERROR_MESSAGE`, ~333-337). Никаких изменений `src/core/flowable-client.ts` (`withRetry`/`FlowableClient` интерфейс — см. §3 отвергнутая B1) и схемы БД — additive-only.

---

## 1. Контекст

F-2 (T-0571 review) вскрыла: `reconcileInstanceEngineDrive` post-approve путь дёргает движковый порт (`EngineDriveReconcilePort`) до пяти раз последовательно — poll-цикл `getActiveUserTasks` (повторяется до совпадения задачи или `pollTimeoutMs=10с` МЕЖДУ итерациями), `completeUserTask`, `isInstanceEnded` дважды (pre-ended-check + шаг 2 реконсайла), `getActiveUserTasks` ещё раз (шаг 3 fan-out). Каждый вызов на деле реализован через `withRetry` (`flowable-client.ts:406-466`): до `maxRetries+1=4` попыток × `timeoutMs=10_000` мс каждая + backoff между ними — то есть ОДИН такой вызов при медленном (не сразу рвущем соединение) движке может занять ~40+ секунд. Внешний `pollTimeoutMs` прерывает только МЕЖДУ итерациями цикла — не прерывает уже начатый `getActiveUserTasks`. T-0571 впервые сделала этот путь синхронным к HTTP-ответу (§2.3 её ADR) — так что деградировавший (не мёртвый, а медленный) движок способен растянуть ответ на кнопку «Согласовать» до нескольких минут, а не «до ~10 секунд», как подразумевал ADR-T0571.

Задача не регрессирует T-0571 (контракт статусов/кодов остаётся) и не выпиливает retry (нужен для одиночных транзиентных сбоев) — вводит ОБЩИЙ бюджет поверх уже существующей цепочки вызовов.

---

## 2. Решение

### 2.1 Разделяемый дедлайн вместо суммы независимых per-call таймаутов

**Принцип: один `deadlineAt` (epoch-ms), вычисленный ОДИН РАЗ в начале `reconcileInstanceEngineDrive` (`Date.now() + driveDeadlineMs`), протекает через ВСЕ пять точек вызова движкового порта в этой функции. Каждая точка вызова оборачивается общим helper'ом `callWithBudget(fn, deadlineAt)`, который:**

1. Вычисляет `remaining = deadlineAt - Date.now()`.
2. Если `remaining <= 0` — НЕ вызывает `fn` вовсе (не тратит впустую даже один HTTP round-trip) и немедленно возвращает сигнал бюджет-исчерпан.
3. Иначе — гонит `Promise.race([fn(), budgetTimeoutPromise(remaining)])`, где `budgetTimeoutPromise` — тот же паттерн, что уже есть в `flowable-client.ts` (`makeTimeoutPromise`/`TIMEOUT_SENTINEL`), но ЛОКАЛЬНЫЙ для `process-projection.ts` (не импортируется из `flowable-client.ts` — тот модуль не экспортирует эти internal-хелперы, и незачем плодить связность; `Promise.race`+`setTimeout`-сентинел — четыре строки, дублирование дешевле связывания модулей ради приватного хелпера, NF-6 соразмерность).
4. Если гонку выигрывает бюджет-таймаут — возвращает сигнал бюджет-исчерпан ДАЖЕ ЕСЛИ реальный вызов `fn()` в итоге сам вернулся бы успешно чуть позже (сам `fn()` — это уже вызов, обёрнутый в `withRetry` — может быть retry всё ещё крутится; промис от `fn()` не отменяется активно (нет `AbortController` в `FlowableClient`/`fetch`-вызовах — см. §3 B2), он просто перестаёт быть ожидаемым этой функцией; отработавший позже результат отбрасывается (нет побочных эффектов на СТОРОНЕ ПРОДУКТА от отброшенного промиса — только сам HTTP-вызов к движку долетит и завершится независимо от нашего ожидания, что и создаёт ИМЕННО ту неопределённость исхода, которую спека требует честно называть, §2.2 ниже).

**Почему НЕ AbortController в `fetch`:** `FlowableClient`/`withRetry` не принимают `AbortSignal` сегодня (интерфейс `FlowableClient`, `flowable-client.ts:274-385`, ни один метод его не берёт). Добавление `AbortSignal` через ВСЕ методы интерфейса + все внутренние `fetch`-вызовы + сигнатуру `withRetry` — это расширение публичного контракта клиента ради ОДНОГО шва (approve-drive), затрагивающее deploy/start/fetchAndLock/failTask и т.д., которые в этот бюджет не входят. Несоразмерно (см. §3, отвергнутая B1). `callWithBudget` — ПОВЕРХ существующих promise-возвращающих методов порта, ничего в `flowable-client.ts` не трогает.

### 2.2 Где именно вставляется `callWithBudget`

Пять точек в `reconcileInstanceEngineDrive` (порядок и структура не меняются, только вызовы оборачиваются):

| # | Строка (текущая) | Вызов | Обёртка |
|---|---|---|---|
| 1 | `1344` (внутри poll-цикла `for(;;)`) | `engine.getActiveUserTasks(args.instanceId)` | `callWithBudget(() => engine.getActiveUserTasks(args.instanceId), deadlineAt)` — **дополнительно**: poll-цикл САМ проверяет `deadlineAt` (не только `pollTimeoutMs`) как условие выхода — см. §2.3. |
| 2 | `1384` | `engine.completeUserTask(engineTaskId)` | `callWithBudget(() => engine.completeUserTask(engineTaskId), deadlineAt)` |
| 3 | `1404` | `engine.isInstanceEnded(args.instanceId)` (pre-ended) | `callWithBudget(...)` |
| 4 | `1421` | `engine.isInstanceEnded(args.instanceId)` (шаг 2) | `callWithBudget(...)` |
| 5 | `1451` | `engine.getActiveUserTasks(args.instanceId)` (шаг 3 fan-out) | `callWithBudget(...)` |

Каждая точка при получении бюджет-исчерпан сигнала возвращает из `reconcileInstanceEngineDrive`:
```
{ ok: false, code: "ENGINE_DRIVE_TIMEOUT", stage: <тот же дискриминатор, что уже помечает эту точку — "poll"|"complete"|"ended"|"next-tasks"> }
```
— то есть НЕ новая ветка control-flow, а третий возможный исход там, где сегодня уже есть два (`ok:true` / `ok:false, code:<engine-код>`). `EngineDriveResult`'s `ok:false` union уже несёт `stage`; `code` становится `string`-совместимым с добавлением константы `ENGINE_DRIVE_TIMEOUT` (аналогично `ENGINE_TASK_NOT_FOUND`/`AMBIGUOUS_ACTIVE_TASK` — экспортируемые string-константы, не enum, additive).

### 2.3 Poll-цикл: бюджет пересекается с существующим `pollTimeoutMs`, не заменяет его

Poll-цикл (`for(;;)` вокруг вызова #1) сегодня выходит по трём условиям: задача найдена (`break`), `tasksResult.tasks.length === 0` (нечего ждать), `Date.now() - pollStart >= pollTimeoutMs`. **Добавляется четвёртое условие: `Date.now() >= deadlineAt` (бюджет исчерпан) — проверяется НАРЯДУ с `pollTimeoutMs`, оба независимо ограничивают цикл (эффективный лимит цикла = `min(pollTimeoutMs, оставшийся бюджет)`).** Это не меняет семантику `pollTimeoutMs` (он остаётся отдельным «сколько ждать появления задачи в устойчивом движке») — бюджет добавляет ВНЕШНИЙ потолок поверх него, актуальный именно когда САМИ вызовы внутри цикла подвисают (F-2's находка — не то, что цикл крутится долго, а то, что ОДНА итерация может быть непропорционально долгой).

Когда poll-цикл прерывается по бюджету (а не по `pollTimeoutMs`/пустому списку), это неотличимо снаружи цикла от «engineTaskId остался null» — существующая логика ПОСЛЕ цикла (строка 1402: `if (!completed) { ... }`) уже обрабатывает `engineTaskId === null` через `isInstanceEnded`-проверку. **НО** если бюджет уже исчерпан на выходе из poll-цикла, ВЫЗОВ #3 (`isInstanceEnded` pre-ended) через `callWithBudget` немедленно вернёт бюджет-исчерпан (remaining ≤ 0) — то есть естественным образом деградирует в `{ok:false, code:"ENGINE_DRIVE_TIMEOUT", stage:"poll"}` без отдельной ветки: бюджет-исчерпание в poll-цикле НЕ требует специального `if` — оно каскадом протекает через уже существующий контрольный поток `callWithBudget`-обёрнутых точек 2/3/4/5, каждая из которых честно откажется стартовать при `remaining <= 0`. Это ключевое свойство дизайна: одна причина (`deadlineAt` истёк) → один унифицированный эффект в любой из пяти точек, без дублирования логики "что если бюджет кончился именно здесь".

### 2.4 Сигнатура и конфигурация

```ts
export async function reconcileInstanceEngineDrive(
  pool: pg.Pool,
  tenantId: string,
  engine: EngineDriveReconcilePort,
  args: {
    // ...существующие поля без изменений...
    readonly pollTimeoutMs?: number;
    readonly pollIntervalMs?: number;
    /** T-0591 (F-2): overall wall-clock budget (ms) for the ENTIRE post-approve
     *  drive path (poll + complete + both isInstanceEnded checks + fan-out).
     *  Default 10_000 — shares scale with pollTimeoutMs's existing default but is
     *  an INDEPENDENT ceiling that also bounds the individual engine-port calls
     *  withRetry can stretch to ~40s+ on a slow (not hard-down) engine. Ignored
     *  entirely on the reconcile-on-read (mirror) path in the sense that it still
     *  applies structurally but that path already tolerates slow/best-effort
     *  degradation (swallowed at the inbox.ts GET call site, T-0522). */
    readonly driveDeadlineMs?: number;
  },
): Promise<EngineDriveResult>
```

Дефолт: `args.driveDeadlineMs ?? 10_000`. `deadlineAt = Date.now() + driveDeadlineMs`, вычисляется В НАЧАЛЕ функции (рядом с существующим `nowMs`/`pollTimeoutMs`/`pollIntervalMs` resolve-блоком, строки 1312-1314).

**Env-override (композиция, `src/http/inbox.ts` вызывающий сайт):** опциональный `ENGINE_DRIVE_DEADLINE_MS` читается В КОМПОЗИЦИИ (там же, где уже читается `FLOWABLE_REST_APP_ADMIN_PASSWORD` и т.п. — `src/server.ts`/`inbox.ts` не читают `process.env` напрямую внутри `process-projection.ts`, конвенция T-0163 NF-1 env boundary уже действует для этого модуля — см. `ADR-T0571 §реконсайл` не вводит новых env-чтений внутри `process-projection.ts`). Практически: `inbox.ts` уже строит `writeDeps`/вызывает `reconcileInstanceEngineDrive` напрямую (не через `server.ts` per-request) — простейшее соразмерное место для чтения `process.env["ENGINE_DRIVE_DEADLINE_MS"]` — модуль-уровня константа в `inbox.ts` (аналогично тому, как `flowable-client.ts` сам читает свои timeout-дефолты В ФАБРИКЕ `makeFlowableClient`, а не при каждом вызове). Отсутствие переменной → компилируемый дефолт 10_000 (honest-degrade, симметрично `pollTimeoutMs`).

### 2.5 Ответ approve-хендлера (inbox.ts)

`ENGINE_DRIVE_TIMEOUT` — третий структурный код НАРЯДУ с `ENGINE_TASK_NOT_FOUND`/`AMBIGUOUS_ACTIVE_TASK` в проверке `isStructural` (`inbox.ts:1712-1713`):

```ts
const isStructural =
  result.code === ENGINE_TASK_NOT_FOUND ||
  result.code === AMBIGUOUS_ACTIVE_TASK ||
  result.code === ENGINE_DRIVE_TIMEOUT;
```

Ответ: **502** `{error:{code:"ENGINE_DRIVE_TIMEOUT", stage, engineCode:"ENGINE_DRIVE_TIMEOUT", instanceId}}` — идентичная форма существующим структурным веткам (envelope не меняется, `sendErrorEnvelope`-совместимая форма из T-0571 §2.3, amended F-1). `task.approved`/`applyStepResult` уже закоммичены ДО вызова reconcile (та же транзакционная граница T-0571 §2.3) — таймаут НЕ откатывает решение человека, ответ 502 честно говорит «записано, движковый шаг мог не успеть подтвердиться».

### 2.6 Семантика неопределённости на фронте (screen-inbox.jsx)

Добавляется запись в `ENGINE_DRIVE_ERROR_MESSAGE`:

```js
ENGINE_DRIVE_TIMEOUT: "Движок отвечает дольше обычного — действие могло примениться, обновите страницу, чтобы увидеть актуальное состояние",
```

Формулировка сознательно НЕ говорит «не выполнено» / «попробуйте ещё раз» (это исказило бы в сторону гарантированного провала — §2.2 NF-1 спеки: `completeUserTask` мог фактически пройти в движке несмотря на то, что продукт перестал ждать ответ). Совет — «обновите страницу», а не «повторите действие»: reconcile-on-read (T-0522, `GET /api/inbox` → `reconcileInboxEngineDriveOnRead`) на следующем чтении САМ обнаружит и спроецирует реальное состояние движка (завершён/продвинулся/не изменился) — это существующий, не новый в T-0591, механизм самоисцеления, который делает совет «обновите» технически осмысленным, а не пустой отговоркой.

### 2.7 Идемпотентность (не регрессирует T-0522/T-0571)

Ничего в write-пути не меняется: `callWithBudget` — чисто READ-стороннее ограничение ОЖИДАНИЯ ответа движка, не пишет и не блокирует запись событий. Повторный approve после `ENGINE_DRIVE_TIMEOUT` (человек нажал ещё раз, увидев ошибку) проходит ПО ТОЙ ЖЕ логике идемпотентности T-0522 (`completeUserTask` → `NOT_FOUND` если уже завершено движком реальным первым вызовом → `engine:"already"`, 200) — таймаут не создаёт нового класса дублирования, он просто может УЧАСТИТЬ обращение к уже-идемпотентному пути.

---

## 3. Отвергнутые альтернативы

| Опция | Почему нет |
|---|---|
| **B1. Пробросить `AbortController`/`AbortSignal` через весь `FlowableClient` (все методы) + `withRetry` + `fetch`** | Расширяет ПУБЛИЧНЫЙ интерфейс клиента ради одного шва (approve-drive); задевает deploy/start/fetchAndLock/failTask/pingEngine — им дедлайн approve не нужен. Несоразмерно (NF-6). `callWithBudget` поверх уже-promise-based порта достигает того же наблюдаемого эффекта (продукт перестаёт ждать) без расширения клиента. |
| **B2. Активно отменять in-flight `fetch` при истечении бюджета (реальный network abort)** | Требует B1 (AbortSignal до `fetch`). Не даёт дополнительной пользы для НАБЛЮДАЕМОГО контракта (approve всё равно отвечает 502 в срок) — экономит только серверные сокеты/ресурсы choros, не latency пользователя. Годная оптимизация РЕСУРСОВ, но не то, что спрашивает F-2 (latency approve); можно рассмотреть отдельно, если профилирование покажет утечку соединений — не блокирует эту задачу. |
| **B3. Уменьшить глобальные `timeoutMs`/`maxRetries` в `FlowableClientConfig`** | Меняет ВСЕ вызовы клиента (не только drive-путь) — blast radius шире шва (см. спека §3). |
| **B4. `pollTimeoutMs` уменьшить достаточно, чтобы «естественно» ограничить худший случай** | Не работает: находка F-2 ровно в том, что `pollTimeoutMs` не прерывает уже НАЧАТЫЙ вызов внутри итерации — уменьшение его значения не сокращает время ОДНОГО зависшего `withRetry`-вызова (`timeoutMs × попытки` не зависит от `pollTimeoutMs`). Нужен независимый потолок поверх каждого вызова, не только между итерациями. |
| **B5. Заменить весь post-approve путь на асинхронный (вернуть 202 + polling статуса с фронта)** | Отвергнуто уже в ADR-T0571 §3 (B4/B5 там) — синхронность завершения ЯВНО выбранное решение (устраняет ложный 200). Переоткрывать эту развилку — не задача F-2 (латентность худшего случая), а откат T-0571; вне скоупа. |
| **B6. Ждать таймаут-Promise через `setTimeout` БЕЗ `Promise.race` (напр. явный флаг + периодическая проверка)** | `Promise.race` — уже установленный в этой же кодовой базе паттерн (`flowable-client.ts` `makeTimeoutPromise`/`TIMEOUT_SENTINEL`, `pingEngine`) для ровно этой задачи (гонка операции против таймера); переизобретать иначе — не соразмерно (NF-6). |

---

## 4. Fitness-функции

| id | rule | ci_check |
|---|---|---|
| **FF-1** | `reconcileInstanceEngineDrive` при исчерпанном `driveDeadlineMs` возвращает `{ok:false, code:"ENGINE_DRIVE_TIMEOUT", stage}` в пределах wall-clock времени, ограниченного заданным бюджетом (не суммой per-call `withRetry` таймаутов). | `vitest run src/__tests__/inbox-engine-drive.test.ts -t "drive-deadline"` — мок-порт с искусственной задержкой (напр. `await new Promise(r=>setTimeout(r, N))` внутри мок-метода) БОЛЬШЕ малого тестового `driveDeadlineMs`; тест измеряет `Date.now()` до/после и assert-ит верхнюю границу (AC-1). |
| **FF-2** | Approve-хендлер отвечает 502 `{error:{code:"ENGINE_DRIVE_TIMEOUT", stage, instanceId}}` при таймауте reconcile — та же envelope, что прочие структурные 502. | `vitest run src/__tests__/inbox-engine-drive.test.ts -t "ENGINE_DRIVE_TIMEOUT"` (AC-2). |
| **FF-3** | Успешный типовой путь (движок отвечает быстро) не регрессирует — 200 как в T-0571, без искусственной задержки теста. | Существующие тесты `describe("T-0571 approve handler...")` остаются зелёными без изменения ожиданий (AC-3/AC-6). |
| **FF-4** | Retry внутри одного под-вызова не выпилен бюджетом — транзиентная одна ошибка + успех второй попытки в пределах оставшегося бюджета всё ещё даёт успех. | `vitest run src/__tests__/inbox-engine-drive.test.ts -t "retry-within-budget"` (AC-4). |
| **FF-5** | Идемпотентность T-0522/T-0571 не регрессирует. | `vitest run src/__tests__/inbox-engine-drive.test.ts -t "idempotent"` (AC-6). |
| **FF-6 (анти-кейс, D-064)** | Diff не добавляет в `src/` новых кейс-специфичных строковых литералов сверх baseline. | `git diff origin/main...HEAD -- 'src/**' \| grep '^+' \| grep -Ev '^\+\+\+' \| grep -E '"(soglasovanie\|role-approver\|Согласование\|Закупки\|task-approve)"'` → пусто = pass (AC-7). |

---

## 5. Совместимость public-поверхности

- `reconcileInstanceEngineDrive`'s `args` получает НОВОЕ опциональное поле `driveDeadlineMs?: number` — additive, дефолт сохраняет текущее поведение количественно иначе (см. ниже), но КАЧЕСТВЕННО совместимо: здоровый движок (типовой ответ — миллисекунды-сотни мс) укладывается в дефолтный бюджет 10с так же, как укладывался бы раньше в `pollTimeoutMs=10с`; НАБЛЮДАЕМАЯ разница — только для ДЕГРАДИРОВАВШЕГО движка (ранее ~40с+ подвисания на непрозрачном пути → теперь честные ~10с и явный 502).
- `EngineDriveResult`'s `ok:false`-ветка получает новую возможную строку `code: "ENGINE_DRIVE_TIMEOUT"` (экспортируемая константа рядом с `ENGINE_TASK_NOT_FOUND`/`AMBIGUOUS_ACTIVE_TASK`) — additive (union уже был `string`-широким по факту, т.к. `code` в `ok:false` ветке типизирован из `engine`-кодов, не закрытым enum).
- `inbox.ts` `isStructural`-проверка расширяется одним `||` — уже существующий паттерн (T-0571 уже вводила два кода тем же способом).
- `screen-inbox.jsx` `ENGINE_DRIVE_ERROR_MESSAGE` получает одну новую запись — additive объект-литерал, тот же паттерн, что T-0571 уже установила для трёх существующих кодов.
- Никаких изменений `FlowableClient` интерфейса, `FlowableClientConfig`, `withRetry` — нулевой blast radius на любой ДРУГОЙ вызывающий код клиента (deploy/start/fetchAndLock/failTask/getMessageCatchWaits/correlateMessage/pingEngine).
- Модель событий БД не меняется — миграции нет.

---

## 6. Трассировка AC → покрытие

| AC | covered_by |
|---|---|
| AC-1 (таймаут → честный код в пределах бюджета) | §2.1-2.3 механизм; FF-1 |
| AC-2 (502 envelope) | §2.5; FF-2 |
| AC-3 (успешный путь не регрессирует) | §2.4 дефолт; FF-3 |
| AC-4 (retry не выпилен) | §2.1 п.3 (`fn()` — уже `withRetry`-обёрнутый вызов, не заменяется); FF-4 |
| AC-5 (нежаргонное сообщение) | §2.6; manual review |
| AC-6 (T-0571/T-0522 не регрессируют) | §2.7; FF-3/FF-5 |
| AC-7 (анти-кейс) | §2.4 (нет новых кейс-строк); FF-6 |

---

## 7. Границы

Design-only: продуктовый код (`process-projection.ts`/`inbox.ts`/`screen-inbox.jsx`) НЕ меняется здесь — отдельный BUILD-таск. Вне скоупа (спека §5): активная отмена in-flight `fetch` через `AbortController` (B2, возможный отдельный ресурсно-ориентированный follow-up, не latency-контракт); durable outbox (O6 ADR-T0571); UI progress-индикатор с обратным отсчётом.

**Escalation:** нет. F-2 — nit-severity follow-up с уже согласованным направлением решения в самой задаче (deadline-budget поверх withRetry, не его замена); открытых продуктовых/денежных/секретных развилок нет.
