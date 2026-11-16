import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

const S = 'segredo-de-teste'

describe('banco isolado', () => {
  let db: PGlite
  let version = 0

  const call = async <T,>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(sql, params)).rows[0]?.r as T
  const push = async (changes: unknown[], expected = version) => {
    version = await call<number>('select public.barbearia_push($1, $2, $3) as r', [S, expected, JSON.stringify(changes)])
    return version
  }
  const appt = (id: string, start: string, end: string, status = 'scheduled', barberId = 'b1') => ({
    c: 'appointments', id, data: { barberId, start, end, status },
  })

  beforeAll(async () => {
    db = new PGlite({ extensions: { btree_gist, pgcrypto } })
    await db.exec(`create role anon; create role authenticated; create schema extensions;`)
    await db.exec(readFileSync('supabase/store/schema.sql', 'utf8'))
    await db.query(`insert into barbearia.meta (api_secret_hash) values (encode(extensions.digest($1::text, 'sha256'), 'hex'))`, [S])
  })

  beforeEach(async () => {
    await db.exec(`
      alter table barbearia.entities disable trigger guard_history;
      delete from barbearia.entities; delete from barbearia.staff; update barbearia.meta set version = 0;
      alter table barbearia.entities enable trigger guard_history;
    `)
    version = 0
  })

  it('todo UPDATE tem WHERE: o Supabase recusa os que não têm, e o Postgres local não', () => {
    const sql = readFileSync('supabase/store/schema.sql', 'utf8')
    const updates = sql.match(/^\s*update\s+barbearia\.[\s\S]*?;/gim) ?? []
    expect(updates.length).toBeGreaterThan(3)
    for (const statement of updates) expect(statement).toMatch(/\bwhere\b/i)
  })

  it('sem a chave do servidor nada entra nem sai', async () => {
    await expect(db.query('select public.barbearia_pull($1, 0)', ['errada'])).rejects.toThrow(/acesso negado/)
    await expect(db.query('select public.barbearia_pull(null, 0)')).rejects.toThrow(/acesso negado/)
    await expect(db.query(`select public.barbearia_push('x', 0, '[]')`)).rejects.toThrow(/acesso negado/)
  })

  it('o papel público não enxerga as tabelas', async () => {
    await db.exec('set role anon')
    await expect(db.query('select * from barbearia.entities')).rejects.toThrow(/permission denied/)
    await expect(db.query('select * from barbearia.meta')).rejects.toThrow(/permission denied/)
    await db.exec('reset role')
  })

  it('baixa só o que mudou, inclusive exclusões', async () => {
    await push([{ c: 'blocks', id: 'a', data: { x: 1 } }, { c: 'blocks', id: 'b', data: { x: 2 } }])
    const v1 = version
    await push([{ c: 'blocks', id: 'a', data: null }])
    const r = await call<{ version: number; changes: unknown[] }>('select public.barbearia_pull($1, $2) as r', [S, v1])
    expect(r.version).toBe(2)
    expect(r.changes).toEqual([{ c: 'blocks', id: 'a', data: null }])
  })

  it('dois comandos ao mesmo tempo: o segundo refaz em vez de sobrescrever', async () => {
    await push([{ c: 'blocks', id: 'a', data: {} }])
    await expect(push([{ c: 'blocks', id: 'b', data: {} }], 0)).rejects.toThrow(/conflito/)
  })

  it('gravação falha por inteiro, sem deixar metade', async () => {
    await push([appt('a1', '2026-03-03T13:00:00.000Z', '2026-03-03T13:30:00.000Z')])
    await expect(push([
      { c: 'blocks', id: 'x', data: {} },
      appt('a2', '2026-03-03T13:15:00.000Z', '2026-03-03T13:45:00.000Z'),
    ])).rejects.toThrow(/no_double_booking/)
    const r = await call<{ changes: unknown[] }>('select public.barbearia_pull($1, 0) as r', [S])
    expect(r.changes.length).toBe(1)
  })

  it('agenda: colado e outro barbeiro passam, cancelado libera', async () => {
    await push([appt('a1', '2026-03-03T13:00:00.000Z', '2026-03-03T13:30:00.000Z')])
    await push([appt('a2', '2026-03-03T13:30:00.000Z', '2026-03-03T14:00:00.000Z')])
    await push([appt('a3', '2026-03-03T13:00:00.000Z', '2026-03-03T13:30:00.000Z', 'scheduled', 'b2')])
    await push([appt('a1', '2026-03-03T13:00:00.000Z', '2026-03-03T13:30:00.000Z', 'cancelled')])
    await push([appt('a4', '2026-03-03T13:00:00.000Z', '2026-03-03T13:30:00.000Z')])
  })

  it('estoque negativo, venda com conta errada e venda dupla são barrados', async () => {
    await expect(push([{ c: 'products', id: 'p', data: { qty: -1 } }])).rejects.toThrow(/stock_not_negative/)
    await expect(push([{ c: 'sales', id: 's', data: { subtotalCents: 100, discountCents: 1, totalCents: 100 } }])).rejects.toThrow(/sale_totals/)
    const sale = { subtotalCents: 100, discountCents: 0, totalCents: 100, appointmentId: 'a1' }
    await push([{ c: 'sales', id: 's1', data: sale }])
    await expect(push([{ c: 'sales', id: 's2', data: sale }])).rejects.toThrow(/one_sale_per_appointment/)
  })

  it('histórico financeiro não se altera nem se apaga', async () => {
    const tx = { amountCents: 100, type: 'in', reversed: false }
    await push([{ c: 'transactions', id: 't', data: tx }])
    await expect(push([{ c: 'transactions', id: 't', data: { ...tx, amountCents: 1 } }])).rejects.toThrow(/alterados/)
    await expect(push([{ c: 'transactions', id: 't', data: null }])).rejects.toThrow(/apagado/)
    await push([{ c: 'transactions', id: 't', data: { ...tx, reversed: true } }])
    const sale = { subtotalCents: 100, discountCents: 0, totalCents: 100, status: 'paid', refundedAt: null, refundReason: '' }
    await push([{ c: 'sales', id: 's', data: sale }])
    await expect(push([{ c: 'sales', id: 's', data: { ...sale, subtotalCents: 90, totalCents: 90 } }])).rejects.toThrow(/só estornadas/)
    await push([{ c: 'sales', id: 's', data: { ...sale, status: 'refunded', refundedAt: 'x', refundReason: 'y' } }])
  })

  it('mensagem com mesma chave não duplica', async () => {
    await push([{ c: 'messages', id: 'm1', data: { dedupeKey: 'k' } }])
    await expect(push([{ c: 'messages', id: 'm2', data: { dedupeKey: 'k' } }])).rejects.toThrow(/message_dedupe/)
  })

  describe('login', () => {
    const login = (email: string, password: string) => call<Record<string, unknown> | null>('select public.barbearia_login($1, $2, $3) as r', [S, email, password])
    const create = () => db.query(`select public.barbearia_set_staff($1, 'Dono@Teste.com', 'senha-forte', 'owner', null, 'Samuel')`, [S])

    it('entra com a senha certa e não guarda a senha em texto', async () => {
      await create()
      expect(await login(' dono@teste.com ', 'senha-forte')).toEqual({ role: 'owner', barberId: null, name: 'Samuel', email: 'dono@teste.com' })
      const { rows } = await db.query<{ password_hash: string }>('select password_hash from barbearia.staff')
      expect(rows[0]?.password_hash).not.toContain('senha-forte')
    })

    it('recusa senha errada e e-mail inexistente da mesma forma', async () => {
      await create()
      expect(await login('dono@teste.com', 'errada')).toBeNull()
      expect(await login('ninguem@teste.com', 'errada')).toBeNull()
    })

    it('trava depois de 5 erros, mesmo com a senha certa', async () => {
      await create()
      for (let i = 0; i < 5; i++) await login('dono@teste.com', 'errada')
      expect(await login('dono@teste.com', 'senha-forte')).toEqual({ locked: true })
    })

    it('recusa senha curta', async () => {
      await expect(db.query(`select public.barbearia_set_staff($1, 'a@b.com', '123', 'owner', null, 'x')`, [S])).rejects.toThrow(/8 caracteres/)
    })
  })
})
