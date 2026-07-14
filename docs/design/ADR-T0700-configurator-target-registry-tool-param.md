# ADR-T0700 — targetRegistrySlug в схеме инструмента author_binding

Status: ready
Task: T-0700 (E-FORMS T-0479, столп 5 «настройка через ИИ»)
Base: task/T-0700

## 1. Problem

`src/http/assistant.ts`'s `executeApprovedOpAsDraft` (кейс `"author_binding"`)
с T-0681 читает `op.args["targetRegistrySlug"]`, валидирует его как slug
РЕАЛЬНОГО `registry_def` под привязываемым приложением, честно отклоняет
несуществующий слаг, и пишет его в `process_app_binding.target_registry_slug`.
Тот же T-0681 дал человеку в `web/src/screens/screen-processes.jsx` `<select
id="bind-target-registry">` — видимый пикер «Реестр результата (необязательно)»
поверх `registryTargetOptions(registryDefs)`.

Но `TOOL_AUTHOR_BINDING` (`src/core/assistant-configurator.ts`) — JSON-схема
инструмента `author_binding`, которую LLM агента-конфигуратора получает в
каждом `chat()`-вызове (`CONFIGURATOR_TOOLS`) — не объявляла
`targetRegistrySlug` в `parameters.properties`. В function-calling протоколе
(OpenAI-совместимый; `ChatLlmRequest.tools[]`) модель заполняет только
параметры, перечисленные в схеме инструмента — параметра там не было,
значит модель не могла его заполнить НЕЗАВИСИМО от того, что просил
пользователь текстом. Человек мог выбрать нестандартный реестр в UI; бот —
нет. Это разрыв инварианта «бот==человек» (столп 5), обнаруженный при
разведке T-0700 (`args.targetRegistrySlug` уже принимается и валидируется
сервером — T-0681 закрыл ТОЛЬКО путь `POST /api/process-app-bindings`,
не путь конфигуратора).

## 2. Decision — add the parameter to the tool schema; args already flow through opaquely

`processToolCall`'s кейс `"author_binding"` (`src/core/assistant-configurator.ts`)
строит `ApprovedOp` так:

```ts
const approved: ApprovedOp = {
  kind: "author_binding",
  description: `...`,
  args,           // ← весь распарсенный объект аргументов инструмента, целиком
  tier: "draft",
};
```

`args` — это `JSON.parse(call.arguments)`, весь объект, который LLM вернула
для tool-call'а, без выборочной деструктуризации отдельных ключей на этом
уровне. Значит **единственное**, что мешало `targetRegistrySlug` доходить до
`ApprovedOp.args` (и дальше — до уже готового T-0681 исполнителя) — это то,
что схема инструмента никогда не подсказывала модели, что такой параметр
существует. Никакой код `processToolCall`/`executeApprovedOpAsDraft` менять
не нужно для протяжки значения — только объявить параметр в схеме.

Добавлено в `TOOL_AUTHOR_BINDING.function.parameters.properties`:

```ts
targetRegistrySlug: {
  type: "string",
  description:
    "Необязательно: slug реестра (registry_def) внутри приложения этой привязки, " +
    "куда должен попасть результат шага процесса — если он должен отличаться от " +
    "реестра приложения по умолчанию. Укажите только когда пользователь явно " +
    "просит направить результат в ДРУГОЙ, конкретный реестр этого приложения. " +
    "Пусто или не указано — используется реестр по умолчанию (прежнее поведение). " +
    "Значение должно быть slug'ом РЕАЛЬНОГО реестра этого приложения — иначе сервер " +
    "честно отклонит привязку, а не создаст её вслепую.",
},
```

НЕ добавлено в `required` — пустое/отсутствующее значение обязано остаться
не-регрессирующим (реестр по умолчанию, T-0681's backward-compatible путь).

Description сформулировано ОБЩИМИ словами (что это, когда использовать, что
означает пустое значение, что сервер отклонит несуществующий слаг) — без
имён конкретных реестров/приложений/кейсов (D-064 §5 анти-кейс: `src/`
не несёт кейс-контента).

### 2.1 Audit-паритет (небольшая сопутствующая правка)

`processToolCall`'s changelog-строка/`ApprovedOp.description` для
`author_binding` дополнена: если `targetRegistrySlug` присутствует, к
описанию добавляется `, реестр результата=«<slug>»`. Это не новая операция
и не расширение контракта `ApprovedOp` — то же поле `description`, которое
уже существовало, теперь честно называет то, что человек уже видел бы в
своей UI-форме при том же выборе. Без этого правка была бы «тихой»:
draft-changelog, который читает человек перед промоутом, не отражал бы
нестандартный реестр, хотя запись уже унесла его в БД.

## 3. Почему НЕ трогаем `CONFIGURATOR_DEFAULT_SYSTEM_PROMPT`

`CONFIGURATOR_DEFAULT_SYSTEM_PROMPT` — общий инструктаж «как работать»
(порядок propose_plan → generate, каскад relate_application, draft-only).
Он НЕ перечисляет параметры отдельных инструментов — `startFormKey`,
`fieldMapping`, `isCorePinned` и другие уже существующие необязательные
параметры `author_binding`/`edit_jsonschema` там тоже не упомянуты
поимённо. LLM в function-calling протоколе читает описание параметра ИЗ
СХЕМЫ ИНСТРУМЕНТА (`parameters.properties.<key>.description`) — это и есть
тот «промпт», который относится к конкретному параметру. Добавление
`targetRegistrySlug` в системный промпт отдельно от остальных параметров
было бы несимметричным разрастанием текста без функциональной необходимости
(the tool schema description already IS the per-parameter prompt) — отклонено
как расходящееся с объёмом задачи (coder.md правило 5, соразмерность).

## 4. Security / co-equal invariant preserved

- Исполнитель (`executeApprovedOpAsDraft`) НЕ меняется — тот же путь,
  что T-0681 уже проверил (адресность slug'а СТРОГО под привязываемым
  приложением; иначе честный отказ). Один исполнитель для
  бот-инициированных и человек-инициированных привязок (co-equal, ADR
  T-0361 §2).
- DRAFT-only инвариант не затронут: `ApprovedOp.tier` остаётся `'draft'`
  безусловно — эта задача не даёт агенту новый путь к промоуту.
- Fail-closed сохранён: несуществующий `targetRegistrySlug` (LLM
  «придумала» слаг) отклоняется сервером honest-текстом «реестр «…» не
  найден», СТРОКА НЕ ПИШЕТСЯ — то же поведение, что человек получил бы,
  если бы (гипотетически) обошёл `<select>` и отправил произвольный текст.

## 5. Alternatives rejected

- **Новый отдельный tool (например `author_binding_with_registry`)** —
  дублирование существующего инструмента ради одного необязательного поля;
  отклонено, `author_binding` уже несёт несколько опциональных полей
  (`startFormKey`, `fieldMapping`) без отдельных инструментов на каждое.
- **Ветвление в `processToolCall`'s кейс `"author_binding"` для явной
  деструктуризации `targetRegistrySlug`** — избыточно: `args` уже передаётся
  целиком в `ApprovedOp.args`, деструктуризация ничего бы не добавила
  функционально (добавлена только description-логика changelog'а, п.2.1).
- **Добавить упоминание в `CONFIGURATOR_DEFAULT_SYSTEM_PROMPT`** —
  отклонено, см. §3 (несимметрично, функционально избыточно).
