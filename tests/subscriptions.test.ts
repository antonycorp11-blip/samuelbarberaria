import { describe, expect, it } from 'vitest'
import { runAutomations } from '../src/domain/automations'
import { dre } from '../src/domain/finance'
import { checkout, refundSale } from '../src/domain/sales'
import { cancelSubscription, payCharge, subscribe, subscriptionMetrics, upsertPlan } from '../src/domain/subscriptions'
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
