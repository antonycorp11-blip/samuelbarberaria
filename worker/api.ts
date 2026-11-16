// Servidor da barbearia. Chaves e regras finais ficam aqui, nunca no aparelho.
import { buildStarter } from '../src/data/starter'
import { bookOnline, cancelAppointment, OCCUPYING } from '../src/domain/agenda'
import { runAutomations } from '../src/domain/automations'
import { COMMANDS } from '../src/domain/commands'
import { SYSTEM_ACTOR, type Ctx } from '../src/domain/engine'
import { DomainError } from '../src/domain/errors'
import { CANCEL_MARKER } from '../src/domain/messages'
import { claimMessages, settleMessage } from '../src/domain/outbox'
import { linkGateway, recordGatewayPayment, recordGatewayRefund, startOnlineSubscription, syncGatewayStatus } from '../src/domain/gateway'
import { viewFor, type Change } from '../src/domain/sync'
import { dateKey, timeOf } from '../src/domain/time'
import { PUSH_TEAM_ID } from '../src/domain/push'
import { emptyState, type Actor, type DbState } from '../src/domain/types'
import { asaas, PAID_STATUSES, validWebhookToken, type AsaasEnv } from './asaas'
import { processOutbox, type OutboxMessage } from './outbox'
import { createSession, readSession } from './session'
import type { Database, ServerStore } from './store'

/** Limitador de requisições da Cloudflare (binding `ratelimits`). */
export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>
}

export interface Env extends AsaasEnv {
  PUBLIC_LIMITER?: RateLimiter
  AUTH_LIMITER?: RateLimiter
  TEST_KEY?: string
  SESSION_SECRET?: string
  STORE_SECRET?: string
  SUPABASE_URL?: string
  SUPABASE_KEY?: string
  GMAIL_USER?: string
  GMAIL_APP_PASSWORD?: string
  MAIL_FROM_NAME?: string
  ONESIGNAL_APP_ID?: string
  ONESIGNAL_REST_API_KEY?: string
  APP_URL?: string
  // Só para testes locais.
  SMTP_HOST?: string
  SMTP_PORT?: string
  SMTP_SECURE?: string
  ONESIGNAL_API_URL?: string
}

export interface Notification {
  channel: 'email' | 'push'
  to: string
  subject: string
  body: string
}

export type EmailSender = (env: Env, n: Notification) => Promise<void>

export interface Deps {
  env: Env
  store: ServerStore
  db: Database
  sendEmail: EmailSender
  http?: typeof fetch
  /** Trabalho que continua depois da resposta, como enviar a fila. */
  later: (work: Promise<unknown>) => void
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
const fail = (message: string, status: number) => json({ error: { message } }, status)

/** OneSignal responde 200 mesmo sem entregar a ninguém, por isso a resposta é conferida. */
export async function sendPush(env: Env, n: Notification, http: typeof fetch = fetch) {
  const res = await http(`${env.ONESIGNAL_API_URL ?? 'https://api.onesignal.com'}/notifications`, {
    method: 'POST',
    headers: { Authorization: `Key ${env.ONESIGNAL_REST_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: env.ONESIGNAL_APP_ID,
      target_channel: 'push',
      // Vai para os aparelhos ligados à equipe, sem depender dos segmentos do painel.
      include_aliases: { external_id: [PUSH_TEAM_ID] },
      headings: { en: n.subject, pt: n.subject },
      contents: { en: n.body, pt: n.body },
      web_url: env.APP_URL ? `${env.APP_URL}/agenda` : undefined,
      chrome_web_icon: env.APP_URL ? `${env.APP_URL}/icon-192.png` : undefined,
    }),
  })
  const data = (await res.json().catch(() => ({}))) as { id?: string; errors?: unknown }
  if (!res.ok) throw new Error(`OneSignal ${res.status}: ${JSON.stringify(data.errors ?? data)}`)
  if (!data.id) throw new Error(`Nenhum aparelho recebeu o push: ${JSON.stringify(data.errors ?? 'sem detalhes')}`)
}

/** Traduz a falha para o formato que a fila entende (ver isAccountProblem). */
export function describeError(e: unknown) {
  const message = e instanceof Error ? e.message : String(e)
  const auth = /\b53[45]\b|BadCredentials|Invalid credentials|authentication|Failed to authenticate/i.test(message)
  return { code: auth ? 'EAUTH' : undefined, message }
}

function parseNotification(raw: unknown): Notification | null {
  const n = raw as Partial<Notification> | null
  if (!n || (n.channel !== 'email' && n.channel !== 'push')) return null
  if (typeof n.subject !== 'string' || typeof n.body !== 'string' || typeof n.to !== 'string') return null
  if (!n.subject.trim() || !n.body.trim() || n.subject.length > 200 || n.body.length > 5000) return null
  // Quebra de linha no destinatário ou assunto permitiria injetar cabeçalhos no e-mail.
  if (/[\r\n]/.test(n.subject + n.to)) return null
  if (n.channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(n.to)) return null
  return n as Notification
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** O aparelho sugere os ids para os dois lados chegarem ao mesmo resultado. Quem define o resto é o servidor. */
function ctxFactory(actor: Actor, ids: string[] = []) {
  return (): Ctx => {
    let next = 0
    return { now: new Date().toISOString(), actor, id: () => ids[next++] ?? crypto.randomUUID() }
  }
}

const systemCtx = ctxFactory(SYSTEM_ACTOR)
const PUBLIC_ACTOR: Actor = { role: 'barber', barberId: null, name: 'Cliente (online)' }
/** Cancelamento pelo link do e-mail: o link assinado é a autorização, e vale só para aquele horário. */
const CLIENT_LINK_ACTOR: Actor = { role: 'owner', barberId: null, name: 'Cliente (link do e-mail)' }

async function cancelToken(appointmentId: string, env: Env) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET ?? ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`cancelar:${appointmentId}`)))
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function validCancelToken(appointmentId: string, token: string | null, env: Env) {
  if (!appointmentId || !token || !env.SESSION_SECRET) return false
  const expected = await cancelToken(appointmentId, env)
  if (expected.length !== token.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i)
  return diff === 0
}

/** Só o necessário para mostrar horários livres. Nenhum dado de cliente sai por aqui. */
export function publicView(s: DbState, now: string): DbState {
  const today = dateKey(now)
  return {
    ...emptyState(),
    settings: { ...s.settings, feeBps: emptyState().settings.feeBps, subscriptionCommissionBps: 0 },
    services: s.services.filter((x) => x.active),
    plans: s.plans.filter((p) => p.active),
    barbers: s.barbers
      .filter((b) => b.active)
      .map((b) => ({ ...b, email: '', phone: '', serviceBps: 0, productBps: 0 })),
    appointments: s.appointments
      .filter((a) => OCCUPYING.includes(a.status) && dateKey(a.start) >= today)
      .map((a) => ({ ...a, clientId: '', notes: '', serviceIds: [], saleId: null, source: 'staff' as const })),
    blocks: s.blocks.filter((b) => dateKey(b.end) >= today).map((b) => ({ ...b, reason: '' })),
  }
}

/** Roda as automações, se pedido, e entrega a fila. */
export async function deliver(deps: Deps, automations = false) {
  const { store, env, sendEmail, http } = deps
  if (automations) await store.execute(runAutomations, undefined, systemCtx)
  const settle = (id: string, status: 'sent' | 'failed' | 'queued', attempts?: number, error?: string) =>
    store.execute(settleMessage, { id, status, attempts, error }, systemCtx)
  const toNotification = (m: OutboxMessage): Notification => ({ channel: m.channel, to: m.recipient, subject: m.subject, body: m.body })
  const withLinks = async (n: Notification): Promise<Notification> => {
    let body = n.body
    for (const [marker, id] of [...n.body.matchAll(CANCEL_MARKER)]) {
      body = body.replace(marker, `${env.APP_URL ?? ''}/agendar/cancelar?id=${encodeURIComponent(id as string)}&t=${await cancelToken(id as string, env)}`)
    }
    return { ...n, body }
  }
  return processOutbox({
    claim: async () =>
      (await store.execute(claimMessages, undefined, systemCtx)).map((m) => ({
        id: m.id, channel: m.channel, recipient: m.to, subject: m.subject, body: m.body, attempts: m.attempts ?? 0,
      })),
    sendEmail: async (m) => {
      try {
        await sendEmail(env, await withLinks(toNotification(m)))
      } catch (e) {
        throw Object.assign(new Error(describeError(e).message), { code: describeError(e).code })
      }
    },
    sendPush: (m) => sendPush(env, toNotification(m), http),
    markSent: async (id) => void (await settle(id, 'sent')),
    requeue: async (id, attempts, error) => void (await settle(id, 'queued', attempts, error)),
    markFailed: async (id, attempts, error) => void (await settle(id, 'failed', attempts, error)),
  })
}

/** Quem dispara muitos pedidos seguidos é barrado. Sem o limitador configurado, segue sem ele. */
async function tooMany(req: Request, limiter: RateLimiter | undefined, scope: string) {
  if (!limiter) return false
  const ip = req.headers.get('cf-connecting-ip') ?? 'sem-ip'
  const { success } = await limiter.limit({ key: `${scope}:${ip}` })
  return !success
}

const LIMITED: Record<string, 'public' | 'auth'> = {
  '/api/public/book': 'public',
  '/api/public/club/subscribe': 'public',
  '/api/public/appointment/cancel': 'public',
  '/api/auth/login': 'auth',
  '/api/auth/setup': 'auth',
  '/api/auth/reset': 'auth',
}

async function publicRoutes(path: string, req: Request, deps: Deps): Promise<Response | null> {
  const { env, store, db } = deps
  const scope = req.method === 'POST' ? LIMITED[path] : undefined
  if (scope && (await tooMany(req, scope === 'public' ? env.PUBLIC_LIMITER : env.AUTH_LIMITER, scope))) {
    return fail('Muitas tentativas seguidas. Aguarde um minuto.', 429)
  }
  if (path === '/api/config' && req.method === 'GET') return json({ oneSignalAppId: env.ONESIGNAL_APP_ID ?? null })

  if (path === '/api/auth/state' && req.method === 'GET') return json({ needsSetup: (await db.staffCount()) === 0 })

  if (path === '/api/public/state' && req.method === 'GET') {
    const { state } = await store.current()
    return json(publicView(state, new Date().toISOString()))
  }

  if (path === '/api/public/book' && req.method === 'POST') {
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const serviceIds = b?.serviceIds
    if (
      !b || typeof b.name !== 'string' || typeof b.phone !== 'string' || typeof b.email !== 'string' || typeof b.barberId !== 'string' ||
      typeof b.start !== 'string' || !ISO_INSTANT.test(b.start) || !Array.isArray(serviceIds) || serviceIds.some((x) => typeof x !== 'string') ||
      b.name.length > 100 || b.phone.length > 30 || b.email.length > 200
    ) {
      return fail('Dados inválidos.', 400)
    }
    const appt = await store.execute(bookOnline, {
      name: b.name, phone: b.phone, email: b.email, serviceIds: serviceIds as string[], barberId: b.barberId, start: b.start,
      marketingOptIn: b.marketingOptIn === true, coupon: typeof b.coupon === 'string' ? b.coupon.slice(0, 20) : null,
    }, ctxFactory(PUBLIC_ACTOR))
    deps.later(deliver(deps))
    return json({ start: appt.start, end: appt.end, barberId: appt.barberId })
  }

  if (path === '/api/public/appointment' && req.method === 'GET') {
    const url = new URL(req.url)
    const id = url.searchParams.get('id') ?? ''
    if (!(await validCancelToken(id, url.searchParams.get('t'), env))) return fail('Link inválido.', 403)
    const { state } = await store.current()
    const a = state.appointments.find((x) => x.id === id)
    if (!a) return fail('Horário não encontrado.', 404)
    return json({
      start: a.start, status: a.status, shopName: state.settings.shopName, phone: state.settings.phone,
      barber: state.barbers.find((b) => b.id === a.barberId)?.name ?? '',
      services: a.serviceIds.map((s) => state.services.find((x) => x.id === s)?.name).filter(Boolean),
    })
  }

  if (path === '/api/public/appointment/cancel' && req.method === 'POST') {
    const b = (await req.json().catch(() => null)) as { id?: string; t?: string } | null
    if (!b?.id || !(await validCancelToken(b.id, b.t ?? null, env))) return fail('Link inválido.', 403)
    const { state } = await store.current()
    const a = state.appointments.find((x) => x.id === b.id)
    if (!a) return fail('Horário não encontrado.', 404)
    if (a.start <= new Date().toISOString()) return fail('Esse horário já passou.', 409)
    await store.execute(cancelAppointment, { id: a.id, reason: 'Cancelado pelo cliente no link' }, ctxFactory(CLIENT_LINK_ACTOR))
    deps.later(deliver(deps))
    return json({ ok: true })
  }

  if (path === '/api/public/club/subscribe' && req.method === 'POST') {
    const pay = asaas(env, deps.http)
    if (!pay.configured) return fail('A assinatura online ainda não está disponível. Fale com a barbearia.', 503)
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (
      !b || typeof b.name !== 'string' || typeof b.phone !== 'string' || typeof b.email !== 'string' || typeof b.planId !== 'string' ||
      b.name.length > 100 || b.phone.length > 30 || b.email.length > 200
    ) {
      return fail('Dados inválidos.', 400)
    }
    const started = await store.execute(startOnlineSubscription, { name: b.name, phone: b.phone, email: b.email, planId: b.planId }, ctxFactory(PUBLIC_ACTOR))
    const { state } = await store.current()
    const now = new Date().toISOString()
    const checkout = await pay.createCheckout({
      subscriptionId: started.subscriptionId,
      name: `${state.settings.shopName} · ${started.planName}`,
      amountCents: started.amountCents,
      firstDueDate: `${dateKey(now)} ${timeOf(now)}:00`,
      appUrl: env.APP_URL ?? '',
    })
    await store.execute(linkGateway, { subscriptionId: started.subscriptionId, checkoutId: checkout.id }, systemCtx)
    deps.later(deliver(deps))
    return json({ checkoutUrl: pay.checkoutUrl(checkout.id) })
  }

  if (path === '/api/asaas/webhook' && req.method === 'POST') return asaasWebhook(req, deps)

  if (path === '/api/auth/setup' && req.method === 'POST') {
    const b = (await req.json().catch(() => null)) as { key?: string; email?: string; password?: string; name?: string } | null
    if (!env.TEST_KEY || b?.key !== env.TEST_KEY) return fail('Chave de instalação incorreta.', 403)
    if ((await db.staffCount()) > 0) return fail('O sistema já foi instalado.', 409)
    if (!b.email || !b.password || !b.name?.trim()) return fail('Preencha nome, e-mail e senha.', 400)
    // Os dados vêm antes da conta: se algo falhar aqui, dá para instalar de novo.
    const { version } = await store.current()
    if (version === 0) await store.seed(buildStarter(new Date().toISOString(), b.name.trim()))
    await db.setStaff({ email: b.email, password: b.password, role: 'owner', barberId: null, name: b.name.trim() })
    return login(b.email, b.password, deps)
  }

  // Esqueceu a senha do dono: quem instalou o sistema redefine com a chave de instalação.
  if (path === '/api/auth/reset' && req.method === 'POST') {
    const b = (await req.json().catch(() => null)) as { key?: string; email?: string; password?: string } | null
    if (!env.TEST_KEY || b?.key !== env.TEST_KEY) return fail('Chave de instalação incorreta.', 403)
    if (!b.email || !b.password) return fail('Informe e-mail e a nova senha.', 400)
    const current = await db.staffInfo(b.email)
    if (!current || current.role !== 'owner') return fail('Esse e-mail não é de uma conta de dono.', 404)
    await db.setStaff({ email: b.email, password: b.password, role: 'owner', barberId: null, name: current.name })
    return login(b.email, b.password, deps)
  }

  if (path === '/api/auth/login' && req.method === 'POST') {
    const b = (await req.json().catch(() => null)) as { email?: string; password?: string } | null
    if (!b?.email || !b.password) return fail('Informe e-mail e senha.', 400)
    return login(b.email, b.password, deps)
  }
  return null
}

/**
 * Aviso do Asaas. O corpo nunca é usado como verdade para dinheiro: o token é conferido
 * e a cobrança é buscada de novo na API do Asaas antes de qualquer gravação.
 */
async function asaasWebhook(req: Request, deps: Deps) {
  const { env, store } = deps
  const pay = asaas(env, deps.http)
  if (!pay.configured) return fail('Asaas não configurado.', 503)
  if (!validWebhookToken(req, env.ASAAS_WEBHOOK_TOKEN)) return fail('Token inválido.', 401)
  const body = (await req.json().catch(() => ({}))) as {
    event?: string
    payment?: { id?: string }
    subscription?: { id?: string }
    checkout?: { id?: string }
  }
  const event = body.event ?? ''

  try {
    if ((event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED') && body.payment?.id) {
      const payment = await pay.getPayment(body.payment.id)
      if (PAID_STATUSES.includes(payment.status) && payment.subscription) {
        const sub = await pay.getSubscription(payment.subscription)
        await store.execute(recordGatewayPayment, {
          externalId: sub.id,
          checkoutId: sub.checkoutSession ?? null,
          subscriptionId: sub.externalReference ?? payment.externalReference ?? null,
          paymentId: payment.id,
          amountCents: Math.round(payment.value * 100),
        }, systemCtx)
        deps.later(deliver(deps))
      }
    } else if ((event === 'PAYMENT_REFUNDED' || event === 'PAYMENT_CHARGEBACK_REQUESTED') && body.payment?.id) {
      const payment = await pay.getPayment(body.payment.id)
      if (payment.status === 'REFUNDED' || event === 'PAYMENT_CHARGEBACK_REQUESTED') {
        await store.execute(recordGatewayRefund, { paymentId: payment.id }, systemCtx)
        deps.later(deliver(deps))
      }
    } else if ((event === 'SUBSCRIPTION_DELETED' || event === 'SUBSCRIPTION_INACTIVATED') && body.subscription?.id) {
      const sub = await pay.getSubscription(body.subscription.id).catch(() => null)
      if (!sub || sub.deleted || sub.status !== 'ACTIVE') {
        await store.execute(syncGatewayStatus, {
          externalId: body.subscription.id, checkoutId: sub?.checkoutSession ?? null, subscriptionId: sub?.externalReference ?? null, status: 'cancelled',
        }, systemCtx)
      }
    } else if ((event === 'CHECKOUT_EXPIRED' || event === 'CHECKOUT_CANCELED') && body.checkout?.id) {
      // Só afeta quem ainda não pagou: assinatura ativa não é cancelada por esse aviso.
      await store.execute(syncGatewayStatus, { checkoutId: body.checkout.id, status: 'cancelled' }, systemCtx)
    }
  } catch (e) {
    // Regra recusada não deve ser reenviada para sempre: o Asaas pausa a fila depois de 15 falhas.
    if (e instanceof DomainError) {
      console.error('Aviso do Asaas recusado', event, e.message)
      return json({ ok: true })
    }
    throw e
  }
  return json({ ok: true })
}

async function changePassword(req: Request, email: string, actor: Actor, deps: Deps) {
  const b = (await req.json().catch(() => null)) as { current?: string; next?: string } | null
  if (!b?.current || !b.next) return fail('Informe a senha atual e a nova.', 400)
  const staff = await deps.db.login(email, b.current)
  if (staff?.locked) return fail('Muitas tentativas. Aguarde 15 minutos.', 429)
  if (!staff?.role) return fail('Senha atual incorreta.', 403)
  await deps.db.setStaff({ email, password: b.next, role: staff.role, barberId: staff.barberId ?? null, name: staff.name ?? actor.name })
  return json({ ok: true })
}

async function login(email: string, password: string, { db, env }: Deps) {
  const staff = await db.login(email, password)
  if (staff?.locked) return fail('Muitas tentativas. Aguarde 15 minutos.', 429)
  if (!staff?.role) return fail('E-mail ou senha incorretos.', 401)
  const actor: Actor = { role: staff.role, barberId: staff.barberId ?? null, name: staff.name ?? '' }
  return json({ token: await createSession(actor, staff.email ?? email, env.SESSION_SECRET as string), actor })
}

async function privateRoutes(path: string, req: Request, actor: Actor, deps: Deps): Promise<Response> {
  const { env, store, db, sendEmail, http = fetch } = deps

  if (path === '/api/sync' && req.method === 'GET') {
    const since = Number(new URL(req.url).searchParams.get('since') ?? 0)
    const { version, changes } = await syncChanges(store, db, since)
    return json({ version, epoch: await databaseEpoch(env), changes: viewFor(actor, changes) })
  }

  if (path === '/api/command' && req.method === 'POST') {
    const b = (await req.json().catch(() => null)) as { name?: string; input?: unknown; ids?: unknown } | null
    const cmd = b?.name ? Object.hasOwn(COMMANDS, b.name) && COMMANDS[b.name] : null
    if (!cmd) return fail('Comando desconhecido.', 400)
    const ids = Array.isArray(b?.ids) ? b.ids.filter((x): x is string => typeof x === 'string' && UUID.test(x)) : []
    await store.execute(cmd, b?.input, ctxFactory(actor, ids))
    deps.later(deliver(deps))
    if (b?.name === 'cancelSubscription') {
      const { state } = await store.current()
      const sub = state.subscriptions.find((x) => x.id === (b.input as { id?: string })?.id)
      const externalId = sub?.gateway?.externalId
      // O mês pago continua valendo no app; no Asaas a recorrência para já.
      if (externalId) await asaas(env, deps.http).deleteSubscription(externalId)
    }
    return json({ ok: true })
  }

  if (actor.role !== 'owner') return fail('Somente o dono pode fazer isso.', 403)

  if (path === '/api/staff' && req.method === 'POST') {
    const b = (await req.json().catch(() => null)) as { email?: string; password?: string; barberId?: string; name?: string } | null
    if (!b?.email || !b.password || !b.barberId || !b.name) return fail('Dados incompletos.', 400)
    await db.setStaff({ email: b.email, password: b.password, role: 'barber', barberId: b.barberId, name: b.name })
    return json({ ok: true })
  }

  if (path === '/api/status' && req.method === 'GET') {
    return json({
      email: Boolean(env.GMAIL_USER && env.GMAIL_APP_PASSWORD),
      push: Boolean(env.ONESIGNAL_APP_ID && env.ONESIGNAL_REST_API_KEY),
    })
  }

  if (path === '/api/notify' && req.method === 'POST') {
    const n = parseNotification(await req.json().catch(() => null))
    if (!n) return fail('Mensagem inválida.', 400)
    try {
      await (n.channel === 'email' ? sendEmail(env, n) : sendPush(env, n, http))
      return json({ ok: true })
    } catch (e) {
      return json({ error: describeError(e) }, 502)
    }
  }
  return fail('Não encontrado.', 404)
}

/** Identidade do banco: muda quando o servidor passa a usar outro banco, como na migração de conta. */
async function databaseEpoch(env: Env) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.SUPABASE_URL}|${env.STORE_SECRET}`))
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** O aparelho pede "o que mudou desde a versão X". */
async function syncChanges(store: ServerStore, db: Database, since: number): Promise<{ version: number; changes: Change[] }> {
  const { version, changes } = await db.pull(since)
  await store.current()
  return { version, changes }
}

export async function handleApi(req: Request, deps: Deps): Promise<Response> {
  const path = new URL(req.url).pathname
  try {
    const open = await publicRoutes(path, req, deps)
    if (open) return open
    const token = req.headers.get('authorization')?.replace(/^Bearer /, '')
    const session = await readSession(token, deps.env.SESSION_SECRET as string)
    if (!session) return fail('Sessão expirada. Entre de novo.', 401)
    const { email, ...actor } = session
    // Barbeiro desativado perde o acesso na hora, mesmo com a sessão de 30 dias ainda válida.
    if (actor.role === 'barber') {
      const { state } = await deps.store.current()
      if (!state.barbers.some((b) => b.id === actor.barberId && b.active)) return fail('Acesso desativado. Fale com o dono.', 401)
    }
    if (path === '/api/auth/password' && req.method === 'POST') return changePassword(req, email, actor, deps)
    return await privateRoutes(path, req, actor, deps)
  } catch (e) {
    if (e instanceof DomainError) return json({ error: { code: e.code, message: e.message } }, 422)
    console.error(e)
    return fail('Erro no servidor. Nada foi salvo.', 500)
  }
}

