import { describe, expect, it } from 'vitest'
import { addTransaction, averageTicket, balanceByMethod, cashFlow, dre, reverseTransaction } from '../src/domain/finance'
import { checkout } from '../src/domain/sales'
import { stockAdjust, stockIn, stockOut, stockTurnover, weightedAverage } from '../src/domain/stock'
import { payCommissions } from '../src/domain/team'
import { setup } from './helpers'

describe('financeiro', () => {
  it('fecha o DRE de ponta a ponta', () => {
    const { w, ana, cut, joao, pomade } = setup()
    w.do(checkout, {
      clientId: joao, barberId: ana,
      items: [{ kind: 'service', refId: cut, qty: 1 }, { kind: 'product', refId: pomade, qty: 1 }],
      payments: [{ method: 'credit', amountCents: 9000 }],
    })
    w.do(addTransaction, { type: 'out', category: 'aluguel', amountCents: 1000, method: 'pix', description: '' })
    const r = dre(w.state, w.today, w.today)
    expect(r).toMatchObject({
      serviceRevenue: 5000, productRevenue: 4000, grossRevenue: 9000, paymentFees: 314, netRevenue: 8686,
      cogs: 1500, commissions: 2900, contributionMargin: 4286, totalExpenses: 1000, netProfit: 3286,
    })
  })

  it('pagar comissão e comprar estoque mexem no caixa, não no lucro', () => {
    const { w, ana, cut, joao, pomade } = setup()
    w.do(checkout, { clientId: joao, barberId: ana, items: [{ kind: 'service', refId: cut, qty: 1 }], payments: [{ method: 'pix', amountCents: 5000 }] })
    const before = dre(w.state, w.today, w.today).netProfit
    w.do(payCommissions, { barberId: ana, method: 'pix' })
    w.do(stockIn, { productId: pomade, qty: 5, unitCostCents: 1000, method: 'pix' })
    expect(dre(w.state, w.today, w.today).netProfit).toBe(before)
    const day = cashFlow(w.state, w.today, w.today)[0]
    expect(day).toMatchObject({ opening: 0, inflow: 5000, outflow: 7500, closing: -2500 })
  })

  it('saldo de abertura vem do dia anterior', () => {
    const { w } = setup()
    w.do(addTransaction, { type: 'in', category: 'outras_receitas', amountCents: 500, method: 'cash', description: '' })
    w.now = '2026-03-03T12:00:00.000Z'
    expect(cashFlow(w.state, w.today, w.today)[0]?.opening).toBe(500)
  })

  it('corrige lançamento com oposto, uma vez só, e nunca lançamento automático', () => {
    const { w, ana, cut, joao } = setup()
    const id = w.do(addTransaction, { type: 'out', category: 'marketing', amountCents: 800, method: 'pix', description: 'Panfleto' })
    w.do(reverseTransaction, { id })
    expect(dre(w.state, w.today, w.today).totalExpenses).toBe(0)
    expect(w.state.transactions.length).toBe(2)
    expect(() => w.do(reverseTransaction, { id })).toThrow(/já foi corrigido/)
    w.do(checkout, { clientId: joao, barberId: ana, items: [{ kind: 'service', refId: cut, qty: 1 }], payments: [{ method: 'pix', amountCents: 5000 }] })
    const auto = w.state.transactions.find((t) => t.category === 'venda')!
    expect(() => w.do(reverseTransaction, { id: auto.id })).toThrow(/estorno/)
  })

  it('não aceita valor zerado nem categoria do sistema', () => {
    const { w } = setup()
    expect(() => w.do(addTransaction, { type: 'out', category: 'aluguel', amountCents: 0, method: 'pix', description: '' })).toThrow()
    expect(() => w.do(addTransaction, { type: 'out', category: 'comissao', amountCents: 10, method: 'pix', description: '' })).toThrow(/Categoria/)
  })

  it('ticket médio ignora visita coberta e separa saldo por forma de pagamento', () => {
    const { w, ana, cut, joao } = setup()
    const items = [{ kind: 'service' as const, refId: cut, qty: 1 }]
    w.do(checkout, { clientId: joao, barberId: ana, items, payments: [{ method: 'pix', amountCents: 5000 }] })
    w.do(checkout, { clientId: joao, barberId: ana, items: [{ kind: 'service', refId: cut, qty: 2 }], payments: [{ method: 'cash', amountCents: 10000 }] })
    expect(averageTicket(w.state, w.today, w.today)).toBe(7500)
    expect(balanceByMethod(w.state, w.today, w.today)).toMatchObject({ pix: 5000, cash: 10000 })
  })
})

describe('estoque', () => {
  it('calcula custo médio ponderado', () => {
    expect(weightedAverage(10, 1500, 10, 2500)).toBe(2000)
    const { w, pomade } = setup()
    w.do(stockIn, { productId: pomade, qty: 10, unitCostCents: 2500 })
    expect(w.state.products[0]).toMatchObject({ qty: 20, avgCostCents: 2000 })
  })

  it('saída e ajuste nunca deixam negativo e entram no custo', () => {
    const { w, pomade } = setup()
    expect(() => w.do(stockOut, { productId: pomade, qty: 11, note: '' })).toThrow(/insuficiente/)
    w.do(stockOut, { productId: pomade, qty: 1, note: 'Uso interno' })
    w.do(stockAdjust, { productId: pomade, countedQty: 7, note: 'Inventário' })
    expect(w.state.products[0]?.qty).toBe(7)
    expect(dre(w.state, w.today, w.today).cogs).toBe(4500)
  })

  it('mede giro e cobertura', () => {
    const { w, ana, joao, pomade } = setup()
    w.do(checkout, { clientId: joao, barberId: ana, items: [{ kind: 'product', refId: pomade, qty: 3 }], payments: [{ method: 'pix', amountCents: 12000 }] })
    const row = stockTurnover(w.state, w.today)[0]
    expect(row).toMatchObject({ soldQty: 3, coverDays: 70 })
  })
})
