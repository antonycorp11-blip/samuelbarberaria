import { CalendarPlus, Check, ChevronLeft } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, nowISO } from '@/data/store'
import { durationOf, onlineSlots, priceOf, type FitIn } from '@/domain/agenda'
import { formatBRL } from '@/domain/money'
import { addDays, dateKey, dayLabel, timeOf, weekdayLabel } from '@/domain/time'
import { emptyState, type DateKey, type DbState, type ID } from '@/domain/types'
import { Button, Card, cx, Field, Input, toast, Toggle } from '@/ui/kit'
import { EmailFix } from '@/ui/emailFix'

type Step = 'services' | 'barber' | 'time' | 'details' | 'done'

const REMEMBER = 'samuel-cliente'

/** Dados de quem já agendou neste celular: na próxima vez, é só confirmar. */
function remembered(): { name: string; phone: string; email: string; birthDate?: string } | null {
  try {
    return JSON.parse(localStorage.getItem(REMEMBER) ?? 'null')
  } catch {
    return null
  }
}

const icsDate = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/** Arquivo de calendário: no iPhone e no Android abre direto para salvar na agenda. */
function downloadIcs(start: string, end: string, title: string, location: string) {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Barbearia//Agendamento//PT', 'BEGIN:VEVENT',
    `UID:${start}-${Math.random().toString(36).slice(2)}@barbearia`, `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${title}`, location ? `LOCATION:${location}` : '',
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', `DESCRIPTION:${title}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n')
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'horario-barbearia.ics'
  a.click()
  URL.revokeObjectURL(url)
}

export default function PublicBookingPage() {
  const [db, setDb] = useState<DbState>(emptyState)
  const [offline, setOffline] = useState(false)
  const today = dateKey(nowISO())
  const [step, setStep] = useState<Step>('services')
  const [serviceIds, setServiceIds] = useState<ID[]>([])
  const [barberId, setBarberId] = useState<ID | null>(null)
  const [date, setDate] = useState<DateKey>(today)
  const [slot, setSlot] = useState<FitIn | null>(null)
  const saved = useMemo(remembered, [])
  const [name, setName] = useState(saved?.name ?? '')
  const [phone, setPhone] = useState(saved?.phone ?? '')
  const [email, setEmail] = useState(saved?.email ?? '')
  const [birthDate, setBirthDate] = useState(saved?.birthDate ?? '')
  const [editing, setEditing] = useState(!saved)
  const [optIn, setOptIn] = useState(false)
  const [booked, setBooked] = useState<{ start: string; end: string; barberId: ID } | null>(null)
  const [busy, setBusy] = useState(false)
  const coupon = useMemo(() => new URLSearchParams(location.search).get('cupom')?.toUpperCase() ?? '', [])

  useEffect(() => {
    const load = () =>
      api<DbState>('/api/public/state')
        .then((s) => {
          setDb(s)
          setOffline(false)
        })
        .catch(() => setOffline(true))
    void load()
    const timer = setInterval(() => void load(), 20_000)
    return () => clearInterval(timer)
  }, [])

  const services = db.services.filter((s) => s.active)
  const barbers = db.barbers.filter((b) => b.active)
  const duration = serviceIds.length ? durationOf(db, serviceIds) : 0
  const days = useMemo(
    () => Array.from({ length: Math.min(21, db.settings.bookingWindowDays + 1) }, (_, i) => addDays(today, i)),
    [today, db.settings.bookingWindowDays],
  )
  const slots = useMemo(
    () => (duration ? onlineSlots(db, barberId, date, duration, nowISO()) : []),
    [db, barberId, date, duration],
  )
  const single = barbers.length === 1 ? barbers[0] : undefined
  const back: Partial<Record<Step, Step>> = { barber: 'services', time: single ? 'services' : 'barber', details: 'time' }
  const previous = back[step]

  /** Abre os horários já no primeiro dia com vaga. */
  const goToTime = (id: ID | null) => {
    setBarberId(id)
    setSlot(null)
    setDate(days.find((d) => onlineSlots(db, id, d, duration, nowISO()).length > 0) ?? today)
    setStep('time')
  }

  const nextFree = (id: ID | null) => {
    for (const d of days) {
      const first = onlineSlots(db, id, d, duration, nowISO())[0]
      if (first) return `${d === today ? 'hoje' : `${weekdayLabel(d)} ${dayLabel(d)}`} às ${timeOf(first.start)}`
    }
    return null
  }

  const confirm = async () => {
    if (!slot) return
    setBusy(true)
    try {
      const r = await api<{ start: string; end: string; barberId: ID }>('/api/public/book', {
        method: 'POST',
        body: JSON.stringify({ name, phone, email, birthDate, serviceIds, barberId: slot.barberId, start: slot.start, marketingOptIn: optIn, coupon: coupon || null }),
      })
      try {
        localStorage.setItem(REMEMBER, JSON.stringify({ name, phone, email, birthDate }))
      } catch {
        // Sem armazenamento: na próxima vez a pessoa digita de novo.
      }
      setBooked(r)
      setEditing(false)
      setStep('done')
    } catch (e) {
      toast.bad(e instanceof Error ? e.message : 'Não foi possível agendar.')
    }
    setBusy(false)
  }

  return (
    <div className="mx-auto min-h-dvh max-w-lg pb-32">
      <header className="pt-safe px-4 pb-3">
        {previous && (
          <button type="button" onClick={() => setStep(previous)} className="mb-1 flex min-h-9 items-center gap-1 text-sm font-semibold text-muted">
            <ChevronLeft size={17} /> Voltar
          </button>
        )}
        <div className="mb-2 flex items-center gap-3">
          <img src="/logo.webp" alt="" width={52} height={52} className="rounded-xl" />
          <p className="text-sm font-semibold text-brass">{db.settings.shopName}</p>
        </div>
        <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">
          {{ services: 'O que vamos fazer?', barber: 'Com quem?', time: 'Quando?', details: 'Seus dados', done: 'Tudo certo!' }[step]}
        </h1>
      </header>

      {offline && <p className="mx-4 mb-3 rounded-xl bg-bad/15 p-3 text-sm text-bad">Sem conexão com a barbearia. Tente de novo em instantes.</p>}
      {coupon && step !== 'done' && (
        <p className="mx-4 mb-3 rounded-xl bg-brass/15 p-3 text-sm font-semibold text-brass">🎟️ Cupom {coupon}: o desconto é aplicado no atendimento.</p>
      )}

      {step === 'services' && (
        <div className="space-y-2 px-4">
          {services.map((s) => {
            const on = serviceIds.includes(s.id)
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={on}
                onClick={() => setServiceIds((l) => (on ? l.filter((x) => x !== s.id) : [...l, s.id]))}
                className={cx('flex min-h-16 w-full items-center gap-3 rounded-2xl p-3.5 text-left', on ? 'bg-brass text-brass-ink' : 'bg-surface')}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-bold">{s.name}</div>
                  <div className="text-[13px] opacity-75">{s.durationMin} min</div>
                </div>
                <div className="tnum font-extrabold">{formatBRL(s.priceCents)}</div>
              </button>
            )
          })}
        </div>
      )}

      {step === 'barber' && (
        <div className="space-y-2 px-4">
          {[{ id: null as ID | null, name: 'Sem preferência' }, ...barbers.map((b) => ({ id: b.id as ID | null, name: b.name }))].map((b) => {
            const free = nextFree(b.id)
            return (
              <button
                key={b.id ?? 'any'}
                type="button"
                onClick={() => goToTime(b.id)}
                className="block min-h-16 w-full rounded-2xl bg-surface p-3.5 text-left active:bg-raised"
              >
                <div className="font-bold">{b.name}</div>
                <div className="text-[13px] text-muted">{free ? `Próximo horário: ${free}` : 'Sem horários nos próximos dias'}</div>
              </button>
            )
          })}
        </div>
      )}

      {step === 'time' && (
        <>
          <div className="no-bar flex gap-1.5 overflow-x-auto px-4 py-0.5">
            {days.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={d === date}
                onClick={() => { setDate(d); setSlot(null) }}
                className={cx('flex h-16 w-13 shrink-0 flex-col items-center justify-center rounded-xl', d === date ? 'bg-brass text-brass-ink' : 'bg-surface')}
              >
                <span className="text-[11px] font-semibold uppercase opacity-75">{weekdayLabel(d)}</span>
                <span className="tnum text-lg leading-tight font-extrabold">{Number(d.slice(8))}</span>
              </button>
            ))}
          </div>
          <div className="px-4 pt-4">
            {slots.length === 0 ? (
              <Card className="p-5 text-center text-sm text-muted">Sem horários neste dia. Tente outro.</Card>
            ) : (
              <div className="grid grid-cols-4 gap-1.5">
                {slots.map((s) => (
                  <button
                    key={s.start}
                    type="button"
                    aria-pressed={slot?.start === s.start}
                    onClick={() => {
                      setSlot(s)
                      setStep('details')
                    }}
                    className={cx('tnum min-h-12 rounded-xl font-bold', slot?.start === s.start ? 'bg-brass text-brass-ink' : 'bg-surface')}
                  >
                    {timeOf(s.start)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {step === 'details' && slot && (
        <div className="space-y-3 px-4">
          <Card className="p-3.5">
            <div className="font-bold">{serviceIds.map((id) => db.services.find((s) => s.id === id)?.name).join(' + ')}</div>
            <div className="text-sm text-muted">
              {weekdayLabel(date)}, {dayLabel(date)} às {timeOf(slot.start)} · {db.barbers.find((b) => b.id === slot.barberId)?.name}
            </div>
          </Card>
          {editing ? (
            <>
              <Field label="Nome"><Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Celular com DDD"><Input autoComplete="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
              <Field label="E-mail" hint="Enviamos a confirmação e o lembrete por aqui."><Input autoComplete="email" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} /><EmailFix email={email} onFix={setEmail} /></Field>
              <Toggle checked={optIn} onChange={setOptIn} label="Quero receber promoções" />
            </>
          ) : (
            <Card className="flex items-center justify-between gap-3 p-3.5">
              <div className="min-w-0">
                <div className="truncate font-bold">{name}</div>
                <div className="truncate text-sm text-muted">{phone} · {email}</div>
              </div>
              <button type="button" onClick={() => setEditing(true)} className="min-h-10 shrink-0 text-sm font-bold text-brass">Não é você?</button>
            </Card>
          )}
          <Field label="Data de nascimento"><Input type="date" autoComplete="bday" min="1900-01-01" max={today} value={birthDate} onChange={(e) => setBirthDate(e.target.value)} /></Field>
        </div>
      )}

      {step === 'done' && booked && (
        <div className="px-4">
          <Card className="flex flex-col items-center gap-2 p-6 text-center">
            <div className="grid size-14 place-items-center rounded-full bg-ok/15 text-ok"><Check size={28} /></div>
            <div className="text-lg font-bold">{weekdayLabel(dateKey(booked.start))}, {dayLabel(dateKey(booked.start))} às {timeOf(booked.start)}</div>
            <div className="text-sm text-muted">Com {db.barbers.find((b) => b.id === booked.barberId)?.name}. A confirmação vai para o seu e-mail, com o link para cancelar se precisar.</div>
            {db.settings.address && <div className="text-sm text-muted">{db.settings.address}</div>}
          </Card>
          <div className="mt-3 space-y-2">
            <Button
              variant="primary"
              block
              onClick={() => downloadIcs(booked.start, booked.end, `${serviceIds.map((id) => db.services.find((s) => s.id === id)?.name).join(' + ')} · ${db.settings.shopName}`, db.settings.address)}
            >
              <CalendarPlus size={18} /> Salvar na agenda do celular
            </Button>
            <Button
              block
              onClick={() => {
                setServiceIds([])
                setSlot(null)
                setBooked(null)
                setStep('services')
              }}
            >
              Agendar outro horário
            </Button>
          </div>
        </div>
      )}

      {step !== 'done' && (
        <div className="pb-safe fixed inset-x-0 bottom-0 border-t border-line bg-bg/95 px-4 pt-3 backdrop-blur">
          <div className="mx-auto max-w-lg">
            {step === 'services' && (
              <Button variant="primary" block disabled={serviceIds.length === 0} onClick={() => (single ? goToTime(single.id) : setStep('barber'))}>
                Continuar{serviceIds.length > 0 && ` · ${formatBRL(priceOf(db, serviceIds))}`}
              </Button>
            )}
            {step === 'time' && <p className="py-3 text-center text-sm text-muted">Toque no horário que preferir</p>}
            {step === 'details' && (
              <Button variant="primary" block disabled={busy || !name || !phone || !email || !birthDate} onClick={() => void confirm()}>
                {busy ? 'Agendando…' : slot ? `Confirmar ${timeOf(slot.start)}` : 'Confirmar agendamento'}
              </Button>
            )}
            {step === 'barber' && <p className="py-3 text-center text-sm text-muted">Duração: {duration} min</p>}
          </div>
        </div>
      )}
    </div>
  )
}
