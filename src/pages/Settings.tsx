import { Download, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, exec, getState, logout, useActor, useDb } from '@/data/store'
import { updateSettings, upsertService } from '@/domain/catalog'
import { formatBRL } from '@/domain/money'
import { weekdayNames } from '@/domain/time'
import type { PaymentMethod, Service } from '@/domain/types'
import { METHOD_LABEL } from '@/domain/finance'
import { SHOP_PIX_KEY } from '@/domain/pix'
import {
  attempt, Badge, Button, Card, Field, Input, List, MoneyInput, PageHeader, PercentInput, Row, Section, Sheet, toast, Toggle,
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
      <Field label="Chave Pix" hint="Vai no QR Code do caixa e nas cobranças pelo WhatsApp. Deixe vazio para não mostrar.">
        <Input autoCapitalize="none" autoComplete="off" value={form.pixKey ?? SHOP_PIX_KEY} onChange={(e) => set('pixKey', e.target.value.trim())} />
      </Field>
      <Field label="Cidade no Pix" hint="O cliente vê o nome da barbearia e esta cidade ao pagar.">
        <Input value={form.pixCity ?? ''} onChange={(e) => set('pixCity', e.target.value)} />
      </Field>
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

function PasswordSheet({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ current, next }) })
      toast.ok('Senha alterada')
      onClose()
    } catch (e) {
      toast.bad(e instanceof Error ? e.message : 'Não foi possível alterar.')
      setBusy(false)
    }
  }
  return (
    <Sheet title="Trocar senha" onClose={onClose} footer={<Button variant="primary" block disabled={busy || next.length < 8} onClick={() => void save()}>Salvar nova senha</Button>}>
      <Field label="Senha atual"><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
      <Field label="Nova senha" hint="Ao menos 8 caracteres."><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
    </Sheet>
  )
}

export default function SettingsPage() {
  const db = useDb()
  const actor = useActor()
  const owner = actor.role === 'owner'
  const [service, setService] = useState<Service | 'new' | null>(null)
  const [rules, setRules] = useState(false)
  const [password, setPassword] = useState(false)

  const backup = () => {
    const blob = new Blob([JSON.stringify(getState())], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `backup-barbearia-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <>
      <PageHeader back title="Ajustes" sub={db.settings.shopName} />

      {password && <PasswordSheet onClose={() => setPassword(false)} />}
      <Section title="Conta" className="pt-0">
        <Card className="flex items-center justify-between gap-3 p-3.5">
          <div className="min-w-0">
            <div className="truncate font-bold">{actor.name}</div>
            <div className="text-sm text-muted">{owner ? 'Dono' : 'Barbeiro'} · versão {__APP_VERSION__}</div>
          </div>
          <div className="flex gap-2">
            <Button className="min-h-10" onClick={() => setPassword(true)}>Senha</Button>
            <Button variant="danger" className="min-h-10" onClick={() => void logout()}>Sair</Button>
          </div>
        </Card>
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

          <Section title="Notificações">
            <Link to="/notificacoes"><Button block>Testar e-mail e push</Button></Link>
          </Section>

          <Section title="Dados">
            <Button block onClick={backup}><Download size={17} /> Baixar uma cópia dos dados</Button>
          </Section>
        </>
      )}

      {service && <ServiceForm service={service === 'new' ? undefined : service} onClose={() => setService(null)} />}
      {rules && <RulesForm onClose={() => setRules(false)} />}
    </>
  )
}
