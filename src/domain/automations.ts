import { inactiveClients } from './clients'
import { base, type Command } from './engine'
import { appointmentMessage, enqueue } from './messages'
import { isLowStock } from './stock'
import { closeChargeCommission, markOverdue, renewIfDue } from './subscriptions'
import { addMinutes, dateKey } from './time'

/**
 * Rotina periódica. Hoje roda ao abrir o app; depois vira um cron no Supabase.
 * Todas as etapas são idempotentes: rodar duas vezes não duplica nada.
 */
export const runAutomations: Command<void, { messages: number }> = (d, _i, ctx) => {
  const s = base(d)
  const today = dateKey(ctx.now)
  const seen = new Set(s.messages.map((m) => m.dedupeKey))
  const before = seen.size
  const shop = s.settings.shopName
  const clients = new Map(s.clients.map((c) => [c.id, c]))
  const barbers = new Map(s.barbers.map((b) => [b.id, b]))

  const in24h = addMinutes(ctx.now, 24 * 60)
  const in2h = addMinutes(ctx.now, 120)
  for (const a of s.appointments) {
    if (!['scheduled', 'confirmed'].includes(a.status) || a.start < ctx.now || a.start > in24h) continue
    const client = clients.get(a.clientId)
    const barber = barbers.get(a.barberId)
    if (!client || !barber) continue
    const kind = a.start <= in2h ? 'reminder_2h' : 'reminder_24h'
    enqueue(d, ctx, appointmentMessage(shop, kind, client, a, barber.name), seen)
  }

  for (const c of s.clients) {
    if (c.birthday === today.slice(5) && c.marketingOptIn) {
      enqueue(d, ctx, {
        to: c.email, clientId: c.id, kind: 'birthday', subject: `Feliz aniversário, ${c.name.split(' ')[0]}!`,
        body: `A ${shop} deseja um ótimo dia para você.`, dedupeKey: `birthday:${c.id}:${today.slice(0, 4)}`,
      }, seen)
    }
  }

  for (const { client, daysAway } of inactiveClients(s, ctx.now)) {
    if (!client.marketingOptIn) continue
    enqueue(d, ctx, {
      to: client.email, clientId: client.id, kind: 'recovery', subject: 'Faz tempo que não te vemos',
      body: `${client.name.split(' ')[0]}, já são ${daysAway} dias desde o último corte. Bora marcar?`,
      dedupeKey: `recovery:${client.id}:${today.slice(0, 7)}`,
    }, seen)
  }

  for (const sub of d.subscriptions) renewIfDue(d, ctx, sub, today)
  markOverdue(d, ctx, today, seen)
  for (const charge of d.charges) closeChargeCommission(d, ctx, charge, today)

  for (const p of s.products) {
    if (!isLowStock(p)) continue
    enqueue(d, ctx, {
      channel: 'push', to: 'equipe', clientId: null, kind: 'low_stock', subject: 'Estoque baixo',
      body: `${p.name}: restam ${p.qty}.`, dedupeKey: `low_stock:${p.id}:${today}`,
    }, seen)
  }

  for (const w of d.waitlist) {
    if (['waiting', 'notified'].includes(w.status) && w.date < today) w.status = 'expired'
  }
  return { messages: seen.size - before }
}
