import { Check, ChevronLeft } from 'lucide-react'
import { useMemo, useState } from 'react'
import { execPublic, nowISO, useDb } from '@/data/store'
import { bookOnline, durationOf, onlineSlots, priceOf, type FitIn } from '@/domain/agenda'
import { formatBRL } from '@/domain/money'
import { addDays, dateKey, dayLabel, timeOf, weekdayLabel } from '@/domain/time'
import type { Appointment, DateKey, ID } from '@/domain/types'
import { attempt, Button, Card, cx, Field, Input, Toggle } from '@/ui/kit'

type Step = 'services' | 'barber' | 'time' | 'details' | 'done'

export default function PublicBookingPage() {
  const db = useDb()
  const today = dateKey(nowISO())
  const [step, setStep] = useState<Step>('services')
  const [serviceIds, setServiceIds] = useState<ID[]>([])
  const [barberId, setBarberId] = useState<ID | null>(null)
  const [date, setDate] = useState<DateKey>(today)
  const [slot, setSlot] = useState<FitIn | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [optIn, setOptIn] = useState(false)
  const [booked, setBooked] = useState<Appointment | null>(null)

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
  const back: Partial<Record<Step, Step>> = { barber: 'services', time: 'barber', details: 'time' }
  const previous = back[step]

  const confirm = () => {
    const ok = attempt(() => {
      if (!slot) return
      setBooked(execPublic(bookOnline, { name, phone, email, serviceIds, barberId: slot.barberId, start: slot.start, marketingOptIn: optIn }))
      setStep('done')
    })
    if (!ok) setSlot(null)
  }

  return (
    <div className="mx-auto min-h-dvh max-w-lg pb-32">
      <header className="pt-safe px-4 pb-3">
        {previous && (
          <button type="button" onClick={() => setStep(previous)} className="mb-1 flex min-h-9 items-center gap-1 text-sm font-semibold text-muted">
            <ChevronLeft size={17} /> Voltar
          </button>
        )}
        <p className="text-sm font-semibold text-brass">{db.settings.shopName}</p>
        <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">
          {{ services: 'O que vamos fazer?', barber: 'Com quem?', time: 'Quando?', details: 'Seus dados', done: 'Tudo certo!' }[step]}
        </h1>
      </header>

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
          {[{ id: null as ID | null, name: 'Sem preferência', sub: 'Mais horários disponíveis' }, ...barbers.map((b) => ({ id: b.id as ID | null, name: b.name, sub: '' }))].map((b) => (
            <button
              key={b.id ?? 'any'}
              type="button"
              onClick={() => {
                setBarberId(b.id)
                setSlot(null)
                setDate(days.find((d) => onlineSlots(db, b.id, d, duration, nowISO()).length > 0) ?? today)
                setStep('time')
              }}
              className="block min-h-16 w-full rounded-2xl bg-surface p-3.5 text-left active:bg-raised"
            >
              <div className="font-bold">{b.name}</div>
              {b.sub && <div className="text-[13px] text-muted">{b.sub}</div>}
            </button>
          ))}
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
                    onClick={() => setSlot(s)}
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
          <Field label="Nome"><Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Celular com DDD"><Input autoComplete="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="E-mail" hint="Enviamos a confirmação e o lembrete por aqui."><Input autoComplete="email" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Toggle checked={optIn} onChange={setOptIn} label="Quero receber promoções" />
        </div>
      )}

      {step === 'done' && booked && (
        <div className="px-4">
          <Card className="flex flex-col items-center gap-2 p-6 text-center">
            <div className="grid size-14 place-items-center rounded-full bg-ok/15 text-ok"><Check size={28} /></div>
            <div className="text-lg font-bold">{weekdayLabel(dateKey(booked.start))}, {dayLabel(dateKey(booked.start))} às {timeOf(booked.start)}</div>
            <div className="text-sm text-muted">Com {db.barbers.find((b) => b.id === booked.barberId)?.name}. A confirmação vai para o seu e-mail.</div>
            {db.settings.address && <div className="text-sm text-muted">{db.settings.address}</div>}
          </Card>
        </div>
      )}

      {step !== 'done' && (
        <div className="pb-safe fixed inset-x-0 bottom-0 border-t border-line bg-bg/95 px-4 pt-3 backdrop-blur">
          <div className="mx-auto max-w-lg">
            {step === 'services' && <Button variant="primary" block disabled={serviceIds.length === 0} onClick={() => setStep('barber')}>Continuar{serviceIds.length > 0 && ` · ${formatBRL(priceOf(db, serviceIds))}`}</Button>}
            {step === 'time' && <Button variant="primary" block disabled={!slot} onClick={() => setStep('details')}>{slot ? `Continuar com ${timeOf(slot.start)}` : 'Escolha um horário'}</Button>}
            {step === 'details' && <Button variant="primary" block onClick={confirm}>Confirmar agendamento</Button>}
            {step === 'barber' && <p className="py-3 text-center text-sm text-muted">Duração: {duration} min</p>}
          </div>
        </div>
      )}
    </div>
  )
}
