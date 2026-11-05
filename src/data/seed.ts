import { createAppointment, availableSlots, cancelAppointment, setAppointmentStatus } from '@/domain/agenda'
import { updateSettings, upsertService } from '@/domain/catalog'
import { upsertClient } from '@/domain/clients'
import { run, SYSTEM_ACTOR, type Command, type Ctx } from '@/domain/engine'
import { DomainError } from '@/domain/errors'
import { addTransaction } from '@/domain/finance'
import { upsertCoupon } from '@/domain/marketing'
import { checkout, quote, type CheckoutItem } from '@/domain/sales'
import { stockIn, upsertProduct } from '@/domain/stock'
import { payCharge, subscribe, upsertPlan } from '@/domain/subscriptions'
import { payCommissions, upsertBarber } from '@/domain/team'
import { addDays, dateKey, toISO, weekday } from '@/domain/time'
import { runAutomations } from '@/domain/automations'
import { emptyState, type DbState, type ID, type PaymentMethod } from '@/domain/types'

const NAMES = [
  'Lucas Almeida', 'Mateus Ferreira', 'Pedro Henrique', 'Gabriel Costa', 'Rafael Moura', 'Thiago Nunes', 'Bruno Carvalho',
  'André Lima', 'Felipe Rocha', 'Gustavo Dias', 'Vinícius Prado', 'Caio Mendes', 'Leonardo Reis', 'Daniel Freitas',
  'Eduardo Pires', 'Rodrigo Teixeira', 'Marcelo Barros', 'João Vitor', 'Igor Santana', 'Henrique Vaz', 'Otávio Ramos',
  'Fábio Tavares', 'Renan Cardoso', 'Murilo Azevedo', 'Alex Monteiro', 'Davi Campos', 'Samuel Pinto', 'Enzo Castro',
  'Nicolas Lopes', 'Arthur Melo', 'Heitor Duarte', 'Kaique Souza', 'Wesley Farias', 'Yuri Batista', 'Paulo Sérgio',
]

/**
 * Dados de demonstração gerados pelos próprios comandos do sistema, com o relógio
 * simulado. Assim a demo passa pelas mesmas regras da operação real.
 */
export function buildDemo(nowIso: string): DbState {
  let seed = 20260
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)] as T

  let state = emptyState()
  let n = 0
  let clock = nowIso
  const ctx = (): Ctx => ({ now: clock, actor: SYSTEM_ACTOR, id: () => `demo-${++n}` })
  const go = <I, R>(cmd: Command<I, R>, input: I): R => {
    const out = run(state, cmd, input, ctx())
    state = out.state
    return out.result
  }

  const today = dateKey(nowIso)
  const firstDay = addDays(today, -45)
  clock = toISO(firstDay, '07:00')

  go(updateSettings, { phone: '(11) 99999-0000', address: 'Endereço da barbearia' })
  const cut = go(upsertService, { name: 'Corte', priceCents: 5000, durationMin: 30 })
  const beard = go(upsertService, { name: 'Barba', priceCents: 3500, durationMin: 30 })
  const combo = go(upsertService, { name: 'Corte + Barba', priceCents: 7500, durationMin: 60 })
  const kids = go(upsertService, { name: 'Corte infantil', priceCents: 4000, durationMin: 30 })
  const brow = go(upsertService, { name: 'Sobrancelha', priceCents: 2000, durationMin: 15 })
  const paint = go(upsertService, { name: 'Pigmentação', priceCents: 6000, durationMin: 45 })

  const team = { phone: '', daysOff: [0], breakStart: '12:00', breakEnd: '13:00' }
  const barbers: ID[] = [
    go(upsertBarber, { ...team, name: 'Samuel', email: 'samuel@exemplo.com', serviceBps: 6000, productBps: 1500 }),
    go(upsertBarber, { ...team, name: 'Rafael', email: 'rafael@exemplo.com', serviceBps: 5000, productBps: 1000, breakStart: '13:00', breakEnd: '14:00' }),
    go(upsertBarber, { ...team, name: 'Diego', email: 'diego@exemplo.com', serviceBps: 4500, productBps: 1000, daysOff: [0, 1] }),
  ]

  const clients = NAMES.map((name, i) =>
    go(upsertClient, {
      name,
      phone: `1198${String(1000000 + i * 7919).slice(0, 7)}`,
      email: `${name.split(' ')[0]?.normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase()}${i}@exemplo.com`,
      birthday: `${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
      notes: i % 7 === 0 ? 'Prefere máquina 2 nas laterais.' : '',
      marketingOptIn: i % 6 !== 0,
    }),
  )

  const products = [
    { name: 'Pomada modeladora', price: 4500, cost: 1900, min: 5, qty: 26 },
    { name: 'Óleo para barba', price: 3900, cost: 1600, min: 4, qty: 20 },
    { name: 'Shampoo anticaspa', price: 3500, cost: 1500, min: 4, qty: 12 },
    { name: 'Balm hidratante', price: 4200, cost: 2000, min: 3, qty: 9 },
    { name: 'Pente de madeira', price: 2500, cost: 800, min: 3, qty: 5 },
  ].map((p) => {
    const id = go(upsertProduct, { name: p.name, salePriceCents: p.price, minQty: p.min })
    go(stockIn, { productId: id, qty: p.qty, unitCostCents: p.cost, method: 'pix', note: 'Estoque inicial' })
    return id
  })

  const planBasic = go(upsertPlan, {
    name: 'Clube Corte', priceCents: 12900, visitsPerCycle: 4, serviceIds: [cut], productDiscountBps: 1000,
    benefits: ['4 cortes por mês', '10% em produtos'],
  })
  const planFull = go(upsertPlan, {
    name: 'Clube Completo', priceCents: 19900, visitsPerCycle: null, serviceIds: [cut, beard, combo, brow], productDiscountBps: 1500,
    benefits: ['Corte e barba à vontade', 'Sobrancelha inclusa', '15% em produtos'],
  })
  go(upsertCoupon, {
    code: 'VOLTEI15', type: 'percent', value: 1500, minCents: 0, maxUses: 100, validFrom: firstDay,
    validTo: addDays(today, 60), active: true,
  })
  go(upsertCoupon, {
    code: 'AMIGO10', type: 'fixed', value: 1000, minCents: 4000, maxUses: null, validFrom: firstDay,
    validTo: addDays(today, 90), active: true,
  })

  clients.slice(0, 7).forEach((clientId, i) => {
    go(subscribe, { clientId, planId: i % 3 === 0 ? planFull : planBasic, payWith: pick(['pix', 'credit'] as const) })
  })

  const menu = [cut, cut, cut, combo, combo, beard, kids, brow, paint]
  const methods: PaymentMethod[] = ['pix', 'pix', 'pix', 'credit', 'credit', 'debit', 'cash']
  const regulars = clients.slice(0, 24)

  for (let date = firstDay; date <= today; date = addDays(date, 1)) {
    clock = toISO(date, '07:30')
    go(runAutomations, undefined)
    settlePending()
    if (date.slice(8) === '10') {
      go(addTransaction, { type: 'out', category: 'aluguel', amountCents: 280000, method: 'pix', description: 'Aluguel do salão' })
      go(addTransaction, { type: 'out', category: 'energia_agua', amountCents: 41000, method: 'pix', description: 'Luz e água' })
      go(addTransaction, { type: 'out', category: 'internet_software', amountCents: 22000, method: 'pix', description: 'Internet e sistema' })
    }
    if (weekday(date) === 1) {
      for (const p of state.products) {
        // Deixa o pente de fora para a demo mostrar o aviso de estoque baixo.
        if (p.qty <= p.minQty && p.name !== 'Pente de madeira') {
          go(stockIn, { productId: p.id, qty: 12, unitCostCents: p.avgCostCents, method: 'pix', note: 'Reposição' })
        }
      }
    }
    if (weekday(date) === 6) {
      for (const b of barbers) {
        const pending = state.commissions.filter((c) => c.barberId === b && c.status === 'pending').length
        if (pending > 0 && date < today) {
          try {
            go(payCommissions, { barberId: b, method: 'pix' })
          } catch (e) {
            if (!(e instanceof DomainError)) throw e
          }
        }
      }
    }

    const booked: { id: ID; end: string; start: string }[] = []
    for (const barberId of barbers) {
      const target = 5 + Math.floor(rand() * 6)
      for (let i = 0; i < target; i++) {
        const serviceId = pick(menu)
        const duration = state.services.find((s) => s.id === serviceId)?.durationMin ?? 30
        const slots = availableSlots(state, barberId, date, duration, clock)
        if (slots.length === 0) break
        const appt = go(createAppointment, {
          clientId: rand() < 0.75 ? pick(regulars) : pick(clients),
          barberId,
          serviceIds: [serviceId],
          start: pick(slots),
        })
        booked.push(appt)
      }
    }

    for (const b of booked.sort((x, y) => x.end.localeCompare(y.end))) {
      if (b.end > nowIso) continue
      clock = b.end
      const appt = state.appointments.find((a) => a.id === b.id)
      if (!appt) continue
      const roll = rand()
      if (roll < 0.04) go(setAppointmentStatus, { id: appt.id, status: 'no_show' })
      else if (roll < 0.09) go(cancelAppointment, { id: appt.id })
      else finish(appt.id)
    }
  }

  function finish(appointmentId: ID) {
    const appt = state.appointments.find((a) => a.id === appointmentId)
    if (!appt) return
    const items: CheckoutItem[] = appt.serviceIds.map((refId) => ({ kind: 'service', refId, qty: 1 }))
    const inStock = products.filter((id) => (state.products.find((p) => p.id === id)?.qty ?? 0) > 1)
    if (rand() < 0.16 && inStock.length) items.push({ kind: 'product', refId: pick(inStock), qty: 1 })
    const base = { appointmentId, clientId: appt.clientId, barberId: appt.barberId, items }
    const sub = state.subscriptions.find((s) => s.clientId === appt.clientId && s.status === 'active')
    const plan = sub && state.plans.find((p) => p.id === sub.planId)
    const covered =
      plan && sub && appt.serviceIds.every((id) => plan.serviceIds.includes(id)) &&
      (plan.visitsPerCycle === null || sub.usedVisits < plan.visitsPerCycle)
    const client = state.clients.find((c) => c.id === appt.clientId)
    const options = {
      ...base,
      useSubscription: Boolean(covered),
      useReward: !covered && (client?.rewards ?? 0) > 0,
      couponCode: !covered && rand() < 0.04 ? 'VOLTEI15' : undefined,
    }
    const total = quote(state, options, ctx()).totalCents
    go(checkout, { ...options, payments: total > 0 ? [{ method: pick(methods), amountCents: total }] : [] })
  }

  function settlePending() {
    for (const c of state.charges) {
      if (c.status === 'pending' && c.dueDate <= dateKey(clock)) go(payCharge, { chargeId: c.id, method: pick(['pix', 'credit'] as const) })
    }
  }

  clock = nowIso
  for (let i = 0; i < 7; i++) {
    const date = addDays(today, i)
    for (const barberId of barbers) {
      const target = i === 0 ? 3 : Math.max(1, 6 - i)
      for (let k = 0; k < target; k++) {
        const serviceId = pick(menu)
        const duration = state.services.find((s) => s.id === serviceId)?.durationMin ?? 30
        const slots = availableSlots(state, barberId, date, duration, nowIso)
        if (slots.length === 0) break
        const appt = go(createAppointment, { clientId: pick(regulars), barberId, serviceIds: [serviceId], start: pick(slots) })
        if (rand() < 0.5) go(setAppointmentStatus, { id: appt.id, status: 'confirmed' })
      }
    }
  }

  // A fila histórica só faria barulho na demo: ela recomeça com o que vale para hoje.
  state = { ...state, messages: [], audit: [] }
  go(runAutomations, undefined)
  return state
}
