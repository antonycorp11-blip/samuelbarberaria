import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import nodemailer from 'nodemailer'
import { SMTPServer } from 'smtp-server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { isAccountProblem, mailOptions, MAX_ATTEMPTS, processOutbox, type OutboxDeps, type OutboxMessage } from '../supabase/functions/process-outbox/worker'

describe('fila no banco', () => {
  let db: PGlite
  let n = 0

  const add = (kind: string, channel = 'email', createdAt = 'now()') =>
    db.exec(`insert into messages (channel, recipient, kind, subject, body, dedupe_key, created_at)
             values ('${channel}', 'a@b.com', '${kind}', 's', 'b', 'k${++n}', ${createdAt})`)
  const claim = async (cap: number, marketing: number, batch: number) =>
    (await db.query<{ kind: string; channel: string }>(`select * from claim_messages(${cap}, ${marketing}, ${batch})`)).rows
  const send = () => db.exec(`update messages set status = 'sent', sent_at = now() where status = 'sending'`)

  beforeAll(async () => {
    db = new PGlite({ extensions: { btree_gist } })
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    `)
    await db.exec(readFileSync('supabase/migrations/0001_schema.sql', 'utf8'))
    await db.exec(readFileSync('supabase/migrations/0002_gmail_outbox.sql', 'utf8'))
  })

  beforeEach(() => db.exec('delete from messages'))

  it('campanha grande não passa na frente do lembrete', async () => {
    for (let i = 0; i < 5; i++) await add('campaign', 'email', `now() - interval '1 hour'`)
    await add('reminder_24h')
    const rows = await claim(400, 200, 3)
    expect(rows.map((r) => r.kind).sort()).toEqual(['campaign', 'campaign', 'reminder_24h'])
  })

  it('para no teto diário e o marketing para antes, deixando vaga para lembretes', async () => {
    for (let i = 0; i < 6; i++) await add('campaign')
    expect((await claim(5, 2, 50)).length).toBe(2)
    await send()
    expect((await claim(5, 2, 50)).length).toBe(0)
    for (let i = 0; i < 6; i++) await add('reminder_24h')
    expect((await claim(5, 2, 50)).length).toBe(3)
    await send()
    expect((await claim(5, 2, 50)).length).toBe(0)
  })

  it('o que passou de ontem não gasta o limite de hoje', async () => {
    await add('reminder_24h')
    await claim(1, 1, 10)
    await db.exec(`update messages set status = 'sent', sent_at = now() - interval '2 days'`)
    await add('booking_confirmation')
    expect((await claim(1, 1, 10)).length).toBe(1)
  })

  it('push não consome o limite do Gmail', async () => {
    await add('low_stock', 'push')
    expect((await claim(0, 0, 10)).map((r) => r.channel)).toEqual(['push'])
  })

  it('mensagem reservada não sai duas vezes', async () => {
    await add('reminder_24h')
    expect((await claim(10, 10, 10)).length).toBe(1)
    expect((await claim(10, 10, 10)).length).toBe(0)
  })

  it('execução que caiu devolve a reserva depois de 15 minutos', async () => {
    await add('reminder_24h')
    await claim(10, 10, 10)
    await db.exec(`update messages set claimed_at = now() - interval '20 minutes'`)
    expect((await claim(10, 10, 10)).length).toBe(1)
  })

  it('lembrete vencido é descartado, confirmação não', async () => {
    await add('reminder_2h', 'email', `now() - interval '2 days'`)
    await add('booking_confirmation', 'email', `now() - interval '2 days'`)
    expect((await claim(10, 10, 10)).map((r) => r.kind)).toEqual(['booking_confirmation'])
    const { rows } = await db.query<{ status: string }>(`select status from messages where kind = 'reminder_2h'`)
    expect(rows[0]?.status).toBe('failed')
  })

  it('limpeza apaga só mensagens antigas já resolvidas', async () => {
    await add('reminder_24h', 'email', `now() - interval '100 days'`)
    await add('campaign', 'email', `now() - interval '100 days'`)
    await db.exec(`update messages set status = 'sent' where kind = 'reminder_24h'`)
    await add('welcome')
    await db.exec(`update messages set status = 'sent' where kind = 'welcome'`)
    expect((await db.query<{ n: number }>(`select purge_old_messages() as n`)).rows[0]?.n).toBe(1)
    expect((await db.query(`select 1 from messages`)).rows.length).toBe(2)
  })

  it('visitante e barbeiro não chamam a fila', async () => {
    await db.exec('set role authenticated')
    await expect(db.exec('select * from claim_messages(1, 1, 1)')).rejects.toThrow(/permission denied for function/)
    await db.exec('reset role')
  })
})

describe('rotina de envio', () => {
  const msg = (id: string, channel: OutboxMessage['channel'] = 'email', attempts = 0): OutboxMessage => ({
    id, channel, recipient: 'a@b.com', subject: 's', body: 'b', attempts,
  })

  function fake(batch: OutboxMessage[], sendEmail: OutboxDeps['sendEmail']) {
    const log: string[] = []
    const deps: OutboxDeps = {
      claim: async () => batch,
      sendEmail,
      sendPush: async () => {},
      markSent: async (id) => void log.push(`sent:${id}`),
      requeue: async (id, attempts) => void log.push(`requeue:${id}:${attempts ?? '-'}`),
      markFailed: async (id, attempts) => void log.push(`failed:${id}:${attempts}`),
    }
    return { deps, log }
  }

  it('senha errada para o lote e devolve tudo sem gastar tentativas', async () => {
    let calls = 0
    const { deps, log } = fake([msg('a'), msg('b'), msg('c')], async () => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error('Invalid login'), { code: 'EAUTH' })
    })
    const r = await processOutbox(deps)
    expect(r).toMatchObject({ sent: 1, released: 2, stopped: true })
    expect(log).toEqual(['sent:a', 'requeue:b:-', 'requeue:c:-'])
    expect(calls).toBe(2)
  })

  it('limite do Gmail também para tudo', () => {
    expect(isAccountProblem({ responseCode: 550, response: '550 5.4.5 Daily user sending limit exceeded' })).toBe(true)
    expect(isAccountProblem({ responseCode: 550, response: '550 5.1.1 The email account does not exist' })).toBe(false)
  })

  it('endereço inválido tenta de novo e desiste na última tentativa, sem travar os outros', async () => {
    const bad = Object.assign(new Error('no such user'), { responseCode: 550, response: '550 5.1.1' })
    const { deps, log } = fake([msg('a', 'email', 0), msg('b', 'email', MAX_ATTEMPTS - 1), msg('c')], async (m) => {
      if (m.id !== 'c') throw bad
    })
    expect(await processOutbox(deps)).toMatchObject({ sent: 1, retried: 1, failed: 1, stopped: false })
    expect(log).toEqual(['requeue:a:1', `failed:b:${MAX_ATTEMPTS}`, 'sent:c'])
  })
})

describe('entrega por SMTP', () => {
  const received: string[] = []
  const server = new SMTPServer({
    secure: true,
    onAuth: (auth, _s, cb) => (auth.password === 'senha-de-app' ? cb(null, { user: 'ok' }) : cb(new Error('Invalid login'))),
    onData: (stream, _s, cb) => {
      let raw = ''
      stream.on('data', (c) => (raw += c.toString()))
      stream.on('end', () => {
        received.push(raw)
        cb()
      })
    },
  })
  let port = 0
  const transport = (pass: string) =>
    nodemailer.createTransport({ host: '127.0.0.1', port, secure: true, auth: { user: 'x@gmail.com', pass }, tls: { rejectUnauthorized: false } })

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          port = (server.server.address() as { port: number }).port
          resolve()
        })
      }),
  )
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('entrega com nome da barbearia e acentos intactos', async () => {
    const options = mailOptions({ recipient: 'joao@teste.com', subject: 'Horário confirmado', body: 'João, até às 10:00.' }, 'Samuel Barbearia', 'x@gmail.com')
    await transport('senha-de-app').sendMail(options)
    const parsed = received[0] ?? ''
    expect(parsed).toContain('From: Samuel Barbearia <x@gmail.com>')
    expect(parsed).toContain('To: joao@teste.com')
    expect(parsed).toContain('Subject: =?UTF-8?Q?Hor=C3=A1rio_confirmado?=')
    expect(parsed).toContain('Jo=C3=A3o, at=C3=A9 =C3=A0s 10:00.')
  })

  it('senha errada é reconhecida como problema da conta', async () => {
    const error = await transport('errada').sendMail(mailOptions({ recipient: 'a@b.com', subject: 's', body: 'b' }, 'n', 'x@gmail.com')).catch((e) => e)
    expect(isAccountProblem(error)).toBe(true)
  })
})
