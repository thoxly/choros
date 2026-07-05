# ADR-T0649 — Полевые контролы (Money/Date/Person) + P1 целостность

**Статус:** принято · **Задача:** T-0649 (W4-UX/столп 2) · **Спека:** T-0649.spec.md, docs/design/ux-study-2026-07-05.md §2

## Контекст

Живое исследование фаундера (2026-07-05) вскрыло: (1) money-поле молча теряет копейки на ПОКАЗЕ (округление до целых рублей — целостность данных, не только UX); (2) PersonPicker мёртв на стенде из-за `GET /api/org` 401 при живой сессии; (3) дата — голый нативный `<input type="date">` + сырой ISO в списках, нет типа datetime, дата внутри collection-строк никогда не форматируется; (4) дублирующая колонка «Создано» в авто-виде списка.

Рендерер полей ЕДИН (`web/src/forms/field-renderer.jsx`, T-0399 D7-K) — контролы, добавленные сюда, применяются во ВСЕХ формах (записи + инбокс-задачи) одним изменением.

## Решения

### D1 — MoneyInput: копейки не теряются НИГДЕ

Хранение НЕ меняется: money остаётся `type:number` + `x-money:{currency:"RUB"}` аннотация (T-0509), значение — обычный JS number в `record.data`, сериализуется `Number(str)` без округления (`records-form.js:955-968` — уже корректно, подтверждено чтением кода до правки).

Единственный виновник — `formatCellValue`'s money branch (`records-form.js:1167-1172`), которая передавала `maximumFractionDigits: 0` в `Intl.NumberFormat`/`toLocaleString`. Меняем на `{ minimumFractionDigits: 0, maximumFractionDigits: 2 }`: целая сумма показывается без копеек («150 000 ₽»), дробная — с точными копейками («150 000,50 ₽»). Один фикс закрывает список, канбан и деталку записи — все три вызывают `formatCellValue`.

Ввод: `MoneyInput` — новый структурный контрол (симметричный `PersonPicker`/`RelationPickerField` по расположению в файле), держит внутреннее состояние «сырой ввод» (строка с разрядами) отдельно от родительского value (число как строка — тот же контракт `onChange(key, string)`, что был у голого `<input type="number">`, чтобы `serializeRecordData` не менять). ₽ рисуется ВНУТРИ поля (`position:absolute` слева, паддинг инпута), не снаружи флексом (снаружи ₽ обрезался границей поля — живой баг из §2).

### D2 — PersonPicker + `/api/org` 401: корневая причина и фикс

Расследование (код, не гипотеза): `fetchEmployees()` (`field-renderer.jsx`, до фикса) вызывал `fetch('/api/org')` БЕЗ единого заголовка. Комментарий в коде ошибочно полагал, что «браузер сам пришлёт cookie сессии» — но в Choros keycloak-режим авторизации ЦЕЛИКОМ на `Authorization: Bearer <token>` (`src/http/auth.ts` `authenticate()`, вызывается `withAuth` на каждый роут): при отсутствии заголовка `authenticate()` бросает `HttpError(401, "UNAUTHENTICATED", "missing Authorization header")` ДО того, как identity-резолвер (`resolveActorSlugFromAuth`, `src/db/org.ts`, T-0371/T-0633 fix) вообще вызывается. Каждый ДРУГОЙ fetch в том же файле (`RelationPickerField`, `FileField`, строки ~257/322/550 до правки) уже прикладывал `devHeaders()` — `fetchEmployees` был единственным исключением.

Вывод: это ДЕТЕРМИНИРОВАННЫЙ баг (100% в keycloak-режиме на каждый вызов), НЕ транзиентный сбой сети/JWKS/токена. `resolveActorSlugFromAuth` и его sub-first/preferred_username-fallback резолюция (жёстко задокументированы T-0371/T-0633, включая BYPASSRLS-инвариант пула) — в порядке, не является причиной этого симптома (просто никогда не достигается).

Фикс: `fetchEmployees()` → `fetchWithAuthRetry('/api/org', { headers: devHeaders() })` вместо голого `fetch`. `fetchWithAuthRetry` (`dev-auth.js`, T-0608) уже реализует ИМЕННО нужный паттерн: прикладывает актуальные auth-заголовки на каждый вызов (dev X-Dev-User / keycloak Bearer) И, при НАСТОЯЩЕМ транзиентном 401 (истёкший токен посреди сессии) в keycloak-режиме, делает silent-refresh + один повтор перед логин-редиректом. Один фикс закрывает и «person-поле мертво» (детерминированная причина), и «нет авто-retry на транзиентный 401» (для того случая, когда токен ДЕЙСТВИТЕЛЬНО истёк между рендером и кликом).

PersonPicker честная ошибка + кнопка «Повторить» добавлена independently от корневого фикса (защита в глубину): если `fetchWithAuthRetry` всё же исчерпает ретраи (например реальный logout/revoke), пользователь не застревает на немой ошибке — может повторить руками без перезагрузки страницы.

### D3 — DateInput + datetime + collection date

`DateInput` — стилизованный триггер-кнопка «05.07.2026 📅», раскрывающая нативный `<input type="date">` в поповере (без внешней библиотеки-календаря — в духе репо, "свой контрол"), либо (проще и надёжнее для a11y/фокуса) сам input стилизуется через `--chs-*` токены с иконкой-декором, а локализованный текст «05.07.2026» рисуется рядом/поверх нативного отображения браузера, которое зависит от локали ОС. Выбор реализации: рендерим `<input type="date">` полупрозрачным поверх видимого форматированного лейбла (паттерн "invisible native input + visible formatted overlay") — сохраняет клавиатурный ввод/a11y семантику нативного date input (уже работал живьём — «05072026 → принялось»), но гарантирует дд.мм.гггг независимо от локали браузера.

`datetime` — новый скалярный тип: `{ type:"string", "x-datetime": true }` (тот же x-* discriminator convention, что `x-date`/`x-url`/`x-email` — AJV strict принимает голый `type:"string"`, аннотация стрипается перед compile). Хранится как ISO-8601 datetime (`YYYY-MM-DDTHH:mm`), рендерится `<input type="datetime-local">`, показывается в списках «дд.мм.гггг чч:мм».

Collection date (x-date внутри строк): схема-редактор УЖЕ разрешает создать колонку типа `date` (`COLLECTION_SUB_FIELD_TYPES` включает `"date"`), но круговой обход схемы терял тип (читался назад как `"string"`, потому что вложенный `items.properties[key]` не может нести `x-date` — AJV strict). Фикс: пишем список ключей суб-полей-дат как родной верхнеуровневый ключ НА `items` (`items['x-collection-date-fields']`), не внутри `properties[key]` — AJV strict его не видит (он не заглядывает в неизвестные keys ВНЕ properties/required/type/additionalProperties, которые стрипаются тем же x-* convention'ом, что и остальные top-level x-*). Парсер (`apps-schema.js`) после построения subFields из `items.properties` восстанавливает `sfType:"date"` для ключей, перечисленных в `x-collection-date-fields`. Рендер ячейки не меняется — `CollectionField`/`FieldControl` уже правильно диспетчерят по `sf.type`.

### D4 — Дублирующая колонка «Создано»

`buildFieldCatalog` (`list-view-panel.js`) уже добавляет pseudo-колонку `created_at` (`label:'Создано'`) в field-каталог, из которого строится `columns` для активного/дефолтного view. `screen-app-records.jsx` рендерила и `columns.map(...)` (может УЖЕ включать created_at), и ОТДЕЛЬНО захардкоженный `<th>Создано</th>`+`<td>{fmtTs(...)}</td>`. Убираем захардкоженную пару — created_at теперь ТОЛЬКО через `columns` (её форматирование делегируется `formatCellValue(rec.created_at, 'created_at')`, новая ветка — раньше `created_at` форматировался inline через `fmtTs`, вне `formatCellValue`; теперь единая точка).

## Анти-кейс

Все контролы — generic по ТИПУ поля (money/date/person/datetime), НЕ по конкретному кейсу (не «дата подписания договора», не «сумма закупки»). Проверено: ни один добавленный компонент не содержит строкового литерала бизнес-домена.

## Последствия / риски

- `formatCellValue`'s money branch меняет ВИДИМЫЙ формат (было: всегда 0 знаков после запятой; стало: 0 или 2 по факту дробности) — это НАМЕРЕННОЕ визуальное изменение (существующие тесты на "1234567 → содержит ₽ и цифры" остаются зелёными: целое число как было без копеек).
- `x-collection-date-fields` — новая top-level запись на `items` (не `items.properties`) — должна быть добавлена в x-* strip allowlist сервера (`validateRecordSchemaDefinition`/AJV strict config), иначе schema save упадёт. Проверено при реализации.
- PersonPicker/401 фикс касается ТОЛЬКО `fetchEmployees` — широкий периметр "голый fetch без auth" по всем экранам НЕ трогается (см. FINDINGS, отдельная задача).
