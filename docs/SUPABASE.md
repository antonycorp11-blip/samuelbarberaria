# Banco de dados

O app fala só com o servidor na Cloudflare (`worker/`). O servidor fala com o Supabase por cinco funções `barbearia_*`, protegidas por uma chave própria. As tabelas ficam no schema `barbearia`, que não é exposto.

Por isso o banco pode morar no mesmo projeto de outro sistema sem encostar nele: hoje está no projeto **ATHG**, temporariamente.

## Como os dados fluem

1. O aparelho calcula o comando na hora, para a tela responder sem esperar.
2. O servidor repete o mesmo cálculo com os mesmos `src/domain`, usando o papel da sessão, e grava.
3. Se outro comando entrou antes, o banco devolve conflito e o servidor refaz sobre a versão nova.
4. Se recusar, a tela volta ao que está confirmado.
5. Os aparelhos buscam o que mudou a cada 10 segundos e ao voltar para o app.

As travas finais ficam no banco, em `supabase/store/schema.sql`: agenda sem sobreposição, estoque não negativo, venda única por atendimento e histórico financeiro imutável.

## Configurar em um projeto novo

1. Rode `supabase/store/schema.sql` no SQL Editor do projeto.
2. Ajuste a URL e a chave publicável em `scripts/setup-secrets.sh` e rode o script. Ele mostra um `HASH`.
3. Grave o hash no banco:

```sql
insert into barbearia.meta (api_secret_hash) values ('HASH');
```

4. Publique com `npm run deploy` e abra o app. A primeira tela cria a conta do dono e pede a `TEST_KEY`.

## Migrar para a conta definitiva

1. Faça uma restauração do backup no projeto novo (ver abaixo).
2. Rode `scripts/setup-secrets.sh` apontando para o projeto novo e atualize o hash em `barbearia.meta`.
3. Publique. Quem estiver logado continua logado.
4. Apague o schema e as funções `barbearia_*` do ATHG.

## Backup diário

O repositório precisa ser **privado**. Em Settings > Secrets and variables > Actions, crie:

| Nome | Tipo | Valor |
| --- | --- | --- |
| `SUPABASE_DB_URL` | Secret | String do **Session pooler** do projeto |
| `BACKUP_PASSPHRASE` | Secret | Frase longa. **Guarde também fora do GitHub** |
| `BACKUP_ENABLED` | Variable | `true` |

O backup roda às 03:00, cobre só o schema `barbearia` e fica guardado por 90 dias. O GitHub avisa por e-mail se falhar. Sem a frase, ele não abre.

```bash
scripts/restore.sh backup-2026-11-05.sql.gz.enc "URL_DO_PROJETO_NOVO"
```

Sempre em um projeto **novo e vazio**. **Faça uma restauração de verdade antes de operar** e repita a cada três meses.

## Limites para acompanhar

- **CPU da Cloudflare:** o plano grátis dá 10 ms de CPU por requisição. Com poucos dados cabe; com um ano de operação é provável precisar do Workers Paid (US$ 5/mês).
- **Rotas públicas:** limitadas a 8 pedidos por minuto por endereço de internet, e cada e-mail recebe no máximo 6 mensagens por dia. O limitador da Cloudflare conta por localidade, então barra rajadas, mas não é exato.
- **Clube online:** cartão automático pelo Asaas, ver [ASAAS.md](ASAAS.md).
