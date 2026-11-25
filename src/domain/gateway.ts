import { isValidEmail, normalizePhone } from './agenda'
import { validBirthDate } from './clients'
import { audit, base, must, type Command } from './engine'
import { fail } from './errors'
import { enqueue, welcomeMessage } from './messages'
import { formatBRL } from './money'
import { closeChargeCommission, createCharge, renewIfDue, settleCharge } from './subscriptions'
import { addDays, addMonths, brDate, dateKey } from './time'
import type { DbState, ID, Subscription } from './types'

/**
 * Clube com cobrança automática pelo Asaas, no cartão ou no Pix. Estas regras só rodam no servidor:
 * o cliente inicia pelo link público, paga no Asaas, e quem confirma é o Asaas.
 */

export type GatewayMethod = 'card' | 'pix'

/** CPF com os dígitos verificadores certos. Aceita com ou sem pontuação. */
export function validCpf(value: string): boolean {
  const d = value.replace(/\D/g, '')
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false
  const digit = (len: number) => {
    let sum = 0
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i)
    const r = (sum * 10) % 11
    return r === 10 ? 0 : r
  }
  return digit(9) === Number(d[9]) && digit(10) === Number(d[10])
}

export interface OnlineSubscription {
  subscriptionId: ID
  planName: string
  amountCents: number
  email: string
}

export const startOnlineSubscription: Command<
  { name: string; phone: string; email: string; birthDate: string; planId: ID; method?: GatewayMethod },
  OnlineSubscription
> = (d, i, ctx) => {
  const s = base(d)
  const phone = normalizePhone(i.phone)
  const email = i.email.trim().toLowerCase()
  if (i.name.trim().length < 2) fail('bad_name', 'Informe seu nome.')
  if (phone.length < 10 || phone.length > 11) fail('bad_phone', 'Informe um celular com DDD.')
  if (!isValidEmail(email)) fail('bad_email', 'Informe um e-mail válido.')
  if (!validBirthDate(i.birthDate, dateKey(ctx.now))) fail('bad_birthday', 'Informe sua data de nascimento.')
  const birthday = i.birthDate.slice(5)
  const plan = must(s.plans.find((p) => p.id === i.planId), 'Plano')
  if (!plan.active) fail('inactive_plan', 'Este plano não está disponível.')

  let client = d.clients.find((c) => c.phone === phone)
  if (client) {
    if (!client.email) client.email = email
    if (!client.birthDate) {
      client.birthDate = i.birthDate
      client.birthday = birthday
    } else client.birthday = client.birthDate.slice(5)
  } else {
    client = { id: ctx.id(), name: i.name.trim(), phone, email, birthDate: i.birthDate, birthday, notes: '', marketingOptIn: false, stamps: 0, rewards: 0, createdAt: ctx.now }
    d.clients.push(client)
    enqueue(d, ctx, welcomeMessage(client))
  }
  const clientId = client.id
  if (d.subscriptions.some((x) => x.clientId === clientId && (x.status === 'active' || x.status === 'past_due'))) {
    fail('already_subscribed', 'Você já é assinante. Fale com a barbearia para trocar de plano.')
  }
  // Quem desistiu no meio do pagamento pode tentar de novo: a tentativa antiga sai.
  for (const old of d.subscriptions) {
    if (old.clientId === clientId && old.status === 'pending') {
      old.status = 'cancelled'
      old.cancelledAt = ctx.now
    }
  }
  const today = dateKey(ctx.now)
  const sub: Subscription = {
    id: ctx.id(), clientId, planId: plan.id, status: 'pending', startedAt: ctx.now, periodStart: today,
    periodEnd: addMonths(today, 1), usedVisits: 0, autoRenew: true, cancelledAt: null,
    gateway: { provider: 'asaas', checkoutId: null, externalId: null, method: i.method === 'pix' ? 'pix' : 'card' },
  }
  d.subscriptions.push(sub)
  audit(d, ctx, 'assinatura.online.iniciar', sub.id)
  return { subscriptionId: sub.id, planName: plan.name, amountCents: plan.priceCents, email }
}

export const linkGateway: Command<{ subscriptionId: ID; checkoutId?: string; externalId?: string; pixAutomatic?: 'offered' | 'off' }> = (d, i) => {
  const sub = must(d.subscriptions.find((x) => x.id === i.subscriptionId), 'Assinatura')
  if (!sub.gateway) fail('not_gateway', 'Assinatura sem cobrança automática.')
  if (i.checkoutId) sub.gateway.checkoutId = i.checkoutId
  if (i.externalId) sub.gateway.externalId = i.externalId
  if (i.pixAutomatic && !sub.gateway.pixAutomatic) sub.gateway.pixAutomatic = i.pixAutomatic
}

/** Como o Asaas se refere à assinatura: pela assinatura dele, pelo checkout ou pelo nosso código. */
export interface GatewayRef {
  externalId?: string | null
  checkoutId?: string | null
  subscriptionId?: string | null
}

function findByGateway(subs: Subscription[], ref: GatewayRef) {
  const sub = subs.find(
    (x) =>
      x.gateway &&
      ((ref.externalId && x.gateway.externalId === ref.externalId) ||
        (ref.checkoutId && x.gateway.checkoutId === ref.checkoutId) ||
        (ref.subscriptionId && x.id === ref.subscriptionId)),
  )
  if (sub?.gateway && ref.externalId && !sub.gateway.externalId) sub.gateway.externalId = ref.externalId
  return sub
}

export type PaymentResult = 'activated' | 'paid' | 'duplicate' | 'unknown'

/**
 * Pagamento confirmado no Asaas. Seguro para o mesmo aviso chegar várias vezes.
 * feeCents é a taxa real cobrada pelo Asaas (valor menos o líquido); sem ela, vale a taxa dos Ajustes.
 */
export const recordGatewayPayment: Command<GatewayRef & { paymentId: string; amountCents: number; feeCents?: number | null }, PaymentResult> = (d, i, ctx) => {
  if (!Number.isInteger(i.amountCents) || i.amountCents <= 0) fail('bad_amount', 'Valor de pagamento inválido.')
  const fee = Number.isInteger(i.feeCents) && (i.feeCents as number) >= 0 && (i.feeCents as number) <= i.amountCents ? (i.feeCents as number) : undefined
  if (d.charges.some((c) => c.gatewayPaymentId === i.paymentId)) return 'duplicate'
  const sub = findByGateway(d.subscriptions, i)
  if (!sub) return 'unknown'
  const today = dateKey(ctx.now)
  const s = base(d)
  const pix = sub.gateway?.method === 'pix'
  const method = pix ? 'pix' : 'credit'

  if (sub.status === 'pending') {
    sub.status = 'active'
    sub.startedAt = ctx.now
    sub.periodStart = today
    sub.periodEnd = addMonths(today, 1)
    sub.usedVisits = 0
    const charge = createCharge(d, ctx, sub, i.amountCents)
    settleCharge(d, ctx, charge, method, fee)
    charge.gatewayPaymentId = i.paymentId
    const client = s.clients.find((c) => c.id === sub.clientId) ?? d.clients.find((c) => c.id === sub.clientId)
    const plan = s.plans.find((p) => p.id === sub.planId)
    if (client) {
      enqueue(d, ctx, {
        to: client.email, clientId: client.id, kind: 'club_welcome', subject: 'Bem-vindo ao clube! 👑',
        body: `${client.name.split(' ')[0]}, sua assinatura está ativa. Agora é só aproveitar!\nPlano: ${plan?.name ?? 'Clube'}\nValor: ${formatBRL(i.amountCents)} por mês\nRenova em: ${brDate(sub.periodEnd)}\n${pix ? 'A mensalidade vem pelo Pix todo mês. Se você autorizou o Pix Automático no app do banco, ela é paga sozinha.' : 'A cobrança é automática no seu cartão.'} Para cancelar, fale com a barbearia.`,
        dedupeKey: `club_welcome:${sub.id}`,
      })
      enqueue(d, ctx, {
        channel: 'push', to: 'equipe', clientId: null, kind: 'new_subscriber', subject: 'Novo assinante',
        body: `${client.name} assinou o ${plan?.name ?? 'clube'}`, dedupeKey: `new_subscriber:${sub.id}`,
      })
    }
    audit(d, ctx, 'assinatura.online.ativar', sub.id, `pagamento=${i.paymentId}`)
    return 'activated'
  }

  renewIfDue(d, ctx, sub, today)
  const open = d.charges
    .filter((c) => c.subscriptionId === sub.id && c.status === 'pending')
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart))[0]
  // Sem cobrança em aberto, o dinheiro paga o próximo mês. A renovação não cria outra depois.
  const charge = open ?? createCharge(d, ctx, sub, i.amountCents, { start: sub.periodEnd, end: addMonths(sub.periodEnd, 1) })
  if (charge.amountCents !== i.amountCents) charge.amountCents = i.amountCents
  settleCharge(d, ctx, charge, method, fee)
  charge.gatewayPaymentId = i.paymentId
  if (sub.status === 'past_due' && !d.charges.some((c) => c.subscriptionId === sub.id && c.status === 'pending')) sub.status = 'active'
  closeChargeCommission(d, ctx, charge, today)
  audit(d, ctx, 'assinatura.online.pagamento', sub.id, `pagamento=${i.paymentId}`)
  return 'paid'
}

/** Mudança de situação vinda do Asaas: assinatura removida ou checkout abandonado. */
export const syncGatewayStatus: Command<GatewayRef & { status: 'cancelled' | 'linked' }> = (d, i, ctx) => {
  const sub = findByGateway(d.subscriptions, i)
  if (!sub) return
  if (i.status === 'cancelled' && sub.gateway) sub.gateway.remoteClosed = true
  if (i.status === 'cancelled' && sub.status !== 'cancelled') {
    sub.autoRenew = false
    // Quem já pagou o mês continua com o benefício até o fim do período.
    if (sub.status === 'pending' || sub.status === 'past_due') {
      sub.status = 'cancelled'
      sub.cancelledAt = ctx.now
      for (const c of d.charges) if (c.subscriptionId === sub.id && c.status === 'pending') c.status = 'void'
    }
    audit(d, ctx, 'assinatura.online.cancelada', sub.id)
  }
}

/** Estorno feito no Asaas: a mensalidade sai da receita, uma vez só. */
export const recordGatewayRefund: Command<{ paymentId: string }, boolean> = (d, i, ctx) => {
  const charge = d.charges.find((c) => c.gatewayPaymentId === i.paymentId)
  if (!charge || charge.gatewayRefunded) return false
  charge.gatewayRefunded = true
  d.transactions.push({
    id: ctx.id(), type: 'out', category: 'assinatura', amountCents: charge.amountCents, method: 'credit', at: ctx.now,
    description: 'Estorno de mensalidade no Asaas', saleId: null, reversalOf: null, reversed: false,
  })
  enqueue(d, ctx, {
    channel: 'push', to: 'equipe', clientId: null, kind: 'new_subscriber', subject: 'Mensalidade estornada',
    body: `Um estorno de ${formatBRL(charge.amountCents)} foi feito no Asaas.`, dedupeKey: `refund:${i.paymentId}`,
  })
  audit(d, ctx, 'assinatura.online.estorno', charge.subscriptionId, `pagamento=${i.paymentId}`)
  return true
}

/** Quem abriu o pagamento e não concluiu em 2 dias sai da lista. */
export function expireAbandoned(subs: Subscription[], now: string) {
  const limit = addDays(dateKey(now), -2)
  for (const sub of subs) {
    if (sub.status === 'pending' && dateKey(sub.startedAt) < limit) {
      sub.status = 'cancelled'
      sub.cancelledAt = now
    }
  }
}

const clientName = (d: DbState, sub: Subscription) => d.clients.find((c) => c.id === sub.clientId)?.name ?? 'Um assinante'

function findByAuthorization(subs: Subscription[], externalId: string | null | undefined, authorizationId: string) {
  return subs.find(
    (x) => x.gateway?.method === 'pix' && ((externalId && x.gateway.externalId === externalId) || x.gateway.pixAuthorizationId === authorizationId),
  )
}

/**
 * Situação da autorização do Pix Automático. Os avisos podem chegar fora de ordem:
 * uma autorização que já foi aprovada não volta para "aguardando".
 */
export const syncPixAuthorization: Command<{ externalId?: string | null; authorizationId: string; status: 'offered' | 'active' | 'off' }> = (d, i, ctx) => {
  const sub = findByAuthorization(d.subscriptions, i.externalId, i.authorizationId)
  if (!sub?.gateway) return
  const g = sub.gateway
  const same = !g.pixAuthorizationId || g.pixAuthorizationId === i.authorizationId
  if (i.status === 'offered') {
    // Autorização nova depois de uma que expirou: volta a esperar o cliente.
    if (!g.pixAutomatic || g.pixAutomatic === 'offered' || (g.pixAutomatic === 'off' && !same)) {
      g.pixAutomatic = 'offered'
      g.pixAuthorizationId = i.authorizationId
    }
    return
  }
  if (!same && i.status === 'off') return
  const before = g.pixAutomatic
  g.pixAutomatic = i.status
  g.pixAuthorizationId = i.authorizationId
  audit(d, ctx, i.status === 'active' ? 'assinatura.pix.autorizado' : 'assinatura.pix.encerrado', sub.id)
  if (i.status === 'off' && before === 'active' && sub.status !== 'cancelled') {
    enqueue(d, ctx, {
      channel: 'push', to: 'equipe', clientId: null, kind: 'new_subscriber', subject: 'Pix Automático cancelado',
      body: `${clientName(d, sub)} cancelou o Pix Automático no banco. As próximas mensalidades chegam por Pix para ele pagar.`,
      dedupeKey: `pix_off:${i.authorizationId}`,
    })
  }
}

/** O banco do cliente recusou o débito do mês, por exemplo por falta de saldo. A cobrança continua em aberto. */
export const recordPixRefused: Command<{ authorizationId: string; instructionId: string }> = (d, i, ctx) => {
  const sub = findByAuthorization(d.subscriptions, null, i.authorizationId)
  if (!sub) return
  enqueue(d, ctx, {
    channel: 'push', to: 'equipe', clientId: null, kind: 'new_subscriber', subject: 'Pix Automático recusado',
    body: `O banco de ${clientName(d, sub)} recusou o débito da mensalidade. Ela ficou em aberto; vale chamar o cliente.`,
    dedupeKey: `pix_refused:${i.instructionId}`,
  })
  audit(d, ctx, 'assinatura.pix.recusado', sub.id, `instrucao=${i.instructionId}`)
}

/** Assinaturas no Pix que saíram do app mas ainda existem no Asaas e precisam ser apagadas lá. */
export function remoteToClose(subs: Subscription[]): { id: ID; externalId: string }[] {
  return subs
    .filter((x) => x.status === 'cancelled' && x.gateway?.method === 'pix' && x.gateway.externalId && !x.gateway.remoteClosed)
    .map((x) => ({ id: x.id, externalId: x.gateway?.externalId as string }))
}

export const markRemoteClosed: Command<{ subscriptionId: ID }> = (d, i) => {
  const g = d.subscriptions.find((x) => x.id === i.subscriptionId)?.gateway
  if (g) g.remoteClosed = true
}
