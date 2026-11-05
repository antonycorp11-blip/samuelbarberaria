import { CalendarPlus, Pencil } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { nowISO, useDb } from '@/data/store'
import { clientStats } from '@/domain/clients'
import { formatBRL } from '@/domain/money'
import { brDate, dateKey, timeOf } from '@/domain/time'
import { Avatar, Badge, Button, Card, cx, Empty, IconButton, List, Row, Section, Stat } from '@/ui/kit'
import { BookingSheet } from '@/ui/operations'
import { ClientForm } from './Clients'

export default function ClientDetailPage() {
  const { id } = useParams()
  const db = useDb()
  const [editing, setEditing] = useState(false)
  const [booking, setBooking] = useState(false)
  const client = db.clients.find((c) => c.id === id)
  if (!client) return <div className="p-4"><Empty title="Cliente não encontrado" action={<Link to="/clientes" className="font-bold text-brass">Voltar</Link>} /></div>

  const stats = clientStats(db, client.id, nowISO())
  const sub = db.subscriptions.find((s) => s.clientId === client.id && s.status !== 'cancelled')
  const plan = sub && db.plans.find((p) => p.id === sub.planId)
  const required = db.settings.loyaltyStampsRequired

  return (
    <>
      <header className="pt-safe px-4">
        <Link to="/clientes" className="text-sm font-semibold text-muted">‹ Clientes</Link>
        <div className="mt-2 flex items-center gap-3">
          <Avatar name={client.name} size={56} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-2xl font-semibold">{client.name}</h1>
            <p className="tnum truncate text-sm text-muted">{client.phone}{client.email ? ` · ${client.email}` : ''}</p>
          </div>
          <IconButton label="Editar cliente" onClick={() => setEditing(true)}><Pencil size={18} /></IconButton>
        </div>
        {client.notes && <p className="mt-3 rounded-xl bg-warn/10 p-3 text-sm text-warn">{client.notes}</p>}
        <Button variant="primary" block className="mt-3" onClick={() => setBooking(true)}><CalendarPlus size={19} /> Agendar</Button>
      </header>

      <div className="grid grid-cols-2 gap-2 px-4 pt-4">
        <Stat label="Visitas" value={String(stats.visits)} hint={stats.noShows ? `${stats.noShows} falta(s)` : undefined} />
        <Stat label="Total gasto" value={formatBRL(stats.spentCents)} />
        <Stat label="Frequência" value={stats.avgIntervalDays ? `${stats.avgIntervalDays} dias` : '—'} hint="Intervalo médio" />
        <Stat
          label="Próximo retorno"
          value={stats.nextAppointment ? `${brDate(dateKey(stats.nextAppointment.start)).slice(0, 5)}` : stats.expectedReturn ? brDate(stats.expectedReturn).slice(0, 5) : '—'}
          hint={stats.nextAppointment ? `Marcado às ${timeOf(stats.nextAppointment.start)}` : stats.expectedReturn ? 'Previsão' : undefined}
        />
      </div>

      <Section title="Cartão fidelidade">
        <Card className="p-3.5">
          <div className="flex flex-wrap gap-1.5" role="img" aria-label={`${client.stamps} de ${required} selos`}>
            {Array.from({ length: required }, (_, i) => (
              <div key={i} className={cx('grid size-8 place-items-center rounded-full text-xs font-extrabold', i < client.stamps ? 'bg-brass text-brass-ink' : 'bg-raised text-muted')}>
                {i + 1}
              </div>
            ))}
          </div>
          <p className="mt-2 text-sm text-muted">
            {client.rewards > 0 ? `${client.rewards} recompensa(s) disponível(is) para resgate.` : `Faltam ${required - client.stamps} para a recompensa.`}
          </p>
        </Card>
      </Section>

      {sub && plan && (
        <Section title="Assinatura">
          <Card className="flex items-center justify-between p-3.5">
            <div>
              <div className="font-bold">{plan.name}</div>
              <div className="text-sm text-muted">
                {plan.visitsPerCycle === null ? `${sub.usedVisits} visitas no ciclo` : `${sub.usedVisits} de ${plan.visitsPerCycle} visitas`} · até {brDate(sub.periodEnd)}
              </div>
            </div>
            <Badge tone={sub.status === 'active' ? 'ok' : 'bad'}>{sub.status === 'active' ? 'Ativa' : 'Em atraso'}</Badge>
          </Card>
        </Section>
      )}

      <Section title="Histórico">
        {stats.history.length === 0 ? (
          <Empty title="Sem atendimentos ainda" />
        ) : (
          <List>
            {stats.history.slice(0, 20).map((s) => (
              <Row
                key={s.id}
                title={s.items.map((i) => i.name).join(' + ')}
                sub={`${brDate(dateKey(s.at))} · ${db.barbers.find((b) => b.id === s.barberId)?.name}`}
                right={s.subscriptionId ? <Badge tone="brass">Clube</Badge> : formatBRL(s.totalCents)}
              />
            ))}
          </List>
        )}
      </Section>

      {editing && <ClientForm client={client} onClose={() => setEditing(false)} />}
      {booking && <BookingSheet initial={{ clientId: client.id }} onClose={() => setBooking(false)} />}
    </>
  )
}
