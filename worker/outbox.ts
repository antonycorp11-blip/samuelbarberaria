// Regras de envio, sem depender de Deno: rodam igual aqui, na Vercel e nos testes.

export interface OutboxMessage {
  id: string
  channel: 'email' | 'push'
  recipient: string
  subject: string
  body: string
  attempts: number
}

export interface OutboxDeps {
  claim: () => Promise<OutboxMessage[]>
  sendEmail: (m: OutboxMessage) => Promise<void>
  sendPush: (m: OutboxMessage) => Promise<void>
  markSent: (id: string) => Promise<void>
  /** Devolve à fila. Com `attempts`, conta a tentativa que falhou. */
  requeue: (id: string, attempts?: number, error?: string) => Promise<void>
  markFailed: (id: string, attempts: number, error: string) => Promise<void>
}

export const MAX_ATTEMPTS = 3

export function mailOptions(m: Pick<OutboxMessage, 'recipient' | 'subject' | 'body'>, fromName: string, fromAddress: string) {
  return { from: { name: fromName, address: fromAddress }, to: m.recipient, subject: m.subject, text: m.body }
}

/**
 * Senha errada ou limite do Gmail não são culpa da mensagem: insistir só agrava,
 * e a conta pode ser bloqueada. Para o lote e devolve tudo intacto à fila.
 */
export function isAccountProblem(e: unknown): boolean {
  const err = e as { code?: string; responseCode?: number; response?: string; message?: string }
  if (err.code === 'EAUTH' || err.responseCode === 535 || err.responseCode === 534 || err.responseCode === 421 || err.responseCode === 454) return true
  return /5\.4\.5|sending limit|rate limit|too many/i.test(`${err.response ?? ''} ${err.message ?? ''}`)
}

export async function processOutbox(deps: OutboxDeps) {
  const batch = await deps.claim()
  const result = { sent: 0, failed: 0, retried: 0, released: 0, stopped: false }

  for (const [index, m] of batch.entries()) {
    try {
      await (m.channel === 'email' ? deps.sendEmail(m) : deps.sendPush(m))
      await deps.markSent(m.id)
      result.sent += 1
    } catch (e) {
      const error = String(e)
      if (m.channel === 'email' && isAccountProblem(e)) {
        for (const rest of batch.slice(index)) {
          await deps.requeue(rest.id)
          result.released += 1
        }
        result.stopped = true
        break
      }
      const attempts = m.attempts + 1
      if (attempts >= MAX_ATTEMPTS) {
        await deps.markFailed(m.id, attempts, error)
        result.failed += 1
      } else {
        await deps.requeue(m.id, attempts, error)
        result.retried += 1
      }
    }
  }
  return result
}
