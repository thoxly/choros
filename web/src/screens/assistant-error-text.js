/* ============================================================================
   CHOROS — assistant-error-text.js  (T-0573, review R-1 fix)

   Чистое (без React/DOM) извлечение человекочитаемого текста ошибки из тела
   ответа ассистента.

   ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ: T-0573 перевела оба пути LLM-недоступности бэкенда
   (dormant + adapter-failure) на КАНОНИЧЕСКИЙ envelope
   {error:{code:"LLM_UNAVAILABLE", message:<HUMAN c /llm-connections>}} —
   текст теперь ВЛОЖЕН в d.error.message. Старый (до-T-0573) dormant-ответ нёс
   ПЛОСКОЕ top-level поле d.message ({error:"LLM_NOT_CONFIGURED", message}).
   Ревью R-1 поймало: экран читал только плоское d.message → после перехода на
   канонический envelope пользователь ВСЕГДА видел локальный fallback без
   ссылки /llm-connections (F6/AC-6 не доставлены на реальную поверхность).

   Порядок чтения (новое → старое → fallback):
     1. d.error.message  — канонический envelope (router.ts sendErrorEnvelope,
                           единый для 503 LLM_UNAVAILABLE и 500 INTERNAL);
     2. d.message        — плоский legacy-шейп (обратная совместимость с
                           любыми ещё не переведёнными 4xx/5xx-путями);
     3. fallback         — только если тело не дало ни одного текста.

   Тест: __tests__/screen-assistant.error-envelope.test.js — прогоняет эту
   функцию с РЕАЛЬНЫМ шейпом envelope и грепом подтверждает, что 503-ветка
   экрана использует именно её (регресс к плоскому d.message ловится).
   ============================================================================ */

/**
 * Извлечь человекочитаемый текст ошибки из распарсенного тела ответа.
 * @param {unknown} d — распарсенное JSON-тело ответа (или null/undefined).
 * @param {string} fallback — текст на случай, когда тело не несёт сообщения.
 * @returns {string}
 */
export function assistantErrorText(d, fallback) {
  if (d && typeof d === 'object') {
    const nested = d.error && typeof d.error === 'object' ? d.error.message : undefined;
    if (typeof nested === 'string' && nested.trim()) return nested;
    if (typeof d.message === 'string' && d.message.trim()) return d.message;
  }
  return fallback;
}
