import { Check, Clock, Plus, Search, Trash2, UserPlus, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { exec, getCtx, nowISO, useActor, useDb } from '@/data/store'
import {
  addToWaitlist, availableSlots, cancelAppointment, canTransition, createAppointment, createBlock, durationOf, findFitIns,
  priceOf, rescheduleAppointment, setAppointmentStatus,
} from '@/domain/agenda'
import { upsertClient } from '@/domain/clients'
import { DomainError } from '@/domain/errors'
import { METHOD_LABEL } from '@/domain/finance'
import { formatBRL } from '@/domain/money'
import { activeSubscription, checkout, quote, type CheckoutItem } from '@/domain/sales'
import { addDays, brDate, dateKey, dayLabel, timeOf, toISO, weekdayLabel } from '@/domain/time'
import type { Appointment, AppointmentStatus, DateKey, ID, ISO, PaymentMethod } from '@/domain/types'
import {
  Avatar, Badge, Button, Chips, ConfirmSheet, cx, Field, IconButton, Input, MoneyInput, Row, Sheet, Textarea, Toggle, attempt,
} from './kit'

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled: 'Agendado', confirmed: 'Confirmado', in_progress: 'Em atendimento', completed: 'Concluído', cancelled: 'Cancelado', no_show: 'Faltou',
}
export const STATUS_TONE: Record<AppointmentStatus, 'muted' | 'ok' | 'bad' | 'warn' | 'info' | 'brass'> = {
  scheduled: 'muted', confirmed: 'info', in_progress: 'brass', completed: 'ok', cancelled: 'bad', no_show: 'warn',
}

const METHODS = (Object.keys(METHOD_LABEL) as PaymentMethod[]).map((value) => ({ value, label: METHOD_LABEL[value] }))

/* ---------- escolher cliente ---------- */

export function ClientPicker({ value, onChange }: { value: ID | null; onChange: (id: ID | null) => void }) {
  const db = useDb()
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const selected = db.clients.find((c) => c.id === value)
  const term = q.trim().toLowerCase()
  const digits = term.replace(/\D/g, '')
  const results = term
    ? db.clients.filter((c) => c.name.toLowerCase().includes(term) || (digits.length >= 3 && c.phone.includes(digits))).slice(0, 5)
    : []

  if (selected) {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-raised p-2.5">
        <Avatar name={selected.name} size={36} />
        <div className="min-w-0 flex-1 truncate font-semibold">{selected.name}</div>
        <Button variant="ghost" className="min-h-9" onClick={() => onChange(null)}>Trocar</Button>
      </div>
    )
  }
  if (adding) {
    return (
      <div className="space-y-2 rounded-xl bg-raised p-3">
        <Input placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <Input placeholder="Celular com DDD" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Input placeholder="E-mail (para lembretes)" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <Button variant="ghost" onClick={() => setAdding(false)}>Voltar</Button>
          <Button
            variant="primary"
            onClick={() =>
              attempt(() => {
                onChange(exec(upsertClient, { name, phone, email, birthday: null, notes: '', marketingOptIn: false }))
                setAdding(false)
              })
            }
          >
            Salvar
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={18} className="absolute top-1/2 left-3.5 -translate-y-1/2 text-muted" />
        <Input className="pl-10" placeholder="Nome ou celular" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar cliente" />
      </div>
      {results.length > 0 && (
        <div className="divide-y divide-line/70 overflow-hidden rounded-xl bg-raised">
          {results.map((c) => <Row key={c.id} title={c.name} sub={c.phone} onClick={() => onChange(c.id)} />)}
        </div>
      )}
      <Button variant="link" className="min-h-10 px-1" onClick={() => { setAdding(true); setName(/\d/.test(q) ? '' : q) }}>
        <UserPlus size={17} /> Cadastrar novo cliente
      </Button>
    </div>
  )
}

function DatePicker({ value, onChange, days = 14 }: { value: DateKey; onChange: (d: DateKey) => void; days?: number }) {
  const today = dateKey(nowISO())
  const list = Array.from({ length: days }, (_, i) => addDays(today, i))
  return (
    <div className="no-bar -mx-4 flex gap-1.5 overflow-x-auto px-4 py-0.5">
      {list.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={d === value}
          onClick={() => onChange(d)}
          className={cx('flex h-15 w-12 shrink-0 flex-col items-center justify-center rounded-xl', d === value ? 'bg-brass text-brass-ink' : 'bg-raised')}
        >
          <span className="text-[11px] font-semibold uppercase opacity-75">{weekdayLabel(d)}</span>
          <span className="tnum text-lg leading-tight font-extrabold">{Number(d.slice(8))}</span>
        </button>
      ))}
    </div>
  )
}

function SlotGrid({ slots, value, onPick }: { slots: ISO[]; value: ISO | null; onPick: (s: ISO) => void }) {
  if (slots.length === 0) return <p className="rounded-xl bg-raised p-3 text-sm text-muted">Sem horário livre neste dia.</p>
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {slots.map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={s === value}
          onClick={() => onPick(s)}
          className={cx('tnum min-h-11 rounded-lg text-sm font-bold', s === value ? 'bg-brass text-brass-ink' : 'bg-raised')}
        >
          {timeOf(s)}
        </button>
      ))}
    </div>
  )
}

/* ---------- novo agendamento ---------- */

export function BookingSheet({ onClose, initial }: {
  onClose: () => void
  initial?: { barberId?: ID; date?: DateKey; start?: ISO; clientId?: ID; fitIn?: boolean; waitlistId?: ID; serviceIds?: ID[] }
}) {
  const db = useDb()
  const actor = useActor()
  const barbers = db.barbers.filter((b) => b.active && (actor.role === 'owner' || b.id === actor.barberId))
  const services = db.services.filter((s) => s.active)
  const [clientId, setClientId] = useState<ID | null>(initial?.clientId ?? null)
  const [serviceIds, setServiceIds] = useState<ID[]>(initial?.serviceIds ?? [])
  const [barberId, setBarberId] = useState<ID | null>(initial?.barberId ?? actor.barberId ?? barbers[0]?.id ?? null)
  const [date, setDate] = useState<DateKey>(initial?.date ?? dateKey(nowISO()))
  const [start, setStart] = useState<ISO | null>(initial?.start ?? null)
  const [notes, setNotes] = useState('')
  const fitIn = Boolean(initial?.fitIn)

  const duration = serviceIds.length ? durationOf(db, serviceIds) : 0
  const now = nowISO()
  const slots = useMemo(
    () => (barberId && duration ? availableSlots(db, barberId, date, duration, now) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, barberId, date, duration],
  )
  const fits = useMemo(
    () => (fitIn && duration ? findFitIns(db, { durationMin: duration, from: now, limit: 6 }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, fitIn, duration],
  )

  const toggleService = (id: ID) => {
    setStart(null)
    setServiceIds((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))
  }

  const canSave = clientId && barberId && serviceIds.length > 0 && start
  const save = () =>
    attempt(() => {
      exec(createAppointment, {
        clientId: clientId as ID, barberId: barberId as ID, serviceIds, start: start as ISO, notes, fitIn, waitlistId: initial?.waitlistId,
      })
      onClose()
    }, 'Horário marcado')

  return (
    <Sheet
      title={fitIn ? 'Encaixe' : 'Novo agendamento'}
      onClose={onClose}
      footer={
        <Button variant="primary" block disabled={!canSave} onClick={save}>
          {start ? `Marcar às ${timeOf(start)}` : 'Escolha um horário'}
          {serviceIds.length > 0 && ` · ${formatBRL(priceOf(db, serviceIds))}`}
        </Button>
      }
    >
      <Field label="Cliente"><ClientPicker value={clientId} onChange={setClientId} /></Field>
      <div>
        <span className="mb-1.5 block text-[13px] font-bold text-muted">Serviços</span>
        <Chips multi value={serviceIds} onChange={toggleService} options={services.map((s) => ({ value: s.id, label: s.name, sub: `${s.durationMin}min` }))} />
      </div>
      {fitIn ? (
        <div>
          <span className="mb-1.5 block text-[13px] font-bold text-muted">Próximos horários livres</span>
          {duration === 0 && <p className="rounded-xl bg-raised p-3 text-sm text-muted">Escolha o serviço para ver os encaixes.</p>}
          {duration > 0 && fits.length === 0 && <p className="rounded-xl bg-raised p-3 text-sm text-muted">Nenhum horário livre nos próximos dias.</p>}
          <div className="grid grid-cols-2 gap-1.5">
            {fits.map((f) => {
              const on = f.start === start && f.barberId === barberId
              return (
                <button
                  key={`${f.barberId}${f.start}`}
                  type="button"
                  aria-pressed={on}
                  onClick={() => { setBarberId(f.barberId); setStart(f.start) }}
                  className={cx('rounded-xl p-2.5 text-left', on ? 'bg-brass text-brass-ink' : 'bg-raised')}
                >
                  <div className="tnum font-extrabold">{timeOf(f.start)} <span className="text-xs font-semibold opacity-70">{dateKey(f.start) === dateKey(now) ? 'hoje' : dayLabel(dateKey(f.start))}</span></div>
                  <div className="text-[13px] opacity-75">{db.barbers.find((b) => b.id === f.barberId)?.name}</div>
                </button>
              )
            })}
          </div>
        </div>
      ) : (
        <>
          {barbers.length > 1 && (
            <div>
              <span className="mb-1.5 block text-[13px] font-bold text-muted">Profissional</span>
              <Chips value={barberId} onChange={(id) => { setBarberId(id); setStart(null) }} options={barbers.map((b) => ({ value: b.id, label: b.name }))} />
            </div>
          )}
          <div>
            <span className="mb-1.5 block text-[13px] font-bold text-muted">Dia</span>
            <DatePicker value={date} onChange={(d) => { setDate(d); setStart(null) }} />
          </div>
          {duration > 0 && (
            <div>
              <span className="mb-1.5 block text-[13px] font-bold text-muted">Horário ({duration} min)</span>
              <SlotGrid slots={slots} value={start} onPick={setStart} />
              {slots.length === 0 && clientId && (
                <Button
                  variant="ghost"
                  className="mt-1 min-h-10 px-1 text-brass"
                  onClick={() =>
                    attempt(() => {
                      exec(addToWaitlist, { clientId, serviceIds, barberId, date })
                      onClose()
                    }, 'Cliente na lista de espera')
                  }
                >
                  <Clock size={17} /> Colocar na lista de espera
                </Button>
              )}
            </div>
          )}
        </>
      )}
      <Field label="Observação"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" /></Field>
    </Sheet>
  )
}

/* ---------- detalhe do atendimento ---------- */

export function AppointmentSheet({ id, onClose }: { id: ID; onClose: () => void }) {
  const db = useDb()
  const [mode, setMode] = useState<'view' | 'checkout' | 'reschedule' | 'cancel'>('view')
  const a = db.appointments.find((x) => x.id === id)
  if (!a) return null
  const client = db.clients.find((c) => c.id === a.clientId)
  const barber = db.barbers.find((b) => b.id === a.barberId)
  const names = a.serviceIds.map((s) => db.services.find((x) => x.id === s)?.name).join(' + ')
  const sale = db.sales.find((s) => s.id === a.saleId)
  const closable = ['scheduled', 'confirmed', 'in_progress'].includes(a.status)
  const set = (status: 'confirmed' | 'in_progress' | 'no_show', msg: string) => attempt(() => exec(setAppointmentStatus, { id, status }), msg)

  if (mode === 'checkout') return <CheckoutSheet appointment={a} onClose={onClose} onBack={() => setMode('view')} />
  if (mode === 'reschedule') return <RescheduleSheet appointment={a} onClose={() => setMode('view')} />
  if (mode === 'cancel') {
    return (
      <ConfirmSheet
        title="Cancelar horário?"
        text={`${client?.name} às ${timeOf(a.start)}. O cliente recebe um aviso e o horário volta a ficar livre.`}
        confirm="Cancelar horário"
        danger
        onClose={() => setMode('view')}
        onConfirm={() => {
          if (attempt(() => exec(cancelAppointment, { id }), 'Horário cancelado')) onClose()
        }}
      />
    )
  }

  return (
    <Sheet
      title={client?.name ?? 'Atendimento'}
      onClose={onClose}
      footer={
        closable ? <Button variant="primary" block onClick={() => setMode('checkout')}><Check size={19} /> Fechar atendimento</Button> : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Badge>
        {a.source === 'online' && <Badge tone="info">Online</Badge>}
        {a.source === 'fit_in' && <Badge tone="brass">Encaixe</Badge>}
        {sale?.status === 'refunded' && <Badge tone="bad">Estornado</Badge>}
      </div>
      <div className="rounded-xl bg-raised p-3.5">
        <div className="tnum text-2xl font-extrabold">{timeOf(a.start)} – {timeOf(a.end)}</div>
        <div className="text-sm text-muted">{weekdayLabel(dateKey(a.start))}, {brDate(dateKey(a.start))} · {barber?.name}</div>
        <div className="mt-2 font-semibold">{names}</div>
        <div className="tnum text-sm text-muted">{formatBRL(sale?.totalCents ?? priceOf(db, a.serviceIds))}</div>
        {a.notes && <p className="mt-2 text-sm text-muted">{a.notes}</p>}
        {client?.notes && <p className="mt-2 text-sm text-warn">{client.notes}</p>}
      </div>
      {closable && (
        <div className="grid grid-cols-2 gap-2">
          {canTransition(a.status, 'confirmed') && <Button onClick={() => set('confirmed', 'Confirmado')}>Confirmar</Button>}
          {canTransition(a.status, 'in_progress') && <Button onClick={() => set('in_progress', 'Atendimento iniciado')}>Iniciar</Button>}
          {a.status !== 'in_progress' && <Button onClick={() => setMode('reschedule')}>Remarcar</Button>}
          {canTransition(a.status, 'no_show') && <Button onClick={() => set('no_show', 'Marcado como falta')}>Faltou</Button>}
          <Button variant="danger" className="col-span-2" onClick={() => setMode('cancel')}>Cancelar horário</Button>
        </div>
      )}
      {client && <Link to={`/clientes/${client.id}`} onClick={onClose} className="block text-center text-sm font-bold text-brass">Ver ficha do cliente</Link>}
    </Sheet>
  )
}

function RescheduleSheet({ appointment: a, onClose }: { appointment: Appointment; onClose: () => void }) {
  const db = useDb()
  const [barberId, setBarberId] = useState(a.barberId)
  const [date, setDate] = useState(dateKey(a.start))
  const [start, setStart] = useState<ISO | null>(null)
  const duration = durationOf(db, a.serviceIds)
  const barbers = db.barbers.filter((b) => b.active)
  const slots = availableSlots(db, barberId, date, duration, nowISO())
  return (
    <Sheet
      title="Remarcar"
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          block
          disabled={!start}
          onClick={() => {
            if (attempt(() => exec(rescheduleAppointment, { id: a.id, barberId, start: start as ISO }), 'Horário remarcado')) onClose()
          }}
        >
          Confirmar novo horário
        </Button>
      }
    >
      <Chips value={barberId} onChange={(id) => { setBarberId(id); setStart(null) }} options={barbers.map((b) => ({ value: b.id, label: b.name }))} />
      <DatePicker value={date} onChange={(d) => { setDate(d); setStart(null) }} />
      <SlotGrid slots={slots} value={start} onPick={setStart} />
    </Sheet>
  )
}

/* ---------- fechamento ---------- */

export function CheckoutSheet({ appointment, onClose, onBack }: { appointment?: Appointment; onClose: () => void; onBack?: () => void }) {
  const db = useDb()
  const actor = useActor()
  const [clientId, setClientId] = useState<ID | null>(appointment?.clientId ?? null)
  const [barberId, setBarberId] = useState<ID | null>(appointment?.barberId ?? actor.barberId ?? db.barbers.find((b) => b.active)?.id ?? null)
  const [items, setItems] = useState<CheckoutItem[]>(appointment?.serviceIds.map((refId) => ({ kind: 'service', refId, qty: 1 })) ?? [])
  const [coupon, setCoupon] = useState('')
  const [appliedCoupon, setAppliedCoupon] = useState('')
  const [manual, setManual] = useState(0)
  const client = db.clients.find((c) => c.id === clientId)
  const sub = activeSubscription(db, clientId)
  const plan = sub && db.plans.find((p) => p.id === sub.planId)
  const visitsLeft = plan && sub ? (plan.visitsPerCycle === null ? Infinity : plan.visitsPerCycle - sub.usedVisits) : 0
  const coverable = Boolean(plan && visitsLeft > 0 && items.some((i) => i.kind === 'service' && plan.serviceIds.includes(i.refId)))
  const [useSub, setUseSub] = useState(true)
  const [useReward, setUseReward] = useState(false)
  const [payments, setPayments] = useState<{ method: PaymentMethod; amountCents: number }[]>([{ method: 'pix', amountCents: 0 }])
  const [received, setReceived] = useState(0)
  const [adding, setAdding] = useState(false)

  const input = {
    appointmentId: appointment?.id ?? null, clientId, barberId: barberId ?? '', items,
    couponCode: appliedCoupon || undefined, manualDiscountCents: manual,
    useSubscription: coverable && useSub, useReward: useReward && (client?.rewards ?? 0) > 0,
  }
  let q: ReturnType<typeof quote> | null = null
  let quoteError = ''
  if (items.length > 0 && barberId) {
    try {
      q = quote(db, input, getCtx())
    } catch (e) {
      if (e instanceof DomainError) quoteError = e.message
      else throw e
    }
  }
  const total = q?.totalCents ?? 0
  const split = payments.length > 1
  const finalPayments = total === 0 ? [] : split ? payments : [{ method: payments[0]?.method ?? 'pix', amountCents: total }]
  const paid = finalPayments.reduce((t, p) => t + p.amountCents, 0)
  const missing = total - paid
  const cashOnly = !split && payments[0]?.method === 'cash' && total > 0

  const setLine = (index: number, qty: number) =>
    setItems((list) => (qty <= 0 ? list.filter((_, i) => i !== index) : list.map((x, i) => (i === index ? { ...x, qty } : x))))
  const addLine = (kind: 'service' | 'product', refId: ID) => {
    setItems((list) => {
      const at = list.findIndex((x) => x.kind === kind && x.refId === refId)
      return at >= 0 ? list.map((x, i) => (i === at ? { ...x, qty: x.qty + 1 } : x)) : [...list, { kind, refId, qty: 1 }]
    })
    setAdding(false)
  }

  const finish = () => {
    if (attempt(() => exec(checkout, { ...input, barberId: barberId as ID, payments: finalPayments }), 'Atendimento fechado')) onClose()
  }

  return (
    <Sheet
      title={appointment ? 'Fechar atendimento' : 'Venda rápida'}
      onClose={onBack ?? onClose}
      footer={
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted">Total{q && q.discountCents > 0 ? ` (desconto ${formatBRL(q.discountCents)})` : ''}</span>
            <span className="tnum text-2xl font-extrabold">{formatBRL(total)}</span>
          </div>
          <Button variant="primary" block disabled={!q || missing !== 0} onClick={finish}>
            {split && missing !== 0 ? `Faltam ${formatBRL(missing)}` : total === 0 ? 'Concluir sem cobrança' : 'Confirmar pagamento'}
          </Button>
        </div>
      }
    >
      {!appointment && (
        <>
          <Field label="Cliente (opcional)"><ClientPicker value={clientId} onChange={setClientId} /></Field>
          {actor.role === 'owner' && (
            <Chips value={barberId} onChange={setBarberId} options={db.barbers.filter((b) => b.active).map((b) => ({ value: b.id, label: b.name }))} />
          )}
        </>
      )}

      <div className="divide-y divide-line/70 overflow-hidden rounded-xl bg-raised">
        {items.map((it, i) => {
          const line = q?.items[i]
          const ref = it.kind === 'service' ? db.services.find((s) => s.id === it.refId) : db.products.find((p) => p.id === it.refId)
          return (
            <div key={`${it.kind}${it.refId}`} className="flex items-center gap-2 p-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold">{ref?.name}</div>
                <div className="tnum text-[13px] text-muted">
                  {line?.coverage === 'subscription' ? 'Coberto pelo plano' : line?.coverage === 'reward' ? 'Recompensa' : formatBRL(line?.netCents ?? 0)}
                </div>
              </div>
              <IconButton label="Diminuir" className="size-9 bg-surface" onClick={() => setLine(i, it.qty - 1)}>
                {it.qty === 1 ? <Trash2 size={16} /> : '−'}
              </IconButton>
              <span className="tnum w-5 text-center font-bold">{it.qty}</span>
              <IconButton label="Aumentar" className="size-9 bg-surface" onClick={() => setLine(i, it.qty + 1)}>+</IconButton>
            </div>
          )
        })}
        {adding ? (
          <div className="max-h-64 divide-y divide-line/70 overflow-y-auto">
            {db.services.filter((s) => s.active).map((s) => <Row key={s.id} title={s.name} right={formatBRL(s.priceCents)} onClick={() => addLine('service', s.id)} />)}
            {db.products.filter((p) => p.active).map((p) => (
              <Row key={p.id} title={p.name} sub={`${p.qty} em estoque`} right={formatBRL(p.salePriceCents)} onClick={() => addLine('product', p.id)} />
            ))}
          </div>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="flex min-h-12 w-full items-center gap-2 px-3 text-sm font-bold text-brass">
            <Plus size={17} /> Adicionar serviço ou produto
          </button>
        )}
      </div>
      {quoteError && <p className="rounded-xl bg-bad/15 p-3 text-sm font-semibold text-bad">{quoteError}</p>}

      {plan && coverable && (
        <Toggle
          checked={useSub}
          onChange={setUseSub}
          label={`Usar ${plan.name}`}
          hint={visitsLeft === Infinity ? 'Plano ilimitado' : `${visitsLeft} visita(s) restante(s) no ciclo`}
        />
      )}
      {(client?.rewards ?? 0) > 0 && (
        <Toggle checked={useReward} onChange={setUseReward} label="Resgatar cartão fidelidade" hint="Serviço de maior valor sai grátis" />
      )}

      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Input placeholder="Cupom" value={coupon} autoCapitalize="characters" onChange={(e) => setCoupon(e.target.value)} aria-label="Cupom" />
        <Button onClick={() => setAppliedCoupon(appliedCoupon ? '' : coupon)}>{appliedCoupon ? 'Remover' : 'Aplicar'}</Button>
      </div>
      {actor.role === 'owner' && <Field label="Desconto manual"><MoneyInput value={manual} onChange={setManual} /></Field>}

      {total > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-bold text-muted">Pagamento</span>
            <Button
              variant="ghost"
              className="min-h-8 px-1 text-sm text-brass"
              onClick={() => setPayments(split ? [payments[0] ?? { method: 'pix', amountCents: 0 }] : [{ method: 'pix', amountCents: 0 }, { method: 'cash', amountCents: 0 }])}
            >
              {split ? 'Forma única' : 'Dividir pagamento'}
            </Button>
          </div>
          {payments.map((p, i) => (
            <div key={i} className="space-y-1.5">
              <Chips
                value={p.method}
                onChange={(method) => setPayments((list) => list.map((x, k) => (k === i ? { ...x, method } : x)))}
                options={METHODS}
              />
              {split && (
                <MoneyInput
                  aria-label={`Valor ${i + 1}`}
                  value={p.amountCents}
                  onChange={(amountCents) => setPayments((list) => list.map((x, k) => (k === i ? { ...x, amountCents } : x)))}
                />
              )}
            </div>
          ))}
          {cashOnly && (
            <Field label="Valor recebido" hint={received > total ? `Troco: ${formatBRL(received - total)}` : undefined}>
              <MoneyInput value={received} onChange={setReceived} />
            </Field>
          )}
        </div>
      )}
    </Sheet>
  )
}

/* ---------- bloqueio ---------- */

export function BlockSheet({ onClose, date: initialDate, barberId: initialBarber }: { onClose: () => void; date?: DateKey; barberId?: ID | null }) {
  const db = useDb()
  const actor = useActor()
  const owner = actor.role === 'owner'
  const [barberId, setBarberId] = useState<string>(actor.barberId ?? initialBarber ?? 'all')
  const [date, setDate] = useState(initialDate ?? dateKey(nowISO()))
  const [from, setFrom] = useState('12:00')
  const [to, setTo] = useState('13:00')
  const [reason, setReason] = useState('')
  const options = [
    ...(owner ? [{ value: 'all', label: 'Barbearia toda' }] : []),
    ...db.barbers.filter((b) => b.active && (owner || b.id === actor.barberId)).map((b) => ({ value: b.id, label: b.name })),
  ]
  return (
    <Sheet
      title="Bloquear horário"
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          block
          onClick={() => {
            const ok = attempt(
              () => exec(createBlock, { barberId: barberId === 'all' ? null : barberId, start: toISO(date, from), end: toISO(date, to), reason }),
              'Horário bloqueado',
            )
            if (ok) onClose()
          }}
        >
          Bloquear
        </Button>
      }
    >
      <Chips value={barberId} onChange={setBarberId} options={options} />
      <Field label="Dia"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Das"><Input type="time" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Até"><Input type="time" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <Field label="Motivo"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Opcional" /></Field>
    </Sheet>
  )
}

/* ---------- ações rápidas ---------- */

export function QuickActions({ onClose, onPick }: { onClose: () => void; onPick: (a: 'booking' | 'fitin' | 'sale' | 'block') => void }) {
  const items = [
    { id: 'booking' as const, label: 'Novo agendamento', sub: 'Escolher dia e horário', icon: Plus },
    { id: 'fitin' as const, label: 'Encaixe', sub: 'Primeiro horário livre', icon: Zap },
    { id: 'sale' as const, label: 'Venda rápida', sub: 'Produto ou serviço sem agenda', icon: Check },
    { id: 'block' as const, label: 'Bloquear horário', sub: 'Almoço, folga, compromisso', icon: Clock },
  ]
  return (
    <Sheet title="O que você quer fazer?" onClose={onClose}>
      <div className="divide-y divide-line/70 overflow-hidden rounded-xl bg-raised">
        {items.map((i) => (
          <Row key={i.id} title={i.label} sub={i.sub} left={<i.icon size={20} className="text-brass" />} onClick={() => onPick(i.id)} />
        ))}
      </div>
    </Sheet>
  )
}

