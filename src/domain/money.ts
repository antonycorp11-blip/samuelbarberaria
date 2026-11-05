import type { Bps, Cents } from './types'

export function applyBps(amount: Cents, bps: Bps): Cents {
  return Math.round((amount * bps) / 10000)
}

/**
 * Divide um total inteiro proporcionalmente aos pesos pelo método do maior resto:
 * a soma das partes é sempre exatamente igual ao total, sem centavo perdido.
 */
export function allocate(total: Cents, weights: number[]): Cents[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0) return weights.map(() => 0)
  const raw = weights.map((w) => (total * w) / sum)
  const parts = raw.map(Math.floor)
  let rest = total - parts.reduce((a, b) => a + b, 0)
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (const { i } of order) {
    if (rest <= 0) break
    parts[i] = (parts[i] ?? 0) + 1
    rest -= 1
  }
  return parts
}

export function formatBRL(cents: Cents): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function formatBps(bps: Bps): string {
  return `${(bps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`
}
