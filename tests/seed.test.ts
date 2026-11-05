import { describe, expect, it } from 'vitest'
import { buildDemo } from '../src/data/seed'
import { dre } from '../src/domain/finance'
import { assertInvariants } from './helpers'

describe('dados de demonstração', () => {
  it.each(['2026-11-05T19:30:00.000Z', '2026-03-01T13:00:00.000Z', '2026-12-31T23:59:00.000Z'])('passam por todas as regras em %s', (now) => {
    const started = Date.now()
    const s = buildDemo(now)
    expect(assertInvariants(s)).toEqual([])
    expect(s.sales.length).toBeGreaterThan(400)
    console.log(now, { ms: Date.now() - started, sales: s.sales.length, bytes: JSON.stringify(s).length, dre: dre(s, '2026-10-01', '2026-10-31').netProfit })
  })
})
