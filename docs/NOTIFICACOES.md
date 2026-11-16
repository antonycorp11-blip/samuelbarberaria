# E-mail e push

O envio sai do servidor na Cloudflare (`worker/`): a cada minuto e logo depois de cada ação. As chaves ficam nele, nunca no app.

## 1. Gmail

Na conta da barbearia, ative a verificação em duas etapas e crie uma senha de app.

## 2. OneSignal

1. Crie a conta em [onesignal.com](https://onesignal.com) e um app novo.
2. Vá em **Settings > Push & In-App > Web**.
3. Em integração, escolha **Custom Code**.
4. Preencha:
   - **Site Name:** `Samuel Barbearia` (vira o título padrão das notificações).
   - **Site URL:** `https://samuelbarberaria.antonycorp11.workers.dev`, sem barra no fim.
   - **Auto Resubscribe:** ligado.
   - **Default Icon URL:** envie `public/icon-256.png`.
5. Salve. **Não baixe o arquivo do service worker nem mexa nos campos de caminho:** o app já cuida disso.
6. Em **Settings > Keys & IDs**, copie o **App ID** e a **App API Key**. Ela é a `ONESIGNAL_REST_API_KEY`. Não use a Organization API Key.

## 3. Gravar os segredos

Cada comando pede o valor no terminal. Assim ele não aparece no histórico nem no chat.

```bash
npx wrangler secret put TEST_KEY
```

```bash
npx wrangler secret put GMAIL_USER
```

```bash
npx wrangler secret put GMAIL_APP_PASSWORD
```

```bash
npx wrangler secret put ONESIGNAL_APP_ID
```

```bash
npx wrangler secret put ONESIGNAL_REST_API_KEY
```

`TEST_KEY` é uma senha que você inventa. Ela só é pedida uma vez, para criar a conta do dono.

## 4. Testar no celular

Abra **Mais > Ajustes > Testar e-mail e push**. Os dois selos devem aparecer verdes.

1. Envie o e-mail de teste para o seu endereço.
2. Toque em Ativar notificações, aceite e envie o push de teste.
3. Peça para alguém agendar pelo link público, em outro aparelho.

**iPhone:** o push só funciona com o app instalado na Tela de Início (iOS 16.4 ou mais novo) e aberto por lá.

## Se algo falhar

| Sintoma | Causa provável |
| --- | --- |
| Gmail recusou a senha | Senha de app errada, ou a senha da conta Google mudou |
| "Nenhum aparelho recebeu o push" | Abra o app logado e toque em Ativar notificações. A mensagem traz o detalhe do OneSignal |
| Push não chega no iPhone | App aberto pelo Safari, e não pelo ícone instalado |
| E-mail no spam | Marque como "não é spam" para treinar o Gmail do cliente |

Mensagens com falha aparecem em **Marketing > Mensagens**, com o motivo.

## Ao trocar para o domínio definitivo

Não é só trocar a URL: o navegador prende cada inscrição de push ao endereço, e o OneSignal pede um app por domínio.

1. Aponte o domínio para o Worker (Custom Domain na Cloudflare).
2. Crie um **app novo** no OneSignal com o novo Site URL, seguindo a seção 2.
3. Regrave `ONESIGNAL_APP_ID` e `ONESIGNAL_REST_API_KEY`.
4. Cada pessoa da equipe instala o app pelo novo endereço e toca em Ativar notificações.
5. Troque o endereço em `APP_URL` (`wrangler.jsonc`) e nas tags `og:` de `index.html`. Sem isso, a prévia do WhatsApp e a logo dos e-mails apontam para o endereço antigo.
6. Atualize o link de agendamento divulgado e tire o `X-Robots-Tag: noindex` de `public/_headers`.

Gmail, banco e os outros segredos não mudam.
