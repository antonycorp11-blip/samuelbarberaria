import { describe, expect, it } from 'vitest'
import { crc16, pixKeyOf, pixPayload, shopPix, SHOP_PIX_KEY } from '../src/domain/pix'
import { emptyState } from '../src/domain/types'
import { waTemplates } from '../src/domain/whatsapp'

describe('código Pix do balcão', () => {
  it('CRC bate com o padrão e com o exemplo do manual do BR Code', () => {
    expect(crc16('123456789')).toBe('29B1')
    const manual = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304'
    expect(crc16(manual)).toBe('1D3D')
  })

  it('monta o código com chave, valor, nome sem acento e cidade', () => {
    const code = pixPayload({ key: SHOP_PIX_KEY, name: 'Samuel Barbearia Ação', city: 'São Paulo', amountCents: 4500 })
    expect(code).toContain('0014br.gov.bcb.pix01368b26f858-fcea-4cc9-8f30-45097bbd7f8c')
    expect(code).toContain('540545.00')
    expect(code).toContain('5921SAMUEL BARBEARIA ACAO')
    expect(code).toContain('6009SAO PAULO')
    expect(code.slice(-4)).toBe(crc16(code.slice(0, -4)))
  })

  it('sem valor, o cliente digita; sem cidade, usa BRASIL', () => {
    const code = pixPayload({ key: 'chave@teste.com', name: 'Loja', city: '' })
    expect(code).not.toContain('5404')
    expect(code).toContain('6006BRASIL')
  })

  it('o QR do banco da barbearia confere: mesma chave e código válido', () => {
    const bank = '00020126580014br.gov.bcb.pix01368b26f858-fcea-4cc9-8f30-45097bbd7f8c5204000053039865802BR5913Samuel  Lucas6009Sao Paulo62240520daqr13436350568950156304EEE6'
    expect(crc16(bank.slice(0, -4))).toBe('EEE6')
    expect(bank).toContain(`0136${SHOP_PIX_KEY}`)
    expect(shopPix(emptyState().settings, 4500)).toContain('6006CUIABA')
  })

  it('usa a chave do Samuel por padrão e some quando apagada nos Ajustes', () => {
    const s = emptyState().settings
    expect(pixKeyOf(s)).toBe(SHOP_PIX_KEY)
    expect(shopPix({ ...s, pixKey: '' }, 1000)).toBeNull()
  })

  it('a cobrança pelo WhatsApp leva a chave Pix', () => {
    const db = emptyState()
    const client = { id: 'c', name: 'Ana Lima', phone: '11999990000', email: '', birthday: null, notes: '', marketingOptIn: false, stamps: 0, rewards: 0, createdAt: '' }
    expect(waTemplates.charge(db, client, 8000)).toContain(SHOP_PIX_KEY)
  })
})
