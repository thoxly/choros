/* ============================================================================
   CHOROS — slug-field.jsx (T-0650 [W4-UX §7] — авто-слаги)

   Человек вводит только «Название»; слаг придумывать не нужно (столп 2/5,
   ux-study-2026-07-05.md §7 — «слаг-ад»: ~15-30 рукописных машинных имён на кейс).

   Три состояния (см. ADR-T0650-auto-slugs.md §4):
     1. locked            — сущность УЖЕ создана: слаг неизменяем, рендерится MonoId.
     2. !touched (default) — живая подпись-превью «будет создан как `x` · изменить»,
                              зеркалит транслит name на лету; слаг НЕ редактируется
                              напрямую (финальный слаг + анти-коллизия — на сервере).
     3. touched            — обычное текстовое поле (после клика «изменить»):
                              дальнейший ввод названия больше НЕ перезаписывает слаг.

   HOOK-FREE (T-0649 discipline): web/vitest.config.js runs a plain "node"
   environment (no jsdom/react-dom/react-test-renderer) — components using
   useState/useEffect cannot be reliably invoked as plain functions in that
   harness. SlugField is a fully controlled, stateless renderer: `touched` is
   owned by the PARENT screen (alongside `slug`), not local state.

   Ноль хардкод-цвета (UX-гейт G6) — только --chs-* токены.
   ============================================================================ */

import React from 'react';
import { Field, MonoId, Button } from './components.jsx';
import { previewSlugFromName } from './slug-field-logic.js';

/**
 * SlugField
 *
 * @param {string} name       текущее значение поля «Название» (источник превью)
 * @param {string} value      текущий слаг (controlled) — используется только когда touched или locked
 * @param {(next:string)=>void} onChange   вызывается при ручном редактировании слага
 * @param {boolean} touched   true после клика «изменить» — показывает обычный инпут
 * @param {()=>void} onTouch  вызывается при клике «изменить» (родитель ставит touched=true
 *                            и, как правило, сид-ит value текущим превью)
 * @param {boolean} locked    true после создания сущности — слаг иммутабелен (MonoId, без инпута)
 * @param {string} [error]    серверная ошибка (409/400) — показывается как hint инпута
 * @param {string} [label]    подпись поля в touched/locked режиме (default «Слаг»)
 */
export function SlugField({
  name = '',
  value = '',
  onChange,
  touched = false,
  onTouch,
  locked = false,
  error,
  label = 'Слаг',
}) {
  if (locked) {
    return (
      <div className="chs-field">
        <span className="chs-label">{label}</span>
        <div>
          <MonoId>{value || '—'}</MonoId>
        </div>
      </div>
    );
  }

  if (touched) {
    return (
      <Field
        label={label}
        mono
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="my-slug"
        invalid={Boolean(error)}
        hint={error || 'строчные латинские, цифры, дефис · 1–64'}
      />
    );
  }

  // Default (untouched): live preview mirrored from `name`, no direct slug input.
  const preview = previewSlugFromName(name);
  return (
    <div className="chs-field chs-slugfield-preview">
      <span className="chs-label">{label}</span>
      <div className="chs-slugfield-preview__row">
        <span className="chs-slugfield-preview__text">
          {preview ? (
            <>
              будет создан как <span className="chs-slugfield-preview__mono">{preview}</span>
            </>
          ) : (
            'слаг сгенерируется автоматически из названия'
          )}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onTouch && onTouch(preview)}>
          изменить
        </Button>
      </div>
      {error && <span className="chs-hint chs-hint--invalid">{error}</span>}
    </div>
  );
}
