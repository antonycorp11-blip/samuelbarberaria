import type { ID, Service } from './types'

/**
 * Texto gravado no QR de cada serviço, na folha da bancada. Leva só o código do serviço:
 * o preço vem do cadastro na hora, então mudar o preço não obriga a reimprimir a folha.
 */
const PREFIX = 'SBS1:servico:'

export function serviceQrText(id: ID): string {
  return `${PREFIX}${id}`
}

/** Serviço lido pela câmera, ou null se o QR não for de um serviço ativo da barbearia. */
export function parseServiceQr(text: string, services: Service[]): Service | null {
  const raw = text.trim()
  if (!raw.startsWith(PREFIX)) return null
  const id = raw.slice(PREFIX.length)
  return services.find((s) => s.id === id && s.active) ?? null
}
