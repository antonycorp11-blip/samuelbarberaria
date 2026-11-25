import { emailTypoFix } from '@/domain/emailTypo'

/** Aviso embaixo do campo de e-mail quando o fim parece digitado errado, com um toque para corrigir. */
export function EmailFix({ email, onFix }: { email: string; onFix: (fixed: string) => void }) {
  const fixed = emailTypoFix(email)
  if (!fixed) return null
  return (
    <button type="button" onClick={() => onFix(fixed)} className="mt-1 block text-left text-sm font-semibold text-warn">
      Você quis dizer <span className="underline">{fixed}</span>? Toque para corrigir.
    </button>
  )
}
