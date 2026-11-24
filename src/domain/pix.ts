import type { Cents, Settings } from './types'

/** Chave aleatória da conta Asaas do Samuel. Pode ser trocada em Ajustes; vazia desliga o Pix do balcão. */
export const SHOP_PIX_KEY = '449bfdf7-02f5-4e63-b17a-8e326c96d530'

export function pixKeyOf(s: Settings): string {
  return (s.pixKey ?? SHOP_PIX_KEY).trim()
}

const field = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`

/** O padrão do Pix só aceita letras sem acento, números e espaço no nome e na cidade. */
function plain(text: string, max: number) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .trim()
    .toUpperCase()
    .slice(0, max)
}

/** CRC16-CCITT (polinômio 0x1021, início 0xFFFF), exigido no fim do código Pix. */
export function crc16(text: string): string {
  let crc = 0xffff
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

/**
 * Código Pix "copia e cola" estático (BR Code), com o valor já preenchido.
 * É o mesmo texto que vira o QR Code: o cliente escaneia e só confirma no banco.
 */
export function pixPayload(o: { key: string; name: string; city: string; amountCents?: Cents }): string {
  const account = field('00', 'br.gov.bcb.pix') + field('01', o.key.trim())
  const body =
    field('00', '01') +
    field('26', account) +
    field('52', '0000') +
    field('53', '986') +
    (o.amountCents && o.amountCents > 0 ? field('54', (o.amountCents / 100).toFixed(2)) : '') +
    field('58', 'BR') +
    field('59', plain(o.name, 25) || 'BARBEARIA') +
    field('60', plain(o.city, 15) || 'BRASIL') +
    field('62', field('05', '***')) +
    '6304'
  return body + crc16(body)
}

/** Código Pix da barbearia para um valor, ou null se não houver chave. */
export function shopPix(s: Settings, amountCents?: Cents): string | null {
  const key = pixKeyOf(s)
  return key ? pixPayload({ key, name: s.shopName, city: s.pixCity ?? '', amountCents }) : null
}
