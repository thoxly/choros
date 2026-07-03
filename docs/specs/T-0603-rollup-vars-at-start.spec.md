# T-0603 — Спека: embedded-роллап доезжает до Flowable-переменных при create=start

**Status:** ready
**Phase:** SPEC
**Task:** T-0603 [приёмочный P0 2026-07-03] — ветвление >500к в on_create-старте
**Date:** 2026-07-03
**База:** dev @ `c6db7b8` (ветка `task/T-0603-rollup-vars-at-start`).
**Предшественники:** T-0407 (rollup/matrix-lookup контракт + DAO), T-0452/T-0453
(UI-конструктор computed-полей → `x-rollup` embedded-shape), T-0575 (BUG-016 —
derived-precompute overlay перед проекцией переменных на create=start), T-0439
(DMN-precompute), T-0351/E16 (create=start seam).

---

## 1. Контекст (L-факты разведки, проверено в коде)

**Живой факт приёмки (2026-07-03).** Ветвление «Сумма больше 500 тыс?» в процессе
согласования закупки не срабатывает, когда процесс стартует ЧЕРЕЗ ПРОДУКТ
(on_create): переменная `amount` уходит в Flowable как NULL, эксклюзивный гейтвей
берёт default-ветку. Инстансы с суммами 600000 и 700000 (`flowable.act_hi_varinst`
`amount=NULL`) прошли малой веткой; корректно ветвился только инстанс, стартованный
через API с явными vars.

**Корень — доказан: два несовместимых флейвора роллапа под одним ключом `x-rollup`.**

- UI-конструктор computed-полей (`web/src/screens/apps-schema.js:452-463`) пишет
  роллап в схему в **embedded-флейворе**: `x-rollup: { source, op, value_field,
  factor_field? }` — агрегат по МАССИВУ-коллекции, живущему ВНУТРИ `record.data`
  (под-поле `source`, например `items`, — это collection-поле
  `type:"array", items:{type:"object",…}`). Семантику этого флейвора считает
  чистая функция `web/src/screens/records-form.js::computeRollup` (`:129-187`):
  `sum = Σ(value_field × factor_field)`, пустой массив → `null`, нечисловые
  ячейки пропускаются, factor по умолчанию 1. Именно поэтому в UI сумма 700000
  ВИДНА (браузер считает сам), а в переменных Flowable — NULL.

- Серверный контракт роллапа (`src/core/rollup-contract.ts::validateRollupFieldDef`,
  `:199-262`) распознаёт ТОЛЬКО **child-records-флейвор**: `x-rollup: {
  source_registry_id (UUID), ref_field, aggregate, value_field }` — агрегат по
  ДОЧЕРНИМ ЗАПИСЯМ (`src/db/derived-fields-dao.ts::computeRollupValue`,
  `:111-154`: `WHERE registry_id = source_registry_id AND data->>ref_field =
  parent_id`). У embedded-схемы НЕТ `source_registry_id`/`ref_field`/`aggregate` →
  `validateRollupFieldDef` возвращает `{ok:false}` → `extractDerivedFields`
  (`:353-391`) **молча пропускает** это поле (defensive skip невалидной
  аннотации).

- Следствие на create=start (`src/http/records.ts:838-869`, T-0575 derived-
  precompute): `extractDerivedFields(reg.record_schema)` для embedded-схемы
  возвращает `[]` → блок overlay не выполняется → `projectionSource` не получает
  вычисленной суммы → `projectEngineVariables` (`:702-730`) читает
  `record["total"]` = `undefined` → по строке `:725` `vars["amount"] = undefined
  ?? null = null` → в Flowable уходит переменная `amount` с честным NULL. BPMN-
  условие `${amount > 500000}` на NULL детерминированно ложно → default-ветка.
  (В логах контейнера НЕТ warning `[on_create derived-precompute]` — компьют не
  падал; `extractDerivedFields` вернул пустой список, overlay просто не случился.)

- То же на READ-пути (`src/http/records.ts:1683`): `extractDerivedFields` не
  видит embedded-роллап → серверный `derived`-map пуст; UI показывает сумму лишь
  потому, что считает `computeRollup` сам на клиенте. Т.е. серверная сторона НИКОГДА
  не распознавала embedded-флейвор ни на одном пути.

**Почему это не поймал «LIVE_PROOF» T-0575.** DB-тест
`ci/checks/db/detel-rollup-to-variables.db.test.ts` сеет
child-records-флейвор (`seedParentRegistry` `:304-312`:
`source_registry_id/ref_field/aggregate/value_field`) — тот, что сервер и так
поддерживает. Embedded-флейвор (реально авторимый UI и живущий в проде «Заявка»)
не тестировался — тест был зелёный, продовый путь оставался красным. Это
дефект покрытия, а не логики T-0575.

**Гипотеза №2 (позиции — дочерние записи, создаются после родителя) — ОПРОВЕРГНУТА.**
`items` в схеме «Заявка» — это collection-под-поле (`type:"array"`,
`items:{type:"object",…}`, `apps-schema.js:437-445`), которое ХРАНИТСЯ прямо в
`record.data` родителя и создаётся АТОМАРНО с ним в одном create-payload. Порядка-
проблемы нет; чинить надо распознавание флейвора.

## 2. Функциональные требования

- **F1.** `rollup-contract.ts` распознаёт embedded-флейвор роллапа: аннотация
  `x-rollup: { source, op, value_field?, factor_field? }` (без `source_registry_id`)
  парсится в новый типизированный `EmbeddedRollupFieldDef`. Дискриминатор флейвора
  ЯВНЫЙ (наличие `source_registry_id` → child-records; его отсутствие + наличие
  `source` → embedded), без угадывания. Child-records-флейвор НЕ меняется.
- **F2.** `extractDerivedFields` возвращает `DerivedFieldSpec` для обоих флейворов
  роллапа (child и embedded) и для matrix-lookup. `kind`-дискриминатор различает
  их для DAO-слоя.
- **F3.** Вычисление embedded-роллапа — ЧИСТОЕ, из `record.data` в памяти (без
  запроса к БД, как `computeMatrixLookupValue` читает оси из `recordData`).
  Семантика ТА ЖЕ, что серверная сторона обязана иметь по контракту с UI
  (`records-form.js::computeRollup`): `op:sum = Σ(value_field × factor_field)`;
  `count` = число строк; `avg/min/max` по числовым `value_field`-ячейкам; factor
  по умолчанию 1; нечисловые/пустые ячейки пропускаются; пустой массив (или все
  ячейки нечисловые) → `null` (НЕ 0 — честная неизвестность, ADR-T0575 §2.4).
- **F4.** `computeAllDerivedFields` (DAO) маршрутизирует по `kind`: embedded-
  роллап → чистый in-memory компьют из переданного `recordData`; child-роллап →
  существующий SQL по дочерним записям; matrix-lookup → существующий PK-скан.
- **F5.** На create=start (`records.ts:838-869`) embedded-роллап-поле,
  указанное в `field_mapping` on_create-биндинга, получает вычисленное значение в
  overlay ДО `projectEngineVariables` — так `amount` уходит в Flowable ЧИСЛОМ
  (не NULL) при непустой коллекции. При пустой коллекции — честный NULL (условие
  `${amount>500000}` детерминированно ложно, тот же контракт, что был).
- **F6.** На READ-пути (`records.ts:1683`) embedded-роллап-поле попадает в
  серверный `derived`-map с тем же вычисленным значением (побочный честный
  эффект единого распознавания; UI-`computeRollup` и серверный компьют дают
  идентичный результат на одних данных).
- **F7.** SAVEPOINT-изоляция derived-precompute на create=start НЕ ослабляется:
  embedded-компьют чист (не бросает при мусорных данных — деградирует в `null`),
  но общий контур savepoint-обёртки сохраняется (тот же fail-honest контур).

## 3. Нефункциональные требования

- **N1 (закон границы, D-064 §5).** Никаких кейс-литералов в `src/` (никаких
  `purchaseApproval`, `«Заявка»`, `500000`, `items`, слагов тенанта). Механизм
  генерический: работает для ЛЮБОГО embedded-роллапа любой схемы; кейс живёт в
  данных (record_schema тенанта). Анти-кейс гейт (`ci/checks/anti-case-lock.sh`)
  не растёт от baseline.
- **N2 (единый источник семантики).** Серверный embedded-компьют и клиентский
  `records-form.js::computeRollup` дают ОДИНАКОВЫЙ результат на одних данных
  (та же формула Σ(value×factor), та же null-семантика). Тест это фиксирует
  зеркальными кейсами.
- **N3 (child-флейвор не регрессирует).** `computeRollupValue` (SQL по детям) и
  его существующие тесты/контракт не меняются; `detel-rollup-to-variables.db.test.ts`
  (child-флейвор) остаётся зелёным.
- **N4 (без storage-мутации).** Роллап НЕ пишется в `record.data` (PD-20 — derived
  считается на чтение/на старт как transient overlay). Ни один insert/update не
  меняется.
- **N5 (без новых зависимостей / HTTP-маршрутов).** Только правка чистого
  контракта + DAO-роутинг + переиспользование существующего overlay-контура.
- **N6 (детерминизм гейта на NULL).** Пустая коллекция → `amount:null` → условие
  `${amount>500000}` ложно детерминированно (не throw) — сохраняется как явный
  контракт (ADR §2.4 T-0575, здесь подтверждается).

## 4. Out of scope

- **O1.** Изменение child-records-флейвора роллапа (SQL-агрегат по дочерним
  записям) — работает, не трогается.
- **O2.** Изменение matrix-lookup — не трогается.
- **O3.** Изменение UI-конструктора / `records-form.js::computeRollup` — клиентская
  семантика уже правильная (эталон); сервер подтягивается к ней, не наоборот.
- **O4.** Rollup-of-rollup / вложенные агрегаты глубже 1 уровня — вне контракта
  (embedded-source — это массив скаляр-ячеек в `data`, не другое derived-поле).
- **O5.** Изменение честного 503-пути / DMN-precompute — не трогаются.
- **O6.** Хранение derived-значения в `record.data` — прямо запрещено PD-20.

## 5. Acceptance criteria

| id | текст | verifiable_as |
|---|---|---|
| AC-1 | `validateRollupFieldDef`/`validateEmbeddedRollupFieldDef` (или единый парсер флейвора): аннотация `{source, op:"sum", value_field, factor_field}` (без `source_registry_id`) парсится как embedded-роллап; аннотация с `source_registry_id` — как child-роллап; невалидная (ни того, ни другого) → отвергается. | test |
| AC-2 | Чистый embedded-компьют: `op:sum` даёт `Σ(value_field × factor_field)` на массиве из ≥2 строк; factor по умолчанию 1 при отсутствии `factor_field`. | test |
| AC-3 | Чистый embedded-компьют: пустой массив-источник → `null`; массив со всеми нечисловыми `value_field`-ячейками → `null`; смешанные (числовые + мусорные) ячейки → сумма только числовых. | test |
| AC-4 | Чистый embedded-компьют: `count` = число строк (пустой → `null`); `avg/min/max` по числовым `value_field`-ячейкам. | test |
| AC-5 | Серверный embedded-компьют и клиентский `records-form.js::computeRollup` дают идентичный результат на ≥3 общих фикстурах (sum+factor, пустой, смешанный). | test |
| AC-6 | `extractDerivedFields` на схеме с embedded-`x-rollup` возвращает spec с `kind` embedded; на схеме с child-`x-rollup` — spec с child-kind; смешанная схема — оба. | test |
| AC-7 | Интеграционно (стаб-pool/стаб-flowable, паттерн `binding-trigger.unit.test.ts`): on_create с embedded-роллап-полем в `field_mapping` над непустой коллекцией в `data` → `flowable.startInstance` получает `amount` = вычисленную сумму (число), НЕ null. | test |
| AC-8 | Тот же путь при ПУСТОЙ коллекции → `amount` = null (детерминированный default-ветка-контракт, N6). | test |
| AC-9 | Живой DB+Flowable (расширение `detel-rollup-to-variables.db.test.ts` ИЛИ соседний файл): on_create над embedded-роллап-схемой (`source=items`, `sum(price×qty)`) с суммой >500000 → инстанс ждёт на HIGH-VALUE ветке; сумма <порога / пустая коллекция → default-ветка. Skip graceful без Flowable. | fitness |
| AC-10 | READ-путь (`GET /api/records/:id`) над embedded-роллап-схемой возвращает `derived[fieldKey]` = ту же сумму, что клиентский `computeRollup` (закрытие расхождения UI↔сервер). | test |
| AC-11 | `npm test` (root vitest), `npm run build` (tsc), `npm run fitness:db` — зелёные; счётчики тестов зафиксированы в handoff. | fitness |
| AC-12 | `bash ci/checks/anti-case-lock.sh` — exit 0, denylist не вырос от baseline (ноль кейс-литералов в `src/`). | fitness |

## 6. Открытые вопросы

Нет блокирующих. Единственная содержательная развилка (чинить распознавание
флейвора на сервере vs заставить UI писать child-флейвор) разрешена в §1/§O3:
клиентская embedded-семантика — эталон (проще, атомарна, уже работает в UI),
child-флейвор — отдельный легитимный случай; сервер обязан распознавать ОБА,
не ломая ни один. `status: ready`.

---

*Файл: `docs/specs/T-0603-rollup-vars-at-start.spec.md`. Разведка:
`src/core/rollup-contract.ts` (:199-262 child-only парсер, :353-391
`extractDerivedFields`), `src/db/derived-fields-dao.ts` (:111-154 SQL по детям,
:238-272 `computeAllDerivedFields`), `src/http/records.ts` (:838-869 create=start
derived-precompute overlay, :702-730 `projectEngineVariables`, :1683 READ-путь),
`web/src/screens/records-form.js` (:129-187 `computeRollup` — эталон embedded-
семантики), `web/src/screens/apps-schema.js` (:452-463 UI пишет embedded-shape),
`ci/checks/db/detel-rollup-to-variables.db.test.ts` (:304-312 child-флейвор,
объясняет пробел покрытия).*
