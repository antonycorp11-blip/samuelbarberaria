import { describe, expect, it } from 'vitest'
import { allocate, applyBps } from '../src/domain/money'
import { addMonths, dateKey, startOfWeek, timeOf, toISO } from '../src/domain/time'

describe('dinheiro', () => {
  it('divide sem perder nem criar centavo', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33])
    for (const total of [1, 7, 999, 10001]) {
      for (const weights of [[3, 3, 3], [1, 2, 7], [5000, 3333, 1]]) {
        expect(allocate(total, weights).reduce((a, b) => a + b, 0)).toBe(total)
      }
    }
  })
  it('não divide quando não há peso', () => expect(allocate(100, [0, 0])).toEqual([0, 0]))
  it('aplica percentual', () => expect(applyBps(3333, 4500)).toBe(1500))
})

describe('datas em São Paulo', () => {
  it('23:30 local ainda é o mesmo dia, mesmo já sendo o dia seguinte em UTC', () => {
    const iso = toISO('2026-03-02', '23:30')
    expect(iso).toBe('2026-03-03T02:30:00.000Z')
    expect(dateKey(iso)).toBe('2026-03-02')
    expect(timeOf(iso)).toBe('23:30')
  })
  it('31/jan + 1 mês cai no fim de fevereiro', () => expect(addMonths('2026-01-31', 1)).toBe('2026-02-28'))
  it('semana começa na segunda', () => expect(startOfWeek('2026-03-08')).toBe('2026-03-02'))
})
