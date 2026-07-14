/**
 * violation-i18n.js — T-0761: finishes the "человеческим русским" goal T-0659
 * started for publish-time BPMN lint violations.
 *
 * T-0659 (screen-process-editor.jsx VIOLATION_TYPE_LABELS) gave every
 * LintViolationType a Russian TITLE and stopped truncating the .message body
 * at 120 chars. Its own follow-up review (docs/tasks/T-0659.ux-review.json,
 * findings T-0659-UX-N2/N3) flagged that the .message BODY itself is still
 * authored server-side (src/core/bpmn-linter.ts, src/http/process-defs.ts) in
 * English/XML-technical prose, and elementKind (e.g. "boundaryEvent") renders
 * as raw BPMN camelCase mid-sentence.
 *
 * This module finishes that gap from the SAME layer T-0659 used — client-side,
 * additive, fallback-safe, server contract untouched (confirmed: zero diff
 * under src/ from this task) — rather than rewriting server message strings,
 * because dozens of existing server-side tests
 * (src/__tests__/bpmn-linter.test.ts and siblings) assert on the exact English
 * substrings of LintViolation.message; rewriting them server-side would be a
 * much larger, riskier, cross-cutting change than this task's scope.
 *
 * Every message this module translates is an AUTHORED TS TEMPLATE LITERAL in
 * the server (not free-form user text) — the set of shapes is finite and
 * enumerable. HUMANIZERS below matches each known shape with a regex anchored
 * on the STABLE English scaffold phrasing (dynamic tokens — ids, counts,
 * variable names — are captured, not hard-coded) and renders a Russian detail
 * sentence + a Russian "как починить" action hint. Any message that does not
 * match a known shape (e.g. an exotic low-level XML-tokenizer edge case from a
 * hand-corrupted file) safely falls back to the raw, untranslated .message —
 * shown in FULL, never hidden, never truncated — exactly like T-0659's own
 * fallback discipline. Never throws.
 */

// ---------------------------------------------------------------------------
// ELEMENT_KIND_LABELS — BPMN elementKind -> human Russian noun phrase.
// Symmetric with VIOLATION_TYPE_LABELS (screen-process-editor.jsx, T-0659):
// covers every elementKind value src/core/bpmn-linter.ts + src/http/process-defs.ts
// actually emit on a LintViolation today. Additive: any kind not yet listed
// here still renders (falls back to the raw camelCase string), it just isn't
// translated — same fallback discipline as VIOLATION_TYPE_LABELS.
// ---------------------------------------------------------------------------
export const ELEMENT_KIND_LABELS = {
  serviceTask: 'сервисный шаг',
  userTask: 'пользовательский шаг',
  sendTask: 'шаг отправки сообщения',
  receiveTask: 'шаг ожидания сообщения',
  boundaryEvent: 'граничное событие',
  intermediateCatchEvent: 'промежуточное событие ожидания',
  parallelGateway: 'параллельный шлюз (И)',
  exclusiveGateway: 'шлюз выбора (ИЛИ)',
  dataObject: 'объект данных',
  dataObjectReference: 'ссылка на объект данных',
  conditionExpression: 'условие перехода',
  application: 'приложение',
};

/**
 * Renders a human element label, translating elementKind via
 * ELEMENT_KIND_LABELS when known. Mirrors the layout ViolationItem already
 * used pre-T-0761 (kind + «id», or kind alone when there is no id) — only the
 * kind word itself is now translated.
 *
 * `malformed_xml` / `binding_mismatch` violations set elementKind === type as
 * a sentinel (the violation is document-level, not tied to one diagram
 * element — see src/core/bpmn-linter.ts lines ~452/474/875/890) — those
 * return null (nothing useful to add over the title, which already names the
 * rule).
 *
 * @param {{ type?: string, elementId?: string, elementKind?: string }} v
 * @returns {string|null}
 */
export function formatElementLabel(v) {
  if (!v || typeof v !== 'object') return null;
  if (v.elementKind && v.elementKind === v.type) return null; // document-level sentinel, not a real element
  const kindLabel = v.elementKind ? (ELEMENT_KIND_LABELS[v.elementKind] || v.elementKind) : '';
  if (v.elementId) {
    return `${kindLabel ? kindLabel + ' ' : ''}«${v.elementId}»`;
  }
  return kindLabel || null;
}

// ---------------------------------------------------------------------------
// Per-type message humanizers.
//
// Each entry: { re: RegExp, render: (match) => { detail: string, fix?: string } }
// `re` is matched against the raw v.message with .match() (not fully anchored
// at the end with `$` in every case — some server messages have discourse
// after the part we translate; we anchor only on the STABLE lead clause so a
// future wording tweak in the trailing prose does not silently break the
// match). Tried in array order; first match wins.
// ---------------------------------------------------------------------------
const HUMANIZERS = {
  raw_object_binding: [
    {
      re: /^raw-object binding detected in (attribute "([^"]+)" of|text content of) <([^>]+)>: value contains record-identity or payload keys; use an ObjectHandle instead$/,
      render: (m) => {
        const where = m[2] ? `в атрибуте «${m[2]}»` : 'в тексте элемента';
        return {
          detail: `Обнаружена привязка «сырого» объекта записи ${where} (<${m[3]}>): значение содержит поля идентичности записи или полезной нагрузки вместо ссылки на объект.`,
          fix: 'Используйте ObjectHandle (привязку к объекту) вместо прямой передачи данных записи.',
        };
      },
    },
  ],

  malformed_xml: [
    {
      re: /^document contains invalid UTF-8 sequences \(U\+FFFD replacement character detected\)$/,
      render: () => ({
        detail: 'Файл содержит некорректные байты UTF-8 (обнаружен символ-заменитель U+FFFD).',
        fix: 'Пересохраните файл процесса в кодировке UTF-8 без потери данных, либо пересоздайте диаграмму в редакторе.',
      }),
    },
    {
      re: /^document has (\d+) unclosed element\(s\): (.+)$/,
      render: (m) => ({
        detail: `Документ не закрывает ${m[1]} XML-элемент(ов): ${m[2]}.`,
        fix: 'Проверьте, что каждый открытый тег в BPMN XML закрыт, либо пересоздайте диаграмму в визуальном редакторе.',
      }),
    },
    // T-0071 tokenizer parse-error reasons (src/core/bpmn-xml-parser.ts) — a
    // finite, enumerable list of low-level XML syntax errors surfaced when a
    // hand-edited/corrupted diagram fails to tokenize.
    {
      re: /^null byte in XML document \(illegal per XML 1\.0 §2\.2\)$/,
      render: () => ({ detail: 'В документе обнаружен нулевой байт — запрещено спецификацией XML 1.0 §2.2.' }),
    },
    {
      re: /^unclosed XML declaration$/,
      render: () => ({ detail: 'Не закрыта XML-декларация («<?xml ... ?>»).' }),
    },
    {
      re: /^XML version "([^"]*)" not supported; only 1\.0 is accepted$/,
      render: (m) => ({ detail: `Версия XML «${m[1]}» не поддерживается — принимается только версия 1.0.` }),
    },
    {
      re: /^encoding "([^"]*)" not supported; BPMN deploy artifacts must be UTF-8$/,
      render: (m) => ({ detail: `Кодировка «${m[1]}» не поддерживается — файл процесса должен быть в UTF-8.` }),
    },
    {
      re: /^invalid or non-predefined entity reference in text content at offset (\d+)$/,
      render: (m) => ({ detail: `Недопустимая или неизвестная именованная сущность (entity) в тексте документа, смещение ${m[1]}.` }),
    },
    {
      re: /^unexpected end of document after '<'$/,
      render: () => ({ detail: 'Документ неожиданно обрывается сразу после символа «<».' }),
    },
    {
      re: /^unclosed comment$/,
      render: () => ({ detail: 'Не закрыт XML-комментарий («<!-- ... -->»).' }),
    },
    {
      re: /^comment contains '--' which is illegal inside XML comments$/,
      render: () => ({ detail: 'XML-комментарий содержит «--», что запрещено внутри комментариев.' }),
    },
    {
      re: /^unclosed CDATA section$/,
      render: () => ({ detail: 'Не закрыт блок CDATA.' }),
    },
    {
      re: /^DOCTYPE declarations are not permitted in BPMN deploy artifacts \(entity injection risk\)$/,
      render: () => ({ detail: 'Объявления DOCTYPE запрещены в файлах процессов (риск entity-инъекции).' }),
    },
    {
      re: /^unknown markup declaration at offset (\d+)$/,
      render: (m) => ({ detail: `Неизвестное объявление разметки, смещение ${m[1]}.` }),
    },
    {
      re: /^processing instructions are not permitted in BPMN deploy artifacts$/,
      render: () => ({ detail: 'Инструкции обработки (processing instructions) запрещены в файлах процессов.' }),
    },
    {
      re: /^unclosed close-tag$/,
      render: () => ({ detail: 'Не закрыт закрывающий тег.' }),
    },
    {
      re: /^empty close-tag name$/,
      render: () => ({ detail: 'Пустое имя закрывающего тега.' }),
    },
    {
      re: /^empty local name in close-tag "(.*)"$/,
      render: (m) => ({ detail: `Пустое локальное имя в закрывающем теге «${m[1]}».` }),
    },
    {
      re: /^document nesting depth exceeds maximum of (\d+) levels$/,
      render: (m) => ({ detail: `Превышена максимальная глубина вложенности XML (${m[1]} уровней).` }),
    },
    {
      re: /^empty tag name$/,
      render: () => ({ detail: 'Пустое имя тега.' }),
    },
    {
      re: /^empty local name in tag "(.*)"$/,
      render: (m) => ({ detail: `Пустое локальное имя в теге «${m[1]}».` }),
    },
    {
      re: /^unexpected end of document inside tag$/,
      render: () => ({ detail: 'Документ неожиданно обрывается внутри тега.' }),
    },
    {
      re: /^unexpected character '(.*)' in tag <(.+)>$/,
      render: (m) => ({ detail: `Недопустимый символ «${m[1]}» в теге <${m[2]}>.` }),
    },
    {
      re: /^attribute "(.+)" missing value in tag <(.+)>$/,
      render: (m) => ({ detail: `У атрибута «${m[1]}» в теге <${m[2]}> отсутствует значение.` }),
    },
    {
      re: /^unexpected end of document after '='$/,
      render: () => ({ detail: 'Документ неожиданно обрывается сразу после «=».' }),
    },
    {
      re: /^unquoted attribute value in tag <(.+)> \(XML requires quoted attribute values\)$/,
      render: (m) => ({ detail: `Значение атрибута в теге <${m[1]}> не заключено в кавычки (XML требует кавычки).` }),
    },
    {
      re: /^unclosed attribute value in tag <(.+)>$/,
      render: (m) => ({ detail: `Не закрыто значение атрибута в теге <${m[1]}>.` }),
    },
    {
      re: /^attribute value in tag <(.+)> exceeds maximum size of (\d+) bytes$/,
      render: (m) => ({ detail: `Значение атрибута в теге <${m[1]}> превышает максимально допустимый размер (${m[2]} байт).` }),
    },
    {
      re: /^invalid or non-predefined entity in attribute "(.+)" of tag <(.+)>$/,
      render: (m) => ({ detail: `Недопустимая или неизвестная именованная сущность в атрибуте «${m[1]}» тега <${m[2]}>.` }),
    },
    {
      re: /^duplicate namespace prefix declaration "(.+)" \(ambiguous parsing\)$/,
      render: (m) => ({ detail: `Повторное объявление префикса пространства имён «${m[1]}» (неоднозначный разбор).` }),
    },
    {
      re: /^duplicate attribute "(.+)" on element <(.+)> \(parser-differential exploit path\)$/,
      render: (m) => ({ detail: `Повторяющийся атрибут «${m[1]}» на элементе <${m[2]}> (риск разночтения между разборщиками XML).` }),
    },
    {
      re: /^unexpected end of document inside open tag$/,
      render: () => ({ detail: 'Документ неожиданно обрывается внутри открывающего тега.' }),
    },
  ],

  binding_mismatch: [
    {
      re: /^BPMN variable "([^"]+)" is not declared in the form binding schema$/,
      render: (m) => ({
        detail: `Переменная процесса «${m[1]}» не объявлена в схеме привязки формы.`,
        fix: `Добавьте переменную «${m[1]}» в схему привязки формы либо уберите её использование в диаграмме.`,
      }),
    },
    {
      re: /^Form field key "([^"]+)" is not referenced in any BPMN variable source$/,
      render: (m) => ({
        detail: `Поле формы «${m[1]}» не связано ни с одной переменной процесса.`,
        fix: `Свяжите поле «${m[1]}» с переменной BPMN-процесса либо удалите поле из формы.`,
      }),
    },
  ],

  gateway_rule_mismatch: [
    {
      re: /^<.+?> uses routing variable "([^"]+)" but no published rule table declares a routing outcome with that name;/,
      render: (m) => ({
        detail: `Шлюз использует переменную маршрутизации «${m[1]}», но нет опубликованной таблицы правил с таким исходом.`,
        fix: `Опубликуйте таблицу правил, задающую исход маршрутизации «${m[1]}», перед публикацией процесса.`,
      }),
    },
    {
      re: /^<.+?> has a branch condition "([^"]+) == '([^']*)'" but the rule table for routing outcome "([^"]+)" does not produce the value "([^"]*)";/,
      render: (m) => ({
        detail: `Условие ветвления «${m[1]} == '${m[2]}'» не может сработать: таблица правил для исхода «${m[3]}» не выдаёт значение «${m[4]}».`,
        fix: 'Обновите таблицу правил, чтобы она выдавала нужное значение, либо удалите это условие ветвления.',
      }),
    },
  ],

  parallel_gateway_imbalance: [
    {
      re: /^<.+?> is dangling: it has (\d+) incoming and (\d+) outgoing sequence flow\(s\)\./,
      render: (m) => ({
        detail: `Параллельный шлюз оторван от потока: у него ${m[1]} входящих и ${m[2]} исходящих связей. У шлюза должен быть минимум один входящий и один исходящий поток: у развилки — 1 входящий и ≥2 исходящих, у слияния — ≥2 входящих и 1 исходящий.`,
        fix: 'Добавьте недостающие входящие/исходящие связи для этого шлюза.',
      }),
    },
    {
      re: /^<.+?> mixes split and join: it has (\d+) incoming and (\d+) outgoing flows\./,
      render: (m) => ({
        detail: `Один параллельный шлюз одновременно делает и развилку, и слияние (${m[1]} входящих, ${m[2]} исходящих).`,
        fix: 'Разделите его на два разных шлюза: отдельную развилку (1 входящий, ≥2 исходящих) и отдельное слияние (≥2 входящих, 1 исходящий).',
      }),
    },
  ],

  timer_malformed: [
    {
      re: /^<.+?> has a <timerEventDefinition> without a valid deadline:/,
      render: () => ({
        detail: 'У таймера не задан дедлайн: нужно указать длительность (например, PT24H), дату (или выражение вида ${поле.записи}), либо цикл повторения.',
        fix: 'Заполните длительность/дату/цикл таймера в панели настройки таймера.',
      }),
    },
    {
      re: /^<.+?> has a <timeDuration> "([^"]*)" that is not a valid ISO-8601 duration/,
      render: (m) => ({
        detail: `Указанная длительность таймера «${m[1]}» не является корректной ISO-8601-длительностью (пример: PT24H, P1D, P1DT12H).`,
        fix: 'Введите длительность в формате ISO-8601 (например, PT24H) или выражение вида ${поле.записи}.',
      }),
    },
    {
      re: /^<.+?> has a <timeDate> "([^"]*)" that is neither an ISO-8601 date/,
      render: (m) => ({
        detail: `Указанная дата таймера «${m[1]}» не является ни корректной ISO-8601-датой (например, 2026-07-01T14:00:00Z), ни выражением вида \${поле.записи}.`,
        fix: 'Введите дату в формате ISO-8601 или выражение вида ${поле.записи}.',
      }),
    },
    {
      re: /^<.+?> is a boundary timer with no attachedToRef/,
      render: () => ({
        detail: 'Граничный таймер не присоединён ни к одному шагу (нет attachedToRef).',
        fix: 'Присоедините таймер к шагу, дедлайн которого он контролирует.',
      }),
    },
    {
      re: /^<.+?> has no outgoing sequence flow — when the deadline fires/,
      render: () => ({
        detail: 'У таймера нет исходящего потока: когда сработает дедлайн, эскалации некуда идти.',
        fix: 'Проведите стрелку от таймера к шагу эскалации.',
      }),
    },
  ],

  message_event_incoherent: [
    {
      re: /^<.+?> is a message\/signal catch with NO TIMEOUT/,
      render: () => ({
        detail: 'Ожидание сообщения/сигнала не защищено таймаутом — при отсутствии сообщения процесс будет ждать бесконечно.',
        fix: 'Присоедините граничный таймер (дедлайн) к этому ожиданию.',
      }),
    },
    {
      re: /^<.+?> declares no choros:correlationField/,
      render: () => ({
        detail: 'Не указано поле корреляции (choros:correlationField) — непонятно, по какому бизнес-ключу сопоставлять входящее сообщение.',
        fix: 'Укажите поле записи, которое служит ключом корреляции.',
      }),
    },
    {
      re: /^<.+?> declares no choros:messageName/,
      render: () => ({
        detail: 'Не указано имя сообщения (choros:messageName) — входящий конверт некому адресовать.',
        fix: 'Укажите имя сообщения/сигнала, которое ожидает этот шаг.',
      }),
    },
  ],

  agent_task_incoherent: [
    {
      re: /^<.+?> is an agent step \(choros:executorType="agent"\) with no id/,
      render: () => ({
        detail: 'У агентского шага нет id — без идентификатора его нельзя подключить и адресовать.',
        fix: 'Задайте id этому шагу.',
      }),
    },
    {
      re: /^<.+?> is an agent step but declares no choros:agentRef/,
      render: () => ({
        detail: 'У агентского шага не указан агент (choros:agentRef).',
        fix: 'Выберите агента, который будет выполнять этот шаг (по нему диспетчер загружает права и LLM агента).',
      }),
    },
    {
      re: /^<.+?> is an agent step but is not an external task/,
      render: () => ({
        detail: 'Агентский шаг не оформлен как внешняя задача (flowable:type="external" отсутствует) — диспетчер агентов никогда не увидит эту задачу.',
        fix: 'Отметьте шаг как внешнюю задачу (flowable:type="external").',
      }),
    },
    {
      re: /^<.+?> is an agent step external task but its flowable:topic is "([^"]*)" — it must be "([^"]*)" so the agent dispatcher polls and fires on it$/,
      render: (m) => ({
        detail: `У внешней задачи агентского шага указан topic «${m[1]}», но должно быть «${m[2]}», иначе диспетчер агентов не увидит и не запустит эту задачу.`,
        fix: `Замените flowable:topic на «${m[2]}».`,
      }),
    },
  ],

  timer_escalation_no_convergence: [
    {
      re: /^<.+?> is a NON-INTERRUPTING boundary timer \(cancelActivity="false"\) whose escalation branch reaches its own endEvent WITHOUT reconnecting to the guarded task's own downstream path\. If the guarded task \(attachedToRef="([^"]*)"\) completes before the deadline fires, the escalation branch's token is never cancelled and never reaches an end either/,
      render: (m) => ({
        detail: `Неблокирующий (cancelActivity="false") граничный таймер эскалации доходит до собственного конечного события, не соединяясь с обычным потоком завершения охраняемого шага (attachedToRef="${m[1]}"). Если охраняемый шаг завершится раньше, чем сработает таймер, экземпляр процесса никогда не закроется (act_hi_procinst.end_time останется NULL), даже если основной путь уже завершился.`,
        fix: 'Соедините ветку эскалации с общим шлюзом, куда также приходит обычное завершение охраняемого шага, либо установите cancelActivity="true", если эскалация должна отменять шаг, а не просто напоминать.',
      }),
    },
  ],

  // T-0661 [ADR-T0612 §8]: convergence alone is NOT sufficient — a converging
  // exclusiveGateway is an uncontrolled merge, so once the timer FIRES it
  // spawns a second concurrent token that a plain endEvent can never resolve.
  timer_escalation_unresolved_concurrency: [
    {
      re: /^<.+?> is a NON-INTERRUPTING boundary timer \(cancelActivity="false"\) whose escalation branch RECONNECTS to the guarded task's \(attachedToRef="([^"]*)"\) downstream path \(flow convergence exists\) but no terminateEndEvent is reachable from the escalation branch/,
      render: (m) => ({
        detail: `Неблокирующий (cancelActivity="false") граничный таймер эскалации СХОДИТСЯ с обычным потоком завершения охраняемого шага (attachedToRef="${m[1]}"), но ни один reachable-узел ветки эскалации не является terminate-событием. Когда таймер СРАБАТЫВАЕТ, он порождает ВТОРОЙ, независимый токен (токен охраняемого шага остаётся живым) — сходящийся шлюз/конечное событие пропускает каждый токен независимо, поэтому экземпляр процесса завершится только после того, как ЗАВЕРШАТСЯ ОБЕ задачи: он зависает, пока вторая, уже неактуальная задача тоже не будет закрыта.`,
        fix: 'Направьте схождение веток в scope-local terminateEndEvent (например, внутри вложенного sub-process), чтобы первое из завершений отменяло вторую, гоняющуюся задачу.',
      }),
    },
  ],

  app_binding_unpublished: [
    {
      re: /^This process binds application "([^"]*)" \(slug="([^"]*)"\) which is still a SANDBOX \(draft\) application/,
      render: (m) => ({
        detail: `Процесс использует приложение «${m[1]}» (slug=«${m[2]}»), которое всё ещё в песочнице (черновик) — опубликованный процесс не может зависеть от черновика приложения.`,
        fix: `Сначала опубликуйте (промотируйте) приложение «${m[1]}» — отдельно или вместе с процессом в одном пакете решения — затем опубликуйте процесс.`,
      }),
    },
  ],

  step_target_unresolved: [
    {
      re: /^This process's approve step writes its result into a registry named "([^"]*)" under the bound application/,
      render: (m) => ({
        detail: `Шаг согласования записывает результат в реестр «${m[1]}» привязанного приложения, но такого реестра там ещё нет — первое же согласование завершится ошибкой (STEP_TARGET_UNRESOLVED) вместо публикации.`,
        fix: `Создайте реестр «${m[1]}» в привязанном приложении, либо укажите в привязке процесса другой существующий реестр (target_registry_slug), затем опубликуйте процесс заново.`,
      }),
    },
  ],
};

/**
 * Humanizes ONE LintViolation's .message into a Russian detail + optional
 * "как починить" fix hint. Never throws.
 *
 * Matches `v.message` against the known shapes for `v.type` (HUMANIZERS
 * above). No match (unknown/future violation type, or a message shape not yet
 * covered — e.g. an exotic XML-tokenizer edge case) → falls back to the raw
 * `.message`, unchanged and shown in FULL (matched === false lets callers/
 * tests distinguish "translated" from "fell back to raw" without guessing
 * from content).
 *
 * @param {{ type?: string, message?: string }} v
 * @returns {{ detail: string, fix: string|null, matched: boolean }}
 */
export function humanizeViolation(v) {
  const rawMessage = v && typeof v.message === 'string' ? v.message : '';
  const candidates = (v && v.type && HUMANIZERS[v.type]) || null;
  if (candidates && rawMessage) {
    for (const { re, render } of candidates) {
      const m = rawMessage.match(re);
      if (m) {
        const { detail, fix } = render(m) || {};
        if (typeof detail === 'string' && detail) {
          return { detail, fix: fix || null, matched: true };
        }
      }
    }
  }
  return { detail: rawMessage, fix: null, matched: false };
}
