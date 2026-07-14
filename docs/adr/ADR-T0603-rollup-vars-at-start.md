# ADR-T0603 — Сервер распознаёт embedded-флейвор роллапа; сумма доезжает до Flowable при create=start

**Status:** ready
**Phase:** DESIGN
**Task:** T-0603 [приёмочный P0 2026-07-03]
**Date:** 2026-07-03
**Спека:** `docs/specs/T-0603-rollup-vars-at-start.spec.md` + `docs/specs/T-0603.spec.contract.json` (AC-1..AC-12)
**База:** dev @ `c6db7b8` (ветка `task/T-0603-rollup-vars-at-start`)
**Предшественники:** T-0407 (rollup-contract + DAO), T-0452/T-0453 (UI computed → embedded x-rollup),
T-0575 (BUG-016 derived-precompute overlay), T-0351/E16 (create=start seam).

---

## 1. Решение

**Сервер учится распознавать ОБА флейвора роллапа, живущих под ключом `x-rollup`,
и считать embedded-флейвор чисто in-memory из `record.data`.** Никаких изменений
storage, HTTP-маршрутов, доктрины create=start-атомарности. Единый путь распознавания
чинит и create=start (`amount` доезжает числом), и READ (`derived`-map перестаёт
расходиться с UI).

### 1.1 Дельта A — `rollup-contract.ts`: два флейвора, явный дискриминатор (F1/F2, AC-1/AC-6)

Сегодня `RollupFieldDef` = только child-records-флейвор:
`{ source_registry_id, ref_field, aggregate, value_field? }`. UI же (T-0452,
`apps-schema.js:461`) пишет embedded-флейвор: `{ source, op, value_field?, factor_field? }`.
`validateRollupFieldDef` требует `source_registry_id` (UUID) первым же чеком —
embedded-аннотация проваливается, `extractDerivedFields` её молча выкидывает.

Вводим второй тип и второй парсер, с ЯВНЫМ дискриминатором флейвора (не «попробуй один,
не вышло — попробуй другой», а решение по форме):

```ts
export interface EmbeddedRollupFieldDef {
  readonly source: string;       // ключ collection-под-поля в record.data (массив строк)
  readonly op: RollupAggregate;  // тот же closed-set {sum,count,avg,min,max}
  readonly value_field?: string; // ячейка строки для агрегации (нет для count)
  readonly factor_field?: string;// множитель для op:sum (по умолчанию 1)
}

// dispatchRollupFlavor(raw): raw.source_registry_id присутствует → child-парсер;
//                            иначе raw.source присутствует → embedded-парсер;
//                            иначе → отвергнуть (ни того, ни другого).
```

`validateRollupFieldDef` (child) остаётся дословно как есть. Новый
`validateEmbeddedRollupFieldDef`: `source` — non-empty string; `op ∈ ROLLUP_AGGREGATES`;
`value_field` required для sum/avg/min/max, absent для count (та же дисциплина, что
child); `factor_field` — optional non-empty string, только осмыслен для sum
(валидатор его допускает при любом op, компьют игнорирует вне sum — зеркалит
`records-form.js`, где factor читается только в ветке `op==='sum'`).

`DerivedFieldSpec` расширяется третьим вариантом union:
```ts
| { kind: "rollup";          fieldKey; def: RollupFieldDef }          // child (как было)
| { kind: "rollup-embedded"; fieldKey; def: EmbeddedRollupFieldDef }  // новый
| { kind: "matrix-lookup";   fieldKey; def: MatrixLookupFieldDef }
```

`extractDerivedFields`: встретив `x-rollup`, вызывает диспетчер флейвора и пушит
соответствующий `kind`. Невалидные аннотации по-прежнему молча пропускаются
(defensive — схема валидировалась на запись). Матрикс-lookup не трогается.

### 1.2 Дельта B — чистый embedded-компьют (F3, AC-2/AC-3/AC-4/AC-5)

Новая ЧИСТАЯ функция (в `rollup-contract.ts`, рядом с контрактом — pure, no I/O,
как `validate*`): `computeEmbeddedRollup(def, recordData): number | null`. Семантика
ДОСЛОВНО зеркалит `web/src/screens/records-form.js::computeRollup` (эталон, N2):

- `recordData[def.source]` должно быть массивом; иначе → `null`.
- `count`: `rows.length === 0 ? null : rows.length` (value_field игнорируется).
- `sum/avg/min/max`: собрать числовые `value_field`-ячейки (строки коэрсятся через
  `Number`, нечисловые/пустые/NaN пропускаются). Для `sum` при заданном `factor_field`:
  `value × factor`, factor по умолчанию 1 (нечисловой factor → 1). Пустой список
  собранных значений → `null`.
- `sum` = Σ; `avg` = среднее; `min`/`max` соответственно.

Эта функция ЧИСТА и живёт в core (не в DAO), т.к. embedded-роллап НЕ ходит в БД —
источник (массив) уже в `record.data`. Это архитектурно параллельно
`computeMatrixLookupValue`, который тоже читает оси из `recordData` в памяти
(хотя тот ради нормативной таблицы всё же делает PK-скан; embedded-роллап не
делает и его).

### 1.3 Дельта C — `derived-fields-dao.ts`: роутинг по `kind` (F4)

`computeAllDerivedFields` (`:238-272`) сейчас: `spec.kind === "rollup"` → SQL;
иначе → matrix. Добавляем третью ветку:
```ts
if (spec.kind === "rollup")            → computeRollupValue (SQL по детям, как было)
else if (spec.kind === "rollup-embedded") → { ok:true, value: computeEmbeddedRollup(spec.def, recordData) }  // in-memory, без client
else                                    → computeMatrixLookupValue (как было)
```
Embedded-ветка НЕ использует `client` — чистый компьют из уже-переданного
`recordData` (тот же параметр, что matrix-lookup читает). Ноль новых SQL, ноль
новых round-trip.

### 1.4 Точки применения — БЕЗ изменений кода в них (F5/F6)

- **create=start** (`records.ts:838-869`): код НЕ меняется. `extractDerivedFields`
  теперь вернёт embedded-spec, `computeAllDerivedFields` посчитает значение,
  overlay `{ ...projectionSource, ...derived }` положит `total` → сумму,
  `projectEngineVariables` спроецирует `amount` = число. Пустая коллекция → `null`
  → `amount:null` → условие `${amount>500000}` детерминированно false (N6, тот же
  контракт). SAVEPOINT-обёртка сохраняется (F7): embedded-компьют чист, но при
  child/matrix в той же схеме savepoint по-прежнему страхует.
- **READ** (`records.ts:1683`): код НЕ меняется. Тот же `extractDerivedFields` +
  `computeAllDerivedFields` теперь наполняют `derived[fieldKey]` — расхождение
  UI↔сервер закрывается автоматически.

Оба call-site уже передают `recordData`/`projectionSource` в `computeAllDerivedFields`
— эта задача только заставляет распознавание+компьют РАБОТАТЬ для embedded-флейвора.

### 1.5 Закон границы (D-064 §5, N1)

Всё — генерические механизмы: тип, парсер, чистый компьют, роутинг по kind. Ни
`purchaseApproval`, ни `«Заявка»`, ни `500000`, ни `items`, ни слаги тенанта не
появляются в `src/`. Кейс живёт в `record_schema` тенанта (данные). Живой DB-тест
(AC-9) использует НЕЙТРАЛЬНЫЕ имена (`source: "lines"`, `value_field: "price"`,
`factor_field: "qty"`, произвольный порог) — не воспроизводит продовые слаги.
`anti-case-lock.sh` не растёт от baseline.

## 2. Отклонённые альтернативы

(в contract-JSON)

## 3. Почему это правильный уровень

Дефект — не в overlay-механике T-0575 (она корректна для распознанных derived-
полей), а в том, что распознаватель контракта знал лишь один из двух флейворов,
которые продукт реально порождает. Чинить надо распознавание+компьют на сервере,
приведя серверную embedded-семантику к клиентскому эталону — тогда ВСЕ пути
(create=start, READ), проходящие через единый `extractDerivedFields`/
`computeAllDerivedFields`, чинятся одной дельтой без дублирования.

## 4. План тестов (AC → FF)

1. `src/__tests__/rollup-contract.test.ts` (расширение): AC-1 (диспетчер флейвора),
   AC-2/AC-3/AC-4 (чистый `computeEmbeddedRollup`), AC-6 (`extractDerivedFields`
   embedded/child/mixed). Все pure, без БД.
2. Зеркальный тест семантики (AC-5): те же фикстуры, что гоняются через клиентский
   `computeRollup` в web-тестах — сверить идентичность результата серверного
   компьюта. (Web-сторона: `web/src/screens/__tests__/*` — при наличии добавить
   зеркальный кейс; иначе зафиксировать эталонные числа в src-тесте с комментарием-
   ссылкой на `records-form.js::computeRollup`.)
3. `src/__tests__/binding-trigger.unit.test.ts` (расширение, AC-7/AC-8): стаб-pool
   отдаёт registry с embedded-`x-rollup`-схемой + on_create-биндинг
   `field_mapping {amount: <rollupKey>}`; `data` с непустой коллекцией → стаб-flowable
   `startInstance` получает `amount` = сумму; пустая коллекция → `amount:null`.
4. Живой DB+Flowable (AC-9): расширить `ci/checks/db/detel-rollup-to-variables.db.test.ts`
   вторым describe-блоком (embedded-флейвор, нейтральные имена) — >порога → HIGH-VALUE,
   <порога/пустой → default. Skip graceful без Flowable (тот же helper).
5. READ-путь (AC-10): db-тест GET /api/records/:id над embedded-схемой → `derived`
   несёт сумму (расширить существующий records-read db-тест либо тот же файл).
6. Гейты (AC-11/AC-12): `npm test`, `npm run build`, `npm run fitness:db`,
   `bash ci/checks/anti-case-lock.sh`.

---

*Файл: `docs/adr/ADR-T0603-rollup-vars-at-start.md`.*
