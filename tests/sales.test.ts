import { describe, expect, it } from 'vitest'
import { createAppointment } from '../src/domain/agenda'
import { updateSettings } from '../src/domain/catalog'
import { dre } from '../src/domain/finance'
import { upsertCoupon } from '../src/domain/marketing'
import { checkout, quote, refundSale } from '../src/domain/sales'
import { commissionBalance, payCommissions } from '../src/domain/team'
import { toISO } from '../src/domain/time'
import { assertInvariants, setup } from './helpers'

const pix = (amountCents: number) => [{ method: 'pix' as const, amountCents }]

function coupon(w: ReturnType<typeof setup>['w'], over = {}) {
  return w.do(upsertCoupon, {
    code: 'volta10', type: 'percent', value: 1000, minCents: 0, maxUses: null,
    validFrom: '2026-01-01', validTo: '2026-12-31', active: true, ...over,
  })
}

describe('fechamento de atendimento', () => {
  it('gera venda, caixa, comissão, estoque e selo de uma vez', () => {
    const { w, ana, cut, joao, pomade } = setup()
    const a = w.do(createAppointment, {
      clientId: joao, barberId: ana, serviceIds: [cut], start: toISO('2026-03-02', '10:00'),
    })
    const sale = w.do(checkout, {
      appointmentId: a.id, clientId: joao, barberId: ana,
      items: [{ kind: 'service', refId: cut, qty: 1 }, { kind: 'product', refId: pomade, qty: 2 }],
      payments: [{ method: 'credit', amountCents: 13000 }],
    })
    expect(sale.totalCents).toBe(13000)
    expect(sale.payments[0]?.feeCents).toBe(454)
    expect(w.state.commissions.map((c) => c.amountCents).sort((x, y) => x - y)).toEqual([800, 2500])
    expect(w.state.products[0]?.qty).toBe(8)
    expect(w.state.clients.find((c) => c.id === joao)?.stamps).toBe(1)
    expect(w.state.appointments[0]?.status).toBe('completed')
    expect(assertInvariants(w.state)).toEqual([])
  })

  it('não fecha o mesmo atendimento duas vezes', () => {
    const { w, ana, cut, joao } = setup()
    const a = w.do(createAppointment, {
      clientId: joao, barberId: ana, serviceIds: [cut], start: toISO('2026-03-02', '10:00'),
    })
    const input = { appointmentId: a.id, clientId: joao, barberId: ana, items: [{ kind: 'service' as const, refId: cut, qty: 1 }], payments: pix(5000) }
    w.do(checkout, input)
    expect(() => w.do(checkout, input)).toThrow(/já foi fechado/)
    expect(w.state.sales.length).toBe(1)
  })

  it('falha atômica: sem estoque, nada é gravado', () => {
    const { w, ana, cut, joao, pomade } = setup()
    const before = w.state
    expect(() =>
      w.do(checkout, {
        clientId: joao, barberId: ana,
        items: [{ kind: 'service', refId: cut, qty: 1 }, { kind: 'product', refId: pomade, qty: 6 }, { kind: 'product', refId: pomade, qty: 6 }],
        payments: pix(53000),
      }),
    ).toThrow(/Estoque insuficiente/)
    expect(w.state).toBe(before)
  })

  it('exige pagamento exato, inclusive dividido', () => {
    const { w, ana, cut, joao } = setup()
    const items = [{ kind: 'service' as const, refId: cut, qty: 1 }]
    expect(() => w.do(checkout, { clientId: joao, barberId: ana, items, payments: pix(4999) })).toThrow(/soma/)
    const sale = w.do(checkout, {
      clientId: joao, barberId: ana, items,
      payments: [{ method: 'cash', amountCents: 2000 }, { method: 'pix', amountCents: 3000 }],
    })
    expect(sale.payments.length).toBe(2)
  })

  it('rateia desconto sem perder centavo e comissiona sobre o valor líquido', () => {
    const { w, ana, beard, cut, joao } = setup()
    coupon(w)
    const sale = w.do(checkout, {
      clientId: joao, barberId: ana, couponCode: ' volta10 ',
      items: [{ kind: 'service', refId: cut, qty: 1 }, { kind: 'service', refId: beard, qty: 1 }],
      payments: pix(7500),
    })
    expect(sale.discountCents).toBe(833)
    expect(sale.items.reduce((t, i) => t + i.discountCents, 0)).toBe(833)
    expect(w.state.commissions.reduce((t, c) => t + c.amountCents, 0)).toBe(3750)
    expect(w.state.coupons[0]?.uses).toBe(1)
  })

  it('recusa cupom vencido, esgotado ou abaixo do mínimo', () => {
    const { w, ana, cut, joao } = setup()
    const id = coupon(w, { maxUses: 1, minCents: 6000 })
    const items = [{ kind: 'service' as const, refId: cut, qty: 1 }]
    const base = { clientId: joao, barberId: ana, items, couponCode: 'VOLTA10' }
    expect(() => quote(w.state, base, w.ctx())).toThrow(/mínimo/)
    w.do(upsertCoupon, { ...w.state.coupons[0]!, id, minCents: 0 })
    w.do(checkout, { ...base, payments: pix(4500) })
    expect(() => quote(w.state, base, w.ctx())).toThrow(/esgotado/)
    w.do(upsertCoupon, { ...w.state.coupons[0]!, id, maxUses: null, validTo: '2026-02-01', validFrom: '2026-01-01' })
    expect(() => quote(w.state, base, w.ctx())).toThrow(/validade/)
  })

  it('barbeiro não dá desconto manual nem fecha venda de outro', () => {
    const { w, ana, beto, cut, joao } = setup()
    w.actor = { role: 'barber', barberId: ana, name: 'Ana' }
    const items = [{ kind: 'service' as const, refId: cut, qty: 1 }]
    expect(() => w.do(checkout, { clientId: joao, barberId: ana, items, manualDiscountCents: 100, payments: pix(4900) })).toThrow(/dono/)
    expect(() => w.do(checkout, { clientId: joao, barberId: beto, items, payments: pix(5000) })).toThrow(/própria agenda/)
  })
})

describe('fidelidade', () => {
  it('completa o cartão, resgata e a casa banca a comissão', () => {
    const { w, ana, cut, joao } = setup()
    w.do(updateSettings, { loyaltyStampsRequired: 2 })
    const items = [{ kind: 'service' as const, refId: cut, qty: 1 }]
    const base = { clientId: joao, barberId: ana, items }
    w.do(checkout, { ...base, payments: pix(5000) })
    w.do(checkout, { ...base, payments: pix(5000) })
    const client = () => w.state.clients.find((c) => c.id === joao)!
    expect(client()).toMatchObject({ stamps: 0, rewards: 1 })
    const free = w.do(checkout, { ...base, useReward: true, payments: [] })
    expect(free.totalCents).toBe(0)
    expect(client()).toMatchObject({ stamps: 0, rewards: 0 })
    expect(commissionBalance(w.state, ana).pendingCents).toBe(7500)
  })

  it('estorno desfaz selo e recompensa ganha', () => {
    const { w, ana, cut, joao } = setup()
    w.do(updateSettings, { loyaltyStampsRequired: 2 })
    const base = { clientId: joao, barberId: ana, items: [{ kind: 'service' as const, refId: cut, qty: 1 }] }
    w.do(checkout, { ...base, payments: pix(5000) })
    const second = w.do(checkout, { ...base, payments: pix(5000) })
    w.do(refundSale, { saleId: second.id, reason: 'Teste' })
    expect(w.state.clients.find((c) => c.id === joao)).toMatchObject({ stamps: 1, rewards: 0 })
  })
})

describe('estorno', () => {
  function sold() {
    const ctx = setup()
    const sale = ctx.w.do(checkout, {
      clientId: ctx.joao, barberId: ctx.ana,
      items: [{ kind: 'service', refId: ctx.cut, qty: 1 }, { kind: 'product', refId: ctx.pomade, qty: 1 }],
      payments: [{ method: 'credit', amountCents: 9000 }],
    })
    return { ...ctx, sale }
  }

  it('reverte caixa, taxa, comissão e estoque', () => {
    const { w, ana, sale } = sold()
    w.do(refundSale, { saleId: sale.id, reason: 'Cliente desistiu' })
    expect(commissionBalance(w.state, ana).pendingCents).toBe(0)
    expect(w.state.products[0]?.qty).toBe(10)
    expect(assertInvariants(w.state)).toEqual([])
    expect(() => w.do(refundSale, { saleId: sale.id, reason: 'de novo' })).toThrow(/já foi estornada/)
  })

  it('comissão já paga vira abatimento no próximo pagamento', () => {
    const { w, ana, cut, joao, sale } = sold()
    w.do(payCommissions, { barberId: ana, method: 'pix' })
    w.do(refundSale, { saleId: sale.id, reason: 'Erro' })
    expect(commissionBalance(w.state, ana).pendingCents).toBe(-2900)
    expect(() => w.do(payCommissions, { barberId: ana, method: 'pix' })).toThrow(/saldo/)
    w.do(checkout, { clientId: joao, barberId: ana, items: [{ kind: 'service', refId: cut, qty: 2 }], payments: pix(10000) })
    expect(w.do(payCommissions, { barberId: ana, method: 'pix' }).amountCents).toBe(2100)
    expect(assertInvariants(w.state)).toEqual([])
  })

  it('estorno no mês seguinte não reescreve o mês fechado', () => {
    const { w, sale } = sold()
    const march = dre(w.state, '2026-03-01', '2026-03-31')
    w.now = '2026-04-02T12:00:00.000Z'
    w.do(refundSale, { saleId: sale.id, reason: 'Devolução' })
    expect(dre(w.state, '2026-03-01', '2026-03-31')).toEqual(march)
    const april = dre(w.state, '2026-04-01', '2026-04-30')
    expect(april.refunds).toBe(9000)
    expect(april.commissions).toBe(-2900)
    expect(april.cogs).toBe(-1500)
    expect(april.paymentFees).toBe(-314)
  })

  it('somente o dono estorna', () => {
    const { w, ana, sale } = sold()
    w.actor = { role: 'barber', barberId: ana, name: 'Ana' }
    expect(() => w.do(refundSale, { saleId: sale.id, reason: 'x' })).toThrow(/dono/)
  })
})
