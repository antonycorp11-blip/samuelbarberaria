import { ArrowDownLeft, ArrowUpRight, Minus, Plus, Undo2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { exec, nowISO, useDb } from '@/data/store'
import {
  addTransaction, averageTicket, balanceByMethod, CATEGORY_LABEL, cashFlow, dre, EXPENSE_CATEGORIES, METHOD_LABEL, paidSales, reverseTransaction,
} from '@/domain/finance'
import { formatBps, formatBRL } from '@/domain/money'
import { refundSale } from '@/domain/sales'
import { addDays, brDate, dateKey, dayLabel, endOfMonth, monthLabel, startOfMonth, timeOf } from '@/domain/time'
import type { DateKey, ID, PaymentMethod, Sale, Transaction, TxCategory } from '@/domain/types'
import {
  attempt, Button, Card, Chips, ConfirmSheet, cx, Empty, Field, IconButton, Input, List, MoneyInput, PageHeader, Row, Section, Segmented, Select, Sheet, Stat,
} from '@/ui/kit'

const METHODS = (Object.keys(METHOD_LABEL) as PaymentMethod[]).map((value) => ({ value, label: METHOD_LABEL[value] }))

function EntrySheet({ type, onClose }: { type: 'in' | 'out'; onClose: () => void }) {
  const [amount, setAmount] = useState(0)
  const [category, setCategory] = useState<TxCategory>(type === 'in' ? 'outras_receitas' : 'aluguel')
  const [method, setMethod] = useState<PaymentMethod>('pix')
  const [description, setDescription] = useState('')
  const save = () => {
    if (attempt(() => exec(addTransaction, { type, category, amountCents: amount, method, description }), 'Lançamento salvo')) onClose()
  }
  return (
    <Sheet title={type === 'in' ? 'Nova entrada' : 'Nova despesa'} onClose={onClose} footer={<Button variant="primary" block onClick={save}>Lançar</Button>}>
      <Field label="Valor"><MoneyInput value={amount} onChange={setAmount} autoFocus /></Field>
      {type === 'out' && (
        <Field label="Categoria">
          <Select value={category} onChange={(e) => setCategory(e.target.value as TxCategory)}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </Field>
      )}
      <div><span className="mb-1.5 block text-[13px] font-bold text-muted">Forma</span><Chips value={method} onChange={setMethod} options={METHODS} /></div>
      <Field label="Descrição"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Opcional" /></Field>
    </Sheet>
  )
}

function SaleSheet({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const db = useDb()
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const client = db.clients.find((c) => c.id === sale.clientId)
  if (confirming) {
    return (
      <ConfirmSheet
        title="Estornar esta venda?"
        text={`${formatBRL(sale.totalCents)} saem do caixa. Comissão, estoque, cupom e fidelidade voltam junto. Não dá para desfazer.`}
        confirm="Estornar"
        danger
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          if (attempt(() => exec(refundSale, { saleId: sale.id, reason }), 'Venda estornada')) onClose()
        }}
      >
        <Field label="Motivo"><Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      </ConfirmSheet>
    )
  }
  return (
    <Sheet title={client?.name ?? 'Venda balcão'} onClose={onClose}>
      <div className="text-sm text-muted">{brDate(dateKey(sale.at))} às {timeOf(sale.at)} · {db.barbers.find((b) => b.id === sale.barberId)?.name}</div>
      <div className="divide-y divide-line/70 overflow-hidden rounded-xl bg-raised">
        {sale.items.map((i) => <Row key={i.id} title={`${i.qty}× ${i.name}`} sub={i.coverage === 'subscription' ? 'Plano' : i.coverage === 'reward' ? 'Fidelidade' : undefined} right={formatBRL(i.netCents)} />)}
      </div>
      <div className="tnum space-y-1 text-sm">
        {sale.discountCents > 0 && <div className="flex justify-between text-muted"><span>Descontos</span><span>−{formatBRL(sale.discountCents)}</span></div>}
        {sale.payments.map((p, i) => <div key={i} className="flex justify-between"><span>{METHOD_LABEL[p.method]}</span><span>{formatBRL(p.amountCents)}</span></div>)}
        <div className="flex justify-between pt-1 text-base font-extrabold"><span>Total</span><span>{formatBRL(sale.totalCents)}</span></div>
      </div>
      {sale.status === 'refunded' ? (
        <p className="rounded-xl bg-bad/15 p-3 text-sm text-bad">Estornada: {sale.refundReason}</p>
      ) : (
        <Button variant="danger" block onClick={() => setConfirming(true)}><Undo2 size={18} /> Estornar venda</Button>
      )}
    </Sheet>
  )
}

function Line({ label, value, strong, sub }: { label: string; value: number; strong?: boolean; sub?: boolean }) {
  return (
    <div className={cx('flex justify-between gap-3 px-3.5 py-2', strong && 'bg-raised font-extrabold', sub && 'text-sm text-muted')}>
      <span className="min-w-0 truncate">{label}</span>
      <span className={cx('tnum shrink-0', strong && value < 0 && 'text-bad')}>{formatBRL(value)}</span>
    </div>
  )
}

function DreView({ from, to }: { from: DateKey; to: DateKey }) {
  const db = useDb()
  const r = useMemo(() => dre(db, from, to), [db, from, to])
  return (
    <Card className="overflow-hidden py-1">
      <Line label="Serviços" value={r.serviceRevenue} sub />
      <Line label="Produtos" value={r.productRevenue} sub />
      <Line label="Assinaturas" value={r.subscriptionRevenue} sub />
      {r.otherRevenue !== 0 && <Line label="Outras receitas" value={r.otherRevenue} sub />}
      <Line label="Receita bruta" value={r.grossRevenue} strong />
      {r.refunds !== 0 && <Line label="(−) Estornos" value={-r.refunds} sub />}
      <Line label="(−) Taxas de pagamento" value={-r.paymentFees} sub />
      <Line label="Receita líquida" value={r.netRevenue} strong />
      <Line label="(−) Custo dos produtos" value={-r.cogs} sub />
      <Line label="(−) Comissões" value={-r.commissions} sub />
      <Line label="Margem de contribuição" value={r.contributionMargin} strong />
      {r.expenses.map((e) => <Line key={e.category} label={`(−) ${e.label}`} value={-e.amountCents} sub />)}
      <Line label="Lucro líquido" value={r.netProfit} strong />
      <div className="px-3.5 py-2 text-sm text-muted">Margem líquida: {formatBps(r.marginBps)}</div>
    </Card>
  )
}

export default function FinancePage() {
  const db = useDb()
  const today = dateKey(nowISO())
  const [tab, setTab] = useState<'summary' | 'entries' | 'flow' | 'dre'>('summary')
  const [month, setMonth] = useState(startOfMonth(today))
  const [entry, setEntry] = useState<'in' | 'out' | null>(null)
  const [saleId, setSaleId] = useState<ID | null>(null)
  const [undo, setUndo] = useState<Transaction | null>(null)
  const from = month
  const to = endOfMonth(month) < today ? endOfMonth(month) : today
  const r = useMemo(() => dre(db, from, to), [db, from, to])
  const byMethod = useMemo(() => balanceByMethod(db, from, to), [db, from, to])
  const flow = useMemo(() => cashFlow(db, from, to).reverse(), [db, from, to])
  const sale = db.sales.find((s) => s.id === saleId)
  const entries = useMemo(
    () => db.transactions.filter((t) => dateKey(t.at) >= from && dateKey(t.at) <= to).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100),
    [db, from, to],
  )
  const count = paidSales(db, from, to).length

  return (
    <>
      <PageHeader
        back
        title="Financeiro"
        sub={monthLabel(month)}
        action={
          <div className="flex gap-2">
            <IconButton label="Nova entrada" onClick={() => setEntry('in')}><Plus size={20} /></IconButton>
            <IconButton label="Nova despesa" onClick={() => setEntry('out')}><Minus size={20} /></IconButton>
          </div>
        }
      />
      <div className="space-y-2 px-4">
        <div className="flex items-center gap-2">
          <Button className="flex-1 text-sm" onClick={() => setMonth(startOfMonth(addDays(month, -1)))}>‹ Mês anterior</Button>
          <Button className="flex-1 text-sm" disabled={endOfMonth(month) >= today} onClick={() => setMonth(startOfMonth(addDays(endOfMonth(month), 1)))}>Próximo ›</Button>
        </div>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[{ value: 'summary', label: 'Resumo' }, { value: 'entries', label: 'Extrato' }, { value: 'flow', label: 'Fluxo' }, { value: 'dre', label: 'DRE' }]}
        />
      </div>

      {tab === 'summary' && (
        <>
          <div className="grid grid-cols-2 gap-2 px-4 pt-3">
            <Stat label="Faturamento" value={formatBRL(r.grossRevenue)} hint={`${count} atendimentos`} />
            <Stat label="Lucro líquido" value={formatBRL(r.netProfit)} tone={r.netProfit >= 0 ? 'ok' : 'bad'} hint={`Margem ${formatBps(r.marginBps)}`} />
            <Stat label="Ticket médio" value={formatBRL(averageTicket(db, from, to))} />
            <Stat label="Despesas" value={formatBRL(r.totalExpenses)} />
          </div>
          <Section title="Recebido por forma">
            <List>{METHODS.map((m) => <Row key={m.value} title={m.label} right={formatBRL(byMethod[m.value])} />)}</List>
          </Section>
        </>
      )}

      {tab === 'entries' && (
        <div className="px-4 pt-3">
          {entries.length === 0 ? <Empty title="Sem lançamentos neste mês" /> : (
            <List>
              {entries.map((t) => (
                <Row
                  key={t.id}
                  left={t.type === 'in' ? <ArrowDownLeft size={18} className="text-ok" /> : <ArrowUpRight size={18} className="text-bad" />}
                  title={t.description}
                  sub={`${dayLabel(dateKey(t.at))} ${timeOf(t.at)} · ${CATEGORY_LABEL[t.category]} · ${METHOD_LABEL[t.method]}${t.reversed ? ' · corrigido' : ''}`}
                  right={<span className={t.type === 'in' ? 'text-ok' : ''}>{t.type === 'in' ? '+' : '−'}{formatBRL(t.amountCents)}</span>}
                  onClick={() => {
                    if (t.saleId) setSaleId(t.saleId)
                    else if (!t.reversed && !t.reversalOf && !['comissao', 'compra_estoque', 'assinatura', 'taxa_pagamento'].includes(t.category)) setUndo(t)
                  }}
                />
              ))}
            </List>
          )}
          <p className="mt-2 text-center text-xs text-muted">Toque numa venda para ver detalhes ou estornar.</p>
        </div>
      )}

      {tab === 'flow' && (
        <div className="px-4 pt-3">
          <Card className="overflow-hidden">
            <div className="grid grid-cols-[52px_1fr_1fr_1fr] gap-1 border-b border-line px-3 py-2 text-[11px] font-bold text-muted uppercase">
              <span>Dia</span><span className="text-right">Entra</span><span className="text-right">Sai</span><span className="text-right">Saldo</span>
            </div>
            {flow.filter((d) => d.inflow || d.outflow).map((d) => (
              <div key={d.date} className="tnum grid grid-cols-[52px_1fr_1fr_1fr] gap-1 border-b border-line/50 px-3 py-2 text-[13px] last:border-0">
                <span className="font-bold">{brDate(d.date).slice(0, 5)}</span>
                <span className="text-right text-ok">{(d.inflow / 100).toFixed(0)}</span>
                <span className="text-right text-bad">{(d.outflow / 100).toFixed(0)}</span>
                <span className="text-right font-bold">{(d.closing / 100).toFixed(0)}</span>
              </div>
            ))}
          </Card>
          <p className="mt-2 text-center text-xs text-muted">Valores em reais, sem centavos.</p>
        </div>
      )}

      {tab === 'dre' && <div className="px-4 pt-3"><DreView from={from} to={to} /></div>}

      {entry && <EntrySheet type={entry} onClose={() => setEntry(null)} />}
      {sale && <SaleSheet sale={sale} onClose={() => setSaleId(null)} />}
      {undo && (
        <ConfirmSheet
          title="Corrigir lançamento?"
          text={`${undo.description}: ${formatBRL(undo.amountCents)}. Será criado um lançamento oposto; o original fica no histórico.`}
          confirm="Corrigir"
          danger
          onClose={() => setUndo(null)}
          onConfirm={() => {
            if (attempt(() => exec(reverseTransaction, { id: undo.id }), 'Lançamento corrigido')) setUndo(null)
          }}
        />
      )}
    </>
  )
}
