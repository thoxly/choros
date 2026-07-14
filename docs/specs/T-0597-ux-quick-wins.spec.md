# T-0597 — UX quick wins (5 S-фиксов из ux-loop-report-2026-07-02.md)

Источник: `docs/ux-loop-report-2026-07-02.md`, находки №3, №5, №6, №8, №9 (design-steward,
2026-07-02). Пять S-размерных фиксов, каждый — точечная правка одного экрана,
без новых эндпоинтов, без изменения серверной семантики.

## Контекст (не дублировать выводы отчёта)

Отчёт уже сверил, что находится ВНЕ этого T: находки №1/№2/№4/№7/№10 (M-размер
или продуктовое решение к фаундеру) — не в периметре T-0597. Ниже — только пять
S-фиксов, помеченных в отчёте как «Quick wins — можно исполнить сегодня».

## FR-1 (= находка №6) — alert() → pushToast в инбоксе

**Файл:** `web/src/screens/screen-inbox.jsx:672` (claimTask) и `:698` (approveTask).

**Сейчас:** оба catch-блока вызывают `alert(e.message)` — блокирующий нативный
модал, не стилизован, не консистентен с остальным экраном (Drawer уже показывает
ошибки через `S.noticeError`, `ra-criticality.jsx`/`ra-overview-forms.jsx`/
`screen-assistant.jsx` используют `pushToast({tone:'error', message})`).

**Должно быть:** оба `alert()` заменяются на `pushToast({ tone: 'error', message: e.message })`
через `useToastContext()` (тот же провайдер, что уже используется в rights/assistant
экранах — не новый провайдер, не другой тон). Человекочитаемый текст, который
уже собирается в `e.message` (включая `ENGINE_DRIVE_ERROR_MESSAGE[code]` маппинг
для approve и `ALREADY_CLAIMED`-ветку для claim), **не меняется** — только канал
доставки. `error`-тон в существующем `toast-context.jsx` имеет `duration:0`
(не гаснет сам) и `role=alert`/`aria-live=assertive` — эквивалент по «не
пропустишь», но не блокирует поток (JS не встаёт на native-modal паузу).

## FR-2 (= находка №3) — reveal-toggle на поле API-ключа

**Файл:** `web/src/screens/screen-llm-connections.jsx:442-450` (форма
`ConnectionKeyBinder`, `type="password"` Field).

**Сейчас:** значение всегда замаскировано; нет способа проверить вставленное
перед отправкой.

**Должно быть:** локальный `showKey` state в `ConnectionKeyBinder`; кнопка-глазик
рядом с полем переключает `type` между `password`/`text` и меняет иконку
(`eye` ⟷ `eye-off`, новые записи в `KitIcon`/`ICON_REGISTRY` — их пока нет в
kit). Кнопка — `<button type="button">` (не submit), `aria-label`
«Показать ключ» / «Скрыть ключ» синхронно с текущим состоянием, устанавливается
`aria-pressed`. Реализация — инлайн в `screen-llm-connections.jsx` (не расширяем
общий `Field` в `components.jsx` — отчёт допускает оба варианта, инлайн меньше
площадь диффа и не меняет контракт `Field` для остальных потребителей).
Write-only семантика ключа НЕ затрагивается: reveal — чисто клиентское
состояние ДО отправки (значение, которое пользователь только что напечатал);
после успешного сохранения поле обнуляется и закрывается как раньше — сервер
по-прежнему никогда не возвращает сырой ключ обратно.

## FR-3 (= находка №5) — actionable-hint «оргструктура пуста»

**Файл:** `web/src/screens/rights/ra-overview-forms.jsx:206-212` (`AssignRoleForm`,
`Select label="Сотрудник"` hint при пустом списке).

**Сейчас:** hint — голая строка «Список сотрудников пуст — заведите сотрудников
в разделе «Оргструктура» или обновите страницу», без кликабельного пути.

**Должно быть:** hint при пустом списке сотрудников заменяется на JSX-фрагмент:
тот же честный текст + инлайн-кнопка/ссылка «Открыть оргструктуру», которая
вызывает `navigate('/org')`. Путь подтверждён в коде: `web/src/app-shell/shell.jsx:1160`
регистрирует `<Route path="/org" element={<OrgScreen .../>} />`, и
`screen-overview.jsx:193` уже использует ровно этот путь (`navigate('/org')`)
для той же плитки «Оргструктура» — контракт пути не изобретается заново.
`Select`'s `hint` prop уже рендерит `{hint}` как произвольный ReactNode (нет
PropTypes-ограничения на string) — можно передать JSX без изменения kit.
`AssignRoleForm` не имеет прямого доступа к router — добавляем
`useNavigate()` из `react-router-dom` внутри самого компонента (тот же паттерн,
что уже использует `screen-rights.jsx:229`, — компонент монтируется внутри
`<Router>` дерева приложения, вызов легален в любом функциональном компоненте
поддерева).

## FR-4 (= находка №8) — дефолт формы = Anthropic

**Файл:** `web/src/screens/screen-llm-connections.jsx:501-508` (initial state
формы «Новый профиль») и инструкция `:683-693`.

**Сейчас:** инструкция сверху ведёт строго по Anthropic (console.anthropic.com,
«выберите провайдера Anthropic»), но `useState` инициализирует
`provider='deepseek'`, `endpoint='https://api.deepseek.com/v1'`,
`model='deepseek-chat'`, `priceIn='0.14'`, `priceOut='0.28'` — рассинхрон между
текстом-инструкцией и тем, что уже стоит в форме при первом взгляде.

**Должно быть:** начальные значения формы переключаются на Anthropic-пресет
(значения берутся из уже существующего `PROVIDER_PRESETS.find(p => p.value === 'anthropic')`
— не задваиваем данные вручную, единственный источник цифр — массив пресетов).
DeepSeek остаётся первым пресетом в массиве и полностью выбираемым через
`Select` (`onProviderChange` не меняется) — это переключение ДЕФОЛТА формы, не
удаление/скрытие альтернативы. `isDefault` чекбокс и остальные поля не
затрагиваются.

## FR-5 (= находка №9) — честный статус «ключ не привязан»

**Файл:** `web/src/screens/screen-llm-connections.jsx:697-802` (форма создания,
успех-баннер `:800`) + карточка профиля `:829-880` (`chipStyle`, `ConnectionKeyBinder`
кнопка `:430-432`).

**Сейчас:** `createOk` рендерит нейтральный `bannerOkStyle` (`--chs-color-success*`)
с текстом «Профиль создан.» независимо от того, привязан ли ключ. Чип
«ключ не привязан» использует нейтрально-серый `chipStyle(false)`
(`--chs-color-surface-raised`/`--chs-color-text-muted`/`--chs-color-border` —
не подача предупреждения). Кнопка «Вставить API-ключ» в `ConnectionKeyBinder`
всегда `variant="ghost"`.

**Должно быть:** три независимых, но согласованных изменения:
1. Успех-баннер при создании профиля БЕЗ ключа (`!secretHandle.trim()` в
   момент успешного `onCreate`) дописывает вторую строку: «Теперь вставьте
   API-ключ, чтобы он заработал.» — баннер с ключом не меняется (остаётся
   «Профиль создан.» без довеска, т.к. секрет-хэндл уже указан).
2. `chipStyle(ok)` при `ok===false` (`!secret_bound`) получает предупреждающий
   тон через существующие токены `--chs-color-warning` / `--chs-color-warning-soft`
   (уже определены в `design/tokens.css:193-194,263-264` для обеих тем) — не
   новый токен, не хардкод.
3. Кнопка «Вставить API-ключ» в `ConnectionKeyBinder` получает
   `variant={secretBound ? 'ghost' : 'primary'}` — primary только когда ключ ещё
   не привязан (после привязки/при «Заменить API-ключ» кнопка возвращается к
   `ghost`, это НЕ более не critical action).

## Границы (out of scope)

- OOS-1: находки №1/№2/№4/№7/№10 отчёта — не входят в T-0597 (M-размер или
  продуктовое решение).
- OOS-2: не меняется серверный контракт (`/api/inbox/*`, `/api/llm-connections*`,
  `/api/role-assignments`, `/api/agents`) — все пять фиксов чисто клиентские.
- OOS-3: не трогается общий `Field`/`Select` компонент в `components.jsx` (кроме
  добавления `eye`/`eye-off` в `KitIcon`+`ICON_REGISTRY`, что аддитивно и не
  меняет существующие сигнатуры).
- OOS-4: `ux-g2` (theme-pairing) не затрагивается — фиксы не трогают
  `tokens.css`/`form-theme.css`.

## Acceptance criteria

- AC-1: `screen-inbox.jsx` не содержит `alert(` в `claimTask`/`approveTask` catch-блоках;
  оба используют `pushToast({tone:'error', ...})` через `useToastContext()`.
- AC-2: человекочитаемый текст ошибки (включая `ENGINE_DRIVE_ERROR_MESSAGE`
  маппинг и `ALREADY_CLAIMED`-ветку) сохранён byte-for-byte — только канал
  доставки меняется.
- AC-3: `ConnectionKeyBinder` рендерит toggle-кнопку рядом с полем API-ключа;
  клик переключает `type` password↔text и `aria-label`/`aria-pressed`.
- AC-4: после успешной привязки ключ по-прежнему не читается с сервера (список
  соединений продолжает отдавать только `secret_bound`+`secret_handle_redacted`,
  никакого нового поля с сырым значением) — negative-проверка на server-контракт
  НЕ меняется этим T (он клиентский).
- AC-5: `AssignRoleForm` при пустом списке сотрудников рендерит кликабельный
  путь (`button`/`a`), вызывающий `navigate('/org')`.
- AC-6: путь `/org` подтверждён существующим маршрутом
  (`shell.jsx` Route path="/org") — не изобретён новый путь.
- AC-7: начальные значения формы «Новый профиль» соответствуют
  `PROVIDER_PRESETS.find(p => p.value === 'anthropic')` (endpoint/model/priceIn/priceOut/currency),
  `provider` initial state = `'anthropic'`.
- AC-8: DeepSeek остаётся первым элементом `PROVIDER_PRESETS` и полностью
  выбираем через `Select` без изменения `onProviderChange`.
- AC-9: успех-баннер без секрет-хэндла содержит дописанную строку про вставку
  ключа; баннер с секрет-хэндлом — не содержит (различие по ветке).
- AC-10: `chipStyle(false)` использует `--chs-color-warning`/`--chs-color-warning-soft`
  вместо нейтральных `--chs-color-surface-raised`/`--chs-color-text-muted`.
- AC-11: кнопка «Вставить API-ключ» — `variant="primary"` при `!secretBound`,
  `variant="ghost"` при `secretBound` (включая режим «Заменить API-ключ»).
- AC-12: ни один фикс не вводит новый хардкод-цвет вне `--chs-*` токенов
  (`ux-g6` информационный gate остаётся чист по новым строкам).
- AC-13: ни один фикс не вводит dev-жаргон в видимый текст (`ux-g5` остаётся
  чист по новым строкам).
- AC-14: web vitest полный прогон зелёный; `tsc` (если применим к web) без
  новых ошибок в затронутых файлах.

## Fitness / verification map

| AC | verifiable_as | как |
|----|----|-----|
| AC-1/AC-2 | test | `screen-inbox.test.jsx` (новый, source-presence) |
| AC-3 | test | `screen-llm-connections.test.jsx` (расширение, source-presence) |
| AC-4 | test | не regressed — существующие server-контракт тесты не тронуты (клиентский фикс) |
| AC-5/AC-6 | test | `ra-overview-forms.test.jsx` (новый, source-presence) |
| AC-7/AC-8 | test | `screen-llm-connections.test.jsx` (расширение) |
| AC-9/AC-10/AC-11 | test | `screen-llm-connections.test.jsx` (расширение) |
| AC-12 | fitness | `bash ci/checks/ux/ux-g6-no-new-hardcode.sh` |
| AC-13 | fitness | `bash ci/checks/ux/ux-g5-jargon-denylist.sh` |
| AC-14 | ci | `npx vitest run` (web), `npx tsc --noEmit` (если сконфигурирован для web) |
