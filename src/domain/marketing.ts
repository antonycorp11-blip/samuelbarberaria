import { inactiveClients } from './clients'
import { audit, base, must, requireOwner, type Command } from './engine'
import { fail } from './errors'
import { enqueue } from './messages'
import { dateKey } from './time'
import type { Campaign, CampaignAudience, Client, Coupon, DbState, ID } from './types'

export const upsertCoupon: Command<Omit<Coupon, 'id' | 'uses'> & { id?: ID }, ID> = (d, i, ctx) => {
  requireOwner(ctx)
  const code = i.code.trim().toUpperCase()
  if (!/^[A-Z0-9_-]{3,20}$/.test(code)) fail('bad_code', 'Código deve ter de 3 a 20 letras ou números.')
  if (base(d).coupons.some((c) => c.code === code && c.id !== i.id)) fail('duplicate', 'Já existe cupom com este código.')
  if (i.value <= 0 || (i.type === 'percent' && i.value > 10000)) fail('bad_value', 'Valor do desconto inválido.')
  if (i.validTo < i.validFrom) fail('bad_range', 'A validade termina antes de começar.')
  if (i.id) {
    Object.assign(must(d.coupons.find((c) => c.id === i.id), 'Cupom'), { ...i, code })
    return i.id
  }
  const id = ctx.id()
  d.coupons.push({ ...i, id: id, code, uses: 0 })
  audit(d, ctx, 'cupom.criar', id, code)
  return id
}

/** Só entra quem aceitou receber marketing e tem e-mail (LGPD). */
export function audienceOf(s: DbState, audience: CampaignAudience, now: string): Client[] {
  const eligible = (c: Client) => c.marketingOptIn && Boolean(c.email)
  switch (audience) {
    case 'all':
      return s.clients.filter(eligible)
    case 'inactive':
      return inactiveClients(s, now).map((x) => x.client).filter(eligible)
    case 'subscribers': {
      const ids = new Set(s.subscriptions.filter((x) => x.status === 'active').map((x) => x.clientId))
      return s.clients.filter((c) => ids.has(c.id) && eligible(c))
    }
    case 'birthday_month': {
      const month = dateKey(now).slice(5, 7)
      return s.clients.filter((c) => c.birthday?.startsWith(month) && eligible(c))
    }
  }
}

export const sendCampaign: Command<
  { name: string; audience: CampaignAudience; subject: string; body: string; couponId?: ID | null },
  Campaign
> = (d, i, ctx) => {
  requireOwner(ctx)
  const s = base(d)
  if (!i.name.trim() || !i.subject.trim() || !i.body.trim()) fail('incomplete', 'Preencha nome, assunto e mensagem.')
  const coupon = i.couponId ? must(s.coupons.find((c) => c.id === i.couponId), 'Cupom') : null
  const clients = audienceOf(s, i.audience, ctx.now)
  if (clients.length === 0) fail('empty_audience', 'Nenhum cliente neste público.')
  const id = ctx.id()
  for (const c of clients) {
    enqueue(
      d,
      ctx,
      {
        to: c.email,
        clientId: c.id,
        kind: 'campaign',
        subject: i.subject.trim(),
        body: `${i.body.trim().replaceAll('{nome}', c.name.split(' ')[0] ?? '')}${coupon ? `\n\nUse o cupom ${coupon.code}.` : ''}`,
        dedupeKey: `campaign:${id}:${c.id}`,
      },
      new Set(),
    )
  }
  const campaign: Campaign = {
    id, name: i.name.trim(), audience: i.audience, subject: i.subject.trim(), body: i.body.trim(),
    couponId: coupon?.id ?? null, recipients: clients.length, sentAt: ctx.now,
  }
  d.campaigns.push(campaign)
  audit(d, ctx, 'campanha.enviar', id, `destinatarios=${clients.length}`)
  return campaign
}
