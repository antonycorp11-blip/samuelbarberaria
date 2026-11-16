import { beforeEach, describe, expect, it } from 'vitest'
import { commandName } from '../src/domain/commands'
import { createAppointment, onlineSlots } from '../src/domain/agenda'
import { upsertClient } from '../src/domain/clients'
import { run, type Ctx } from '../src/domain/engine'
import { claimMessages, pickOutbox, settleMessage } from '../src/domain/outbox'
import { checkout } from '../src/domain/sales'
import { applyChanges, diffState, viewFor, type Change } from '../src/domain/sync'
import { addDays, dateKey, toISO } from '../src/domain/time'
import { emptyState, type DbState, type Message } from '../src/domain/types'
import { deliver, describeError, handleApi, sendPush, type Deps, type Env, type Notification } from '../worker/api'
import { renderEmail } from '../worker/email'
import { isAccountProblem, MAX_ATTEMPTS, processOutbox, type OutboxDeps, type OutboxMessage } from '../worker/outbox'
import { createSession, readSession } from '../worker/session'
import { ConflictError, ServerStore, type Database, type StoreDb } from '../worker/store'
import { assertInvariants, setup } from './helpers'

/** Banco em memória com o mesmo contrato do Postgres. */
class FakeDb implements StoreDb {
  rows = new Map<string, { c: string; id: string; data: unknown; version: number }>()
  version = 0
  staff = new Map<string, { password: string; role: string; barberId: string | null; name: string }>()
  beforePush?: () => void

  async pull(since: number) {
    const changes = [...this.rows.values()].filter((r) => r.version > since).map(({ c, id, data }) => ({ c, id, data }))
    return { version: this.version, changes: structuredClone(changes) as Change[] }
  }
  async push(expected: number, changes: Change[]) {
    this.beforePush?.()
    if (expected !== this.version) throw new ConflictError()
    this.version += 1
    for (const ch of changes) this.rows.set(`${ch.c}:${ch.id}`, { ...ch, data: structuredClone(ch.data), version: this.version })
    return this.version
  }
  staffCount = async () => this.staff.size
  setStaff = async (s: { email: string; password: string; role: string; barberId: string | null; name: string }) => {
    this.staff.set(s.email, s)
    return null
  }
  staffInfo = async (email: string) => {
    const s = this.staff.get(email)
    return s ? { role: s.role as 'owner' | 'barber', name: s.name } : null
  }
  login = async (email: string, password: string) => {
    const s = this.staff.get(email)
    if (!s || s.password !== password) return null
    return { role: s.role as 'owner' | 'barber', barberId: s.barberId, name: s.name, email }
  }
}

const env: Env = {
  TEST_KEY: 'instalar', SESSION_SECRET: 'sessao', GMAIL_USER: 'a@gmail.com', GMAIL_APP_PASSWORD: 'x', ONESIGNAL_APP_ID: 'app', ONESIGNAL_REST_API_KEY: 'rest',
  ASAAS_API_KEY: '$aact_teste', ASAAS_WEBHOOK_TOKEN: 'token-do-webhook-com-mais-de-32-caracteres', APP_URL: 'https://app.test',
}

/** Asaas simulado: checkout que vira assinatura depois de pago, cobranças e consultas como a API real. */
class FakeAsaas {
  checkouts = new Map<string, { id: string; externalReference: string; value: number; paid: boolean }>()
  subscriptions = new Map<string, { id: string; status: string; deleted: boolean; checkoutSession: string; externalReference: string | null; value: number }>()
  payments = new Map<string, { id: string; status: string; value: number; subscription: string; externalReference: string | null }>()
  calls: string[] = []
  apiKeys = new Set<string>()
  handle(url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) {
    const path = url.replace('https://api.asaas.com/v3', '')
    this.calls.push(`${init.method ?? 'GET'} ${path}`)
    this.apiKeys.add(init.headers?.access_token ?? '')
    if (path === '/checkouts' && init.method === 'POST') {
      const b = JSON.parse(init.body ?? '{}') as { externalReference: string; items: { value: number }[]; chargeTypes: string[]; billingTypes: string[] }
      if (!b.chargeTypes.includes('RECURRENT') || b.billingTypes.join() !== 'CREDIT_CARD') return Response.json({ errors: [{ description: 'inválido' }] }, { status: 400 })
      const id = `chk-${this.checkouts.size + 1}`
      this.checkouts.set(id, { id, externalReference: b.externalReference, value: b.items[0]!.value, paid: false })
      return Response.json({ id })
    }
    const sub = path.match(/^\/subscriptions\/(.+)$/)
    if (sub) {
      const found = this.subscriptions.get(sub[1] as string)
      if (!found) return Response.json({ errors: [{ description: 'não encontrada' }] }, { status: 404 })
      if (init.method === 'DELETE') {
        found.deleted = true
        return Response.json({ deleted: true, id: found.id })
      }
      return Response.json(found)
    }
    const pay = path.match(/^\/payments\/(.+)$/)
    if (pay) {
      const found = this.payments.get(pay[1] as string)
      return found ? Response.json(found) : Response.json({ errors: [{ description: 'não encontrada' }] }, { status: 404 })
    }
    return Response.json({ errors: [{ description: 'rota desconhecida' }] }, { status: 404 })
  }
  /** O cliente concluiu o checkout: o Asaas cria a assinatura dele. Como no real, ela pode vir sem a nossa referência. */
  completeCheckout(checkoutId: string, keepReference = false) {
    const chk = this.checkouts.get(checkoutId)!
    chk.paid = true
    const id = `sub_${this.subscriptions.size + 1}`
    this.subscriptions.set(id, { id, status: 'ACTIVE', deleted: false, checkoutSession: checkoutId, externalReference: keepReference ? chk.externalReference : null, value: chk.value })
    return id
  }
  /** Uma cobrança da assinatura no cartão. */
  charge(subscriptionId: string, status = 'CONFIRMED') {
    const s = this.subscriptions.get(subscriptionId)!
    const id = `pay_${this.payments.size + 1}`
    this.payments.set(id, { id, status, value: s.value, subscription: subscriptionId, externalReference: null })
    return id
  }
}

function asaasWebhook(event: string, body: Record<string, unknown>, token = 'token-do-webhook-com-mais-de-32-caracteres') {
  return new Request('https://app.test/api/asaas/webhook', {
    method: 'POST',
    headers: { 'asaas-access-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: `evt_${crypto.randomUUID()}`, event, ...body }),
  })
}

function server() {
  const db = new FakeDb()
  const mails: Notification[] = []
  const work: Promise<unknown>[] = []
  const pushes: string[] = []
  const gateway = new FakeAsaas()
  const deps: Deps = {
    env, db: db as unknown as Database, store: new ServerStore(db),
    sendEmail: async (_e, n) => void mails.push(n),
    http: (async (u: string, init: { body: string; method?: string; headers?: Record<string, string> }) => {
      if (String(u).startsWith('https://api.asaas.com')) return gateway.handle(String(u), init as never)
      pushes.push((JSON.parse(init.body) as { contents: { pt: string } }).contents.pt)
      return Response.json({ id: 'ok' })
    }) as unknown as typeof fetch,
    later: (p) => void work.push(p),
  }
  const call = async (path: string, opts: { token?: string; body?: unknown } = {}) => {
    const res = await handleApi(new Request(`https://app.test${path}`, {
      method: opts.body === undefined ? 'GET' : 'POST',
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }), deps)
    await Promise.all(work)
    return { status: res.status, data: (await res.json()) as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const install = async () => {
    const r = await call('/api/auth/setup', { body: { key: 'instalar', email: 'dono@teste.com', password: 'senha-forte', name: 'Samuel' } })
    return r.data.token as string
  }
  const state = async (token: string) => {
    const r = await call('/api/sync?since=0', { token })
    return applyChanges(emptyState(), r.data.changes as Change[])
  }
  const webhook = async (req: Request) => {
    const res = await handleApi(req, deps)
    await Promise.all(work)
    return res.status
  }
  return { db, deps, mails, pushes, gateway, call, install, state, webhook }
}

function nextOpenSlot(s: DbState) {
  const barber = s.barbers[0]!
  const now = new Date().toISOString()
  for (let i = 1; i < 10; i++) {
    const date = addDays(dateKey(now), i)
    const slot = onlineSlots(s, barber.id, date, 30, now)[0]
    if (slot) return slot
  }
  throw new Error('sem horário')
}

describe('sincronização', () => {
  it('o que muda de um lado chega igual do outro', () => {
    const a = setup()
    const before = a.w.state
    a.w.do(checkout, { clientId: a.joao, barberId: a.ana, items: [{ kind: 'service', refId: a.cut, qty: 1 }], payments: [{ method: 'pix', amountCents: 5000 }] })
    const merged = applyChanges(before, diffState(before, a.w.state))
    expect(JSON.parse(JSON.stringify({ ...merged, audit: 0 }))).toEqual(JSON.parse(JSON.stringify({ ...a.w.state, audit: 0 })))
    expect(assertInvariants(merged)).toEqual([])
  })

  it('remoção vira exclusão no outro lado', () => {
    const s: DbState = { ...emptyState(), blocks: [{ id: 'b', barberId: null, start: 'a', end: 'b', reason: '' }] }
    const next = { ...s, blocks: [] }
    expect(diffState(s, next)).toEqual([{ c: 'blocks', id: 'b', data: null }])
    expect(applyChanges(s, diffState(s, next)).blocks).toEqual([])
  })

  it('barbeiro não recebe caixa nem números dos colegas', () => {
    const changes: Change[] = [
      { c: 'transactions', id: 't', data: {} },
      { c: 'audit', id: 'a', data: {} },
      { c: 'commissions', id: 'mine', data: { barberId: 'b1' } },
      { c: 'commissions', id: 'other', data: { barberId: 'b2' } },
      { c: 'sales', id: 'other', data: { barberId: 'b2' } },
      { c: 'clients', id: 'c', data: {} },
    ]
    const seen = viewFor({ role: 'barber', barberId: 'b1', name: 'x' }, changes).map((c) => `${c.c}:${c.id}`)
    expect(seen).toEqual(['commissions:mine', 'clients:c'])
  })
})

describe('servidor como autoridade', () => {
  let s: ReturnType<typeof server>
  let token: string
  beforeEach(async () => {
    s = server()
    token = await s.install()
  })

  it('agendamento de um aparelho aparece no outro: o caso do Gilmar', async () => {
    const pub = (await s.call('/api/public/state')).data as DbState
    const slot = nextOpenSlot(pub)
    const service = pub.services[0]!
    const r = await s.call('/api/public/book', {
      body: { name: 'Gilmar Teste', phone: '11977776666', email: 'gilmar@teste.com', serviceIds: [service.id], barberId: slot.barberId, start: slot.start },
    })
    expect(r.status).toBe(200)
    const owner = await s.state(token)
    expect(owner.clients.map((c) => c.name)).toContain('Gilmar Teste')
    expect(owner.appointments.length).toBe(1)
    expect(s.mails.map((m) => m.to)).toEqual(['gilmar@teste.com', 'gilmar@teste.com'])
    expect(s.pushes[0]).toContain('Gilmar Teste')
    expect(owner.messages.every((m) => m.status === 'sent')).toBe(true)
  })

  it('link público não entrega dado de cliente nem financeiro', async () => {
    const st = await s.state(token)
    const start = nextOpenSlot(st).start
    await s.call('/api/command', { token, body: { name: 'upsertClient', input: { name: 'Cliente Secreto', phone: '11988887777', email: 'secreto@teste.com', birthday: null, notes: 'nota privada', marketingOptIn: false } } })
    const fresh = await s.state(token)
    await s.call('/api/command', { token, body: { name: 'createAppointment', input: { clientId: fresh.clients[0]!.id, barberId: fresh.barbers[0]!.id, serviceIds: [fresh.services[0]!.id], start, notes: 'nota da agenda' } } })
    const raw = JSON.stringify((await s.call('/api/public/state')).data)
    expect(raw).not.toMatch(/Secreto|secreto@|nota|11988887777/)
    expect(JSON.parse(raw).clients).toEqual([])
    expect(JSON.parse(raw).appointments.length).toBe(1)
  })

  it('segundo cliente no mesmo horário perde', async () => {
    const pub = (await s.call('/api/public/state')).data as DbState
    const slot = nextOpenSlot(pub)
    const base = { serviceIds: [pub.services[0]!.id], barberId: slot.barberId, start: slot.start, email: 'a@teste.com' }
    expect((await s.call('/api/public/book', { body: { ...base, name: 'Primeiro', phone: '11977776666' } })).status).toBe(200)
    const second = await s.call('/api/public/book', { body: { ...base, name: 'Segundo', phone: '11977775555' } })
    expect(second.status).toBe(422)
    expect((await s.state(token)).clients.length).toBe(1)
  })

  it('comando concorrente é refeito sobre a versão nova, sem perder nada', async () => {
    const other = new ServerStore(s.db)
    const ctx = (): Ctx => ({ now: new Date().toISOString(), actor: { role: 'owner', barberId: null, name: 'Dono' }, id: () => crypto.randomUUID() })
    const client = (name: string, phone: string) => ({ name, phone, email: '', birthday: null, notes: '', marketingOptIn: false })
    let once = false
    s.db.beforePush = () => {
      if (once) return
      once = true
      void other.execute(upsertClient, client('Entrou Antes', '11900000001'), ctx)
    }
    await s.call('/api/command', { token, body: { name: 'upsertClient', input: client('Depois', '11900000002') } })
    expect((await s.state(token)).clients.map((c) => c.name).sort()).toEqual(['Depois', 'Entrou Antes'])
  })

  it('o aparelho e o servidor chegam ao mesmo resultado com os mesmos ids', async () => {
    const id = crypto.randomUUID()
    const input = { name: 'Fulano', phone: '11900000003', email: '', birthday: null, notes: '', marketingOptIn: false }
    await s.call('/api/command', { token, body: { name: commandName(upsertClient), input, ids: [id] } })
    expect((await s.state(token)).clients[0]?.id).toBe(id)
  })

  it('regra violada volta como erro e nada é gravado', async () => {
    const version = s.db.version
    const r = await s.call('/api/command', { token, body: { name: 'addTransaction', input: { type: 'out', category: 'aluguel', amountCents: 0, method: 'pix', description: '' } } })
    expect(r.status).toBe(422)
    expect(s.db.version).toBe(version)
  })

  it('não executa nada fora da lista de comandos', async () => {
    for (const name of ['settleMessage', 'runAutomations', 'bookOnline', 'constructor', '__proto__', 'toString']) {
      expect((await s.call('/api/command', { token, body: { name, input: {} } })).status).toBe(400)
    }
  })

  it('entrada malformada não derruba nem grava', async () => {
    const version = s.db.version
    const r = await s.call('/api/command', { token, body: { name: 'checkout', input: null } })
    expect(r.status).toBe(500)
    expect(s.db.version).toBe(version)
    expect((await s.call('/api/public/book', { body: { name: 1 } })).status).toBe(400)
    expect((await s.call('/api/public/book', { body: { name: 'x', phone: '1', email: 'a', barberId: 'b', serviceIds: [], start: 'amanhã' } })).status).toBe(400)
  })
})

describe('acesso', () => {
  it('instala uma vez só e só com a chave', async () => {
    const s = server()
    expect((await s.call('/api/auth/state')).data).toEqual({ needsSetup: true })
    expect((await s.call('/api/auth/setup', { body: { key: 'errada', email: 'a@b.com', password: 'senha-forte', name: 'x' } })).status).toBe(403)
    await s.install()
    expect((await s.call('/api/auth/setup', { body: { key: 'instalar', email: 'b@b.com', password: 'senha-forte', name: 'x' } })).status).toBe(409)
    expect((await s.call('/api/auth/state')).data).toEqual({ needsSetup: false })
  })

  it('instalação que falha pode ser repetida', async () => {
    const s = server()
    s.db.beforePush = () => {
      throw new Error('falha no banco')
    }
    const body = { key: 'instalar', email: 'dono@teste.com', password: 'senha-forte', name: 'Samuel' }
    expect((await s.call('/api/auth/setup', { body })).status).toBe(500)
    expect(s.db.staff.size).toBe(0)
    s.db.beforePush = undefined
    expect((await s.call('/api/auth/setup', { body })).status).toBe(200)
  })

  it('nada privado responde sem login', async () => {
    const s = server()
    await s.install()
    for (const path of ['/api/sync?since=0', '/api/status']) expect((await s.call(path)).status).toBe(401)
    expect((await s.call('/api/command', { body: { name: 'upsertClient', input: {} } })).status).toBe(401)
    expect((await s.call('/api/notify', { body: {} })).status).toBe(401)
  })

  it('sessão adulterada ou vencida não vale', async () => {
    const t = await createSession({ role: 'barber', barberId: 'b', name: 'x' }, 'b@teste.com', 'sessao')
    expect(await readSession(t, 'sessao')).toEqual({ role: 'barber', barberId: 'b', name: 'x', email: 'b@teste.com' })
    const [body, sig] = t.split('.') as [string, string]
    const forged = btoa(atob(body.replaceAll('-', '+').replaceAll('_', '/')).replace('barber', 'owner')).replaceAll('=', '')
    expect(await readSession(`${forged}.${sig}`, 'sessao')).toBeNull()
    expect(await readSession(t, 'outra')).toBeNull()
    expect(await readSession(t, 'sessao', Date.now() + 31 * 86_400_000)).toBeNull()
    expect(await readSession('lixo', 'sessao')).toBeNull()
  })

  it('o papel vem da sessão, nunca do que o aparelho diz', async () => {
    const s = server()
    const owner = await s.install()
    const barberId = (await s.state(owner)).barbers[0]!.id
    const barber = await createSession({ role: 'barber', barberId, name: 'x' }, 'b@teste.com', 'sessao')
    const r = await s.call('/api/command', { token: barber, body: { name: 'addTransaction', input: { type: 'out', category: 'aluguel', amountCents: 100, method: 'pix', description: '' }, actor: { role: 'owner' } } })
    expect(r.status).toBe(422)
    expect(r.data.error.message).toMatch(/dono/)
    expect((await s.call('/api/notify', { token: barber, body: {} })).status).toBe(403)
    expect((await s.call('/api/staff', { token: barber, body: {} })).status).toBe(403)
  })

  it('a sincronização informa a identidade do banco, que muda quando o banco muda', async () => {
    const s = server()
    const owner = await s.install()
    const first = (await s.call('/api/sync?since=0', { token: owner })).data.epoch as string
    expect(first).toMatch(/^[a-f0-9]{12}$/)
    s.deps.env = { ...s.deps.env, STORE_SECRET: 'outro-banco' }
    expect((await s.call('/api/sync?since=0', { token: owner })).data.epoch).not.toBe(first)
  })

  it('barbeiro entra com a própria senha', async () => {
    const s = server()
    const owner = await s.install()
    const st = await s.state(owner)
    await s.call('/api/staff', { token: owner, body: { email: 'rafa@teste.com', password: 'outra-senha', barberId: st.barbers[0]!.id, name: 'Rafael' } })
    const r = await s.call('/api/auth/login', { body: { email: 'rafa@teste.com', password: 'outra-senha' } })
    expect(r.data.actor).toEqual({ role: 'barber', barberId: st.barbers[0]!.id, name: 'Rafael' })
    expect((await s.call('/api/auth/login', { body: { email: 'rafa@teste.com', password: 'errada' } })).status).toBe(401)
  })
})

describe('fila de envio', () => {
  const m = (id: string, kind: Message['kind'], over: Partial<Message> = {}): Message => ({
    id, channel: 'email', to: 'a@b.com', clientId: null, kind, subject: 's', body: 'b', dedupeKey: id, status: 'queued',
    createdAt: '2026-03-02T12:00:00.000Z', sentAt: null, error: null, ...over,
  })
  const now = '2026-03-02T15:00:00.000Z'
  const limits = { dailyCap: 5, marketingCap: 2, batch: 50 }

  it('campanha não passa na frente do lembrete', () => {
    const list = [m('c1', 'campaign'), m('c2', 'campaign'), m('r', 'reminder_24h')]
    expect(pickOutbox(list, now, { ...limits, batch: 2 }).map((x) => x.id)).toEqual(['r', 'c1'])
  })

  it('para no teto diário e o marketing para antes', () => {
    const sent = (id: string, kind: Message['kind']) => m(id, kind, { status: 'sent', sentAt: now })
    expect(pickOutbox([sent('a', 'campaign'), sent('b', 'campaign'), m('c', 'campaign')], now, limits)).toEqual([])
    const full = ['a', 'b', 'c', 'd', 'e'].map((x) => sent(x, 'reminder_24h'))
    expect(pickOutbox([...full, m('r', 'reminder_24h')], now, limits)).toEqual([])
  })

  it('o que saiu ontem não gasta o limite de hoje, e push não conta', () => {
    const old = ['a', 'b', 'c', 'd', 'e'].map((x) => m(x, 'reminder_24h', { status: 'sent', sentAt: '2026-03-01T12:00:00.000Z' }))
    expect(pickOutbox([...old, m('r', 'reminder_24h')], now, limits).length).toBe(1)
    expect(pickOutbox([m('p', 'low_stock', { channel: 'push' })], now, { ...limits, dailyCap: 0 }).length).toBe(1)
  })

  const ctx = (at = now): Ctx => ({ now: at, actor: { role: 'owner', barberId: null, name: 's' }, id: () => 'x' })
  const withMessages = (messages: Message[]) => ({ ...emptyState(), messages })

  it('mensagem reservada não sai duas vezes', () => {
    const first = run(withMessages([m('r', 'reminder_24h')]), claimMessages, undefined, ctx())
    expect(first.result.length).toBe(1)
    expect(run(first.state, claimMessages, undefined, ctx()).result.length).toBe(0)
  })

  it('reserva abandonada volta depois de 15 minutos', () => {
    const s = withMessages([m('r', 'booking_confirmation', { status: 'sending', claimedAt: '2026-03-02T14:30:00.000Z' })])
    expect(run(s, claimMessages, undefined, ctx()).result.length).toBe(1)
  })

  it('lembrete vencido é descartado, confirmação não', () => {
    const old = '2026-02-27T12:00:00.000Z'
    const r = run(withMessages([m('a', 'reminder_2h', { createdAt: old }), m('b', 'booking_confirmation', { createdAt: old })]), claimMessages, undefined, ctx())
    expect(r.result.map((x) => x.id)).toEqual(['b'])
    expect(r.state.messages[0]?.status).toBe('failed')
  })

  it('devolve à fila guardando as tentativas', () => {
    const r = run(withMessages([m('a', 'welcome', { status: 'sending' })]), settleMessage, { id: 'a', status: 'queued', attempts: 2, error: 'x' }, ctx())
    expect(r.state.messages[0]).toMatchObject({ status: 'queued', attempts: 2, error: 'x' })
  })

  it('duas rotinas ao mesmo tempo entregam uma vez só', async () => {
    const s = server()
    const owner = await s.install()
    await s.call('/api/command', { token: owner, body: { name: 'upsertClient', input: { name: 'Com Email', phone: '11900000004', email: 'c@teste.com', birthday: null, notes: '', marketingOptIn: false } } })
    await Promise.all([deliver(s.deps), deliver(s.deps), deliver(s.deps)])
    expect(s.mails.length).toBe(1)
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
    expect(await processOutbox(deps)).toMatchObject({ sent: 1, released: 2, stopped: true })
    expect(log).toEqual(['sent:a', 'requeue:b:-', 'requeue:c:-'])
  })

  it('endereço inválido desiste na última tentativa sem travar os outros', async () => {
    const bad = Object.assign(new Error('no such user'), { responseCode: 550, response: '550 5.1.1' })
    const { deps, log } = fake([msg('a', 'email', 0), msg('b', 'email', MAX_ATTEMPTS - 1), msg('c')], async (x) => {
      if (x.id !== 'c') throw bad
    })
    expect(await processOutbox(deps)).toMatchObject({ sent: 1, retried: 1, failed: 1 })
    expect(log).toEqual(['requeue:a:1', `failed:b:${MAX_ATTEMPTS}`, 'sent:c'])
  })

  it('reconhece problema de conta', () => {
    expect(isAccountProblem(describeError(new Error('535-5.7.8 BadCredentials')))).toBe(true)
    expect(isAccountProblem({ responseCode: 550, response: '550 5.4.5 Daily user sending limit exceeded' })).toBe(true)
    expect(isAccountProblem(describeError(new Error('550 5.1.1 mailbox unavailable')))).toBe(false)
  })
})

describe('e-mail', () => {
  const body = 'João, seu horário está garantido.\nQuando: sex, 06/11/2026 às 10:00\nCom: Rafael\nSe precisar remarcar, é só chamar.'

  it('monta quadro de detalhes, parágrafos e logo', () => {
    const html = renderEmail({ subject: 'Horário confirmado', body }, 'https://app.test', 'Samuel')
    expect(html).toContain('https://app.test/logo-email.png')
    expect(html).toContain('>Quando<')
    expect(html).toContain('sex, 06/11/2026 às 10:00')
    expect(html).toContain('Se precisar remarcar')
    expect(html).not.toContain('Agendar horário')
  })

  it('mensagem sem detalhes ganha o botão de agendar', () => {
    const html = renderEmail({ subject: 'Oi', body: 'Faz tempo!' }, 'https://app.test', 'Samuel')
    expect(html).toContain('href="https://app.test/agendar"')
  })

  it('nome de cliente não injeta HTML no e-mail', () => {
    const html = renderEmail({ subject: 'Oi <b>', body: '<script>alert(1)</script>, olá\nCom: <img src=x onerror=y>' }, 'https://app.test', 'S')
    expect(html).not.toMatch(/<script|<img src=x|<b>/)
  })

  it('confirmação traz os dados do atendimento', () => {
    const { w, ana, cut, joao } = setup()
    w.do(createAppointment, { clientId: joao, barberId: ana, serviceIds: [cut], start: toISO('2026-03-03', '10:00') })
    const m = w.state.messages.find((x) => x.kind === 'booking_confirmation')
    expect(m?.body).toContain('Quando: ter, 03/03/2026 às 10:00')
    expect(m?.body).toContain('Serviço: Corte')
    expect(m?.body).toContain('Com: Ana')
    expect(m?.body).toMatch(/Valor: R\$\s50,00/)
  })
})

describe('push', () => {
  const stub = (status: number, data: unknown) => (async () => Response.json(data, { status })) as unknown as typeof fetch
  const push: Notification = { channel: 'push', to: 'equipe', subject: 's', body: 'b' }

  it('não finge sucesso quando ninguém está inscrito', async () => {
    await expect(sendPush(env, push, stub(200, { id: '', errors: ['All included players are not subscribed'] }))).rejects.toThrow(/Nenhum aparelho.*not subscribed/)
  })

  it('mira nos aparelhos da equipe, sem depender de segmento do painel', async () => {
    let sent: Record<string, unknown> = {}
    const http = (async (_u: unknown, init: { body: string }) => {
      sent = JSON.parse(init.body) as Record<string, unknown>
      return Response.json({ id: 'abc' })
    }) as unknown as typeof fetch
    await sendPush({ ...env, APP_URL: 'https://app.test' }, push, http)
    expect(sent.include_aliases).toEqual({ external_id: ['equipe-barbearia'] })
    expect(sent.included_segments).toBeUndefined()
    expect(sent.web_url).toBe('https://app.test/agenda')
  })

  it('aviso parcial do OneSignal não vira falha falsa', async () => {
    await expect(sendPush(env, push, stub(200, { id: 'abc', errors: { invalid_aliases: { external_id: ['x'] } } }))).resolves.toBeUndefined()
  })

  it('reporta chave inválida e confirma sucesso', async () => {
    await expect(sendPush(env, push, stub(403, { errors: ['Access denied'] }))).rejects.toThrow(/OneSignal 403/)
    await expect(sendPush(env, push, stub(200, { id: 'abc' }))).resolves.toBeUndefined()
  })
})


describe('clube pelo Asaas', () => {
  async function withPlan() {
    const s = server()
    const owner = await s.install()
    const st = await s.state(owner)
    await s.call('/api/command', { token: owner, body: { name: 'upsertPlan', input: { name: 'Clube Corte', priceCents: 12900, visitsPerCycle: 4, serviceIds: [st.services[0]!.id], productDiscountBps: 1000, benefits: [] } } })
    const planId = (await s.state(owner)).plans[0]!.id
    const subscribe = () => s.call('/api/public/club/subscribe', { body: { name: 'Carlos Novo', phone: '11966665555', email: 'qualquer@email.com', planId } })
    /** Cliente pagou no checkout e o cartão foi aprovado. */
    const pay = async (checkoutId = 'chk-1') => {
      const asaasSub = s.gateway.completeCheckout(checkoutId)
      const payment = s.gateway.charge(asaasSub)
      expect(await s.webhook(asaasWebhook('PAYMENT_CONFIRMED', { payment: { id: payment, status: 'CONFIRMED' } }))).toBe(200)
      return { asaasSub, payment }
    }
    return { s, owner, planId, subscribe, pay }
  }

  it('assinar abre o checkout do Asaas: só cartão, recorrente, com o código da assinatura', async () => {
    const { s, owner, subscribe } = await withPlan()
    const r = await subscribe()
    expect(r.data.checkoutUrl).toBe('https://asaas.com/checkoutSession/show?id=chk-1')
    const st = await s.state(owner)
    expect(s.gateway.checkouts.get('chk-1')).toMatchObject({ externalReference: st.subscriptions[0]!.id, value: 129 })
    expect(st.subscriptions[0]).toMatchObject({ status: 'pending', gateway: { checkoutId: 'chk-1', externalId: null } })
    expect(s.gateway.apiKeys).toEqual(new Set(['$aact_teste']))
  })

  it('qualquer e-mail funciona: o pagamento acha o cliente pelo checkout', async () => {
    const { s, owner, subscribe, pay } = await withPlan()
    await subscribe()
    await pay()
    const st = await s.state(owner)
    expect(st.subscriptions[0]).toMatchObject({ status: 'active', gateway: { checkoutId: 'chk-1', externalId: 'sub_1' } })
    expect(st.charges[0]).toMatchObject({ status: 'paid', amountCents: 12900, gatewayPaymentId: 'pay_1' })
    expect(s.mails.map((m) => m.subject)).toContain('Bem-vindo ao clube! 👑')
    expect(s.pushes.some((p) => p.includes('Carlos Novo assinou'))).toBe(true)
  })

  it('confirmado e depois recebido (o mesmo pagamento) contam uma vez só', async () => {
    const { s, owner, subscribe, pay } = await withPlan()
    await subscribe()
    const { payment } = await pay()
    s.gateway.payments.get(payment)!.status = 'RECEIVED'
    await s.webhook(asaasWebhook('PAYMENT_RECEIVED', { payment: { id: payment } }))
    await s.webhook(asaasWebhook('PAYMENT_CONFIRMED', { payment: { id: payment } }))
    const st = await s.state(owner)
    expect(st.charges.length).toBe(1)
    expect(st.transactions.filter((t) => t.category === 'assinatura').length).toBe(1)
  })

  it('mensalidades seguintes são reconhecidas pela assinatura do Asaas', async () => {
    const { s, owner, subscribe, pay } = await withPlan()
    await subscribe()
    const { asaasSub } = await pay()
    const next = s.gateway.charge(asaasSub)
    await s.webhook(asaasWebhook('PAYMENT_CONFIRMED', { payment: { id: next } }))
    const st = await s.state(owner)
    expect(st.charges.filter((c) => c.status === 'paid').length).toBe(2)
  })

  it('aviso sem token ou com token errado é recusado e nada muda', async () => {
    const { s, owner, subscribe } = await withPlan()
    await subscribe()
    const payment = s.gateway.charge(s.gateway.completeCheckout('chk-1'))
    expect(await s.webhook(asaasWebhook('PAYMENT_CONFIRMED', { payment: { id: payment } }, 'token-errado'))).toBe(401)
    const plain = new Request('https://app.test/api/asaas/webhook', { method: 'POST', body: JSON.stringify({ event: 'PAYMENT_CONFIRMED', payment: { id: payment } }) })
    expect(await s.webhook(plain)).toBe(401)
    expect((await s.state(owner)).subscriptions[0]?.status).toBe('pending')
  })

  it('não confia no corpo do aviso: cobrança ainda pendente no Asaas não ativa', async () => {
    const { s, owner, subscribe } = await withPlan()
    await subscribe()
    const payment = s.gateway.charge(s.gateway.completeCheckout('chk-1'), 'PENDING')
    expect(await s.webhook(asaasWebhook('PAYMENT_CONFIRMED', { payment: { id: payment, status: 'CONFIRMED' } }))).toBe(200)
    expect((await s.state(owner)).subscriptions[0]?.status).toBe('pending')
  })

  it('cancelar pelo app encerra a recorrência no Asaas', async () => {
    const { s, owner, subscribe, pay } = await withPlan()
    await subscribe()
    await pay()
    const sub = (await s.state(owner)).subscriptions[0]!
    expect((await s.call('/api/command', { token: owner, body: { name: 'cancelSubscription', input: { id: sub.id } } })).status).toBe(200)
    expect(s.gateway.subscriptions.get('sub_1')?.deleted).toBe(true)
    expect((await s.state(owner)).subscriptions[0]).toMatchObject({ status: 'active', autoRenew: false })
  })

  it('assinatura removida no Asaas chega ao app', async () => {
    const { s, owner, subscribe, pay } = await withPlan()
    await subscribe()
    await pay()
    s.gateway.subscriptions.get('sub_1')!.deleted = true
    expect(await s.webhook(asaasWebhook('SUBSCRIPTION_DELETED', { subscription: { id: 'sub_1' } }))).toBe(200)
    expect((await s.state(owner)).subscriptions[0]).toMatchObject({ autoRenew: false })
  })

  it('checkout expirado cancela só quem não pagou', async () => {
    const { s, owner, subscribe } = await withPlan()
    await subscribe()
    expect(await s.webhook(asaasWebhook('CHECKOUT_EXPIRED', { checkout: { id: 'chk-1' } }))).toBe(200)
    expect((await s.state(owner)).subscriptions[0]?.status).toBe('cancelled')
  })

  it('estorno no Asaas tira o valor da receita e avisa a equipe', async () => {
    const { s, owner, subscribe, pay } = await withPlan()
    await subscribe()
    const { payment } = await pay()
    s.gateway.payments.get(payment)!.status = 'REFUNDED'
    await s.webhook(asaasWebhook('PAYMENT_REFUNDED', { payment: { id: payment } }))
    await s.webhook(asaasWebhook('PAYMENT_REFUNDED', { payment: { id: payment } }))
    const st = await s.state(owner)
    expect(st.transactions.filter((t) => t.description === 'Estorno de mensalidade no Asaas').length).toBe(1)
    expect(s.pushes.some((p) => p.includes('estorno'))).toBe(true)
  })

  it('evento desconhecido recebe 200 para o Asaas não pausar a fila', async () => {
    const { s } = await withPlan()
    expect(await s.webhook(asaasWebhook('PAYMENT_BANK_SLIP_VIEWED', { payment: { id: 'x' } }))).toBe(200)
    expect(await s.webhook(asaasWebhook('PAYMENT_CONFIRMED', { payment: { id: 'nao-existe-no-meu-app' } }))).toBe(500)
  })

  it('sem chave configurada, o clube online avisa e não cria nada', async () => {
    const { s, owner, planId } = await withPlan()
    s.deps.env = { ...s.deps.env, ASAAS_API_KEY: undefined }
    const r = await s.call('/api/public/club/subscribe', { body: { name: 'X Y', phone: '11966665555', email: 'x@teste.com', planId } })
    expect(r.status).toBe(503)
    expect((await s.state(owner)).subscriptions).toEqual([])
  })

  it('a página pública mostra os planos, mas não as assinaturas', async () => {
    const { s, subscribe } = await withPlan()
    await subscribe()
    const pub = (await s.call('/api/public/state')).data as DbState
    expect(pub.plans.map((p) => p.name)).toEqual(['Clube Corte'])
    expect(pub.subscriptions).toEqual([])
    expect(JSON.stringify(pub)).not.toContain('qualquer@email.com')
  })
})

describe('pente fino de segurança', () => {
  it('barbeiro desativado perde o acesso na hora', async () => {
    const s = server()
    const owner = await s.install()
    const st = await s.state(owner)
    const barber = st.barbers[0]!
    await s.call('/api/staff', { token: owner, body: { email: 'rafa@teste.com', password: 'senha-rafa1', barberId: barber.id, name: 'Rafa' } })
    const login = await s.call('/api/auth/login', { body: { email: 'rafa@teste.com', password: 'senha-rafa1' } })
    const token = login.data.token as string
    expect((await s.call('/api/sync?since=0', { token })).status).toBe(200)
    await s.call('/api/command', { token: owner, body: { name: 'upsertBarber', input: { ...barber, active: false } } })
    expect((await s.call('/api/sync?since=0', { token })).status).toBe(401)
  })

  it('dono troca a senha só sabendo a atual', async () => {
    const s = server()
    const owner = await s.install()
    expect((await s.call('/api/auth/password', { token: owner, body: { current: 'errada', next: 'nova-senha-1' } })).status).toBe(403)
    expect((await s.call('/api/auth/password', { token: owner, body: { current: 'senha-forte', next: 'nova-senha-1' } })).status).toBe(200)
    expect((await s.call('/api/auth/login', { body: { email: 'dono@teste.com', password: 'nova-senha-1' } })).status).toBe(200)
    expect((await s.call('/api/auth/login', { body: { email: 'dono@teste.com', password: 'senha-forte' } })).status).toBe(401)
  })

  it('senha esquecida do dono só volta com a chave de instalação, e nunca a de barbeiro', async () => {
    const s = server()
    const owner = await s.install()
    const st = await s.state(owner)
    await s.call('/api/staff', { token: owner, body: { email: 'rafa@teste.com', password: 'senha-rafa1', barberId: st.barbers[0]!.id, name: 'Rafa' } })
    expect((await s.call('/api/auth/reset', { body: { key: 'errada', email: 'dono@teste.com', password: 'outra-senha' } })).status).toBe(403)
    expect((await s.call('/api/auth/reset', { body: { key: 'instalar', email: 'rafa@teste.com', password: 'outra-senha' } })).status).toBe(404)
    expect((await s.call('/api/auth/reset', { body: { key: 'instalar', email: 'dono@teste.com', password: 'outra-senha' } })).status).toBe(200)
  })

  it('rajada nas rotas públicas é barrada pelo limitador', async () => {
    const s = server()
    await s.install()
    let count = 0
    s.deps.env = { ...s.deps.env, PUBLIC_LIMITER: { limit: async () => ({ success: ++count <= 2 }) } }
    const body = { name: 'X Y', phone: '11977776666', email: 'x@teste.com', serviceIds: [], barberId: 'b', start: 'x' }
    expect((await s.call('/api/public/book', { body })).status).toBe(400)
    expect((await s.call('/api/public/book', { body })).status).toBe(400)
    expect((await s.call('/api/public/book', { body })).status).toBe(429)
  })

  it('o Gmail nunca manda mais que o teto para o mesmo endereço no dia', async () => {
    const s = server()
    await s.install()
    const pub = (await s.call('/api/public/state')).data as DbState
    const now = new Date().toISOString()
    const date = addDays(dateKey(now), 1)
    const slots = onlineSlots(pub, pub.barbers[0]!.id, date, 30, now).slice(0, 8)
    for (const [i, slot] of slots.entries()) {
      await s.call('/api/public/book', { body: { name: `Pessoa ${i}`, phone: `1197777${String(i).padStart(4, '0')}`, email: 'vitima@teste.com', serviceIds: [pub.services[0]!.id], barberId: slot.barberId, start: slot.start } })
    }
    expect(s.mails.filter((m) => m.to === 'vitima@teste.com').length).toBe(6)
  })
})

describe('experiência do cliente', () => {
  async function booked(extra: Record<string, unknown> = {}) {
    const s = server()
    const owner = await s.install()
    const pub = (await s.call('/api/public/state')).data as DbState
    const slot = nextOpenSlot(pub)
    const r = await s.call('/api/public/book', {
      body: { name: 'Gilmar Teste', phone: '11977776666', email: 'gilmar@teste.com', serviceIds: [pub.services[0]!.id], barberId: slot.barberId, start: slot.start, ...extra },
    })
    expect(r.status).toBe(200)
    const st = await s.state(owner)
    return { s, owner, appt: st.appointments[0]!, st }
  }
  const linkFrom = (body: string) => body.match(/https:\/\/app\.test\/agendar\/cancelar\?id=([^&\s]+)&t=([a-f0-9]+)/)

  it('a confirmação sai com o link de cancelar assinado, sem a marca interna', async () => {
    const { s, appt } = await booked()
    const mail = s.mails.find((m) => m.subject.startsWith('Horário confirmado'))!
    expect(mail.body).not.toContain('{{')
    const link = linkFrom(mail.body)
    expect(link?.[1]).toBe(appt.id)
  })

  it('cliente cancela em dois toques pelo link, e o horário fica livre', async () => {
    const { s, owner } = await booked()
    const [, id, t] = linkFrom(s.mails.find((m) => m.subject.startsWith('Horário confirmado'))!.body)!
    const info = await s.call(`/api/public/appointment?id=${id}&t=${t}`)
    expect(info.data).toMatchObject({ status: 'scheduled', services: [expect.any(String)] })
    expect(JSON.stringify(info.data)).not.toMatch(/gilmar|11977776666/)
    expect((await s.call('/api/public/appointment/cancel', { body: { id, t } })).status).toBe(200)
    expect((await s.state(owner)).appointments[0]?.status).toBe('cancelled')
    expect(s.mails.some((m) => m.subject === 'Horário cancelado')).toBe(true)
  })

  it('link adulterado ou de outro horário não cancela nada', async () => {
    const { s, owner, appt } = await booked()
    const [, , t] = linkFrom(s.mails.find((m) => m.subject.startsWith('Horário confirmado'))!.body)!
    expect((await s.call('/api/public/appointment/cancel', { body: { id: appt.id, t: '0'.repeat(32) } })).status).toBe(403)
    expect((await s.call('/api/public/appointment/cancel', { body: { id: 'outro-id', t } })).status).toBe(403)
    expect((await s.call(`/api/public/appointment?id=${appt.id}`)).status).toBe(403)
    expect((await s.state(owner)).appointments[0]?.status).toBe('scheduled')
  })

  it('cupom válido do QR fica anotado no horário; cupom inexistente é ignorado', async () => {
    const s = server()
    const owner = await s.install()
    await s.call('/api/command', { token: owner, body: { name: 'upsertCoupon', input: { code: 'VOLTEI15', type: 'percent', value: 1500, minCents: 0, maxUses: null, validFrom: '2026-01-01', validTo: '2027-12-31', active: true } } })
    const pub = (await s.call('/api/public/state')).data as DbState
    const slots = onlineSlots(pub, pub.barbers[0]!.id, addDays(dateKey(new Date().toISOString()), 2), 30, new Date().toISOString())
    const base = { email: 'a@teste.com', serviceIds: [pub.services[0]!.id], barberId: pub.barbers[0]!.id }
    await s.call('/api/public/book', { body: { ...base, name: 'Com Cupom', phone: '11911112222', start: slots[0]!.start, coupon: 'voltei15' } })
    await s.call('/api/public/book', { body: { ...base, name: 'Cupom Falso', phone: '11911113333', start: slots[2]!.start, coupon: 'NAOEXISTE' } })
    const notes = (await s.state(owner)).appointments.map((a) => a.notes).sort()
    expect(notes).toEqual(['', 'Cupom: VOLTEI15'])
  })
})
