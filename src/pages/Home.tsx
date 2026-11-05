import { AlertTriangle, CalendarClock, ChevronRight, Package, Receipt, Wallet } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { nowISO, useActor, useDb } from '@/data/store'
import { appointmentsOn } from '@/domain/agenda'
import { averageTicket, dre, lastDays, revenueSeries } from '@/domain/finance'
import { formatBRL, formatBps } from '@/domain/money'
import { occupancy } from '@/domain/reports'
import { isLowStock } from '@/domain/stock'
import { subscriptionMetrics } from '@/domain/subscriptions'
import { commissionBalance } from '@/domain/team'
import { dateKey, dayLabel, startOfMonth, timeOf, weekdayLabel } from '@/domain/time'
import type { ID } from '@/domain/types'
import { Avatar, Badge, Bars, Card, Empty, List, Row, Section, Stat } from '@/ui/kit'
import { AppointmentSheet, STATUS_LABEL, STATUS_TONE } from '@/ui/operations'

export default function HomePage() {
  const db = useDb()
  const actor = useActor()
  const [openId, setOpenId] = useState<ID | null>(null)
  const now = nowISO()
  const today = dateKey(now)
  const owner = actor.role === 'owner'

  const day = useMemo(() => dre(db, today, today), [db, today])
  const month = useMemo(() => dre(db, startOfMonth(today), today), [db, today])
  const series = useMemo(() => {
    const { from, to } = lastDays(today, 14)
    return revenueSeries(db, from, to).map((d) => ({ label: dayLabel(d.date), value: d.cents }))
  }, [db, today])

  const upcoming = appointmentsOn(db, today)
    .filter((a) => ['scheduled', 'confirmed', 'in_progress'].includes(a.status) && (owner || a.barberId === actor.barberId))
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 5)

  const low = db.products.filter(isLowStock)
  const pendingCommission = db.barbers.reduce((t, b) => t + Math.max(0, commissionBalance(db, b.id).pendingCents), 0)
  const club = subscriptionMetrics(db)
  const mine = actor.barberId ? commissionBalance(db, actor.barberId) : null
  const hour = Number(timeOf(now).slice(0, 2))
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite'

  return (
    <>
      <header className="pt-safe px-4 pb-1">
        <p className="text-sm text-muted">{weekdayLabel(today)}, {dayLabel(today)}</p>
        <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">{greeting}, {actor.name.split(' ')[0]}</h1>
      </header>

      {owner ? (
        <div className="px-4 pt-3">
          <Card className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-muted">Faturamento hoje</div>
                <div className="tnum mt-0.5 text-[34px] leading-10 font-extrabold tracking-tight">{formatBRL(day.grossRevenue)}</div>
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold text-muted">Lucro hoje</div>
                <div className={`tnum mt-1.5 text-lg font-extrabold ${day.netProfit >= 0 ? 'text-ok' : 'text-bad'}`}>{formatBRL(day.netProfit)}</div>
              </div>
            </div>
            <div className="mt-4"><Bars data={series} format={formatBRL} /></div>
          </Card>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Stat label="Faturamento do mês" value={formatBRL(month.grossRevenue)} hint={`Lucro ${formatBRL(month.netProfit)}`} />
            <Stat label="Ticket médio do mês" value={formatBRL(averageTicket(db, startOfMonth(today), today))} />
            <Stat label="Ocupação hoje" value={formatBps(occupancy(db, today, today))} />
            <Stat label="Receita recorrente" value={formatBRL(club.mrrCents)} hint={`${club.activeCount} assinantes`} />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 px-4 pt-3">
          <Stat label="Comissão a receber" value={formatBRL(mine?.pendingCents ?? 0)} tone="ok" />
          <Stat label="Já recebido" value={formatBRL(mine?.paidCents ?? 0)} />
        </div>
      )}

      <Section title="Próximos de hoje" action={<Link to="/agenda" className="text-sm font-bold text-brass">Agenda</Link>}>
        {upcoming.length === 0 ? (
          <Empty title="Nada pendente hoje" sub="Os próximos horários aparecem aqui." />
        ) : (
          <List>
            {upcoming.map((a) => {
              const client = db.clients.find((c) => c.id === a.clientId)
              const barber = db.barbers.find((b) => b.id === a.barberId)
              return (
                <Row
                  key={a.id}
                  left={<Avatar name={client?.name ?? '?'} />}
                  title={client?.name}
                  sub={`${timeOf(a.start)} · ${a.serviceIds.map((s) => db.services.find((x) => x.id === s)?.name).join(' + ')}${owner ? ` · ${barber?.name}` : ''}`}
                  right={<Badge tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Badge>}
                  onClick={() => setOpenId(a.id)}
                />
              )
            })}
          </List>
        )}
      </Section>

      {owner && (low.length > 0 || pendingCommission > 0 || club.pastDueCount > 0) && (
        <Section title="Precisa de atenção">
          <List>
            {low.length > 0 && (
              <Row to="/estoque" left={<Package size={20} className="text-warn" />} title={`${low.length} ${low.length === 1 ? 'produto' : 'produtos'} com estoque baixo`} sub={low.slice(0, 2).map((p) => p.name).join(', ')} right={<ChevronRight size={18} />} />
            )}
            {pendingCommission > 0 && (
              <Row to="/equipe" left={<Wallet size={20} className="text-brass" />} title="Comissões a pagar" sub={formatBRL(pendingCommission)} right={<ChevronRight size={18} />} />
            )}
            {club.pastDueCount > 0 && (
              <Row to="/clube" left={<AlertTriangle size={20} className="text-bad" />} title={`${club.pastDueCount} assinante(s) em atraso`} sub={`${formatBRL(club.openCents)} em aberto`} right={<ChevronRight size={18} />} />
            )}
          </List>
        </Section>
      )}

      {owner && (
        <div className="grid grid-cols-2 gap-2 px-4 pt-5">
          <Link to="/financeiro"><Card className="flex items-center gap-2.5 p-3.5 font-bold active:bg-raised"><Receipt size={19} className="text-brass" /> Caixa</Card></Link>
          <Link to="/relatorios"><Card className="flex items-center gap-2.5 p-3.5 font-bold active:bg-raised"><CalendarClock size={19} className="text-brass" /> Relatórios</Card></Link>
        </div>
      )}

      {openId && <AppointmentSheet id={openId} onClose={() => setOpenId(null)} />}
    </>
  )
}
