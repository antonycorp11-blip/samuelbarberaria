import { Ban, ChevronLeft, ChevronRight, Clock, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { exec, nowISO, useActor, useDb } from '@/data/store'
import { appointmentsOn, OCCUPYING, priceOf, removeBlock, removeFromWaitlist, workWindow } from '@/domain/agenda'
import { formatBRL } from '@/domain/money'
import { occupancy } from '@/domain/reports'
import { addDays, dateKey, dayLabel, minutesOf, startOfWeek, timeFromMinutes, timeOf, weekdayLabel } from '@/domain/time'
import type { DateKey, DbState, ID, ISO } from '@/domain/types'
import { attempt, Badge, Button, Card, Chips, ConfirmSheet, cx, Empty, IconButton, List, Meter, PageHeader, Row, Section, Segmented } from '@/ui/kit'
import { AppointmentSheet, BlockSheet, BookingSheet, STATUS_LABEL } from '@/ui/operations'

const PX = 1.25

const TONE: Record<string, string> = {
  scheduled: 'bg-raised border-l-muted',
  confirmed: 'bg-info/15 border-l-info',
  in_progress: 'bg-brass/20 border-l-brass',
  completed: 'bg-ok/10 border-l-ok',
  no_show: 'bg-warn/10 border-l-warn',
}

function dayRange(db: DbState, date: DateKey) {
  const windows = db.barbers.filter((b) => b.active).map((b) => workWindow(db, b, date)).filter((w) => w !== null)
  if (windows.length === 0) return { open: 9 * 60, close: 18 * 60, closed: true }
  return { open: Math.min(...windows.map((w) => w.open)), close: Math.max(...windows.map((w) => w.close)), closed: false }
}

function DayGrid({ date, barberIds, onOpen, onEmpty, onBlock }: {
  date: DateKey; barberIds: ID[]; onOpen: (id: ID) => void; onEmpty: (barberId: ID) => void; onBlock: (id: ID) => void
}) {
  const db = useDb()
  const { open, close, closed } = dayRange(db, date)
  const height = (close - open) * PX
  const today = dateKey(nowISO()) === date
  const nowMin = minutesOf(timeOf(nowISO()))
  const scroller = useRef<HTMLDivElement>(null)
  const hours = []
  for (let m = Math.ceil(open / 60) * 60; m < close; m += 60) hours.push(m)

  useEffect(() => {
    const box = scroller.current
    if (box) box.scrollTop = today ? (nowMin - open) * PX - box.clientHeight / 2 : 0
    // Só ao abrir o dia: depois disso a rolagem é do usuário.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date])

  if (closed) return <div className="px-4 pt-3"><Empty title="Barbearia fechada" sub="Ninguém atende neste dia." /></div>

  const barbers = barberIds.map((id) => db.barbers.find((b) => b.id === id)).filter((b) => b !== undefined)

  return (
    <div ref={scroller} className="mt-2 overflow-y-auto overscroll-contain px-2" style={{ height: 'max(340px, calc(100dvh - 310px))' }}>
      {barbers.length > 1 && (
        <div className="sticky top-0 z-10 flex bg-bg py-1.5 pl-10">
          {barbers.map((b) => <div key={b.id} className="flex-1 truncate text-center text-[13px] font-bold">{b.name}</div>)}
        </div>
      )}
      <div className="relative flex" style={{ height }}>
        <div className="w-10 shrink-0">
          {hours.map((m) => (
            <div key={m} className="tnum absolute -translate-y-1/2 text-[11px] text-muted" style={{ top: (m - open) * PX }}>{timeFromMinutes(m)}</div>
          ))}
        </div>
        <div className="relative flex flex-1 gap-1">
          {hours.map((m) => <div key={m} className="pointer-events-none absolute inset-x-0 border-t border-line/60" style={{ top: (m - open) * PX }} />)}
          {barbers.map((b) => {
            const win = workWindow(db, b, date)
            const appts = appointmentsOn(db, date).filter((a) => a.barberId === b.id && a.status !== 'cancelled')
            const blocks = db.blocks.filter((k) => (k.barberId === null || k.barberId === b.id) && dateKey(k.start) === date)
            const y = (time: string) => (minutesOf(time) - open) * PX
            return (
              <div
                key={b.id}
                className="relative min-w-0 flex-1"
                onClick={() => onEmpty(b.id)}
              >
                {!win && <div className="hatch absolute inset-0 rounded-lg" />}
                {win && b.breakStart && b.breakEnd && (
                  <div className="hatch absolute inset-x-0 rounded-lg" style={{ top: y(b.breakStart), height: y(b.breakEnd) - y(b.breakStart) }} />
                )}
                {blocks.map((k) => (
                  <button
                    key={`${k.id}${b.id}`}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onBlock(k.id) }}
                    className="hatch absolute inset-x-0 overflow-hidden rounded-lg p-1 text-left text-[11px] font-bold text-muted"
                    style={{ top: y(timeOf(k.start)), height: y(timeOf(k.end)) - y(timeOf(k.start)) }}
                  >
                    {k.reason || 'Bloqueado'}
                  </button>
                ))}
                {appts.map((a) => {
                  const client = db.clients.find((c) => c.id === a.clientId)
                  const h = y(timeOf(a.end)) - y(timeOf(a.start))
                  const first = a.serviceIds[0]
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onOpen(a.id) }}
                      className={cx('absolute inset-x-0 overflow-hidden rounded-lg border-l-[3px] px-1.5 py-0.5 text-left', TONE[a.status])}
                      style={{ top: y(timeOf(a.start)) + 1, height: h - 2 }}
                      aria-label={`${timeOf(a.start)} ${client?.name}, ${STATUS_LABEL[a.status]}`}
                    >
                      <div className={cx('truncate text-[12.5px] leading-4 font-bold', a.status === 'no_show' && 'line-through')}>
                        <span className="tnum font-semibold opacity-70">{timeOf(a.start)} </span>{client?.name.split(' ')[0]}
                      </div>
                      {h > 34 && <div className="truncate text-[11px] leading-3.5 text-muted">{db.services.find((s) => s.id === first)?.name}</div>}
                    </button>
                  )
                })}
              </div>
            )
          })}
          {today && nowMin >= open && nowMin <= close && (
            <div className="pointer-events-none absolute inset-x-0 z-[5] h-0.5 bg-bad" style={{ top: (nowMin - open) * PX }} />
          )}
        </div>
      </div>
    </div>
  )
}

function WeekList({ start, barberIds, onPick }: { start: DateKey; barberIds: ID[]; onPick: (d: DateKey) => void }) {
  const db = useDb()
  const today = dateKey(nowISO())
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i))
  const single = barberIds.length === 1 ? barberIds[0] : undefined
  return (
    <div className="space-y-2 px-4 pt-3">
      {days.map((d) => {
        const appts = appointmentsOn(db, d).filter((a) => barberIds.includes(a.barberId) && OCCUPYING.includes(a.status))
        const value = appts.reduce((t, a) => t + priceOf(db, a.serviceIds), 0)
        const occ = occupancy(db, d, d, single)
        return (
          <button key={d} type="button" onClick={() => onPick(d)} className="block w-full text-left">
            <Card className={cx('flex items-center gap-3 p-3 active:bg-raised', d === today && 'ring-1 ring-brass')}>
              <div className="w-11 text-center">
                <div className="text-[11px] font-bold text-muted uppercase">{weekdayLabel(d)}</div>
                <div className="tnum text-xl leading-6 font-extrabold">{Number(d.slice(8))}</div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex justify-between text-sm font-semibold">
                  <span>{appts.length} {appts.length === 1 ? 'horário' : 'horários'}</span>
                  <span className="tnum text-muted">{formatBRL(value)}</span>
                </div>
                <div className="mt-1.5"><Meter bps={occ} /></div>
              </div>
            </Card>
          </button>
        )
      })}
    </div>
  )
}

export default function AgendaPage() {
  const db = useDb()
  const actor = useActor()
  const today = dateKey(nowISO())
  const [view, setView] = useState<'day' | 'week'>('day')
  const [date, setDate] = useState(today)
  const [filter, setFilter] = useState<string>(actor.barberId ?? 'all')
  const [openId, setOpenId] = useState<ID | null>(null)
  const [booking, setBooking] = useState<{ barberId?: ID; date: DateKey; start?: ISO; clientId?: ID; serviceIds?: ID[]; waitlistId?: ID } | null>(null)
  const [blocking, setBlocking] = useState(false)
  const [blockId, setBlockId] = useState<ID | null>(null)

  const active = db.barbers.filter((b) => b.active)
  const barberIds = useMemo(
    () => (filter === 'all' ? db.barbers.filter((b) => b.active).map((b) => b.id) : [filter]),
    [db.barbers, filter],
  )
  const waiting = db.waitlist.filter((w) => ['waiting', 'notified'].includes(w.status) && w.date >= today)
  const step = view === 'day' ? 1 : 7
  const weekStart = startOfWeek(date)
  const block = db.blocks.find((b) => b.id === blockId)

  return (
    <>
      <PageHeader
        title="Agenda"
        sub={view === 'day' ? `${weekdayLabel(date)}, ${dayLabel(date)}` : `Semana de ${dayLabel(weekStart)}`}
        action={
          <div className="flex gap-2">
            <IconButton label="Bloquear horário" onClick={() => setBlocking(true)}><Ban size={19} /></IconButton>
            <IconButton label="Novo agendamento" className="bg-brass text-brass-ink" onClick={() => setBooking({ date })}><Plus size={21} /></IconButton>
          </div>
        }
      />
      <div className="space-y-2 px-4">
        <div className="flex items-center gap-2">
          <IconButton label="Anterior" onClick={() => setDate(addDays(date, -step))}><ChevronLeft size={20} /></IconButton>
          <Segmented className="flex-1" value={view} onChange={setView} options={[{ value: 'day', label: 'Dia' }, { value: 'week', label: 'Semana' }]} />
          <IconButton label="Próximo" onClick={() => setDate(addDays(date, step))}><ChevronRight size={20} /></IconButton>
        </div>
        <div className="flex items-center gap-2">
          {date !== today && <Button className="min-h-11 shrink-0 px-3 text-sm" onClick={() => setDate(today)}>Hoje</Button>}
          {actor.role === 'owner' && (
            <div className="min-w-0 flex-1">
              <Chips value={filter} onChange={setFilter} options={[{ value: 'all', label: 'Todos' }, ...active.map((b) => ({ value: b.id, label: b.name }))]} />
            </div>
          )}
        </div>
      </div>

      {view === 'day' ? (
        <DayGrid
          date={date}
          barberIds={barberIds}
          onOpen={setOpenId}
          onBlock={setBlockId}
          onEmpty={(barberId) => setBooking({ barberId, date })}
        />
      ) : (
        <WeekList start={weekStart} barberIds={barberIds} onPick={(d) => { setDate(d); setView('day') }} />
      )}

      {waiting.length > 0 && (
        <Section title={`Lista de espera (${waiting.length})`}>
          <List>
            {waiting.map((w) => {
              const client = db.clients.find((c) => c.id === w.clientId)
              return (
                <Row
                  key={w.id}
                  left={<Clock size={18} className="text-brass" />}
                  title={client?.name}
                  sub={`${dayLabel(w.date)} · ${w.serviceIds.map((s) => db.services.find((x) => x.id === s)?.name).join(' + ')}`}
                  right={w.status === 'notified' ? <Badge tone="info">Avisado</Badge> : <Badge>Aguardando</Badge>}
                  onClick={() => setBooking({ date: w.date, clientId: w.clientId, serviceIds: w.serviceIds, waitlistId: w.id, barberId: w.barberId ?? undefined })}
                />
              )
            })}
          </List>
          <Button variant="ghost" className="mt-1 min-h-10 text-sm" onClick={() => {
            const first = waiting[0]
            if (first) attempt(() => exec(removeFromWaitlist, { id: first.id }), 'Removido da lista')
          }}>
            Remover o primeiro da lista
          </Button>
        </Section>
      )}

      {openId && <AppointmentSheet id={openId} onClose={() => setOpenId(null)} />}
      {booking && <BookingSheet initial={booking} onClose={() => setBooking(null)} />}
      {blocking && <BlockSheet date={date} barberId={filter === 'all' ? null : filter} onClose={() => setBlocking(false)} />}
      {block && (
        <ConfirmSheet
          title="Liberar horário?"
          text={`${timeOf(block.start)} às ${timeOf(block.end)}${block.reason ? ` · ${block.reason}` : ''}`}
          confirm="Liberar"
          onClose={() => setBlockId(null)}
          onConfirm={() => {
            if (attempt(() => exec(removeBlock, { id: block.id }), 'Horário liberado')) setBlockId(null)
          }}
        />
      )}
    </>
  )
}
