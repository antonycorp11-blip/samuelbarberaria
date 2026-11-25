import { describe, expect, it } from 'vitest'
import { DomainError } from '../src/domain/errors'
import { productByBarcode, upsertProduct, validGtin } from '../src/domain/stock'
import { World } from './helpers'

describe('código de barras', () => {
  it('confere o dígito de GTIN', () => {
    for (const code of ['7891234567895', '96385074', '036000291452']) expect(validGtin(code)).toBe(true)
    for (const code of ['7891234567896', '96385075', '036000291453', 'ABC1234567895', '1234567', '123456789012345']) {
      expect(validGtin(code)).toBe(false)
    }
  })

  it('normaliza e impede código de outro produto ativo', () => {
    const w = new World()
    const input = { name: 'Pomada', salePriceCents: 2000, minQty: 2 }
    const first = w.do(upsertProduct, { ...input, barcode: '789.123.456.789-5' })
    expect(w.state.products[0]?.barcode).toBe('7891234567895')
    try {
      w.do(upsertProduct, { ...input, name: 'Outra', barcode: '7891234567895' })
      throw new Error('Deveria recusar o código repetido.')
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      expect((error as DomainError).code).toBe('duplicate_barcode')
      expect((error as DomainError).message).toBe('Esse código de barras já é de outro produto.')
    }
    w.do(upsertProduct, { ...input, id: first, barcode: null, active: false })
    expect(w.state.products[0]?.barcode).toBeNull()
    expect(w.do(upsertProduct, { ...input, barcode: '7891234567895' })).toBeTruthy()
  })

  it('acha UPC-A mesmo quando o leitor devolve EAN-13', () => {
    const w = new World()
    const id = w.do(upsertProduct, { name: 'Óleo', salePriceCents: 2000, minQty: 1, barcode: '036000291452' })
    expect(productByBarcode('0036000291452', w.state.products)?.id).toBe(id)
    expect(() => w.do(upsertProduct, { name: 'Outro óleo', salePriceCents: 2000, minQty: 1, barcode: '0036000291452' }))
      .toThrowError('Esse código de barras já é de outro produto.')
    expect(productByBarcode('outro', w.state.products)).toBeNull()
  })
})
