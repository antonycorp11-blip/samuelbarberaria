#!/usr/bin/env bash
# Abre um backup. Uso:
#   scripts/restore.sh arquivo                imprime o SQL (para conferir)
#   scripts/restore.sh arquivo URL_DO_BANCO   recria tudo em um projeto novo e vazio
set -euo pipefail

file="$1"
target="${2:-}"
: "${BACKUP_PASSPHRASE:?defina BACKUP_PASSPHRASE}"

decrypt() {
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$file" | gunzip
}

if [ -z "$target" ]; then
  decrypt
else
  psql "$target" -v ON_ERROR_STOP=1 --single-transaction -f "$(dirname "$0")/../supabase/store/schema.sql"
  decrypt | psql "$target" -v ON_ERROR_STOP=1 --single-transaction
fi
