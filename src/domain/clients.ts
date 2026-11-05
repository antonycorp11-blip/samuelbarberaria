import { isValidEmail, normalizePhone } from './agenda'
import { audit, base, must, type Command } from './engine'
import { fail } from './errors'
import { enqueue } from './messages'
import { addDays, dateKey, diffDays } from './time'
import type { Appointment, Client, DateKey, DbState, ID, Sale } from './types'

export const upsertClient: Command<
  { id?: ID; name: string; phone: string; email: string; birthday: string | null; notes: string; marketingOptIn: boolean },
  ID
> = (d, i, ctx) => {
  const s = base(d)
  const phone = normalizePhone(i.phone)
  const email = i.email.trim().toLowerCase()
  if (i.name.trim().length < 2) fail('bad_name', 'Informe o nome do cliente.')
  if (phone.length < 10 || phone.length > 11) fail('bad_phone', 'Informe um celular com DDD.')
  if (email && !isValidEmail(email)) fail('bad_email', 'E-mail inválido.')
  if (i.birthday && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(i.birthday)) fail('bad_birthday', 'Data de aniversário inválida.')
  if (s.clients.some((c) => c.phone === phone && c.id !== i.id)) fail('duplicate', 'Já existe cliente com este celular.')
  const data = { name: i.name.trim(), phone, email, birthday: i.birthday, notes: i.notes, marketingOptIn: i.marketingOptIn }
  if (i.id) {
    Object.assign(must(d.clients.find((c) => c.id === i.id), 'Cliente'), data)
    audit(d, ctx, 'cliente.editar', i.id)
    return i.id
  }
  const id = ctx.id()
  d.clients.push({ ...data, id, stamps: 0, rewards: 0, createdAt: ctx.now })
  enqueue(d, ctx, {
    to: email,
    clientId: id,
    kind: 'welcome',
    subject: `Bem-vindo à ${s.settings.shopName}`,
    body: `${data.name.split(' ')[0]}, que bom ter você com a gente.`,
    dedupeKey: `welcome:${id}`,
  })
  audit(d, ctx, 'cliente.criar', id)
  return id
}

export interface ClientStats {
  visits: number
  noShows: number
  spentCents: number
  firstVisit: DateKey | null
  lastVisit: DateKey | null
  /** Intervalo médio entre visitas, em dias. */
  avgIntervalDays: number | null
  expectedReturn: DateKey | null
  nextAppointment: Appointment | null
  history: Sale[]
}

export function clientStats(s: DbState, clientId: ID, now: string): ClientStats {
  const history = s.sales
    .filter((x) => x.clientId === clientId && x.status === 'paid')
    .sort((a, b) => b.at.localeCompare(a.at))
  const days = [...new Set(history.map((x) => dateKey(x.at)))].sort()
  const first = days[0] ?? null
  const last = days[days.length - 1] ?? null
  const avg = first && last && days.length > 1 ? Math.round(diffDays(last, first) / (days.length - 1)) : null
  const appts = s.appointments.filter((a) => a.clientId === clientId)
  return {
    visits: days.length,
    noShows: appts.filter((a) => a.status === 'no_show').length,
    spentCents: history.reduce((sum, x) => sum + x.totalCents, 0),
    firstVisit: first,
    lastVisit: last,
    avgIntervalDays: avg,
    expectedReturn: last && avg ? addDays(last, avg) : null,
    nextAppointment:
      appts
        .filter((a) => ['scheduled', 'confirmed'].includes(a.status) && a.start >= now)
        .sort((a, b) => a.start.localeCompare(b.start))[0] ?? null,
    history,
  }
}

/** Mapa cliente → último dia com atendimento pago, em uma passada só. */
export function lastVisits(s: DbState): Map<ID, DateKey> {
  const out = new Map<ID, DateKey>()
  for (const sale of s.sales) {
    if (!sale.clientId || sale.status !== 'paid') continue
    const k = dateKey(sale.at)
    if ((out.get(sale.clientId) ?? '') < k) out.set(sale.clientId, k)
  }
  return out
}

function hasUpcoming(s: DbState, now: string): Set<ID> {
  return new Set(
    s.appointments
      .filter((a) => ['scheduled', 'confirmed'].includes(a.status) && a.start >= now)
      .map((a) => a.clientId),
  )
}

export interface InactiveClient {
  client: Client
  lastVisit: DateKey
  daysAway: number
}

/** Já foi cliente, sumiu há mais que o limite e não tem horário marcado. */
export function inactiveClients(s: DbState, now: string): InactiveClient[] {
  const today = dateKey(now)
  const last = lastVisits(s)
  const upcoming = hasUpcoming(s, now)
  return s.clients
    .flatMap((client) => {
      const lastVisit = last.get(client.id)
      if (!lastVisit || upcoming.has(client.id)) return []
      const daysAway = diffDays(today, lastVisit)
      return daysAway >= s.settings.inactiveDays ? [{ client, lastVisit, daysAway }] : []
    })
    .sort((a, b) => a.daysAway - b.daysAway)
}

/** Clientes cuja data provável de retorno já chegou e ainda não marcaram. */
export function dueForReturn(s: DbState, now: string): { client: Client; expected: DateKey }[] {
  const today = dateKey(now)
  const upcoming = hasUpcoming(s, now)
  const byClient = new Map<ID, Set<DateKey>>()
  for (const sale of s.sales) {
    if (!sale.clientId || sale.status !== 'paid') continue
    if (!byClient.has(sale.clientId)) byClient.set(sale.clientId, new Set())
    byClient.get(sale.clientId)?.add(dateKey(sale.at))
  }
  return s.clients
    .flatMap((client) => {
      const days = [...(byClient.get(client.id) ?? [])].sort()
      const first = days[0]
      const last = days[days.length - 1]
      if (!first || !last || days.length < 2 || upcoming.has(client.id)) return []
      const expected = addDays(last, Math.round(diffDays(last, first) / (days.length - 1)))
      const late = diffDays(today, expected)
      return late >= 0 && late < s.settings.inactiveDays ? [{ client, expected }] : []
    })
    .sort((a, b) => a.expected.localeCompare(b.expected))
}

