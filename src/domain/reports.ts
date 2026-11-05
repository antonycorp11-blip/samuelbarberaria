import { OCCUPYING, workWindow } from './agenda'
import { allocate } from './money'
import { paidSales } from './finance'
import { addDays, dateKey, daysBetween, diffDays } from './time'
import type { Cents, DateKey, DbState, ID } from './types'

export interface BarberRank {
  barberId: ID
  name: string
  revenueCents: Cents
  services: number
  products: number
  clients: number
  commissionCents: Cents
  ticketCents: Cents
  occupancyBps: number
}

export function barberRanking(s: DbState, from: DateKey, to: DateKey): BarberRank[] {
  const sales = paidSales(s, from, to)
  return s.barbers
    .map((b) => {
      const items = sales.flatMap((x) => x.items).filter((it) => it.barberId === b.id)
      const own = sales.filter((x) => x.barberId === b.id)
      const paying = own.filter((x) => x.totalCents > 0)
      const revenueCents = items.reduce((t, it) => t + it.netCents, 0)
      return {
        barberId: b.id,
        name: b.name,
        revenueCents,
        services: items.filter((it) => it.kind === 'service').reduce((t, it) => t + it.qty, 0),
        products: items.filter((it) => it.kind === 'product').reduce((t, it) => t + it.qty, 0),
        clients: new Set(own.map((x) => x.clientId).filter(Boolean)).size,
        commissionCents: s.commissions
          .filter((c) => c.barberId === b.id && dateKey(c.at) >= from && dateKey(c.at) <= to)
          .reduce((t, c) => t + c.amountCents, 0),
        ticketCents: paying.length ? Math.round(paying.reduce((t, x) => t + x.totalCents, 0) / paying.length) : 0,
        occupancyBps: occupancy(s, from, to, b.id),
      }
    })
    .sort((a, b) => b.revenueCents - a.revenueCents)
}

export function topServices(s: DbState, from: DateKey, to: DateKey) {
  const map = new Map<ID, { name: string; qty: number; revenueCents: Cents }>()
  for (const sale of paidSales(s, from, to)) {
    for (const it of sale.items) {
      if (it.kind !== 'service') continue
      const row = map.get(it.refId) ?? { name: it.name, qty: 0, revenueCents: 0 }
      row.qty += it.qty
      row.revenueCents += it.coverage === 'subscription' ? 0 : it.netCents
      map.set(it.refId, row)
    }
  }
  return [...map.values()].sort((a, b) => b.qty - a.qty)
}

/**
 * Minutos ocupados sobre minutos disponíveis. Só conta dias já trabalhados e
 * desconta intervalos e bloqueios da capacidade.
 */
export function occupancy(s: DbState, from: DateKey, to: DateKey, barberId?: ID): number {
  const barbers = s.barbers.filter((b) => b.active && (!barberId || b.id === barberId))
  let capacity = 0
  for (const date of daysBetween(from, to)) {
    for (const b of barbers) {
      const win = workWindow(s, b, date)
      if (!win) continue
      capacity += win.close - win.open
      if (b.breakStart && b.breakEnd) {
        capacity -= (Number(b.breakEnd.slice(0, 2)) * 60 + Number(b.breakEnd.slice(3))) -
          (Number(b.breakStart.slice(0, 2)) * 60 + Number(b.breakStart.slice(3)))
      }
    }
  }
  for (const k of s.blocks) {
    if (dateKey(k.start) < from || dateKey(k.start) > to) continue
    const minutes = (new Date(k.end).getTime() - new Date(k.start).getTime()) / 60000
    if (k.barberId === null) capacity -= minutes * barbers.length
    else if (barbers.some((b) => b.id === k.barberId)) capacity -= minutes
  }
  if (capacity <= 0) return 0
  const busy = s.appointments
    .filter((a) => OCCUPYING.includes(a.status) && dateKey(a.start) >= from && dateKey(a.start) <= to)
    .filter((a) => barbers.some((b) => b.id === a.barberId))
    .reduce((t, a) => t + (new Date(a.end).getTime() - new Date(a.start).getTime()) / 60000, 0)
  return Math.min(10000, Math.round((busy / capacity) * 10000))
}

/**
 * Taxa de retorno: dos clientes atendidos no período, quantos voltaram em até
 * `windowDays` depois de uma visita. Só conta quem já teve tempo de voltar.
 */
export function returnRate(s: DbState, from: DateKey, to: DateKey, today: DateKey, windowDays = 45) {
  const visits = new Map<ID, DateKey[]>()
  for (const sale of s.sales) {
    if (!sale.clientId || sale.status !== 'paid') continue
    const list = visits.get(sale.clientId) ?? []
    list.push(dateKey(sale.at))
    visits.set(sale.clientId, list)
  }
  let eligible = 0
  let returned = 0
  for (const days of visits.values()) {
    const sorted = [...new Set(days)].sort()
    const inPeriod = sorted.filter((d) => d >= from && d <= to)
    const first = inPeriod[0]
    if (!first) continue
    const cameBack = sorted.some((d) => d > first && diffDays(d, first) <= windowDays)
    if (cameBack) {
      eligible += 1
      returned += 1
    } else if (addDays(first, windowDays) <= today) eligible += 1
  }
  return { eligible, returned, rateBps: eligible ? Math.round((returned / eligible) * 10000) : 0 }
}

export function commissionHistory(s: DbState, from: DateKey, to: DateKey) {
  return s.payouts
    .filter((p) => dateKey(p.at) >= from && dateKey(p.at) <= to)
    .sort((a, b) => b.at.localeCompare(a.at))
}

/** Reaproveita a divisão exata de centavos para a pizza de formas de pagamento. */
export function shareBps(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0)
  return total > 0 ? allocate(10000, values) : values.map(() => 0)
}
