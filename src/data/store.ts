import { del, get, set } from 'idb-keyval'
import { useSyncExternalStore } from 'react'
import { commandName } from '@/domain/commands'
import { run, type Command, type Ctx } from '@/domain/engine'
import { applyChanges, type Change } from '@/domain/sync'
import { emptyState, SCHEMA_VERSION, type Actor, type DbState } from '@/domain/types'
import { toast } from '@/ui/kit'

/**
 * O servidor é a fonte da verdade. O aparelho guarda uma cópia para abrir rápido e
 * calcula cada comando na hora, para a tela responder sem esperar. O servidor repete
 * o mesmo cálculo: se recusar, a tela volta ao que está confirmado.
 */
const CACHE = 'samuel-cache'
const SESSION = 'samuel-session'
const POLL_MS = 10_000

interface Session {
  token: string
  actor: Actor
}

let confirmed: DbState = emptyState()
let state: DbState = confirmed
let version = 0
let epoch = ''
let session: Session | null = readSession()
let pending = 0
let queue: Promise<void> = Promise.resolve()
let ready = false
const listeners = new Set<() => void>()

function readSession(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION) ?? 'null') as Session | null
  } catch {
    return null
  }
}

function emit() {
  for (const l of listeners) l()
}

export const nowISO = () => new Date().toISOString()

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...init?.headers },
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (res.status === 401 && session) {
    void logout()
    throw new Error('Sessão expirada. Entre de novo.')
  }
  if (!res.ok) throw new Error(data.error?.message ?? `Erro ${res.status}: o servidor não respondeu.`)
  return data
}

async function pull() {
  if (!session) return
  type Sync = { version: number; epoch: string; changes: Change[] }
  let r = await api<Sync>(`/api/sync?since=${version}`)
  // O banco do servidor foi trocado ou restaurado: a cópia do aparelho é descartada e tudo vem de novo,
  // para ninguém ver dado que não existe mais.
  const replaced = r.epoch !== epoch || r.version < version
  if (replaced && version > 0) r = await api<Sync>('/api/sync?since=0')
  if (!replaced && r.version === version && r.changes.length === 0) return
  confirmed = applyChanges(replaced ? emptyState() : confirmed, r.changes)
  version = r.version
  epoch = r.epoch
  // Comando em andamento: a tela mantém o cálculo local até ele voltar.
  if (pending === 0) {
    state = confirmed
    emit()
  }
  void set(CACHE, { state: confirmed, version, epoch, schema: SCHEMA_VERSION }).catch(() => {})
}

const safePull = () => pull().catch(() => {})

let started = false

export async function bootstrap() {
  if (session) {
    const cached = await get<{ state: DbState; version: number; epoch?: string; schema: number }>(CACHE).catch(() => undefined)
    if (cached?.schema === SCHEMA_VERSION) {
      confirmed = state = cached.state
      version = cached.version
      epoch = cached.epoch ?? ''
    }
    await safePull()
  }
  ready = true
  emit()
  if (started) return
  started = true
  setInterval(() => void safePull(), POLL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void safePull()
  })
}

function ctx(ids: string[] = []): Ctx {
  return {
    now: nowISO(),
    actor: session?.actor ?? { role: 'barber', barberId: null, name: '' },
    id: () => {
      const id = crypto.randomUUID()
      ids.push(id)
      return id
    },
  }
}

/** Executa um comando. Regra violada lança DomainError na hora e nada muda. */
export function exec<I, R>(cmd: Command<I, R>, input: I): R {
  const name = commandName(cmd)
  const ids: string[] = []
  const { state: next, result } = run(state, cmd, input, ctx(ids))
  state = next
  pending += 1
  emit()
  queue = queue.then(async () => {
    try {
      await api('/api/command', { method: 'POST', body: JSON.stringify({ name, input, ids }) })
      pending -= 1
      await safePull()
    } catch (e) {
      pending -= 1
      toast.bad(e instanceof TypeError ? 'Sem conexão: não foi salvo.' : e instanceof Error ? e.message : 'Não foi salvo.')
      state = confirmed
      emit()
      await safePull()
    }
  })
  return result
}

export const getState = () => state
export const getCtx = () => ctx()

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const useDb = (): DbState => useSyncExternalStore(subscribe, () => state)
export const useSession = () => useSyncExternalStore(subscribe, () => session)
export const useReady = () => useSyncExternalStore(subscribe, () => ready)

const NOBODY: Actor = { role: 'barber', barberId: null, name: '' }
export const useActor = (): Actor => useSyncExternalStore(subscribe, () => session?.actor ?? NOBODY)

export async function signIn(next: Session) {
  session = next
  localStorage.setItem(SESSION, JSON.stringify(next))
  confirmed = state = emptyState()
  version = 0
  ready = false
  emit()
  await bootstrap()
}

export async function logout() {
  session = null
  try {
    localStorage.removeItem(SESSION)
  } catch {
    // Sem armazenamento: a sessão já saiu da memória.
  }
  confirmed = state = emptyState()
  version = 0
  await del(CACHE).catch(() => {})
  emit()
}
