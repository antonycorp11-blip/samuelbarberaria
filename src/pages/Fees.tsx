import { CreditCard, QrCode, Zap } from 'lucide-react'
import { useState } from 'react'
import { exec, useDb } from '@/data/store'
import { asaasFees, quoteAsaas, type FeeQuote } from '@/domain/asaasFees'
import { updateSettings } from '@/domain/catalog'
import { formatBps, formatBRL } from '@/domain/money'
import { brDate, dateKey } from '@/domain/time'
import type { AsaasFees } from '@/domain/types'
import { attempt, Button, Card, Field, Input, MoneyInput, PageHeader, PercentInput, Section, Sheet } from '@/ui/kit'

function FeesForm({ fees, onClose }: { fees: AsaasFees; onClose: () => void }) {
  const [f, setF] = useState(fees)
  const set = <K extends keyof AsaasFees>(k: K, v: AsaasFees[K]) => setF((x) => ({ ...x, [k]: v }))
  const save = () => {
    if (attempt(() => exec(updateSettings, { asaasFees: f }), 'Taxas salvas')) onClose()
  }
  return (
    <Sheet title="Taxas da conta Asaas" onClose={onClose} footer={<Button variant="primary" block onClick={save}>Salvar</Button>}>
      <p className="text-sm text-muted">
        Copie do Asaas, em Minha conta → Taxas. Nos 3 primeiros meses da conta, o Asaas cobra menos (cartão 1,99% e Pix R$ 0,99 na tabela pública); depois, volte aqui e atualize.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Cartão: valor fixo"><MoneyInput value={f.cardFixedCents} onChange={(v) => set('cardFixedCents', v)} /></Field>
        <Field label="Cartão: percentual (%)"><PercentInput value={f.cardBps} onChange={(v) => set('cardBps', v)} /></Field>
        <Field label="Pix: por recebimento"><MoneyInput value={f.pixCents} onChange={(v) => set('pixCents', v)} /></Field>
        <Field label="Antecipação (% ao mês)"><PercentInput value={f.anticipationMonthlyBps} onChange={(v) => set('anticipationMonthlyBps', v)} /></Field>
      </div>
      <Field label="Dias para o cartão cair" hint="No Asaas, o cartão à vista fica disponível 32 dias depois do pagamento.">
        <Input inputMode="numeric" value={String(f.cardDays)} onChange={(e) => set('cardDays', Number(e.target.value.replace(/\D/g, '') || 0))} />
      </Field>
    </Sheet>
  )
}

function QuoteCard({ icon: Icon, title, when, q }: { icon: typeof QrCode; title: string; when: string; q: FeeQuote }) {
  return (
    <Card className="p-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-bold"><Icon size={18} className="text-brass" /> {title}</span>
        <span className="tnum text-xl font-extrabold">{formatBRL(q.netCents)}</span>
      </div>
      <div className="mt-1 flex justify-between gap-3 text-[13px] text-muted">
        <span>{when}</span>
        <span className="tnum">taxa {formatBRL(q.feeCents)}</span>
      </div>
    </Card>
  )
}

/** Na tabela o R$ fica no título da coluna, para caber no celular. */
const plain = (cents: number) => (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function FeesPage() {
  const db = useDb()
  const fees = asaasFees(db.settings.asaasFees)
  const today = dateKey(new Date().toISOString())
  const plans = db.plans.filter((p) => p.active).sort((a, b) => a.priceCents - b.priceCents)
  const [amount, setAmount] = useState(plans[0]?.priceCents ?? 10000)
  const [editing, setEditing] = useState(false)
  const q = quoteAsaas(amount, fees, today)

  const values = [...new Set([...plans.map((p) => p.priceCents), 5000, 10000, 15000, 20000])].sort((a, b) => a - b)
  const recent = db.charges
    .filter((c) => c.gatewayPaymentId && c.status === 'paid' && c.paidAt)
    .sort((a, b) => (b.paidAt ?? '').localeCompare(a.paidAt ?? ''))
    .slice(0, 5)

  return (
    <>
      <PageHeader back title="Calculadora de taxas" sub="Quanto cai líquido no Asaas" />
      <div className="space-y-2 px-4">
        <Field label="Valor cobrado"><MoneyInput value={amount} onChange={setAmount} /></Field>
        <QuoteCard icon={QrCode} title="Pix" when="Cai na hora" q={q.pix} />
        <QuoteCard icon={CreditCard} title="Cartão" when={`Cai em ${brDate(q.card.availableOn)}`} q={q.card} />
        <QuoteCard icon={Zap} title="Cartão antecipado" when="Cai na hora, se o Asaas aprovar" q={q.cardAnticipated} />
      </div>

      <Section title="Tabela">
        <Card className="overflow-hidden">
          <table className="tnum w-full text-[13px]">
            <thead className="text-[12px] text-muted">
              <tr className="text-right">
                <th className="px-3 py-2.5 text-left font-semibold">Valor (R$)</th>
                <th className="px-2 py-2.5 font-semibold">Pix</th>
                <th className="px-2 py-2.5 font-semibold">Cartão</th>
                <th className="py-2.5 pr-3 pl-2 font-semibold">Antecip.</th>
              </tr>
            </thead>
            <tbody>
              {values.map((v) => {
                const r = quoteAsaas(v, fees, today)
                return (
                  <tr key={v} className="border-t border-line text-right">
                    <td className="px-3 py-2.5 text-left font-bold">{plain(v)}</td>
                    <td className="px-2 py-2.5">{plain(r.pix.netCents)}</td>
                    <td className="px-2 py-2.5">{plain(r.card.netCents)}</td>
                    <td className="py-2.5 pr-3 pl-2">{plain(r.cardAnticipated.netCents)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
        <p className="mt-2 text-xs text-muted">Valores líquidos, já sem a taxa do Asaas.</p>
      </Section>

      {recent.length > 0 && (
        <Section title="O que caiu de verdade">
          <Card className="divide-y divide-line">
            {recent.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                <span>
                  <span className="font-semibold">{c.method === 'pix' ? 'Pix' : 'Cartão'}</span>
                  <span className="text-muted"> · {brDate(dateKey(c.paidAt as string)).slice(0, 5)}</span>
                </span>
                <span className="tnum text-right">
                  <span className="font-bold">{formatBRL(c.amountCents - c.feeCents)}</span>
                  <span className="text-muted"> de {formatBRL(c.amountCents)} (taxa {formatBRL(c.feeCents)})</span>
                </span>
              </div>
            ))}
          </Card>
          <p className="mt-2 text-xs text-muted">Taxa real descontada pelo Asaas em cada mensalidade. Se não bater com a calculadora, ajuste as taxas abaixo.</p>
        </Section>
      )}

      <Section title="Taxas usadas" action={<Button className="min-h-9 px-3 text-sm" onClick={() => setEditing(true)}>Editar</Button>}>
        <Card className="space-y-1 p-3.5 text-sm">
          <div className="flex justify-between"><span className="text-muted">Cartão</span><span className="tnum">{formatBRL(fees.cardFixedCents)} + {formatBps(fees.cardBps)}</span></div>
          <div className="flex justify-between"><span className="text-muted">Pix</span><span className="tnum">{formatBRL(fees.pixCents)}</span></div>
          <div className="flex justify-between"><span className="text-muted">Antecipação</span><span className="tnum">{formatBps(fees.anticipationMonthlyBps)} ao mês</span></div>
          <div className="flex justify-between"><span className="text-muted">Cartão cai em</span><span className="tnum">{fees.cardDays} dias</span></div>
        </Card>
      </Section>
      <div className="h-6" />
      {editing && <FeesForm fees={fees} onClose={() => setEditing(false)} />}
    </>
  )
}
