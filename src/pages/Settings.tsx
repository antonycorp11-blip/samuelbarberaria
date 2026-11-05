import { Download, Plus, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { exec, getState, replaceState, resetTo, setActor, useActor, useDb } from '@/data/store'
import { updateSettings, upsertService } from '@/domain/catalog'
import { formatBRL } from '@/domain/money'
import { weekdayNames } from '@/domain/time'
import type { DbState, PaymentMethod, Service } from '@/domain/types'
import { METHOD_LABEL } from '@/domain/finance'
import {
  attempt, Badge, Button, Card, Chips, ConfirmSheet, Field, Input, List, MoneyInput, PageHeader, PercentInput, Row, Section, Sheet, toast, Toggle,
} from '@/ui/kit'

function ServiceForm({ service, onClose }: { service?: Service; onClose: () => void }) {
  const [name, setName] = useState(service?.name ?? '')
  const [price, setPrice] = useState(service?.priceCents ?? 0)
  const [duration, setDuration] = useState(String(service?.durationMin ?? 30))
  const [active, setActive] = useState(service?.active ?? true)
  const save = () => {
    const ok = attempt(() => exec(upsertService, { id: service?.id, name, priceCents: price, durationMin: Number(duration), active }), 'Serviço salvo')
    if (ok) onClose()
  }
  return (
    <Sheet title={service ? 'Editar serviço' : 'Novo serviço'} onClose={onClose} footer={<Button variant="primary" block onClick={save}>Salvar</Button>}>
      <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Preço"><MoneyInput value={price} onChange={setPrice} /></Field>
      <Field label="Duração (minutos)"><Input inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} /></Field>
      {service && <Toggle checked={active} onChange={setActive} label="Ativo" />}
    </Sheet>
  )
}

function RulesForm({ onClose }: { onClose: () => void }) {
  const { settings: s } = useDb()
  const [form, setForm] = useState(s)
  const set = <K extends keyof typeof s>(k: K, v: (typeof s)[K]) => setForm((f) => ({ ...f, [k]: v }))
  const num = (k: 'inactiveDays' | 'loyaltyStampsRequired' | 'minAdvanceMinutes' | 'bookingWindowDays' | 'subscriptionGraceDays', label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input inputMode="numeric" value={String(form[k])} onChange={(e) => set(k, Number(e.target.value.replace(/\D/g, '')))} />
    </Field>
  )
  const save = () => {
    if (attempt(() => exec(updateSettings, form), 'Ajustes salvos')) onClose()
  }
  return (
    <Sheet title="Regras da barbearia" onClose={onClose} footer={<Button variant="primary" block onClick={save}>Salvar</Button>}>
      <Field label="Nome"><Input value={form.shopName} onChange={(e) => set('shopName', e.target.value)} /></Field>
      <Field label="Telefone"><Input value={form.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
      <Field label="Endereço"><Input value={form.address} onChange={(e) => set('address', e.target.value)} /></Field>
      <div>
        <span className="mb-1.5 block text-[13px] font-bold text-muted">Horário de funcionamento</span>
        <div className="space-y-1.5">
          {form.hours.map((h, i) => (
            <div key={i} className="grid grid-cols-[44px_1fr_1fr_auto] items-center gap-1.5">
              <span className="text-sm font-bold uppercase">{weekdayNames[i]}</span>
              {h ? (
                <>
                  <Input type="time" aria-label={`Abre ${weekdayNames[i]}`} value={h.open} onChange={(e) => set('hours', form.hours.map((x, k) => (k === i && x ? { ...x, open: e.target.value } : x)))} />
                  <Input type="time" aria-label={`Fecha ${weekdayNames[i]}`} value={h.close} onChange={(e) => set('hours', form.hours.map((x, k) => (k === i && x ? { ...x, close: e.target.value } : x)))} />
                </>
              ) : <span className="col-span-2 text-sm text-muted">Fechado</span>}
              <Button className="min-h-10 px-2.5 text-xs" onClick={() => set('hours', form.hours.map((x, k) => (k === i ? (x ? null : { open: '09:00', close: '18:00' }) : x)))}>
                {h ? 'Fechar' : 'Abrir'}
              </Button>
            </div>
          ))}
        </div>
      </div>
      <div>
        <span className="mb-1.5 block text-[13px] font-bold text-muted">Taxas de pagamento (%)</span>
        <div className="grid grid-cols-2 gap-2">
          {(['debit', 'credit', 'pix', 'cash'] as PaymentMethod[]).map((m) => (
            <Field key={m} label={METHOD_LABEL[m]}>
              <PercentInput value={form.feeBps[m]} onChange={(v) => set('feeBps', { ...form.feeBps, [m]: v })} />
            </Field>
          ))}
        </div>
      </div>
      {num('loyaltyStampsRequired', 'Selos para a recompensa')}
      {num('inactiveDays', 'Cliente inativo depois de (dias)')}
      {num('minAdvanceMinutes', 'Antecedência mínima online (minutos)')}
      {num('bookingWindowDays', 'Agendamento online até (dias à frente)')}
      {num('subscriptionGraceDays', 'Tolerância de atraso do clube (dias)')}
      <Field label="Comissão sobre assinaturas (%)" hint="Parte da mensalidade dividida entre quem atendeu no ciclo.">
        <PercentInput value={form.subscriptionCommissionBps} onChange={(v) => set('subscriptionCommissionBps', v)} />
      </Field>
    </Sheet>
  )
}

export default function SettingsPage() {
  const db = useDb()
  const actor = useActor()
  const owner = actor.role === 'owner'
  const [service, setService] = useState<Service | 'new' | null>(null)
  const [rules, setRules] = useState(false)
  const [reset, setReset] = useState<'demo' | 'empty' | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const profile = actor.barberId ?? 'owner'

  const backup = () => {
    const blob = new Blob([JSON.stringify(getState())], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `backup-barbearia-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const restore = async (f: File) => {
    try {
      replaceState(JSON.parse(await f.text()) as DbState)
      toast.ok('Backup restaurado')
    } catch {
      toast.bad('Arquivo de backup inválido.')
    }
  }

  return (
    <>
      <PageHeader back title="Ajustes" sub={db.settings.shopName} />

      <Section title="Entrar como" className="pt-0">
        <Chips
          value={profile}
          onChange={(id) => {
            const b = db.barbers.find((x) => x.id === id)
            setActor(b ? { role: 'barber', barberId: b.id, name: b.name } : { role: 'owner', barberId: null, name: 'Dono' })
          }}
          options={[{ value: 'owner', label: 'Dono' }, ...db.barbers.filter((b) => b.active).map((b) => ({ value: b.id, label: b.name }))]}
        />
        <p className="mt-1.5 text-xs text-muted">Simulação de perfis. O login real entra com o Supabase.</p>
      </Section>

      {owner && (
        <>
          <Section title="Serviços" action={<Button variant="link" className="min-h-8 px-1 text-sm" onClick={() => setService('new')}><Plus size={16} /> Novo</Button>}>
            <List>
              {db.services.map((s) => (
                <Row key={s.id} title={s.name} sub={`${s.durationMin} min`} right={s.active ? formatBRL(s.priceCents) : <Badge>Inativo</Badge>} onClick={() => setService(s)} />
              ))}
            </List>
          </Section>

          <Section title="Barbearia">
            <Button block onClick={() => setRules(true)}>Horários, taxas e regras</Button>
          </Section>

          <Section title="Dados deste aparelho">
            <Card className="space-y-2 p-3.5">
              <p className="text-sm text-muted">Sem o Supabase conectado, tudo fica salvo só neste aparelho.</p>
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={backup}><Download size={17} /> Backup</Button>
                <Button onClick={() => file.current?.click()}><Upload size={17} /> Restaurar</Button>
              </div>
              <input
                ref={file}
                type="file"
                accept="application/json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void restore(f)
                  e.target.value = ''
                }}
              />
              <Button block onClick={() => setReset('demo')}>Recarregar dados de exemplo</Button>
              <Button block variant="danger" onClick={() => setReset('empty')}>Apagar tudo e começar do zero</Button>
            </Card>
          </Section>
        </>
      )}

      {service && <ServiceForm service={service === 'new' ? undefined : service} onClose={() => setService(null)} />}
      {rules && <RulesForm onClose={() => setRules(false)} />}
      {reset && (
        <ConfirmSheet
          title={reset === 'demo' ? 'Recarregar exemplo?' : 'Apagar tudo?'}
          text="Tudo o que está neste aparelho será substituído. Faça um backup antes se quiser guardar."
          confirm={reset === 'demo' ? 'Recarregar' : 'Apagar tudo'}
          danger
          onClose={() => setReset(null)}
          onConfirm={() => {
            resetTo(reset)
            setActor({ role: 'owner', barberId: null, name: 'Dono' })
            setReset(null)
            toast.ok('Pronto')
          }}
        />
      )}
    </>
  )
}
