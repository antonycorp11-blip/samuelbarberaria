import { Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { exec, nowISO, useDb } from '@/data/store'
import { dueForReturn, inactiveClients, lastVisits, upsertClient } from '@/domain/clients'
import { brDate, dateKey, dayLabel } from '@/domain/time'
import type { Client } from '@/domain/types'
import { attempt, Avatar, Badge, Button, Empty, Field, IconButton, Input, List, PageHeader, Row, Segmented, Sheet, Textarea, Toggle } from '@/ui/kit'

export function ClientForm({ client, onClose }: { client?: Client; onClose: () => void }) {
  const [name, setName] = useState(client?.name ?? '')
  const [phone, setPhone] = useState(client?.phone ?? '')
  const [email, setEmail] = useState(client?.email ?? '')
  const [birthday, setBirthday] = useState(client?.birthday ? `${client.birthday.slice(3)}/${client.birthday.slice(0, 2)}` : '')
  const [notes, setNotes] = useState(client?.notes ?? '')
  const [optIn, setOptIn] = useState(client?.marketingOptIn ?? false)
  const save = () => {
    const m = birthday.match(/^(\d{2})\/(\d{2})$/)
    const value = m ? `${m[2]}-${m[1]}` : birthday ? 'invalido' : null
    const ok = attempt(
      () => exec(upsertClient, { id: client?.id, name, phone, email, birthday: value, notes, marketingOptIn: optIn }),
      'Cliente salvo',
    )
    if (ok) onClose()
  }
  return (
    <Sheet title={client ? 'Editar cliente' : 'Novo cliente'} onClose={onClose} footer={<Button variant="primary" block onClick={save}>Salvar</Button>}>
      <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Celular com DDD"><Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
      <Field label="E-mail" hint="Usado para confirmações e lembretes."><Input inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Aniversário (dia/mês)"><Input inputMode="numeric" placeholder="25/12" maxLength={5} value={birthday} onChange={(e) => setBirthday(e.target.value)} /></Field>
      <Field label="Observações"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Preferências do corte, alergias..." /></Field>
      <Toggle checked={optIn} onChange={setOptIn} label="Aceita receber promoções" hint="Exigido pela LGPD para campanhas." />
    </Sheet>
  )
}

export default function ClientsPage() {
  const db = useDb()
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<'all' | 'return' | 'inactive'>('all')
  const [adding, setAdding] = useState(false)
  const now = nowISO()
  const today = dateKey(now)
  const last = useMemo(() => lastVisits(db), [db])
  const inactive = useMemo(() => inactiveClients(db, now), [db]) // eslint-disable-line react-hooks/exhaustive-deps
  const returning = useMemo(() => dueForReturn(db, now), [db]) // eslint-disable-line react-hooks/exhaustive-deps
  const subs = useMemo(() => new Set(db.subscriptions.filter((s) => s.status === 'active').map((s) => s.clientId)), [db])
  const term = q.trim().toLowerCase()
  const digits = term.replace(/\D/g, '')
  const match = (c: Client) => !term || c.name.toLowerCase().includes(term) || (digits.length > 2 && c.phone.includes(digits))

  const rows =
    tab === 'all'
      ? [...db.clients].filter(match).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 80).map((c) => ({
          c, sub: last.get(c.id) ? `Última visita ${brDate(last.get(c.id) as string)}` : 'Sem visitas ainda',
        }))
      : tab === 'return'
        ? returning.filter((x) => match(x.client)).map((x) => ({
            c: x.client, sub: x.expected === today ? 'Deve voltar hoje' : `Era esperado em ${dayLabel(x.expected)}`,
          }))
        : inactive.filter((x) => match(x.client)).map((x) => ({ c: x.client, sub: `${x.daysAway} dias sem vir` }))

  return (
    <>
      <PageHeader
        title="Clientes"
        sub={`${db.clients.length} cadastrados`}
        action={<IconButton label="Novo cliente" className="bg-brass text-brass-ink" onClick={() => setAdding(true)}><Plus size={21} /></IconButton>}
      />
      <div className="space-y-2 px-4">
        <div className="relative">
          <Search size={18} className="absolute top-1/2 left-3.5 -translate-y-1/2 text-muted" />
          <Input className="pl-10" placeholder="Buscar por nome ou celular" aria-label="Buscar cliente" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: 'Todos' },
            { value: 'return', label: `Retorno (${returning.length})` },
            { value: 'inactive', label: `Inativos (${inactive.length})` },
          ]}
        />
      </div>
      <div className="px-4 pt-3">
        {rows.length === 0 ? (
          <Empty title="Ninguém por aqui" sub={term ? 'Tente outro nome ou celular.' : 'Esta lista está vazia.'} />
        ) : (
          <List>
            {rows.map(({ c, sub }) => (
              <Row
                key={c.id}
                to={`/clientes/${c.id}`}
                left={<Avatar name={c.name} />}
                title={c.name}
                sub={sub}
                right={subs.has(c.id) ? <Badge tone="brass">Clube</Badge> : c.rewards > 0 ? <Badge tone="ok">Prêmio</Badge> : undefined}
              />
            ))}
          </List>
        )}
      </div>
      {adding && <ClientForm onClose={() => setAdding(false)} />}
    </>
  )
}
