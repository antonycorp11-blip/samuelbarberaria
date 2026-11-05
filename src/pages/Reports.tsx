import { useMemo, useState } from 'react'
import { nowISO, useDb } from '@/data/store'
import { averageTicket, dre, METHOD_LABEL, paidSales, revenueSeries } from '@/domain/finance'
import { formatBps, formatBRL } from '@/domain/money'
import { barberRanking, commissionHistory, occupancy, returnRate, topServices } from '@/domain/reports'
import { addDays, dateKey, dayLabel, endOfMonth, startOfMonth } from '@/domain/time'
import { Avatar, Bars, Card, Chips, Empty, List, Meter, PageHeader, Row, Section, Stat } from '@/ui/kit'

type Range = '7' | '30' | 'month' | 'last' | '90'

function rangeOf(r: Range, today: string) {
  if (r === 'month') return { from: startOfMonth(today), to: today }
  if (r === 'last') {
    const end = addDays(startOfMonth(today), -1)
    return { from: startOfMonth(end), to: endOfMonth(end) }
  }
  return { from: addDays(today, -Number(r) + 1), to: today }
}

export default function ReportsPage() {
  const db = useDb()
  const today = dateKey(nowISO())
  const [range, setRange] = useState<Range>('30')
  const { from, to } = rangeOf(range, today)
  const data = useMemo(() => {
    const series = revenueSeries(db, from, to)
    return {
      result: dre(db, from, to),
      sales: paidSales(db, from, to).length,
      ticket: averageTicket(db, from, to),
      occ: occupancy(db, from, to),
      ret: returnRate(db, from, to, today),
      services: topServices(db, from, to),
      ranking: barberRanking(db, from, to),
      payouts: commissionHistory(db, from, to),
      bars: series.map((d) => ({ label: dayLabel(d.date), value: d.cents })),
    }
  }, [db, from, to, today])
  const topQty = data.services[0]?.qty ?? 1

  return (
    <>
      <PageHeader back title="Relatórios" sub={`${dayLabel(from)} a ${dayLabel(to)}`} />
      <div className="px-4">
        <Chips
          value={range}
          onChange={setRange}
          options={[
            { value: '7', label: '7 dias' }, { value: '30', label: '30 dias' }, { value: 'month', label: 'Este mês' },
            { value: 'last', label: 'Mês passado' }, { value: '90', label: '90 dias' },
          ]}
        />
      </div>

      <Section title="Faturamento">
        <Card className="p-4">
          <div className="tnum text-3xl font-extrabold tracking-tight">{formatBRL(data.result.grossRevenue)}</div>
          <div className="mt-0.5 mb-3 text-sm text-muted">{data.sales} atendimentos · inclui {formatBRL(data.result.subscriptionRevenue)} de assinaturas</div>
          <Bars data={data.bars} format={formatBRL} />
        </Card>
      </Section>

      <div className="grid grid-cols-2 gap-2 px-4 pt-2">
        <Stat label="Ticket médio" value={formatBRL(data.ticket)} />
        <Stat label="Ocupação da agenda" value={formatBps(data.occ)} />
        <Stat label="Taxa de retorno" value={formatBps(data.ret.rateBps)} hint={`${data.ret.returned} de ${data.ret.eligible} clientes`} />
        <Stat label="Lucro líquido" value={formatBRL(data.result.netProfit)} tone={data.result.netProfit >= 0 ? 'ok' : 'bad'} />
      </div>

      <Section title="Serviços mais vendidos">
        {data.services.length === 0 ? <Empty title="Sem vendas no período" /> : (
          <Card className="space-y-3 p-3.5">
            {data.services.map((s) => (
              <div key={s.name}>
                <div className="mb-1 flex justify-between gap-2 text-sm">
                  <span className="truncate font-semibold">{s.name}</span>
                  <span className="tnum shrink-0 text-muted">{s.qty} · {formatBRL(s.revenueCents)}</span>
                </div>
                <Meter bps={(s.qty / topQty) * 10000} />
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Ranking de barbeiros">
        <List>
          {data.ranking.map((r, i) => (
            <Row
              key={r.barberId}
              left={<Avatar name={r.name} size={36} />}
              title={`${i + 1}º ${r.name}`}
              sub={`${r.services} serviços · ticket ${formatBRL(r.ticketCents)}`}
              right={formatBRL(r.revenueCents)}
            />
          ))}
        </List>
      </Section>

      <Section title="Histórico de comissões">
        {data.payouts.length === 0 ? <Empty title="Nenhum pagamento no período" /> : (
          <List>
            {data.payouts.slice(0, 12).map((p) => (
              <Row key={p.id} title={db.barbers.find((b) => b.id === p.barberId)?.name} sub={`${dayLabel(dateKey(p.at))} · ${METHOD_LABEL[p.method]}`} right={formatBRL(p.amountCents)} />
            ))}
          </List>
        )}
      </Section>
    </>
  )
}
