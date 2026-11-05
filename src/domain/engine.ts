import { original, produce, type Draft } from 'immer'
import { fail } from './errors'
import type { Actor, DbState, ID, ISO } from './types'

export interface Ctx {
  now: ISO
  actor: Actor
  id: () => ID
}

export type Command<I, R = void> = (d: DbState, input: I, ctx: Ctx) => R

/**
 * Executa um comando de forma atômica: ou tudo é aplicado, ou nada.
 * Se a regra falhar no meio (estoque, pagamento, conflito), o estado original fica intacto.
 */
export function run<I, R>(state: DbState, cmd: Command<I, R>, input: I, ctx: Ctx): { state: DbState; result: R } {
  let result!: R
  const next = produce(state, (draft: Draft<DbState>) => {
    result = cmd(draft as DbState, input, ctx)
  })
  return { state: next, result }
}

/** Estado anterior ao comando, para leituras rápidas (sem proxies do Immer). */
export function base(d: DbState): DbState {
  return original(d) ?? d
}

export function requireOwner(ctx: Ctx) {
  if (ctx.actor.role !== 'owner') fail('forbidden', 'Somente o dono pode fazer isso.')
}

/** Barbeiro só mexe no que é dele. */
export function requireBarberScope(ctx: Ctx, barberId: ID) {
  if (ctx.actor.role === 'barber' && ctx.actor.barberId !== barberId) {
    fail('forbidden', 'Você só pode alterar a sua própria agenda.')
  }
}

export function audit(d: DbState, ctx: Ctx, action: string, entityId: ID | null, detail = '') {
  d.audit.push({ id: ctx.id(), at: ctx.now, actor: ctx.actor.name, action, entityId, detail })
}

export function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) fail('not_found', `${what} não encontrado.`)
  return value
}

export const SYSTEM_ACTOR: Actor = { role: 'owner', barberId: null, name: 'Sistema' }
