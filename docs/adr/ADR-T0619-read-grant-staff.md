# ADR-T0619 — Covering READ-грант КАЖДОМУ нанятому человеку-сотруднику (охват назначения role-reader)

**Задача:** T-0619 (P0-фикс, security/RBAC) · опирается на T-0570 (READ-PDP), T-0573 (tenant-zero backfill).
**Статус:** ready.
**changes_product:** 1 (после мержа — LIVE_PROOF: сотрудник-человек логинится и видит записи).

---

## 1. Контекст (железный диагноз из LIVE_PROOF волны 2)

READ-PDP-гейт T-0570 АКТИВЕН и КОРРЕКТЕН. Ворота спрашивают тот же PDP,
что гейтит действия: запись видна актору только если у него есть покрывающий
READ-грант (`operation='read'`, `resource_type='record'`, scope покрывает узел
записи). `role-reader` держит платформенный default-open READ-грант на
`RESOURCE_ROOT` сентинел.

**Дефект — ОХВАТ назначения `role-reader`.** Роль `role-reader` назначается
ТОЛЬКО двум субъектам тенанта:
- владельцу (`tenant-owner` / `e-owner`) — `register.ts` шаг 3n;
- `assistant-agent` — `register.ts` шаг 3o.

Ни один логинящийся человек-сотрудник (нанятый через hire-флоу или
`POST /api/employees`) НЕ получает назначения `role-reader`. Следствие:
- `src/db/grants-dao.ts:253-266` `getGrantsForSubject` → 0 read/record-грантов;
- `src/http/records.ts` LIST (:1645-1654) отдаёт пусто, DETAIL (:1725-1734)
  кидает 404. Создатель не читает даже собственную только что созданную запись.

Механизм гранта РАБОТАЕТ (владелец имеет 1 грант на `RESOURCE_ROOT`). Чиним
ОХВАТ назначения роли, НЕ гейт.

Два места-близнеца охвата:
- `src/core/register.ts` шаги 3n/3o (~631-676): только владелец + ассистент.
- `migrations/117_default_read_grant_backfill.sql` части B/C: тот же охват.

Плюс третье место, ранее НЕ сидировавшее `role-reader` вовсе: **hire-флоу**
(`src/http/rights-intents.ts` `registerHire`, `POST /api/rights/intents/hire`) —
создаёт `employee(kind='human')` + `role_assignment` на роль позиции + гранты
пресета, но НЕ на `role-reader`.

---

## 2. Решение

**Базовый covering READ-грант выдаётся КАЖДОМУ нанятому человеку-сотруднику
тенанта — через назначение существующей платформенной роли `role-reader`.**

### 2.1 Выбор для hire-флоу: вариант (а) — назначать `role-reader` в самом hire-флоу

Рассмотрены два честных варианта:

- **(а) [ВЫБРАН]** В hire-флоу каждый нанятый **человек-сотрудник** получает
  `role_assignment` на существующую роль `role-reader` (ту самую, что держит
  default-open READ-грант владельца). Роль и её грант обеспечиваются идемпотентно
  (ensure-upsert: `role-reader` + covering READ-грант на `RESOURCE_ROOT`), затем
  идёт назначение — идемпотентно (WHERE NOT EXISTS: повторный найм того же
  человека не плодит дубль).
- **(б) [ОТВЕРГНУТ]** Привязать covering READ к **базовой роли позиции**, которую
  получают все hires.

**Почему (а), а не (б):** covering READ — свойство «сотрудник», а НЕ «эта
позиция/роль». Вариант (б) размазал бы default-open READ по КАЖДОЙ роли позиции
(их много, они специфичны кейсу — `role-approver` и т.п.), сделав грант
неотзываемым без переработки роли и нарушив D-064 (роли позиций несут кейс-слаги;
не место платформенному примитиву). Вариант (а) переиспользует ОДИН платформенный
`role-reader` — тот же механизм, что уже есть у владельца — минимальная и честная
поверхность. Сужение видимости (`sujenie`) остаётся актом grant-конфигурации
поверх (узкий грант делегируется от default-open через существующий
`validateNarrowing`), а не платформенным кодом (ратифицированная доктрина T-0570).

### 2.2 Граница «только человек, не агент»

Назначение `role-reader` в hire-флоу выдаётся ТОЛЬКО при `kind='human'`.
Бизнес-агентам read полагается по ИХ СОБСТВЕННЫМ грантам — отдельный контур
(agent-права). `assistant-agent` уже имеет назначение `role-reader` из
register.ts/117 — его контур не трогаем. Массовой раздачи `role-reader` агентам
НЕТ (security-граница).

### 2.3 Граница «role-reader НЕ обходит field-visibility» (композитный гейт)

`role-reader` = baseline «видит записи + читаемые поля». Это грант на
`record`/`read` со scope `RESOURCE_ROOT` и `resource_facet = NULL` (whole-resource
на УРОВНЕ ВИДИМОСТИ ЗАПИСИ). Он даёт **record-level visibility** (какая запись
видна), НО НЕ обходит **field-level redaction**:

- record-visibility-гейт (`isRecordReadable`) решает, попадёт ли строка в ответ;
- НЕЗАВИСИМО от него `applyFieldVisibilityRedaction` (records.ts, из
  `field-visibility.ts`) редактирует ПОЛЯ внутри видимой строки по
  `fvGrants`/`fvPolicy`. Скрытое поле физически ОТСУТСТВУЕТ в JSON независимо от
  наличия `role-reader`.

То есть гейт **композитный**: `role-reader` открывает «видишь запись», но поля
всё ещё режутся отдельным field-visibility-слоем. Это доказывается регресс-тестом
(FF-619-3): актор с `role-reader` видит запись, но скрытое field-visibility-поле
всё ещё редактируется. `role-reader` — covering READ на RESOURCE_ROOT, как у
владельца, НЕ super-grant.

### 2.4 Догоняющая миграция 123 — охват ВСЕГО персонала

`migrations/123_read_grant_all_staff_backfill.sql` — идемпотентная, tenant-scoped,
повторяет паттерн 117 частей B/C, но с ПОЛНЫМ охватом:

- **B'.** ensure `role-reader` роль для каждого тенанта (ON CONFLICT DO NOTHING —
  идемпотентно; переиспользует роль, созданную 117-A, если та уже есть).
- **C'.** ensure covering READ-грант (read/record/RESOURCE_ROOT) на `role-reader`
  для каждого тенанта (WHERE NOT EXISTS — идемпотентно; 117-D уже мог создать).
- **D'.** `role_assignment`: КАЖДЫЙ человек-сотрудник (`employee.kind='human'`)
  каждого тенанта → `role-reader` (CONFIRMED), WHERE NOT EXISTS (не плодит дубль,
  не трогает уже назначенных владельца/ранее-нанятых).

Охват — generic по «все `employee.kind='human'` тенанта», НЕ перечислением имён
персон (D-064). Set-driven `FROM choros.tenant` / `FROM choros.employee`, без
хардкода tenant-UUID (кроме платформенного `RESOURCE_ROOT` сентинела, не
являющегося tenant-id). Составные FK / RLS / ON CONFLICT — по конвенциям 117/118.

Агентам (`kind='agent'`) миграция `role-reader` НЕ выдаёт (граница §2.2);
`assistant-agent` уже покрыт 117-C.

---

## 3. Что НЕ трогаем

- Сам гейт: `src/http/records.ts`, `src/core/read-visibility.ts`,
  `src/db/resource-ancestry.ts`, `src/db/grants-dao.ts`, `src/server.ts` wiring —
  корректны, FROZEN (только импортируются/читаются).
- Frozen-ядро: `grant-resolver.ts`, `grant-lattice.ts`, `object-handle.ts`,
  `field-visibility.ts`.
- Пинованные к 117/118 гейты `ci/checks/read-pdp-no-hardcoded-tenant.sh` и
  `ci/checks/migrations/no-hardcoded-tenant-uuid.sh` (они сканируют ИМЕННО
  117/118 — не расширяем чужой frozen-предикат под своё имя; новая миграция 123
  соблюдает ту же анти-хардкод-дисциплину и покрыта СВОИМ db-тестом).
- Контур прав агентов.

---

## 4. Объектная модель (всё — существующие таблицы, НИ одной новой)

- `choros.role` (role-reader) — существующая; ensure ON CONFLICT DO NOTHING.
- `choros.role_assignment` (human → role-reader) — существующая; CONFIRMED,
  `org_scope = {kind:'set',members:[]}` (⊥, как owner-assignment T-0570),
  идемпотентно WHERE NOT EXISTS `(tenant_id, employee_id, role_id)`.
- `choros."grant"` (read/record/RESOURCE_ROOT на role-reader) — существующая;
  ensure идемпотентно.

Ни ALTER, ни новых столбцов, ни новых таблиц.

---

## 5. Контракты

- `src/http/rights-intents.ts` (additive, внутри той же `withTenantTx` hire-флоу):
  при `kind='human'` — ensure `role-reader` (роль + covering READ-грант на
  RESOURCE_ROOT, ON CONFLICT/NOT EXISTS) + `role_assignment(human → role-reader)`
  CONFIRMED (WHERE NOT EXISTS). Импорт `READER_ROLE_SLUG`, `RESOURCE_ROOT_NODE_ID`
  из `../core/read-visibility.js`. Публичная поверхность модуля не меняется.
- `migrations/123_read_grant_all_staff_backfill.sql`: три `INSERT … SELECT …
  FROM choros.tenant` / `FROM choros.employee` блока (ensure role, ensure grant,
  assign all humans), идемпотентно, без хардкода tenant-UUID.
- FROZEN (только импорт): read-visibility.ts, records.ts, grants-dao.ts,
  field-visibility.ts, register.ts (его сид владельца/ассистента не меняем — он
  корректен; hire-флоу — отдельный путь для нанятых людей).

> Примечание по register.ts (§2.5 напоминание): register.ts сидирует
> `role-reader` владельцу и ассистенту при СОЗДАНИИ тенанта. Нанятые ПОЗЖЕ люди
> проходят hire-флоу — там и добавлен охват. Диагноз называл 3n/3o как одно из
> двух мест-близнецов «охвата владельцу+ассистенту»; фактический охват НОВЫХ
> нанятых людей живёт в hire-флоу (register.ts не нанимает рядовых сотрудников),
> поэтому фронт-1 реализуется в rights-intents.ts, а не правкой 3n/3o. Это НЕ
> отклонение от диагноза: «два места-близнеца» (register.ts + migration 117)
> задавали ОХВАТ существующего владельца; T-0619 расширяет охват на ВЕСЬ персонал
> — новых через hire-флоу (код), существующих через миграцию 123 (backfill).

---

## 6. Fitness-функции

| id | правило | ci_check |
|----|---------|----------|
| FF-619-1 | Hire-флоу: нанятый `kind='human'` получает CONFIRMED `role_assignment` на `role-reader` + covering READ-грант существует; читает свою запись (LIST содержит, DETAIL 200). | `ci/checks/db/hire-read-grant.db.test.ts` (live PG): hire → getGrantsForSubject(hired) содержит read/record/RESOURCE_ROOT; GET /api/records видит запись. |
| FF-619-2 | Hire-флоу для `kind='agent'` НЕ добавляет `role-reader` (граница §2.2). | тот же db-тест: hire kind='agent' → нет role_assignment на role-reader. |
| FF-619-3 | `role-reader` НЕ обходит field-visibility: актор с role-reader видит запись, но скрытое field-visibility-поле редактируется (физически отсутствует). | `ci/checks/db/hire-read-grant.db.test.ts`: запись со скрытым полем + fvPolicy → record present, скрытый ключ absent. |
| FF-619-4 | Миграция 123: существующий рядовой человек-сотрудник ПОСЛЕ миграции читает запись (GET 200, не 404); WHERE NOT EXISTS ⇒ повторный прогон no-op; агент НЕ получает role-reader. | `ci/checks/db/migration-123-read-grant-staff.db.test.ts` (live PG): seed pre-fix тенант (owner+role-reader, рядовой человек БЕЗ назначения) → до миграции 0 грантов у рядового → применить 123 → 1 covering грант; идемпотентность; агент не затронут. |
| FF-619-5 | Tenant-изоляция граната не ослаблена: рядовой сотрудник тенанта A не читает записи тенанта B. | `ci/checks/db/migration-123-read-grant-staff.db.test.ts`: актор A c role-reader → запись B невидима/404 (RLS первичен). |
| FF-619-6 | Анти-кейс (D-064): в diff `src/` нет кейс-слагов персон (e-larina/e-orlov/e-configurator/role-approver/…); охват — generic по kind='human'. | существующий `ci/checks/read-pdp-anti-case.sh` (git-diff scoped по src/) — зелёный на этом diff. |
| FF-619-7 | Миграция 123 итерирует `FROM choros.tenant`/`FROM choros.employee`, без хардкода tenant-UUID. | статический assert внутри `migration-123-read-grant-staff.db.test.ts` (нет literal tenant-UUID кроме RESOURCE_ROOT-сентинела; есть FROM choros.tenant). |

---

## 7. Трассировка критериев приёмки

| AC | покрыто |
|----|---------|
| Нанятый человек получает role-reader и читает свою запись | §2.1 hire-флоу + FF-619-1 |
| Агент не получает role-reader массово | §2.2 + FF-619-2 |
| role-reader не обходит field-visibility (композитный гейт) | §2.3 + FF-619-3 |
| Существующий рядовой сотрудник читает записи после миграции | §2.4 миграция 123 + FF-619-4 |
| Tenant-изоляция не ослаблена | §2.4/§3 RLS + FF-619-5 |
| Анти-кейс (generic-механизм, без имён персон) | §2.4 + FF-619-6 |
| Идемпотентность + анти-хардкод миграции | §2.4 + FF-619-4/FF-619-7 |

---

## 8. runtime_target

`runtime:node` + Postgres. TS/HTTP-слой (`src/http/rights-intents.ts`) + backfill
Postgres-миграция (`migrations/123_read_grant_all_staff_backfill.sql`). Fitness:
live-PG vitest (`npm run fitness:db` на реальном PG :55432) + существующие
shell-линтеры (read-pdp-anti-case.sh). Внешний ресурс не требуется — миграция
применяется штатным `migrations/run.mjs` при деплое (гейт фаундера — сам деплой).

## 9. escalation

Пусто. Локализованный security-фикс охвата назначения роли поверх ратифицированной
доктрины T-0570; кросс-вендор-петля не нужна.
