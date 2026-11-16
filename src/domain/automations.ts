import { inactiveClients } from './clients'
import { expireAbandoned } from './gateway'
import { base, type Command } from './engine'
import { appointmentMessage, enqueue } from './messages'
import { isLowStock } from './stock'
import { closeChargeCommission, markOverdue, renewIfDue } from './subscriptions'
import { addDays, addMinutes, dateKey } from './time'

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

  const in24h = addMinutes(ctx.now, 24 * 60)
  const in2h = addMinutes(ctx.now, 120)
  for (const a of s.appointments) {
    if (!['scheduled', 'confirmed'].includes(a.status) || a.start < ctx.now || a.start > in24h) continue
    const client = clients.get(a.clientId)
    if (!client) continue
    const kind = a.start <= in2h ? 'reminder_2h' : 'reminder_24h'
    enqueue(d, ctx, appointmentMessage(s, kind, client, a), seen)
  }

  for (const c of s.clients) {
    if (c.birthday === today.slice(5) && c.marketingOptIn) {
      enqueue(d, ctx, {
        to: c.email, clientId: c.id, kind: 'birthday', subject: `Feliz aniversário, ${c.name.split(' ')[0]}! 🎉`,
        body: `Hoje o dia é seu! A ${shop} deseja muita saúde e um ano incrível.\nQue tal comemorar com o visual em dia?`, dedupeKey: `birthday:${c.id}:${today.slice(0, 4)}`,
      }, seen)
    }
  }

  for (const { client, daysAway } of inactiveClients(s, ctx.now)) {
    if (!client.marketingOptIn) continue
    enqueue(d, ctx, {
      to: client.email, clientId: client.id, kind: 'recovery', subject: 'Faz tempo que não te vemos',
      body: `${client.name.split(' ')[0]}, já são ${daysAway} dias desde o seu último corte. Sua cadeira está te esperando!\nEscolha o melhor horário e bora dar aquele tapa no visual.`,
      dedupeKey: `recovery:${client.id}:${today.slice(0, 7)}`,
    }, seen)
  }

  expireAbandoned(d.subscriptions, ctx.now)
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

  // Mensagens resolvidas há mais de 90 dias saem: o app não fica mais pesado mês a mês.
  // Dados de clientes e financeiros nunca entram nesta limpeza.
  const purgeBefore = addDays(today, -90)
  d.messages = d.messages.filter((m) => !((m.status === 'sent' || m.status === 'failed') && m.createdAt.slice(0, 10) < purgeBefore))
  return { messages: seen.size - before }
}
