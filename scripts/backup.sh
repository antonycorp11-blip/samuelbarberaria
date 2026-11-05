#!/usr/bin/env bash
# Gera um backup criptografado do banco. Uso: scripts/backup.sh arquivo-de-saida
set -euo pipefail

out="$1"
: "${BACKUP_PASSPHRASE:?defina BACKUP_PASSPHRASE}"
dump="${DUMP_CMD:-docker run --rm postgres:17 pg_dump $SUPABASE_DB_URL --schema=public --no-owner --no-privileges}"

$dump | gzip -9 | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$out"

# Um dump vazio passaria em silêncio e só seria descoberto na hora de restaurar.
size=$(wc -c < "$out" | tr -d ' ')
if [ "$size" -lt 1024 ]; then
  echo "Backup suspeito: apenas $size bytes" >&2
  exit 1
fi
echo "Backup gerado: $size bytes"
