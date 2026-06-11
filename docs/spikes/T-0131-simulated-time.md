# Spike T-0131 — Симулированное время на Flowable OSS 7.1.0

**Статус:** DONE — disposable spike  
**Дата:** 2026-06-11  
**Контекст:** T-0130 ADR §11 п.9 — «Stage-2 + Flowable-спайк заранее»; промотка таймеров/SLA в draft-прогоне (режим 2 автопрогона).  
**Среда:** `flowable/flowable-rest:7.1.0` (Apache 2.0), Postgres 16, docker-compose из `/docker-compose.yml` воркдерева T-0131.  
**Disclaimer:** disposable spike — код в этом документе НЕ регистрируется в фитнесс-тестах и НЕ является продакшн-кодом.

---

## Вопросы спайка

### Q1: Умеет ли Flowable OSS «подменить часы»?

**Ответ: Нет — глобального Clock API через REST не существует.**

Эксперимент:
```
GET  /flowable-rest/service/management/clock  → {"message":"Internal server error","exception":"No endpoint GET /flowable-rest/service/management/clock."}
POST /flowable-rest/service/management/clock  → {"message":"Internal server error","exception":"No endpoint POST /flowable-rest/service/management/clock."}
PUT  /flowable-rest/service/management/clock  → {"message":"Internal server error","exception":"No endpoint PUT /flowable-rest/service/management/clock."}
```

Flowable OSS `ProcessEngineConfiguration#setClock` / `ClockUtil.setCurrentTime(...)` существует только во внутреннем Java API (используется в Flowable unit-тестах через `FlowableRule`). Через REST-границу (T-0057: TS-only, внешняя REST-граница) этот механизм недоступен. Подтверждено экспериментально на реальном контейнере `flowable/flowable-rest:7.1.0`.

**Известные механизмы REST для управления временем таймеров:**
- `POST /management/timer-jobs/{id}` с `{"action":"move"}` — перемещает timer job из очереди таймеров в исполняемую очередь (`act_ru_job`), после чего async executor запускает его немедленно. **Работает. Результат HTTP 204.**
- `POST /management/timer-jobs/{id}` с `{"action":"reschedule","newDueDate":"..."}` — должен менять dueDate. **Не работает для PT-duration таймеров в Flowable 7.1.0:** возвращает HTTP 400 «Invalid reschedule timer action. Reschedule timer actions must have a valid due date.» для любого формата даты. Поведение идентично для `timeDate`, `timeDuration`, различных ISO-форматов.
- Прямое SQL UPDATE `act_ru_timer_job.duedate_` → **работает**: async executor подхватывает истёкший job в следующем polling-цикле (~5-10 сек).

---

### Q2: Практическая промотка — что реально сработало

#### Подготовка

Задеплоен BPMN-процесс `timerBoundaryTest2` с non-interrupting timer boundary (PT5M) на userTask:
```bash
# Деплой
curl -s -u admin:choros_flowable_dev_pw \
  -X POST http://localhost:8082/flowable-rest/service/repository/deployments \
  -F "file=@timer-boundary-test2.bpmn20.xml;type=text/xml"
# → HTTP 200 {"id":"3012c63b-...","name":"timer-boundary-test"}

# Старт инстанса
curl -s -u admin:choros_flowable_dev_pw \
  -X POST http://localhost:8082/flowable-rest/service/runtime/process-instances \
  -H "Content-Type: application/json" \
  -d '{"processDefinitionKey":"timerBoundaryTest2","variables":[]}'
# → {"id":"302340fe-...","ended":false}
```

Таймер-джоб появился в `act_ru_timer_job` с `duedate_ = NOW() + PT5M`.

#### (а) action=move — СРАБОТАЛО

```bash
TIMER_JOB_ID="3027add8-..."
curl -s -o /dev/null -w "%{http_code}" \
  -u admin:choros_flowable_dev_pw \
  -X POST "http://localhost:8082/flowable-rest/service/management/timer-jobs/$TIMER_JOB_ID" \
  -H "Content-Type: application/json" \
  -d '{"action":"move"}'
# → 204 (No Content) — успех
```

После move: таймер пропал из `act_ru_timer_job`; async executor подхватил и исполнил. Через ~10 секунд:
```bash
curl -s -u admin:choros_flowable_dev_pw \
  "http://localhost:8082/flowable-rest/service/runtime/tasks?processInstanceId=302340fe-..."
# → tasks: ["Wait for approval", "Escalation task"]  ← timer boundary сработал, escalation task создан
```

**Вывод:** `action=move` — промотка конкретного timer job по ID. **Работает через REST, HTTP 204.**

#### (б) action=reschedule — НЕ СРАБОТАЛО

```bash
curl -s -u admin:choros_flowable_dev_pw \
  -X POST "http://localhost:8082/flowable-rest/service/management/timer-jobs/$TIMER_JOB_ID" \
  -H "Content-Type: application/json" \
  -d '{"action":"reschedule","newDueDate":"2026-12-31T23:59:59.000Z"}'
# → 400 {"message":"Bad request","exception":"Invalid reschedule timer action. Reschedule timer actions must have a valid due date."}
```

Тестировались форматы: ISO 8601 с Z, с +0000, без Z, epoch ms, timerDuration, timerCycle. Все → HTTP 400 с идентичной ошибкой. Вывод: `reschedule` в Flowable 7.1.0 OSS через REST недоступен или требует формата, не задокументированного в публичном API. Возможно, функция зарезервирована для Enterprise/CMMN, либо требует timer типа `timeDate` c особым внутренним статусом.

#### (в) Прямое SQL обновление duedate_ — СРАБОТАЛО

```bash
PGPASSWORD=choros_dev_pw psql -h localhost -p 55433 -U choros_migrator -d choros \
  -c "UPDATE flowable.act_ru_timer_job SET duedate_=NOW() - INTERVAL '1 second' WHERE id_='$TIMER_JOB_ID' RETURNING id_, duedate_;"
# → UPDATE 1, duedate_ = 2026-06-11 18:58:11.136752
```

Async executor (polling interval ~5-10 сек) подхватил просроченный job и выполнил:
```
# ~10 секунд позже:
tasks: ["Wait for date-based timer", "Date Escalation task"]  ← timer сработал
```

**Вывод:** прямое обновление `duedate_` в Postgres + ожидание async executor polling — **рабочий механизм промотки**. Не публичный REST API, но предсказуемо и верифицировано.

---

### Q3: Ограничения — per-instance или глобальный clock?

**`action=move` — per-instance (по job ID). Изолирован.**

Эксперимент с двумя параллельными инстансами:
```bash
# Instance A — таймер сработал через action=move (Timer A ID)
curl -X POST .../timer-jobs/$TIMER_A_ID -d '{"action":"move"}'  → 204

# Instance B — таймер НЕ тронут
timer-jobs?processInstanceId=$INST_B_ID  → still has timer job, dueDate intact
tasks?processInstanceId=$INST_B_ID       → ["Wait for approval"]  (без escalation)
tasks?processInstanceId=$INST_A_ID       → ["Wait for approval", "Escalation task"]  ✓
```

**Промотка per-instance — нет конфликта с параллельными draft-прогонами.**  
Аналогично для SQL UPDATE: `WHERE id_='$SPECIFIC_JOB_ID'` — точечный, не global.

**Нет глобального clock API через REST** — нельзя случайно «сдвинуть время» для всего движка.

**SLA/эскалации при промотке:**  
Non-interrupting boundary event: при срабатывании таймера оба потока продолжают независимо (исходная задача + escalation task). Порядок корректен. Interrupting boundary event (cancelActivity=true) отменил бы исходную задачу — также корректно. Движок соблюдает BPMN-семантику независимо от способа промотки (move vs natural time expiry).

---

### Q4: Вывод для T-0130 ADR — рекомендованный механизм day-1

**Рекомендованный механизм:** `POST /management/timer-jobs/{job_id}` с `{"action":"move"}` — **публичный REST, per-instance, без глобального сайд-эффекта**.

| Критерий | action=move (REST) | SQL duedate_ update | Global clock (Java API) |
|---|---|---|---|
| Доступность через REST | **ДА** | НЕТ (Postgres напрямую) | НЕТ (Java только) |
| Per-instance изоляция | **ДА** (job by ID) | ДА (by job ID) | НЕТ (глобальный движок) |
| Предсказуемость | **ДА** (HTTP 204 = move подтверждён) | ДА, но async lag ~5-10 сек | N/A |
| Конфликт с параллельными прогонами | **НЕТ** | НЕТ | РИСК |
| Требует доступа к Postgres | **НЕТ** | ДА | НЕТ |
| SLA-порядок корректен | **ДА** (BPMN-семантика) | ДА | N/A |
| Зависимость от Enterprise | **НЕТ** | НЕТ | НЕТ |

**Стратегия промотки таймеров в draft-прогоне (T-0130 режим 2):**

1. При запуске `simulation_run` со сценарием: для каждого timer boundary/intermediate event, который должен «сработать» по сценарию — получить job ID через `GET /management/timer-jobs?processInstanceId={id}` + `elementId={timerElementId}`.
2. Вызвать `POST /management/timer-jobs/{job_id}` `{"action":"move"}` → HTTP 204.
3. Ждать появления ожидаемого следующего состояния (poll tasks / poll executions).

**Стоимость:** 1 REST-вызов на таймер. Латентность: async executor lag ~5-10 сек (polling interval).  
Это достаточно для mode-2 автопрогона (не real-time).

**Неосуществимо day-1:** «реальное» симулированное время (move engine clock → все future timers пересчитываются) — Stage-2 и требует либо кастомного job-runner с контролируемым clock, либо Flowable Spring boot тестового профиля (TestClockUtil). В production OSS REST image это недоступно.

---

## Ограничения и риски

1. **`reschedule` не работает** в Flowable 7.1.0 REST для duration-таймеров (возможно, и для date-таймеров). `action=move` — единственный рабочий REST-механизм принудительного срабатывания.
2. **Async executor lag:** после `action=move` таймер попадает в `act_ru_job`; executor подбирает его в следующем polling-цикле (~5-10 сек, конфигурируемо через `flowable.async-executor-activate`). В test-прогоне это приемлемо.
3. **Нет возможности «перемотать» несколько таймеров атомарно**: нужно вызывать move последовательно + ждать исполнения перед следующим. Для сложных процессов с цепочкой таймеров — sequential pattern.
4. **`action=move` идемпотентен только один раз**: после move job удаляется из timer-queue и исполняется; повторный вызов вернёт 404. Статус-машина draft-прогона должна трекать, какие таймеры уже промотнуты.
5. **Per-engine scope**: `action=move` работает на уровне одного Flowable engine (одного контейнера). В multi-engine конфигурации (Stage-2) потребуется routing к нужному engine — вне scope day-1.

---

## Рекомендация для T-0130 ADR

**Механизм day-1:** `action=move` через REST — осуществимо, изолировано, без Stage-2.  
**Паттерн:** simulation_run.step() → GET timer jobs (by processInstanceId + elementId filter) → POST action=move → poll until expected state.  
**Stage-2:** global clock manipulation (Flowable TestClockUtil/Spring profile) — custom job runner или тестовый Flowable profile; вне scope OSS REST image.  
**Verdict для T-0130 §11 п.9:** «симулированное время day-1 = per-timer action=move (REST, осуществимо); глобальный clock — Stage-2».
