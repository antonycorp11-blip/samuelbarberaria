import { describe, expect, it } from 'vitest'
import { runAutomations } from '../src/domain/automations'
import { dre } from '../src/domain/finance'
import { checkout, refundSale } from '../src/domain/sales'
import { cancelSubscription, payCharge, planDaysLabel, subscribe, subscriptionMetrics, upsertPlan } from '../src/domain/subscriptions'
import { weekday } from '../src/domain/time'
import { commissionBalance } from '../src/domain/team'
import { assertInvariants, setup } from './helpers'

function withPlan(visits: number | null = 2) {
  const ctx = setup()
  const planId = ctx.w.do(upsertPlan, {
    name: 'Clube', priceCents: 10000, visitsPerCycle: visits, serviceIds: [ctx.cut], productDiscountBps: 1000, benefits: [],
  })
  return { ...ctx, planId }
}

describe('clube de assinaturas', () => {
  it('assinar com pagamento lança receita recorrente', () => {
    const { w, joao, planId } = withPlan()
    w.do(subscribe, { clientId: joao, planId, payWith: 'credit' })
    const r = dre(w.state, w.today, w.today)
    expect(r.subscriptionRevenue).toBe(10000)
    expect(r.paymentFees).toBe(349)
    expect(subscriptionMetrics(w.state)).toMatchObject({ activeCount: 1, mrrCents: 10000 })
  })

  it('cobre o serviço, conta visitas e para no limite', () => {
    const { w, ana, cut, joao, planId } = withPlan(1)
    w.do(subscribe, { clientId: joao, planId, payWith: 'pix' })
    const base = { clientId: joao, barberId: ana, items: [{ kind: 'service' as const, refId: cut, qty: 1 }], useSubscription: true }
    const sale = w.do(checkout, { ...base, payments: [] })
    expect(sale.totalCents).toBe(0)
    expect(w.state.subscriptions[0]?.usedVisits).toBe(1)
    expect(() => w.do(checkout, { ...base, payments: [] })).toThrow(/acabaram/)
  })

  it('serviço fora do plano é cobrado e produto tem desconto do assinante', () => {
    const { w, ana, beard, cut, joao, planId, pomade } = withPlan()
    w.do(subscribe, { clientId: joao, planId, payWith: 'pix' })
    const sale = w.do(checkout, {
      clientId: joao, barberId: ana, useSubscription: true,
      items: [{ kind: 'service', refId: cut, qty: 1 }, { kind: 'service', refId: beard, qty: 1 }, { kind: 'product', refId: pomade, qty: 1 }],
      payments: [{ method: 'pix', amountCents: 3333 + 3600 }],
    })
    expect(sale.items[0]?.netCents).toBe(0)
    expect(sale.totalCents).toBe(6933)
  })

  it('plano de seg a qua: fora do dia bloqueia o plano e cobra avulso com o desconto do assinante', () => {
    const ctx = setup()
    const { w, ana, cut, joao } = ctx
    const today = weekday(w.today)
    const planId = w.do(upsertPlan, {
      name: 'Básico seg–qua', priceCents: 6500, visitsPerCycle: null, serviceIds: [cut], productDiscountBps: 1000,
      serviceDiscountBps: 2000, allowedDays: [(today + 1) % 7], benefits: [],
    })
    w.do(subscribe, { clientId: joao, planId, payWith: 'pix' })
    const items = [{ kind: 'service' as const, refId: cut, qty: 1 }]
    expect(() => w.do(checkout, { clientId: joao, barberId: ana, items, useSubscription: true, payments: [] })).toThrow(/vale só .*20% de desconto/)
    const sale = w.do(checkout, { clientId: joao, barberId: ana, items, payments: [{ method: 'pix', amountCents: 4000 }] })
    expect(sale.items[0]).toMatchObject({ coverage: null, grossCents: 5000, discountCents: 1000, netCents: 4000 })
    expect(w.state.subscriptions[0]?.usedVisits).toBe(0)
    // Comissão normal do barbeiro sobre o valor com desconto.
    expect(w.state.commissions.find((c) => c.saleId === sale.id)).toMatchObject({ baseCents: 4000, amountCents: 2000 })
    assertInvariants(w.state)
  })

  it('no dia do plano o corte entra no plano e a barba avulsa ganha o desconto', () => {
    const ctx = setup()
    const { w, ana, beard, cut, joao } = ctx
    const planId = w.do(upsertPlan, {
      name: 'Básico seg–qua', priceCents: 6500, visitsPerCycle: null, serviceIds: [cut], productDiscountBps: 1000,
      serviceDiscountBps: 2000, allowedDays: [weekday(w.today)], benefits: [],
    })
    w.do(subscribe, { clientId: joao, planId, payWith: 'pix' })
    const sale = w.do(checkout, {
      clientId: joao, barberId: ana, useSubscription: true,
      items: [{ kind: 'service', refId: cut, qty: 1 }, { kind: 'service', refId: beard, qty: 1 }],
      payments: [{ method: 'pix', amountCents: 2666 }],
    })
    expect(sale.items.map((i) => [i.coverage, i.netCents])).toEqual([['subscription', 0], [null, 2666]])
    expect(w.state.subscriptions[0]?.usedVisits).toBe(1)
    assertInvariants(w.state)
  })

  it('dias do plano viram texto e dia inválido é recusado', () => {
    const plan = (allowedDays: number[]) => ({ id: 'p', name: 'P', priceCents: 1, visitsPerCycle: null, serviceIds: [], productDiscountBps: 0, benefits: [], active: true, allowedDays })
    expect(planDaysLabel(plan([1, 2, 3]))).toBe('seg a qua')
    expect(planDaysLabel(plan([5, 1, 3]))).toBe('seg, qua e sex')
    expect(planDaysLabel(plan([]))).toBeNull()
    const { w, cut } = setup()
    expect(() => w.do(upsertPlan, { name: 'X', priceCents: 100, visitsPerCycle: null, serviceIds: [cut], productDiscountBps: 0, allowedDays: [7], benefits: [] })).toThrow(/Dias/)
  })

  it('não aceita segunda assinatura ativa', () => {
    const { w, joao, planId } = withPlan()
    w.do(subscribe, { clientId: joao, planId })
    expect(() => w.do(subscribe, { clientId: joao, planId })).toThrow(/já tem/)
  })

  it('renova no vencimento, zera visitas e não duplica ao rodar duas vezes', () => {
    const { w, ana, cut, joao, planId } = withPlan()
    w.do(subscribe, { clientId: joao, planId, payWith: 'pix' })
    w.do(checkout, { clientId: joao, barberId: ana, items: [{ kind: 'service', refId: cut, qty: 1 }], useSubscription: true, payments: [] })
    w.now = '2026-04-02T12:00:00.000Z'
    w.do(runAutomations, undefined)
    w.do(runAutomations, undefined)
    expect(w.state.charges.length).toBe(2)
    expect(w.state.subscriptions[0]).toMatchObject({ periodStart: '2026-04-02', periodEnd: '2026-05-02', usedVisits: 0 })
    expect(w.state.messages.filter((m) => m.kind === 'charge_due').length).toBe(1)
  })

  it('divide a comissão do ciclo pelo trabalho de cada barbeiro, sem perder centavo', () => {
    const { w, ana, beto, cut, joao, planId } = withPlan(3)
    w.do(subscribe, { clientId: joao, planId, payWith: 'pix' })
    const visit = (barberId: string) =>
      w.do(checkout, { clientId: joao, barberId, items: [{ kind: 'service', refId: cut, qty: 1 }], useSubscription: true, payments: [] })
    visit(ana)
    visit(ana)
    visit(beto)
    w.now = '2026-04-02T12:00:00.000Z'
    w.do(runAutomations, undefined)
    w.do(runAutomations, undefined)
    expect(commissionBalance(w.state, ana).pendingCents).toBe(2667)
    expect(commissionBalance(w.state, beto).pendingCents).toBe(1333)
  })

  it('visita estornada não conta para a comissão e devolve o saldo', () => {
    const { w, ana, cut, joao, planId } = withPlan()
    w.do(subscribe, { clientId: joao, planId, payWith: 'pix' })
    const sale = w.do(checkout, { clientId: joao, barberId: ana, items: [{ kind: 'service', refId: cut, qty: 1 }], useSubscription: true, payments: [] })
    w.do(refundSale, { saleId: sale.id, reason: 'Lançado errado' })
    expect(w.state.subscriptions[0]?.usedVisits).toBe(0)
    w.now = '2026-04-02T12:00:00.000Z'
    w.do(runAutomations, undefined)
    expect(commissionBalance(w.state, ana).pendingCents).toBe(0)
  })

  it('inadimplente perde cobertura e volta ao pagar', () => {
    const { w, ana, cut, joao, planId } = withPlan()
    w.do(subscribe, { clientId: joao, planId })
    w.now = '2026-03-08T12:00:00.000Z'
    w.do(runAutomations, undefined)
    expect(w.state.subscriptions[0]?.status).toBe('past_due')
    const visit = { clientId: joao, barberId: ana, items: [{ kind: 'service' as const, refId: cut, qty: 1 }], useSubscription: true, payments: [] }
    expect(() => w.do(checkout, visit)).toThrow(/sem assinatura/)
    w.do(payCharge, { chargeId: w.state.charges[0]!.id, method: 'pix' })
    expect(w.state.subscriptions[0]?.status).toBe('active')
    w.do(checkout, visit)
    expect(() => w.do(payCharge, { chargeId: w.state.charges[0]!.id, method: 'pix' })).toThrow(/em aberto/)
  })

  it('cancelar mantém acesso até o fim do período pago e não gera nova cobrança', () => {
    const { w, joao, planId } = withPlan()
    const sub = w.do(subscribe, { clientId: joao, planId, payWith: 'pix' })
    w.do(cancelSubscription, { id: sub.id })
    expect(w.state.subscriptions[0]?.status).toBe('active')
    expect(subscriptionMetrics(w.state).mrrCents).toBe(0)
    w.now = '2026-04-02T12:00:00.000Z'
    w.do(runAutomations, undefined)
    expect(w.state.subscriptions[0]?.status).toBe('cancelled')
    expect(w.state.charges.length).toBe(1)
  })

  it('assinatura de 31/jan não fica presa no dia 28', () => {
    const { w, joao, planId } = withPlan()
    w.now = '2026-01-31T15:00:00.000Z'
    w.do(subscribe, { clientId: joao, planId, payWith: 'pix' })
    expect(w.state.subscriptions[0]?.periodEnd).toBe('2026-02-28')
    w.now = '2026-02-28T15:00:00.000Z'
    w.do(runAutomations, undefined)
    expect(w.state.subscriptions[0]).toMatchObject({ periodStart: '2026-02-28', periodEnd: '2026-03-31' })
    expect(assertInvariants(w.state)).toEqual([])
  })
})
