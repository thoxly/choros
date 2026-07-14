# ADR T-0278 — ТЭЛ deploy-acceptance click-through

> Фаза DESIGN. Architect. Вход = `docs/specs/T-0278.spec.md` + `.spec.contract.json`
> (AC-1..AC-10, status ready). Выход-контракт = `schemas/adr.schema.json` + эта
> декомпозиция для оркестратора. Реализацию НЕ пишем (зона coder).

## 0. Резюме решения (одним абзацем)

Закрываем «дыру деплоя» тонким вертикальным срезом: **(а)** один канонический
линейный ТЭЛ как deployable BPMN process-definition (`config/flowable/processes/
tel-linear.bpmn20.xml`, ключ `telLinear`), детерминированно деплоимый тем же
REST-механизмом, что `choros-smoke` / `customer-onboarding`; **(б)** один
write-роут `POST /api/processes/start` поверх существующего `makeFlowableClient().
startInstance`, tenant-scoped тем же `withTenantTx`+RLS+`x-tenant-id`, что
`process-defs.ts`; **(в)** проекция engine→экраны через тонкий слой, который
показывает реальный инстанс и его user-task'и на тех же processes/inbox-экранах
(сейчас они seed-only — это корневой шов M4); **(г)** один deploy-acceptance гейт
на **Playwright headless** против `docker compose` стека с собранным `web/dist`,
который браузером проходит U1→U5 и **падает фейл-чест**, если хоть один шаг не
кликабелен. Курицу-яйцо разруливаем **вариантом (а): гейт вводится
non-blocking/informational, и флипается в `required` отдельной финальной задачей
T-0278-G ПОСЛЕ того, как весь вайринг зелёный** — dev никогда не видит красный
required-гейт (D-056).

Соразмерность (ось 5): тонкое ядро. Один процесс, один happy-path, один write-роут,
один новый dev-dep (Playwright). Moat/defer/degraded/refusal-ветки, E8/E2 —
out_of_scope (O1–O6), не тянем.

---

## 1. Контекст из кода (грунт, подтверждён чтением)

| Факт | Источник в коде | Следствие для дизайна |
|---|---|---|
| start-instance роута НЕТ | `src/http/processes.ts` — только GET ×2 | Новый POST-роут (задача B) |
| Кнопка запуска `disabled` | `web/src/app-shell/shell.jsx:152-160` | Включить + launch-modal (задача C) |
| Flowable bridge готов | `src/core/flowable-client.ts` — `startInstance(key, vars)`, `deployBpmn` | Переиспользуем, НЕ изобретаем |
| Tenant-scoping паттерн | `src/http/process-defs.ts` — `withTenantTx`+`SET LOCAL choros.tenant_id`+RLS, `x-tenant-id` header, `x-dev-user` actor | Контракт start-роута следует ему дословно |
| Композиционный корень | `src/server.ts:321-331` — `makeFlowableClient` из env при наличии `grantsPool`+пароля | Сюда вешаем `registerStartInstanceRoute` |
| Канонического ТЭЛ BPMN НЕТ | `find *.bpmn` → только smoke + customer-onboarding | Новый BPMN (задача A); seed = TS `seed/demo/tel-scenario.ts` (5 шагов, роли) |
| **Инбокс/процессы/формы — SEED, не движок** | `src/http/inbox.ts` (PROCESSES_SEED, defer-проекция из audit_event), `processes.ts` (pack-file), customer-onboarding-smoke: «no HTTP inbox endpoint yet» | **Корневой шов M4** — старт должен породить инстанс/таски, видимые ТЕМИ ЖЕ экранами (задача D) |
| Approve/transition роута НЕТ | grep `register("POST"` → только `/external-task/:id/complete` | AC-5 «Согласовать» = новый card-action роут (задача D) |
| Claim-роут есть | `src/http/inbox.ts:429` `POST /api/inbox/:id/claim`, pool→mine, 403 NOT_ELIGIBLE | AC-4 переиспользует |
| Form-submit есть | `src/http/forms.ts` `POST /api/forms/:formId/submit`, серверная валидация, 400 VALIDATION | AC-2 переиспользует |
| Repo zero-dep | `package.json` deps=[ajv,pg], web=[vite,react,react-router] | Playwright = заметная dev-dep — обоснование в §4 |
| Compose стек есть | `docker-compose.yml` postgres:55432+keycloak+flowable:8082+choros:3000, Dockerfile собирает `web/dist` через vite build | NF1 «эквивалент dev» выполним без нового compose |
| vitest worktree-исключение | `vitest.config.js` exclude `.claude/**`,`../choros-wt/**`,`web/**` | NF2 — паттерн переиспользуем для Playwright testDir |
| Seed CLI идемпотентен | `seed/cli.ts apply/reset`, `seed/importer.ts` через public API (не прямой PG) | NF3 — ТЭЛ-seed расширяет тот же путь |

**Главный архитектурный вывод.** Самый дорогой кусок — НЕ роут и НЕ BPMN, а
**шов «движок ↔ экраны» (M4)**: сегодня экраны читают seed/pack/audit-проекцию, а
не runtime-состояние Flowable. Чтобы U1→U5 был *кликабельным сквозным путём в
одном инстансе*, проекция должна показывать реальную user-task стартованного
инстанса. Это серийный шов, на котором сходятся задачи A/B/D — его контракт
замораживаем ДО параллельного BUILD (orchestrator-правило 9).

---

## 2. Решение по разделам ТЗ

### 2.1. Канонический ТЭЛ BPMN (M1)

- **Где живёт:** `config/flowable/processes/tel-linear.bpmn20.xml` (рядом с
  `choros-smoke.bpmn20.xml` — тот же REST-deploy-only паттерн, без filesystem
  auto-deploy). НЕ в seed-pack: pack = display/actor-плоскость (org/grants/cards),
  а BPMN = engine-артефакт, деплоится через `deployBpmn`, как customer-onboarding.
- **Ключ процесса:** `telLinear` (camelCase, как `chorosSmoke`; Flowable
  process-key конвенция).
- **Структура (строго линейная, без gateway/cycle/refuse — NF O3):**
  ```
  start
   → userTask "Подача заявки"        (candidateGroups="role-initiator")   [U1/U2]
   → serviceTask "Триаж"  external topic="tel-intake"                      [U3 агентский, DORMANT-deterministic]
   → userTask "Согласование" (candidateGroups="role-approver")            [U4]
   → end "Завершено"                                                       [U5]
  ```
  Роли узлов берём из `seed/demo/tel-scenario.ts`: initiator=`e-orlov`
  (role-initiator), approver=`e-larina` (role-approver/fin-ctrl). Intake-слот =
  `role-intake-agent` (agent_card DORMANT, llm_* NULL → ZERO платных LLM, NF3/O5).
  Триаж как external-task проходит детерминированно тем же bridge-механизмом, что
  smoke (`fetchAndLock`/`completeTask`); на day-1 — детерминированный stub-worker,
  НЕ блокирует переход к U4 (spec §4 прим.).
- **Маппинг на seed/demo/tel-scenario.ts:** BPMN — это runtime-субстрат уже
  ратифицированного 5-шагового пути. S1+S2→userTask «Подача» (форма заявки,
  `DEMO_DEAL` сумма 5.5M); S3→serviceTask «Триаж» (intake slot); S4→userTask
  «Согласование» (e-larina, card-action approve); S5→end + audit. Линейный путь
  T-0218 — без S3-legal-precheck moat-ветки (O4) в этом гейте: legal-precheck
  мотор T-0233 либо проходит детерминированно, либо не на критическом пути к U4.
- **Детерминированный deploy:** новый скрипт `ci/checks/flowable/tel-linear-
  smoke.sh` (зеркало `customer-onboarding-smoke.sh`): `deployBpmn`→201,
  `startInstance(telLinear)`→201. Подключается в `fitness:flowable`.

### 2.2. start-instance контракт (FROZEN — шов B↔C↔E)

Это **frozen-контракт** между задачей роута (B), задачей UI-кнопки (C) и задачей
E2E (E). Заморожен ДО параллельного BUILD.

```
POST /api/processes/start
Headers:
  x-dev-user:  <employee-slug>      # актор (dev auth mode), как process-defs.ts
  x-tenant-id: <uuid>               # tenant scope, как process-defs.ts
  Content-Type: application/json
Body:
  {
    "processKey": "telLinear",      # string, non-empty (валидируется)
    "variables":  { ... }           # optional Record<string,unknown>; форма заявки = отдельный E9 submit, НЕ в старте
  }
Responses:
  201 { "instanceId": "<flowable-id>", "processKey": "telLinear", "tenantId": "<uuid>" }
  400 VALIDATION        — processKey пуст / тело не объект / tenantId не UUID
  401 UNAUTHENTICATED   — нет x-dev-user
  403 NOT_ELIGIBLE      — актор не вправе стартовать процесс в этом тенанте (PDP)
  502 ENGINE_ERROR      — startInstance вернул не-ok (ENGINE_UNAVAILABLE/...)
```

- **Как ходит в Flowable:** роут → `flowable.startInstance(processKey, variables)`
  (`src/core/flowable-client.ts`, уже есть `assertVariableValue` guard FF-G3). Тот
  же injected-client из композиционного корня (`server.ts`), env-чтение только
  там (NF-1, no-env-in-core).
- **Tenant-scoping (AC-9/NF4):** `extractTenantId(req)` + `withTenantTx(pool,
  tenantId, …)` ДО вызова движка; запись «инстанс↔тенант» в проекционную таблицу
  (см. §2.3) под `SET LOCAL choros.tenant_id` + FORCE RLS. Кросс-тенант-старт →
  RLS не даст записать/прочитать чужой инстанс → инстанс в чужом тенанте не виден
  и не создаётся в проекции (AC-9). Дословно паттерн `process-defs.ts`.
- **Грант/авторизация:** старт = `exec`/`invoke` грант на ресурс `process` со
  scope тенанта; PDP-deny → 403 NOT_ELIGIBLE (переиспользуем grant-resolver, как
  card-action). Минимально: проверка членства актора в тенанте через
  `resolveActorTenant`; полный PDP — узкий, не раздуваем.
- **Why this seam frozen:** изменение пути/тела/кодов после старта B уронит C
  (fetch-контракт кнопки) и E (Playwright-ассерты) → merge-разрыв. Любая правка
  контракта — через re-freeze + ре-нотификация B/C/E.

### 2.3. Шов «движок ↔ экраны» (M4 — FROZEN, серийный)

Корневой риск. Сегодня processes/inbox — seed. Чтобы один инстанс был кликабелен
сквозь U1→U5, нужен **тонкий read-проекционный слой**, читающий runtime-состояние
стартованного инстанса (Flowable user-tasks) и отдающий его теми же экранами.

**Решение (соразмерное):** не переписываем processes/inbox на live-engine целиком
(это E2-масштаб). Вместо этого — **аддитивная проекция стартованных инстансов**:

- Новая таблица проекции `tel_instance` НЕ заводится без нужды; используем
  **существующий append-only механизм**: старт пишет `audit_event`
  (`process.started`), а inbox уже умеет проецировать defer-задачи из `audit_event`
  (`listDeferredInboxTasks`, `src/http/inbox.ts`). Расширяем ту же проекцию на
  user-task'и стартованного ТЭЛ-инстанса: первая user-task инициатора (U2-форма)
  и pool-задача согласующего (U4) появляются в inbox через ту же
  audit-проекционную дорожку, адресованные РОЛИ (candidateGroups → role).
- `GET /api/processes` дополняется проекцией стартованных инстансов поверх
  pack-данных (read-only merge, как inbox merge seed+defer): стартованный инстанс
  виден в списке (AC-1) и в статусе done после approve (AC-6).
- **Card-action «Согласовать» (AC-5):** новый `POST /api/inbox/:id/action` с телом
  `{ action: "approve" }` → проверка гранта `approve` (PDP) → запись
  `audit_event(task.approved + transition)` → проекция продвигает инстанс к end
  (status done). Минимальный card-action, узкий scope (card-action-isolation.sh
  fitness уже существует — переиспользуем его границы).

**Frozen-контракт проекции (шов A↔B↔D):** форма audit-событий старта/approve +
поля проекции user-task (id, role, inst, step, status) фиксируются в ADR ДО BUILD,
т.к. на них сходятся BPMN-роли (A), запись старта (B) и чтение/продвижение (D).

> Замечание о соразмерности: эта проекция — НЕ полноценная engine-sync-шина. Это
> тонкий honest-срез: реальный инстанс реально стартует в Flowable (NF1), а экраны
> показывают его через уже существующую append-only audit-дорожку. Полный
> live-engine inbox — отдельный пост-MVP scope (как E2/E8, O1/O2).

### 2.4. Deploy-acceptance E2E harness + CI-job (M5)

- **Инструмент: Playwright (headless Chromium).** Обоснование vs альтернативы — §4.
- **Окружение (NF1, D-056):** `docker compose up` существующего `docker-compose.yml`
  (postgres+keycloak+flowable+choros). `choros` собирается из Dockerfile, который
  УЖЕ делает `vite build` → `web/dist` (web-builder stage). НЕ моки, не in-memory —
  Playwright бьёт в `http://localhost:3000` (реальный собранный SPA + реальный HTTP
  + реальный движок). Новый compose НЕ нужен.
- **Детерминированный seed (NF3):** перед прогоном — `seed/cli apply --tenant
  <demo> --pack <tel>` (идемпотентно, через public API, не прямой PG) +
  deployBpmn(tel-linear) (через `tel-linear-smoke.sh` или dedicated bootstrap).
  agent_card DORMANT (llm_* NULL) → ZERO платных LLM (AC-10). Повторный прогон =
  no-op (apply идемпотентен; deploy — версионируется движком, idempotent-by-key).
- **Изоляция прогона (NF2/AC-10):** Playwright `testDir: e2e/`, `testMatch:
  **/*.e2e.ts`; конфиг ЯВНО исключает `.claude/**`, `../choros-wt/**`, `web/**`,
  `node_modules/**` (зеркало vitest.config.js). E2E-тесты живут ТОЛЬКО в `e2e/` на
  чекауте гейта.
- **Сценарий (один линейный прогон, AC-7):** U1 (клик «Запустить» → 201 + инстанс
  в списке) → U2 (форма submit → 200 + recordId; невалид → 400) → U3→U4 (задача
  согласования в пуле у роли) → U4-claim (POST claim 200; чужая роль 403) → U4-
  approve (card-action → transition + audit) → U5 (инстанс done + цепочка в аудите).
- **Negative / фейл-чест (AC-8, NF5):** отдельный negative-spec, который УТВЕРЖДАЕТ
  красный, если кнопка `disabled`/отсутствует, start-роут не-2xx, инстанс не создан/
  не продвинулся/не завершён. Реализуется как тест, который ОЖИДАЕТ провал при
  сломанном аффордансе (assert-on-absence), плюс CI-самотест скрипта-обёртки: при
  поднятом стенде без вайринга гейт ДОЛЖЕН вернуть exit≠0.
- **CI-job:** новый job `deploy-acceptance` в `.github/workflows/ci.yml`:
  `docker compose up -d --wait` → seed+deploy → `npx playwright test` →
  `docker compose down`. Команда npm: `npm run acceptance:tel`.
- **runtime_target:** локально `docker compose` на машине разработчика (и в CI-
  раннере с Docker). Публичный демо-сервер (T-0142) — ОТДЕЛЬНЫЙ GT-4, НЕ сюда.

### 2.5. Курица-яйцо (высоколеверажное — РЕШЕНО, вариант (а))

**Проблема:** если ввести `deploy-acceptance` как `required` CI-job сразу, он будет
КРАСНЫМ пока вайринг (A/B/C/D) не готов → заблокирует мерж ВСЕХ задач в dev
(D-056: «зелёный на ветке == зелёный на dev»).

**Выбор: (а) поэтапный ввод — non-blocking → required-flip отдельной задачей.**

- Задачи A/B/C/D/E мержатся в dev по мере готовности. На этом этапе job
  `deploy-acceptance` либо отсутствует, либо помечен `continue-on-error: true`
  (informational): он МОЖЕТ быть красным, но НЕ блокирует мерж — dev никогда не
  видит required-красный.
- Финальная задача **T-0278-G (flip-to-required)** убирает `continue-on-error`
  (делает job блокирующим) ТОЛЬКО ПОСЛЕ того, как локальный прогон
  `acceptance:tel` зелёный на полном вайринге. `depends_on` = [A,B,C,D,E].
- Это сохраняет D-056 инвариант: в момент, когда гейт становится `required`, он уже
  зелёный → dev никогда не видит красный required-гейт.

**Почему НЕ (б) (один большой стек):** один атомарный merge всего вайринга+гейта
противоречит ratified «до 6 в параллель» и orchestrator fan-out; крупный стек =
большой merge-риск, теряем параллелизм. Вариант (а) сохраняет параллелизм A–E и
изолирует риск красного гейта в один тонкий flip (T-0278-G), который сам по себе
не пишет продукт-код.

---

## 3. Декомпозиция на параллельные BUILD-задачи (главный выход)

Граф (→ = depends_on). **FROZEN-контракты §2.2 (start-API) и §2.3 (проекция/audit-
форма) объявлены ДО старта параллельного BUILD.**

```
        ┌──────────────────────────────────────────────┐
        │  FROZEN SEAMS (этот ADR, до BUILD):           │
        │   • start-API контракт (§2.2)                 │
        │   • engine→screen проекция + audit-форма (§2.3)│
        └──────────────────────────────────────────────┘
                          │
   ┌──────────┬───────────┼───────────┬──────────────┐
   │          │           │           │              │
 A (BPMN)   B (роут)    C (UI)    D (проекция+    (parallel-safe друг к другу
   │          │           │        approve)        на разных файлах; все читают
   │          │           │           │            frozen-контракт, не друг друга)
   └──────────┴─────┬─────┴───────────┘
                    │
              E (Playwright harness + seed-bootstrap + negative)
              depends_on: A,B,C,D (нужен живой вайринг для зелёного прогона;
                          сам код harness можно писать против frozen-контракта
                          параллельно, но ЗЕЛЁНЫМ станет после A–D)
                    │
              T-0278-G (flip job → required)
              depends_on: A,B,C,D,E  (serialized, последняя)
```

**Параллельность:** A, B, C, D — parallel-safe (разные файлы, общий шов заморожен) →
до 4 в параллель. E пишется параллельно (против контракта), но зелёным/мержабельным
становится после A–D. G — строго последняя, serialized.

**Файлы по задачам (зоны записи — взаимно непересекающиеся, кроме явного
frozen-шва, который НИКТО не правит после заморозки):**

| # | Задача | task_type | Пишет файлы | depends_on | parallel |
|---|---|---|---|---|---|
| A | Канонический ТЭЛ BPMN + deploy-smoke | standard_code | `config/flowable/processes/tel-linear.bpmn20.xml`, `ci/checks/flowable/tel-linear-smoke.sh`, package.json (добавить в `fitness:flowable`) | — (читает §2.1,§2.3 роли) | parallel-safe |
| B | start-instance роут | standard_code | `src/http/processes.ts` (добавить POST; GET не трогать), регистрация в `src/server.ts` | — (читает §2.2) | parallel-safe |
| C | UI launch-кнопка + modal | standard_code | `web/src/app-shell/shell.jsx` (включить кнопку), `web/src/screens/screen-processes.jsx` (кнопка/modal запуска) | — (читает §2.2 fetch-контракт) | parallel-safe |
| D | engine→screen проекция + card-action approve | standard_code | `src/http/inbox.ts` (action-роут + проекция user-task'ей старта), `src/http/processes.ts`-проекция merge — **CAUTION: общий файл с B** → см. ниже | B (на shared `processes.ts`) | **serialized-on-shared-seam с B** |
| E | Playwright harness + seed-bootstrap + negative | tests | `e2e/tel-linear.e2e.ts`, `e2e/tel-linear-negative.e2e.ts`, `playwright.config.ts`, `e2e/bootstrap-tel.ts` (seed+deploy), package.json (`acceptance:tel`, devDep playwright) | A,B,C,D | parallel-write, green-after-ABCD |
| G | Flip job → required | devops | `.github/workflows/ci.yml` (убрать continue-on-error / добавить required job) | A,B,C,D,E | serialized (last) |

**Уточнение по shared-seam B↔D (`src/http/processes.ts`):** B добавляет POST-роут;
D добавляет read-проекцию старта в GET. Оба правят `processes.ts`. Чтобы не было
merge-конфликта: **сериализуем D после B** (D depends_on B), ИЛИ выносим проекцию
старта в новый модуль `src/http/process-projection.ts`, импортируемый и в B-старте
(запись) и в GET (чтение). **Рекомендация:** вынести в `process-projection.ts`
(новый файл, никем не правится) → тогда B пишет только POST+вызов проекции, D пишет
`process-projection.ts`+inbox-проекцию+action-роут, и `processes.ts` GET правит
только B минимально. Это делает B и D parallel-safe. Оркестратор выбирает: либо
serialized (проще), либо extract-module (параллельнее). ADR санкционирует оба;
extract-module предпочтителен для параллелизма.

**Итог параллелизма:** при extract-module → A,B,C,D в параллель (4), затем E,
затем G. При serialized → A,B,C параллельно (3) + D после B, затем E, затем G.

---

## 4. Решение по инструменту E2E (Playwright vs альтернативы)

| Опция | Вердикт | Почему |
|---|---|---|
| **Playwright (headless Chromium)** | **ВЫБРАНО** | Один dev-dep, headless-CI-native, авто-ожидания (устраняет flaky), trace на фейле (фейл-чест диагностируем), `testDir`/`testMatch`/exclude — прямой аналог vitest-исключения worktree (NF2). Сетевые ассерты (статус start-роута) из коробки. |
| Cypress | отвергнут | Тяжелее в headless-CI (Electron-bundle), хуже мультидоменная/сетевая интроспекция, больше footprint для zero-dep-репо. |
| Selenium/WebDriver | отвергнут | Требует отдельный driver+grid, многословный, не headless-native; больше инфра-движущихся частей. |
| Свой fetch-only «E2E» (без браузера) | отвергнут | НЕ доказывает КЛИКАБЕЛЬНОСТЬ (кнопка enabled, SPA-роутинг, форма рендерится) — а именно это корень дефекта (read-only витрина). Нарушает суть AC-1/F8. |

Цена (zero-dep-репо): Playwright — **dev-dependency только в `e2e`-контуре** и
запускается ТОЛЬКО в `deploy-acceptance` CI-job, НЕ в основном `ci`-job (tsc/eslint/
fitness/vitest остаются zero-runtime-dep). Браузер-бинарь ставится `npx playwright
install --with-deps chromium` в CI-шаге. Это соразмерно: единственный честный
способ доказать клик.

---

## 5. Fitness-функции (ось 6 — обязательно)

Каждое нарушаемое решение → исполнимое CI-правило.

| ID | Правило | ci_check (команда/скрипт) |
|---|---|---|
| FF-1 | Канонический ТЭЛ BPMN деплоится и стартует в живом движке (M1, AC-1) | `bash ci/checks/flowable/tel-linear-smoke.sh` — deployBpmn(tel-linear)→201, startInstance(telLinear)→201; добавлен в `fitness:flowable` |
| FF-2 | start-instance tenant-scoped: кросс-тенант-старт отклонён, инстанс в чужом тенанте не создаётся (AC-9, NF4) | vitest в `ci/checks/db/` (live PG): старт под tenant A, чтение под tenant B → пусто; старт с чужим x-tenant-id → 403/RLS-deny. `npm run fitness:db` |
| FF-3 | Гейт гонит против реального стека (не моки/in-memory), web из `vite build` (NF1, D-056) | `ci/checks/acceptance/no-mock-stack.sh` — grep negative: e2e-конфиг baseURL=localhost:3000 (compose), запрещён `MOCK`/`in-memory`/stub-fallback в e2e; проверка что Dockerfile собирает web/dist |
| FF-4 | Seed канонического ТЭЛ идемпотентен, без платных LLM (NF3, AC-10) | `ci/checks/acceptance/seed-idempotent.sh` — двойной `seed apply` → второй no-op (diff пуст); grep agent_card llm_* NULL (переиспользует `budget-dormancy.sh`/`agent-instruction-runtime-dormant.sh` границы) |
| FF-5 | Фейл-чест: при сломанном аффордансе гейт ОБЯЗАН падать red (AC-8, NF5) | `ci/checks/acceptance/fail-honest.sh --self-test` — поднять стенд с disabled-кнопкой/без start-роута → `acceptance:tel` exit≠0 (самотест отрицательного спека) |
| FF-6 | E2E-прогон изолирован от worktree (NF2, AC-10) | `ci/checks/acceptance/e2e-scope.sh` — playwright.config testDir=`e2e/`, exclude содержит `.claude/**`,`../choros-wt/**`,`web/**`,`node_modules/**` (зеркало vitest.config.js); + `--self-test` |
| FF-7 | start-instance — ЕДИНСТВЕННЫЙ новый write-путь к движку из UI; GET-роуты не мутируют (граница read/write) | `ci/checks/acceptance/start-route-isolation.sh` — POST start вызывает `flowable.startInstance` через injected client (no env in core); GET processes не вызывает движок |
| FF-8 | card-action approve узкий: проверяет грант `approve` + пишет audit; не широкий мутатор (AC-5) | переиспользовать `ci/checks/card-action-isolation.sh` + `card-action-broad-scope.sh` (уже существуют) на новый action-роут |

Минимум схемы (≥1) выполнен с запасом; FF-2/FF-5 — ядро честности гейта.

---

## 6. Трассировка AC → дизайн

| AC | Покрыто в дизайне |
|---|---|
| AC-1 (U1 запуск, кнопка→201→инстанс виден) | §2.2 start-роут + §2.4 UI(C) + §2.3 проекция processes; FF-1, E2E U1 |
| AC-2 (U2 форма submit 200 / невалид 400) | существующий `POST /api/forms/:formId/submit` (forms.ts), E2E U2; §1 |
| AC-3 (задача согласования в пуле у роли) | §2.3 проекция user-task candidateGroups→role в inbox; E2E U3→U4 |
| AC-4 (claim 200 / чужая роль 403) | существующий `POST /api/inbox/:id/claim` (inbox.ts:429), E2E claim |
| AC-5 (card-action «Согласовать»→transition+грант+audit) | §2.3 новый `POST /api/inbox/:id/action {approve}`; FF-8 |
| AC-6 (инстанс done, результат+цепочка в аудите) | §2.3 проекция done + audit-цепочка; §2.1 BPMN end; E2E U5 |
| AC-7 (единый скрипт, реальный стек, один линейный прогон) | §2.4 harness(E) + `acceptance:tel` + CI-job; FF-3 |
| AC-8 (фейл-чест negative) | §2.4 negative-spec + §2.5 порядок; FF-5 |
| AC-9 (tenant-scoping старта) | §2.2 withTenantTx+RLS; FF-2 |
| AC-10 (изоляция прогона + идемпотентный seed + ZERO LLM) | §2.4 NF2/NF3; FF-4, FF-6 |

---

## 7. Отвергнутые альтернативы

1. **Переписать processes/inbox на live-engine целиком** — отвергнуто:
   несоразмерно (ось 5), это E2-масштаб; тонкая аддитивная audit-проекция
   стартованного инстанса достаточна для честного линейного click-through.
2. **Курица-яйцо вариант (б) (один большой стек merge)** — отвергнуто: губит
   параллелизм A–E и raises merge-риск; вариант (а) изолирует риск в тонкий
   flip-job.
3. **fetch-only «E2E» без браузера** — отвергнуто: не доказывает кликабельность
   (корень дефекта = read-only витрина), нарушает суть F8/AC-1.
4. **Cypress/Selenium** — §4 (footprint/headless-CI/сетевая интроспекция).
5. **ТЭЛ BPMN в seed-pack** — отвергнуто: pack = display/actor-плоскость; BPMN —
   engine-артефакт, деплоится через `deployBpmn` (как customer-onboarding), иначе
   ломается single-source seed-инвариант.
6. **Новая таблица `tel_instance`** — отвергнуто (по умолчанию): defer-no-new-table
   норма D-061; переиспользуем append-only `audit_event`-проекцию. (Если live-DB-
   тест покажет, что audit-проекции недостаточно для done-статуса — узкая таблица
   допустима, но это решение coder'а на фактах, с обоснованием.)

## 8. Эскалация

Пусто. Направление ратифицировано (линейный ТЭЛ = эталон приёмки); развилки —
инженерные («как»), зона architect/D-061: выбор инструмента E2E, разруливание
курицы-яйца (вариант а), шов engine↔screen через audit-проекцию. Ничего из этого
не меняет направление продукта, деньги, секреты или необратимое. start-instance
контракт и порядок ввода гейта — высоколеверажны технически, но решены здесь и
заморожены; продуктовая петля не требуется.
