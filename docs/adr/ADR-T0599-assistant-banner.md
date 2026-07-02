# ADR-T0599 — Проактивный баннер «LLM-ключ не подключён» на экране ассистента

**Status:** ready
**Phase:** DESIGN
**Task:** T-0599 [W2/ассистент-UX] (UX-петля №4)
**Date:** 2026-07-02
**Спека:** `docs/specs/T-0599-assistant-banner.spec.md` + `docs/specs/T-0599.spec.contract.json` (AC-1..AC-12)
**База:** dev @ `edff87e` (ветка `task/T-0599-assistant-banner`)
**Предшественники:** T-0573 (honest-503), T-0595 (deep-link + серверный admin-предикат),
T-0597 (честный статус ключа на `/llm-connections`), T-0271/T-0473 (`GET /api/agents`),
T-0474/T-0498 (`llm_connection` named profiles), T-0539 (`nav-capabilities`).

---

## 1. Решение

**Источник статуса — существующий `GET /api/agents`, но чинится баг честности в нём.
Admin-статус — существующий клиентский кэш `getNavCapabilities()`. Ноль новых
эндпойнтов.** Баннер строится строго из данных, которые УЖЕ доступны без нового
сетевого запроса сверх одного `GET /api/agents`, который экран ассистента раньше не
делал вовсе.

### 1.1 Дельта A — `agents-list.ts`: `llm_bound` резолвится через `llm_connection` (F1, AC-1..AC-3)

`listAgentsTx` (`src/http/agents-list.ts:229-262`) сегодня селектит только
`ac.llm_secret_handle` — устаревшее inline-поле (migration 094 deprecation). Реальный
рантайм-резолвер (`src/db/agent-provision.ts::readConfiguredAgentLlmConfig`) LEFT JOIN'ит
`choros.llm_connection` и берёт `COALESCE(lc.secret_handle, ac.llm_secret_handle)`.
`listAgentsTx` получает ТОЧНО такой же JOIN + `COALESCE`:

```sql
SELECT ac.id AS agent_card_id,
       ac.employee_id, ac.agent_type, e.slug, e.display_name, ac.kc_client_id,
       COALESCE(lc.endpoint, ac.llm_endpoint)       AS llm_endpoint,
       COALESCE(lc.model, ac.llm_model)             AS llm_model,
       COALESCE(lc.secret_handle, ac.llm_secret_handle) AS llm_secret_handle,
       ac.llm_connection_id,
       p.title AS position_title, d.display_name AS department_name
  FROM choros.agent_card ac
  LEFT JOIN choros.employee e  ON e.tenant_id = ac.tenant_id AND e.id = ac.employee_id
  LEFT JOIN choros.llm_connection lc
       ON lc.tenant_id = ac.tenant_id AND lc.id = ac.llm_connection_id
  LEFT JOIN choros.position p  ON p.tenant_id = e.tenant_id AND p.id = e.position_id
  LEFT JOIN choros.department d ON d.tenant_id = p.tenant_id AND d.id = p.department_id
 WHERE ...
```

`serializeAgent` не меняется структурно — `row.llm_secret_handle` теперь УЖЕ несёт
резолвленное (COALESCE'd) значение из SQL-слоя, `bound = row.llm_secret_handle !== null`
(`agents-list.ts:189`) остаётся дословно тем же кодом, но входные данные честны.
`llm_endpoint`/`llm_model` в ответе (`deriveLlmProvider`, `AgentPublic.llm_model`) тоже
становятся точнее тем же путём (побочный, не new-scope выигрыш — те поля УЖЕ были в
контракте, просто читали неполный источник).

Секретная гигиена не меняется: `lc.secret_handle` — та же custody-класс опаки-ссылка,
что `ac.llm_secret_handle` (оба — RL-3 opaque handle, никогда не сырой ключ); JOIN не
вводит новый путь утечки — `llm_secret_handle` уже был read-only-для-boolean и остаётся
таким.

### 1.2 Дельта B — `screen-assistant.jsx`: чтение статуса + рендер баннера (F2-F5, AC-4/AC-5/AC-8)

Новый хук `useAssistantLlmStatus()` (соседствует с `useThreadsStub`/`useMessagesStub` —
тот же файл, тот же стиль):

```js
function useAssistantLlmStatus() {
  const [state, setState] = useState({ loading: true, llmBound: null });

  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    fetch('/api/agents', { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        const assistant = (d.agents || []).find((a) => a.slug === 'assistant-agent');
        // F5: не найдена запись → llmBound остаётся null (баннер не рендерится —
        // честная неизвестность, не «точно сломано»).
        setState({ loading: false, llmBound: assistant ? assistant.llm_bound : null });
      })
      .catch(() => setState({ loading: false, llmBound: null }));
  }, []);

  useEffect(() => { load(); }, [load]);
  // F7: on-focus перечитывание — возврат с /llm-connections после привязки ключа.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  return state; // { loading, llmBound: boolean | null }
}
```

`llmBound === null` покрывает ОБА честных «неизвестно»-случая (F5): сетевая ошибка И
запись не найдена — баннер не показывается ни в loading (F3), ни в unknown-состоянии;
показывается ТОЛЬКО когда `llmBound === false` (доказанный факт отсутствия ключа, F4).
Это не то же самое, что «скрывать проблему» — 503-путь (F8) остаётся страховкой на
случай реальной попытки отправки, баннер — best-effort превенция, не единственная линия
обороны.

`AssistantScreen` (`:1012` уже существующего компонента) вызывает
`useAssistantLlmStatus()` РЯДОМ с существующими хуками и рендерит баннер НАД
`ThreadView`/`NothingSelected` (виден независимо от того, выбран ли тред — баннер про
состояние ассистента в целом, не про конкретный разговор):

```jsx
const { loading: llmLoading, llmBound } = useAssistantLlmStatus();
const showLlmBanner = !llmLoading && llmBound === false;
...
{showLlmBanner && <AssistantLlmBanner />}
```

### 1.3 Дельта C — admin-решение для кнопки (F6, AC-6/AC-7) — БЕЗ нового запроса

`AssistantLlmBanner` (новый локальный компонент, тот же файл) читает admin-статус
СИНХРОННО из уже резолвленного клиентского кэша:

```js
import { getNavCapabilities } from '../app-shell/active-tenant.js';

function AssistantLlmBanner() {
  const navigate = useNavigate();
  const navCaps = getNavCapabilities(); // синхронный геттер, уже резолвлен shell.jsx до маунта экрана
  const isAdmin = Boolean(navCaps && (navCaps.isGenesisOwner || (navCaps.zones || []).includes('admin')));

  return (
    <Notice
      tone="warning"
      title="Ассистент пока не может отвечать"
      message={
        isAdmin
          ? 'Не подключён LLM-ключ. Подключите или проверьте ключ на странице «LLM-соединения».'
          : 'Не подключён LLM-ключ. Обратитесь к администратору вашей организации, чтобы подключить ключ.'
      }
      action={isAdmin && (
        <Button variant="ghost" size="sm" onClick={() => navigate('/llm-connections')}>
          Открыть LLM-соединения
        </Button>
      )}
    />
  );
}
```

`getNavCapabilities()` (`active-tenant.js:86-88`) — синхронный геттер module-level
кэша, заполняемого ОДИН РАЗ за сессию `shell.jsx` auth-bootstrap (`resolveNavCapabilities()`,
`shell.jsx:798-805`) ДО того, как защищённые маршруты (включая `/assistant`) вообще
монтируются (тот же `authReady`-гейт, что охраняет весь `AppShell`). Никакого нового
`fetch` не требуется — тот же вызов, которым РЕШАЕТСЯ видимость admin-зоны в сайдбаре
(`nav-config.js::projectZones`). Кнопка навигационная (`navigate('/llm-connections')`) —
НЕ обходит серверный гейт T-0595 (тот управляет ДЕТАЛЯМИ honest-503 envelope на
сервере); здесь клиент решает ровно то же самое «видна ли мне эта дверь», что уже решает
сайдбар для ТОГО ЖЕ пункта `llm-connections` (`nav-config.js:162`, capability
`mgmt_object:*`). Если предикат неверен — некорректен весь сайдбар, это не новая
поверхность риска, вводимая T-0599.

Текст admin-варианта называет страницу «LLM-соединения» (факт. nav/h1-титул,
`nav-config.js:162`, `screen-llm-connections.jsx` h1) — синхронно с UX_REVIEW T-0595
F-1 нитом (та же путаница «Подключения LLM» vs «LLM-соединения» была найдена и
исправлена там; T-0599 сразу пишет правильное имя, не повторяет тот же nit).

### 1.4 Дельта D — kit-компонент `Notice` (F-компонент, AC-12)

`web/src/components/components.jsx` не содержит персистентного warning-баннера —
только `Toast` (транзиентный) и `Badge` (инлайн-чип). Новый экспорт `Notice`
(соседствует с `Toast`, тот же файл, тот же токен-набор):

```jsx
function Notice({ tone = 'info', title, message, action, className = '' }) {
  return (
    <div
      className={`chs-notice chs-notice--${tone} ${className}`}
      role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
    >
      <span className="chs-notice__icon">
        <KitIcon name={tone === 'warning' ? 'warning' : tone === 'error' ? 'error' : 'info'} size={16} />
      </span>
      <div className="chs-notice__body">
        {title && <div className="chs-notice__title">{title}</div>}
        {message && <div className="chs-notice__msg">{message}</div>}
      </div>
      {action && <div className="chs-notice__action">{action}</div>}
    </div>
  );
}
```

CSS (`web/src/design/app.css`, соседствует с `.chs-toast`) — только `--chs-*`
токены (`--chs-color-warning-soft` фон, `--chs-color-warning` бордер/акцент,
уже парные в обеих темах, `tokens.css:193-195/263-265` — G2 не нарушается, новых
токенов не вводится). Экспортируется из `components.jsx` рядом с `Toast`/`Badge` —
переиспользуемый kit-примитив, не one-off inline styling (в отличие от разового
`floor2Flag`-баннера в `MessageBubble`, который — намеренно ad-hoc для той узкой
плашки; здесь явно просят kit-компонент, т.к. паттерн потенциально переиспользуем
другими экранами позже).

### 1.5 Почему НЕ отдельный эндпойнт / НЕ второе поле

Рамка задачи прямо требует reuse. `GET /api/agents` уже возвращает всё нужное
(`llm_bound`, `llm_connection_id`, `slug`) БЕЗ admin-гейта — идеальный источник для
превентивного баннера, видимого любому пользователю независимо от роли. Единственная
проблема — значение поля было неверным для connection-based агентов; чинить ИСТОЧНИК
(а не городить второе, «настоящее» поле рядом) — единственный вариант, где остаётся
ОДИН источник правды, используемый и админ-экраном агентов (`screen-agents.jsx`), и
новым баннером, и совпадающий с тем, что реально решает рантайм при вызове LLM.

## 2. Отклонённые альтернативы

| Вариант | Почему нет |
|---|---|
| Новый эндпойнт `GET /api/assistant/llm-status` | Прямо запрещено рамкой задачи (reuse существующих). `GET /api/agents` уже содержит всё нужное после фикса — второй эндпойнт дублировал бы источник правды. |
| Вызывать `GET /api/llm-connections` для проверки статуса | Эндпойнт admin-only (`canConfigureLlmConnection`, 403 для builder-не-админа) — вызов от ЛЮБОГО пользователя экрана ассистента означал бы систематический 403 для не-админов на каждую загрузку экрана. `GET /api/agents` не имеет такого гейта и уже агрегирует нужный boolean. |
| Оставить `llm_bound` как есть, вычислять «настоящий» статус вторым полем (`llm_resolved_bound`) на клиенте эвристикой | Плодит два источника правды с шансом разойтись; клиент не имеет доступа к `llm_connection.secret_handle` НИКАК (это и не должен) — эвристика на клиенте невозможна без утечки. Единственно честный путь — чинить сервер. |
| Клиент запрашивает admin-статус отдельным `fetch('/api/me/nav-capabilities')` при монтировании экрана ассистента | Дублирует уже сделанный shell-запрос (лишний round-trip на каждую загрузку экрана); `getNavCapabilities()` синхронно возвращает уже резолвленное значение — гонки нет, т.к. `authReady` гейтит рендер маршрутов ДО завершения `resolveNavCapabilities()`. |
| Polling каждые N секунд для «живого» статуса | Спека явно ограничивает F7 до on-mount/on-focus («realtime не нужен») — polling добавил бы нагрузку без требуемой пользы; возврат с `/llm-connections` — единственный практический сценарий смены статуса, и focus-событие его покрывает. |
| Рендерить disabled-кнопку для не-админа вместо полного её отсутствия | Тот же анти-паттерн, что отклонён в T-0595 («честно назвали, нечестно предложили») — mirрор решения T-0595, не изобретаем заново. |
| Встроить баннер прямо в JSX `AssistantScreen` без выделения `Notice`-компонента (ad-hoc `<div>` как `floor2Flag`) | Задача явно просит kit-компонент (Alert/notice-паттерн) — разовый inline-div создал бы вторую нестандартную реализацию «предупреждения» рядом с `Toast`, увеличивая расхождение kit-поверхности. |

## 3. Object model

| entity | fields |
|---|---|
| `AgentPublic` (существующий, `src/http/agents-list.ts:137-167`) | без изменений по ИМЕНАМ полей; `llm_bound: boolean` теперь резолвится честно (COALESCE с `llm_connection.secret_handle`) |
| `AssistantLlmStatusState` (client-only, не персистится) | `loading: boolean`, `llmBound: boolean \| null` |
| `Notice` (новый kit-компонент, `components.jsx`) | `tone: 'info'\|'warning'\|'error'`, `title?: string`, `message?: string`, `action?: ReactNode`, `className?: string` |

## 4. Контракты для coder/tester

1. `src/http/agents-list.ts::listAgentsTx` — SQL LEFT JOIN `choros.llm_connection`,
   `COALESCE` на `endpoint`/`model`/`secret_handle` (см. §1.1). `serializeAgent` НЕ
   меняется (те же имена полей, честные входные данные).
2. `src/__tests__/agents-list.test.ts` — расширяется юнит-тестами на все 4 комбинации
   (`ac.llm_secret_handle` × `lc.secret_handle`, null/non-null) — AC-3.
3. `ci/checks/db/*` (или новый `assistant-llm-status.test.ts` рядом с
   `assistant-llm-unavailable.test.ts`) — живой DB-тест на AC-1/AC-2 (реальный
   `llm_connection` row с `secret_handle` привязан к assistant-agent → `GET /api/agents`
   возвращает `llm_bound:true`).
4. `web/src/screens/screen-assistant.jsx` — `useAssistantLlmStatus()` хук +
   `AssistantLlmBanner` компонент + рендер над `ThreadView`/`NothingSelected` (см. §1.2/1.3).
5. `web/src/components/components.jsx` — новый экспорт `Notice` (см. §1.4), добавлен
   в `export { ... }` список рядом с `Toast`.
6. `web/src/design/app.css` (или где живёт `.chs-toast`) — `.chs-notice*` CSS-классы,
   только `--chs-*` токены.
7. `web/src/screens/__tests__/screen-assistant.llm-banner.test.js` (новый, source-presence
   convention — см. `screen-assistant.error-envelope.test.js`) — проверяет наличие
   хука, fetch на `/api/agents`, условие рендера баннера, admin/non-admin ветвление,
   отсутствие регресса 503-пути.
8. `docs/handoff/T-0599.pr-handoff.json` — BUILD-фаза.

## 5. Fitness-функции

| id | правило | ci_check |
|---|---|---|
| FF-1 | AC-1: `GET /api/agents` возвращает `llm_bound:true` для assistant-agent, привязанного через `llm_connection.secret_handle` (inline `agent_card.llm_secret_handle` NULL). | живой DB-тест (`ci/checks/db/*` или root vitest, реальный Postgres) |
| FF-2 | AC-2: `GET /api/agents` возвращает `llm_bound:false`, когда ни connection, ни inline-handle не заданы. | тот же DB-тест |
| FF-3 | AC-3: `serializeAgent`/SQL-резолюция покрыта юнит-тестами на 4 комбинации. | `vitest run src/__tests__/agents-list.test.ts` |
| FF-4 | AC-4: баннер не рендерится до разрешения запроса. | `vitest run web/src/screens/__tests__/screen-assistant.llm-banner.test.js` |
| FF-5 | AC-5: баннер рендерится при `llm_bound:false`, warning-тон, без жаргона. | тот же тестовый файл |
| FF-6 | AC-6: admin видит кнопку с `navigate('/llm-connections')`. | тот же тестовый файл |
| FF-7 | AC-7: не-admin не видит кнопку, текст без голого пути. | тот же тестовый файл |
| FF-8 | AC-8: баннер не рендерится при `llm_bound:true`. | тот же тестовый файл |
| FF-9 | AC-9: 503-путь не регрессирует — существующие 12 тестов `screen-assistant.error-envelope.test.js` проходят без изменений. | `vitest run web/src/screens/__tests__/screen-assistant.error-envelope.test.js` |
| FF-10 | AC-10: полный локальный CI (root+web) зелёный. | `npm run ci && (cd web && npx vitest run)` |
| FF-11 | AC-11: UX-гейты g2/g5/g6 зелёные / без новых находок. | `bash ci/checks/ux/ux-g2-theme-pairing.sh && bash ci/checks/ux/ux-g5-jargon-denylist.sh && bash ci/checks/ux/ux-g6-no-new-hardcode.sh` |
| FF-12 | AC-12: `Notice` использует только `--chs-*` токены, экспортирован и переиспользован (grep-проверка на hex/rgba в новых строках). | `bash ci/checks/ux/ux-g6-no-new-hardcode.sh` + source-presence тест |

## 6. Traceability

| ac | covered_by |
|---|---|
| AC-1 | FF-1 |
| AC-2 | FF-2 |
| AC-3 | FF-3 |
| AC-4 | FF-4 |
| AC-5 | FF-5 |
| AC-6 | FF-6 |
| AC-7 | FF-7 |
| AC-8 | FF-8 |
| AC-9 | FF-9 |
| AC-10 | FF-10 |
| AC-11 | FF-11 |
| AC-12 | FF-12 |

## 7. Эскалация

Нет. Весь механизм переиспользует существующие поверхности (`GET /api/agents`,
`getNavCapabilities()`, nav-config admin-предикат, T-0595 текстовый паттерн) — фикс
`agents-list.ts` — коррекция бага честности в уже существующем контракте, не новая
архитектура. Единственное новое: `Notice` kit-компонент (запрошен явно в задаче) и
клиентский хук чтения статуса.

---

*Файл: `docs/adr/ADR-T0599-assistant-banner.md`. См. также
`docs/adr/T-0599.adr.contract.json` (машиночитаемый дубликат для validate.py).*
