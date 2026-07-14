# ADR: T-0117 — Flowable OSS-граница (спайк-харнесс)

Статус: **ready** (DESIGN; вход для BUILD)
Тип: `architecture` (спайк-харнесс, не продуктовый код)
Вход: `docs/specs/T-0117-flowable-oss-spike.spec.md` (15 AC) + ратифицированный
`docs/design/stack-and-fleet-ops.md` §1 «Открытые риски» п.1.
Выход спайка (фаза BUILD): знание + вердикт-аддендум, ратифицирует фаундер.

> Этот ADR проектирует **как устроен спайк-харнесс** (топология, генераторы,
> методика измерения, артефакты, fitness-функции фазы BUILD). Сами числа спайка —
> результат BUILD, не этого ADR.

---

## 1. Решение (одним абзацем)

Спайк-харнесс — изолированный каталог `spikes/flowable-oss/`: **два независимых
docker-compose-стека** (`flowable` и `operaton`), каждый = движок-REST-приложение
(официальный OSS-образ, Apache 2.0, версия запиннена) + свой одноразовый Postgres 16
с именованным томом. Один **zero-dep bash-entrypoint** `spikes/flowable-oss/run.sh`
с подкомандами per-AC (`up/seed/cleanup/deadletter/measure/down/smoke/all`),
параметризованный движком (`ENGINE=flowable|operaton`) и объёмом (`N_HISTORY`,
дефолт 300000). История сидируется **прямой батч-вставкой в таблицы истории движка
через `psql`** (не через REST-старт инстансов — на 300k это часы; см. §6 риск-1),
по минимальной but-корректной модели завершённого инстанса. Cleanup измеряется на
**тёплом прогоне** (warm-up + замер throughput удаления записей/с + кривая роста
таблиц до/во время/после) с честно выписанными допущениями экстраполяции на 70M/год.
Deadletter создаётся **детерминированно**: разворачивается минимальный BPMN с
service-task, который всегда падает, `retries` выставлен в 0 → джоба в deadletter;
затем три REST-операции (list / set-retries / move) исполняются **только через
публичный REST OSS-артефакта** и фиксируется HTTP-код+эффект. Все измерения пишутся
в машиночитаемый `spikes/flowable-oss/measurements.json` (по движку). Вердикт —
`docs/design/stack-flowable-oss-spike-addendum.md`, статус «addendum, awaiting
ratification». Fitness-функции фазы BUILD проверяют **что харнесс работает** (smoke),
а не каков результат спайка (результат — вход фаундерского гейта, не CI-гейт).

**Runtime-таргет:** локально, Docker на машине разработчика (NF-1). Внешних ресурсов
/ founder-провижна спайк не требует — публичный `docker pull` Apache-2.0-образов.

---

## 2. Выбор артефактов (запиннены, Apache 2.0, без enterprise-ключей)

| Роль | Координата (pin) | Лицензия | Почему |
|---|---|---|---|
| Flowable REST | `flowable/flowable-rest:7.1.0` | Apache 2.0 | Официальный OSS-образ Flowable 7; Spring-Boot-приложение, поднимает **полный набор REST API + Swagger** (включая `/management/*` — deadletter), Postgres через `SPRING_DATASOURCE_*`. **Готовый образ существует** — тонкий Dockerfile из maven-артефактов НЕ нужен (снят риск-1 §6). |
| Flowable БД | `postgres:16` (official) | PostgreSQL Licence | Целевая СУБД Choros (ADR §1). Один инстанс на стек, одноразовый том. |
| Operaton (движок+REST+webapps) | `operaton/operaton:1.0.0` | Apache 2.0 | Официальный OSS-образ форка Camunda 7 CE; Spring-Boot-дистрибутив, REST API + Cockpit/Tasklist/Admin, Postgres через `SPRING_DATASOURCE_*` / `DB_*`. Запасной движок (spec FR-5). |
| Operaton БД | `postgres:16` (official) | PostgreSQL Licence | То же, отдельный стек/том. |

**Лицензионная фиксация (AC-2/AC-11, FR-6):** `run.sh license <engine>` записывает в
журнал точную координату+digest (`docker image inspect ... RepoDigests`), и
извлекает строки лицензии из `docker run --rm <image> sh -c 'find / -iname "LICENSE*"'`
/ метки образа. **Бинарный исход** (NF-4): найден enterprise-jar/требование ключа →
no-go для движка, фиксируется, **не обходится** (RL-3). Если конкретный pin-тег на
момент BUILD недоступен — берётся ближайший доступный OSS-тег той же мажорной линии и
**фактический тег записывается в журнал** (воспроизводимость через digest, не «latest»).

> **Никаких** триалов/регистраций/ключей. Enterprise-only способность = no-go-сигнал
> (вердикт), а не задача «как обойти» (RL-3, NF-4).

---

## 3. Архитектура харнесса (compose-топология)

```
spikes/flowable-oss/
├── README.md                      # «СПАЙК, НЕ ПРОД» + как запускать
├── run.sh                         # единственный entrypoint, zero-dep (bash+curl+psql-in-container)
├── compose.flowable.yml           # flowable-rest:7.1.0 + postgres:16  (том spike_flowable_pg)
├── compose.operaton.yml           # operaton:1.0.0   + postgres:16  (том spike_operaton_pg)
├── bpmn/
│   ├── flowable-failing.bpmn20.xml   # service-task, всегда падает → deadletter
│   └── operaton-failing.bpmn20.xml   # то же под Camunda-неймспейс
├── sql/
│   ├── seed-flowable.sql          # батч-INSERT в ACT_HI_PROCINST/ACT_HI_ACTINST (генерируется по N)
│   └── seed-operaton.sql          # батч-INSERT в ACT_HI_PROCINST (+ removal_time) под Camunda-схему
├── lib/
│   ├── seed.sh                    # генерирует и заливает sql батчами (FR-2)
│   ├── measure.sh                 # снимает счётчики таблиц/тайминги, пишет measurements.json (FR-7)
│   └── jq-free-json.sh            # сборка JSON без внешних зависимостей (bash printf)
└── measurements.json              # машиночитаемый журнал (создаётся прогоном; в .gitignore-? — НЕТ: коммитим как доказательство)
```

**Топология одного стека** (пример Flowable):

```
[ flowable-rest:7.1.0 ]  --JDBC-->  [ postgres:16 ]
   :8080 (REST+Swagger)               :5432, том spike_flowable_pg
   healthcheck: GET /flowable-rest/service/management/engine  -> 200
   env: SPRING_DATASOURCE_URL=jdbc:postgresql://pg:5432/flowable
        SPRING_DATASOURCE_USERNAME/PASSWORD, FLOWABLE_REST_APP_ADMIN_*
        flowable.enable-history-cleaning + cycle (для AC-4/5)
```

Стеки **полностью независимы** (разные проекты compose `-p spike_flowable` /
`-p spike_operaton`, разные тома, разные host-порты 8080/8081). Никакой сети к
прод-`docker-compose` Choros. Всё под `spikes/` (AC-14/NF-5).

### 3.1 Сидирование истории (~300k+ завершённых) — FR-2, AC-3

**Метод: прямая батч-вставка в таблицы истории, НЕ старт инстансов через REST.**
Старт+завершение 300k реальных инстансов на ноутбуке = часы и шумит на измерении
cleanup; нам нужны записи истории в правильной форме, а не семантика выполнения.

- Минимальный завершённый инстанс = строка в таблице истории процессов движка:
  - Flowable: `ACT_HI_PROCINST` (PROC_INST_ID, PROC_DEF_ID, START_TIME, **END_TIME**,
    DURATION, ...) + по N строк в `ACT_HI_ACTINST` (опционально, чтобы каскад удаления
    был представителен; объём активити-записей — параметр `ACT_PER_INST`, дефолт 1).
  - Operaton: `ACT_HI_PROCINST` с заполненным `END_TIME_` **и `REMOVAL_TIME_`**
    (Camunda-7-стратегия removal-time; без него cleanup ничего не удалит — см. §6 нюанс).
- Генератор `lib/seed.sh` пишет SQL батчами по `BATCH=10000` (`INSERT ... SELECT
  generate_series(...)` — одна команда на батч, не 300k строк-инсертов), фиксирует
  фактический счётчик `SELECT count(*)` после заливки (AC-3: счётчик в журнале совпал).
- **END_TIME сидируется в прошлое** (старше TTL-границы cleanup), чтобы все записи
  были немедленно eligible под удаление (иначе throughput-замер ложно даст 0).
- Идемпотентность: `seed` сначала `TRUNCATE` целевые HI-таблицы (повтор даёт тот же N).

> Это «масштабируемая модель нашей нагрузки» (spec FR-2), а не функциональный E2E —
> явная не-цель спека §4. Допущение «вставленная история = удаляемая cleanup-ом так же,
> как порождённая движком» выписывается в журнал и в аддендум (опровергаемо: BUILD
> сверяет, что cleanup реально уменьшает count этих строк — AC-4/AC-6).

### 3.2 Измерение history-cleanup throughput — FR-3, AC-4/5/6

**Честная методика, тёплый прогон:**

1. **enable cleanup в OSS-артефакте** (env/REST), запиннить batch-size.
   - Flowable: `flowable.enable-history-cleaning=true` + триггер немедленного цикла;
     удаление по `END_TIME < now - cleaningAfterDays`.
   - Operaton: `POST /engine-rest/history/cleanup?immediatelyDue=true` → создаёт
     ever-living job в `ACT_RU_JOB`; eligibility по `REMOVAL_TIME_`.
2. **Warm-up:** один маленький cleanup-проход на «прогрев» (план запроса, кэш, autovacuum
   не считается в throughput).
3. **Замер:** засечь `t0`, `count(ACT_HI_PROCINST) = N0`; запустить cleanup; поллить
   count каждые `POLL=5s` пока не стабилизируется; `t1`, `N1`.
   `throughput = (N0 - N1) / (t1 - t0)` записей/с.
4. **Деградация (AC-6):** снимать размер таблиц (`pg_total_relation_size`), число
   мёртвых строк (`pg_stat_user_tables.n_dead_tup`), длительность каждого poll-окна →
   проверить **нет неограниченного роста / зависания**, cleanup завершается
   детерминированно (count выходит на плато).
5. **Подтверждение OSS-присутствия (AC-4):** механизм запустился из публичного образа
   без ключа и реально уменьшил count → `cleanup_present_in_oss=true`. Если механизм
   отсутствует/требует enterprise → `false` → **no-go Flowable**.

### 3.3 Экстраполяция на 70M/год (NF-3, §6 спека) — AC-5

Записывается в журнал и аддендум **с явными допущениями** (часть вердикта, опровержима):
- `linearity`: измеренный throughput линеен по объёму (или зафиксированная сублинейность
  при росте N — замер на двух точках N и N/3, чтобы НЕ предполагать линейность вслепую);
- `contour_vs_fleet`: 70M — флотовый объём; при silo на контур приходится доля
  (явный коэффициент `contour_fraction`, консервативно);
- `dev_vs_prod_resources`: dev-ноутбук vs контурный NVMe-Postgres — консервативный
  понижающий коэффициент на dev (явный, не «прод будет быстрее»);
- `cleanup_window`: cleanup — фоновое ночное/недельное окно (не онлайн-путь);
- **Вердикт go:** `70M_per_contour / throughput_adjusted` укладывается в окно **с запасом**.
  Не укладывается даже с запасом → no-go/risk-flag (AC-5).

### 3.4 Deadletter через REST OSS — FR-4/5, AC-7/8/9

**Детерминированное создание dead-job:**
- Развернуть `*-failing.bpmn20.xml` (service-task, который всегда бросает) через REST
  deploy; стартовать инстанс; джоба упадёт; **выставить retries=0** (через REST
  set-retries в 0, или дать движку исчерпать ретраи) → джоба гарантированно в deadletter.

**Три REST-операции — ТОЛЬКО через публичный REST артефакта (NF-4, бинарно):**

| Способность | Flowable REST (OSS) | Operaton REST (OSS) | go-критерий |
|---|---|---|---|
| list (AC-7) | `GET /flowable-rest/service/management/deadletter-jobs` | `GET /engine-rest/job?withException=true` (retries=0) | HTTP 2xx + непустой список из OSS |
| retry/set-retries (AC-8) | `POST /management/deadletter-jobs/{id}` body `{"action":"move"}` или set-retries через `PUT` job retries | `PUT /engine-rest/job/{id}/retries` `{"retries":3}` | джоба ушла из deadletter в активную очередь |
| move/возврат (AC-9) | `POST /management/deadletter-jobs/{id}` `{"action":"move"}` | (set-retries и есть возврат в active; зафиксировать паритет) | подтверждено состоянием очереди (повторный list пуст / джоба в ACT_RU_JOB) |

Каждая операция логирует **HTTP-код и пост-эффект** (повторный list/запрос count).
Enterprise-only по любой из трёх → no-go для движка (бинарно, NF-4). Точные пути в
BUILD сверяются со Swagger артефакта (`/swagger-ui` поднятого образа) — не выдумываются.

---

## 4. Объектная модель (артефакты харнесса — контракт между скриптами и журналом)

`measurements.json` — корень: `{ "schema_version", "generated_at", "engines": [EngineResult] }`.

---

## 5. Контракты (CLI харнесса + формат журнала + аддендум)

`run.sh` подкоманды (per-AC, идемпотентны):

```
run.sh up        <engine>            # AC-1: поднять стек, ждать healthcheck зелёным
run.sh license   <engine>            # AC-2/11: записать координату+digest+лицензию
run.sh seed      <engine> [N]        # AC-3: залить >=N завершённых, вернуть фактический count
run.sh cleanup   <engine>            # AC-4/5/6: warm-up + замер throughput + кривая деградации
run.sh deadletter<engine>            # AC-7/8/9: создать dead-job, прогнать list/retry/move через REST
run.sh measure   <engine>            # AC-12: собрать всё в measurements.json (EngineResult)
run.sh down      <engine>            # AC-15: снести стек + одноразовый том
run.sh smoke     <engine>            # BUILD-fitness: up→REST 200→seed 1000→measure пишет JSON→down (быстрый)
run.sh all       <engine> [N]        # полный прогон одного движка
```

Формат `EngineResult` (запись в `measurements.json`):
```
{ engine, image, image_digest, license, license_ok,
  n_history_target, n_history_actual,
  cleanup_present_in_oss, cleanup_throughput_rps, cleanup_duration_s,
  table_size_before_bytes, table_size_after_bytes, degradation_ok,
  extrapolation: { linearity, contour_fraction, dev_factor, window, fits_70m, headroom_factor },
  deadletter: { list:{available,http,count}, retry:{available,http,effect}, move:{available,http,effect} },
  verdict_engine: "go"|"no-go"|"risk", notes }
```

Аддендум `docs/design/stack-flowable-oss-spike-addendum.md` (FR-8/AC-13), структура:
1. Заголовок + **Статус: addendum, awaiting ratification** (ратифицирует фаундер, GT/RL-2).
2. Per-AC таблица результата (AC-1..AC-15: исход + число/бинарь + ссылка на measurements.json).
3. Методика измерения (тёплый прогон, batch-size, как создан deadletter) — воспроизводимо.
4. Допущения экстраполяции на 70M/год (§3.3) — явный список, помечен «опровержим».
5. **go/no-go Flowable** (по сводному правилу спека: AC-2,4,7,8,9 = OSS И AC-5/6 в норме).
6. **go/no-go Operaton** (AC-10/11 + те же пробы).
7. **Рекомендация Flowable vs Operaton** с обоснованием от измерений (паритет/расхождения).
8. Открытые вопросы фаундеру (если есть).

---

## 6. Риски и их снятие (вход для BUILD)

| Риск | Оценка | Решение в дизайне |
|---|---|---|
| **R1. Готового Flowable 7 REST-образа нет** | СНЯТ | `flowable/flowable-rest:7.1.0` существует на Docker Hub (Apache 2.0, полный REST). Тонкий Dockerfile из maven не нужен. Fallback при недоступности тега: ближайший OSS-тег 7.x, фактический — в журнал по digest. |
| **R2. Сидирование 300k через REST = часы** | СНЯТ | Прямая батч-INSERT в HI-таблицы (§3.1), `generate_series`, батчи по 10k → минуты. Допущение «вставленная история удаляется как порождённая» выписано и проверяется (cleanup реально жмёт count). |
| **R3. Operaton-образ/координаты** | СНЯТ | `operaton/operaton:1.0.0` на Docker Hub, Apache 2.0, Postgres через env. Подтверждено web-поиском. |
| **R4. Cleanup не удаляет: TTL/removal-time не выставлены** | СНЯТ дизайном | Flowable: END_TIME сидируется старше cleaningAfterDays. Operaton: сидируется `REMOVAL_TIME_` в прошлом + `historyTimeToLive`. Иначе замер ложно даст 0 — нюанс выписан. |
| **R5. Точные REST-пути deadletter отличаются от ожидаемых** | управляем | BUILD сверяет пути со Swagger поднятого артефакта (`/swagger-ui`), не выдумывает. Способность бинарна: есть в OSS REST / нет. |
| **R6. Спайк загрязняет прод (NF-5)** | СНЯТ fitness | FF-ISOLATION (§7): git diff вне `spikes/` + один addendum → красный. |
| **R7. Лицензия не Apache 2.0 / есть ключ** | это и есть вердикт | NF-4 бинарно: фиксируем no-go, не обходим (RL-3). Не «провал спайка» — это его законный результат. |

---

## 7. Fitness-функции (фаза BUILD — проверяют, что ХАРНЕСС работает, не результат спайка)

> Спайк — `manual`/`fitness` по природе (spec §5): запускается на Docker-машине, не в
> обычном unit-CI. Эти FF — исполнимые smoke/структурные проверки **работоспособности
> харнесса**, отделённые от самих чисел спайка (числа = вход founder-гейта, не CI-гейт).

| ID | Правило | CI-check (команда) |
|---|---|---|
| FF-ISOLATION | Спайк не трогает `src/`, прод-`docker-compose`, прод-CI; всё под `spikes/` + один addendum в `docs/design/` (AC-14/NF-5) | `git diff --name-only <base>..HEAD \| grep -vE '^(spikes/\|docs/design/stack-flowable-oss-spike-addendum\.md\|docs/design/T-0117)' ` → пусто, иначе exit 1 |
| FF-SMOKE-UP | Каждый стек поднимается из публичных образов и REST отвечает 200 (AC-1) | `spikes/flowable-oss/run.sh up flowable && curl -fsS localhost:8080/.../management >/dev/null` (и operaton:8081); exit 0 |
| FF-SMOKE-SEED | Генератор заливает заданный объём и фактический count совпал с целевым (AC-3, на малом N в smoke) | `run.sh seed flowable 1000 && [ "$(...count...)" -ge 1000 ]` |
| FF-SMOKE-JSON | `measure` создаёт `measurements.json`, машиночитаем (валидный JSON) и содержит обязательные поля EngineResult (AC-12) | `run.sh measure flowable && python3 -c "import json;d=json.load(open('spikes/flowable-oss/measurements.json'));assert d['engines'][0]['engine']" ` |
| FF-SMOKE-DOWN | `down` сносит контейнеры и одноразовый том; повторный `up` чист (AC-15/NF-2) | `run.sh down flowable && ! docker volume ls \| grep spike_flowable_pg && run.sh up flowable` exit 0 |
| FF-ADDENDUM | Аддендум присутствует, статус «addendum, awaiting ratification», содержит явные go/no-go по обоим движкам + рекомендацию (AC-13) | `grep -q 'addendum, awaiting ratification' docs/design/stack-flowable-oss-spike-addendum.md && grep -Eq 'go|no-go' ...` |
| FF-IMAGES-PINNED | Образы запиннены (не `latest`), лицензия Apache 2.0 зафиксирована в журнале (AC-2/11, NF-2 воспроизводимость) | `! grep -E ':latest' spikes/flowable-oss/compose.*.yml && grep -q 'Apache' spikes/flowable-oss/measurements.json` |
| FF-NO-SECRETS | Нет триал-ключей/токенов/регистраций в харнессе (RL-3) | `! grep -RiE 'enterprise.?key\|license.?key\|trial\|api[_-]?token' spikes/flowable-oss/` exit 0 |

> Эти FF — для **локального gate-прогона спайка** (smoke на малом N, минуты). Полный
> прогон (N≥300k, оба движка) — отдельный исполнительный шаг BUILD, его выход —
> заполненный `measurements.json` + аддендум, которые читает фаундер. CI прод-сборки
> Choros спайк НЕ трогает (FF-ISOLATION гарантирует).

---

## 8. Трассировка AC → дизайн

| AC | Покрыто |
|---|---|
| AC-1 | §3 топология + `run.sh up` + healthcheck; FF-SMOKE-UP |
| AC-2 | §2 pin-таблица + `run.sh license`; FF-IMAGES-PINNED |
| AC-3 | §3.1 батч-сидирование + фактический count; FF-SMOKE-SEED |
| AC-4 | §3.2 п.5 cleanup_present_in_oss из публичного образа |
| AC-5 | §3.2 throughput + §3.3 экстраполяция с допущениями |
| AC-6 | §3.2 п.4 деградация (размеры таблиц, dead_tup, плато) |
| AC-7 | §3.4 list через REST OSS |
| AC-8 | §3.4 retry/set-retries через REST OSS |
| AC-9 | §3.4 move/возврат через REST OSS |
| AC-10 | §3 второй стек operaton, те же подкоманды `run.sh ... operaton` |
| AC-11 | §2 Operaton pin + `run.sh license operaton`; FF-IMAGES-PINNED |
| AC-12 | §5 `measurements.json` EngineResult; FF-SMOKE-JSON |
| AC-13 | §5 аддендум-структура; FF-ADDENDUM |
| AC-14 | §3 всё под `spikes/`; FF-ISOLATION |
| AC-15 | §3 одноразовые тома + `run.sh down`; FF-SMOKE-DOWN |

---

## 9. Развилки вне полномочий

Нет. Выбор образов/координат, методики измерения, способа сидирования, состава
deadletter-операций и порогов — **автономия роли** (spec §7 подтверждает: пороги
выведены из ратифицированной нагрузки ADR; развилка Flowable-vs-Operaton не блокирует
спайк, это его выход). Финальная **ратификация** вердикта-аддендума — штатный
founder-gate (GT/RL-2), вне фазы DESIGN/BUILD. Внешних ресурсов / GT-4-провижна нет
(публичный docker pull). `escalation` пуст.
