#!/usr/bin/env bash
# T-0540 · FF-SECTIONS-FROM-DATA — динамические секции РАБОТЫ из данных, не хардкода
#
# Правило: в nav-config.js и shell.jsx нет хардкодированных бизнес-секций
# ('Финансы', 'HR', 'Продажи' как строковые литералы, кроме fallback-метки 'Другое').
# Секции = результат groupAppsBySection(apps) из данных app.section.
#
# Сканируются:
#   web/src/app-shell/nav-config.js
#   web/src/app-shell/shell.jsx
#
# Паттерн-дефект: строковый литерал вида 'Финансы' / 'HR' / 'Продажи' / 'Sales' /
# 'Finance' / 'Human Resources' в nav-конфиге или shell (в аргументах-объектах, JSX).
# Комментарии не учитываются (comment-scoped, как g5-jargon).
#
# EXIT CODES: 0 = нет нарушений · 1 = нарушение

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

echo "[T-0540] nav-sections-no-hardcode (FF-SECTIONS-FROM-DATA): проверка nav-конфига и shell"

# Список ЗАПРЕЩЁННЫХ бизнес-секций (строковые литералы, кириллица и латиница).
# Примечание: 'Другое' (FALLBACK_SECTION_LABEL) разрешён.
DENY_SECTIONS=('Финансы' 'HR' 'Продажи' 'Sales' 'Finance' 'Human Resources' 'Закупки' 'Маркетинг' 'Logistic')

FILES=(
  "${ROOT}/web/src/app-shell/nav-config.js"
  "${ROOT}/web/src/app-shell/shell.jsx"
)

FINDINGS=0

# strip_comments — вычистить блочные и строчные комментарии (по аналогии с g5-jargon).
strip_comments() {
  awk '
    {
      line = $0; out = ""; i = 1; n = length(line)
      while (i <= n) {
        if (inblock) {
          rest = substr(line, i); p = index(rest, "*/")
          if (p > 0) { inblock = 0; i = i + p + 1; continue }
          else { i = n + 1; continue }
        }
        two = substr(line, i, 2)
        if (two == "/*") { inblock = 1; i += 2; continue }
        if (two == "//") { i = n + 1; continue }
        out = out substr(line, i, 1); i++
      }
      print out
    }
  ' "$1"
}

for f in "${FILES[@]}"; do
  [[ -f "${f}" ]] || continue
  rel="${f#"${ROOT}/"}"
  stripped="$(strip_comments "${f}")"
  for sect in "${DENY_SECTIONS[@]}"; do
    hits="$(grep -nF "${sect}" <<<"${stripped}" || true)"
    if [[ -n "${hits}" ]]; then
      echo "FAIL [FF-SECTIONS-FROM-DATA]: hardcoded section literal '${sect}' in ${rel}:"
      echo "${hits}"
      FINDINGS=$((FINDINGS + 1))
    fi
  done
done

if [[ "${FINDINGS}" -gt 0 ]]; then
  echo ""
  echo "FAIL [FF-SECTIONS-FROM-DATA]: ${FINDINGS} hardcoded section literal(s) found." >&2
  echo "Секции должны строиться из данных app.section через groupAppsBySection(), а не хардкодиться." >&2
  exit 1
fi

echo "PASS [FF-SECTIONS-FROM-DATA]: нет хардкодированных бизнес-секций в nav-конфиге и shell"
exit 0
