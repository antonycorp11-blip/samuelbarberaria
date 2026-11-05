import type { DateKey, ISO } from './types'

/**
 * Único ponto do sistema que conhece o fuso. O Brasil não tem horário de verão
 * desde 2019, então São Paulo é UTC-3 fixo.
 */
const OFFSET_MIN = -180
const MIN = 60_000
const DAY = 86_400_000

const shifted = (iso: ISO) => new Date(new Date(iso).getTime() + OFFSET_MIN * MIN)
const pad = (n: number) => String(n).padStart(2, '0')

export function dateKey(iso: ISO): DateKey {
  return shifted(iso).toISOString().slice(0, 10)
}

export function timeOf(iso: ISO): string {
  return shifted(iso).toISOString().slice(11, 16)
}

export function toISO(date: DateKey, time: string): ISO {
  const utc = Date.parse(`${date}T${time}:00.000Z`)
  return new Date(utc - OFFSET_MIN * MIN).toISOString()
}

export function addMinutes(iso: ISO, minutes: number): ISO {
  return new Date(new Date(iso).getTime() + minutes * MIN).toISOString()
}

export function addDays(date: DateKey, days: number): DateKey {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
}

/** Soma meses mantendo o dia, limitado ao último dia do mês (31/jan + 1 = 28/fev). */
export function addMonths(date: DateKey, months: number): DateKey {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d, lastDay))
  return target.toISOString().slice(0, 10)
}

export function diffDays(a: DateKey, b: DateKey): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY)
}

export function weekday(date: DateKey): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

export function startOfWeek(date: DateKey): DateKey {
  return addDays(date, -((weekday(date) + 6) % 7))
}

export function startOfMonth(date: DateKey): DateKey {
  return `${date.slice(0, 7)}-01`
}

export function endOfMonth(date: DateKey): DateKey {
  return addDays(addMonths(startOfMonth(date), 1), -1)
}

export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number]
  return h * 60 + m
}

export function timeFromMinutes(total: number): string {
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

export function daysBetween(from: DateKey, to: DateKey): DateKey[] {
  const out: DateKey[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

export const weekdayLabel = (date: DateKey) => WEEKDAYS[weekday(date)] ?? ''
export const weekdayNames = WEEKDAYS

export function dayLabel(date: DateKey): string {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`
}

export function monthLabel(date: DateKey): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`
}

export function brDate(date: DateKey): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`
}
