# ADR T-0139 — Reasoning-trace агента в audit_event (red-line объяснимости)

- **task_id:** T-0139
- **status:** ready (red-line-решение фаундера уже принято — §3а раунд решений gap-map; ADR проектирует в его рамках, не re-litigate)
- **spec_ref:** playbooks/choros-product-gap-map.md зона 3 §3 п.2 — «аудит пишет *что* сделал агент, не *почему*»
- **runtime_target:** существующий choros dev-стек (single-Postgres substrate + node:http). НИКАКОЙ новой миграции, новой таблицы, нового внешнего ресурса — трасса ложится в уже существующую колонку `audit_event.payload jsonb` (миграция 006). Чисто аддитивно: новый pure-модуль `src/core/reasoning-trace.ts` + правки только в encoder-вызовах агентских decision-точек. Без founder-gate.

---

## 1. Контекст и инвариант, который НЕЛЬЗЯ сломать

`choros.audit_event` (006, T-0016) — append-only hash-chained журнал. Append-only
держится двумя механизмами: (a) `choros_app` имеет только `SELECT, INSERT`;
(b) `BEFORE UPDATE/DELETE` триггеры режут мутацию для всех ролей. Каждая строка
hash-покрыта каноническим preimage (`src/core/audit-preimage.ts`,
`CANONICAL_FIELD_ORDER`, vocab_version=1); **`payload` — поле №11 этого preimage**
(`audit-preimage.ts:245`), JCS-канонизируется и входит в `row_hash`. Любое
изменение набора/порядка колонок preimage = vocab bump (краснит FF-3 golden).

`actor_event` (018, T-0019) — отдельный typed SoD-субстрат с pinned-vocab
({request,prepare,submit,approve,release}). Это НЕ аудит-флор; ломать его словарь
нельзя (FF actor_event_seq_no_decrement и т.п.).

Decision-точки агента сегодня уже пишут в аудит через **единый канонический
sink** `appendAuditEvent` (T-0031/T-0068) с pure-энкодерами:
`encodeInvokeAuditEvent` (`invoke.command` — агент-диспетчер) и
`encodeLifecycleAuditEvent` (`task.completed`/`task.failed` — агент-external-task),
причём `actorType ∈ {human,agent,service}` уже живёт в `payload`, hash-покрыт
(`lifecycle-audit.ts:28`).

**Вывод:** объяснимость должна лечь АДДИТИВНО внутрь `payload` существующего
журнала — НЕ второй журнал, НЕ новая колонка, НЕ новая таблица. Соразмерно
тонкому ядру (CONCEPT §5): reasoning-trace = структурированный под-объект
`payload.reasoning`, который автоматически наследует append-only, hash-покрытие,
RLS tenant-изоляцию и actor-vocab — без единой строки нового DDL.

---

## 2. Decision (что проектируем)

### 2.1. Объектная модель: `ReasoningTrace` как под-объект `payload`

Reasoning-trace — **зарезервированный ключ `reasoning` внутри `audit_event.payload`**.
Никаких новых колонок. Под-объект (TS-тип `ReasoningTrace`, pure-модуль
`src/core/reasoning-trace.ts`):

| Поле | Тип | Обяз. | Семантика |
|---|---|---|---|
| `decision` | `string` (slug, `^[a-z0-9_.-]+$`) | да | КАКОЕ решение принималось (decision-точка), напр. `"provider.select"`, `"triage.route"`, `"task.complete"`. Закрытого словаря НЕТ (соразмерно — это product-evolving), но формат-инвариант есть. |
| `chosen_option` | `string` (1..2000 chars) | да | Выбранный вариант X — что агент решил. |
| `alternatives` | `Alternative[]` (0..N) | да (массив обязателен, может быть пустым) | Рассмотренные/отвергнутые альтернативы. Пустой `[]` ДОПУСТИМ (бинарное решение без альтернатив), но ключ обязан присутствовать — отсутствие ≠ «не было», отсутствие = нарушение red-line. |
| `rationale` | `string` (1..8000 chars) | да | Почему выбран X / отвергнуты остальные — ядро ответственности «кто/почему». |
| `confidence` | `number` (0.0..1.0) | нет | Опционально (Stage-2 autonomy-downgrade запаркован без критериев — здесь только переносим значение, порогов НЕ вводим). |
| `inputs_ref` | `InputRef[]` (0..N) | да (массив обязателен) | Ссылки-на-входы (НЕ значения): `{kind, ref}` — указатели на записи/гранты/процессные переменные, по которым принято решение. Зеркалит инвариант actor_event «references, never values» (018 §3.4) — чувствительные данные НЕ копируются в журнал. |
| `model_ref` | `string` | нет | Опц. идентификатор модели/версии промта агента (происхождение решения). |

`Alternative = { option: string (1..2000), rejected_because: string (1..4000) }`.
`InputRef = { kind: string (slug), ref: string }` — `ref` = непрозрачный
указатель (uuid/handle/key), НЕ инлайн-данные.

**Размещение:** `payload.reasoning = ReasoningTrace`. Остальные ключи payload
(actorType, goal, target_agent_id, …) сохраняются. Так как payload целиком
hash-покрыт, reasoning-trace становится tamper-detectable бесплатно (AC-7).

### 2.2. Контракт записи (КОГДА агент ОБЯЗАН писать трассу)

Статический **реестр decision-точек** в `reasoning-trace.ts`:

```
export const AGENT_DECISION_EVENT_TYPES = new Set<string>([
  "invoke.command",     // агент-диспетчер выбирает/запускает действие
  "task.completed",     // агент-external-task завершил шаг = принял решение по шагу
]) ;
```

Red-line-инвариант (fail-closed):

> Любое audit-событие, чей `type ∈ AGENT_DECISION_EVENT_TYPES` И чей
> `payload.actorType === "agent"`, ОБЯЗАНО нести валидный `payload.reasoning`.
> Решение агента в decision-точке БЕЗ reasoning-trace = НАРУШЕНИЕ.

Механика fail-closed на **границе энкодера** (НЕ в БД-триггере — БД не знает
семантику «agent-decision»; и НЕ опциональным best-effort):

- Pure-функция `attachReasoning(input: AuditEventInput, trace: ReasoningTrace): AuditEventInput`
  валидирует `trace` через `assertReasoningTrace` (бросает на нарушении формы) и
  возвращает новый input с `payload.reasoning` вмёрженным.
- Pure-функция `assertAgentDecisionHasReasoning(input: AuditEventInput): void` —
  единый guard: если `type ∈ AGENT_DECISION_EVENT_TYPES` и
  `payload.actorType==="agent"`, но `payload.reasoning` отсутствует/невалиден →
  `throw ReasoningTraceMissingError`. Вызывается из агентских call-site ДО
  `appendAuditEvent` (в той же `withTenantTx`, что и вставка → транзакция
  откатывается, строка НЕ пишется = fail-closed, нет «частичного» аудита).
- Человеческие/service-события (`actorType ∈ {human,service}`) guard пропускает —
  red-line только про агентские решения (объяснимость агента, не человека).

Производитель трассы — рантайм агента (вне ядра T-0139): он передаёт `reasoning`
вместе с goal/result. T-0139 проектирует **контракт и принуждение**, не сам LLM.
Для day-1 invoke-стаба (dispatch = no-op) reasoning исходит от вызывающего
(invoke body расширяется опц. полем `reasoning`, валидируемым тем же модулем);
когда Stage-2 подключит реальный рантайм — тот же guard принуждает его.

### 2.3. Tenant-изоляция и не-утечка чувствительного

- **Изоляция:** наследуется ПОЛНОСТЬЮ от `audit_event` RLS (006: ENABLE+FORCE
  RLS, policy на `choros.tenant_id` GUC, `choros_app` NOBYPASSRLS). reasoning
  внутри payload той же строки → tenant-изоляция автоматическая, нового пути нет.
- **Не утечка:** `inputs_ref` несёт ССЫЛКИ (kind+ref), НЕ значения — тот же
  инвариант, что actor_event «references, never values» (018 §3.4). `rationale`/
  `chosen_option` — человекочитаемый текст решения, НЕ сырые персональные данные;
  fitness-чек статически запрещает в reasoning-trace ключи-двойники сырых данных
  (`payload`/`record_data`/`secret`/`document_body`) на верхнем уровне trace, и
  data-classification-петля (T-0017кл.) остаётся ответственной за то, что агент
  не кладёт классифицированное в rationale (продуктовое правило промта, не схема).

---

## 3. Rejected alternatives

| Вариант | Почему нет |
|---|---|
| Отдельная таблица `reasoning_trace` с FK→audit_event | Плодит второй журнал (нарушает прямое требование задачи «аддитивно, не плодя второй журнал»), требует своего append-only+RLS+hash механизма, FK через append-only границу хрупок (ср. actor_event AC-21 явно ЗАПРЕЩает FK→audit_event). Несоразмерно. |
| Новая колонка `audit_event.reasoning jsonb` | Меняет набор колонок → меняет `CANONICAL_FIELD_ORDER` preimage → vocab bump (FF-3 golden flip, краснит всю цепь, ломает live-verifier). payload УЖЕ jsonb и УЖЕ hash-покрыт — колонка избыточна. |
| Положить трассу в `actor_event.detail` | actor_event — SoD-субстрат с pinned closed-vocab и БЕЗ hash-цепи (018 §2); объяснимость-под-ответственность требует tamper-evidence (hash), которого там нет by design. Decision-точки агента уже пишут в audit_event, не actor_event. |
| Best-effort/опциональная трасса (warn, не fail) | Нарушает red-line: «решение без трассы = нарушение». Опциональность = объяснимость, которую можно молча пропустить = провал ответственности. Принуждение обязано быть fail-closed. |
| Принуждение БД-триггером (CHECK payload?reasoning) | БД не знает, какое событие — «агентское решение» (это семантика типа+actorType, эволюционирующий реестр). CHECK на jsonb-ключ хрупок и дублирует реестр в SQL. Граница энкодера — единственное место, где известны и type, и actorType, и где уже проходит весь агентский аудит. |
| confidence-порог / autonomy-downgrade здесь | Запарковано в Stage-2 БЕЗ критериев разморозки (gap-map зона 3); вводить порог = новый нерешённый продуктовый выбор. Переносим значение, политику НЕ вводим. |

---

## 4. Fitness-функции

Каждая — исполнимый bash-чек в `ci/checks/`. **FF-RT-REDLINE** — главный red-line-инвариант, реализован двумя половинами (статической + тестовой), как `audit_actor_type_set`/`audit_append_only`.

| id | rule | ci_check |
|---|---|---|
| **FF-RT-REDLINE-STATIC** | Статическая половина red-line: каждый энкодер агентской decision-точки (`encodeInvokeAuditEvent` для `invoke.command`, `encodeLifecycleAuditEvent` для `task.completed`) и/или его call-site принуждает reasoning — т.е. в src присутствует `assertAgentDecisionHasReasoning`/`attachReasoning` на агентском пути, а реестр `AGENT_DECISION_EVENT_TYPES` непуст и содержит `invoke.command`+`task.completed`. Никакой агентский call-site не пишет decision-событие через `appendAuditEvent` минуя guard. | `ci/checks/reasoning-trace-redline.sh` |
| **FF-RT-REDLINE-TEST** | Тестовая половина red-line: unit-тест доказывает, что `assertAgentDecisionHasReasoning` БРОСАЕТ для события `type∈AGENT_DECISION_EVENT_TYPES` с `actorType==='agent'` без `payload.reasoning`, и ПРОПУСКАЕТ при валидном reasoning и для `actorType∈{human,service}`. Чек гоняет именно этот тест зелёным. | `ci/checks/reasoning-trace-redline.sh` (раздел test) |
| **FF-RT-SHAPE** | `assertReasoningTrace` принуждает форму §2.1: обязательны `decision`(slug-regex), `chosen_option`, `alternatives`(массив, может быть пуст), `rationale`, `inputs_ref`(массив); `confidence`∈[0,1] если задан; каждый `Alternative` имеет `option`+`rejected_because`; каждый `InputRef` — `kind`+`ref`. Невалидная форма → throw. Unit-тест покрывает каждое поле. | `ci/checks/reasoning-trace-shape.sh` |
| **FF-RT-APPEND-ONLY** | reasoning-trace НЕ ослабляет append-only: ни одной новой таблицы/колонки в `audit_event`; `CANONICAL_FIELD_ORDER` и `VOCAB_VERSION` в audit-preimage.ts НЕ изменены (reasoning живёт в payload, не в наборе колонок); нет нового GRANT UPDATE/DELETE на audit_event; reasoning-trace.ts не импортирует pg/http. | `ci/checks/reasoning-trace-append-only.sh` |
| **FF-RT-NO-LEAK** | Не-утечка: `inputs_ref` типизирован как ссылки (`kind`+`ref`), а не данные; `assertReasoningTrace` отвергает на верхнем уровне trace зарезервированные «сырые» ключи (`payload`,`record_data`,`secret`,`document_body`,`raw`). reasoning-trace.ts остаётся IO-free (нет network/LLM-вызовов из ядра). | `ci/checks/reasoning-trace-no-leak.sh` |
| **FF-RT-SINGLE-SINK** | Соразмерность/один путь: reasoning пишется ТОЛЬКО как `payload.reasoning` через канонический `appendAuditEvent` — нет второй таблицы `reasoning_trace`, нет `CREATE TABLE *reasoning*` в migrations/, нет второго sink. | `ci/checks/reasoning-trace-single-sink.sh` |

---

## 5. Traceability (AC → покрытие)

| AC | covered_by |
|---|---|
| AC-1: объектная модель trace (decision/chosen_option/alternatives/rationale/confidence?/inputs_ref) | §2.1 + FF-RT-SHAPE + `ReasoningTrace` type в reasoning-trace.ts |
| AC-2: трасса ложится в audit_event АДДИТИВНО (payload.reasoning, без нового журнала/колонки) | §2.1/§2.2 + FF-RT-SINGLE-SINK + FF-RT-APPEND-ONLY |
| AC-3: append-only + actor-vocab инварианты сохранены | §1/§2.1 + FF-RT-APPEND-ONLY (preimage/vocab/grants unchanged) |
| AC-4: red-line — агентское решение в decision-точке БЕЗ trace = FAIL (fail-closed) | §2.2 + FF-RT-REDLINE-STATIC + FF-RT-REDLINE-TEST |
| AC-5: реестр decision-точек явный и принуждаемый | §2.2 `AGENT_DECISION_EVENT_TYPES` + FF-RT-REDLINE-STATIC |
| AC-6: tenant-изоляция (RLS) reasoning | §2.3 (наследует audit_event RLS) |
| AC-7: tamper-detectable (hash-покрытие) | §1/§2.1 (payload = поле preimage) |
| AC-8: не утекает чувствительное (refs, не values) | §2.3 + FF-RT-NO-LEAK |
| AC-9: соразмерность (нет второй подсистемы) | §3 + FF-RT-SINGLE-SINK; контракт = pure-модуль + правки энкодеров |
| AC-10: confidence без новых порогов (Stage-2 парковка не размораживается) | §2.1/§3 (значение переносится, политики нет) |

---

## 6. Контракт для coder/tester (единые поля/типы)

```ts
// src/core/reasoning-trace.ts  (PURE, IO-free; no pg/http/https/net/fetch/child_process)
export interface InputRef { kind: string; ref: string }
export interface Alternative { option: string; rejected_because: string }
export interface ReasoningTrace {
  decision: string;            // ^[a-z0-9_.-]+$
  chosen_option: string;       // 1..2000
  alternatives: Alternative[]; // 0..N (массив обязателен; [] допустим)
  rationale: string;           // 1..8000
  inputs_ref: InputRef[];      // 0..N (массив обязателен)
  confidence?: number;         // 0.0..1.0
  model_ref?: string;
}
export class ReasoningTraceMissingError extends Error {}
export class ReasoningTraceShapeError extends Error {}

export const AGENT_DECISION_EVENT_TYPES: ReadonlySet<string>; // {invoke.command, task.completed}

export function assertReasoningTrace(t: unknown): asserts t is ReasoningTrace; // throws ReasoningTraceShapeError
export function attachReasoning(input: AuditEventInput, trace: ReasoningTrace): AuditEventInput; // returns input with payload.reasoning merged
export function assertAgentDecisionHasReasoning(input: AuditEventInput): void; // throws ReasoningTraceMissingError on agent-decision w/o valid reasoning
```

- `AuditEventInput` импортируется ВЕРБАТИМ из `audit-grant-encoder.ts` — НЕ переопределять.
- Call-site (invoke.ts / lifecycle-audit.ts agent-путь): вызвать `assertAgentDecisionHasReasoning(input)` ВНУТРИ той же `withTenantTx` ДО `appendAuditEvent` → throw откатывает транзакцию, строка не пишется (fail-closed).
- Все правки строго аддитивны; конституция/agents/control-plane не трогаются.

## 7. Escalation

Пусто. status=ready: red-line-решение принято фаундером (gap-map §3а); ADR
проектирует в его рамках. Новых нерешённых продуктовых выборов нет — confidence-
пороги/autonomy-downgrade явно оставлены в Stage-2-парковке без разморозки
(перенос значения ≠ ввод политики).
