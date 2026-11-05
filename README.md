# Samuel Barbearia

App de gestão da barbearia: agenda, caixa, equipe, clientes, estoque, clube de assinaturas, marketing e relatórios. PWA feita para celular.

```bash
npm install
npm run dev
```

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Sobe o app local |
| `npm test` | Roda regras de negócio, simulação e schema do banco |
| `npm run build` | Confere os tipos e gera a versão de produção |
| `npm run test:gmail` | Testa a senha de app do Gmail (lê o `.env.local`) |

Link público de agendamento: `/agendar`.

## Publicar na Cloudflare

```bash
npx wrangler login
```

```bash
npm run deploy
```

O endereço aparece no fim do comando. Enquanto o Supabase não estiver conectado, cada aparelho tem os próprios dados de exemplo. Antes de abrir para clientes, tire o `X-Robots-Tag: noindex` de `public/_headers`.

## Como está organizado

- `src/domain`: regras de negócio em funções puras. Não conhece tela nem banco.
- `src/data`: onde os dados ficam guardados (hoje, no aparelho) e dados de exemplo.
- `src/pages` e `src/ui`: interface.
- `supabase`: schema e funções para a conexão. Veja [docs/SUPABASE.md](docs/SUPABASE.md).
- `scripts`: backup criptografado e restauração, usados pelo GitHub Actions.
- `tests`: inclui `fuzz.test.ts`, que simula meses de operação aleatória conferindo as contas.

## Regras que não se negociam

- Dinheiro sempre em centavos inteiros.
- Lançamento financeiro nunca é apagado: correção é um lançamento oposto.
- Toda operação é atômica: se uma regra falha, nada é gravado.
