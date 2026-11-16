import { base, type Ctx } from './engine'
import { formatBRL } from './money'
import { brDate, dateKey, timeOf, weekdayLabel } from './time'
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

/** Teto de e-mails para o mesmo endereço por dia. Uma rotina normal manda 2 ou 3. */
export const MAX_EMAILS_PER_RECIPIENT_PER_DAY = 6

export function enqueue(d: DbState, ctx: Ctx, m: NewMessage, seen?: Set<string>): boolean {
  if (!m.to) return false
  const duplicate = seen
    ? seen.has(m.dedupeKey)
    : base(d).messages.some((x) => x.dedupeKey === m.dedupeKey)
  if (duplicate) return false
  // Protege o Gmail da barbearia: ninguém usa o link público para mandar e-mail em massa para um endereço.
  if ((m.channel ?? 'email') === 'email') {
    const today = ctx.now.slice(0, 10)
    const recipient = m.to.toLowerCase()
    const sentToday = base(d).messages.filter((x) => x.channel === 'email' && x.to.toLowerCase() === recipient && x.createdAt.slice(0, 10) === today).length
    if (sentToday >= MAX_EMAILS_PER_RECIPIENT_PER_DAY) return false
  }
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

/** Marca do link de cancelamento no texto. Só o servidor sabe assinar o link. */
export const cancelMarker = (appointmentId: string) => `{{cancelar:${appointmentId}}}`
export const CANCEL_MARKER = /\{\{cancelar:([^}]+)\}\}/g

const firstName = (c: Client) => c.name.split(' ')[0] ?? c.name

export function welcomeMessage(c: Client): NewMessage {
  return {
    to: c.email,
    clientId: c.id,
    kind: 'welcome',
    subject: 'Seja bem-vindo!',
    body: `${firstName(c)}, que bom ter você com a gente!\nAqui você cuida do visual com quem entende do assunto, e agenda seu horário pelo celular quando quiser, 24 horas por dia.`,
    dedupeKey: `welcome:${c.id}`,
  }
}

const APPOINTMENT_TEXT = {
  booking_confirmation: ['Horário confirmado ✂️', (n: string) => `${n}, seu horário está garantido. Te esperamos!`],
  reminder_24h: ['Seu horário é amanhã', (n: string) => `${n}, passando para lembrar do seu horário.`],
  reminder_2h: ['Seu horário é daqui a pouco', (n: string) => `${n}, falta pouco. Te esperamos!`],
  cancellation: ['Horário cancelado', (n: string) => `${n}, seu horário foi cancelado. Quando quiser, é só agendar de novo.`],
} as const

export function appointmentMessage(
  s: DbState,
  kind: keyof typeof APPOINTMENT_TEXT,
  c: Client,
  a: Appointment,
): NewMessage {
  const [subject, intro] = APPOINTMENT_TEXT[kind]
  const services = a.serviceIds.map((id) => s.services.find((x) => x.id === id))
  const lines = [intro(firstName(c))]
  if (kind !== 'cancellation') {
    lines.push(`Quando: ${weekdayLabel(dateKey(a.start))}, ${brDate(dateKey(a.start))} às ${timeOf(a.start)}`)
    lines.push(`Serviço: ${services.map((x) => x?.name).join(' + ')}`)
    lines.push(`Com: ${s.barbers.find((b) => b.id === a.barberId)?.name ?? 'nossa equipe'}`)
    lines.push(`Valor: ${formatBRL(services.reduce((t, x) => t + (x?.priceCents ?? 0), 0))}`)
    if (s.settings.address) lines.push(`Onde: ${s.settings.address}`)
    if (s.settings.phone) lines.push(`Se precisar remarcar, é só chamar a gente no ${s.settings.phone}.`)
    // O servidor troca a marca pelo link assinado na hora de enviar.
    lines.push(`Precisa cancelar? ${cancelMarker(a.id)}`)
  }
  return { to: c.email, clientId: c.id, kind, subject, body: lines.join('\n'), dedupeKey: `${kind}:${a.id}:${a.start}` }
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
