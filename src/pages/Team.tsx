import { Plus, Trophy } from 'lucide-react'
import { useMemo, useState } from 'react'
import { exec, nowISO, useActor, useDb } from '@/data/store'
import { METHOD_LABEL } from '@/domain/finance'
import { formatBps, formatBRL } from '@/domain/money'
import { barberRanking } from '@/domain/reports'
import { commissionBalance, payCommissions, upsertBarber } from '@/domain/team'
import { dateKey, dayLabel, startOfMonth, weekdayNames } from '@/domain/time'
import type { Barber, ID, PaymentMethod } from '@/domain/types'
import {
  attempt, Avatar, Badge, Button, Card, Chips, cx, Empty, Field, IconButton, Input, List, Meter, PageHeader, PercentInput, Row, Section, Sheet, Stat, Toggle,
} from '@/ui/kit'

const METHODS = (Object.keys(METHOD_LABEL) as PaymentMethod[]).map((value) => ({ value, label: METHOD_LABEL[value] }))

function BarberForm({ barber, onClose }: { barber?: Barber; onClose: () => void }) {
  const [name, setName] = useState(barber?.name ?? '')
  const [email, setEmail] = useState(barber?.email ?? '')
  const [phone, setPhone] = useState(barber?.phone ?? '')
  const [serviceBps, setServiceBps] = useState(barber?.serviceBps ?? 5000)
  const [productBps, setProductBps] = useState(barber?.productBps ?? 1000)
  const [daysOff, setDaysOff] = useState<number[]>(barber?.daysOff ?? [0])
  const [breakStart, setBreakStart] = useState(barber?.breakStart ?? '')
  const [breakEnd, setBreakEnd] = useState(barber?.breakEnd ?? '')
  const [active, setActive] = useState(barber?.active ?? true)
  const save = () => {
    const ok = attempt(
      () => exec(upsertBarber, {
        id: barber?.id, name, email, phone, serviceBps, productBps, daysOff, breakStart: breakStart || null, breakEnd: breakEnd || null, active,
      }),
      'Profissional salvo',
    )
    if (ok) onClose()
  }
  return (
    <Sheet title={barber ? 'Editar profissional' : 'Novo profissional'} onClose={onClose} footer={<Button variant="primary" block onClick={save}>Salvar</Button>}>
      <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="E-mail"><Input inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Celular"><Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Comissão serviços (%)"><PercentInput value={serviceBps} onChange={setServiceBps} /></Field>
        <Field label="Comissão produtos (%)"><PercentInput value={productBps} onChange={setProductBps} /></Field>
      </div>
      <div>
        <span className="mb-1.5 block text-[13px] font-bold text-muted">Folgas</span>
        <div className="grid grid-cols-7 gap-1">
          {weekdayNames.map((label, i) => (
            <button
              key={label}
              type="button"
              aria-pressed={daysOff.includes(i)}
              onClick={() => setDaysOff((d) => (d.includes(i) ? d.filter((x) => x !== i) : [...d, i]))}
              className={cx('min-h-11 rounded-lg text-xs font-bold uppercase', daysOff.includes(i) ? 'bg-brass text-brass-ink' : 'bg-raised')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Intervalo: início"><Input type="time" value={breakStart} onChange={(e) => setBreakStart(e.target.value)} /></Field>
        <Field label="Intervalo: fim"><Input type="time" value={breakEnd} onChange={(e) => setBreakEnd(e.target.value)} /></Field>
      </div>
      {barber && <Toggle checked={active} onChange={setActive} label="Ativo" hint="Inativos saem da agenda, o histórico fica." />}
    </Sheet>
  )
}

function BarberSheet({ id, onClose, onEdit }: { id: ID; onClose: () => void; onEdit: () => void }) {
  const db = useDb()
  const actor = useActor()
  const [method, setMethod] = useState<PaymentMethod>('pix')
  const barber = db.barbers.find((b) => b.id === id)
  const bal = commissionBalance(db, id)
  const owner = actor.role === 'owner'
  const pending = db.commissions.filter((c) => c.barberId === id && c.status === 'pending').sort((a, b) => b.at.localeCompare(a.at))
  const payouts = db.payouts.filter((p) => p.barberId === id).sort((a, b) => b.at.localeCompare(a.at))
  const byKind = (kind: string) => pending.filter((c) => c.kind === kind).reduce((t, c) => t + c.amountCents, 0)
  return (
    <Sheet
      title={barber?.name ?? ''}
      onClose={onClose}
      footer={
        owner && bal.pendingCents > 0 ? (
          <Button
            variant="primary"
            block
            onClick={() => {
              if (attempt(() => exec(payCommissions, { barberId: id, method }), 'Comissão paga')) onClose()
            }}
          >
            Pagar {formatBRL(bal.pendingCents)}
          </Button>
        ) : undefined
      }
    >
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Pendente" value={formatBRL(bal.pendingCents)} tone={bal.pendingCents < 0 ? 'bad' : 'warn'} />
        <Stat label="Já pago" value={formatBRL(bal.paidCents)} />
      </div>
      <div className="divide-y divide-line/70 overflow-hidden rounded-xl bg-raised">
        <Row title="Serviços" right={formatBRL(byKind('service'))} />
        <Row title="Produtos" right={formatBRL(byKind('product'))} />
        <Row title="Assinaturas" right={formatBRL(byKind('subscription'))} />
        {byKind('reversal') !== 0 && <Row title="Estornos" right={formatBRL(byKind('reversal'))} />}
      </div>
      {bal.pendingCents < 0 && <p className="text-sm text-muted">Saldo negativo por estorno de comissão já paga. Será abatido das próximas.</p>}
      {owner && bal.pendingCents > 0 && <Chips value={method} onChange={setMethod} options={METHODS} />}
      {payouts.length > 0 && (
        <div>
          <span className="mb-1.5 block text-[13px] font-bold text-muted">Pagamentos recentes</span>
          <div className="divide-y divide-line/70 overflow-hidden rounded-xl bg-raised">
            {payouts.slice(0, 6).map((p) => <Row key={p.id} title={dayLabel(dateKey(p.at))} sub={METHOD_LABEL[p.method]} right={formatBRL(p.amountCents)} />)}
          </div>
        </div>
      )}
      {owner && <Button block onClick={onEdit}>Editar cadastro</Button>}
    </Sheet>
  )
}

export default function TeamPage() {
  const db = useDb()
  const actor = useActor()
  const owner = actor.role === 'owner'
  const [form, setForm] = useState<Barber | 'new' | null>(null)
  const [openId, setOpenId] = useState<ID | null>(null)
  const today = dateKey(nowISO())
  const from = startOfMonth(today)
  const ranking = useMemo(() => barberRanking(db, from, today).filter((r) => db.barbers.find((b) => b.id === r.barberId)?.active), [db, from, today])
  const visible = owner ? ranking : ranking.filter((r) => r.barberId === actor.barberId)
  const top = ranking[0]?.revenueCents ?? 1

  return (
    <>
      <PageHeader
        back
        title="Equipe"
        sub="Produção do mês"
        action={owner ? <IconButton label="Novo profissional" className="bg-brass text-brass-ink" onClick={() => setForm('new')}><Plus size={21} /></IconButton> : undefined}
      />
      <div className="space-y-2 px-4">
        {visible.length === 0 && <Empty title="Nenhum profissional" sub="Cadastre a equipe para começar." />}
        {visible.map((r, i) => {
          const bal = commissionBalance(db, r.barberId)
          return (
            <button key={r.barberId} type="button" onClick={() => setOpenId(r.barberId)} className="block w-full text-left">
              <Card className="p-3.5 active:bg-raised">
                <div className="flex items-center gap-3">
                  <Avatar name={r.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 font-bold">
                      {owner && i === 0 && r.revenueCents > 0 && <Trophy size={15} className="text-brass" />}
                      <span className="truncate">{r.name}</span>
                    </div>
                    <div className="text-[13px] text-muted">{r.services} serviços · {r.clients} clientes · ocupação {formatBps(r.occupancyBps)}</div>
                  </div>
                  <div className="tnum text-right font-extrabold">{formatBRL(r.revenueCents)}</div>
                </div>
                <div className="mt-2.5"><Meter bps={(r.revenueCents / Math.max(1, top)) * 10000} /></div>
                <div className="mt-2 flex items-center justify-between text-[13px]">
                  <span className="text-muted">Ticket {formatBRL(r.ticketCents)}</span>
                  {bal.pendingCents !== 0 && <Badge tone={bal.pendingCents > 0 ? 'warn' : 'bad'}>A pagar {formatBRL(bal.pendingCents)}</Badge>}
                </div>
              </Card>
            </button>
          )
        })}
      </div>
      {owner && db.barbers.some((b) => !b.active) && (
        <Section title="Inativos">
          <List>{db.barbers.filter((b) => !b.active).map((b) => <Row key={b.id} title={b.name} onClick={() => setForm(b)} />)}</List>
        </Section>
      )}
      {openId && (
        <BarberSheet
          id={openId}
          onClose={() => setOpenId(null)}
          onEdit={() => {
            setForm(db.barbers.find((b) => b.id === openId) ?? null)
            setOpenId(null)
          }}
        />
      )}
      {form && <BarberForm barber={form === 'new' ? undefined : form} onClose={() => setForm(null)} />}
    </>
  )
}
