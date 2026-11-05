import { audit, base, must, requireBarberScope, requireOwner, type Command, type Ctx } from './engine'
import { fail } from './errors'
import { appointmentMessage, enqueue } from './messages'
import { addDays, addMinutes, brDate, dateKey, minutesOf, timeFromMinutes, timeOf, toISO, weekday } from './time'
import type { Appointment, AppointmentStatus, Barber, Client, DateKey, DbState, ID, ISO } from './types'

/** Estados que ocupam o horário do barbeiro. */
export const OCCUPYING: AppointmentStatus[] = ['scheduled', 'confirmed', 'in_progress', 'completed']

const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled: ['confirmed', 'in_progress', 'cancelled', 'no_show'],
  confirmed: ['in_progress', 'cancelled', 'no_show'],
  in_progress: ['cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
}

export function canTransition(from: AppointmentStatus, to: AppointmentStatus) {
  return TRANSITIONS[from].includes(to)
}

export function durationOf(s: DbState, serviceIds: ID[]): number {
  return serviceIds.reduce((sum, id) => sum + must(s.services.find((x) => x.id === id), 'Serviço').durationMin, 0)
}

export function priceOf(s: DbState, serviceIds: ID[]): number {
  return serviceIds.reduce((sum, id) => sum + must(s.services.find((x) => x.id === id), 'Serviço').priceCents, 0)
}

/** Todos os instantes são ISO UTC no mesmo formato, então comparar texto é comparar tempo. */
const overlaps = (aStart: ISO, aEnd: ISO, bStart: ISO, bEnd: ISO) => aStart < bEnd && bStart < aEnd

const dayIndexes = new WeakMap<Appointment[], Map<DateKey, Appointment[]>>()

/** Agendamentos por dia. O estado é imutável, então o índice vale enquanto a lista for a mesma. */
export function appointmentsOn(s: DbState, date: DateKey): Appointment[] {
  let index = dayIndexes.get(s.appointments)
  if (!index) {
    index = new Map()
    for (const a of s.appointments) {
      const k = dateKey(a.start)
      const list = index.get(k)
      if (list) list.push(a)
      else index.set(k, [a])
    }
    dayIndexes.set(s.appointments, index)
  }
  return index.get(date) ?? []
}

/** Janela de trabalho do barbeiro no dia, em minutos, ou null se não trabalha. */
export function workWindow(s: DbState, barber: Barber, date: DateKey): { open: number; close: number } | null {
  const day = weekday(date)
  const hours = s.settings.hours[day]
  if (!hours || barber.daysOff.includes(day)) return null
  return { open: minutesOf(hours.open), close: minutesOf(hours.close) }
}

/** Explica por que o horário não serve, ou null se está livre. */
export function slotProblem(
  s: DbState,
  q: { barberId: ID; start: ISO; end: ISO; ignoreId?: ID },
): string | null {
  const barber = s.barbers.find((b) => b.id === q.barberId)
  if (!barber || !barber.active) return 'Profissional indisponível.'
  const date = dateKey(q.start)
  if (dateKey(addMinutes(q.end, -1)) !== date) return 'O atendimento precisa terminar no mesmo dia.'
  const win = workWindow(s, barber, date)
  if (!win) return `${barber.name} não atende neste dia.`
  const startMin = minutesOf(timeOf(q.start))
  const endMin = startMin + (new Date(q.end).getTime() - new Date(q.start).getTime()) / 60000
  if (startMin < win.open || endMin > win.close) return 'Fora do horário de funcionamento.'
  if (barber.breakStart && barber.breakEnd) {
    const bs = minutesOf(barber.breakStart)
    const be = minutesOf(barber.breakEnd)
    if (startMin < be && bs < endMin) return `Horário de intervalo de ${barber.name}.`
  }
  const block = s.blocks.find(
    (b) => (b.barberId === null || b.barberId === q.barberId) && overlaps(q.start, q.end, b.start, b.end),
  )
  if (block) return `Horário bloqueado${block.reason ? `: ${block.reason}` : ''}.`
  const clash = appointmentsOn(s, date).find(
    (a) =>
      a.id !== q.ignoreId &&
      a.barberId === q.barberId &&
      OCCUPYING.includes(a.status) &&
      overlaps(q.start, q.end, a.start, a.end),
  )
  if (clash) return `${barber.name} já tem atendimento às ${timeOf(clash.start)}.`
  return null
}

export function availableSlots(
  s: DbState,
  barberId: ID,
  date: DateKey,
  durationMin: number,
  earliest: ISO,
): ISO[] {
  const barber = s.barbers.find((b) => b.id === barberId)
  if (!barber) return []
  const win = workWindow(s, barber, date)
  if (!win || durationMin <= 0) return []
  const step = s.settings.slotMinutes
  const out: ISO[] = []
  for (let m = win.open; m + durationMin <= win.close; m += step) {
    const start = toISO(date, timeFromMinutes(m))
    if (start < earliest) continue
    if (!slotProblem(s, { barberId, start, end: addMinutes(start, durationMin) })) out.push(start)
  }
  return out
}

export interface FitIn {
  barberId: ID
  start: ISO
}

/** Encaixe: primeiro horário livre de cada profissional, do mais próximo para o mais distante. */
export function findFitIns(
  s: DbState,
  q: { durationMin: number; from: ISO; barberId?: ID | null; days?: number; limit?: number },
): FitIn[] {
  const barbers = s.barbers.filter((b) => b.active && (!q.barberId || b.id === q.barberId))
  const out: FitIn[] = []
  const firstDay = dateKey(q.from)
  for (let i = 0; i < (q.days ?? 7); i++) {
    const date = addDays(firstDay, i)
    for (const b of barbers) {
      for (const start of availableSlots(s, b.id, date, q.durationMin, q.from).slice(0, q.barberId ? 6 : 2)) {
        out.push({ barberId: b.id, start })
      }
    }
    if (out.length >= (q.limit ?? 6)) break
  }
  return out.sort((a, b) => a.start.localeCompare(b.start)).slice(0, q.limit ?? 6)
}

function insertAppointment(
  d: DbState,
  ctx: Ctx,
  i: { clientId: ID; barberId: ID; serviceIds: ID[]; start: ISO; notes?: string; source: Appointment['source'] },
): Appointment {
  const s = base(d)
  if (i.serviceIds.length === 0) fail('no_service', 'Escolha ao menos um serviço.')
  // Lê do rascunho: no agendamento online o cliente pode ter nascido neste mesmo comando.
  const client = must(d.clients.find((c) => c.id === i.clientId), 'Cliente')
  if (new Date(i.start) < new Date(ctx.now)) fail('past', 'Não é possível agendar no passado.')
  for (const id of i.serviceIds) {
    if (!must(s.services.find((x) => x.id === id), 'Serviço').active) fail('inactive_service', 'Serviço inativo.')
  }
  const end = addMinutes(i.start, durationOf(s, i.serviceIds))
  const problem = slotProblem(s, { barberId: i.barberId, start: i.start, end })
  if (problem) fail('slot_taken', problem)
  const appt: Appointment = {
    id: ctx.id(),
    clientId: i.clientId,
    barberId: i.barberId,
    serviceIds: i.serviceIds,
    start: i.start,
    end,
    status: 'scheduled',
    source: i.source,
    notes: i.notes ?? '',
    saleId: null,
    createdAt: ctx.now,
  }
  d.appointments.push(appt)
  const barber = must(s.barbers.find((b) => b.id === i.barberId), 'Profissional')
  enqueue(d, ctx, appointmentMessage(s.settings.shopName, 'booking_confirmation', client, appt, barber.name))
  return appt
}

export const createAppointment: Command<
  { clientId: ID; barberId: ID; serviceIds: ID[]; start: ISO; notes?: string; fitIn?: boolean; waitlistId?: ID },
  Appointment
> = (d, i, ctx) => {
  requireBarberScope(ctx, i.barberId)
  const appt = insertAppointment(d, ctx, { ...i, source: i.fitIn ? 'fit_in' : 'staff' })
  if (i.waitlistId) {
    const w = d.waitlist.find((x) => x.id === i.waitlistId)
    if (w) w.status = 'booked'
  }
  audit(d, ctx, 'agendamento.criar', appt.id)
  return appt
}

export const rescheduleAppointment: Command<{ id: ID; barberId: ID; start: ISO }> = (d, i, ctx) => {
  const a = must(d.appointments.find((x) => x.id === i.id), 'Agendamento')
  requireBarberScope(ctx, a.barberId)
  if (!['scheduled', 'confirmed'].includes(a.status)) fail('bad_status', 'Este atendimento não pode ser remarcado.')
  if (new Date(i.start) < new Date(ctx.now)) fail('past', 'Não é possível remarcar para o passado.')
  const s = base(d)
  const end = addMinutes(i.start, durationOf(s, a.serviceIds))
  const problem = slotProblem(s, { barberId: i.barberId, start: i.start, end, ignoreId: a.id })
  if (problem) fail('slot_taken', problem)
  const freed = { barberId: a.barberId, start: a.start, end: a.end }
  a.barberId = i.barberId
  a.start = i.start
  a.end = end
  a.status = 'scheduled'
  const client = must(s.clients.find((c) => c.id === a.clientId), 'Cliente')
  const barber = must(s.barbers.find((b) => b.id === i.barberId), 'Profissional')
  enqueue(d, ctx, appointmentMessage(s.settings.shopName, 'booking_confirmation', client, a, barber.name))
  offerFreedSlot(d, ctx, freed)
  audit(d, ctx, 'agendamento.remarcar', a.id)
}

export const setAppointmentStatus: Command<{ id: ID; status: 'confirmed' | 'in_progress' | 'no_show' }> = (d, i, ctx) => {
  const a = must(d.appointments.find((x) => x.id === i.id), 'Agendamento')
  requireBarberScope(ctx, a.barberId)
  if (!canTransition(a.status, i.status)) fail('bad_status', 'Mudança de status inválida.')
  a.status = i.status
  audit(d, ctx, `agendamento.${i.status}`, a.id)
}

export const cancelAppointment: Command<{ id: ID; reason?: string }> = (d, i, ctx) => {
  const a = must(d.appointments.find((x) => x.id === i.id), 'Agendamento')
  requireBarberScope(ctx, a.barberId)
  if (!canTransition(a.status, 'cancelled')) fail('bad_status', 'Este atendimento não pode ser cancelado.')
  a.status = 'cancelled'
  const s = base(d)
  const client = must(s.clients.find((c) => c.id === a.clientId), 'Cliente')
  const barber = must(s.barbers.find((b) => b.id === a.barberId), 'Profissional')
  enqueue(d, ctx, appointmentMessage(s.settings.shopName, 'cancellation', client, a, barber.name))
  offerFreedSlot(d, ctx, a)
  audit(d, ctx, 'agendamento.cancelar', a.id, i.reason ?? '')
}

/** Horário liberado: avisa o primeiro da lista de espera em que o serviço caiba. */
function offerFreedSlot(d: DbState, ctx: Ctx, slot: { barberId: ID; start: ISO; end: ISO }) {
  const s = base(d)
  if (new Date(slot.start) < new Date(ctx.now)) return
  const date = dateKey(slot.start)
  const minutes = (new Date(slot.end).getTime() - new Date(slot.start).getTime()) / 60000
  const entry = d.waitlist.find(
    (w) =>
      w.status === 'waiting' &&
      w.date === date &&
      (w.barberId === null || w.barberId === slot.barberId) &&
      durationOf(s, w.serviceIds) <= minutes,
  )
  if (!entry) return
  const client = s.clients.find((c) => c.id === entry.clientId) as Client | undefined
  if (!client) return
  entry.status = 'notified'
  enqueue(d, ctx, {
    to: client.email,
    clientId: client.id,
    kind: 'waitlist_slot',
    subject: 'Abriu um horário para você',
    body: `${client.name.split(' ')[0]}, abriu um horário em ${brDate(date)} às ${timeOf(slot.start)}. Agende pelo link para garantir.`,
    dedupeKey: `waitlist:${entry.id}:${slot.start}`,
  })
  audit(d, ctx, 'espera.avisar', entry.id)
}

export const createBlock: Command<{ barberId: ID | null; start: ISO; end: ISO; reason: string }, ID> = (d, i, ctx) => {
  if (i.barberId) requireBarberScope(ctx, i.barberId)
  else requireOwner(ctx)
  if (new Date(i.end) <= new Date(i.start)) fail('bad_range', 'O fim precisa ser depois do início.')
  const s = base(d)
  const clash = s.appointments.find(
    (a) =>
      (i.barberId === null || a.barberId === i.barberId) &&
      ['scheduled', 'confirmed', 'in_progress'].includes(a.status) &&
      overlaps(i.start, i.end, a.start, a.end),
  )
  if (clash) fail('slot_taken', `Já existe atendimento às ${timeOf(clash.start)} nesse período. Remarque antes de bloquear.`)
  const id = ctx.id()
  d.blocks.push({ id, barberId: i.barberId, start: i.start, end: i.end, reason: i.reason })
  audit(d, ctx, 'bloqueio.criar', id, i.reason)
  return id
}

export const removeBlock: Command<{ id: ID }> = (d, i, ctx) => {
  const b = must(d.blocks.find((x) => x.id === i.id), 'Bloqueio')
  if (b.barberId) requireBarberScope(ctx, b.barberId)
  else requireOwner(ctx)
  d.blocks = d.blocks.filter((x) => x.id !== i.id)
  audit(d, ctx, 'bloqueio.remover', i.id)
}

export const addToWaitlist: Command<{ clientId: ID; serviceIds: ID[]; barberId: ID | null; date: DateKey }, ID> = (d, i, ctx) => {
  must(base(d).clients.find((c) => c.id === i.clientId), 'Cliente')
  if (i.serviceIds.length === 0) fail('no_service', 'Escolha ao menos um serviço.')
  const id = ctx.id()
  d.waitlist.push({ id, ...i, status: 'waiting', createdAt: ctx.now })
  return id
}

export const removeFromWaitlist: Command<{ id: ID }> = (d, i) => {
  d.waitlist = d.waitlist.filter((w) => w.id !== i.id)
}

export const normalizePhone = (phone: string) => phone.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '')
export const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)

/** Horários do link público: respeita antecedência mínima e janela de agendamento. */
export function onlineSlots(s: DbState, barberId: ID | null, date: DateKey, durationMin: number, now: ISO): FitIn[] {
  const earliest = addMinutes(now, s.settings.minAdvanceMinutes)
  if (date > addDays(dateKey(now), s.settings.bookingWindowDays)) return []
  const barbers = s.barbers.filter((b) => b.active && (!barberId || b.id === barberId))
  const seen = new Map<ISO, ID>()
  for (const b of barbers) {
    for (const start of availableSlots(s, b.id, date, durationMin, earliest)) {
      const current = seen.get(start)
      if (!current || dayLoad(s, b.id, date) < dayLoad(s, current, date)) seen.set(start, b.id)
    }
  }
  return [...seen.entries()].map(([start, id]) => ({ start, barberId: id })).sort((a, b) => a.start.localeCompare(b.start))
}

function dayLoad(s: DbState, barberId: ID, date: DateKey) {
  return appointmentsOn(s, date).filter((a) => a.barberId === barberId && OCCUPYING.includes(a.status)).length
}

export const bookOnline: Command<
  { name: string; phone: string; email: string; serviceIds: ID[]; barberId: ID; start: ISO; marketingOptIn: boolean },
  Appointment
> = (d, i, ctx) => {
  const s = base(d)
  const phone = normalizePhone(i.phone)
  const email = i.email.trim().toLowerCase()
  if (i.name.trim().length < 2) fail('bad_name', 'Informe seu nome.')
  if (phone.length < 10 || phone.length > 11) fail('bad_phone', 'Informe um celular com DDD.')
  if (!isValidEmail(email)) fail('bad_email', 'Informe um e-mail válido.')
  const earliest = addMinutes(ctx.now, s.settings.minAdvanceMinutes)
  if (new Date(i.start) < new Date(earliest)) fail('too_soon', 'Esse horário já não está disponível.')
  if (dateKey(i.start) > addDays(dateKey(ctx.now), s.settings.bookingWindowDays)) {
    fail('too_far', 'Esse dia ainda não abriu para agendamento.')
  }
  let client = d.clients.find((c) => c.phone === phone)
  if (client) {
    if (!client.email) client.email = email
  } else {
    client = {
      id: ctx.id(),
      name: i.name.trim(),
      phone,
      email,
      birthday: null,
      notes: '',
      marketingOptIn: i.marketingOptIn,
      stamps: 0,
      rewards: 0,
      createdAt: ctx.now,
    }
    d.clients.push(client)
    enqueue(d, ctx, {
      to: email,
      clientId: client.id,
      kind: 'welcome',
      subject: `Bem-vindo à ${s.settings.shopName}`,
      body: `${client.name.split(' ')[0]}, que bom ter você com a gente.`,
      dedupeKey: `welcome:${client.id}`,
    })
  }
  const appt = insertAppointment(d, ctx, { clientId: client.id, barberId: i.barberId, serviceIds: i.serviceIds, start: i.start, source: 'online' })
  audit(d, ctx, 'agendamento.online', appt.id)
  return appt
}
