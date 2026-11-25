import { Check, Copy, CreditCard, Crown, QrCode } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '@/data/store'
import { formatBps, formatBRL } from '@/domain/money'
import { planDaysLabel } from '@/domain/subscriptions'
import { emptyState, type DbState, type ID } from '@/domain/types'
import { Button, Card, cx, Field, Input, toast } from '@/ui/kit'

type Method = 'pix' | 'card'

interface PixCharge {
  payload: string
  image: string
  expiresAt: string
  automatic: boolean
}

interface PixStarted {
  pix: PixCharge
  status: { id: string; t: string }
}

/** 000.000.000-00 enquanto digita. */
function maskCpf(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 11)
  return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2')
}

// Quem recarrega a página enquanto paga não perde o QR Code.
const PIX_KEY = 'clube:pix'
const savedPix = (): PixStarted | null => {
  try {
    return JSON.parse(sessionStorage.getItem(PIX_KEY) ?? 'null') as PixStarted | null
  } catch {
    return null
  }
}
const savePix = (v: PixStarted | null) => {
  try {
    if (v) sessionStorage.setItem(PIX_KEY, JSON.stringify(v))
    else sessionStorage.removeItem(PIX_KEY)
  } catch {
    // Navegador sem armazenamento: segue sem guardar.
  }
}

function Done({ confirmed = false }: { confirmed?: boolean }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center gap-3 px-6 text-center">
      <img src="/logo.webp" alt="" width={96} height={96} className="rounded-2xl" />
      <div className="grid size-14 place-items-center rounded-full bg-ok/15 text-ok"><Check size={28} /></div>
      <h1 className="font-display text-[28px] font-semibold">{confirmed ? 'Pagamento confirmado' : 'Recebemos seu pedido'}</h1>
      <p className="text-muted">
        {confirmed
          ? 'Sua assinatura está ativa. Você vai receber um e-mail de boas-vindas e já pode usar o clube.'
          : 'Assim que o pagamento for confirmado, você recebe um e-mail de boas-vindas e já pode usar o clube.'}
      </p>
      <a href="/agendar" className="mt-2 font-bold text-brass">Agendar meu horário</a>
    </div>
  )
}

function PixPayment({ started, onPaid, onBack }: { started: PixStarted; onPaid: () => void; onBack: () => void }) {
  const { pix, status } = started
  useEffect(() => {
    const check = () =>
      api<{ status: string }>(`/api/public/club/status?id=${encodeURIComponent(status.id)}&t=${encodeURIComponent(status.t)}`)
        .then((r) => r.status === 'active' && onPaid())
        .catch(() => undefined)
    const timer = setInterval(check, 4000)
    return () => clearInterval(timer)
  }, [status.id, status.t, onPaid])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pix.payload)
      toast.ok('Código copiado. Cole no app do seu banco.')
    } catch {
      toast.bad('Não foi possível copiar. Segure o código e copie.')
    }
  }

  return (
    <div className="mx-auto min-h-dvh max-w-lg px-4 pb-10">
      <header className="pt-safe pb-3">
        <div className="mb-2 flex items-center gap-3">
          <img src="/logo.webp" alt="" width={52} height={52} className="rounded-xl" />
          <button type="button" onClick={onBack} className="text-sm font-semibold text-muted">‹ Voltar</button>
        </div>
        <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">Pague com Pix</h1>
        <p className="mt-1 text-sm text-muted">
          {pix.automatic
            ? 'Pague o primeiro mês e, quando o banco perguntar, autorize o Pix Automático. Os próximos meses saem sozinhos da sua conta.'
            : 'Pague o primeiro mês. Nos próximos, você recebe o Pix por e-mail para pagar.'}
        </p>
      </header>
      <Card className="flex flex-col items-center gap-4 p-5">
        <img src={`data:image/png;base64,${pix.image}`} alt="QR Code do Pix" width={232} height={232} className="rounded-xl bg-white p-2" />
        <Button variant="primary" block onClick={() => void copy()}><Copy size={18} /> Copiar código Pix</Button>
        <p className="w-full break-all rounded-xl bg-raised p-3 font-mono text-[11px] text-muted select-all">{pix.payload}</p>
      </Card>
      <p className="mt-4 text-center text-sm text-muted">Esperando o pagamento… Esta tela atualiza sozinha quando o Pix cair.</p>
    </div>
  )
}

export default function PublicClubPage() {
  const thanks = useLocation().pathname.endsWith('/obrigado')
  const [db, setDb] = useState<DbState>(emptyState)
  const [planId, setPlanId] = useState<ID | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [birthDate, setBirthDate] = useState('')
  const [method, setMethod] = useState<Method>('pix')
  const [cpf, setCpf] = useState('')
  const [busy, setBusy] = useState(false)
  const [pix, setPix] = useState<PixStarted | null>(savedPix)
  const [paid, setPaid] = useState(false)

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
      const r = await api<{ checkoutUrl?: string } & Partial<PixStarted>>('/api/public/club/subscribe', {
        method: 'POST',
        body: JSON.stringify({ name, phone, email, birthDate, planId: plan.id, method, cpf: method === 'pix' ? cpf : undefined }),
      })
      if (r.checkoutUrl) {
        location.href = r.checkoutUrl
        return
      }
      if (r.pix && r.status) {
        const started = { pix: r.pix, status: r.status }
        savePix(started)
        setPix(started)
      }
      setBusy(false)
    } catch (e) {
      toast.bad(e instanceof Error ? e.message : 'Não foi possível continuar.')
      setBusy(false)
    }
  }

  if (thanks || paid) return <Done confirmed={paid} />
  if (pix) {
    return (
      <PixPayment
        started={pix}
        onPaid={() => {
          savePix(null)
          setPaid(true)
        }}
        onBack={() => {
          savePix(null)
          setPix(null)
        }}
      />
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
        <p className="mt-1 text-sm text-muted">Visual sempre em dia, com mensalidade automática no Pix ou no cartão.</p>
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
                {planDaysLabel(p) && <li>Vale de {planDaysLabel(p)}</li>}
                {(p.serviceDiscountBps ?? 0) > 0 && (
                  <li>{formatBps(p.serviceDiscountBps ?? 0)} de desconto em serviços avulsos{planDaysLabel(p) ? ', inclusive fora desses dias' : ''}</li>
                )}
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
          <Field label="Data de nascimento">
            <Input type="date" autoComplete="bday" min="1900-01-01" max={new Date().toISOString().slice(0, 10)} value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
          </Field>
          <div>
            <p className="mb-1.5 text-sm font-semibold">Como quer pagar?</p>
            <div className="grid grid-cols-2 gap-2">
              {([
                ['pix', 'Pix Automático', 'Sai da sua conta todo mês', QrCode],
                ['card', 'Cartão de crédito', 'Cobrado todo mês no cartão', CreditCard],
              ] as const).map(([id, label, sub, Icon]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={method === id}
                  onClick={() => setMethod(id)}
                  className={cx('rounded-2xl p-3 text-left transition', method === id ? 'bg-brass text-brass-ink' : 'bg-surface')}
                >
                  <Icon size={20} />
                  <div className="mt-1.5 font-bold">{label}</div>
                  <div className="text-xs opacity-80">{sub}</div>
                </button>
              ))}
            </div>
          </div>
          {method === 'pix' && (
            <Field label="CPF" hint="O banco pede o CPF para a cobrança no Pix.">
              <Input inputMode="numeric" autoComplete="off" placeholder="000.000.000-00" value={cpf} onChange={(e) => setCpf(maskCpf(e.target.value))} />
            </Field>
          )}
          <p className="text-xs text-muted">
            {method === 'pix'
              ? 'No próximo passo aparece o QR Code do primeiro mês. Ao pagar, o banco pergunta se você autoriza o Pix Automático. Cancele quando quiser falando com a barbearia ou no app do banco.'
              : 'No próximo passo você informa o cartão na página segura do Asaas, sem precisar criar conta. A barbearia não vê os dados do seu cartão. Cancele quando quiser falando com a barbearia.'}
          </p>
        </div>
      )}

      <div className="pb-safe fixed inset-x-0 bottom-0 border-t border-line bg-bg/95 px-4 pt-3 backdrop-blur">
        <div className="mx-auto max-w-lg">
          <Button variant="primary" block disabled={!plan || busy || !name || !phone || !email || !birthDate || (method === 'pix' && cpf.replace(/\D/g, '').length !== 11)} onClick={() => void subscribe()}>
            {busy ? (method === 'pix' ? 'Gerando o Pix…' : 'Abrindo o pagamento…') : plan ? `Assinar por ${formatBRL(plan.priceCents)}/mês` : 'Escolha um plano'}
          </Button>
        </div>
      </div>
    </div>
  )
}
