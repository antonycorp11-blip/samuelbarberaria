import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { pgDump } from '@electric-sql/pglite-tools/pg_dump'
import { describe, expect, it } from 'vitest'

const AUTH_STUB = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
`

async function freshDb() {
  const db = new PGlite({ extensions: { btree_gist } })
  await db.exec(AUTH_STUB)
  return db
}

const count = async (db: PGlite, table: string) =>
  (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]?.n

describe('backup e restauração', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-'))
  const env = { ...process.env, BACKUP_PASSPHRASE: 'frase-de-teste' }

  it('um banco com dados volta inteiro, com as travas funcionando', async () => {
    const source = await freshDb()
    await source.exec(readFileSync('supabase/migrations/0001_schema.sql', 'utf8'))
    await source.exec(readFileSync('supabase/migrations/0002_gmail_outbox.sql', 'utf8'))
    await source.exec(`
      insert into barbers (id, name, service_bps, product_bps) values ('00000000-0000-0000-0000-00000000000a', 'Ana', 5000, 1000);
      insert into clients (id, name, phone) values ('00000000-0000-0000-0000-00000000000b', 'João Ação', '11999990001');
      insert into transactions (type, category, amount_cents, method, description) values ('in', 'venda', 12345, 'pix', 'Venda');
      insert into appointments (client_id, barber_id, service_ids, starts_at, ends_at) values
        ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a', array[gen_random_uuid()], '2026-03-03T13:00Z', '2026-03-03T13:30Z');
      insert into sales (id, barber_id, subtotal_cents, discount_cents, total_cents) values ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000a', 5000, 0, 5000);
      update appointments set sale_id = '00000000-0000-0000-0000-00000000000c', status = 'completed';
    `)

    const dumped = await pgDump({ pg: source, args: ['--schema=public', '--no-owner', '--no-privileges'] })
    const plain = join(dir, 'dump.sql')
    writeFileSync(plain, await dumped.text())

    const file = join(dir, 'backup.enc')
    execFileSync('scripts/backup.sh', [file], { env: { ...env, DUMP_CMD: `cat ${plain}` } })
    expect(statSync(file).size).toBeGreaterThan(1024)
    expect(readFileSync(file).includes('João')).toBe(false)

    const sql = execFileSync('scripts/restore.sh', [file], { env, maxBuffer: 1e8 }).toString()
    const target = await freshDb()
    await target.exec('create extension if not exists btree_gist')
    // Comandos \restrict são do psql; o Postgres embutido não os interpreta.
    await target.exec(sql.replace(/^\\(un)?restrict .*$/gm, ''))
    // O dump zera o search_path da conexão; uma conexão nova, como a do app, já vem com o padrão.
    await target.exec('set search_path = public')

    for (const table of ['barbers', 'clients', 'transactions', 'appointments', 'sales']) {
      expect(await count(target, table)).toBe(await count(source, table))
    }
    expect((await target.query<{ name: string }>('select name from clients')).rows[0]?.name).toBe('João Ação')
    expect((await target.query<{ amount_cents: number }>('select amount_cents from transactions')).rows[0]?.amount_cents).toBe(12345)

    await expect(
      target.exec(`insert into appointments (client_id, barber_id, service_ids, starts_at, ends_at) values
        ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a', array[gen_random_uuid()], '2026-03-03T13:10Z', '2026-03-03T13:20Z')`),
    ).rejects.toThrow(/no_double_booking/)
    await expect(target.exec('delete from transactions')).rejects.toThrow(/apagados/)
    const policies = await target.query<{ n: number }>(`select count(*)::int as n from pg_policies`)
    const original = await source.query<{ n: number }>(`select count(*)::int as n from pg_policies`)
    expect(policies.rows[0]?.n).toBe(original.rows[0]?.n)
  })

  it('senha errada não abre o backup', () => {
    const file = join(dir, 'backup.enc')
    const r = spawnSync('scripts/restore.sh', [file], { env: { ...env, BACKUP_PASSPHRASE: 'outra' } })
    expect(r.status).not.toBe(0)
  })

  it('dump vazio é recusado em vez de passar em silêncio', () => {
    const r = spawnSync('scripts/backup.sh', [join(dir, 'vazio.enc')], { env: { ...env, DUMP_CMD: 'true' } })
    expect(r.status).not.toBe(0)
    expect(r.stderr.toString()).toContain('suspeito')
  })

  it('dump que quebra no meio não vira backup', () => {
    const r = spawnSync('scripts/backup.sh', [join(dir, 'falha.enc')], { env: { ...env, DUMP_CMD: 'false' } })
    expect(r.status).not.toBe(0)
  })
})
