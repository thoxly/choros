# T-0700 — targetRegistrySlug в тулинге агента-конфигуратора (паритет с UI, T-0681)

Task: T-0700 (эпик E-FORMS T-0479, столп 5 «настройка через ИИ»)
Инвариант: бот==человек (капабилити ассистента не уже, чем у человека в UI)
Base: task/T-0700, worktree /Users/shoxy/Code/choros-wt/T-0700

## Контекст

T-0681 научил СЕРВЕР (`executeApprovedOpAsDraft`, кейс `"author_binding"`,
`src/http/assistant.ts`) принимать и валидировать `args.targetRegistrySlug` —
необязательный per-binding override реестра, куда должен попасть результат
шага процесса (иначе используется реестр приложения по умолчанию). Тем же
патчем UI-конструктор (`web/src/screens/screen-processes.jsx`, «Реестр
результата (необязательно)») получил `<select>`, откуда человек выбирает
любой существующий реестр приложения.

Схема инструмента `author_binding`, которую видит LLM агента-конфигуратора
(`TOOL_AUTHOR_BINDING`, `src/core/assistant-configurator.ts`), параметр
`targetRegistrySlug` НЕ объявляла. Function-calling LLM заполняет только
параметры, перечисленные в `parameters.properties` схемы инструмента —
значит бот физически не мог передать это значение, даже если пользователь
явно попросил привязать процесс к нестандартному реестру. Человек в UI мог
то, что бот не мог, — асимметрия капабилити, прямое нарушение инварианта
«бот==человек».

## Functional

- F1. `TOOL_AUTHOR_BINDING.function.parameters.properties` получает
  необязательное поле `targetRegistrySlug: string` с русскоязычным описанием
  общими словами (когда использовать, что означает пустое значение, что
  сервер честно отклонит несуществующий реестр) — без имён конкретных
  реестров/кейсов (анти-кейс, D-064 §5).
- F2. `targetRegistrySlug` НЕ входит в `required` — отсутствие параметра
  оставляет поведение прежним (реестр приложения по умолчанию).
- F3. Значение параметра доходит до `ApprovedOp.args["targetRegistrySlug"]`
  БЕЗ дополнительной трансформации — `processToolCall`'s `case
  "author_binding"` уже присваивает `args: args` целиком (весь объект
  аргументов инструмента), так что новый ключ протягивается автоматически,
  без изменения формы `ApprovedOp`.
- F4. Audit-паритет: описание/changelog-строка `ApprovedOp` для
  `author_binding` называет нестандартный реестр результата, когда он указан
  (человек видит в drafted-changelog то же, что видел бы, выбрав реестр в
  UI-форме) — чисто описательная добавка, не новая операция.
- F5. Исполнение (`executeApprovedOpAsDraft`, кейс `"author_binding"`) НЕ
  меняется — T-0681 уже читает `args["targetRegistrySlug"]`, валидирует его
  существование под приложением этой привязки, честно отклоняет
  несуществующий слаг. Это ОДИН и тот же исполнитель для бот- и
  человек-путей (co-equal, ADR T-0361).

## Non-functional

- N1. Zero new write path — никакого нового SQL/таблицы/резолвера; фикс
  целиком в слое схемы инструмента + описании параметра + changelog-тексте.
- N2. Анти-кейс (D-064 §5): описание параметра — общими словами, без бизнес-
  слагов/имён конкретных реестров/процессов.
- N3. Обратная совместимость: существующие tool-call'ы без
  `targetRegistrySlug` (все текущие вызовы `author_binding`) продолжают
  работать буквально как раньше — параметр опционален и по умолчанию
  отсутствует в `args`.

## Out of scope

- Изменение `CONFIGURATOR_DEFAULT_SYSTEM_PROMPT` (общий системный промпт
  конфигуратора не перечисляет остальные параметры `author_binding» —
  `startFormKey`/`fieldMapping` тоже не упомянуты там — добавлять только
  `targetRegistrySlug` было бы несимметрично и избыточно, т.к. описание
  параметра — это и есть тот «промпт», который LLM видит per-параметр).
- Изменения в `executeApprovedOpAsDraft`/`process-catalog.ts` (сервер уже
  готов, T-0681).
- UI (`screen-processes.jsx`) — уже готов, T-0681.

## Acceptance criteria

- AC-1: `TOOL_AUTHOR_BINDING`'s объявленная схема содержит свойство
  `targetRegistrySlug`, НЕ входящее в `required`.
- AC-2: tool-call `author_binding` С `targetRegistrySlug` →
  `ApprovedOp.args["targetRegistrySlug"]` равен переданному значению
  (проверено unit-тестом, core, $0).
- AC-3: tool-call `author_binding` БЕЗ `targetRegistrySlug` →
  `ApprovedOp.args["targetRegistrySlug"]` отсутствует (`undefined`) —
  прежнее поведение не регрессирует.
- AC-4: живой Postgres — `ApprovedOp`, повторяющий форму продукции
  конфигуратора (kind='author_binding', args.targetRegistrySlug = слаг
  РЕАЛЬНОГО реестра под привязанным приложением), проходит через
  `executeApprovedOpAsDraft` и пишет `process_app_binding.target_registry_slug`
  этим слагом; несуществующий слаг → честная ошибка, строка не пишется;
  отсутствующий параметр → `NULL` (реестр по умолчанию, без регресса).
