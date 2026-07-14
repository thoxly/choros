# ADR · T-0220 — Модель исходов агентского шага (proceed / defer-to-human / fail-closed)

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-14
**Spec (verbatim, unmerged branch):** секция **B** плейбука `v1-demo-and-trust-surface` («Поведение при ошибке агента / graceful degradation day-1»), воспроизведена в теле задачи T-0220. Решение фаундера B.5 (2026-06-14) — «уверенность» = ОБА сигнала сразу (детерминированные пороги DMN И самооценка модели).
**Foundation (do NOT contradict):**
- `docs/design/T-0016-audit-floor.adr.md` + `migrations/006_audit_event.sql` — append-only governance-журнал; `type text NOT NULL` **без CHECK** (open-vocab), `payload jsonb` hash-покрыт. Это субстрат для `agent.deferred`/`agent.blocked`.
- `docs/design/T-0019-actor-event-ledger.adr.md` + `migrations/018_actor_event.sql` — typed SoD-субстрат с **закрытым** verb-set `{request,prepare,submit,approve,release}`. Исходы агентского шага **НЕ** новые actor_event-глаголы (объяснение §2).
- `docs/design/T-0021-grant-resolver-pdp.adr.md` + `src/core/grant-resolver.ts` — PDP, чья функция решения возвращает `{ denied: true, reason: … }` (fail-closed deny). `fail-closed` исхода = этот существующий deny-путь.
- `docs/design/T-0020-agent-card.adr.md` + `migrations/032_agent_card.sql` — `agent_card.autonomy_threshold numeric(5,4) NULL` (soft gate [0,1], dormant day-1) — место хранения детерминированного порога; компетентностный слой T-0123 добавляет `confidence_source`/инструкцию аддитивным `ALTER TABLE ADD COLUMN`.
- `docs/design/T-0139-reasoning-trace.adr.md` + `src/core/reasoning-trace.ts` — reasoning-trace агента в `audit_event.payload` (red-line объяснимости). Объяснение сомнения у `defer`/`block` переиспользует этот канал.
- `src/http/inbox.ts` (E7, с claim+SLA+эскалациями, T-0093/T-0094/T-0138) — `defer-to-human` материализуется как **обычная** задача инбокса.
- `docs/design/T-0123-*` (компетентностный слой) — **ещё не построен/paused**; ссылается как ЗАВИСИМОСТЬ, не как существующий код.

> Это **design-only** ADR. Он НЕ эмитирует миграцию, НЕ трогает `ci/checks/*.sh`, НЕ
> пишет продакшен-код. T-0220 фиксирует *модель, инварианты, контракты событий и
> fitness-функции*, которые **B-2 impl (T-0221)** обязан удовлетворить. Несущая
> ценность — buildable, честный дизайн: каждое утверждение «где это живёт» привязано
> к реальному файлу выше.
>
> Каждая fitness-функция несёт `ci_check` и пометку гейтинга: **static-now** = бежит в
> сегодняшнем `npm run ci` (tsc/eslint/vitest + `ci/checks/*` shell-линты; репозиторий
> zero-runtime-dep); **live-DB** = проба живого Postgres в `fitness:db`. Это зеркалит
> T-0016/T-0019/T-0139.

---

## 1. Контекст и проблема (B.1)

Аудит (T-0016/T-0019/T-0139) пишет **ЧТО** и **ПОЧЕМУ** сделал агент, но не определяет
**ЧТО ПРИ ОШИБКЕ**. D-6 закрыл *ответственность* (вендор = рамка, клиент = компетентностный
слой), но не *поведение day-1*. Choros продаёт «агента-сотрудника»; первый клиент — это
trust-red-line: надо показать, что агент **ошибается безопасно**, а не безошибочно. Доверие =
**предсказуемая остановка**, не отсутствие ошибок.

Этот ADR — **семантическая** модель day-1 поверх уже построенных механизмов. Он НЕ вводит
ни одной новой таблицы, ни нового рантайма автономии, ни egress-движка (всё это Stage-2,
§8). Он вводит ровно: (1) три именованных исхода и их триггеры; (2) несущий инвариант
default-to-human; (3) **два** open-vocab аудит-события; (4) карту переиспользования.

---

## 2. Решение (один абзац)

Агентский шаг — это **ПРЕДЛОЖЕНИЕ, не решение** (гибрид «агент предлагает — человек
подтверждает»). Каждый шаг разрешается ровно в **один из трёх исходов**: **`proceed`**
(уверенность ≥ порога И действие в рамках грантов → агент заполняет/маршрутизирует, человек
видит результат + reasoning-trace), **`defer-to-human`** (уверенность < порога ИЛИ
неоднозначность ИЛИ пограничный атрибут → агент НЕ решает, материализует **обычную задачу
инбокса** (E7) «нужна проверка» с указанием *что именно неясно*, reasoning-trace объясняет
сомнение), **`fail-closed`** (действие вне грантов / ошибка инструмента / egress-блок → шаг
останавливается, пишется аудит-событие, эскалация по роли; **НИКОГДА не тихо пропустить**).
**Несущий инвариант:** дефолт при ЛЮБОЙ неопределённости = `defer`/`fail` к человеку, не
«агент додумал» — формально: исход `proceed` достижим **только** когда выполнены ВСЕ
утверждающие условия; любое нарушение, любая неоднозначность, любая ошибка инструмента и
любой неклассифицированный сигнал разрешаются НЕ в `proceed`. «Уверенность» (B.5) =
**конъюнкция двух гейтов**: детерминированный порог из DMN/`autonomy_threshold` (аудируемый
каркас) **И** самооценка модели (`confidence` как сигнал чувствительности); `defer`
срабатывает если **ЛИБО** порог нарушен **ЛИБО** модель сообщает низкую уверенность.
Реализационно это **«ничего нового сверх envelope»**: `defer→`обычная задача инбокса (E7,
claim/SLA/уведомления), `fail-closed→`существующий PDP-deny (T-0021) + audit-floor (T-0016),
а `agent.deferred`/`agent.blocked` — два **open-vocab** `type`-строки в `audit_event`, БЕЗ
новой таблицы/колонок.

---

## 3. Три исхода — точные триггеры (B.2)

Шаг агента (одна попытка совершить governed-действие: заполнить поле, смаршрутизировать
кейс, инвокнуть инструмент) разрешается детерминированной классификацией в один из трёх
исходов. Порядок проверки — **fail-closed имеет приоритет** (структурный отказ сильнее
сомнения), затем confidence-гейт, затем `proceed` как остаток.

### 3.1 `fail-closed` (приоритет 1 — структурный отказ)
**Триггер (любой из):**
- **действие вне грантов** — PDP (`resolveFor`, `src/core/grant-resolver.ts`) вернул
  `{ denied: true, reason }` (`cross_tenant` / `no_grant` / `no_effect_grant` /
  `sod_violation`);
- **ошибка инструмента** — инвокнутый внешний инструмент/external-worker бросил/таймаут;
- **egress-блок** — попытка исходящего вызова заблокирована (Stage-1: egress узкий; полный
  egress-runtime = Stage-2, §8).

**Поведение:** шаг **останавливается** (никакого частичного автоподтверждения), пишется
аудит-событие `agent.blocked` (§5), эскалация по роли (через инбокс-эскалацию, §6.1).
**Запрещено:** «тихо пропустить» / продолжить со значением по умолчанию / подавить ошибку.

### 3.2 `defer-to-human` (приоритет 2 — сомнение)
**Триггер (любой из):**
- **уверенность < порога** — детерминированный порог нарушен (DMN/`autonomy_threshold`);
- **низкая самооценка модели** — `confidence` модели ниже того же порога (B.5);
- **неоднозначность / пограничный атрибут** — модель/каркас сигналят неоднозначность входа
  (например, сумма у границы DMN-правила, неоднозначная категория).

**Поведение:** агент **НЕ решает**; материализует **обычную задачу инбокса** (E7, §6.2)
«нужна проверка» с полем *что именно неясно* (`doubt_reason`); reasoning-trace (T-0139)
объясняет сомнение. Пишется аудит-событие `agent.deferred` (§5).

### 3.3 `proceed` (остаток — только при выполнении ВСЕХ условий)
**Триггер (конъюнкция):** `НЕ fail-closed` **И** `НЕ defer` ⇔ уверенность ≥ порога (ОБА
сигнала B.5 проходят) **И** действие **в рамках грантов** (PDP allow).
**Поведение:** агент заполняет/маршрутизирует; человек видит **результат + reasoning-trace**
(T-0139). Никакого отдельного `agent.proceeded` open-vocab события day-1 не требуется — сам
governed-эффект уже пишет actor_event (T-0019) и/или lifecycle-audit (T-0068) по
существующим путям; `proceed` НЕ вводит нового аудит-`type` (см. §5.4, AC-9).

> **Решающее правило (default-to-human, §4):** классификатор исхода day-1 — функция
> `classifyOutcome(signals): 'proceed'|'defer-to-human'|'fail-closed'`, где `proceed`
> возвращается **исключительно** в ветке, где ВСЕ утверждающие условия истинны; любой
> неклассифицированный/`undefined`/исключительный сигнал маппится в `defer` (мягкий дефолт),
> а структурный отказ — в `fail-closed`. `proceed` никогда не является default-ветвью.

---

## 4. Несущий инвариант: default-to-human (B.2)

**INV-DEFAULT:** при любой неопределённости исход = НЕ `proceed`. Формально:

```
classifyOutcome(s) = fail-closed   if  s.structuralDenial OR s.toolError OR s.egressBlocked
                   = defer-to-human if  (not above) AND ( s.deterministicThresholdFailed
                                                          OR s.modelConfidence < threshold
                                                          OR s.ambiguous
                                                          OR s.<any-unrecognised-signal> )
                   = proceed        ONLY IF  none of the above hold
```

Свойство, которое impl (T-0221) обязан удержать и которое fitness проверяет (§7): **не
существует входа, на котором отсутствие/неполнота сигнала ведёт к `proceed`**. Это «агент
не додумывает»: пробел в данных = `defer`, не оптимистичное продолжение. Доверие = эта
предсказуемость, а не безошибочность (B.1).

---

## 5. Confidence-модель (B.5) и два open-vocab события

### 5.1 Двойной гейт уверенности (B.5 — фаундер 2026-06-14)
«Уверенность» day-1 = **ОБА сигнала сразу**, объединённые **дизъюнкцией на стороне defer**
(конъюнкцией на стороне proceed):

| Сигнал | Природа | Где живёт | Роль |
|---|---|---|---|
| **Детерминированный порог** | аудируемый каркас (сумма/категория из DMN-правил; soft-gate `autonomy_threshold`) | DMN-таблицы бандла (детерминированный консумент, ср. T-0129/T-0130) + `agent_card.autonomy_threshold` (`migrations/032_agent_card.sql`, [0,1] CHECK, dormant day-1; enforce — T-0123/E5.7) | **воспроизводимый, объяснимый каркас** — почему остановились можно показать клиенту без обращения к модели |
| **Самооценка модели** | `confidence` как сигнал | компетентностный слой агента (**T-0123**, инструкция «когда сомневаешься — спроси» + поле в `agent_card`, настраивается клиентом per-агент) | **чувствительность к неоднозначности**, которую жёсткий порог не ловит |

**Правило:** `defer-to-human` срабатывает если **ЛИБО** детерминированный порог нарушен
**ЛИБО** модель сообщает низкую уверенность. Каркас (пороги) — аудируемый; самооценка
добавляет чувствительность. `proceed` требует, чтобы **прошли оба**. Это делает явным
split «auditable framework + sensitivity»: остановку по порогу всегда можно объяснить
детерминированно; остановку по модели — через reasoning-trace (T-0139).

### 5.2 `agent.deferred` — open-vocab аудит-событие
- **Механизм:** строка в существующем `audit_event` (T-0016) с `type = "agent.deferred"`.
  `audit_event.type` — `text NOT NULL` **БЕЗ CHECK** (`migrations/006_audit_event.sql:13`):
  это open-vocab, новый `type` — НЕ DDL-изменение, НЕ новая колонка, НЕ новая таблица.
- **payload (jsonb, hash-покрыт — поле №11 preimage, T-0139 прецедент):**
  `{ doubtReason, signal: "threshold"|"model"|"ambiguity", inboxTaskId, reasoningTraceRef }`.
  `doubtReason` = *что именно неясно* (B.2); `inboxTaskId` ссылается на материализованную
  задачу (§6.2); reasoning-trace объясняет сомнение через канал T-0139.
- **actor/subject/via:** `actor` = агент (employee.id, kind='agent'); `subject` = объект
  кейса; `via` = канал шага.

### 5.3 `agent.blocked` — open-vocab аудит-событие
- **Механизм:** строка в `audit_event` с `type = "agent.blocked"` (тот же open-vocab путь).
- **payload:** `{ cause: "pdp_deny"|"tool_error"|"egress_block", denyReason?, toolRef?,
  escalatedToRole, reasoningTraceRef }`. `denyReason` для `pdp_deny` = ровно `reason` из
  `resolveFor` (`cross_tenant`/`no_grant`/`no_effect_grant`/`sod_violation`), что связывает
  событие с PDP-следом (T-0021) и pdp-explain (`src/http/pdp-explain.ts`).
- **Связь с PDP:** `fail-closed` по причине `pdp_deny` — это НЕ второй путь авторизации;
  это аудит-проекция уже принятого PDP-deny. Авторитет остаётся единым (T-0021).

### 5.4 Почему НЕ новые actor_event-глаголы и НЕ `proceed`-событие
- `actor_event` verb-set (T-0019) **закрыт** и vocab-versioned (`{request,prepare,submit,
  approve,release}`). `deferred`/`blocked` — это **governance-аудит** (что пошло не так),
  не **SoD-факты** (кто что одобрил); их место — `audit_event` (open-vocab), а не
  `actor_event` (closed). Добавление их в actor_event сломало бы `actor_event_vocab_pinned`
  golden без SoD-выгоды (T-0019 §5 rejected #7).
- `proceed` НЕ требует нового аудит-`type`: успешный governed-эффект уже журналируется
  существующими producer'ами (actor_event/lifecycle-audit). Day-1 минимально достаточно
  материализовать в аудите ровно **отклонения** (`deferred`/`blocked`).

---

## 6. Карта переиспользования — «ничего нового сверх envelope» (B.3)

| Исход | Механизм day-1 | Реальный файл (проверено) | Новый механизм? |
|---|---|---|---|
| `defer-to-human` | **обычная** задача инбокса (E7): role-addressing + claim + SLA + эскалации + уведомления | `src/http/inbox.ts` (`role`, `sla`, `due`, claim-путь T-0094/T-0138, таб «Эскалации»); уведомления `src/core/notification-router.ts` | **НЕТ** — переиспользует claim/SLA/notifications |
| `fail-closed` | существующий **PDP-deny** + **audit-floor** + open-vocab `type` | `src/core/grant-resolver.ts` (`{denied,reason}`), `src/db/audit-writer.ts` (`appendAuditEvent`), `migrations/006_audit_event.sql` | **НЕТ** — PDP-deny + audit уже есть |
| порог уверенности | soft-gate `autonomy_threshold` + DMN-каркас; инструкция «спроси» | `migrations/032_agent_card.sql` (`autonomy_threshold`), T-0123 (инструкция, **не построен**) | **НЕТ структуры**; *enforce* — Stage-2/T-0123 |
| объяснение сомнения | reasoning-trace в `audit_event.payload` | `src/core/reasoning-trace.ts` (T-0139) | **НЕТ** — переиспользует payload-канал |

### 6.1 `fail-closed` → эскалация по роли
Эскалация = существующая инбокс-механика: остановленный шаг порождает/помечает задачу
во вкладке **«Эскалации»** (`src/http/inbox.ts`: таб `esc` = `escalated`-флаг ИЛИ
`status` failed), адресованную **роли** (не конкретному человеку — инвариант role-addressing
T-0093). Уведомление — через `notification-router.ts`. Нового канала эскалации НЕТ.

### 6.2 `defer-to-human` → задача инбокса
`defer` материализует **обычный** user-task: `role` (кому адресовано), `name` («Проверить:
<doubtReason>»), `sla`, `execType: "agent"` (источник), и `claimedBy`/`claimedAt` после
claim. Контракт HTTP/состояний идентичен любой другой задаче пула — отсюда бесплатно
наследуются claim из пула, SLA-таймеры, уведомления, эскалация при просрочке. T-0221 НЕ
вводит новый тип задачи; он вводит **producer**, который кладёт такую задачу в инбокс при
исходе `defer`, и заполняет `doubt_reason`.

### 6.3 Где живёт порог (B.3, точно по коду)
- `agent_card.autonomy_threshold` уже существует (`migrations/032_agent_card.sql:50`,
  `numeric(5,4)`, CHECK `[0,1] OR NULL`, **dormant day-1** — «E5.7 enforces, Stage-2»).
  Это место хранения детерминированного порога. Сам файл миграции называет будущие
  аддитивные колонки `confidence_source`/`autonomy_floor` как T-0123/Stage-2-расширение —
  ровно сценарий B.3.
- Инструкция «когда сомневаешься — спроси» + per-агент настройка клиентом = **T-0123**
  (компетентностный слой), который **ещё не построен** (paused). T-0220 фиксирует *seam*
  (откуда impl читает порог/инструкцию), но НЕ требует, чтобы T-0123 был готов: day-1
  порог может прийти из `autonomy_threshold` (если задан) ИЛИ из DMN-правила процесса.

---

## 7. Fitness / acceptance-критерии для B-2 impl (T-0221)

Каждый критерий — то, что T-0221 обязан закодировать и что CI проверит. `static-now`, если
не указано иное (репозиторий zero-runtime-dep; модель исходов — pure-функция).

| AC | Правило (инвариант) | ci_check (как проверить) | Гейтинг |
|---|---|---|---|
| **AC-1** | `classifyOutcome` тотальна и возвращает ровно один из трёх исходов | unit-golden над таблицей сигналов: каждый вход → ровно один исход; нет `undefined` | static-now |
| **AC-2** | **Неопределённый шаг НИКОГДА не auto-proceed** (INV-DEFAULT) | property/golden: для всех входов где `confidence`/порог/неоднозначность не «оба зелёные» — исход ≠ `proceed`; включая отсутствующий сигнал | static-now |
| **AC-3** | `proceed` достижим ТОЛЬКО при PDP-allow И обоих confidence-гейтах | golden: PDP-deny ИЛИ порог-fail ИЛИ low-model-conf ⇒ исход ≠ proceed | static-now |
| **AC-4** | **`fail-closed` всегда эмитит `agent.blocked`** (никогда тихо) | golden: каждый fail-closed-вход ⇒ ровно одно `audit_event` с `type='agent.blocked'`; `cause` ∈ {pdp_deny,tool_error,egress_block} | static-now (encoder) |
| **AC-5** | **`defer` материализует задачу инбокса** с причиной сомнения | golden: defer-вход ⇒ inbox-task создан с непустым `doubt_reason` И `agent.deferred` c `inboxTaskId`==id задачи | static-now (encoder) + live-DB (inbox write) |
| **AC-6** | `defer` НЕ вводит новый тип задачи — это обычный пул-task | lint: producer кладёт задачу той же формы, что `src/http/inbox.ts` (role/sla/claim); нет новой таблицы задач | static-now |
| **AC-7** | `agent.blocked.denyReason` для `pdp_deny` ∈ `{cross_tenant,no_grant,no_effect_grant,sod_violation}` | golden: значение берётся из `resolveFor` reason, не свободная строка | static-now |
| **AC-8** | `agent.deferred`/`agent.blocked` НЕ добавляют CHECK/колонку/таблицу | lint: `migrations/` без нового `type`-CHECK; события идут через `type` строку (`audit-writer.ts`) | static-now (grep) |
| **AC-9** | `proceed` НЕ эмитит нового аудит-`type` (переиспускает actor_event/lifecycle) | lint: нет `type='agent.proceeded'` в encoder | static-now |
| **AC-10** | События НЕ попадают в `actor_event` (closed verb-set не трогается) | lint: `agent.deferred`/`agent.blocked` не среди ACTOR_EVENT_VERBS; `actor_event_vocab_pinned` зелёный | static-now |
| **AC-11** | reasoning-trace сопровождает defer И block (объяснимость) | golden: payload обоих событий несёт `reasoningTraceRef` (T-0139 канал) | static-now |
| **AC-12** | Порог читается из `agent_card.autonomy_threshold`/DMN, не хардкод | lint: нет литерального порога в коде модели исходов; источник — seam | static-now |
| **AC-13** | `fail-closed` имеет приоритет над `defer` (структурный отказ сильнее сомнения) | golden: вход с PDP-deny И low-confidence ⇒ `fail-closed`, не `defer` | static-now |

---

## 8. Открытые вопросы и границы Stage-2

1. **Полный autonomy-runtime / egress-движок = Stage-2.** Day-1 beachhead-агент = **низкий
   тир** автономии (B.3: «уровни автономии T0–T3, та же envelope-механика; day-1 = низкий
   тир»). Реальное *enforcement* `autonomy_threshold` и полный egress/runtime — Stage-2
   (`agent_card` поле dormant day-1; «E5.7 enforces»). T-0220/T-0221 удерживают day-1-модель,
   а не строят рантайм автономии.
2. **T-0123 (компетентностный слой) не построен.** Инструкция «когда сомневаешься — спроси»
   и per-агент-порог клиента — зависимость, не предпосылка. Seam зафиксирован; день-1 порог
   может прийти из DMN-правила процесса, если `autonomy_threshold` NULL. **Открытый вопрос:**
   точная калибровка `confidence`-шкалы модели и её сопоставление с numeric-порогом [0,1] —
   за T-0123.
3. **Источник самооценки модели.** Day-1 `confidence` — сигнал от модели агента; формат/
   надёжность калибруется в компетентностном слое (T-0123). T-0220 фиксирует *роль* сигнала
   (дизъюнкция с порогом на стороне defer), не его численную модель.
4. **Несколько подряд defer/block в одном кейсе** — материализуются как отдельные
   inbox-задачи/аудит-строки (append-only); агрегация/дедуп — продуктовый вопрос Stage-2.

---

## 9. Rejected alternatives

1. **Новые actor_event-глаголы `defer`/`block`** — actor_event verb-set закрыт и
   vocab-pinned (T-0019); это governance-аудит, не SoD-факт. Open-vocab `audit_event.type`
   — правильное место (§5.4).
2. **Новая таблица `agent_step_outcome`** — нарушает «ничего нового сверх envelope» (B.3);
   `audit_event` (open-vocab) + inbox (E7) покрывают всё day-1. Новая таблица = founder-gate
   и дрейф, без выгоды.
3. **`proceed` как default-ветвь классификатора** — прямо ломает INV-DEFAULT; неполнота
   сигнала привела бы к «агент додумал». `proceed` — только остаток при ВСЕХ зелёных (§4).
4. **Только детерминированный порог ИЛИ только самооценка модели** — противоречит решению
   фаундера B.5 («ОБА сразу»): один порог не ловит неоднозначность, одна модель не
   аудируема. Нужны оба, объединённые дизъюнкцией на defer.
5. **«Тихо продолжить со значением по умолчанию» при ошибке инструмента** — прямо запрещено
   B.2 («НИКОГДА не тихо пропустить»); такое поведение убивает trust-red-line.
6. **Отдельный `agent.proceeded` аудит-`type`** — дублирует существующие actor_event/
   lifecycle-audit producer'ы; day-1 в аудите материализуем только отклонения (§5.4).
7. **Enforce `autonomy_threshold` day-1** — поле dormant по T-0020 («E5.7 enforces,
   Stage-2»); enforcement = Stage-2/T-0123. T-0220 — модель, не рантайм автономии.

---

## 10. Traceability (AC → дизайн / спека B)

| AC | Покрывает |
|---|---|
| AC-1/AC-2 | §4 INV-DEFAULT + §3 классификатор (B.2 несущий инвариант) |
| AC-3/AC-13 | §3 приоритет fail-closed→defer→proceed; §5.1 двойной гейт (B.5) |
| AC-4 | §3.1 + §5.3 `agent.blocked` (B.2 fail-closed) |
| AC-5/AC-6 | §3.2 + §6.2 defer→inbox-task (B.2/B.3 E7 переиспользование) |
| AC-7 | §5.3 denyReason из resolveFor (T-0021 связь) |
| AC-8/AC-10 | §5.2/§5.4 open-vocab type, не actor_event, не новая колонка (T-0016/T-0019) |
| AC-9 | §3.3/§5.4 proceed без нового type |
| AC-11 | §5.2/§5.3 reasoningTraceRef (T-0139) |
| AC-12 | §6.3 порог из agent_card/DMN seam (T-0020/T-0123) |

---

## 11. Runtime / deploy target

**Runtime:** существующий choros dev-стек (single-Postgres substrate + node:http) на
home-сервере фаундера (`/srv/choros`, deploy founder-gated). **НИКАКОЙ** новой миграции,
новой таблицы, нового внешнего ресурса, нового CI-shell-чека этот ADR НЕ вводит —
зеркалит T-0139. **Нет founder-gate** (нет нового инфра/сервера/DB-provisioning).

**Не построено здесь (фиксируются как seam'ы для T-0221):** producer, эмитящий
`agent.deferred`/`agent.blocked` через `appendAuditEvent` (encoder по образцу
`lifecycle-audit.ts`/`audit-grant-encoder.ts`); producer, кладущий defer-задачу в инбокс;
чтение порога из `agent_card.autonomy_threshold`/DMN. **Зависимость:** T-0123
(компетентностный слой — инструкция/per-агент порог) — paused, не предпосылка day-1.
