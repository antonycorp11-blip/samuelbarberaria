import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { pgDump } from '@electric-sql/pglite-tools/pg_dump'
import { describe, expect, it } from 'vitest'

async function freshDb() {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto } })
  await db.exec('create role anon; create role authenticated; create schema extensions;')
  await db.exec(readFileSync('supabase/store/schema.sql', 'utf8'))
  return db
}

const count = async (db: PGlite, table: string) =>
  (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]?.n

describe('backup e restauração', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-'))
  const env = { ...process.env, BACKUP_PASSPHRASE: 'frase-de-teste' }

  it('os dados voltam inteiros num banco novo, com as travas funcionando', async () => {
    const source = await freshDb()
    await source.exec(`
      insert into barbearia.meta (version, api_secret_hash) values (2, 'hash');
      insert into barbearia.staff (email, password_hash, role, name) values ('dono@teste.com', 'x', 'owner', 'João Ação');
      insert into barbearia.entities (collection, id, version, data) values
        ('clients', 'c1', 1, '{"name": "João Ação"}'),
        ('transactions', 't1', 1, '{"amountCents": 12345}'),
        ('appointments', 'a1', 2, '{"barberId": "b1", "start": "2026-03-03T13:00:00.000Z", "end": "2026-03-03T13:30:00.000Z", "status": "scheduled"}');
    `)

    const dumped = await pgDump({ pg: source, args: ['--schema=barbearia', '--data-only', '--no-owner', '--no-privileges'] })
    const plain = join(dir, 'dump.sql')
    writeFileSync(plain, (await dumped.text()) + '\n-- '.padEnd(2000, 'x'))

    const file = join(dir, 'backup.enc')
    execFileSync('scripts/backup.sh', [file], { env: { ...env, DUMP_CMD: `cat ${plain}` } })
    expect(statSync(file).size).toBeGreaterThan(200)
    expect(readFileSync(file).includes('João')).toBe(false)

    const sql = execFileSync('scripts/restore.sh', [file], { env, maxBuffer: 1e8 }).toString()
    const target = await freshDb()
    // Comandos \\restrict são do psql; o Postgres embutido não os interpreta.
    await target.exec(sql.replace(/^\\(un)?restrict .*$/gm, ''))
    await target.exec('set search_path = public')

    for (const table of ['barbearia.entities', 'barbearia.staff', 'barbearia.meta']) {
      expect(await count(target, table)).toBe(await count(source, table))
    }
    const client = await target.query<{ name: string }>(`select data->>'name' as name from barbearia.entities where collection = 'clients'`)
    expect(client.rows[0]?.name).toBe('João Ação')
    await expect(target.exec(`insert into barbearia.entities (collection, id, version, data) values
      ('appointments', 'a2', 3, '{"barberId": "b1", "start": "2026-03-03T13:10:00.000Z", "end": "2026-03-03T13:20:00.000Z", "status": "scheduled"}')`)).rejects.toThrow(/no_double_booking/)
    await expect(target.exec(`delete from barbearia.entities where collection = 'transactions'`)).rejects.toThrow(/não pode ser apagado/)
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
