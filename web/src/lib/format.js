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
