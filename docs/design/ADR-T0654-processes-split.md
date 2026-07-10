# ADR-T0654 — «Процессы»: серверные query-параметры + разнесение на две зоны

Спека: `docs/tasks/T-0654.spec.md`. Статус: `ready` (часть A строится сейчас; B/C/D — под-задачи).

## Решение (одним абзацем)

`GET /api/processes` получает единый **чистый пайплайн выборки** над уже tenant-scoped
проекциями: `filter → sort → paginate`, вынесенный в ЧИСТЫЕ экспортируемые функции
(`parseProcessListQuery`, `selectProcessPage`) в `src/http/processes.ts` (модуль остаётся
pg-free — FF-DISPLAY-4). Фильтры (`q/definition/status/started_from/started_to/mine/record`)
и пагинация (`limit/offset`) применяются ПОСЛЕ проекции, поэтому не могут расширить
видимость. Live-overlay движка применяется ТОЛЬКО к странице (≤ limit engine-читок), а не ко
всем ≤500 проекциям. Стартер-идентичность (`starterActorId`) протягивается на
`InstanceProjection` и резолвится в человеко-имя батчем через уже вшитый `resolveActorsDisplay`
(T-0648). UI-зоны (грид «Работа» + Каталог «Конструктор») — отдельные под-задачи, потому что
это два продуктовых слоя и мега-диф для одного ревью (рубрика ось 5, соразмерность).

## Отвергнутые альтернативы

- **SQL-пагинация в самой `listInstanceProjections`.** Отвергнуто: проекция — это ФОЛД
  audit-событий (process.started + next_task + ended + approved), не таблица; постранично
  фолдить по occurred_at честно нельзя (инстанс может не иметь события в окне). Окно фолда
  (≤500, `readEvents` cap) — существующий потолок; API-пагинация над ним пропорциональна и
  повторяет прецедент T-0708/T-0710 (query-параметры как самостоятельный слой).
- **Фильтровать на `InstanceProjection[]` (numeric startedAt) в DB-пути и на
  `ProcessInstance[]` в no-DB-пути.** Отвергнуто: два пути фильтрации разъедутся. Вместо —
  ОДНА чистая функция над `ProcessInstance[]` + additive `startedAtMs` (numeric), заполняемый
  из проекции; seed/pack без него → дата-фильтр к таким инстансам не применяется (unknown
  проходит), `mine` их отсекает. Единый код, тестируется и в no-DB (seed), и в DB.
- **Переиспользовать `ListViewPanel` (records-грид) для процессов.** Отвергнуто для части B:
  `ListViewPanel` глубоко завязан на registry_def/schemaColumns/serverSortable-типы полей;
  адаптация под non-records source непропорциональна. Часть B рендерит грид по СТАТИЧЕСКОМУ
  каталогу `PROCESSES_VIEW_COLUMNS` + плотность (лёгкий source-config T-0653), сохранённые
  личные виды процессов — отдельный follow-up (волна B оригинальной нарезки §5).
- **Строить всё четыре части одним PR.** Отвергнуто: 2 зоны, ~1000 LOC нового UI, мега-диф
  → дробление (см. spec §Дробление), явно приветствуемое оркестратором.

## Объектная модель (изменения контракта)

`InstanceProjection` (src/http/process-projection.ts) — additive:
- `starterActorId: string` — id актора-стартера (= `row.actor`, тот же, что кормит
  `resolveActorKinds`). Всегда присутствует.

`ProcessInstance` (src/http/processes.ts) — все additive/опциональные:
- `startedAtMs?: number` — numeric epoch старта (DB-путь; отсутствует у seed/pack).
- `starterId?: string` — id стартера (DB-путь).
- `starterName?: string` — резолвнутое человеко-имя стартера (best-effort, T-0648).
- `starterType?: "human"|"agent"|"service"` — тип стартера (из проекции/резолвера).

Ответ `GET /api/processes`: `{ instances: ProcessInstance[], total: number, limit: number,
offset: number }` (+ `demo:true` в no-DB+pack-absent). Поле `instances` не меняет форму
элементов сверх additive-полей — обратная совместимость.

## Контракты (сигнатуры, чистые + экспортируемые)

```ts
interface ProcessListQuery {
  q: string | null; definition: string | null; status: string | null;
  startedFrom: number | null; startedTo: number | null;
  mineActor: string | null;   // actorSlug когда ?mine, иначе null
  record: string | null; limit: number; offset: number;
}
function parseProcessListQuery(req: IncomingMessage, actorSlug: string | null): ProcessListQuery;
function selectProcessPage(instances: ProcessInstance[], q: ProcessListQuery):
  { page: ProcessInstance[]; total: number };  // filter → sort(startedAtMs desc, id asc) → slice
```

## Fitness-функции (машинно-проверяемые)

- **FF-1 (anti-case-lock).** Пайплайн не содержит кейс-констант (слаги/имена процессов) —
  только платформенные поля (name/procId/id/node/status/startedAtMs/starterId). Гейт:
  `ci/checks/anti-case-lock*` + detel-*. Проверка: grep по добавленным строкам.
- **FF-2 (display-plane isolation).** `src/http/processes.ts` не импортирует `pg`/`src/db/*`.
  Гейт: существующий FF-DISPLAY-4/FF-7-3. Проверка: import-grep этого файла.
- **FF-3 (тотальный детерминированный порядок).** `selectProcessPage` при равном `startedAtMs`
  ломает ничью по `id` ASC; инстансы без `startedAtMs` — после known, тоже по id ASC. Гейт:
  unit-тест (перетасованный вход → идентичный выход).
- **FF-4 (честная пагинация).** `total` === длине отфильтрованного набора; `page` = чистый
  slice; строки не фабрикуются, не дублируются. Гейт: unit-тест (offset за пределами → пустая
  страница, total неизменен).
- **FF-5 (фильтр не расширяет видимость).** Все фильтры применяются к УЖЕ tenant-scoped
  списку (после проекции). Гейт: тест — чужой record/definition даёт пусто, не чужие строки.
- **FF-6 (live-overlay только на странице).** `overlayDetailLiveSteps` вызывается на ≤ limit
  проекциях (страница), не на всех. Гейт: код-ревью + тест на счётчик engine-читок (stub).
- **FF-UX-B/C (для под-задач B/C, D-062/OBLIK).** Честные Empty/Loading/Error; нет мёртвых
  affordance; контраст ≥ WCAG AA обе темы; стартер/бейдж ≡ контент; без dev-жаргона. Гейт:
  `ci/checks/ux/*` (G2/G5/G7).

## Трассировка (часть A)

| AC | Покрыто |
|----|---------|
| A1 q | `parseProcessListQuery` + `selectProcessPage` фильтр по name/procId/id/node |
| A2 definition | фильтр `procId ===` |
| A3 status | фильтр `status ===` |
| A4 dates | границы `startedAtMs`; unknown проходит |
| A5 mine | `starterId === mineActor`; unknown отсекается |
| A6 limit/offset | clamp + slice; ответ `{total,limit,offset}` |
| A7 sort | `sortByStartedDescIdAsc` |
| A8 не расширяет | фильтр после проекции; `?record=` компонуется |
| A9 стартер | `InstanceProjection.starterActorId` + additive поля + `resolveActorsDisplay` |
| A10 isolation | processes.ts pg-free; overlay только страницы |

## runtime_target

Локально / контейнер (тот же, что весь `src/http`). Внешних ресурсов часть A не требует.
Live-proof стенда — offline на момент сдачи (план в `T-0654.pr-handoff.json`).

## escalation

Пусто. Решение среднего рычага (query-слой + дробление UI); не меняет направление продукта.
Дробление UI-зон — организационное, не архитектурный кросс-вендор-выбор.
