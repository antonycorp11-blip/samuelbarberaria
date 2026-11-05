import { audit, must, requireOwner, type Command } from './engine'
import { fail } from './errors'
import { addDays, dateKey, daysBetween } from './time'
import type { Cents, DateKey, DbState, ID, ISO, PaymentMethod, Sale, Transaction, TxCategory } from './types'

export const EXPENSE_CATEGORIES: { id: TxCategory; label: string }[] = [
  { id: 'aluguel', label: 'Aluguel' },
  { id: 'energia_agua', label: 'Energia e água' },
  { id: 'internet_software', label: 'Internet e sistemas' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'manutencao', label: 'Manutenção' },
  { id: 'salarios', label: 'Salários e pró-labore' },
  { id: 'impostos', label: 'Impostos' },
  { id: 'outras_despesas', label: 'Outras despesas' },
]

export const CATEGORY_LABEL: Record<TxCategory, string> = {
  ...(Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.id, c.label])) as Record<TxCategory, string>),
  venda: 'Venda',
  assinatura: 'Assinatura',
  taxa_pagamento: 'Taxa de pagamento',
  estorno: 'Estorno',
  comissao: 'Comissão',
  compra_estoque: 'Compra de estoque',
  outras_receitas: 'Outras receitas',
}

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  pix: 'Pix',
  cash: 'Dinheiro',
  debit: 'Débito',
  credit: 'Crédito',
}

const MANUAL_OUT = EXPENSE_CATEGORIES.map((c) => c.id)

export const addTransaction: Command<
  { type: 'in' | 'out'; category: TxCategory; amountCents: Cents; method: PaymentMethod; description: string; at?: ISO },
  ID
> = (d, i, ctx) => {
  requireOwner(ctx)
  if (!Number.isInteger(i.amountCents) || i.amountCents <= 0) fail('bad_amount', 'Informe um valor maior que zero.')
  const allowed = i.type === 'out' ? MANUAL_OUT.includes(i.category) : i.category === 'outras_receitas'
  if (!allowed) fail('bad_category', 'Categoria inválida para este lançamento.')
  const id = ctx.id()
  d.transactions.push({
    id, type: i.type, category: i.category, amountCents: i.amountCents, method: i.method, at: i.at ?? ctx.now,
    description: i.description.trim() || CATEGORY_LABEL[i.category], saleId: null, reversalOf: null, reversed: false,
  })
  audit(d, ctx, 'caixa.lancar', id, `${i.type} ${i.amountCents}`)
  return id
}

/** Lançamento errado não se apaga: gera o oposto, e os dois ficam no histórico. */
export const reverseTransaction: Command<{ id: ID }> = (d, i, ctx) => {
  requireOwner(ctx)
  const t = must(d.transactions.find((x) => x.id === i.id), 'Lançamento')
  if (t.reversed || t.reversalOf) fail('already_reversed', 'Este lançamento já foi corrigido.')
  if (![...MANUAL_OUT, 'outras_receitas'].includes(t.category)) {
    fail('system_tx', 'Lançamentos automáticos são corrigidos pelo estorno da venda.')
  }
  t.reversed = true
  d.transactions.push({
    ...t, id: ctx.id(), type: t.type === 'in' ? 'out' : 'in', at: ctx.now, description: `Correção: ${t.description}`,
    reversalOf: t.id, reversed: false,
  })
  audit(d, ctx, 'caixa.corrigir', t.id)
}

const signed = (t: Transaction) => (t.type === 'in' ? t.amountCents : -t.amountCents)
const inRange = (iso: ISO, from: DateKey, to: DateKey) => {
  const k = dateKey(iso)
  return k >= from && k <= to
}

export interface CashFlowDay {
  date: DateKey
  opening: Cents
  inflow: Cents
  outflow: Cents
  closing: Cents
}

export function cashFlow(s: DbState, from: DateKey, to: DateKey): CashFlowDay[] {
  const inflow = new Map<DateKey, Cents>()
  const outflow = new Map<DateKey, Cents>()
  let opening = 0
  for (const t of s.transactions) {
    const k = dateKey(t.at)
    if (k < from) opening += signed(t)
    else if (k <= to) {
      const map = t.type === 'in' ? inflow : outflow
      map.set(k, (map.get(k) ?? 0) + t.amountCents)
    }
  }
  return daysBetween(from, to).map((date) => {
    const i = inflow.get(date) ?? 0
    const o = outflow.get(date) ?? 0
    const row = { date, opening, inflow: i, outflow: o, closing: opening + i - o }
    opening = row.closing
    return row
  })
}

export function balanceByMethod(s: DbState, from: DateKey, to: DateKey): Record<PaymentMethod, Cents> {
  const out: Record<PaymentMethod, Cents> = { pix: 0, cash: 0, debit: 0, credit: 0 }
  for (const t of s.transactions) {
    if (t.category === 'venda' || t.category === 'assinatura' || t.category === 'estorno') {
      if (inRange(t.at, from, to)) out[t.method] += signed(t)
    }
  }
  return out
}

export interface Dre {
  serviceRevenue: Cents
  productRevenue: Cents
  subscriptionRevenue: Cents
  otherRevenue: Cents
  grossRevenue: Cents
  refunds: Cents
  paymentFees: Cents
  netRevenue: Cents
  cogs: Cents
  commissions: Cents
  contributionMargin: Cents
  expenses: { category: TxCategory; label: string; amountCents: Cents }[]
  totalExpenses: Cents
  netProfit: Cents
  /** Margem líquida em bps. */
  marginBps: number
}

/**
 * Regime de competência. Estorno entra no mês em que aconteceu, nunca reescreve
 * um mês já fechado. Compra de estoque e pagamento de comissão só mexem no caixa:
 * no resultado, entram como CMV e comissão gerada, para não contar duas vezes.
 */
export function dre(s: DbState, from: DateKey, to: DateKey): Dre {
  let serviceRevenue = 0
  let productRevenue = 0
  let refunds = 0
  for (const sale of s.sales) {
    if (inRange(sale.at, from, to)) {
      for (const it of sale.items) {
        if (it.kind === 'service') serviceRevenue += it.netCents
        else productRevenue += it.netCents
      }
    }
    if (sale.refundedAt && inRange(sale.refundedAt, from, to)) refunds += sale.totalCents
  }

  let subscriptionRevenue = 0
  let otherRevenue = 0
  let paymentFees = 0
  const byCategory = new Map<TxCategory, Cents>()
  for (const t of s.transactions) {
    if (!inRange(t.at, from, to)) continue
    if (t.category === 'assinatura') subscriptionRevenue += signed(t)
    else if (t.category === 'outras_receitas') otherRevenue += signed(t)
    else if (t.category === 'taxa_pagamento') paymentFees -= signed(t)
    else if (MANUAL_OUT.includes(t.category)) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) - signed(t))
  }

  const cogs = s.stockMovements
    .filter((m) => m.type !== 'in' && inRange(m.at, from, to))
    .reduce((sum, m) => sum - m.qty * m.unitCostCents, 0)
  const commissions = s.commissions.filter((c) => inRange(c.at, from, to)).reduce((sum, c) => sum + c.amountCents, 0)

  const grossRevenue = serviceRevenue + productRevenue + subscriptionRevenue + otherRevenue
  const netRevenue = grossRevenue - refunds - paymentFees
  const contributionMargin = netRevenue - cogs - commissions
  const expenses = [...byCategory.entries()]
    .filter(([, v]) => v !== 0)
    .map(([category, amountCents]) => ({ category, label: CATEGORY_LABEL[category], amountCents }))
    .sort((a, b) => b.amountCents - a.amountCents)
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amountCents, 0)
  const netProfit = contributionMargin - totalExpenses
  return {
    serviceRevenue, productRevenue, subscriptionRevenue, otherRevenue, grossRevenue, refunds, paymentFees, netRevenue,
    cogs, commissions, contributionMargin, expenses, totalExpenses, netProfit,
    marginBps: grossRevenue > 0 ? Math.round((netProfit / grossRevenue) * 10000) : 0,
  }
}

export function paidSales(s: DbState, from: DateKey, to: DateKey): Sale[] {
  return s.sales.filter((x) => x.status === 'paid' && inRange(x.at, from, to))
}

/** Ticket médio: valor pago por atendimento. Mensalidade fica fora para não distorcer. */
export function averageTicket(s: DbState, from: DateKey, to: DateKey): Cents {
  const list = paidSales(s, from, to).filter((x) => x.totalCents > 0)
  if (list.length === 0) return 0
  return Math.round(list.reduce((sum, x) => sum + x.totalCents, 0) / list.length)
}

export function revenueSeries(s: DbState, from: DateKey, to: DateKey) {
  const totals = new Map<DateKey, Cents>()
  for (const x of paidSales(s, from, to)) {
    const k = dateKey(x.at)
    totals.set(k, (totals.get(k) ?? 0) + x.totalCents)
  }
  return daysBetween(from, to).map((date) => ({ date, cents: totals.get(date) ?? 0 }))
}

export const lastDays = (today: DateKey, n: number) => ({ from: addDays(today, -n + 1), to: today })
