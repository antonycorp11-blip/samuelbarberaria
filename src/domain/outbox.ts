import { current } from 'immer'
import { must, type Command } from './engine'
import { MARKETING_KINDS } from './messages'
import { addMinutes, dateKey } from './time'
import type { Message } from './types'

export const MAIL_LIMITS = { dailyCap: 400, marketingCap: 200, batch: 20 }

const isMarketing = (m: Message) => MARKETING_KINDS.includes(m.kind)

/**
 * Próximo lote da fila. Confirmações e lembretes vêm primeiro; o marketing só usa o
 * que sobra até o próprio teto, para uma campanha nunca gastar o limite do Gmail.
 * Push não conta: não passa pelo Gmail.
 */
export function pickOutbox(messages: Message[], now: string, limits = MAIL_LIMITS): Message[] {
  const today = dateKey(now)
  const sentToday = messages.filter(
    (m) => m.channel === 'email' && (m.status === 'sent' || m.status === 'sending') && dateKey(m.sentAt ?? m.claimedAt ?? m.createdAt) === today,
  )
  let left = Math.max(0, limits.dailyCap - sentToday.length)
  let marketingLeft = Math.max(0, limits.marketingCap - sentToday.filter(isMarketing).length)
  const queued = messages.filter((m) => m.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const out: Message[] = queued.filter((m) => m.channel === 'push').slice(0, limits.batch)
  for (const m of queued.filter((x) => x.channel === 'email' && !isMarketing(x))) {
    if (out.length >= limits.batch || left <= 0) break
    out.push(m)
    left -= 1
  }
  for (const m of queued.filter((x) => x.channel === 'email' && isMarketing(x))) {
    if (out.length >= limits.batch || left <= 0 || marketingLeft <= 0) break
    out.push(m)
    left -= 1
    marketingLeft -= 1
  }
  return out
}

/** Reserva o lote. Duas rotinas simultâneas não pegam a mesma mensagem. */
export const claimMessages: Command<void, Message[]> = (d, _i, ctx) => {
  const staleBefore = addMinutes(ctx.now, -15)
  const expiredBefore = addMinutes(ctx.now, -24 * 60)
  for (const m of d.messages) {
    // Execução que caiu no meio devolve o que tinha reservado.
    if (m.status === 'sending' && (m.claimedAt ?? '') < staleBefore) {
      m.status = 'queued'
      m.claimedAt = null
    }
    // Lembrete atrasado mais de um dia já não ajuda ninguém.
    if (m.status === 'queued' && (m.kind === 'reminder_24h' || m.kind === 'reminder_2h') && m.createdAt < expiredBefore) {
      m.status = 'failed'
      m.error = 'expirada'
    }
  }
  const ids = new Set(pickOutbox(current(d.messages), ctx.now).map((m) => m.id))
  const picked: Message[] = []
  for (const m of d.messages) {
    if (m.status !== 'queued' || !ids.has(m.id)) continue
    m.status = 'sending'
    m.claimedAt = ctx.now
    picked.push({ ...m })
  }
  return picked
}

export const settleMessage: Command<{ id: string; status: 'sent' | 'failed' | 'queued'; error?: string; attempts?: number }> = (d, i, ctx) => {
  const m = must(d.messages.find((x) => x.id === i.id), 'Mensagem')
  m.status = i.status
  m.sentAt = i.status === 'sent' ? ctx.now : null
  m.claimedAt = null
  m.error = i.error ?? null
  if (i.attempts !== undefined) m.attempts = i.attempts
}
