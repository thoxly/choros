# ADR-T0632 — report-page Floor-1 агрегаты вычисляются по READ-PDP-видимому подмножеству

Status: ready
Task: T-0632 (security, столп 4)
Base: dev@aee684b, branch `task/T-0632-report-agg-readpdp`
Finding source: адверс-скептик T-0587; `docs/adr/ADR-T0587-analyst-pdp.md` §1.1
(«Почему НЕ Floor-1 report-builder»)

## 1. Проблема

`GET /api/report-pages/:id/render` (`src/http/report-page-render.ts::renderFloor1`
→ `buildAggSql`) считает `count/sum/avg/min/max/list` **сырым SQL по всей
таблице реестра**:

```sql
SELECT SUM((data->>'field')::numeric) AS agg_result
  FROM choros.record
 WHERE tenant_id = $1 AND registry_id = $2 [+ filter] [+ GROUP BY ...]
```

Единственный PDP-гейт на этом пути — `checkReadGrant` (`defaultCheckReadGrant`,
:167-286) — **application-level**: он проверяет, что actor держит грант
`read` на `resource_type='application'`, чья scope покрывает `page.app_id`.
Он НЕ проверяет ни одного **record-level** гранта. Итог: actor, чей READ-грант
на записи реестра сужен (record-scope грант, покрывающий только подмножество
строк — тот же примитив, что T-0570 R-5/T-0587 живьём доказывают для
`GET /api/records`/аналитик-чата), тем не менее получает `SUM`/`COUNT`/...
**по абсолютно всем строкам реестра**, включая те, которые он не вправе читать
поштучно. Разница между «правами на страницу» (application-грант) и «правами
на данные, которые страница суммирует» (record-грант) стёрта.

`ADR-T0587` §1.1 разведал этот код буквально и **сознательно отказался** его
переиспользовать для аналитика именно по этой причине («переиспользовать его
для аналитика значило бы посчитать сумму по записям, которые спрашивающий
читать не вправе — ровно та утечка, что FR-2/NF-1 запрещают»), но не чинил
сам `report-page-render.ts` — тот остался открытой дырой. T-0632 закрывает
именно её.

### 1.1 Сиблинг-утечка: /data (LEAK A из адверс-ревью)

Адверс-скептик (opus) на ревью первой итерации T-0632 нашёл, что закрыть
только `/render`+`/export` **недостаточно** — READ-PDP дыра report-page НЕ
замурована, пока течёт соседняя колонка той же стены: **`dataFloor2`
(`GET /api/report-pages/:id/data`)**. Этот эндпоинт делает полный **raw-row
дамп** (`SELECT id, data, created_at, updated_at ... WHERE tenant_id AND
registry_id` над ВСЕМИ записями реестра) + `SELECT COUNT(*)` как
`total_count`, гейтнутый **тем же** application-level `checkReadGrant` — БЕЗ
построчного `isRecordReadable`. Тот самый узкий record-scope актор, которого
защищает весь `/render`-фикс, через `/data` читает **полные данные КАЖДОЙ
записи** реестра + точный полный `total_count`, обходя record-level READ-PDP,
который `/render`-фикс только что добавил. `/data` — raw-row близнец
агрегатного `/render`; чинить надо оба. T-0632 (эта итерация) закрывает и его.

## 2. Решение — вариант (б): построчный `isRecordReadable` фильтр НАД
   bounded-fetched raw rows, агрегат считается в приложении (не в SQL)

Вместо SQL-агрегата `buildAggSql` теперь:

1. Строит **safe-parameterized SELECT сырых строк** (`id, data`) кандидатного
   окна реестра (тот же WHERE-предикат tenant/registry/filter, тот же
   charset+whitelist guard на `field_key`/`group_by`/`filter.field_key` —
   НИЧЕГО из существующих injection-инвариантов не убрано), ограниченный
   `AGG_SCAN_LIMIT` (bounded, mirrors `registry-digest-dao.ts`'s `scanLimit`).
2. Резолвит actor'а покрывающие READ-гранты + composite ancestry **ОДИН РАЗ**
   на весь render-вызов — **ТОТ ЖЕ** резолвер, что `records.ts`/
   `registry-digest-dao.ts`: `getGrantsForSubject` + `loadTenantOrgAncestry` +
   `makeResourceAncestryOracle` (NF-1 — single-resolver, не вторая система
   прав).
3. Фильтрует каждую загруженную строку через `isRecordReadable(rowAncestry,
   grants, ancestry, nowMs)` — **byte-identical predicate**, что
   `records.ts` LIST/DETAIL и `registry-digest-dao.ts`.
4. Аккумулирует агрегат (count/sum/avg/min/max/list, с опциональным
   `group_by`/`filter`) **в JS, в приложении**, СТРОГО над строками, прошедшими
   шаг 3 — новый чистый (IO-free) модуль `src/core/visible-record-agg.ts`,
   расширяющий паттерн `visible-aggregate.ts` (T-0587) до полного Floor-1
   vocab (group_by, list, filter — которых `visible-aggregate.ts` не покрывал,
   т.к. он писан только под дайджест-нужды аналитика).

Application-level `checkReadGrant` остаётся **первым** гейтом, ПЕРЕД
построчной фильтрацией (FR-3) — страница вообще не рендерится без него;
построчный READ-PDP — **второй, дополнительный** гейт поверх, никогда не
заменяет первый.

### 2.1 Почему (б), не (а) «raw per-row 404-style deny», не (в) «гейт по полному покрытию»

- **(а) per-row `isRecordReadable` без агрегации, отказ при первой невидимой
  строке** — отклонено: превратило бы ЛЮБОЙ агрегат по частично-видимому
  реестру в жёсткий отказ (403/пусто), даже когда честная частичная сумма
  была бы полезна и корректна (ровно то, что T-0587 §1.3 требует для
  content-ответов аналитика — «сумма по видимому подмножеству», не «всё или
  ничего»). Понижает полезность агрегата сильнее необходимого.
- **(в) гейт по полному покрытию реестра (если грант не покрывает весь реестр
  → отказ/пусто)** — отклонено по той же причине: узкий, но НЕПУСТОЙ,
  READ-грант (видит 1 из 2 записей) сегодня — легитимный, часто встречающийся
  сценарий (T-0570 FF-RP-5 test template, "narrow-actor sees record1 ONLY") —
  отвечать ему пустым агрегатом было бы менее честно, чем отвечать честной
  суммой по видимому подмножеству. Также несимметрично с уже принятым
  паттерном registry-digest-dao.ts (T-0587), который НЕ требует полного
  покрытия — он суммирует по видимому.
- **(б) построчный фильтр + JS-аккумуляция агрегата над видимым подмножеством**
  — выбрано: даёт ЧЕСТНУЮ сумму по видимым записям (как аналитик-чат),
  переиспользует byte-identical READ-PDP путь (NF-1), не вводит новую
  authority-математику (isNarrowerOrEqual/isRecordReadable остаются
  единственным источником решения "видна ли строка"), симметрично с
  T-0587's явно одобренным паттерном.
- Альтернатива «grant-scope SQL-предикат прямо в WHERE» (материализовать
  scope-containment как часть SQL, а не JS-фильтр после fetch) была
  рассмотрена и отклонена: `isNarrowerOrEqual`/`isEffective` (grant-lattice.ts)
  — чистые TS-функции над `AncestryOracle`, не SQL-выражения; переписывать их
  логику как SQL было бы ВТОРОЙ РЕАЛИЗАЦИЕЙ той же authority-математики
  (прямое нарушение NF-1/FR-7 T-0570 «один резолвер») с риском расхождения
  между SQL-версией и in-memory версией предиката. bounded-fetch + in-memory
  filter — единственный путь, не дублирующий authority-логику.

## 3. Что именно меняется в коде

- **`src/core/visible-record-agg.ts`** (новый, чистый, IO-free — зеркалит
  `visible-aggregate.ts`): принимает `(agg, fieldKey, groupBy?, filterPred?)`
  + поток уже READ-PDP-отфильтрованных `{id, data}` строк, накапливает
  `count/sum/avg/min/max` (числовые агрегаты, коэрс + `Number.isFinite`
  guard — тот же паттерн, что `accumulateNumeric`) или `list` (текстовые
  значения поля) — с опциональной группировкой по `group_by` (Map<groupKey,
  accumulator>). Независимо unit-тестируем без Postgres.
- **`src/http/report-page-render.ts`**:
  - `buildAggSql` → переименован/расщеплён на функцию, строящую **raw-row
    SELECT** (не агрегатный SQL) — тот же charset+whitelist guard на
    `field_key`/`group_by`/`filter.field_key`, тот же parameterized
    `filter.value`, тот же `AGG_SCAN_LIMIT` bound.
  - `renderFloor1`: после page-load + `checkReadGrant`, резолвит READ-PDP
    видимость **ОДИН РАЗ за весь render-вызов** (не по одному разу на
    metric/registry) через новый инъецируемый optional dep
    `resolveReadVisibility` на `ReportPageRenderAuthzDeps`-соседний параметр
    (см. §3.1) — mirrors `records.ts`'s `ReadVisibilityResolver`. Каждый
    metric теперь: fetch raw rows (bounded) → filter `isRecordReadable` →
    `visible-record-agg.ts` accumulate → результат.
  - Honest-degrade (NF-2): резолвер — **optional** параметр на уровне
    сигнатуры (не ломает существующие unit-тесты, которые его не передают),
    НО production-wiring (`src/server.ts`) ОБЯЗАН его подключить — это
    security-фикс, не add-on feature; когда резолвер отсутствует, поведение
    деградирует к СТАРОМУ (полный SQL-агрегат) — задокументировано как
    временная/тестовая деградация, не разрешённое production-состояние.
  - **`dataFloor2` (эндпоинт `/data`, LEAK A из адверс, §1.1)**: тот же
    паттерн, что `renderFloor1`. При наличии резолвера: fetch bounded
    candidate-окна (`AGG_SCAN_LIMIT`, тот же bound; join к `registry_def`
    ради `application_id` для `RowAncestry`, как в `registry-digest-dao.ts`) →
    per-row `isRecordReadable` фильтр → `total_count` = **число видимых**
    (НЕ `SELECT COUNT(*)`, который сам бы утёк точное число скрытых записей)
    → пагинация видимого подмножества in-memory (`slice(offset, offset+limit)`,
    зеркалит фильтр-по-загруженной-странице records.ts). Без резолвера —
    honest-degrade к старому пути (`SELECT COUNT(*)` + SQL LIMIT/OFFSET дамп),
    байт-в-байт как до T-0632.
  - `/process-analytics` (4-й роут файла) — **проверен, изменений не требует**:
    читает S3-журнал переходов (`loadCycleTimeByActivity`/
    `loadActorTypeBreakdown` над `audit_event`), не `choros.record`, не
    отдаёт данные конкретных записей — процессная телеметрия, а не
    record-scope READ-PDP поверхность (тот же класс, что T-0587 трактует
    S3-журнал как внутреннюю телеметрию, не сущностные данные).
- **`src/server.ts`**: `registerReportPageRenderRoutes` вызывается с новым
  резолвером, композиция байт-в-байт как `resolveReadVisibility` в
  `registerRecordRoutes` (:875-885) — `getGrantsForSubject` +
  `loadTenantOrgAncestry` → `makeResourceAncestryOracle`.
- **Unit-тесты** (`src/__tests__/report-page-render.test.ts`,
  `report-page-render-export.test.ts`): row-set фикстуры `{agg_result: X}`
  заменены на raw `{id, data}` record rows; остальная структура (authz deps,
  injection probes, WRONG_FLOOR, 401/403/404) не меняется.
- **Новый DB-тест** (`ci/checks/db/report-page-render-read-pdp.db.test.ts`):
  живой Postgres, два actor'а одного тенанта — широкий грант видит полный
  SUM, узкий record-scope грант видит SUM строго по своему подмножеству;
  actor без покрывающих record-грантов видит `count:0`; genesis-owner
  видит полный агрегат без изменений (регресс). **+ LEAK A `/data`-тест**:
  узкий актор через `/data` видит ТОЛЬКО свою запись + `total_count`
  видимых (не полный дамп/count); широкий — обе; 0-грант — пусто+0.

### 3.1 Сигнатура — аддитивная (NF-2/mirrors T-0570 records.ts pattern)

```ts
export type ReportAggReadVisibilityResolver = (
  actorSlug: string,
  tenantId: string,
  nowMs: number,
) => Promise<{ grants: Grant[]; ancestry: AncestryOracle }>;

export function registerReportPageRenderRoutes(
  router: Router,
  _poolHint?: pg.Pool,
  deps: ReportPageRenderAuthzDeps = defaultRenderAuthzDeps,
  resolveActorTenant?: ActorTenantResolver,
  resolveReadVisibility?: ReportAggReadVisibilityResolver, // NEW, optional, additive
): void
```

Существующие вызовы (`registerReportPageRenderRoutes(router)`,
`registerReportPageRenderRoutes(router, pool, deps, resolveActorTenant)`)
компилируются без изменений — параметр добавлен в конец, optional.

## 4. Отклонённые альтернативы (сводка)

| Вариант | Почему отклонён |
|---|---|
| (а) per-row deny (403/пусто на первой невидимой строке) | Понижает полезность агрегата сильнее необходимого; не даёт честную частичную сумму. |
| (в) гейт по полному покрытию реестра | Несимметрично с T-0587's принятым "sum over visible subset" паттерном; узкий-но-непустой грант — легитимный сценарий. |
| SQL scope-containment предикат в WHERE | Дублирует TS-authority-математику (isNarrowerOrEqual/isEffective) в SQL — вторая реализация той же логики, риск расхождения. NF-1 нарушение. |
| Переиспользовать `visible-aggregate.ts` как есть | Не поддерживает `group_by`/`filter`/`list` — специфичный Floor-1 vocab (ADR-T0121 §4); потребовалась генерализация (`visible-record-agg.ts`), не прямое переиспользование. |

## 5. Fitness functions

| id | rule | ci_check |
|---|---|---|
| FF-RAGG-1 | `buildAggSql`-путь никогда не отправляет `SELECT <AGG>(...)` без предварительного построчного `isRecordReadable` фильтра над fetched rows | `ci/checks/db/report-page-render-read-pdp.db.test.ts` (два actor'а, узкий грант → усечённый агрегат) |
| FF-RAGG-2 | READ-PDP видимость резолвится через getGrantsForSubject+loadTenantOrgAncestry+makeResourceAncestryOracle — single-resolver, не вторая authority | `ci/checks/grant-resolver-isolation.sh` (frozen modules unchanged) + code review (no new ACL store token) |
| FF-RAGG-3 | Existing charset/whitelist/parameterized-filter/withTenantTx invariants unchanged | `ci/checks/report-page-render-isolation.sh` |
| FF-RAGG-4 | Анти-кейс: ни один добавленный литерал не кейс-специфичен | `ci/checks/read-pdp-anti-case.sh` + `ci/checks/anti-case-lock.sh` |
| FF-RAGG-5 | genesis-owner видит полный агрегат (регресс) | `ci/checks/db/report-page-render-read-pdp.db.test.ts` (AC-owner-full) |
| FF-RAGG-6 | `/data` (dataFloor2) raw-дамп фильтруется построчным `isRecordReadable`; `total_count` = число видимых (не `SELECT COUNT(*)`) | `ci/checks/db/report-page-render-read-pdp.db.test.ts` (LEAK A: узкий/широкий/0-грант) + `src/__tests__/report-page-render.test.ts` (AC-DATA-1/2/3) |

## 6. Traceability

| AC (T-0632.spec.md) | covered_by |
|---|---|
| AC-1 | `ci/checks/db/report-page-render-read-pdp.db.test.ts` — narrow-vs-wide grant sum comparison |
| AC-2 | `ci/checks/db/report-page-render-read-pdp.db.test.ts` — zero-grant actor → count:0 |
| AC-3 | `ci/checks/db/report-page-render-read-pdp.db.test.ts` — genesis-owner unaffected |
| AC-4 | `src/__tests__/report-page-render.test.ts` (updated fixtures) |
| AC-5 | `ci/checks/report-page-render-isolation.sh` |
| AC-6 | `ci/checks/read-pdp-anti-case.sh`, `grant-resolver-isolation.sh`, `http-route-auth-coverage.sh`, `anti-case-lock.sh` |
| AC-7 | `npm run fitness:db` |
| AC-8 | LIVE_PROOF section, docs/handoff/T-0632.pr-handoff.json |
| LEAK A (/data sibling) | `ci/checks/db/report-page-render-read-pdp.db.test.ts` (LEAK A block) + `src/__tests__/report-page-render.test.ts` (T-0632 LEAK A block, AC-DATA-1/2/3), мутационно красный до фикса |

## 7. LEAK B (адверс, LOW) — `truncated` как pre-fetch coarse-signal: ACCEPTED as-is

Адверс отметил (LOW): `truncated:true` на `/render` при ≥`AGG_SCAN_LIMIT`
записях раскрывает узкому актору «≥5000 записей матчат» — pre-fetch count,
вычисленный ДО построчного фильтра. **Решение: оставить как есть,
задокументировать.**

Причины: (1) это **байт-в-байт** совпадает с уже принятым прецедентом
T-0587/`registry-digest-dao.ts` (`recRes.rows.length === scanLimit`) — тот же
coarse `≥scanLimit`-сигнал, никогда не точный count; менять здесь = ломать
установленную симметрию одного механизма на двух поверхностях. (2)
Семантически `truncated` ДОЛЖЕН означать «окно скана кандидатов могло быть
неполным» (свойство pre-filter окна), а НЕ «видимое подмножество неполно» —
реестр из 5000 кандидатов с 3 видимыми строками всё равно обязан нести флаг
усечения, иначе агрегат молча недо-считает без сигнала. Вычислять `truncated`
из visible fold-count было бы **некорректно**, а не только несимметрично. (3)
Сигнал грубый (`≥5000`, не точное число) и никогда не раскрывает данные
конкретной невидимой записи — только факт «реестр большой». Задокументировано
в коде (комментарий у `const truncated = ...`) и здесь как accepted coarse
signal, consistent with T-0587.
