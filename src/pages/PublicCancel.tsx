import { Check } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '@/data/store'
import { brDate, dateKey, timeOf, weekdayLabel } from '@/domain/time'
import { Button, Card, toast } from '@/ui/kit'

interface Info {
  start: string
  status: string
  shopName: string
  phone: string
  barber: string
  services: string[]
}

/** Cancelamento pelo link do e-mail: dois toques, sem login. */
export default function PublicCancelPage() {
  const params = new URLSearchParams(location.search)
  const id = params.get('id') ?? ''
  const t = params.get('t') ?? ''
  const [info, setInfo] = useState<Info | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<Info>(`/api/public/appointment?id=${encodeURIComponent(id)}&t=${encodeURIComponent(t)}`)
      .then(setInfo)
      .catch((e) => setError(e instanceof Error ? e.message : 'Link inválido.'))
  }, [id, t])

  const cancel = async () => {
    setBusy(true)
    try {
      await api('/api/public/appointment/cancel', { method: 'POST', body: JSON.stringify({ id, t }) })
      setDone(true)
    } catch (e) {
      toast.bad(e instanceof Error ? e.message : 'Não foi possível cancelar.')
    }
    setBusy(false)
  }

  const active = info && ['scheduled', 'confirmed'].includes(info.status) && info.start > new Date().toISOString()

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6 py-10">
      <img src="/logo.webp" alt="" width={84} height={84} className="mx-auto rounded-2xl" />
      {error && <Card className="p-5 text-center text-muted">{error}</Card>}
      {!info && !error && <p className="text-center text-muted">Carregando…</p>}
      {info && done && (
        <Card className="flex flex-col items-center gap-2 p-6 text-center">
          <div className="grid size-14 place-items-center rounded-full bg-ok/15 text-ok"><Check size={28} /></div>
          <div className="text-lg font-bold">Horário cancelado</div>
          <p className="text-sm text-muted">Obrigado por avisar! O horário ficou livre para outra pessoa.</p>
          <a href="/agendar" className="mt-2 font-bold text-brass">Agendar outro horário</a>
        </Card>
      )}
      {info && !done && (
        <>
          <h1 className="text-center font-display text-[28px] font-semibold">{active ? 'Cancelar horário?' : 'Seu horário'}</h1>
          <Card className="p-4 text-center">
            <div className="text-lg font-bold">{weekdayLabel(dateKey(info.start))}, {brDate(dateKey(info.start))} às {timeOf(info.start)}</div>
            <div className="text-sm text-muted">{info.services.join(' + ')}{info.barber ? ` com ${info.barber}` : ''}</div>
            <div className="mt-1 text-sm text-muted">{info.shopName}</div>
          </Card>
          {active ? (
            <>
              <Button variant="danger" block disabled={busy} onClick={() => void cancel()}>{busy ? 'Cancelando…' : 'Sim, cancelar'}</Button>
              <a href="/agendar" className="text-center text-sm font-semibold text-muted">Prefiro remarcar para outro horário</a>
            </>
          ) : (
            <p className="text-center text-sm text-muted">Este horário não pode mais ser cancelado por aqui{info.phone ? `. Fale com a barbearia: ${info.phone}` : ''}.</p>
          )}
        </>
      )}
    </div>
  )
}
