import type { Actor, DbState } from './types'

/** Uma alteração de registro. `data: null` significa removido. */
export interface Change {
  c: string
  id: string
  data: unknown
}

const LISTS = [
  'services', 'barbers', 'clients', 'appointments', 'blocks', 'waitlist', 'products', 'stockMovements', 'sales',
  'transactions', 'commissions', 'payouts', 'plans', 'subscriptions', 'charges', 'coupons', 'campaigns', 'messages', 'audit',
] as const

type ListKey = (typeof LISTS)[number]
type Row = { id: string }

/** O que mudou entre dois estados. O Immer mantém a referência do que não mudou. */
export function diffState(prev: DbState, next: DbState): Change[] {
  const changes: Change[] = []
  if (prev.settings !== next.settings) changes.push({ c: 'settings', id: 'main', data: next.settings })
  for (const key of LISTS) {
    if (prev[key] === next[key]) continue
    const before = new Map<string, Row>((prev[key] as Row[]).map((r) => [r.id, r]))
    for (const row of next[key] as Row[]) {
      if (before.get(row.id) !== row) changes.push({ c: key, id: row.id, data: row })
      before.delete(row.id)
    }
    for (const id of before.keys()) changes.push({ c: key, id, data: null })
  }
  return changes
}

export function applyChanges(state: DbState, changes: Change[]): DbState {
  if (changes.length === 0) return state
  const next = { ...state }
  const grouped = new Map<ListKey, Change[]>()
  for (const ch of changes) {
    if (ch.c === 'settings') {
      if (ch.data) next.settings = ch.data as DbState['settings']
    } else if ((LISTS as readonly string[]).includes(ch.c)) {
      const key = ch.c as ListKey
      grouped.set(key, [...(grouped.get(key) ?? []), ch])
    }
  }
  for (const [key, list] of grouped) {
    const rows = new Map<string, Row>((state[key] as Row[]).map((r) => [r.id, r]))
    for (const ch of list) {
      if (ch.data === null) rows.delete(ch.id)
      else rows.set(ch.id, ch.data as Row)
    }
    ;(next[key] as Row[]) = [...rows.values()]
  }
  return next
}

/** Barbeiro não recebe o caixa nem os números dos colegas: o filtro é no servidor, não na tela. */
export function viewFor(actor: Actor, changes: Change[]): Change[] {
  if (actor.role === 'owner') return changes
  const hidden = new Set(['transactions', 'audit', 'campaigns', 'charges'])
  const own = new Set(['commissions', 'payouts', 'sales'])
  return changes.filter((ch) => {
    if (hidden.has(ch.c)) return false
    if (own.has(ch.c) && ch.data !== null) return (ch.data as { barberId?: string }).barberId === actor.barberId
    return true
  })
}
