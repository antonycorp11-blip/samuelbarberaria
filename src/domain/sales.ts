import { audit, base, must, requireBarberScope, requireOwner, type Command, type Ctx } from './engine'
import { fail } from './errors'
import { allocate, applyBps } from './money'
import { dateKey } from './time'
import type { Client, Coupon, DbState, ID, PaymentMethod, Product, Sale, SaleItem, SalePayment, Subscription } from './types'

export interface CheckoutItem {
  kind: 'service' | 'product'
  refId: ID
  qty: number
  barberId?: ID
}

export interface CheckoutInput {
  appointmentId?: ID | null
  clientId: ID | null
  barberId: ID
  items: CheckoutItem[]
  couponCode?: string
  manualDiscountCents?: number
  useSubscription?: boolean
  useReward?: boolean
  payments: { method: PaymentMethod; amountCents: number }[]
}

export function activeSubscription(s: DbState, clientId: ID | null): Subscription | undefined {
  if (!clientId) return undefined
  return s.subscriptions.find((x) => x.clientId === clientId && x.status === 'active')
}

export function couponProblem(c: Coupon | undefined, today: string, baseCents: number): string | null {
  if (!c || !c.active) return 'Cupom inválido.'
  if (today < c.validFrom || today > c.validTo) return 'Cupom fora da validade.'
  if (c.maxUses !== null && c.uses >= c.maxUses) return 'Cupom esgotado.'
  if (baseCents < c.minCents) return 'Valor mínimo do cupom não atingido.'
  return null
}

export function couponDiscount(c: Coupon, baseCents: number) {
  return Math.min(baseCents, c.type === 'percent' ? applyBps(baseCents, c.value) : c.value)
}

export interface Quote {
  items: SaleItem[]
  subtotalCents: number
  discountCents: number
  totalCents: number
  coupon: Coupon | null
  subscription: Subscription | null
  usedReward: boolean
}

/** Calcula a venda sem gravar nada. A tela e o fechamento usam a mesma conta. */
export function quote(s: DbState, i: Omit<CheckoutInput, 'payments'>, ctx: Pick<Ctx, 'now' | 'id'>): Quote {
  if (i.items.length === 0) fail('empty_sale', 'Adicione ao menos um item.')
  const today = dateKey(ctx.now)
  const items: SaleItem[] = i.items.map((line) => {
    if (!Number.isInteger(line.qty) || line.qty <= 0) fail('bad_qty', 'Quantidade inválida.')
    const ref =
      line.kind === 'service'
        ? must(s.services.find((x) => x.id === line.refId), 'Serviço')
        : must(s.products.find((x) => x.id === line.refId), 'Produto')
    const unit = 'salePriceCents' in ref ? ref.salePriceCents : ref.priceCents
    return {
      id: ctx.id(),
      kind: line.kind,
      refId: line.refId,
      name: ref.name,
      qty: line.qty,
      unitPriceCents: unit,
      grossCents: unit * line.qty,
      discountCents: 0,
      netCents: unit * line.qty,
      unitCostCents: 'avgCostCents' in ref ? ref.avgCostCents : 0,
      barberId: line.barberId ?? i.barberId,
      coverage: null,
    }
  })

  const sub = activeSubscription(s, i.clientId)
  const plan = sub && s.plans.find((p) => p.id === sub.planId)
  let usedSub: Subscription | null = null
  if (i.useSubscription) {
    if (!sub || !plan) fail('no_subscription', 'Cliente sem assinatura ativa.')
    if (plan.visitsPerCycle !== null && sub.usedVisits >= plan.visitsPerCycle) {
      fail('no_visits', 'As visitas do plano neste ciclo acabaram.')
    }
    const covered = items.filter((x) => x.kind === 'service' && plan.serviceIds.includes(x.refId))
    if (covered.length === 0) fail('not_covered', 'Nenhum serviço desta venda está no plano.')
    for (const it of covered) {
      it.coverage = 'subscription'
      it.discountCents = it.grossCents
      it.netCents = 0
    }
    usedSub = sub
  }
  if (plan) {
    for (const it of items) {
      if (it.kind !== 'product') continue
      it.discountCents = applyBps(it.grossCents, plan.productDiscountBps)
      it.netCents = it.grossCents - it.discountCents
    }
  }

  let usedReward = false
  if (i.useReward) {
    const client = s.clients.find((c) => c.id === i.clientId)
    if (!client || client.rewards <= 0) fail('no_reward', 'Cliente sem recompensa disponível.')
    const target = items
      .filter((x) => x.kind === 'service' && x.coverage === null)
      .sort((a, b) => b.grossCents - a.grossCents)[0]
    if (!target) fail('no_reward_target', 'Não há serviço para aplicar a recompensa.')
    target.coverage = 'reward'
    target.discountCents = target.grossCents
    target.netCents = 0
    usedReward = true
  }

  const remaining = items.reduce((sum, x) => sum + x.netCents, 0)
  let coupon: Coupon | null = null
  let extra = 0
  if (i.couponCode) {
    const found = s.coupons.find((c) => c.code === i.couponCode?.trim().toUpperCase())
    const problem = couponProblem(found, today, remaining)
    if (problem) fail('bad_coupon', problem)
    coupon = found as Coupon
    extra += couponDiscount(coupon, remaining)
  }
  const manual = i.manualDiscountCents ?? 0
  if (manual < 0 || !Number.isInteger(manual)) fail('bad_discount', 'Desconto inválido.')
  extra += manual
  if (extra > remaining) fail('bad_discount', 'O desconto é maior que o valor da venda.')
  if (extra > 0) {
    const shares = allocate(extra, items.map((x) => x.netCents))
    items.forEach((it, idx) => {
      const share = shares[idx] ?? 0
      it.discountCents += share
      it.netCents -= share
    })
  }

  const subtotalCents = items.reduce((sum, x) => sum + x.grossCents, 0)
  const totalCents = items.reduce((sum, x) => sum + x.netCents, 0)
  return { items, subtotalCents, discountCents: subtotalCents - totalCents, totalCents, coupon, subscription: usedSub, usedReward }
}

function awardStamp(client: Client, required: number): boolean {
  client.stamps += 1
  if (client.stamps < required) return false
  client.stamps -= required
  client.rewards += 1
  return true
}

/**
 * Fechamento de atendimento. Em uma única operação atômica: venda, pagamentos,
 * caixa, taxas, comissões, baixa de estoque, cupom, assinatura e fidelidade.
 */
export const checkout: Command<CheckoutInput, Sale> = (d, i, ctx) => {
  const s = base(d)
  requireBarberScope(ctx, i.barberId)
  if ((i.manualDiscountCents ?? 0) > 0) requireOwner(ctx)
  const barber = must(s.barbers.find((b) => b.id === i.barberId), 'Profissional')
  if (i.clientId) must(s.clients.find((c) => c.id === i.clientId), 'Cliente')

  const appt = i.appointmentId ? must(d.appointments.find((a) => a.id === i.appointmentId), 'Agendamento') : null
  if (appt) {
    if (appt.saleId) fail('already_closed', 'Este atendimento já foi fechado.')
    if (!['scheduled', 'confirmed', 'in_progress'].includes(appt.status)) {
      fail('bad_status', 'Este atendimento não pode ser fechado.')
    }
    if (appt.clientId !== i.clientId) fail('client_mismatch', 'O cliente não confere com o agendamento.')
  }

  const q = quote(s, i, ctx)

  const paid = i.payments.reduce((sum, p) => sum + p.amountCents, 0)
  if (i.payments.some((p) => !Number.isInteger(p.amountCents) || p.amountCents <= 0)) {
    fail('bad_payment', 'Valor de pagamento inválido.')
  }
  if (paid !== q.totalCents) fail('payment_mismatch', 'A soma dos pagamentos precisa ser igual ao total.')

  const needed = new Map<ID, number>()
  for (const it of q.items) {
    if (it.kind === 'product') needed.set(it.refId, (needed.get(it.refId) ?? 0) + it.qty)
  }
  for (const [productId, qty] of needed) {
    const p = must(s.products.find((x) => x.id === productId), 'Produto')
    if (p.qty < qty) fail('no_stock', `Estoque insuficiente de ${p.name}: restam ${p.qty}.`)
  }

  const saleId = ctx.id()
  const payments: SalePayment[] = i.payments.map((p) => ({
    ...p,
    feeCents: applyBps(p.amountCents, s.settings.feeBps[p.method]),
  }))
  for (const p of payments) {
    d.transactions.push({
      id: ctx.id(), type: 'in', category: 'venda', amountCents: p.amountCents, method: p.method, at: ctx.now,
      description: 'Venda', saleId, reversalOf: null, reversed: false,
    })
    if (p.feeCents > 0) {
      d.transactions.push({
        id: ctx.id(), type: 'out', category: 'taxa_pagamento', amountCents: p.feeCents, method: p.method, at: ctx.now,
        description: 'Taxa da maquininha', saleId, reversalOf: null, reversed: false,
      })
    }
  }

  for (const it of q.items) {
    const worker = must(s.barbers.find((b) => b.id === it.barberId), 'Profissional')
    // Na recompensa de fidelidade quem paga é a casa: o barbeiro recebe sobre o preço cheio.
    const baseCents = it.coverage === 'reward' ? it.grossCents : it.netCents
    const bps = it.kind === 'service' ? worker.serviceBps : worker.productBps
    if (baseCents > 0 && bps > 0) {
      d.commissions.push({
        id: ctx.id(), barberId: worker.id, saleId, chargeId: null, kind: it.kind, baseCents, bps,
        amountCents: applyBps(baseCents, bps), status: 'pending', payoutId: null, at: ctx.now,
      })
    }
    if (it.kind === 'product') {
      const p = d.products.find((x) => x.id === it.refId) as Product
      p.qty -= it.qty
      d.stockMovements.push({
        id: ctx.id(), productId: p.id, type: 'sale', qty: -it.qty, unitCostCents: it.unitCostCents, at: ctx.now, saleId, note: '',
      })
    }
  }

  if (q.coupon) {
    const c = d.coupons.find((x) => x.id === q.coupon?.id) as Coupon
    c.uses += 1
  }
  if (q.subscription) {
    const sub = d.subscriptions.find((x) => x.id === q.subscription?.id) as Subscription
    sub.usedVisits += 1
  }

  let stampAwarded = false
  let rewardEarned = false
  const client = i.clientId ? (d.clients.find((c) => c.id === i.clientId) as Client) : null
  if (client) {
    if (q.usedReward) client.rewards -= 1
    if (q.items.some((x) => x.kind === 'service' && x.coverage === null)) {
      stampAwarded = true
      rewardEarned = awardStamp(client, s.settings.loyaltyStampsRequired)
    }
  }

  const sale: Sale = {
    id: saleId, clientId: i.clientId, barberId: barber.id, appointmentId: appt?.id ?? null, items: q.items,
    subtotalCents: q.subtotalCents, discountCents: q.discountCents, totalCents: q.totalCents,
    couponId: q.coupon?.id ?? null, subscriptionId: q.subscription?.id ?? null, usedReward: q.usedReward,
    stampAwarded, rewardEarned, payments, status: 'paid', at: ctx.now, refundedAt: null, refundReason: '',
  }
  d.sales.push(sale)
  if (appt) {
    appt.status = 'completed'
    appt.saleId = saleId
  }
  audit(d, ctx, 'venda.fechar', saleId, `total=${q.totalCents}`)
  return sale
}

/** Estorno: nada é apagado. Cada efeito da venda recebe um lançamento oposto. */
export const refundSale: Command<{ saleId: ID; reason: string }> = (d, i, ctx) => {
  requireOwner(ctx)
  const s = base(d)
  const sale = must(d.sales.find((x) => x.id === i.saleId), 'Venda')
  if (sale.status === 'refunded') fail('already_refunded', 'Esta venda já foi estornada.')
  if (!i.reason.trim()) fail('no_reason', 'Informe o motivo do estorno.')

  for (const p of sale.payments) {
    d.transactions.push({
      id: ctx.id(), type: 'out', category: 'estorno', amountCents: p.amountCents, method: p.method, at: ctx.now,
      description: 'Estorno de venda', saleId: sale.id, reversalOf: null, reversed: false,
    })
    if (p.feeCents > 0) {
      d.transactions.push({
        id: ctx.id(), type: 'in', category: 'taxa_pagamento', amountCents: p.feeCents, method: p.method, at: ctx.now,
        description: 'Devolução de taxa', saleId: sale.id, reversalOf: null, reversed: false,
      })
    }
  }

  for (const c of s.commissions.filter((x) => x.saleId === sale.id && x.kind !== 'reversal')) {
    d.commissions.push({
      id: ctx.id(), barberId: c.barberId, saleId: sale.id, chargeId: null, kind: 'reversal', baseCents: -c.baseCents,
      bps: c.bps, amountCents: -c.amountCents, status: 'pending', payoutId: null, at: ctx.now,
    })
  }

  for (const it of sale.items) {
    if (it.kind !== 'product') continue
    const p = must(d.products.find((x) => x.id === it.refId), 'Produto')
    const total = p.qty + it.qty
    p.avgCostCents = total > 0 ? Math.round((p.qty * p.avgCostCents + it.qty * it.unitCostCents) / total) : p.avgCostCents
    p.qty = total
    d.stockMovements.push({
      id: ctx.id(), productId: p.id, type: 'refund', qty: it.qty, unitCostCents: it.unitCostCents, at: ctx.now, saleId: sale.id, note: i.reason,
    })
  }

  if (sale.couponId) {
    const c = d.coupons.find((x) => x.id === sale.couponId)
    if (c) c.uses = Math.max(0, c.uses - 1)
  }
  if (sale.subscriptionId) {
    const sub = d.subscriptions.find((x) => x.id === sale.subscriptionId)
    const day = dateKey(sale.at)
    if (sub && day >= sub.periodStart && day < sub.periodEnd) sub.usedVisits = Math.max(0, sub.usedVisits - 1)
  }
  const client = sale.clientId ? d.clients.find((c) => c.id === sale.clientId) : null
  if (client) {
    if (sale.usedReward) client.rewards += 1
    if (sale.rewardEarned) {
      if (client.rewards > 0) {
        client.rewards -= 1
        client.stamps += s.settings.loyaltyStampsRequired - 1
      } else client.stamps = 0
    } else if (sale.stampAwarded) client.stamps = Math.max(0, client.stamps - 1)
  }

  sale.status = 'refunded'
  sale.refundedAt = ctx.now
  sale.refundReason = i.reason
  audit(d, ctx, 'venda.estornar', sale.id, i.reason)
}
