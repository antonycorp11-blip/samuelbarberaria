import { run, SYSTEM_ACTOR, type Command, type Ctx } from '../src/domain/engine'
import { upsertService } from '../src/domain/catalog'
import { upsertClient } from '../src/domain/clients'
import { stockIn, upsertProduct } from '../src/domain/stock'
import { upsertBarber } from '../src/domain/team'
import { emptyState, type Actor, type DbState } from '../src/domain/types'
import { dateKey } from '../src/domain/time'

/** Banco de testes com relógio controlado. 02/03/2026 é uma segunda-feira, 09:00 em São Paulo. */
export class World {
  state: DbState = emptyState()
  now = '2026-03-02T12:00:00.000Z'
  actor: Actor = SYSTEM_ACTOR
  private seq = 0

  ctx(): Ctx {
    return { now: this.now, actor: this.actor, id: () => `id${++this.seq}` }
  }

  do<I, R>(cmd: Command<I, R>, input: I): R {
    const { state, result } = run(this.state, cmd, input, this.ctx())
    this.state = state
    return result
  }

  get today() {
    return dateKey(this.now)
  }
}

export function setup() {
  const w = new World()
  const barber = { email: '', phone: '', daysOff: [0], breakStart: null, breakEnd: null }
  const ana = w.do(upsertBarber, { ...barber, name: 'Ana', serviceBps: 5000, productBps: 1000 })
  const beto = w.do(upsertBarber, { ...barber, name: 'Beto', serviceBps: 4000, productBps: 1000 })
  const cut = w.do(upsertService, { name: 'Corte', priceCents: 5000, durationMin: 30 })
  const beard = w.do(upsertService, { name: 'Barba', priceCents: 3333, durationMin: 30 })
  const client = { birthday: null, notes: '', marketingOptIn: true }
  const joao = w.do(upsertClient, { ...client, name: 'João Silva', phone: '11999990001', email: 'joao@teste.com' })
  const maria = w.do(upsertClient, { ...client, name: 'Maria Souza', phone: '11999990002', email: 'maria@teste.com' })
  const pomade = w.do(upsertProduct, { name: 'Pomada', salePriceCents: 4000, minQty: 2 })
  w.do(stockIn, { productId: pomade, qty: 10, unitCostCents: 1500 })
  return { w, ana, beto, cut, beard, joao, maria, pomade }
}

/** Invariantes que precisam valer em qualquer momento da vida do sistema. */
export function assertInvariants(s: DbState) {
  const problems: string[] = []
  for (const p of s.products) {
    const moved = s.stockMovements.filter((m) => m.productId === p.id).reduce((t, m) => t + m.qty, 0)
    if (moved !== p.qty) problems.push(`estoque de ${p.name}: ${p.qty} != movimentos ${moved}`)
    if (p.qty < 0) problems.push(`estoque negativo: ${p.name}`)
  }
  for (const sale of s.sales) {
    const paid = sale.payments.reduce((t, p) => t + p.amountCents, 0)
    if (paid !== sale.totalCents) problems.push(`venda ${sale.id}: pagamentos != total`)
    const net = sale.items.reduce((t, i) => t + i.netCents, 0)
    if (net !== sale.totalCents) problems.push(`venda ${sale.id}: itens != total`)
    if (sale.items.some((i) => i.netCents < 0)) problems.push(`venda ${sale.id}: item negativo`)
    const cash = s.transactions
      .filter((t) => t.saleId === sale.id && (t.category === 'venda' || t.category === 'estorno'))
      .reduce((t, x) => t + (x.type === 'in' ? x.amountCents : -x.amountCents), 0)
    if (cash !== (sale.status === 'paid' ? sale.totalCents : 0)) problems.push(`venda ${sale.id}: caixa ${cash}`)
    const comm = s.commissions.filter((c) => c.saleId === sale.id).reduce((t, c) => t + c.amountCents, 0)
    if (sale.status === 'refunded' && comm !== 0) problems.push(`venda ${sale.id}: comissão não zerou (${comm})`)
  }
  const active = s.appointments.filter((a) => ['scheduled', 'confirmed', 'in_progress', 'completed'].includes(a.status))
  for (const a of active) {
    for (const b of active) {
      if (a.id < b.id && a.barberId === b.barberId && a.start < b.end && b.start < a.end) {
        problems.push(`agenda sobreposta: ${a.id} e ${b.id}`)
      }
    }
  }
  for (const a of s.appointments) {
    if (a.status === 'completed' && !a.saleId) problems.push(`atendimento ${a.id} concluído sem venda`)
  }
  for (const c of s.clients) {
    if (c.stamps < 0 || c.rewards < 0) problems.push(`fidelidade negativa: ${c.name}`)
  }
  for (const payout of s.payouts) {
    const sum = s.commissions.filter((c) => c.payoutId === payout.id).reduce((t, c) => t + c.amountCents, 0)
    if (sum !== payout.amountCents) problems.push(`pagamento ${payout.id}: ${sum} != ${payout.amountCents}`)
  }
  const keys = s.messages.map((m) => m.dedupeKey)
  if (new Set(keys).size !== keys.length) problems.push('mensagem duplicada na fila')
  return problems
}
