# T-0101 — Формы: исполнение в изолированном sandbox-iframe (auto-height postMessage)

- **id:** T-0101
- **type:** build
- **spec_ref:** `web/preview/forms.html` (sandbox=allow-scripts, opaque origin, fjs-height postMessage); `docs/design/claude-design-prompts.md` (Промпт 3)
- **depends_on:** none (Forms runtime foundation exists)

## 1. Проблема / мотивация

Определения форм (form-js разметка + рантайм-скрипт, который мы исполняем как
инлайн-JS внутри `srcdoc`) — это **недоверенный контент**: в проде форма может
прийти из конфигурации тенанта / AI-генерации (Stage-3). Если такой скрипт
получит доступ к DOM/cookie/`localStorage`/origin родительского приложения, он
сможет угнать сессию, читать чужие данные, делать запросы от имени пользователя.

Поэтому исполнение формы ОБЯЗАНО идти в **изолированном sandbox-iframe с опаковым
(opaque / `"null"`) origin**: `sandbox="allow-scripts"` **без** `allow-same-origin`.
Эта комбинация лишает скрипт формы доступа к родителю: своё `document`, свой
origin `"null"`, нет общих cookie/storage, `postMessage` — единственный канал
наружу.

Так как опаковый origin ломает наследование высоты, iframe должен **авто-высотиться**:
форма постит свою content-height наружу через `postMessage`, родитель ресайзит
iframe. Этот канал — единственная щель в изоляции, поэтому родитель ОБЯЗАН
валидировать сообщение (origin/source/форма/границы), а не доверять любому
`postMessage` (иначе любой фрейм/расширение может спамить height-сообщения).

Задача — это **security-харднинг** существующего пути рендера форм
(`FormViewer.jsx`, `forms.html`, `form-defs.js`): зафиксировать изоляционные
инварианты в коде, на родительском приёмнике сообщений и в статической
fitness-проверке, не ломая существующую валидацию форм.

## 2. Текущее состояние (что уже есть — orient)

- `web/src/forms/FormViewer.jsx` — React-компонент: строит `srcDoc`, монтирует
  `<iframe sandbox="allow-scripts">`, слушает `message` (проверяет `e.source ===
  contentWindow`, `typeof h === 'number'`), ресайзит. **Нет проверки `e.origin`,
  нет защиты от NaN/Infinity, нет верхней границы высоты.**
- `web/preview/forms.html` — статическое превью: два iframe `sandbox="allow-scripts"`,
  `srcdoc`-инъекция, `message`-слушатель. **Проверяет только `contentWindow ===
  e.source`; НЕ проверяет `e.origin`; высота без границ.**
- `web/src/forms/form-defs.js` — `CHOROS_SANDBOX_SCRIPT`: внутри iframe постит
  `parent.postMessage({type:'fjs-height', h}, '*')`. Target-origin `'*'`
  допустим (тело — только высота, не секрет; ребёнок надёжно не знает origin
  родителя), но payload минимален.
- `web/src/screens/screen-forms.jsx` — использует `FormViewer` в приложении.
- `ci/checks/forms-schema-binding.sh` (FF-FORMS1) — связывает UI-поля с
  серверной валидацией; НЕ проверяет sandbox-инварианты.
- `src/core/form-validator.ts`, `src/core/form-schema.ts`, `src/http/forms.ts` —
  серверная валидация (single source of truth). **Эта задача их не трогает.**

## 3. Цель (что значит «done»)

Исполнение формы рендерится в изолированном sandboxed iframe с опаковым origin
(`sandbox="allow-scripts"`, без `allow-same-origin`), iframe авто-высотится через
origin-валидируемый `postMessage`-канал, существующая валидация форм сохранена,
а изоляционные инварианты зафиксированы статической fitness-проверкой.

## 4. Функциональные требования

- **FR-1 — Опаковый origin.** Каждый iframe исполнения формы (`FormViewer.jsx`,
  оба iframe в `forms.html`) имеет `sandbox="allow-scripts"` **без**
  `allow-same-origin`. Скрипт формы не может достать DOM/cookie/storage/origin
  родителя.
- **FR-2 — Авто-высота.** Форма постит content-height наружу
  (`{type:'fjs-height', h}`); родитель ресайзит iframe под высоту контента.
  Поведение работает при смене формы/темы.
- **FR-3 — Origin-валидированный приёмник.** Родительский `message`-слушатель
  принимает height-сообщение ТОЛЬКО когда: (a) `e.source` === `contentWindow`
  целевого iframe; (b) `e.origin === 'null'` (опаковый origin sandbox); (c)
  `e.data.type === 'fjs-height'`; (d) `e.data.h` — конечное неотрицательное
  число. Любое сообщение от чужого source/origin или иной формы — **игнор**.
- **FR-4 — Границы высоты.** Принятая высота клампится в `[MIN, MAX]` (MIN для
  читаемости, MAX чтобы скомпрометированная форма не раздула iframe на весь
  экран DoS-ом). NaN/Infinity → отброшены.
- **FR-5 — Сохранение валидации.** Серверная валидация (`form-validator.ts` /
  `forms.ts` / FF-FORMS1) НЕ меняется и остаётся зелёной; задача не вводит
  клиентского доверия к форме.
- **FR-6 — Статический гейт.** Новый `ci/checks/forms-sandbox-iframe.sh` (FF-FORMS2)
  статически утверждает: каждый form-iframe имеет `sandbox` с `allow-scripts`
  и **без** `allow-same-origin`; родительские приёмники валидируют `origin`;
  height клампится. Имеет `--self-test`.

## 5. Нефункциональные требования

- **NF-1 — Аддитивность.** Изменения сфокусированы на изоляции iframe +
  авто-высоте; никакого рефактора несвязанного кода формы.
- **NF-2 — Без byte-frozen.** НЕ трогать grant-lattice / object-handle /
  frozen-checks. Если кажется, что нужно — СТОП.
- **NF-3 — Без XSS/origin-confusion регрессий.** Не ослаблять sandbox, не
  добавлять `allow-same-origin`, не доверять `postMessage` вслепую.
- **NF-4 — Гейты зелёные.** `tsc --noEmit` exit 0; `eslint src` exit 0;
  `npm run build` exit 0; `npm run fitness` exit 0; `vitest run` exit 0.

## 6. Инварианты безопасности (machine-checkable)

- **SI-1** Ни один form-iframe не содержит `allow-same-origin` совместно с
  `allow-scripts` (комбинация уничтожает sandbox). Проверяется FF-FORMS2 +
  unit-тест на строке sandbox.
- **SI-2** Родительский приёмник валидирует `e.origin === 'null'` И
  `e.source === contentWindow` ДО ресайза. Проверяется FF-FORMS2 (grep на
  `origin`) + unit-тест на чистой функции-приёмнике.
- **SI-3** Высота клампится: `h` вне `[MIN,MAX]` или non-finite → отброшено /
  закламплено. Проверяется unit-тестом чистой функции `acceptFrameHeight`.

## 7. Out of scope

- Серверная валидация форм (FF-FORMS1) — не меняется.
- AI-генерация форм / новые поля формы (Stage-3).
- Полноценный CSP/Trusted-Types движок (отдельный security-эпик).
- Заголовки/CSP на HTTP-ответе приложения (отдельная транспортная задача).

## 8. Приёмка (см. `T-0101.spec.contract.json`)

См. машино-проверяемые AC в контракте: SI-инварианты, авто-высота, origin-валидация.
