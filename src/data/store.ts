import { get, set } from 'idb-keyval'
import { useSyncExternalStore } from 'react'
import { runAutomations } from '@/domain/automations'
import { run, SYSTEM_ACTOR, type Command, type Ctx } from '@/domain/engine'
import { emptyState, SCHEMA_VERSION, type Actor, type DbState } from '@/domain/types'
import { buildDemo } from './seed'

/**
 * Modo local: o banco inteiro fica no IndexedDB do aparelho.
 * Na conexão com o Supabase, `load`, `persist` e `exec` são os pontos de troca
 * (ver docs/SUPABASE.md). As telas não sabem de onde o dado vem.
 */
const KEY = 'samuel-db'
const ACTOR_KEY = 'samuel-actor'
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('samuel-db') : null

let state: DbState = emptyState()
let actor: Actor = readActor()
const listeners = new Set<() => void>()

function readActor(): Actor {
  try {
    const raw = localStorage.getItem(ACTOR_KEY)
    return raw ? (JSON.parse(raw) as Actor) : { ...SYSTEM_ACTOR, name: 'Dono' }
  } catch {
    return { ...SYSTEM_ACTOR, name: 'Dono' }
  }
}

function emit() {
  for (const l of listeners) l()
}

function commit(next: DbState) {
  state = next
  emit()
  void set(KEY, next)
    .then(() => channel?.postMessage('changed'))
    .catch((e) => console.error('Falha ao salvar no aparelho', e))
}

export const nowISO = () => new Date().toISOString()

function ctx(as: Actor = actor): Ctx {
  return { now: nowISO(), actor: as, id: () => crypto.randomUUID() }
}

export async function bootstrap() {
  const saved = await get<DbState>(KEY)
  if (saved && saved.schemaVersion === SCHEMA_VERSION) {
    state = saved
    emit()
  } else commit(buildDemo(nowISO()))
  tick()
  setInterval(tick, 5 * 60_000)
  channel?.addEventListener('message', () => {
    void get<DbState>(KEY).then((s) => {
      if (s) {
        state = s
        emit()
      }
    })
  })
}

function tick() {
  commit(run(state, runAutomations, undefined, ctx(SYSTEM_ACTOR)).state)
}

/** Executa um comando. Se a regra falhar, lança DomainError e nada muda. */
export function exec<I, R>(cmd: Command<I, R>, input: I): R {
  const { state: next, result } = run(state, cmd, input, ctx())
  commit(next)
  return result
}

/** Comando vindo do link público: sem usuário logado. */
export function execPublic<I, R>(cmd: Command<I, R>, input: I): R {
  const { state: next, result } = run(state, cmd, input, ctx({ role: 'barber', barberId: null, name: 'Cliente (online)' }))
  commit(next)
  return result
}

export const getState = () => state
export const getCtx = () => ctx()

export function useDb(): DbState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

export function useActor(): Actor {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => actor,
  )
}

export function setActor(next: Actor) {
  actor = next
  try {
    localStorage.setItem(ACTOR_KEY, JSON.stringify(next))
  } catch {
    // Sem armazenamento: vale só para esta sessão.
  }
  emit()
}

export function resetTo(mode: 'demo' | 'empty') {
  commit(mode === 'demo' ? buildDemo(nowISO()) : emptyState())
}

export function replaceState(next: DbState) {
  if (next.schemaVersion !== SCHEMA_VERSION) throw new Error('Backup de versão incompatível.')
  commit(next)
}
