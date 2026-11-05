import { audit, base, must, requireOwner, type Command } from './engine'
import { fail } from './errors'
import { dateKey } from './time'
import type { Barber, Bps, DateKey, DbState, ID, PaymentMethod, Payout } from './types'

const validBps = (n: Bps) => Number.isInteger(n) && n >= 0 && n <= 10000

export const upsertBarber: Command<Omit<Barber, 'id' | 'active'> & { id?: ID; active?: boolean }, ID> = (d, i, ctx) => {
  requireOwner(ctx)
  if (!i.name.trim()) fail('bad_name', 'Informe o nome.')
  if (!validBps(i.serviceBps) || !validBps(i.productBps)) fail('bad_bps', 'Comissão deve ficar entre 0% e 100%.')
  if (Boolean(i.breakStart) !== Boolean(i.breakEnd)) fail('bad_break', 'Informe início e fim do intervalo.')
  if (i.breakStart && i.breakEnd && i.breakEnd <= i.breakStart) fail('bad_break', 'O intervalo precisa terminar depois de começar.')
  const current = i.id ? must(d.barbers.find((b) => b.id === i.id), 'Profissional') : null
  if (current) {
    if (i.active === false && current.active) {
      const future = base(d).appointments.some(
        (a) => a.barberId === current.id && ['scheduled', 'confirmed'].includes(a.status) && a.start > ctx.now,
      )
      if (future) fail('has_future', 'Remarque os atendimentos futuros antes de desativar.')
    }
    Object.assign(current, { ...i, name: i.name.trim(), active: i.active ?? current.active })
    audit(d, ctx, 'equipe.editar', current.id)
    return current.id
  }
  const id = ctx.id()
  d.barbers.push({ ...i, id, name: i.name.trim(), active: true })
  audit(d, ctx, 'equipe.criar', id)
  return id
}

export function commissionBalance(s: DbState, barberId: ID) {
  const list = s.commissions.filter((c) => c.barberId === barberId)
  const sum = (status: 'pending' | 'paid') =>
    list.filter((c) => c.status === status).reduce((t, c) => t + c.amountCents, 0)
  return { pendingCents: sum('pending'), paidCents: sum('paid') }
}

/** Paga tudo o que está pendente até a data. Estornos pendentes já abatem aqui. */
export const payCommissions: Command<{ barberId: ID; method: PaymentMethod; upTo?: DateKey }, Payout> = (d, i, ctx) => {
  requireOwner(ctx)
  const barber = must(base(d).barbers.find((b) => b.id === i.barberId), 'Profissional')
  const pending = d.commissions.filter(
    (c) => c.barberId === i.barberId && c.status === 'pending' && (!i.upTo || dateKey(c.at) <= i.upTo),
  )
  const amountCents = pending.reduce((t, c) => t + c.amountCents, 0)
  if (amountCents <= 0) fail('nothing_to_pay', 'Não há saldo de comissão a pagar.')
  const payout: Payout = { id: ctx.id(), barberId: i.barberId, amountCents, method: i.method, at: ctx.now }
  d.payouts.push(payout)
  for (const c of pending) {
    c.status = 'paid'
    c.payoutId = payout.id
  }
  d.transactions.push({
    id: ctx.id(), type: 'out', category: 'comissao', amountCents, method: i.method, at: ctx.now,
    description: `Comissão: ${barber.name}`, saleId: null, reversalOf: null, reversed: false,
  })
  audit(d, ctx, 'comissao.pagar', payout.id, `valor=${amountCents}`)
  return payout
}
