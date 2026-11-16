import { run, type Command, type Ctx } from '../src/domain/engine'
import { DomainError } from '../src/domain/errors'
import { applyChanges, diffState, type Change } from '../src/domain/sync'
import { emptyState, type DbState } from '../src/domain/types'

export class ConflictError extends Error {}

export interface StoreDb {
  pull(since: number): Promise<{ version: number; changes: Change[] }>
  push(expected: number, changes: Change[]): Promise<number>
}

/** Mensagens das travas do banco, para o caso raro de o erro chegar até lá. */
function friendly(message: string): DomainError | null {
  if (message.includes('no_double_booking')) return new DomainError('slot_taken', 'Esse horário acabou de ser ocupado.')
  if (message.includes('stock_not_negative')) return new DomainError('no_stock', 'Estoque insuficiente.')
  if (message.includes('one_sale_per_appointment')) return new DomainError('already_closed', 'Este atendimento já foi fechado.')
  return null
}

/**
 * Os mesmos comandos do app, agora com a palavra final. Cada comando roda sobre a versão
 * atual; se outro entrou antes, o banco devolve conflito e o comando é refeito.
 */
export class ServerStore {
  private state: DbState = emptyState()
  private version = 0

  constructor(private db: StoreDb) {}

  async current() {
    const { version, changes } = await this.db.pull(this.version)
    this.state = applyChanges(this.state, changes)
    this.version = version
    return { state: this.state, version }
  }

  async execute<I, R>(cmd: Command<I, R>, input: I, makeCtx: () => Ctx): Promise<R> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { state, version } = await this.current()
      const { state: next, result } = run(state, cmd, input, makeCtx())
      const changes = diffState(state, next)
      if (changes.length === 0) return result
      try {
        this.version = await this.db.push(version, changes)
        this.state = next
        return result
      } catch (e) {
        if (e instanceof ConflictError) continue
        throw friendly(String(e)) ?? e
      }
    }
    throw new DomainError('busy', 'Muitas alterações ao mesmo tempo. Tente de novo.')
  }

  /** Grava um estado inteiro de uma vez: usado só ao criar o banco. */
  async seed(state: DbState) {
    const { state: empty, version } = await this.current()
    this.version = await this.db.push(version, diffState(empty, state))
    this.state = state
  }
}

export function supabaseDb(url: string, key: string, secret: string) {
  const rpc = async <T>(name: string, body: Record<string, unknown>): Promise<T> => {
    const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_secret: secret, ...body }),
    })
    const data = (await res.json().catch(() => null)) as (T & { code?: string; message?: string }) | null
    if (!res.ok) {
      if (data?.code === '40001') throw new ConflictError()
      if (data?.code === 'P0001') throw new DomainError('rejected', data.message ?? 'Operação recusada.')
      throw new Error(`Banco ${res.status}: ${data?.message ?? 'sem resposta'}`)
    }
    return data as T
  }
  return {
    pull: (since: number) => rpc<{ version: number; changes: Change[] }>('barbearia_pull', { p_since: since }),
    push: (expected: number, changes: Change[]) => rpc<number>('barbearia_push', { p_expected: expected, p_changes: changes }),
    staffCount: () => rpc<number>('barbearia_staff_count', {}),
    setStaff: (s: { email: string; password: string; role: string; barberId: string | null; name: string }) =>
      rpc<null>('barbearia_set_staff', { p_email: s.email, p_password: s.password, p_role: s.role, p_barber_id: s.barberId, p_name: s.name }),
    /** Papel e nome de uma conta, para redefinir a senha sem saber a antiga. */
    staffInfo: async (email: string) => {
      const r = await rpc<{ role?: 'owner' | 'barber'; name?: string } | null>('barbearia_staff_info', { p_email: email })
      return r?.role ? { role: r.role, name: r.name ?? '' } : null
    },
    login: (email: string, password: string) =>
      rpc<{ role?: 'owner' | 'barber'; barberId?: string | null; name?: string; email?: string; locked?: boolean } | null>('barbearia_login', { p_email: email, p_password: password }),
  }
}

export type Database = ReturnType<typeof supabaseDb>
