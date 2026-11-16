# Clube com cartão automático (Asaas)

O cliente abre `/clube`, escolhe o plano e informa nome, celular e e-mail. Depois vai para a página de pagamento do Asaas, onde informa CPF e cartão. **Não precisa ter conta em lugar nenhum, e o e-mail pode ser qualquer um.**

Depois do primeiro pagamento, o Asaas cobra o cartão todo mês sozinho e avisa o servidor. O dinheiro cai na conta Asaas do Samuel, e ele transfere por Pix para onde quiser.

O app nunca vê o cartão. Cada aviso tem o token secreto conferido, e a cobrança é consultada de novo na API do Asaas antes de qualquer gravação.

## Passo a passo com o Samuel

### 1. Abrir a conta

Crie a conta em [asaas.com](https://www.asaas.com), de preferência no CNPJ do MEI. Envie os documentos que o Asaas pedir e espere a aprovação.

Para testar antes, crie também uma conta no **sandbox** em [sandbox.asaas.com](https://sandbox.asaas.com). Ela é separada da conta real e não mexe com dinheiro.

### 2. Gerar a chave da API

No painel, vá em **Integrações > Chaves de API** e gere uma chave. Ela começa com `$aact_` e aparece **uma vez só**.

### 3. Configurar os avisos (webhooks)

No painel, vá em **Integrações > Webhooks** e crie um webhook:

- **URL:** `https://samuelbarberaria.antonycorp11.workers.dev/api/asaas/webhook`
- **Token de autenticação:** invente um com mais de 32 caracteres e guarde.
- **Versão da API:** v3. **Tipo de envio:** sequencial.
- **Eventos:** de cobranças (`PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED`), de assinaturas (`SUBSCRIPTION_DELETED`, `SUBSCRIPTION_INACTIVATED`) e de checkout (`CHECKOUT_EXPIRED`, `CHECKOUT_CANCELED`).

### 4. Gravar as chaves

No terminal, cole quando cada comando pedir:

```bash
npx wrangler secret put ASAAS_API_KEY
```

```bash
npx wrangler secret put ASAAS_WEBHOOK_TOKEN
```

**Para testar no sandbox,** grave também `ASAAS_SANDBOX` com o valor `true`:

```bash
npx wrangler secret put ASAAS_SANDBOX
```

Na hora de ir para produção, troque as duas chaves pelas da conta real e grave `ASAAS_SANDBOX` com `false`.

### 5. Testar

1. Abra `/clube` em uma janela anônima e assine com os seus dados.
2. Pague com um cartão de teste do sandbox.
3. Em até um minuto, o assinante aparece como **Cartão automático** em Mais > Clube, com a mensalidade paga no caixa.
4. Cancele pelo app e confira, no painel do Asaas, que a assinatura sumiu de lá também.

Em produção, faça uma assinatura real de valor baixo com o seu cartão, confira e cancele.

## Como funciona

| Situação | O que acontece no app |
| --- | --- |
| Cliente inicia a assinatura | Fica **Aguardando pagamento**, sem benefício |
| Pagou no checkout | Ativa, lança no caixa, envia boas-vindas e avisa a equipe |
| Mensalidade aprovada | Quita a cobrança do mês e calcula a comissão |
| Cartão recusado | Depois da tolerância dos Ajustes, vira **Em atraso** e perde o benefício |
| Estorno ou contestação no Asaas | Sai da receita e a equipe recebe um aviso |
| Cancelamento pelo app | Encerra a recorrência no Asaas na hora; o mês já pago continua valendo |
| Desistiu no checkout | O link expira em 24 horas e a tentativa sai em até 2 dias |

## Limites desta versão

- **Só cartão de crédito.** O checkout recorrente do Asaas não aceita Pix. O Pix Automático usa outro fluxo e pode ser uma segunda etapa.
- **Cliente que troca de cartão** faz isso pelo link que o Asaas envia ou pelo painel. O app não tem essa tela.
- **Taxas:** confira na conta. O app usa a taxa de crédito dos Ajustes no DRE; ajuste para o valor real do Asaas.
- **Preço novo de plano** vale para novas assinaturas. As antigas continuam no valor contratado.
