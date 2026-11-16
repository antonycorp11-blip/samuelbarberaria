import { Check, Crown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '@/data/store'
import { formatBps, formatBRL } from '@/domain/money'
import { emptyState, type DbState, type ID } from '@/domain/types'
import { Button, Card, cx, Field, Input, toast } from '@/ui/kit'

export default function PublicClubPage() {
  const thanks = useLocation().pathname.endsWith('/obrigado')
  const [db, setDb] = useState<DbState>(emptyState)
  const [planId, setPlanId] = useState<ID | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<DbState>('/api/public/state').then(setDb).catch(() => toast.bad('Sem conexão com a barbearia.'))
  }, [])

  const plans = db.plans.filter((p) => p.active).sort((a, b) => a.priceCents - b.priceCents)
  const plan = plans.find((p) => p.id === planId)
  const serviceNames = (ids: ID[]) => ids.map((id) => db.services.find((s) => s.id === id)?.name).filter(Boolean).join(', ')

  const subscribe = async () => {
    if (!plan) return
    setBusy(true)
    try {
      const r = await api<{ checkoutUrl: string }>('/api/public/club/subscribe', {
        method: 'POST',
        body: JSON.stringify({ name, phone, email, planId: plan.id }),
      })
      location.href = r.checkoutUrl
    } catch (e) {
      toast.bad(e instanceof Error ? e.message : 'Não foi possível continuar.')
      setBusy(false)
    }
  }

  if (thanks) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center gap-3 px-6 text-center">
        <img src="/logo.webp" alt="" width={96} height={96} className="rounded-2xl" />
        <div className="grid size-14 place-items-center rounded-full bg-ok/15 text-ok"><Check size={28} /></div>
        <h1 className="font-display text-[28px] font-semibold">Recebemos seu pedido</h1>
        <p className="text-muted">Assim que o pagamento for confirmado, você recebe um e-mail de boas-vindas e já pode usar o clube.</p>
        <a href="/agendar" className="mt-2 font-bold text-brass">Agendar meu horário</a>
      </div>
    )
  }

  return (
    <div className="mx-auto min-h-dvh max-w-lg pb-36">
      <header className="pt-safe px-4 pb-3">
        <div className="mb-2 flex items-center gap-3">
          <img src="/logo.webp" alt="" width={52} height={52} className="rounded-xl" />
          <p className="text-sm font-semibold text-brass">{db.settings.shopName}</p>
        </div>
        <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">Clube de assinatura</h1>
        <p className="mt-1 text-sm text-muted">Visual sempre em dia, com cobrança automática todo mês no cartão.</p>
      </header>

      <div className="space-y-2 px-4">
        {plans.length === 0 && <Card className="p-5 text-center text-sm text-muted">Nenhum plano disponível no momento.</Card>}
        {plans.map((p) => {
          const on = p.id === planId
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              onClick={() => setPlanId(p.id)}
              className={cx('block w-full rounded-2xl p-4 text-left transition', on ? 'bg-brass text-brass-ink' : 'bg-surface')}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex items-center gap-2 text-lg font-bold"><Crown size={18} /> {p.name}</span>
                <span className="tnum text-xl font-extrabold">{formatBRL(p.priceCents)}<span className="text-sm font-semibold opacity-70">/mês</span></span>
              </div>
              <ul className="mt-2 space-y-1 text-sm opacity-85">
                <li>{p.visitsPerCycle === null ? 'Visitas ilimitadas' : `${p.visitsPerCycle} visitas por mês`}: {serviceNames(p.serviceIds)}</li>
                {p.productDiscountBps > 0 && <li>{formatBps(p.productDiscountBps)} de desconto em produtos</li>}
                {p.benefits.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </button>
          )
        })}
      </div>

      {plan && (
        <div className="space-y-3 px-4 pt-5">
          <Field label="Nome"><Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Celular com DDD"><Input autoComplete="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="E-mail" hint="Para enviarmos a confirmação e os avisos do clube.">
            <Input autoComplete="email" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <p className="text-xs text-muted">
            No próximo passo você informa o cartão na página segura do Asaas, sem precisar criar conta. A barbearia não vê os dados do seu cartão. Cancele quando quiser falando com a barbearia.
          </p>
        </div>
      )}

      <div className="pb-safe fixed inset-x-0 bottom-0 border-t border-line bg-bg/95 px-4 pt-3 backdrop-blur">
        <div className="mx-auto max-w-lg">
          <Button variant="primary" block disabled={!plan || busy || !name || !phone || !email} onClick={() => void subscribe()}>
            {busy ? 'Abrindo o pagamento…' : plan ? `Assinar por ${formatBRL(plan.priceCents)}/mês` : 'Escolha um plano'}
          </Button>
        </div>
      </div>
    </div>
  )
}
