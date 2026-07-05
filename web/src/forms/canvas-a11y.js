/**
 * web/src/forms/canvas-a11y.js  (T-0656 · E-FORMS canvas DnD polish)
 *
 * Pure helpers for the accessible-move announcements (the aria-live region) and
 * the clipboard-node deep-copy. Kept React-free so the wording of a move
 * announcement — the thing a screen-reader user actually hears — is unit-tested
 * without mounting the canvas.
 *
 * The drag-and-drop checklist (ux-patterns "Drag and Drop") requires that a
 * move be completable by keyboard AND that state changes be announced in the
 * right place with the right politeness. announceMove() produces the human
 * Russian sentence; the FormDesigner puts it into an aria-live="polite" region.
 */

/**
 * Human-language announcement for a block that just moved.
 * NOT a technical path/index — "Блок «Сумма» перемещён в «Оплата», позиция 2 из 4".
 *
 * @param {object} opts
 * @param {string} opts.label      the moved block's human label (falls back to type)
 * @param {string} [opts.containerLabel] the receiving container's label (root → "форма")
 * @param {number} opts.position   1-based position within the container
 * @param {number} opts.total      total siblings in the container after the move
 * @returns {string}
 */
export function announceMove({ label, containerLabel, position, total }) {
  const blockName = label && String(label).trim() ? `«${label}»` : 'блок';
  const where = containerLabel && String(containerLabel).trim() ? `в «${containerLabel}»` : 'в форме';
  return `Блок ${blockName} перемещён ${where}, позиция ${position} из ${total}.`;
}

/** Announcement for a cut (removed to clipboard). */
export function announceCut(label) {
  const blockName = label && String(label).trim() ? `«${label}»` : 'блок';
  return `Блок ${blockName} вырезан. Нажмите Cmd/Ctrl+V, чтобы вставить.`;
}

/** Announcement for a paste. */
export function announcePaste(label) {
  const blockName = label && String(label).trim() ? `«${label}»` : 'блок';
  return `Блок ${blockName} вставлен.`;
}

/**
 * Deep-copy a node for the clipboard, stripping its editor-local id so a paste
 * does not duplicate a stable key (the same discipline duplicateAt uses). The
 * binding contract (fieldKey/subKey/displayField) is carried verbatim.
 */
export function cloneForClipboard(node) {
  if (!node || typeof node !== 'object') return null;
  const copy = JSON.parse(JSON.stringify(node));
  if (copy && typeof copy === 'object' && 'id' in copy) delete copy.id;
  return copy;
}
