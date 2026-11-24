#!/usr/bin/env bash
# Liga o Asaas ao app de uma vez:
#  1. pede a chave da API (escondida);
#  2. cria um token novo para o webhook;
#  3. grava os dois no servidor;
#  4. cria (ou atualiza) o webhook no Asaas com esse token.
# Nenhuma chave aparece na tela.
set -euo pipefail

WEBHOOK_URL='https://samuelbarberaria.antonycorp11.workers.dev/api/asaas/webhook'

read -rsp 'Cole a chave da API do Asaas (começa com $aact_) e aperte Enter: ' key; echo
case "$key" in
  '$aact_'*) ;;
  *) echo 'Essa chave não começa com $aact_. Gere de novo em Integrações > Chaves de API.'; exit 1 ;;
esac
read -rp 'E-mail para o Asaas avisar se o webhook falhar: ' email

token=$(openssl rand -hex 24)

echo 'Gravando as chaves no servidor...'
printf '%s' "$key" | npx wrangler secret put ASAAS_API_KEY
printf '%s' "$token" | npx wrangler secret put ASAAS_WEBHOOK_TOKEN

echo 'Criando o webhook no Asaas...'
ASAAS_KEY="$key" ASAAS_TOKEN="$token" ASAAS_EMAIL="$email" WEBHOOK_URL="$WEBHOOK_URL" node --input-type=module -e '
const base = "https://api.asaas.com/v3"
const headers = { access_token: process.env.ASAAS_KEY, "Content-Type": "application/json", "User-Agent": "SamuelBarberShop/1.0" }
const call = async (path, init) => {
  const res = await fetch(base + path, { ...init, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error("Asaas recusou (" + res.status + "): " + (data.errors?.map((e) => e.description).join("; ") || "sem detalhes"))
    process.exit(1)
  }
  return data
}
const body = JSON.stringify({
  name: "App Samuel",
  url: process.env.WEBHOOK_URL,
  email: process.env.ASAAS_EMAIL,
  enabled: true,
  interrupted: false,
  apiVersion: 3,
  authToken: process.env.ASAAS_TOKEN,
  sendType: "SEQUENTIALLY",
  events: [
    "PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED",
    "SUBSCRIPTION_DELETED", "SUBSCRIPTION_INACTIVATED",
    "CHECKOUT_EXPIRED", "CHECKOUT_CANCELED",
    "PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CREATED", "PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED",
    "PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED", "PIX_AUTOMATIC_RECURRING_AUTHORIZATION_EXPIRED",
    "PIX_AUTOMATIC_RECURRING_AUTHORIZATION_REFUSED", "PIX_AUTOMATIC_RECURRING_PAYMENT_INSTRUCTION_REFUSED",
  ],
})
const list = await call("/webhooks?limit=100")
const existing = (list.data ?? []).find((w) => w.url === process.env.WEBHOOK_URL)
if (existing) {
  await call("/webhooks/" + existing.id, { method: "PUT", body })
  console.log("Webhook já existia: atualizado com o token novo.")
} else {
  await call("/webhooks", { method: "POST", body })
  console.log("Webhook criado.")
}
'


echo
echo 'Pronto. O Asaas está ligado ao app.'
