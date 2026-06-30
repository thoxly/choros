#!/usr/bin/env bash
# T-0526: гард на запрет window.confirm() в web/src.
# window.confirm() — нативный браузерный диалог без a11y и без дизайн-системы.
# Все деструктивные действия обязаны использовать <ConfirmDialog> из kit.
# Исключаем строки-комментарии (JS-однострочные // и JSDoc *).
set -euo pipefail

FOUND=$(grep -rn "window\.confirm\s*(" web/src/ --include="*.jsx" --include="*.js" --include="*.tsx" --include="*.ts" 2>/dev/null \
  | perl -ne 'print unless /:\s*\/\/|:\s*\*/' \
  || true)

if [ -n "$FOUND" ]; then
  echo "$FOUND"
  echo "ERROR: window.confirm() запрещён. Используй <ConfirmDialog> из components.jsx (kit)."
  exit 1
fi
echo "OK: window.confirm() не найден в исполняемом коде web/src."
