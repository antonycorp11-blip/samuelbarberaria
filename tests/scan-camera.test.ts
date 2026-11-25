import { describe, expect, it } from 'vitest'
import { backCameras, readOnce } from '../src/ui/scan'

describe('câmeras traseiras', () => {
  it('prefere a câmera virtual que troca de lente', () => {
    expect(backCameras([
      { deviceId: 'frente', label: 'Front Camera' },
      { deviceId: 'normal', label: 'Back Camera' },
      { deviceId: 'tripla', label: 'Back Triple Camera' },
      { deviceId: 'dupla', label: 'Dual Wide Camera' },
    ]).map((camera) => camera.deviceId)).toEqual(['tripla', 'dupla', 'normal'])
  })

  it('descarta nomes de câmera frontal', () => {
    expect(backCameras([
      { deviceId: 'a', label: 'Câmera frontal' },
      { deviceId: 'b', label: 'User Facing front' },
      { deviceId: 'c', label: 'Câmera traseira' },
    ])).toEqual([{ deviceId: 'c', label: 'Câmera traseira' }])
  })
})

describe('leitura repetida', () => {
  it('conta uma vez até passar 700 ms fora da imagem', () => {
    const first = readOnce({ text: '', missingSince: null }, '7891234567895', 0)
    expect(first.accepted).toBe('7891234567895')
    const held = readOnce(first.seen, '7891234567895', 1000)
    expect(held.accepted).toBe('')
    const missing = readOnce(held.seen, '', 1100)
    expect(readOnce(missing.seen, '7891234567895', 1799).accepted).toBe('')
    expect(readOnce(missing.seen, '7891234567895', 1800).accepted).toBe('7891234567895')
  })

  it('aceita outro código de imediato', () => {
    const first = readOnce({ text: '', missingSince: null }, '123', 0)
    expect(readOnce(first.seen, '456', 100).accepted).toBe('456')
  })
})
