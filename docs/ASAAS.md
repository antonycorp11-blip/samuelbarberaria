# Clube com Pix Automático e cartão (Asaas)

O cliente abre `/clube`, escolhe o plano, informa nome, celular, e-mail e data de nascimento e escolhe como pagar. **Não precisa ter conta em lugar nenhum, e o e-mail pode ser qualquer um.**

- **Pix Automático:** o cliente informa o CPF e o app mostra o QR Code do primeiro mês. Ao pagar, o banco pergunta se ele autoriza o Pix Automático; com a autorização, os próximos meses saem sozinhos da conta dele. O dinheiro cai na hora.
- **Cartão:** o cliente vai para a página de pagamento do Asaas e informa CPF e cartão. O Asaas cobra o cartão todo mês; o dinheiro fica disponível em 32 dias.

O dinheiro cai na conta Asaas do Samuel, e ele transfere por Pix para onde quiser. Cada mensalidade entra no caixa com a taxa real que o Asaas descontou.

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
- **Eventos:** de cobranças (`PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED`), de assinaturas (`SUBSCRIPTION_DELETED`, `SUBSCRIPTION_INACTIVATED`), de checkout (`CHECKOUT_EXPIRED`, `CHECKOUT_CANCELED`) e de Pix Automático (`PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CREATED`, `_ACTIVATED`, `_CANCELLED`, `_EXPIRED`, `_REFUSED` e `PIX_AUTOMATIC_RECURRING_PAYMENT_INSTRUCTION_REFUSED`).

O script `scripts/setup-asaas.sh` faz os passos 2 a 4 de uma vez: pede a chave escondida, cria o token, grava os dois no servidor e cria (ou atualiza) o webhook com todos esses eventos.

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
| Pix pago | Ativa como no cartão; aparece como **Pix Automático** quando o banco confirma a autorização, ou **Pix mensal** sem ela |
| Cliente sem Pix Automático | O Asaas envia o Pix do mês por e-mail; o app quita sozinho quando o Pix cai |
| Banco recusou o débito do mês | A equipe recebe um aviso; a mensalidade fica em aberto e segue a tolerância |
| Cliente cancelou o Pix Automático no banco | A equipe recebe um aviso; a assinatura continua no Pix mensal |
| Desistiu no Pix | A tentativa sai em até 2 dias e a assinatura é apagada no Asaas |

## Calculadora de taxas

Em **Mais → Taxas**, o Samuel digita um valor e vê quanto cai líquido no Pix, no cartão (com a data) e no cartão antecipado, além de uma tabela com os planos. Embaixo aparece o que caiu de verdade nas últimas mensalidades, com a taxa que o Asaas descontou. As taxas da calculadora vêm de **Editar**: copie de Asaas → Minha conta → Taxas e atualize quando a promoção dos 3 primeiros meses acabar.

## Limites desta versão

- **Pix Automático depende da conta.** O Asaas só libera para conta de empresa com CNPJ ativo há pelo menos 6 meses e chave Pix cadastrada. Sem isso, o app cria a assinatura no Pix mensal comum, e o cliente paga o Pix que chega por e-mail.
- **Cliente que troca de cartão** faz isso pelo link que o Asaas envia ou pelo painel. O app não tem essa tela.
- **Taxas:** confira na conta. O app usa a taxa de crédito dos Ajustes no DRE; ajuste para o valor real do Asaas.
- **Preço novo de plano** vale para novas assinaturas. As antigas continuam no valor contratado.
