import { describe, expect, it } from 'vitest'
import { asaasFees, DEFAULT_ASAAS_FEES, quoteAsaas } from '../src/domain/asaasFees'
import { validCpf } from '../src/domain/gateway'

describe('calculadora de taxas do Asaas', () => {
  it('cartão: fixo + percentual, disponível depois do prazo', () => {
    const q = quoteAsaas(10000, DEFAULT_ASAAS_FEES, '2026-11-24')
    expect(q.card).toEqual({ feeCents: 348, netCents: 9652, availableOn: '2026-12-26' })
  })

  it('promoção dos 3 meses bate com o exemplo do Asaas', () => {
    const promo = asaasFees({ cardBps: 199 })
    expect(quoteAsaas(20000, promo, '2026-11-24').card.netCents).toBe(19553)
  })

  it('Pix: taxa fixa e cai no mesmo dia', () => {
    expect(quoteAsaas(12900, DEFAULT_ASAAS_FEES, '2026-11-24').pix).toEqual({ feeCents: 199, netCents: 12701, availableOn: '2026-11-24' })
  })

  it('antecipação cobra 1,25% ao mês sobre o líquido, proporcional aos dias', () => {
    const q = quoteAsaas(10000, DEFAULT_ASAAS_FEES, '2026-11-24')
    // 9652 × 1,25% × 32/30 = 128,69 → 129
    expect(q.cardAnticipated).toEqual({ feeCents: 348 + 129, netCents: 9523, availableOn: '2026-11-24' })
  })

  it('valor menor que a taxa não fica negativo', () => {
    const q = quoteAsaas(30, DEFAULT_ASAAS_FEES, '2026-11-24')
    expect(q.card.netCents).toBe(0)
    expect(q.pix.netCents).toBe(0)
  })

  it('taxas salvas pela metade completam com as padrão', () => {
    expect(asaasFees({ pixCents: 99 })).toEqual({ ...DEFAULT_ASAAS_FEES, pixCents: 99 })
  })
})

describe('CPF', () => {
  it('aceita com e sem pontuação e recusa dígito errado ou repetido', () => {
    expect(validCpf('529.982.247-25')).toBe(true)
    expect(validCpf('52998224725')).toBe(true)
    expect(validCpf('529.982.247-24')).toBe(false)
    expect(validCpf('111.111.111-11')).toBe(false)
    expect(validCpf('123')).toBe(false)
  })
})
