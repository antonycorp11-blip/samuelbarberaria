import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { beforeAll, describe, expect, it } from 'vitest'

const OWNER = '00000000-0000-0000-0000-000000000001'
const ANA = '00000000-0000-0000-0000-000000000002'
const BETO = '00000000-0000-0000-0000-000000000003'

/** Roda a migration num Postgres real embutido, sem tocar em nenhum projeto Supabase. */
describe('schema do banco', () => {
  let db: PGlite
  let barberA: string
  let barberB: string
  let clientId: string

  const as = async <T,>(user: string | null, fn: () => Promise<T>) => {
    await db.exec(`set role ${user ? 'authenticated' : 'anon'}; set app.uid = '${user ?? ''}';`)
    try {
      return await fn()
    } finally {
      await db.exec('reset role;')
    }
  }
  const appt = (barber: string, start: string, end: string) =>
    db.query(
      `insert into appointments (client_id, barber_id, service_ids, starts_at, ends_at) values ($1, $2, array[gen_random_uuid()], $3, $4) returning id`,
      [clientId, barber, start, end],
    )

  beforeAll(async () => {
    db = new PGlite({ extensions: { btree_gist } })
    // O que o Supabase já fornece pronto.
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
      grant usage on schema auth to anon, authenticated;
    `)
    await db.exec('create role service_role;')
    await db.exec(readFileSync('supabase/migrations/0001_schema.sql', 'utf8'))
    await db.exec(readFileSync('supabase/migrations/0002_gmail_outbox.sql', 'utf8'))
    await db.exec(`
      grant usage on schema public to anon, authenticated;
      grant select, insert, update, delete on all tables in schema public to anon, authenticated;
    `)
    const ins = await db.query<{ id: string }>(
      `insert into barbers (name, service_bps, product_bps) values ('Ana', 5000, 1000), ('Beto', 4000, 1000) returning id`,
    )
    barberA = ins.rows[0]!.id
    barberB = ins.rows[1]!.id
    clientId = (await db.query<{ id: string }>(`insert into clients (name, phone) values ('João', '11999990001') returning id`)).rows[0]!.id
    await db.query(`insert into profiles values ($1, 'owner', null), ($2, 'barber', $3), ($4, 'barber', $5)`, [OWNER, ANA, barberA, BETO, barberB])
  })

  it('duas reservas simultâneas no mesmo horário: o banco recusa a segunda', async () => {
    await appt(barberA, '2026-03-03T13:00Z', '2026-03-03T13:30Z')
    await expect(appt(barberA, '2026-03-03T13:15Z', '2026-03-03T13:45Z')).rejects.toThrow(/no_double_booking/)
    await appt(barberA, '2026-03-03T13:30Z', '2026-03-03T14:00Z')
    await appt(barberB, '2026-03-03T13:00Z', '2026-03-03T13:30Z')
  })

  it('horário cancelado libera a vaga', async () => {
    const { rows } = await appt(barberA, '2026-03-04T13:00Z', '2026-03-04T13:30Z')
    await db.query(`update appointments set status = 'cancelled' where id = $1`, [(rows[0] as { id: string }).id])
    await appt(barberA, '2026-03-04T13:00Z', '2026-03-04T13:30Z')
  })

  it('estoque nunca fica negativo', async () => {
    await db.exec(`insert into products (name, sale_price_cents, qty) values ('Pomada', 4000, 1)`)
    await expect(db.exec(`update products set qty = qty - 2 where name = 'Pomada'`)).rejects.toThrow(/check/)
  })

  it('mensagem repetida e cobrança repetida são barradas', async () => {
    const msg = `insert into messages (recipient, kind, subject, body, dedupe_key) values ('a@b.com', 'reminder_24h', 's', 'b', 'k1')`
    await db.exec(msg)
    await expect(db.exec(msg)).rejects.toThrow(/unique/)
  })

  it('um atendimento só gera uma venda', async () => {
    const { rows } = await appt(barberB, '2026-03-05T13:00Z', '2026-03-05T13:30Z')
    const id = (rows[0] as { id: string }).id
    const sale = `insert into sales (barber_id, appointment_id, subtotal_cents, discount_cents, total_cents) values ('${barberB}', '${id}', 5000, 0, 5000)`
    await db.exec(sale)
    await expect(db.exec(sale)).rejects.toThrow(/unique/)
  })

  it('venda com conta errada não entra', async () => {
    await expect(
      db.exec(`insert into sales (barber_id, subtotal_cents, discount_cents, total_cents) values ('${barberB}', 5000, 100, 5000)`),
    ).rejects.toThrow(/check/)
  })

  it('lançamento financeiro não se altera nem se apaga, só marca correção', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into transactions (type, category, amount_cents, method, description) values ('out', 'aluguel', 1000, 'pix', 'x') returning id`,
    )
    const id = rows[0]!.id
    await expect(db.query(`update transactions set amount_cents = 1 where id = $1`, [id])).rejects.toThrow(/alterados/)
    await expect(db.query(`delete from transactions where id = $1`, [id])).rejects.toThrow(/apagados/)
    await db.query(`update transactions set reversed = true where id = $1`, [id])
  })

  it('visitante sem login não lê nada', async () => {
    const rows = await as(null, async () => (await db.query(`select * from clients`)).rows)
    expect(rows).toEqual([])
  })

  it('barbeiro não vê o caixa nem a comissão do colega', async () => {
    await db.query(`insert into commissions (barber_id, kind, base_cents, bps, amount_cents) values ($1, 'service', 100, 5000, 50), ($2, 'service', 100, 4000, 40)`, [barberA, barberB])
    const seen = await as(ANA, async () => ({
      tx: (await db.query(`select * from transactions`)).rows.length,
      commissions: (await db.query<{ barber_id: string }>(`select barber_id from commissions`)).rows,
    }))
    expect(seen.tx).toBe(0)
    expect(seen.commissions).toEqual([{ barber_id: barberA }])
  })

  it('barbeiro não mexe na agenda do colega, o dono mexe em tudo', async () => {
    const { rows } = await appt(barberB, '2026-03-06T13:00Z', '2026-03-06T13:30Z')
    const id = (rows[0] as { id: string }).id
    const changed = await as(ANA, async () => (await db.query(`update appointments set notes = 'x' where id = $1`, [id])).affectedRows)
    expect(changed).toBe(0)
    const owner = await as(OWNER, async () => (await db.query(`update appointments set notes = 'y' where id = $1`, [id])).affectedRows)
    expect(owner).toBe(1)
  })

  it('barbeiro não dá a si mesmo uma comissão', async () => {
    await expect(
      as(ANA, () => db.query(`insert into commissions (barber_id, kind, base_cents, bps, amount_cents) values ($1, 'service', 1, 1, 999999)`, [barberA])),
    ).rejects.toThrow(/row-level security/)
  })
})
