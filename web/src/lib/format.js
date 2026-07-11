/**
 * format.js — T-0532: Shared label/format layer.
 *
 * Тонкий React-free модуль (нет зависимостей, только stdlib).
 * Экспортирует чистые функции — все компоненты-потребители импортируют отсюда.
 * Нет JSX, нет React, нет внешних зависимостей.
 *
 * Инвариант: ни одна функция не бросает исключений (safe for JSX renders).
 */

// ---------------------------------------------------------------------------
// Встроенный каталог системных enum (единственная правда для всех экранов)
// ---------------------------------------------------------------------------

export const ENUM_LABELS = {
  // Статусы процессов и задач
  draft:       'Черновик',
  published:   'Опубликован',
  running:     'Выполняется',
  pending:     'Ожидает',
  waiting:     'Ожидает',
  completed:   'Завершён',
  done:        'Завершён',
  failed:      'Ошибка',
  paused:      'Приостановлен',
  cancelled:   'Отменён',
  active:      'Активен',
  inactive:    'Неактивен',

  // Типы исполнителей
  human:       'Человек',
  agent:       'Агент',
  service:     'Сервис',

  // Типы полей (field types в каталоге)
  string:      'Текст',
  text:        'Текст (длинный)',
  number:      'Число',
  integer:     'Целое число',
  boolean:     'Флаг (да/нет)',
  date:        'Дата',
  money:       'Сумма (₽)',
  select:      'Выбор из списка',
  'multi-select': 'Мульти-выбор',
  url:         'Ссылка',
  email:       'E-mail',
  person:      'Сотрудник',
  relation:    'Связь с записью',
  collection:  'Таблица (строки)',
  'date-range': 'Период',
  rollup:      'Вычисляемое',
  computed:    'Вычисляемое',
  file:        'Файл',

  // Типы actions / операций прав
  grant:       'Выдача прав',
  revoke:      'Отзыв прав',
  narrow:      'Сужение прав',
};

// ---------------------------------------------------------------------------
// formatDate — дата/время в ru-RU без мс, без Z, без T
// ---------------------------------------------------------------------------

/**
 * Форматирует дату в человекочитаемый вид на русском языке.
 *
 * @param {Date|string|number|null|undefined} value - Date, ISO-строка, epoch-ms или null
 * @param {'datetime'|'date'|'time'} [mode='datetime'] - что показывать
 * @returns {string} - локализованная строка или '—' для null/undefined/невалидного
 *
 * Примеры:
 *   formatDate('2026-06-29T14:32:08.123Z') → '29 июн 2026, 14:32'
 *   formatDate('2026-06-29T14:32:08.123Z', 'date') → '29 июн 2026'
 *   formatDate(null) → '—'
 */
export function formatDate(value, mode = 'datetime') {
  if (value === null || value === undefined || value === '') return '—';

  let d;
  try {
    if (value instanceof Date) {
      d = value;
    } else {
      d = new Date(value);
    }
    // NaN check
    if (isNaN(d.getTime())) return '—';
  } catch {
    return '—';
  }

  try {
    if (mode === 'date') {
      return d.toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    }
    if (mode === 'time') {
      return d.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      });
    }
    // 'datetime' (default): '29 июн 2026, 14:32'
    return d.toLocaleString('ru-RU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

// ---------------------------------------------------------------------------
// formatShortDate / formatShortDateTime — T-0649: дд.мм.гггг числовой формат
// ---------------------------------------------------------------------------
//
// formatDate (above) renders month NAMES ("29 июн 2026, 14:32") — good for
// prose, but the "date"/"datetime" field CONTROLS (DateInput) and their list/
// detail-view cells need the compact numeric дд.мм.гггг the founder's UX study
// asked for (§2: "в списке дата рендерится сырым ISO 2026-07-05" — the fix is
// NOT month-name prose, it's the numeric дд.мм.гггг every Russian business
// document uses). Kept as separate functions (not a new `formatDate` mode) so
// existing formatDate call sites/tests are untouched (NF-2 additive discipline).

/**
 * Formats an ISO date/datetime string (or Date/epoch-ms) as дд.мм.гггг.
 * Parses the ISO date parts directly (no Date() timezone conversion) when the
 * input already looks like YYYY-MM-DD[...] — this keeps a plain "date" field
 * (no time-of-day, no timezone) stable regardless of the browser's local TZ
 * (a Date() round-trip of a bare "2026-07-05" can shift a day near UTC
 * midnight in a negative-offset TZ). Falls back to Date()-based formatting for
 * epoch-ms/Date inputs (datetime values, which DO carry a real instant).
 *
 * @param {string|number|Date|null|undefined} value
 * @returns {string} "05.07.2026" or '—' for null/undefined/invalid
 */
export function formatShortDate(value) {
  if (value === null || value === undefined || value === '') return '—';

  if (typeof value === 'string') {
    const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      const [, y, m, d] = isoMatch;
      return `${d}.${m}.${y}`;
    }
  }

  let d;
  try {
    d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '—';
  } catch {
    return '—';
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/**
 * Formats an ISO datetime string (or Date/epoch-ms) as "дд.мм.гггг чч:мм".
 *
 * @param {string|number|Date|null|undefined} value
 * @returns {string} "05.07.2026 14:32" or '—' for null/undefined/invalid
 */
export function formatShortDateTime(value) {
  if (value === null || value === undefined || value === '') return '—';
  let d;
  try {
    d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '—';
  } catch {
    return '—';
  }
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  return `${datePart} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// formatEnum — enum → человеческая подпись
// ---------------------------------------------------------------------------

/**
 * Переводит машинное enum-значение в человекочитаемую подпись.
 *
 * Приоритет: labelMap > ENUM_LABELS > value as-is.
 * Не бросает исключений.
 *
 * @param {string} value - машинное значение enum
 * @param {Record<string,string>} [labelMap] - опциональный словарь из schema options
 * @returns {string} - человекочитаемая подпись или value as-is если не найдено
 */
export function formatEnum(value, labelMap) {
  if (value === null || value === undefined) return '—';
  const str = String(value);
  if (labelMap && typeof labelMap === 'object' && Object.prototype.hasOwnProperty.call(labelMap, str)) {
    return labelMap[str];
  }
  if (Object.prototype.hasOwnProperty.call(ENUM_LABELS, str)) {
    return ENUM_LABELS[str];
  }
  return str;
}

// ---------------------------------------------------------------------------
// formatError — HTTP/Server error → дружелюбный текст с шагом действия
// ---------------------------------------------------------------------------

const HTTP_MESSAGES = {
  400: 'Некорректный запрос — проверьте данные',
  401: 'Сессия истекла — войдите снова',
  403: 'Недостаточно прав для этого действия',
  404: 'Запись не найдена',
  409: 'Конфликт — запись уже существует',
  422: 'Данные не прошли проверку — исправьте поля',
  429: 'Слишком много запросов — подождите немного',
  500: 'Ошибка сервера — попробуйте позже',
  502: 'Ошибка сервера — попробуйте позже',
  503: 'Ошибка сервера — попробуйте позже',
  504: 'Ошибка сервера — попробуйте позже',
};

const SERVER_CODE_MESSAGES = {
  ENGINE_UNAVAILABLE: 'Движок процессов недоступен — попробуйте позже',
  SUBSTITUTION_WIDENS: 'Подмена не может расширять права — измените область',
  UNAUTHORIZED: 'Сессия истекла — войдите снова',
  FORBIDDEN: 'Недостаточно прав для этого действия',
  NOT_FOUND: 'Запись не найдена',
  CONFLICT: 'Конфликт — запись уже существует',
  VALIDATION_ERROR: 'Данные не прошли проверку — исправьте поля',
};

/**
 * Переводит HTTP-статус или серверный код ошибки в дружелюбный русский текст.
 *
 * @param {number|string} statusOrCode - HTTP-статус (число) или server error code (строка)
 * @returns {string} - понятный русский текст с шагом действия
 */
export function formatError(statusOrCode) {
  if (statusOrCode === null || statusOrCode === undefined) {
    return 'Что-то пошло не так — попробуйте ещё раз';
  }

  // Числовой HTTP-статус
  if (typeof statusOrCode === 'number') {
    if (HTTP_MESSAGES[statusOrCode]) return HTTP_MESSAGES[statusOrCode];
    // 5xx group
    if (statusOrCode >= 500) return 'Ошибка сервера — попробуйте позже';
    // 4xx group
    if (statusOrCode >= 400) return `Ошибка запроса (${statusOrCode}) — попробуйте ещё раз`;
    return `Что-то пошло не так (${statusOrCode}) — попробуйте ещё раз`;
  }

  // Строковый server error code
  const code = String(statusOrCode);

  // Проверяем, не является ли это паттерном "HTTP NNN"
  const httpMatch = code.match(/^HTTP\s+(\d{3})$/i);
  if (httpMatch) {
    const num = parseInt(httpMatch[1], 10);
    return formatError(num);
  }

  if (SERVER_CODE_MESSAGES[code]) return SERVER_CODE_MESSAGES[code];

  return `Что-то пошло не так (${code}) — попробуйте ещё раз`;
}

// ---------------------------------------------------------------------------
// formatPersonName — T-0608 (пункт г): человек-фолбэк для пустого display_name
// ---------------------------------------------------------------------------

/**
 * Разрешает отображаемое имя человека/сотрудника с честным фолбэком.
 *
 * Живой факт приёмки: employee-запись без имени рендерилась как сырой
 * UUID/slug («АВТОР: 4c653940-…», сотрудник «4c653940-…» в дропдауне) — ни
 * один экран не отличал «имени нет» от «имя есть, просто короткое». Эта
 * функция — ЕДИНСТВЕННЫЙ уровень честного отображения: имя пусто И email
 * доступен → «Без имени (email)»; имя пусто И email недоступен → «Без
 * имени»; иначе — само имя. Никогда не возвращает сырой UUID/slug молча —
 * тот остаётся доступен вызывающему как последний fallback (this function
 * does not know about slug/id; callers pass it only when name+email are both
 * absent, mirroring the existing `a.employee_display || a.employee_slug ||
 * a.employee_id` chains already in ra-overview-forms.jsx/screen-rights.jsx).
 *
 * @param {string|null|undefined} name - display_name (может быть '' или null)
 * @param {string|null|undefined} [email] - email/slug для фолбэка в скобках
 * @returns {string|null} - имя, «Без имени (email)», «Без имени», или null
 *   (null когда И имя, И email отсутствуют — вызывающий сам решает последний
 *   fallback, напр. raw id/slug, чтобы НИЧЕГО не потерялось молча)
 */
export function formatPersonName(name, email) {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (trimmedName) return trimmedName;
  const trimmedEmail = typeof email === 'string' ? email.trim() : '';
  if (trimmedEmail) return `Без имени (${trimmedEmail})`;
  return null;
}

// ---------------------------------------------------------------------------
// formatRef — UUID/id/slug → имя сущности из кэша
// ---------------------------------------------------------------------------

/**
 * Разрешает UUID/id/slug в имя сущности из уже загруженного кэша.
 * Синхронный: кэш передаётся снаружи (Map<id, label> в useState компонента).
 *
 * @param {string} value - UUID, id или slug
 * @param {Map<string,string>} cache - Map<id, label> с уже загруженными именами
 * @param {{ fallback?: string }} [options] - fallback по умолчанию '—'
 * @returns {string} - имя из кэша или fallback
 */
export function formatRef(value, cache, options) {
  if (value === null || value === undefined || value === '') {
    return (options && options.fallback != null) ? options.fallback : '—';
  }
  const str = String(value);
  if (cache instanceof Map && cache.has(str)) {
    return cache.get(str);
  }
  return (options && options.fallback != null) ? options.fallback : '—';
}

// ---------------------------------------------------------------------------
// formatJsonReadable — объект → строка для read-only отображения
// ---------------------------------------------------------------------------

const MAX_JSON_LENGTH = 120;

/**
 * Форматирует объект/массив в читаемую строку для read-only отображения.
 * Не рендерить как JSX-пре — это строка для span/td.
 *
 * НАЗНАЧЕНИЕ: компактный превью произвольного JSON-значения в узкой
 * колонке/строке (например значение поля в общем списке записи), где
 * усечение приемлемо. T-0659: НЕ использовать для рендера структурированных
 * ошибок (lint-нарушений публикации процесса и т.п.) — 120-символьный лимит
 * съедает actionable-подсказку из хвоста длинного .message. Для таких
 * случаев рендерить .message человеку ЦЕЛИКОМ (см. ViolationItem в
 * web/src/screens/screen-process-editor.jsx).
 *
 * @param {unknown} value - любое значение
 * @returns {string} - читаемая строка (≤120 символов + '…' если длиннее)
 */
export function formatJsonReadable(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);

  try {
    const str = JSON.stringify(value);
    if (str.length <= MAX_JSON_LENGTH) return str;
    return str.slice(0, MAX_JSON_LENGTH) + '…';
  } catch {
    return '—';
  }
}

// ---------------------------------------------------------------------------
// formatDuration — ISO-duration → человекочитаемый текст
// (bonus: упомянуто в дизайне §E как followup, добавляем сразу)
// ---------------------------------------------------------------------------

/**
 * Форматирует ISO 8601 duration в читаемую строку.
 * Поддерживает: PTxxH (часы), PTxxM (минуты), PxxD (дни).
 *
 * @param {string} duration - ISO duration, например 'PT24H', 'P7D', 'PT30M'
 * @returns {string} - '24 часа', '7 дней', '30 минут' или исходная строка
 */
export function formatDuration(duration) {
  if (!duration || typeof duration !== 'string') return duration || '—';

  // PxxD — дни
  const dayMatch = duration.match(/^P(\d+)D$/);
  if (dayMatch) {
    const n = parseInt(dayMatch[1], 10);
    const word = n === 1 ? 'день' : n >= 2 && n <= 4 ? 'дня' : 'дней';
    return `${n} ${word}`;
  }

  // PT — часы/минуты
  const timeMatch = duration.match(/^PT(\d+)(H|M)$/);
  if (timeMatch) {
    const n = parseInt(timeMatch[1], 10);
    const unit = timeMatch[2];
    if (unit === 'H') {
      const word = n === 1 ? 'час' : n >= 2 && n <= 4 ? 'часа' : 'часов';
      return `${n} ${word}`;
    }
    if (unit === 'M') {
      const word = n === 1 ? 'минута' : n >= 2 && n <= 4 ? 'минуты' : 'минут';
      return `${n} ${word}`;
    }
  }

  return duration;
}
