import { describe, expect, it } from 'vitest'
import { createAppointment } from '../src/domain/agenda'
import { toISO } from '../src/domain/time'
import { waLink, waNumber, waTemplates } from '../src/domain/whatsapp'
import { setup } from './helpers'

describe('WhatsApp em um toque', () => {
  it('normaliza o número para o formato do WhatsApp', () => {
    expect(waNumber('(11) 99999-0001')).toBe('5511999990001')
    expect(waNumber('+55 11 3333-4444')).toBe('551133334444')
    expect(waNumber('011999990001')).toBe('5511999990001')
    expect(waNumber('123')).toBeNull()
  })

  it('número inválido abre o WhatsApp para escolher o contato, sem quebrar', () => {
    expect(waLink('abc', 'oi')).toBe('https://wa.me/?text=oi')
  })

  it('texto vai codificado e com os dados do horário', () => {
    const { w, ana, cut, joao } = setup()
    const a = w.do(createAppointment, { clientId: joao, barberId: ana, serviceIds: [cut], start: toISO('2026-03-03', '10:00') })
    const c = w.state.clients.find((x) => x.id === joao)!
    const text = waTemplates.confirm(w.state, c, a)
    expect(text).toContain('João')
    expect(text).toContain('ter, 03/03 às 10:00 com Ana (Corte)')
    const link = waLink(c.phone, text)
    expect(link.startsWith('https://wa.me/5511999990001?text=')).toBe(true)
    expect(decodeURIComponent(link.split('text=')[1]!)).toBe(text)
  })
})
