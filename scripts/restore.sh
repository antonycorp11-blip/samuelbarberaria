#!/usr/bin/env bash
# Abre um backup. Uso:
#   scripts/restore.sh arquivo            imprime o SQL (para conferir)
#   scripts/restore.sh arquivo URL_DO_BANCO   restaura em um projeto novo e vazio
set -euo pipefail

file="$1"
target="${2:-}"
: "${BACKUP_PASSPHRASE:?defina BACKUP_PASSPHRASE}"

decrypt() {
  # Todo banco novo já nasce com o schema public: recriar interromperia a restauração.
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$file" | gunzip | sed '/^CREATE SCHEMA public;$/d'
}

if [ -z "$target" ]; then
  decrypt
else
  psql "$target" -v ON_ERROR_STOP=1 -c 'create extension if not exists btree_gist'
  decrypt | psql "$target" -v ON_ERROR_STOP=1 --single-transaction
fi
