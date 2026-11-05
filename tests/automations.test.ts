import { describe, expect, it } from 'vitest'
import { createAppointment } from '../src/domain/agenda'
import { runAutomations } from '../src/domain/automations'
import { clientStats, dueForReturn, inactiveClients, upsertClient } from '../src/domain/clients'
import { audienceOf, sendCampaign } from '../src/domain/marketing'
import { occupancy, returnRate } from '../src/domain/reports'
import { checkout } from '../src/domain/sales'
import { toISO } from '../src/domain/time'
import { setup } from './helpers'

const cutSale = (ctx: ReturnType<typeof setup>, clientId: string) =>
  ctx.w.do(checkout, { clientId, barberId: ctx.ana, items: [{ kind: 'service', refId: ctx.cut, qty: 1 }], payments: [{ method: 'pix', amountCents: 5000 }] })

describe('automações', () => {
  it('manda lembretes de 24h e 2h, uma vez cada', () => {
    const { w, ana, cut, joao } = setup()
    w.do(createAppointment, { clientId: joao, barberId: ana, serviceIds: [cut], start: toISO('2026-03-03', '09:00') })
    const count = (kind: string) => w.state.messages.filter((m) => m.kind === kind).length
    w.do(runAutomations, undefined)
    w.do(runAutomations, undefined)
    expect(count('reminder_24h')).toBe(1)
    w.now = toISO('2026-03-03', '07:30')
    w.do(runAutomations, undefined)
    expect(count('reminder_2h')).toBe(1)
  })

  it('aniversário e recuperação respeitam o consentimento', () => {
    const ctx = setup()
    const { w, joao, maria } = ctx
    const base = w.state.clients.find((c) => c.id === joao)!
    w.do(upsertClient, { ...base, birthday: '04-20' })
    const m = w.state.clients.find((c) => c.id === maria)!
    w.do(upsertClient, { ...m, birthday: '04-20', marketingOptIn: false })
    cutSale(ctx, joao)
    cutSale(ctx, maria)
    w.now = toISO('2026-04-20', '10:00')
    w.do(runAutomations, undefined)
    expect(w.state.messages.filter((x) => x.kind === 'birthday').map((x) => x.to)).toEqual(['joao@teste.com'])
    expect(w.state.messages.filter((x) => x.kind === 'recovery').map((x) => x.to)).toEqual(['joao@teste.com'])
  })

  it('inativo com horário marcado não entra na recuperação', () => {
    const ctx = setup()
    const { w, ana, cut, joao } = ctx
    cutSale(ctx, joao)
    w.now = toISO('2026-04-20', '10:00')
    expect(inactiveClients(w.state, w.now).length).toBe(1)
    w.do(createAppointment, { clientId: joao, barberId: ana, serviceIds: [cut], start: toISO('2026-04-21', '10:00') })
    expect(inactiveClients(w.state, w.now).length).toBe(0)
  })

  it('avisa estoque baixo uma vez por dia', () => {
    const { w, pomade } = setup()
    w.state = { ...w.state, products: w.state.products.map((p) => (p.id === pomade ? { ...p, qty: 2 } : p)) }
    w.do(runAutomations, undefined)
    w.do(runAutomations, undefined)
    expect(w.state.messages.filter((m) => m.kind === 'low_stock').length).toBe(1)
  })

  it('campanha só alcança quem aceitou e substitui o nome', () => {
    const { w, joao, maria } = setup()
    const m = w.state.clients.find((c) => c.id === maria)!
    w.do(upsertClient, { ...m, marketingOptIn: false })
    expect(audienceOf(w.state, 'all', w.now).map((c) => c.id)).toEqual([joao])
    const c = w.do(sendCampaign, { name: 'Março', audience: 'all', subject: 'Oi', body: 'Fala {nome}!' })
    expect(c.recipients).toBe(1)
    expect(w.state.messages.at(-1)?.body).toBe('Fala João!')
  })
})

describe('indicadores de clientes', () => {
  it('calcula frequência e previsão de retorno', () => {
    const ctx = setup()
    const { w, joao } = ctx
    cutSale(ctx, joao)
    w.now = toISO('2026-03-22', '10:00')
    cutSale(ctx, joao)
    const stats = clientStats(w.state, joao, w.now)
    expect(stats).toMatchObject({ visits: 2, avgIntervalDays: 20, expectedReturn: '2026-04-11', spentCents: 10000 })
    w.now = toISO('2026-04-12', '10:00')
    expect(dueForReturn(w.state, w.now).map((x) => x.client.id)).toEqual([joao])
  })

  it('taxa de retorno ignora quem ainda não teve tempo de voltar', () => {
    const ctx = setup()
    const { w, joao, maria } = ctx
    cutSale(ctx, joao)
    w.now = toISO('2026-03-20', '10:00')
    cutSale(ctx, joao)
    cutSale(ctx, maria)
    expect(returnRate(w.state, '2026-03-01', '2026-03-31', w.today)).toMatchObject({ eligible: 1, returned: 1, rateBps: 10000 })
  })

  it('ocupação considera atendimento sobre capacidade', () => {
    const { w, ana, cut, joao } = setup()
    w.do(createAppointment, { clientId: joao, barberId: ana, serviceIds: [cut], start: toISO('2026-03-02', '10:00') })
    expect(occupancy(w.state, '2026-03-02', '2026-03-02', ana)).toBe(Math.round((30 / 660) * 10000))
  })
})
