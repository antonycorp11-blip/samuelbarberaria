import { Plus } from 'lucide-react'
import { useState } from 'react'
import { exec, useDb } from '@/data/store'
import { METHOD_LABEL } from '@/domain/finance'
import { formatBps, formatBRL } from '@/domain/money'
import { cancelSubscription, payCharge, subscribe, subscriptionMetrics, upsertPlan } from '@/domain/subscriptions'
import { brDate } from '@/domain/time'
import type { ID, PaymentMethod, Plan } from '@/domain/types'
import {
  attempt, Avatar, Badge, Button, Card, Chips, ConfirmSheet, Empty, Field, IconButton, Input, List, MoneyInput, PageHeader, PercentInput, Row, Section, Segmented, Sheet, Stat, Textarea, Toggle,
} from '@/ui/kit'
import { ClientPicker } from '@/ui/operations'

const METHODS = (Object.keys(METHOD_LABEL) as PaymentMethod[]).map((value) => ({ value, label: METHOD_LABEL[value] }))

function PlanForm({ plan, onClose }: { plan?: Plan; onClose: () => void }) {
  const db = useDb()
  const [name, setName] = useState(plan?.name ?? '')
  const [price, setPrice] = useState(plan?.priceCents ?? 0)
  const [unlimited, setUnlimited] = useState(plan ? plan.visitsPerCycle === null : false)
  const [visits, setVisits] = useState(String(plan?.visitsPerCycle ?? 4))
  const [serviceIds, setServiceIds] = useState<ID[]>(plan?.serviceIds ?? [])
  const [discount, setDiscount] = useState(plan?.productDiscountBps ?? 1000)
  const [benefits, setBenefits] = useState(plan?.benefits.join('\n') ?? '')
  const [active, setActive] = useState(plan?.active ?? true)
  const save = () => {
    const ok = attempt(
      () => exec(upsertPlan, {
        id: plan?.id, name, priceCents: price, visitsPerCycle: unlimited ? null : Number(visits), serviceIds, productDiscountBps: discount,
        benefits: benefits.split('\n').map((b) => b.trim()).filter(Boolean), active,
      }),
      'Plano salvo',
    )
    if (ok) onClose()
  }
  return (
    <Sheet title={plan ? 'Editar plano' : 'Novo plano'} onClose={onClose} footer={<Button variant="primary" block onClick={save}>Salvar</Button>}>
      <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Mensalidade"><MoneyInput value={price} onChange={setPrice} /></Field>
      <div>
        <span className="mb-1.5 block text-[13px] font-bold text-muted">Serviços inclusos</span>
        <Chips
          multi
          value={serviceIds}
          onChange={(id) => setServiceIds((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]))}
          options={db.services.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))}
        />
      </div>
      <Toggle checked={unlimited} onChange={setUnlimited} label="Visitas ilimitadas" />
      {!unlimited && <Field label="Visitas por mês"><Input inputMode="numeric" value={visits} onChange={(e) => setVisits(e.target.value)} /></Field>}
      <Field label="Desconto em produtos (%)"><PercentInput value={discount} onChange={setDiscount} /></Field>
      <Field label="Benefícios" hint="Um por linha."><Textarea value={benefits} onChange={(e) => setBenefits(e.target.value)} /></Field>
      {plan && <Toggle checked={active} onChange={setActive} label="Disponível para novas assinaturas" />}
    </Sheet>
  )
}

function SubscribeSheet({ onClose }: { onClose: () => void }) {
  const db = useDb()
  const plans = db.plans.filter((p) => p.active)
  const [clientId, setClientId] = useState<ID | null>(null)
  const [planId, setPlanId] = useState<ID | null>(plans[0]?.id ?? null)
  const [method, setMethod] = useState<PaymentMethod | 'later'>('pix')
  const save = () => {
    const ok = attempt(
      () => exec(subscribe, { clientId: clientId as ID, planId: planId as ID, payWith: method === 'later' ? null : method }),
      'Assinatura criada',
    )
    if (ok) onClose()
  }
  return (
    <Sheet title="Nova assinatura" onClose={onClose} footer={<Button variant="primary" block disabled={!clientId || !planId} onClick={save}>Assinar</Button>}>
      <Field label="Cliente"><ClientPicker value={clientId} onChange={setClientId} /></Field>
      <div>
        <span className="mb-1.5 block text-[13px] font-bold text-muted">Plano</span>
        <Chips value={planId} onChange={setPlanId} options={plans.map((p) => ({ value: p.id, label: p.name, sub: formatBRL(p.priceCents) }))} />
      </div>
      <div>
        <span className="mb-1.5 block text-[13px] font-bold text-muted">Primeira mensalidade</span>
        <Chips value={method} onChange={setMethod} options={[...METHODS, { value: 'later' as const, label: 'Cobrar depois' }]} />
      </div>
    </Sheet>
  )
}

function ChargeSheet({ chargeId, onClose }: { chargeId: ID; onClose: () => void }) {
  const db = useDb()
  const [method, setMethod] = useState<PaymentMethod>('pix')
  const charge = db.charges.find((c) => c.id === chargeId)
  if (!charge) return null
  return (
    <Sheet
      title="Receber mensalidade"
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          block
          onClick={() => {
            if (attempt(() => exec(payCharge, { chargeId, method }), 'Mensalidade recebida')) onClose()
          }}
        >
          Receber {formatBRL(charge.amountCents)}
        </Button>
      }
    >
      <p className="text-sm text-muted">Vencimento {brDate(charge.dueDate)}</p>
      <Chips value={method} onChange={setMethod} options={METHODS} />
    </Sheet>
  )
}

export default function ClubPage() {
  const db = useDb()
  const [tab, setTab] = useState<'members' | 'charges' | 'plans'>('members')
  const [plan, setPlan] = useState<Plan | 'new' | null>(null)
  const [adding, setAdding] = useState(false)
  const [chargeId, setChargeId] = useState<ID | null>(null)
  const [cancelId, setCancelId] = useState<ID | null>(null)
  const m = subscriptionMetrics(db)
  const members = db.subscriptions.filter((s) => s.status !== 'cancelled')
  const open = db.charges.filter((c) => c.status === 'pending').sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const nameOf = (subscriptionId: ID) => {
    const s = db.subscriptions.find((x) => x.id === subscriptionId)
    return db.clients.find((c) => c.id === s?.clientId)?.name ?? ''
  }
  return (
    <>
      <PageHeader
        back
        title="Clube"
        sub="Assinaturas mensais"
        action={<IconButton label="Nova assinatura" className="bg-brass text-brass-ink" onClick={() => setAdding(true)}><Plus size={21} /></IconButton>}
      />
      <div className="grid grid-cols-2 gap-2 px-4">
        <Stat label="Receita recorrente" value={formatBRL(m.mrrCents)} hint="Por mês" tone="ok" />
        <Stat label="Assinantes ativos" value={String(m.activeCount)} hint={m.pastDueCount ? `${m.pastDueCount} em atraso` : 'Nenhum em atraso'} />
      </div>
      <div className="px-4 pt-3">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[{ value: 'members', label: 'Assinantes' }, { value: 'charges', label: `Cobranças (${open.length})` }, { value: 'plans', label: 'Planos' }]}
        />
      </div>

      {tab === 'members' && (
        <div className="px-4 pt-3">
          {members.length === 0 ? <Empty title="Nenhum assinante ainda" /> : (
            <List>
              {members.map((s) => {
                const client = db.clients.find((c) => c.id === s.clientId)
                const p = db.plans.find((x) => x.id === s.planId)
                return (
                  <Row
                    key={s.id}
                    left={<Avatar name={client?.name ?? '?'} />}
                    title={client?.name}
                    sub={`${p?.name} · ${p?.visitsPerCycle === null ? `${s.usedVisits} visitas` : `${s.usedVisits}/${p?.visitsPerCycle}`} · ${s.autoRenew ? 'renova' : 'termina'} ${brDate(s.periodEnd).slice(0, 5)}`}
                    right={s.status === 'past_due' ? <Badge tone="bad">Em atraso</Badge> : s.autoRenew ? <Badge tone="ok">Ativa</Badge> : <Badge tone="warn">Encerrando</Badge>}
                    onClick={() => setCancelId(s.id)}
                  />
                )
              })}
            </List>
          )}
        </div>
      )}

      {tab === 'charges' && (
        <div className="px-4 pt-3">
          {open.length === 0 ? <Empty title="Nenhuma cobrança em aberto" /> : (
            <List>
              {open.map((c) => <Row key={c.id} title={nameOf(c.subscriptionId)} sub={`Vence ${brDate(c.dueDate)}`} right={formatBRL(c.amountCents)} onClick={() => setChargeId(c.id)} />)}
            </List>
          )}
          <Card className="mt-2 p-3.5 text-sm text-muted">
            A renovação e a cobrança são geradas sozinhas. O recebimento ainda é confirmado aqui, até ligarmos um gateway de pagamento.
          </Card>
        </div>
      )}

      {tab === 'plans' && (
        <Section title="Planos" action={<Button variant="link" className="min-h-8 px-1 text-sm" onClick={() => setPlan('new')}>Novo plano</Button>}>
          {db.plans.length === 0 ? <Empty title="Crie o primeiro plano" /> : (
            <div className="space-y-2">
              {db.plans.map((p) => (
                <button key={p.id} type="button" className="block w-full text-left" onClick={() => setPlan(p)}>
                  <Card className="p-3.5 active:bg-raised">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-bold">{p.name}{!p.active && ' (inativo)'}</span>
                      <span className="tnum font-extrabold text-brass">{formatBRL(p.priceCents)}</span>
                    </div>
                    <div className="mt-1 text-[13px] text-muted">
                      {p.visitsPerCycle === null ? 'Ilimitado' : `${p.visitsPerCycle} visitas/mês`} · {formatBps(p.productDiscountBps)} em produtos
                    </div>
                    {p.benefits.length > 0 && <div className="mt-1 text-[13px] text-muted">{p.benefits.join(' · ')}</div>}
                  </Card>
                </button>
              ))}
            </div>
          )}
        </Section>
      )}

      {plan && <PlanForm plan={plan === 'new' ? undefined : plan} onClose={() => setPlan(null)} />}
      {adding && <SubscribeSheet onClose={() => setAdding(false)} />}
      {chargeId && <ChargeSheet chargeId={chargeId} onClose={() => setChargeId(null)} />}
      {cancelId && (
        <ConfirmSheet
          title="Cancelar assinatura?"
          text="O cliente mantém os benefícios até o fim do período pago e não é cobrado de novo."
          confirm="Cancelar assinatura"
          danger
          onClose={() => setCancelId(null)}
          onConfirm={() => {
            if (attempt(() => exec(cancelSubscription, { id: cancelId }), 'Assinatura cancelada')) setCancelId(null)
          }}
        />
      )}
    </>
  )
}
