import { audit, base, must, requireOwner, type Command, type Ctx } from './engine'
import { fail } from './errors'
import { chargeMessage, enqueue } from './messages'
import { allocate, applyBps } from './money'
import { addDays, addMonths, dateKey } from './time'
import type { Cents, DateKey, DbState, ID, PaymentMethod, Plan, Subscription, SubscriptionCharge } from './types'

export const upsertPlan: Command<Omit<Plan, 'id' | 'active'> & { id?: ID; active?: boolean }, ID> = (d, i, ctx) => {
  requireOwner(ctx)
  if (!i.name.trim()) fail('bad_name', 'Informe o nome do plano.')
  if (i.priceCents <= 0) fail('bad_price', 'Informe o valor do plano.')
  if (i.serviceIds.length === 0) fail('no_service', 'Escolha ao menos um serviço do plano.')
  if (i.visitsPerCycle !== null && i.visitsPerCycle <= 0) fail('bad_visits', 'Número de visitas inválido.')
  const current = i.id ? must(d.plans.find((p) => p.id === i.id), 'Plano') : null
  if (current) {
    Object.assign(current, { ...i, active: i.active ?? current.active })
    return current.id
  }
  const id = ctx.id()
  d.plans.push({ ...i, id, active: true })
  return id
}

function createCharge(d: DbState, ctx: Ctx, sub: Subscription, amountCents: Cents): SubscriptionCharge {
  const charge: SubscriptionCharge = {
    id: ctx.id(), subscriptionId: sub.id, periodStart: sub.periodStart, periodEnd: sub.periodEnd, amountCents,
    dueDate: sub.periodStart, status: 'pending', paidAt: null, method: null, feeCents: 0, commissionClosed: false,
  }
  d.charges.push(charge)
  return charge
}

function settleCharge(d: DbState, ctx: Ctx, charge: SubscriptionCharge, method: PaymentMethod) {
  const s = base(d)
  charge.status = 'paid'
  charge.paidAt = ctx.now
  charge.method = method
  charge.feeCents = applyBps(charge.amountCents, s.settings.feeBps[method])
  d.transactions.push({
    id: ctx.id(), type: 'in', category: 'assinatura', amountCents: charge.amountCents, method, at: ctx.now,
    description: 'Mensalidade do clube', saleId: null, reversalOf: null, reversed: false,
  })
  if (charge.feeCents > 0) {
    d.transactions.push({
      id: ctx.id(), type: 'out', category: 'taxa_pagamento', amountCents: charge.feeCents, method, at: ctx.now,
      description: 'Taxa da mensalidade', saleId: null, reversalOf: null, reversed: false,
    })
  }
}

export const subscribe: Command<{ clientId: ID; planId: ID; payWith?: PaymentMethod | null }, Subscription> = (d, i, ctx) => {
  requireOwner(ctx)
  const s = base(d)
  must(s.clients.find((c) => c.id === i.clientId), 'Cliente')
  const plan = must(s.plans.find((p) => p.id === i.planId), 'Plano')
  if (!plan.active) fail('inactive_plan', 'Plano inativo.')
  if (s.subscriptions.some((x) => x.clientId === i.clientId && x.status !== 'cancelled')) {
    fail('already_subscribed', 'Este cliente já tem assinatura.')
  }
  const start = dateKey(ctx.now)
  const sub: Subscription = {
    id: ctx.id(), clientId: i.clientId, planId: i.planId, status: 'active', startedAt: ctx.now, periodStart: start,
    periodEnd: addMonths(start, 1), usedVisits: 0, autoRenew: true, cancelledAt: null,
  }
  d.subscriptions.push(sub)
  const charge = createCharge(d, ctx, sub, plan.priceCents)
  if (i.payWith) settleCharge(d, ctx, charge, i.payWith)
  audit(d, ctx, 'assinatura.criar', sub.id)
  return sub
}

export const payCharge: Command<{ chargeId: ID; method: PaymentMethod }> = (d, i, ctx) => {
  requireOwner(ctx)
  const charge = must(d.charges.find((c) => c.id === i.chargeId), 'Cobrança')
  if (charge.status !== 'pending') fail('bad_status', 'Esta cobrança não está em aberto.')
  settleCharge(d, ctx, charge, i.method)
  const sub = must(d.subscriptions.find((x) => x.id === charge.subscriptionId), 'Assinatura')
  const stillOpen = d.charges.some((c) => c.subscriptionId === sub.id && c.status === 'pending')
  if (sub.status === 'past_due' && !stillOpen) sub.status = 'active'
  const today = dateKey(ctx.now)
  closeChargeCommission(d, ctx, charge, today)
  renewIfDue(d, ctx, sub, today)
  audit(d, ctx, 'cobranca.pagar', charge.id)
}

/** Por padrão mantém o acesso até o fim do período já pago. */
export const cancelSubscription: Command<{ id: ID; immediate?: boolean }> = (d, i, ctx) => {
  requireOwner(ctx)
  const sub = must(d.subscriptions.find((x) => x.id === i.id), 'Assinatura')
  if (sub.status === 'cancelled') fail('bad_status', 'Assinatura já cancelada.')
  sub.autoRenew = false
  if (i.immediate || sub.status === 'past_due') {
    sub.status = 'cancelled'
    sub.cancelledAt = ctx.now
    for (const c of d.charges) {
      if (c.subscriptionId === sub.id && c.status === 'pending') c.status = 'void'
    }
  }
  audit(d, ctx, 'assinatura.cancelar', sub.id)
}

function nextPeriodEnd(sub: Subscription): DateKey {
  // Conta a partir do início original para que 31/jan não vire dia 28 para sempre.
  const start = dateKey(sub.startedAt)
  const months =
    (Number(sub.periodEnd.slice(0, 4)) - Number(start.slice(0, 4))) * 12 +
    (Number(sub.periodEnd.slice(5, 7)) - Number(start.slice(5, 7)))
  return addMonths(start, months + 1)
}

/** Renova ou encerra ciclos vencidos. Seguro para rodar quantas vezes for preciso. */
export function renewIfDue(d: DbState, ctx: Ctx, sub: Subscription, today: DateKey) {
  while (sub.status === 'active' && sub.periodEnd <= today) {
    if (!sub.autoRenew) {
      sub.status = 'cancelled'
      sub.cancelledAt = ctx.now
      return
    }
    const plan = must(base(d).plans.find((p) => p.id === sub.planId), 'Plano')
    const nextEnd = nextPeriodEnd(sub)
    sub.periodStart = sub.periodEnd
    sub.periodEnd = nextEnd
    sub.usedVisits = 0
    const charge = createCharge(d, ctx, sub, plan.priceCents)
    const client = base(d).clients.find((c) => c.id === sub.clientId)
    if (client) enqueue(d, ctx, chargeMessage('charge_due', client, charge.id, charge.amountCents, charge.dueDate))
  }
}

export function markOverdue(d: DbState, ctx: Ctx, today: DateKey, seen?: Set<string>) {
  const s = base(d)
  for (const charge of s.charges) {
    if (charge.status !== 'pending') continue
    if (addDays(charge.dueDate, s.settings.subscriptionGraceDays) >= today) continue
    const sub = d.subscriptions.find((x) => x.id === charge.subscriptionId)
    if (!sub || sub.status !== 'active') continue
    sub.status = 'past_due'
    const client = s.clients.find((c) => c.id === sub.clientId)
    if (client) enqueue(d, ctx, chargeMessage('charge_overdue', client, charge.id, charge.amountCents, charge.dueDate), seen)
  }
}

/**
 * Comissão de assinatura: ao fechar um ciclo pago, parte da mensalidade é dividida
 * entre os barbeiros na proporção do valor que cada um atendeu pelo plano.
 */
export function closeChargeCommission(d: DbState, ctx: Ctx, charge: SubscriptionCharge, today: DateKey) {
  if (charge.status !== 'paid' || charge.commissionClosed || charge.periodEnd > today) return
  const s = base(d)
  const weights = new Map<ID, number>()
  for (const sale of s.sales) {
    if (sale.subscriptionId !== charge.subscriptionId || sale.status !== 'paid') continue
    const day = dateKey(sale.at)
    if (day < charge.periodStart || day >= charge.periodEnd) continue
    for (const it of sale.items) {
      if (it.coverage === 'subscription') weights.set(it.barberId, (weights.get(it.barberId) ?? 0) + it.grossCents)
    }
  }
  charge.commissionClosed = true
  const bps = s.settings.subscriptionCommissionBps
  const pool = applyBps(charge.amountCents, bps)
  const ids = [...weights.keys()]
  allocate(pool, [...weights.values()]).forEach((amountCents, idx) => {
    if (amountCents <= 0) return
    d.commissions.push({
      id: ctx.id(), barberId: ids[idx] as ID, saleId: null, chargeId: charge.id, kind: 'subscription',
      baseCents: charge.amountCents, bps, amountCents, status: 'pending', payoutId: null, at: ctx.now,
    })
  })
}

export function subscriptionMetrics(s: DbState) {
  const active = s.subscriptions.filter((x) => x.status === 'active')
  const mrrCents = active
    .filter((x) => x.autoRenew)
    .reduce((sum, x) => sum + (s.plans.find((p) => p.id === x.planId)?.priceCents ?? 0), 0)
  return {
    activeCount: active.length,
    pastDueCount: s.subscriptions.filter((x) => x.status === 'past_due').length,
    mrrCents,
    openCents: s.charges.filter((c) => c.status === 'pending').reduce((sum, c) => sum + c.amountCents, 0),
  }
}
