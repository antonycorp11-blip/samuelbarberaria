import { describe, expect, it } from 'vitest'
import {
  addToWaitlist, availableSlots, bookOnline, cancelAppointment, createAppointment, createBlock, rescheduleAppointment, setAppointmentStatus,
} from '../src/domain/agenda'
import { runAutomations } from '../src/domain/automations'
import { DomainError } from '../src/domain/errors'
import { addTransaction, cashFlow, dre, reverseTransaction } from '../src/domain/finance'
import { upsertCoupon } from '../src/domain/marketing'
import { checkout, quote, refundSale, type CheckoutItem } from '../src/domain/sales'
import { stockAdjust, stockIn, stockOut } from '../src/domain/stock'
import { cancelSubscription, payCharge, subscribe, upsertPlan } from '../src/domain/subscriptions'
import { payCommissions } from '../src/domain/team'
import { addMinutes, toISO } from '../src/domain/time'
import type { PaymentMethod } from '../src/domain/types'
import { assertInvariants, setup } from './helpers'

function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

/**
 * Simula meses de operação com ações aleatórias, inclusive inválidas de propósito.
 * Regra rejeitada é esperado; o que não pode é erro inesperado ou invariante quebrada.
 */
function simulate(seed: number, steps: number) {
  const ctx = setup()
  const { w, ana, beto, cut, beard, joao, maria, pomade } = ctx
  const r = prng(seed)
  const pick = <T,>(list: readonly T[]) => list[Math.floor(r() * list.length)] as T
  const methods: PaymentMethod[] = ['pix', 'cash', 'debit', 'credit']
  const planId = w.do(upsertPlan, { name: 'Clube', priceCents: 9990, visitsPerCycle: 4, serviceIds: [cut], productDiscountBps: 1000, benefits: [] })
  w.do(upsertCoupon, { code: 'FUZZ', type: 'percent', value: 1500, minCents: 0, maxUses: 40, validFrom: '2026-01-01', validTo: '2027-12-31', active: true })
  let rejected = 0
  let accepted = 0

  const open = () => w.state.appointments.filter((a) => ['scheduled', 'confirmed', 'in_progress'].includes(a.status))

  const actions: (() => void)[] = [
    () => {
      const barberId = pick([ana, beto])
      const date = toISO(w.today, '09:00').slice(0, 10)
      const slots = availableSlots(w.state, barberId, date, 30, w.now)
      const start = r() < 0.8 && slots.length ? pick(slots) : addMinutes(w.now, Math.floor(r() * 3000) - 200)
      w.do(createAppointment, { clientId: pick([joao, maria]), barberId, serviceIds: r() < 0.3 ? [cut, beard] : [cut], start })
    },
    () => {
      const n = Math.floor(r() * 90000)
      w.do(bookOnline, {
        name: `Cliente ${n}`, phone: `119${String(n).padStart(8, '0')}`, email: `c${n}@teste.com`, marketingOptIn: r() < 0.5,
        serviceIds: [cut], barberId: pick([ana, beto]), start: addMinutes(w.now, 60 + Math.floor(r() * 96) * 15),
      })
    },
    () => {
      const a = pick(open())
      if (!a) return
      const items: CheckoutItem[] = a.serviceIds.map((refId) => ({ kind: 'service', refId, qty: 1 }))
      if (r() < 0.4) items.push({ kind: 'product', refId: pomade, qty: 1 + Math.floor(r() * 3) })
      const options = {
        appointmentId: a.id, clientId: a.clientId, barberId: a.barberId, items,
        useSubscription: r() < 0.3, useReward: r() < 0.1, couponCode: r() < 0.2 ? 'FUZZ' : undefined,
        manualDiscountCents: r() < 0.1 ? Math.floor(r() * 2000) : 0,
      }
      const q = quote(w.state, options, w.ctx()).totalCents
      const first = Math.floor(q * r())
      const payments = q === 0 ? [] : first > 0 && r() < 0.3
        ? [{ method: pick(methods), amountCents: first }, { method: pick(methods), amountCents: q - first }]
        : [{ method: pick(methods), amountCents: r() < 0.05 ? q + 1 : q }]
      w.do(checkout, { ...options, payments })
    },
    () => w.do(cancelAppointment, { id: pick(open())?.id ?? 'x' }),
    () => w.do(setAppointmentStatus, { id: pick(open())?.id ?? 'x', status: pick(['confirmed', 'in_progress', 'no_show'] as const) }),
    () => w.do(rescheduleAppointment, { id: pick(open())?.id ?? 'x', barberId: pick([ana, beto]), start: addMinutes(w.now, Math.floor(r() * 200) * 15) }),
    () => {
      if (r() < 0.25) w.do(refundSale, { saleId: pick(w.state.sales)?.id ?? 'x', reason: 'fuzz' })
    },
    () => w.do(payCommissions, { barberId: pick([ana, beto]), method: pick(methods) }),
    () => w.do(stockIn, { productId: pomade, qty: 1 + Math.floor(r() * 8), unitCostCents: 1000 + Math.floor(r() * 1500), method: pick(methods) }),
    () => w.do(stockOut, { productId: pomade, qty: 1 + Math.floor(r() * 4), note: 'fuzz' }),
    () => w.do(stockAdjust, { productId: pomade, countedQty: Math.floor(r() * 20), note: 'fuzz' }),
    () => w.do(addTransaction, { type: 'out', category: 'aluguel', amountCents: 1 + Math.floor(r() * 90000), method: pick(methods), description: '' }),
    () => w.do(reverseTransaction, { id: pick(w.state.transactions)?.id ?? 'x' }),
    () => w.do(subscribe, { clientId: pick(w.state.clients).id, planId, payWith: r() < 0.7 ? pick(methods) : null }),
    () => w.do(payCharge, { chargeId: pick(w.state.charges)?.id ?? 'x', method: pick(methods) }),
    () => w.do(cancelSubscription, { id: pick(w.state.subscriptions)?.id ?? 'x', immediate: r() < 0.5 }),
    () => w.do(addToWaitlist, { clientId: maria, serviceIds: [cut], barberId: null, date: w.today }),
    () => w.do(createBlock, { barberId: pick([ana, beto]), start: addMinutes(w.now, 600), end: addMinutes(w.now, 660), reason: 'fuzz' }),
    () => {
      w.now = addMinutes(w.now, Math.floor(r() * 1800))
      w.do(runAutomations, undefined)
    },
  ]

  const weighted = [...actions, actions[0]!, actions[0]!, actions[1]!, actions[2]!, actions[2]!, actions[2]!, actions[2]!]
  for (let i = 0; i < steps; i++) {
    try {
      pick(weighted)()
      accepted += 1
    } catch (e) {
      if (!(e instanceof DomainError)) throw e
      rejected += 1
    }
    if (i % 250 === 0) expect(assertInvariants(w.state)).toEqual([])
  }
  expect(assertInvariants(w.state)).toEqual([])

  // Conferência cruzada: o saldo final do caixa precisa bater com a soma de todos os lançamentos.
  const flow = cashFlow(w.state, '2026-03-02', w.today)
  const ledger = w.state.transactions.reduce((t, x) => t + (x.type === 'in' ? x.amountCents : -x.amountCents), 0)
  expect(flow.at(-1)?.closing).toBe(ledger)

  // O DRE do período inteiro é a soma dos DREs de cada dia.
  const whole = dre(w.state, '2026-03-02', w.today).netProfit
  const daily = flow.reduce((t, d) => t + dre(w.state, d.date, d.date).netProfit, 0)
  expect(daily).toBe(whole)

  return { accepted, rejected, sales: w.state.sales.length, charges: w.state.charges.length, subCommissions: w.state.commissions.filter((c) => c.kind === 'subscription').length, days: flow.length, refunds: w.state.sales.filter((s) => s.status === 'refunded').length }
}

describe('simulação de operação', () => {
  it.each([1, 2, 3, 4, 5])('mantém as invariantes com a semente %i', (seed) => {
    const out = simulate(seed, 3000)
    console.log(`semente ${seed}:`, out)
    expect(out.sales).toBeGreaterThan(100)
    expect(out.refunds).toBeGreaterThan(0)
  })
})
