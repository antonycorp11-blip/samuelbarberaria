import { base, type Ctx } from './engine'
import { formatBRL } from './money'
import { brDate, dateKey, timeOf } from './time'
import type { Appointment, Client, DbState, Message, MessageKind } from './types'

export interface NewMessage {
  channel?: Message['channel']
  to: string
  clientId: string | null
  kind: MessageKind
  subject: string
  body: string
  dedupeKey: string
}

/** Tipos que dependem de consentimento (LGPD). Os demais são transacionais. */
export const MARKETING_KINDS: MessageKind[] = ['birthday', 'recovery', 'campaign']

export function enqueue(d: DbState, ctx: Ctx, m: NewMessage, seen?: Set<string>): boolean {
  if (!m.to) return false
  const duplicate = seen
    ? seen.has(m.dedupeKey)
    : base(d).messages.some((x) => x.dedupeKey === m.dedupeKey)
  if (duplicate) return false
  seen?.add(m.dedupeKey)
  d.messages.push({
    id: ctx.id(),
    channel: m.channel ?? 'email',
    to: m.to,
    clientId: m.clientId,
    kind: m.kind,
    subject: m.subject,
    body: m.body,
    dedupeKey: m.dedupeKey,
    status: 'queued',
    createdAt: ctx.now,
    sentAt: null,
    error: null,
  })
  return true
}

const when = (a: Appointment) => `${brDate(dateKey(a.start))} às ${timeOf(a.start)}`

export function appointmentMessage(
  shop: string,
  kind: 'booking_confirmation' | 'reminder_24h' | 'reminder_2h' | 'cancellation',
  c: Client,
  a: Appointment,
  barberName: string,
): NewMessage {
  const first = c.name.split(' ')[0]
  const text = {
    booking_confirmation: [`Horário confirmado na ${shop}`, `${first}, seu horário com ${barberName} está marcado para ${when(a)}.`],
    reminder_24h: [`Seu horário é amanhã`, `${first}, passando para lembrar: ${when(a)} com ${barberName}.`],
    reminder_2h: [`Seu horário é daqui a pouco`, `${first}, te esperamos ${when(a)} com ${barberName}.`],
    cancellation: [`Horário cancelado`, `${first}, seu horário de ${when(a)} foi cancelado. Quando quiser, é só agendar de novo.`],
  }[kind] as [string, string]
  return { to: c.email, clientId: c.id, kind, subject: text[0], body: text[1], dedupeKey: `${kind}:${a.id}:${a.start}` }
}

export function chargeMessage(kind: 'charge_due' | 'charge_overdue', c: Client, chargeId: string, amount: number, due: string): NewMessage {
  const overdue = kind === 'charge_overdue'
  return {
    to: c.email,
    clientId: c.id,
    kind,
    subject: overdue ? 'Sua assinatura está em atraso' : 'Sua assinatura foi renovada',
    body: overdue
      ? `A mensalidade de ${formatBRL(amount)} venceu em ${brDate(due)}. Regularize para continuar usando seus benefícios.`
      : `A mensalidade de ${formatBRL(amount)} vence em ${brDate(due)}.`,
    dedupeKey: `${kind}:${chargeId}`,
  }
}
