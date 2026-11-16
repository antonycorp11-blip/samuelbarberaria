import { MessageCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { waLink } from '@/domain/whatsapp'
import { cx } from './kit'

/** Abre o WhatsApp com a mensagem pronta. É um link: funciona no celular e no computador. */
export function WhatsAppButton({ phone, text, children, compact, className }: {
  phone: string | null; text: string; children?: ReactNode; compact?: boolean; className?: string
}) {
  return (
    <a
      href={waLink(phone, text)}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      aria-label={compact ? 'Chamar no WhatsApp' : undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-bold text-[#06210f] active:brightness-90',
        compact ? 'size-10 shrink-0 bg-[#25d366]' : 'min-h-12 bg-[#25d366] px-4 text-[15px]',
        className,
      )}
    >
      <MessageCircle size={compact ? 19 : 18} />
      {!compact && children}
    </a>
  )
}
