import { updateSettings, upsertService } from '@/domain/catalog'
import { run, SYSTEM_ACTOR, type Ctx } from '@/domain/engine'
import { upsertBarber } from '@/domain/team'
import { emptyState, type DbState } from '@/domain/types'

/** Ponto de partida do banco: o dono ajusta preços e equipe nos Ajustes. */
export function buildStarter(now: string, ownerName: string): DbState {
  let state = emptyState()
  const ctx = (): Ctx => ({ now, actor: SYSTEM_ACTOR, id: () => crypto.randomUUID() })
  state = run(state, updateSettings, {}, ctx()).state
  const services = [
    ['Corte', 5000, 30], ['Barba', 3500, 30], ['Corte + Barba', 7500, 60], ['Corte infantil', 4000, 30], ['Sobrancelha', 2000, 15],
  ] as const
  for (const [name, priceCents, durationMin] of services) {
    state = run(state, upsertService, { name, priceCents, durationMin }, ctx()).state
  }
  state = run(state, upsertBarber, {
    name: ownerName, email: '', phone: '', serviceBps: 5000, productBps: 1000, daysOff: [0], breakStart: null, breakEnd: null,
  }, ctx()).state
  return state
}
