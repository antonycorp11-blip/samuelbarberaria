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

Links públicos: `/agendar` (agendamento, aceita `?cupom=CODIGO`), `/agendar/cancelar` (link assinado enviado no e-mail) e `/clube` (assinatura).

## Publicar na Cloudflare

```bash
npm run deploy
```

Antes de abrir para clientes, tire o `X-Robots-Tag: noindex` de `public/_headers`.

## Como está organizado

- `src/domain`: regras de negócio em funções puras. Não conhece tela nem banco.
- `src/data`: sincronização do aparelho com o servidor.
- `worker`: servidor na Cloudflare. Repete as regras de `src/domain` com a palavra final e envia e-mail e push.
- `src/pages` e `src/ui`: interface.
- `supabase/store`: schema do banco. Veja [docs/SUPABASE.md](docs/SUPABASE.md).
- Clube com cartão automático: [docs/ASAAS.md](docs/ASAAS.md).
- `scripts`: backup criptografado e restauração, usados pelo GitHub Actions.
- `tests`: inclui `server.test.ts`, com o fluxo entre aparelhos, e `fuzz.test.ts`, que simula meses de operação aleatória conferindo as contas.

## Regras que não se negociam

- Dinheiro sempre em centavos inteiros.
- Lançamento financeiro nunca é apagado: correção é um lançamento oposto.
- Toda operação é atômica: se uma regra falha, nada é gravado.
