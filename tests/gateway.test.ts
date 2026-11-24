import { describe, expect, it } from 'vitest'
import { runAutomations } from '../src/domain/automations'
import { dre } from '../src/domain/finance'
import { linkGateway, recordGatewayPayment, recordGatewayRefund, startOnlineSubscription, syncGatewayStatus } from '../src/domain/gateway'
import { checkout } from '../src/domain/sales'
import { cancelSubscription, subscriptionMetrics, upsertPlan } from '../src/domain/subscriptions'
import { assertInvariants, setup } from './helpers'

function online() {
  const ctx = setup()
  const planId = ctx.w.do(upsertPlan, { name: 'Clube', priceCents: 12900, visitsPerCycle: 4, serviceIds: [ctx.cut], productDiscountBps: 1000, benefits: [] })
  const start = ctx.w.do(startOnlineSubscription, { name: 'Carlos Novo', phone: '(11) 96666-5555', email: 'Carlos@Teste.com', birthDate: '1990-03-15', planId })
  ctx.w.do(linkGateway, { subscriptionId: start.subscriptionId, checkoutId: 'chk-1' })
  const sub = () => ctx.w.state.subscriptions.find((s) => s.id === start.subscriptionId)!
  const pay = (paymentId: string, amountCents = 12900) => ctx.w.do(recordGatewayPayment, { externalId: 'sub_1', checkoutId: 'chk-1', paymentId, amountCents })
  return { ...ctx, planId, start, sub, pay }
}

describe('clube com cartão automático', () => {
  it('cadastro inicia pendente, sem benefício e sem entrar na receita', () => {
    const { w, start, sub } = online()
    expect(start).toMatchObject({ amountCents: 12900, email: 'carlos@teste.com', planName: 'Clube' })
    expect(sub().status).toBe('pending')
    expect(subscriptionMetrics(w.state).activeCount).toBe(0)
    expect(w.state.charges.length).toBe(0)
    expect(w.state.clients.find((c) => c.phone === '11966665555')?.name).toBe('Carlos Novo')
  })

  it('primeiro pagamento ativa, lança no caixa e avisa cliente e equipe', () => {
    const { w, sub, pay } = online()
    expect(pay('pay-1')).toBe('activated')
    expect(sub()).toMatchObject({ status: 'active', periodStart: '2026-03-02', periodEnd: '2026-04-02' })
    expect(w.state.charges[0]).toMatchObject({ status: 'paid', method: 'credit', gatewayPaymentId: 'pay-1', amountCents: 12900 })
    expect(w.state.transactions.filter((t) => t.category === 'assinatura').map((t) => t.amountCents)).toEqual([12900])
    expect(w.state.messages.map((m) => m.kind)).toEqual(expect.arrayContaining(['club_welcome', 'new_subscriber']))
  })

  it('o mesmo aviso chegando duas vezes não conta em dobro', () => {
    const { w, pay } = online()
    pay('pay-1')
    expect(pay('pay-1')).toBe('duplicate')
    expect(w.state.charges.length).toBe(1)
    expect(w.state.transactions.filter((t) => t.category === 'assinatura').length).toBe(1)
  })

  it('mensalidade seguinte quita a cobrança da renovação', () => {
    const { w, sub, pay } = online()
    pay('pay-1')
    w.now = '2026-04-02T12:00:00.000Z'
    w.do(runAutomations, undefined)
    expect(w.state.charges.filter((c) => c.status === 'pending').length).toBe(1)
    expect(pay('pay-2')).toBe('paid')
    expect(w.state.charges.every((c) => c.status === 'paid')).toBe(true)
    expect(sub().periodEnd).toBe('2026-05-02')
    expect(w.state.messages.some((m) => m.kind === 'charge_due')).toBe(false)
  })

  it('cartão pago antes da renovação não gera cobrança dupla', () => {
    const { w, pay } = online()
    pay('pay-1')
    w.now = '2026-04-01T12:00:00.000Z'
    pay('pay-2')
    w.now = '2026-04-02T12:00:00.000Z'
    w.do(runAutomations, undefined)
    w.do(runAutomations, undefined)
    expect(w.state.charges.map((c) => [c.periodStart, c.status])).toEqual([['2026-03-02', 'paid'], ['2026-04-02', 'paid']])
  })

  it('cartão recusado deixa em atraso e o pagamento depois reativa', () => {
    const { w, sub, pay } = online()
    pay('pay-1')
    w.now = '2026-04-10T12:00:00.000Z'
    w.do(runAutomations, undefined)
    expect(sub().status).toBe('past_due')
    pay('pay-2')
    expect(sub().status).toBe('active')
  })

  it('assinante pendente ou em atraso não usa o plano', () => {
    const { w, ana, cut, start } = online()
    const client = w.state.subscriptions.find((s) => s.id === start.subscriptionId)!.clientId
    expect(() => w.do(checkout, { clientId: client, barberId: ana, items: [{ kind: 'service', refId: cut, qty: 1 }], useSubscription: true, payments: [] })).toThrow(/sem assinatura/)
  })

  it('removida no Asaas mantém o mês pago e não renova', () => {
    const { w, sub, pay } = online()
    pay('pay-1')
    w.do(syncGatewayStatus, { externalId: 'sub_1', status: 'cancelled' })
    expect(sub()).toMatchObject({ status: 'active', autoRenew: false })
    w.now = '2026-04-02T12:00:00.000Z'
    w.do(runAutomations, undefined)
    expect(sub().status).toBe('cancelled')
  })

  it('quem desistiu no pagamento pode tentar de novo, e o abandono expira', () => {
    const { w, planId, sub } = online()
    const again = w.do(startOnlineSubscription, { name: 'Carlos Novo', phone: '11966665555', email: 'carlos@teste.com', birthDate: '1990-03-15', planId })
    expect(sub().status).toBe('cancelled')
    w.now = '2026-03-06T12:00:00.000Z'
    w.do(runAutomations, undefined)
    expect(w.state.subscriptions.find((s) => s.id === again.subscriptionId)?.status).toBe('cancelled')
  })

  it('guarda o aniversário e recusa data de nascimento inválida', () => {
    const { w, planId } = online()
    expect(w.state.clients.find((c) => c.phone === '11966665555')?.birthday).toBe('03-15')
    const tryDate = (birthDate: string) => () => w.do(startOnlineSubscription, { name: 'Bia', phone: '11944443333', email: 'bia@teste.com', birthDate, planId })
    for (const bad of ['', '15/03/1990', '1990-02-30', '1899-12-31', '2026-03-03']) expect(tryDate(bad)).toThrow(/data de nascimento/)
  })

  it('assinante ativo não assina de novo', () => {
    const { w, planId, pay } = online()
    pay('pay-1')
    expect(() => w.do(startOnlineSubscription, { name: 'Carlos', phone: '11966665555', email: 'c@teste.com', birthDate: '1990-03-15', planId })).toThrow(/já é assinante/)
  })

  it('pagamento de assinatura desconhecida é ignorado sem quebrar', () => {
    const { w } = online()
    expect(w.do(recordGatewayPayment, { externalId: 'outro', paymentId: 'x', amountCents: 100 })).toBe('unknown')
    expect(w.state.charges.length).toBe(0)
  })

  it('o checkout acha o cliente e grava a assinatura do Asaas', () => {
    const ctx = setup()
    const planId = ctx.w.do(upsertPlan, { name: 'Clube', priceCents: 5000, visitsPerCycle: null, serviceIds: [ctx.cut], productDiscountBps: 0, benefits: [] })
    const start = ctx.w.do(startOnlineSubscription, { name: 'Ana Lima', phone: '11955554444', email: 'ana@teste.com', birthDate: '1985-12-01', planId })
    expect(ctx.w.do(recordGatewayPayment, { externalId: 'sub_x', subscriptionId: start.subscriptionId, paymentId: 'p', amountCents: 5000 })).toBe('activated')
    expect(ctx.w.state.subscriptions[0]?.gateway?.externalId).toBe('sub_x')
  })

  it('mantém as invariantes de caixa e comissão ao longo de meses', () => {
    const { w, ana, cut, start, pay } = online()
    const client = w.state.subscriptions.find((s) => s.id === start.subscriptionId)!.clientId
    pay('pay-1')
    w.do(checkout, { clientId: client, barberId: ana, items: [{ kind: 'service', refId: cut, qty: 1 }], useSubscription: true, payments: [] })
    w.now = '2026-04-02T12:00:00.000Z'
    w.do(runAutomations, undefined)
    pay('pay-2')
    expect(w.state.commissions.some((c) => c.kind === 'subscription')).toBe(true)
    expect(assertInvariants(w.state)).toEqual([])
  })

  it('estorno no Asaas tira a mensalidade da receita uma vez só', () => {
    const { w, pay } = online()
    pay('pay-1')
    expect(w.do(recordGatewayRefund, { paymentId: 'pay-1' })).toBe(true)
    expect(w.do(recordGatewayRefund, { paymentId: 'pay-1' })).toBe(false)
    expect(dre(w.state, w.today, w.today).subscriptionRevenue).toBe(0)
  })

  it('cancelar pelo app deixa a assinatura sem renovar', () => {
    const { w, sub, pay } = online()
    pay('pay-1')
    w.do(cancelSubscription, { id: sub().id })
    expect(sub().autoRenew).toBe(false)
  })
})
