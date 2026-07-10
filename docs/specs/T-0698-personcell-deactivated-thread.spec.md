# T-0698 — протянуть deactivated_at до PersonCell (P2 из адверс-судьи T-0673)

Task: T-0698 (anti-UUID/столп 4, D-064, эпик E-UX-HUMAN T-0647)
Base: dev, branch `task/T-0698`

## Контекст

T-0673 добавила `PersonCell` (`web/src/screens/screen-app-records.jsx`) —
рендерит person-типизированное поле записи через `ActorChip` с проп
`deactivated={Boolean(hit && hit.deactivated)}`, где `hit` — запись из
батч-загруженной `Map<id, {id,name,deactivated?}>` (`employeesById`,
построена из `fetchEmployees()`).

Адверс-судья T-0673 нашёл: `deactivated` был ВСЕГДА `false` в проде.
Причина — обрыв протяжки на **двух** звеньях цепи:

1. `listOrgTree` (`src/db/org.ts`) — SQL-запрос `empRows` не селектил
   `e.deactivated_at`; `OrgPerson` тип не нёс поля деактивации вовсе. Это
   первый обрыв: `GET /api/org`'s `people[]` физически не мог нести сигнал.
2. `fetchEmployees()` (`web/src/forms/field-renderer.jsx`) — даже если бы
   `/api/org` начал отдавать поле, `fetchEmployees()`'s `employees.push({id,
   name, position})` не копировал бы его в плоский список, потребляемый
   `screen-app-records.jsx`.

Юнит-тест T-0673 (`screen-app-records.test.jsx`, "threads deactivated
through…") зелёный, но строит `employees` РУКОТВОРНО:
`new Map([['emp-slug-1', {id, name, deactivated: true}]])` — эта Map никогда
не производится реальным кодом. Тест доказывает только, что `PersonCell` сам
по себе правильно прокидывает `hit.deactivated` в проп `ActorChip` — не
доказывает, что реальная цепь `/api/org` → `fetchEmployees()` → `Map` когда-
либо кладёт туда это поле. Ложное покрытие: судья, инбокс-ActorChip уже видит
маркер (T-0648's `batchResolveActors`/`ResolvedActor.deactivated`), а
записи — нет, при зелёном тесте.

## Эталон протяжки (для сверки)

Инбокс-ActorChip (T-0648, `src/db/actor-resolver.ts::batchResolveActors`)
уже решает ровно эту задачу для audit/inbox/grant-trail:

```ts
deactivated: row.deactivated_at != null,   // ResolvedActor — BOOLEAN, не дата
```

`ActorChip`'s собственный контракт (`web/src/components/components.jsx`)
принимает `deactivated: boolean` (default `false`) и рендерит приглушённый
стиль + «(деактивирован)» в тултипе/accessible-name. T-0698 воспроизводит тот
же контракт для `/api/org`, а не изобретает второй.

## Functional

- F1. `listOrgTree` (`src/db/org.ts`) селектит `e.deactivated_at` в
  `empRows`-запросе и кладёт в каждый `OrgPerson`
  `deactivated: e.deactivated_at != null` — BOOLEAN, сырая `deactivated_at`
  наружу НЕ уходит (см. §Non-functional/приватность).
- F2. `OrgPerson` тип (`src/db/org.ts`) получает `deactivated?: boolean`
  (опционально — dev-no-db `ORG_SEED` в `src/http/org.ts` не несёт этого
  поля и остаётся валидным `OrgPerson`).
- F3. `fetchEmployees()` (`web/src/forms/field-renderer.jsx`) копирует
  `deactivated: Boolean(p.deactivated)` в каждый сплющенный элемент —
  additive-поле, как уже сделано для `position` (T-0649).
- F4. `PersonCell` не меняется — уже корректно читает `hit.deactivated`
  (T-0673). Фикс закрывает ИСТОЧНИК, не потребителя.
- F5. Рабочий кейс: открыть запись со ссылкой на деактивированного
  исполнителя (person-поле) → `PersonCell`/`ActorChip` показывает
  приглушённый стиль + «(деактивирован)» в тултипе — идентично тому, что
  уже видно в /audit, /inbox, /rights/trail для того же сотрудника.

## Non-functional

- N1. **Приватность/минимизация данных**: наружу уходит ТОЛЬКО boolean
  `deactivated`, никогда сырой `deactivated_at` (timestamp увольнения —
  потенциально чувствительная HR-деталь: КОГДА именно человек был
  деактивирован). Мирроринг T-0648's `ResolvedActor.deactivated` —
  единственного существующего прецедента вынесения этого сигнала за пределы
  `src/db/`. `GET /api/org` уже широко доступен (любой аутентифицированный
  член тенанта, без `mgmt_object:*` гейта — питает PersonPicker/PersonCell на
  каждом экране записи), поэтому boolean-маркер не создаёт нового класса
  утечки: тот же boolean уже доступен той же аудитории через
  audit/inbox/grant-trail (все просто `withAuth`, без admin-гейта).
- N2. Zero new authority/query path: та же `listOrgTree`, тот же
  SQL-запрос — добавлена одна колонка в SELECT, ноль новых round-trip'ов.
- N3. Обратная совместимость: `deactivated_at`-select — аддитивная колонка
  (T-0588 прецедент того же файла); существующие потребители `OrgPerson`
  (findEmployeeById, ORG_SEED) не меняют сигнатур.
- N4. Мутационно доказуемый тест: серверный тест на живом PG должен падать
  на до-фикс коде (people[] без поля/всегда false для деактивированного) и
  проходить после. Клиентский тест строит `employees` через РЕАЛЬНЫЙ
  `fetchEmployees()` (мок fetch на реалистичном ответе `/api/org`), не
  рукотворную Map.
- N5. Анти-кейс (D-064): без кейс-специфичных слагов/должностей в src/ —
  синтетические фикстуры в тестах ("Human One"/generic slugs), как уже
  делает T-0649's `fetchEmployees` тест.

## Out of scope

- `findEmployeeById` уже несёт `deactivatedAt` (число|null, T-0588) для
  своих собственных вызывающих — не трогается, другой контракт (single-
  employee lookup, не батч-дерево).
- Любые другие места, где `deactivated_at` мог бы понадобиться на клиенте
  (кроме PersonCell/`/api/org`) — вне охвата этой задачи.
- UX/визуальный стиль маркера деактивации — уже реализован в `ActorChip`
  (T-0648 FIX-3), не меняется.

## Acceptance criteria

- AC-1: `GET /api/org` (live PG) → `people[]` несёт `deactivated: true` для
  сотрудника с непустым `employee.deactivated_at` и `deactivated: false`
  (или отсутствие true) для активного — мутационно доказано (тест красный
  на до-фикс `listOrgTree`).
- AC-2: `fetchEmployees()`, given a realistic `/api/org` response with one
  deactivated and one active human, flattens `deactivated: true`/`false`
  correctly (заменяет/дополняет T-0649's точное `toEqual`-покрытие формы).
- AC-3: клиентский честный тест — Map построена РЕАЛЬНЫМ `fetchEmployees()`
  (не рукотворно) → `PersonCell` на деактивированном id получает
  `deactivated: true` на `ActorChip`.
- AC-4: `tsc`/vitest (web + server затронутые файлы) зелёные.
