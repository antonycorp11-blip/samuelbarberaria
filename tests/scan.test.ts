import { describe, expect, it } from 'vitest'
import { parseServiceQr, serviceQrText } from '../src/domain/scan'
import type { Service } from '../src/domain/types'

const services: Service[] = [
  { id: 's1', name: 'Corte', priceCents: 5000, durationMin: 30, active: true },
  { id: 's2', name: 'Barba', priceCents: 3500, durationMin: 30, active: true },
  { id: 's3', name: 'Antigo', priceCents: 1000, durationMin: 15, active: false },
]

describe('QR dos serviços', () => {
  it('o QR leva só o código do serviço, sem preço', () => {
    expect(serviceQrText('s1')).toBe('SBS1:servico:s1')
    expect(serviceQrText('s1')).not.toContain('5000')
  })

  it('a leitura acha o serviço e o preço vem do cadastro atual', () => {
    expect(parseServiceQr('SBS1:servico:s2', services)?.name).toBe('Barba')
    const repriced = services.map((s) => (s.id === 's2' ? { ...s, priceCents: 4000 } : s))
    expect(parseServiceQr(serviceQrText('s2'), repriced)?.priceCents).toBe(4000)
  })

  it('recusa QR de fora, serviço inexistente ou desativado', () => {
    expect(parseServiceQr('00020126580014br.gov.bcb.pix', services)).toBeNull()
    expect(parseServiceQr('https://exemplo.com', services)).toBeNull()
    expect(parseServiceQr('SBS1:servico:nao-existe', services)).toBeNull()
    expect(parseServiceQr('SBS1:servico:s3', services)).toBeNull()
  })
})
