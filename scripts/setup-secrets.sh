#!/usr/bin/env bash
# Gera as chaves do servidor direto na Cloudflare. Elas não aparecem na tela.
# No fim mostra só o hash da chave do banco, que não é segredo.
set -euo pipefail

store=$(openssl rand -hex 32)
printf '%s' "$store" | npx wrangler secret put STORE_SECRET
openssl rand -hex 32 | tr -d '\n' | npx wrangler secret put SESSION_SECRET
printf '%s' 'https://kdcgdkzdjdkebadnupgu.supabase.co' | npx wrangler secret put SUPABASE_URL
printf '%s' 'sb_publishable_ANUtklosjEqev3UXEFeEwA_WANBDrcW' | npx wrangler secret put SUPABASE_KEY

echo
echo "HASH: $(printf '%s' "$store" | shasum -a 256 | cut -d' ' -f1)"
