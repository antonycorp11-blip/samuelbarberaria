/**
 * Erro de digitação no fim do e-mail ("gmail.con", "hotmial.com"): o e-mail sai, mas nunca chega.
 * Sugere o domínio conhecido mais parecido; não mexe em domínios que não reconhece de perto.
 */
const KNOWN = [
  'gmail.com', 'hotmail.com', 'hotmail.com.br', 'outlook.com', 'outlook.com.br', 'live.com', 'yahoo.com', 'yahoo.com.br',
  'icloud.com', 'me.com', 'bol.com.br', 'uol.com.br', 'terra.com.br',
]

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j] as number
      row[j] = Math.min(cur + 1, (row[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length] as number
}

/** E-mail corrigido quando o domínio parece um erro de digitação; senão null. */
export function emailTypoFix(email: string): string | null {
  const value = email.trim().toLowerCase()
  const at = value.lastIndexOf('@')
  if (at < 1) return null
  const domain = value.slice(at + 1)
  if (domain.length < 5 || KNOWN.includes(domain)) return null
  let best: string | null = null
  let bestDistance = 3
  for (const known of KNOWN) {
    const d = distance(domain, known)
    if (d < bestDistance) {
      best = known
      bestDistance = d
    }
  }
  return best ? `${value.slice(0, at)}@${best}` : null
}
