import { X } from 'lucide-react'
import {
  useEffect, useId, useRef, useState, useSyncExternalStore,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { DomainError } from '@/domain/errors'
import { formatBRL } from '@/domain/money'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')
export { cx }

/* ---------- avisos ---------- */

type Toast = { id: number; text: string; kind: 'ok' | 'bad' }
let toasts: Toast[] = []
const toastSubs = new Set<() => void>()
function pushToast(text: string, kind: Toast['kind']) {
  const id = Date.now() + Math.random()
  toasts = [...toasts, { id, text, kind }]
  toastSubs.forEach((f) => f())
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id)
    toastSubs.forEach((f) => f())
  }, kind === 'bad' ? 4500 : 2600)
}
export const toast = { ok: (t: string) => pushToast(t, 'ok'), bad: (t: string) => pushToast(t, 'bad') }

export function Toasts() {
  const list = useSyncExternalStore(
    (l) => {
      toastSubs.add(l)
      return () => toastSubs.delete(l)
    },
    () => toasts,
  )
  return createPortal(
    <div className="pt-safe pointer-events-none fixed inset-x-0 top-0 z-[80] flex flex-col items-center gap-2 px-4" role="status" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          className={cx(
            'anim-fade max-w-md rounded-xl px-4 py-3 text-sm font-semibold shadow-xl',
            t.kind === 'ok' ? 'bg-ok text-[#0e2015]' : 'bg-bad text-[#2a0c09]',
          )}
        >
          {t.text}
        </div>
      ))}
    </div>,
    document.body,
  )
}

/** Roda uma ação de negócio: regra violada vira aviso na tela, nunca uma tela quebrada. */
export function attempt(fn: () => void, success?: string): boolean {
  try {
    fn()
    if (success) toast.ok(success)
    return true
  } catch (e) {
    if (e instanceof DomainError) toast.bad(e.message)
    else {
      console.error(e)
      toast.bad('Algo deu errado. Nada foi salvo.')
    }
    return false
  }
}

/* ---------- botões ---------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'link' | 'danger'
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brass text-brass-ink active:brightness-90',
  secondary: 'bg-raised text-ink active:brightness-125',
  ghost: 'text-muted active:text-ink',
  link: 'text-brass active:brightness-90',
  danger: 'bg-bad/15 text-bad active:bg-bad/25',
}

export function Button({
  variant = 'secondary', block, className, ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; block?: boolean }) {
  return (
    <button
      type="button"
      {...p}
      className={cx(
        'inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-bold transition disabled:opacity-40',
        VARIANTS[variant], block && 'w-full', className,
      )}
    />
  )
}

export function IconButton({ label, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...p}
      className={cx('grid size-11 shrink-0 place-items-center rounded-xl bg-raised text-ink active:brightness-125', className)}
    />
  )
}

/* ---------- estrutura ---------- */

export function PageHeader({ title, sub, action, back }: { title: string; sub?: string; action?: ReactNode; back?: boolean }) {
  return (
    <header className="pt-safe flex items-end justify-between gap-3 px-4 pb-3">
      <div className="min-w-0">
        {back && <Link to="/mais" className="mb-1 block text-sm font-semibold text-muted">‹ Mais</Link>}
        <h1 className="truncate font-display text-[28px] leading-tight font-semibold tracking-tight">{title}</h1>
        {sub && <p className="mt-0.5 truncate text-sm text-muted">{sub}</p>}
      </div>
      {action}
    </header>
  )
}

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...p} className={cx('rounded-2xl bg-surface', className)} />
}

export function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('px-4 pt-5', className)}>
      <div className="mb-2 flex min-h-7 items-center justify-between gap-2">
        <h2 className="text-[13px] font-bold tracking-wide text-muted uppercase">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'ok' | 'bad' | 'warn' }) {
  return (
    <Card className="min-w-0 p-3.5">
      <div className="truncate text-xs font-semibold text-muted">{label}</div>
      <div
        className={cx(
          'tnum mt-1 truncate text-xl font-extrabold tracking-tight',
          tone === 'ok' && 'text-ok', tone === 'bad' && 'text-bad', tone === 'warn' && 'text-warn',
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 truncate text-xs text-muted">{hint}</div>}
    </Card>
  )
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'ok' | 'bad' | 'warn' | 'info' | 'brass' }) {
  const tones = {
    muted: 'bg-raised text-muted', ok: 'bg-ok/15 text-ok', bad: 'bg-bad/15 text-bad', warn: 'bg-warn/15 text-warn',
    info: 'bg-info/15 text-info', brass: 'bg-brass/15 text-brass',
  }
  return <span className={cx('inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-bold', tones[tone])}>{children}</span>
}

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const parts = name.trim().split(/\s+/)
  const initials = `${parts[0]?.[0] ?? ''}${parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : ''}`.toUpperCase()
  return (
    <div
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full bg-raised font-bold text-brass"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {initials}
    </div>
  )
}

export function Row({
  title, sub, right, left, onClick, to,
}: { title: ReactNode; sub?: ReactNode; right?: ReactNode; left?: ReactNode; onClick?: () => void; to?: string }) {
  const body = (
    <>
      {left}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold">{title}</div>
        {sub && <div className="truncate text-[13px] text-muted">{sub}</div>}
      </div>
      {right && <div className="tnum shrink-0 text-right text-sm font-bold">{right}</div>}
    </>
  )
  const cls = 'flex min-h-14 w-full items-center gap-3 px-3.5 py-2.5 text-left'
  if (to) return <Link to={to} className={cx(cls, 'active:bg-raised')}>{body}</Link>
  if (onClick) return <button type="button" onClick={onClick} className={cx(cls, 'active:bg-raised')}>{body}</button>
  return <div className={cls}>{body}</div>
}

export function List({ children }: { children: ReactNode }) {
  return <Card className="divide-y divide-line/70 overflow-hidden">{children}</Card>
}

export function Empty({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <Card className="flex flex-col items-center gap-1 px-6 py-9 text-center">
      <div className="font-semibold">{title}</div>
      {sub && <div className="text-sm text-muted">{sub}</div>}
      {action && <div className="mt-3">{action}</div>}
    </Card>
  )
}

export function Segmented<T extends string>({ value, onChange, options, className }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string
}) {
  return (
    <div role="tablist" className={cx('flex gap-1 rounded-xl bg-surface p-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'min-h-10 flex-1 rounded-lg px-2 text-sm font-bold whitespace-nowrap transition',
            value === o.value ? 'bg-raised text-ink' : 'text-muted',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Chips<T extends string>({ value, onChange, options, multi }: {
  value: T | T[] | null; onChange: (v: T) => void; options: { value: T; label: string; sub?: string }[]; multi?: boolean
}) {
  const on = (v: T) => (multi ? (value as T[]).includes(v) : value === v)
  return (
    <div className="no-bar -mx-4 flex gap-2 overflow-x-auto px-4 py-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={on(o.value)}
          onClick={() => onChange(o.value)}
          className={cx(
            'min-h-11 shrink-0 rounded-xl px-3.5 text-sm font-bold whitespace-nowrap transition',
            on(o.value) ? 'bg-brass text-brass-ink' : 'bg-raised text-ink',
          )}
        >
          {o.label}
          {o.sub && <span className="ml-1.5 font-semibold opacity-70">{o.sub}</span>}
        </button>
      ))}
    </div>
  )
}

/* ---------- formulários ---------- */

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-bold text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  )
}

const inputCls =
  'min-h-12 w-full rounded-xl border border-line bg-raised px-3.5 text-ink outline-none placeholder:text-muted/60 focus:border-brass'

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx(inputCls, p.className)} />
}

export function Textarea(p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...p} className={cx(inputCls, 'py-3', p.className)} />
}

export function Select({ children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cx(inputCls, p.className)}>{children}</select>
}

/** Campo de dinheiro estilo maquininha: digita 1 2 5 0 e vê R$ 12,50. Trabalha em centavos. */
export function MoneyInput({ value, onChange, ...p }: { value: number; onChange: (cents: number) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <Input
      {...p}
      inputMode="numeric"
      className="tnum font-bold"
      value={formatBRL(value)}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(0, 10)
        onChange(Number(digits || 0))
      }}
    />
  )
}

/** Percentual digitado em % e guardado em basis points. */
export function PercentInput({ value, onChange }: { value: number; onChange: (bps: number) => void }) {
  const [text, setText] = useState(String(value / 100).replace('.', ','))
  return (
    <Input
      inputMode="decimal"
      className="tnum"
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value.replace(',', '.'))
        if (Number.isFinite(n)) onChange(Math.round(n * 100))
      }}
    />
  )
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  const id = useId()
  return (
    <div className="flex min-h-12 items-center justify-between gap-3">
      <label htmlFor={id} className="min-w-0">
        <span className="block text-[15px] font-semibold">{label}</span>
        {hint && <span className="block text-[13px] text-muted">{hint}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx('relative h-8 w-14 shrink-0 rounded-full transition', checked ? 'bg-brass' : 'bg-line')}
      >
        <span className={cx('absolute top-1 left-1 size-6 rounded-full bg-ink transition', checked && 'translate-x-6')} />
      </button>
    </div>
  )
}

/* ---------- folha inferior ---------- */

export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
      }
    }
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panel.current?.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = overflow
      previous?.focus?.()
    }
  }, [])

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="anim-fade absolute inset-0 bg-black/65" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="anim-sheet relative flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-3xl bg-surface outline-none sm:rounded-3xl"
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
          <h2 className="truncate font-display text-xl font-semibold">{title}</h2>
          <IconButton label="Fechar" onClick={onClose}><X size={20} /></IconButton>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 pt-1 pb-4">{children}</div>
        {footer && <div className="pb-safe border-t border-line px-4 pt-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export function ConfirmSheet({ title, text, confirm, danger, onConfirm, onClose, children }: {
  title: string; text: string; confirm: string; danger?: boolean; onConfirm: () => void; onClose: () => void; children?: ReactNode
}) {
  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={onClose}>Voltar</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirm}</Button>
        </div>
      }
    >
      <p className="text-[15px] text-muted">{text}</p>
      {children}
    </Sheet>
  )
}

/** Barras simples em CSS: sem biblioteca de gráfico para manter o app leve. */
export function Bars({ data, format }: { data: { label: string; value: number }[]; format: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value))
  const peak = data.reduce((best, d) => (d.value > best.value ? d : best), data[0] ?? { label: '', value: 0 })
  return (
    <div>
      <div className="flex h-28 items-end gap-[3px]" role="img" aria-label={`Maior valor ${format(peak.value)} em ${peak.label}`}>
        {data.map((d, i) => (
          <div key={i} title={`${d.label}: ${format(d.value)}`} className="flex h-full min-w-0 flex-1 items-end">
            <div
              className={cx('w-full rounded-t-[3px]', d === peak ? 'bg-brass' : 'bg-brass/40')}
              style={{ height: `${Math.max(d.value > 0 ? 3 : 1, (d.value / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted">
        <span>{data[0]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </div>
  )
}

export function Meter({ bps, tone = 'bg-brass' }: { bps: number; tone?: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-line">
      <div className={cx('h-full rounded-full', tone)} style={{ width: `${Math.min(100, bps / 100)}%` }} />
    </div>
  )
}
