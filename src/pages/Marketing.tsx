import { Mail, Plus, Send } from 'lucide-react'
import { useMemo, useState } from 'react'
import { exec, nowISO, useDb } from '@/data/store'
import { audienceOf, sendCampaign, upsertCoupon } from '@/domain/marketing'
import { formatBps, formatBRL } from '@/domain/money'
import { addDays, brDate, dateKey, dayLabel, timeOf } from '@/domain/time'
import type { CampaignAudience, Coupon, ID, MessageKind } from '@/domain/types'
import {
  attempt, Badge, Button, Card, Chips, Empty, Field, Input, List, MoneyInput, PageHeader, PercentInput, Row, Section, Segmented, Select, Sheet, Textarea, Toggle,
} from '@/ui/kit'

const AUDIENCES: { value: CampaignAudience; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'inactive', label: 'Inativos' },
  { value: 'subscribers', label: 'Assinantes' },
  { value: 'birthday_month', label: 'Aniversariantes do mês' },
]

const KIND_LABEL: Record<MessageKind, string> = {
  booking_confirmation: 'Confirmação', reminder_24h: 'Lembrete 24h', reminder_2h: 'Lembrete 2h', cancellation: 'Cancelamento',
  waitlist_slot: 'Lista de espera', welcome: 'Boas-vindas', birthday: 'Aniversário', recovery: 'Recuperação', campaign: 'Campanha',
  charge_due: 'Mensalidade', charge_overdue: 'Atraso', low_stock: 'Estoque baixo',
}

function CouponForm({ coupon, onClose }: { coupon?: Coupon; onClose: () => void }) {
  const today = dateKey(nowISO())
  const [code, setCode] = useState(coupon?.code ?? '')
  const [type, setType] = useState<Coupon['type']>(coupon?.type ?? 'percent')
  const [percent, setPercent] = useState(coupon?.type === 'percent' ? coupon.value : 1000)
  const [fixed, setFixed] = useState(coupon?.type === 'fixed' ? coupon.value : 1000)
  const [minCents, setMinCents] = useState(coupon?.minCents ?? 0)
  const [maxUses, setMaxUses] = useState(coupon?.maxUses ? String(coupon.maxUses) : '')
  const [validTo, setValidTo] = useState(coupon?.validTo ?? addDays(today, 30))
  const [active, setActive] = useState(coupon?.active ?? true)
  const save = () => {
    const ok = attempt(
      () => exec(upsertCoupon, {
        id: coupon?.id, code, type, value: type === 'percent' ? percent : fixed, minCents, maxUses: maxUses ? Number(maxUses) : null,
        validFrom: coupon?.validFrom ?? today, validTo, active,
      }),
      'Cupom salvo',
    )
    if (ok) onClose()
  }
  return (
    <Sheet title={coupon ? 'Editar cupom' : 'Novo cupom'} onClose={onClose} footer={<Button variant="primary" block onClick={save}>Salvar</Button>}>
      <Field label="Código"><Input autoCapitalize="characters" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="VOLTEI15" /></Field>
      <Segmented value={type} onChange={setType} options={[{ value: 'percent', label: 'Porcentagem' }, { value: 'fixed', label: 'Valor fixo' }]} />
      {type === 'percent' ? <Field label="Desconto (%)"><PercentInput value={percent} onChange={setPercent} /></Field> : <Field label="Desconto"><MoneyInput value={fixed} onChange={setFixed} /></Field>}
      <Field label="Compra mínima"><MoneyInput value={minCents} onChange={setMinCents} /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Limite de usos"><Input inputMode="numeric" value={maxUses} onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, ''))} placeholder="Sem limite" /></Field>
        <Field label="Válido até"><Input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} /></Field>
      </div>
      {coupon && <Toggle checked={active} onChange={setActive} label="Ativo" />}
    </Sheet>
  )
}

function CampaignForm({ onClose }: { onClose: () => void }) {
  const db = useDb()
  const [name, setName] = useState('')
  const [audience, setAudience] = useState<CampaignAudience>('inactive')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [couponId, setCouponId] = useState<ID | ''>('')
  const reach = useMemo(() => audienceOf(db, audience, nowISO()).length, [db, audience])
  const send = () => {
    const ok = attempt(() => exec(sendCampaign, { name, audience, subject, body, couponId: couponId || null }), `Campanha na fila para ${reach} clientes`)
    if (ok) onClose()
  }
  return (
    <Sheet title="Nova campanha" onClose={onClose} footer={<Button variant="primary" block disabled={reach === 0} onClick={send}><Send size={18} /> Enviar para {reach} clientes</Button>}>
      <Field label="Nome interno"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Promoção de novembro" /></Field>
      <div>
        <span className="mb-1.5 block text-[13px] font-bold text-muted">Público</span>
        <Chips value={audience} onChange={setAudience} options={AUDIENCES} />
        <p className="mt-1 text-xs text-muted">
          Só entra quem aceitou receber promoções e tem e-mail.{reach > 200 && ' Com este público, o envio leva mais de um dia.'}
        </p>
      </div>
      <Field label="Assunto do e-mail"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
      <Field label="Mensagem" hint="Use {nome} para o primeiro nome do cliente."><Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      <Field label="Cupom">
        <Select value={couponId} onChange={(e) => setCouponId(e.target.value)}>
          <option value="">Sem cupom</option>
          {db.coupons.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
        </Select>
      </Field>
    </Sheet>
  )
}

export default function MarketingPage() {
  const db = useDb()
  const [tab, setTab] = useState<'coupons' | 'campaigns' | 'outbox'>('coupons')
  const [coupon, setCoupon] = useState<Coupon | 'new' | null>(null)
  const [campaign, setCampaign] = useState(false)
  const today = dateKey(nowISO())
  const outbox = useMemo(() => [...db.messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 60), [db.messages])
  const queued = db.messages.filter((m) => m.status === 'queued').length
  return (
    <>
      <PageHeader back title="Marketing" sub="Cupons, campanhas e mensagens" />
      <div className="px-4">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'coupons', label: 'Cupons' }, { value: 'campaigns', label: 'Campanhas' }, { value: 'outbox', label: 'Mensagens' }]} />
      </div>

      {tab === 'coupons' && (
        <Section title="Cupons" action={<Button variant="link" className="min-h-8 px-1 text-sm" onClick={() => setCoupon('new')}><Plus size={16} /> Novo</Button>}>
          {db.coupons.length === 0 ? <Empty title="Nenhum cupom" /> : (
            <List>
              {db.coupons.map((c) => {
                const expired = c.validTo < today
                return (
                  <Row
                    key={c.id}
                    title={c.code}
                    sub={`${c.type === 'percent' ? formatBps(c.value) : formatBRL(c.value)} · ${c.uses}${c.maxUses ? `/${c.maxUses}` : ''} usos · até ${brDate(c.validTo)}`}
                    right={!c.active ? <Badge>Inativo</Badge> : expired ? <Badge tone="bad">Vencido</Badge> : <Badge tone="ok">Ativo</Badge>}
                    onClick={() => setCoupon(c)}
                  />
                )
              })}
            </List>
          )}
        </Section>
      )}

      {tab === 'campaigns' && (
        <Section title="Campanhas" action={<Button variant="link" className="min-h-8 px-1 text-sm" onClick={() => setCampaign(true)}><Plus size={16} /> Nova</Button>}>
          {db.campaigns.length === 0 ? (
            <Empty title="Nenhuma campanha ainda" sub="Traga de volta quem sumiu com um cupom." action={<Button variant="primary" onClick={() => setCampaign(true)}>Criar campanha</Button>} />
          ) : (
            <List>
              {[...db.campaigns].reverse().map((c) => <Row key={c.id} title={c.name} sub={`${dayLabel(dateKey(c.sentAt))} · ${AUDIENCES.find((a) => a.value === c.audience)?.label}`} right={`${c.recipients} envios`} />)}
            </List>
          )}
        </Section>
      )}

      {tab === 'outbox' && (
        <>
          <div className="px-4 pt-3">
            <Card className="p-3.5 text-sm text-muted">
              <b className="text-ink">{queued} na fila.</b> Lembretes, aniversários, boas-vindas e recuperação são gerados sozinhos. O envio real começa quando o Gmail e o OneSignal forem conectados. Lembretes têm prioridade: campanhas grandes saem aos poucos, em vários dias.
            </Card>
          </div>
          <div className="px-4 pt-2">
            {outbox.length === 0 ? <Empty title="Nenhuma mensagem" /> : (
              <List>
                {outbox.map((m) => (
                  <Row
                    key={m.id}
                    left={<Mail size={18} className="text-muted" />}
                    title={m.subject}
                    sub={`${KIND_LABEL[m.kind]} · ${m.to} · ${dayLabel(dateKey(m.createdAt))} ${timeOf(m.createdAt)}`}
                    right={m.status === 'sent' ? <Badge tone="ok">Enviada</Badge> : m.status === 'failed' ? <Badge tone="bad">Falhou</Badge> : <Badge>Na fila</Badge>}
                  />
                ))}
              </List>
            )}
          </div>
        </>
      )}

      {coupon && <CouponForm coupon={coupon === 'new' ? undefined : coupon} onClose={() => setCoupon(null)} />}
      {campaign && <CampaignForm onClose={() => setCampaign(false)} />}
    </>
  )
}
