import { audit, must, requireOwner, type Command } from './engine'
import { fail } from './errors'
import type { Cents, ID, Settings } from './types'

export const upsertService: Command<{ id?: ID; name: string; priceCents: Cents; durationMin: number; active?: boolean }, ID> = (d, i, ctx) => {
  requireOwner(ctx)
  if (!i.name.trim()) fail('bad_name', 'Informe o nome do serviço.')
  if (i.priceCents < 0) fail('bad_price', 'Preço inválido.')
  if (i.durationMin <= 0 || i.durationMin % 5 !== 0) fail('bad_duration', 'A duração deve ser múltipla de 5 minutos.')
  const current = i.id ? must(d.services.find((x) => x.id === i.id), 'Serviço') : null
  if (current) {
    Object.assign(current, { ...i, name: i.name.trim(), active: i.active ?? current.active })
    audit(d, ctx, 'servico.editar', current.id)
    return current.id
  }
  const id = ctx.id()
  d.services.push({ id, name: i.name.trim(), priceCents: i.priceCents, durationMin: i.durationMin, active: true })
  return id
}

export const updateSettings: Command<Partial<Settings>> = (d, i, ctx) => {
  requireOwner(ctx)
  const next = { ...d.settings, ...i }
  if (next.loyaltyStampsRequired < 1) fail('bad_value', 'O cartão fidelidade precisa de ao menos 1 selo.')
  if (next.slotMinutes < 5) fail('bad_value', 'O intervalo mínimo da agenda é 5 minutos.')
  if (next.subscriptionCommissionBps < 0 || next.subscriptionCommissionBps > 10000) fail('bad_value', 'Comissão inválida.')
  for (const h of next.hours) {
    if (h && h.close <= h.open) fail('bad_hours', 'O fechamento precisa ser depois da abertura.')
  }
  d.settings = next
  audit(d, ctx, 'config.editar', null)
}
