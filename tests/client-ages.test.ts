import { describe, expect, it } from 'vitest'
import { ageOn, upsertClient, validBirthDate } from '../src/domain/clients'
import { clientAges } from '../src/domain/reports'
import { setup } from './helpers'

describe('datas de nascimento', () => {
  it('calcula anos completos, inclusive em aniversário e ano bissexto', () => {
    expect(ageOn('2000-03-02', '2026-03-02')).toBe(26)
    expect(ageOn('2000-03-03', '2026-03-02')).toBe(25)
    expect(ageOn('2000-02-29', '2024-02-29')).toBe(24)
    expect(ageOn('2000-02-29', '2025-02-28')).toBe(24)
    expect(ageOn('2000-02-29', '2025-03-01')).toBe(25)
    expect(validBirthDate('1900-01-01', '2026-03-02')).toBe(true)
    expect(validBirthDate('1900-02-29', '2026-03-02')).toBe(false)
  })

  it('aceita cadastro antigo e sincroniza data completa no formulário', () => {
    const { w, joao } = setup()
    const client = w.state.clients.find((c) => c.id === joao)!
    const base = { id: joao, name: client.name, phone: client.phone, email: client.email, notes: '', marketingOptIn: false }
    w.do(upsertClient, { ...base, birthday: '04-20' })
    expect(w.state.clients.find((c) => c.id === joao)).toMatchObject({ birthDate: null, birthday: '04-20' })
    w.do(upsertClient, { ...base, birthDate: '1990-06-15' })
    expect(w.state.clients.find((c) => c.id === joao)).toMatchObject({ birthDate: '1990-06-15', birthday: '06-15' })
    expect(() => w.do(upsertClient, { ...base, birthDate: '2026-02-30' })).toThrow(/Data de nascimento inválida/)
    expect(() => w.do(upsertClient, { ...base, birthday: '13-01' })).toThrow(/Data de aniversário inválida/)
  })

  it('resume média, faixas e clientes sem ano', () => {
    const { w } = setup()
    const dates = ['2009-03-02', '2006-03-02', '1996-03-02', '1986-03-02', '1976-03-02', '1966-03-02']
    dates.forEach((birthDate, i) => w.do(upsertClient, {
      name: `Cliente ${i}`, phone: `1198000000${i}`, email: '', birthDate, notes: '', marketingOptIn: false,
    }))
    const result = clientAges(w.state, '2026-03-02')
    expect(result.average).toBeCloseTo(36.1667, 3)
    expect(result.withoutYear).toBe(2)
    expect(result.buckets.map((b) => [b.label, b.count])).toEqual([
      ['Até 17', 1], ['18–24', 1], ['25–34', 1], ['35–44', 1], ['45–54', 1], ['55+', 1],
    ])
    expect(result.buckets[0]?.percent).toBeCloseTo(100 / 6)
  })
})
