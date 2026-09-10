#!/usr/bin/env bash
# Ищет запрещённые строки перед публикацией. Сам список лежит ВНЕ репозитория,
# потому что закоммиченный список стоп-слов публикует то, что должен скрыть.
set -euo pipefail

LIST="${FIELDSTREAM_FORBIDDEN_TERMS:-}"
if [[ -z "$LIST" ]]; then
  echo "check-forbidden-terms: \$FIELDSTREAM_FORBIDDEN_TERMS не задан, проверка пропущена." >&2
  echo "Заведи файл со стоп-словами вне репозитория и укажи путь в переменной." >&2
  exit 0
fi
if [[ ! -f "$LIST" ]]; then
  echo "check-forbidden-terms: файл '$LIST' не найден." >&2
  exit 2
fi

status=0
while IFS= read -r term; do
  term="${term%$''}"
  [[ -z "${term// }" || "$term" == \#* ]] && continue
  if git grep --untracked --exclude-standard -n -I -i -P -e "$term" -- . ':!pnpm-lock.yaml' >/dev/null 2>&1; then
    echo "НАЙДЕНО запрещённое: $term"
    git grep --untracked --exclude-standard -n -I -i -P -e "$term" -- . ':!pnpm-lock.yaml' | head -20
    status=1
  fi
done < "$LIST"

if [[ $status -eq 0 ]]; then echo "check-forbidden-terms: чисто."; fi
exit $status
