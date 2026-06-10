#!/usr/bin/env bash
# T-0117 SPIKE — NOT PRODUCTION. Zero-dependency JSON assembly (bash + printf only).
# ADR §3: measurements.json must be machine-readable, written without external deps (no jq).
# These helpers emit JSON fragments; callers compose the EngineResult document.

# json_str <value> -> JSON-quoted string (escapes \ and ")
json_str() {
  local s="${1-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

# json_num <value> -> bare number, or null when empty/non-numeric
json_num() {
  local n="${1-}"
  if [[ "$n" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then
    printf '%s' "$n"
  else
    printf 'null'
  fi
}

# json_bool <value> -> true/false (treats 1/true/yes/go as true), else null when empty
json_bool() {
  case "${1-}" in
    1|true|TRUE|yes|YES|go) printf 'true' ;;
    0|false|FALSE|no|NO)    printf 'false' ;;
    "")                     printf 'null' ;;
    *)                      printf 'false' ;;
  esac
}
