# Conectando o Supabase

Hoje o app roda em modo local: o banco inteiro fica no IndexedDB do aparelho. Isso serve para validar com o cliente, **não para operar a barbearia**, porque cada celular teria dados diferentes.

A infraestrutura foi pensada para o plano grátis do Supabase, com Gmail para e-mail e backup próprio.

## O que já está pronto

- `supabase/migrations`: tabelas, travas, permissões e fila de envio, testadas em Postgres real.
- `supabase/functions/process-outbox`: envio por Gmail e OneSignal. A lógica está testada; a conexão com o Gmail real e com o OneSignal, ainda não.
- `scripts/backup.sh`, `scripts/restore.sh` e `.github/workflows/backup.yml`: backup diário criptografado.

## O que falta no código

1. **Login real.** Trocar o "Entrar como" dos Ajustes pelo Supabase Auth e preencher `profiles`. Sem isso, as permissões valem só na tela.
2. **Regras no servidor.** Os comandos de `src/domain` rodam no aparelho. Fechamento, estorno, pagamento de comissão e renovação precisam virar funções no banco (RPC), em uma transação cada, usando os testes atuais como especificação.
3. **Link público.** Precisa de uma Edge Function própria, com limite de requisições. Visitantes não têm acesso direto às tabelas.
4. **Rotina periódica.** `runAutomations` vira um `pg_cron`.
5. **Trocar `src/data/store.ts`.** `bootstrap`, `commit` e `exec` são os pontos de troca.

## E-mail pelo Gmail

1. Na conta da barbearia, ative a verificação em duas etapas e crie uma senha de app.
2. Copie `.env.example` para `.env.local`, preencha e rode `npm run test:gmail`. Deve chegar um e-mail na própria conta.
3. Grave os segredos:

```bash
supabase secrets set GMAIL_USER=... GMAIL_APP_PASSWORD=... CRON_SECRET=... MAIL_FROM_NAME="Samuel Barbearia"
```

4. Publique a função e **confirme se a porta 465 passa**:

```bash
supabase functions deploy process-outbox
```

```bash
curl -H "Authorization: Bearer SUA_CHAVE_ANON" -H "x-cron-secret: SEU_SEGREDO" "https://SEU_PROJETO.supabase.co/functions/v1/process-outbox?check=1"
```

A resposta esperada é `{"gmail":"ok"}`. O Supabase bloqueia as portas 25 e 587 e não documenta a 465. **Se falhar**, rode o mesmo `worker.ts` numa função da Vercel, chamada pelo mesmo cron. Nada na fila muda.

5. Agende o envio e a limpeza no SQL Editor (guarde `project_url`, `anon_key` e `cron_secret` no Vault antes):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('enviar-fila', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/process-outbox',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := 30000
  );
$$);

select cron.schedule('limpar-mensagens', '30 6 * * 0', 'select purge_old_messages(90)');
select cron.schedule('limpar-historico-cron', '45 6 * * 0', $$
  delete from cron.job_run_details where end_time < now() - interval '7 days'
$$);
```

O último agendamento importa: o cron a cada minuto gera 1.440 registros por dia, que o Supabase não limpa sozinho.

**Limites.** O teto é de 400 e-mails por dia, abaixo dos 500 do Gmail comum, e o marketing usa no máximo 200. Lembretes e confirmações sempre saem primeiro. Se o Gmail recusar a senha ou acusar limite, o lote para e volta intacto para a fila.

**Se a senha da conta Google mudar**, o Google cancela a senha de app: gere outra e repita o `supabase secrets set`.

## Backup diário

O repositório precisa ser **privado**. Em Settings > Secrets and variables > Actions, crie:

| Nome | Tipo | Valor |
| --- | --- | --- |
| `SUPABASE_DB_URL` | Secret | String do **Session pooler** (a conexão direta do plano grátis é só IPv6) |
| `BACKUP_PASSPHRASE` | Secret | Frase longa. **Guarde também fora do GitHub** |
| `SUPABASE_URL` | Secret | URL do projeto |
| `SUPABASE_ANON_KEY` | Secret | Chave anon |
| `BACKUP_ENABLED` | Variable | `true` |

O backup roda às 03:00, fica guardado por 90 dias nos artefatos da execução e o GitHub avisa por e-mail se falhar. A mesma rotina faz uma consulta para manter o projeto ativo em períodos parados.

A imagem `postgres:17` precisa ser igual ou mais nova que a versão do banco. Confira no painel do Supabase.

**Sem a frase, o backup não abre.** Se ela se perder, os backups se perdem junto.

### Restaurar

Baixe o artefato da execução no GitHub e, com a frase em `BACKUP_PASSPHRASE`:

```bash
scripts/restore.sh backup-2026-11-05.sql.gz.enc "URL_DO_PROJETO_NOVO"
```

Sempre em um projeto **novo e vazio**. As contas de login da equipe não vão no backup: recrie-as e atualize `profiles`.

**Faça uma restauração de verdade antes de entrar em produção** e repita a cada três meses. Backup que nunca foi restaurado é só uma esperança.

## Quando mudar para o Supabase Pro

O espaço não é o gatilho: o volume estimado é de dezenas de MB por ano, contra 500 MB. Mude quando a barbearia não puder ficar parada enquanto você restaura um backup, ou quando precisar de suporte e backups gerenciados.

Também falta um gateway para cobrança recorrente de verdade (Asaas, Mercado Pago ou Stripe), e testar em aparelho real o service worker do OneSignal junto com o da PWA.
