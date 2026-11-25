import { describe, expect, it } from 'vitest'
import { DomainError } from '../src/domain/errors'
import { brandMatches, linkBarcode, productByBarcode, productCodes, upsertProduct, validGtin } from '../src/domain/stock'
import { commandName } from '../src/domain/commands'
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

  it('lê códigos novos e antigos, inclusive UPC-A e EAN-13', () => {
    const w = new World()
    const id = w.do(upsertProduct, { name: 'Óleo', salePriceCents: 2000, minQty: 1, barcodes: ['7891234567895', '036000291452'] })
    expect(productCodes(w.state.products[0]!)).toEqual(['7891234567895', '036000291452'])
    expect(productByBarcode('7891234567895', w.state.products)?.id).toBe(id)
    expect(productByBarcode('0036000291452', w.state.products)?.id).toBe(id)
    const old = { ...w.state.products[0]!, id: 'old', barcode: '96385074', barcodes: ['7891234567895'] }
    expect(productCodes(old)).toEqual(['7891234567895', '96385074'])
    expect(productByBarcode('96385074', [old])?.id).toBe('old')
  })

  it('salva vários códigos normalizados e recusa inválidos ou usados por outro produto', () => {
    const w = new World()
    const input = { name: 'Pomada', salePriceCents: 2000, minQty: 2 }
    const id = w.do(upsertProduct, { ...input, barcodes: ['789.123.456.789-5', '036000291452', '7891234567895'] })
    expect(w.state.products[0]?.barcodes).toEqual(['7891234567895', '036000291452'])
    expect(w.state.products[0]?.barcode).toBe('7891234567895')
    expect(() => w.do(upsertProduct, { ...input, barcodes: ['96385075'] })).toThrowError('Código de barras inválido.')
    expect(() => w.do(upsertProduct, { ...input, name: 'Outra', barcodes: ['0036000291452'] }))
      .toThrowError('Esse código de barras já é de outro produto.')
    w.do(upsertProduct, { ...input, id, barcodes: ['036000291452'] })
    expect(w.state.products[0]?.barcode).toBe('036000291452')
  })

  it('vincula uma vez, registra auditoria e exige dono', () => {
    const w = new World()
    const input = { name: 'Pomada', salePriceCents: 2000, minQty: 2 }
    const first = w.do(upsertProduct, { ...input, barcode: '7891234567895' })
    w.do(upsertProduct, { ...input, name: 'Outra', barcode: '96385074' })
    expect(commandName(linkBarcode)).toBe('linkBarcode')
    w.do(linkBarcode, { productId: first, barcode: '036.000.291.452' })
    expect(w.state.products[0]?.barcodes).toEqual(['7891234567895', '036000291452'])
    expect(w.state.products[0]?.barcode).toBe('7891234567895')
    expect(w.state.audit.filter((a) => a.action === 'estoque.codigo.vincular')).toHaveLength(1)
    w.do(linkBarcode, { productId: first, barcode: '0036000291452' })
    expect(w.state.products[0]?.barcodes).toHaveLength(2)
    expect(w.state.audit.filter((a) => a.action === 'estoque.codigo.vincular')).toHaveLength(1)
    expect(() => w.do(linkBarcode, { productId: first, barcode: '96385074' }))
      .toThrowError('Esse código de barras já é de outro produto.')
    expect(() => w.do(linkBarcode, { productId: first, barcode: '96385075' })).toThrowError('Código de barras inválido.')
    w.actor = { role: 'barber', barberId: 'barber', name: 'Ana' }
    expect(() => w.do(linkBarcode, { productId: first, barcode: '96385074' })).toThrowError('Somente o dono pode fazer isso.')
  })

  it('sugere mesma empresa primeiro e ordena nomes em português', () => {
    const w = new World()
    const input = { salePriceCents: 2000, minQty: 2 }
    const other = w.do(upsertProduct, { ...input, name: 'Álcool', barcode: '036000291452' })
    const z = w.do(upsertProduct, { ...input, name: 'Zebra', barcode: '7891234567895' })
    const a = w.do(upsertProduct, { ...input, name: 'Açaí', barcode: '7891234000002' })
    // Outro código com os sete primeiros dígitos iguais participa.
    expect(brandMatches('7891234567895', w.state.products).map(({ product, sameCompany }) => [product.id, sameCompany]))
      .toEqual([[a, true], [z, true], [other, false]])
    w.do(upsertProduct, { ...input, id: a, name: 'Açaí', active: false })
    expect(brandMatches('7891234567895', w.state.products).map(({ product }) => product.id)).toEqual([z, other])
  })
})
