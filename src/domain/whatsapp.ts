import { formatBRL } from './money'
import { brDate, dateKey, timeOf, weekdayLabel } from './time'
import type { Appointment, Client, DbState } from './types'
import { pixKeyOf } from './pix'

/**
 * Mensagens de WhatsApp enviadas pela própria barbearia, em um toque: o app só abre a
 * conversa com o texto pronto. Nada é enviado sem a pessoa apertar enviar no WhatsApp.
 */

/** Número no formato do WhatsApp: 55 + DDD + número. */
export function waNumber(phone: string): string | null {
  const digits = phone.replace(/\D/g, '').replace(/^0+/, '')
  const local = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits
  return local.length === 10 || local.length === 11 ? `55${local}` : null
}

export function waLink(phone: string | null, text: string): string {
  const number = phone ? waNumber(phone) : null
  return `https://wa.me/${number ?? ''}?text=${encodeURIComponent(text)}`
}

const first = (c: Client) => c.name.split(' ')[0] ?? c.name

function appointmentLine(s: DbState, a: Appointment) {
  const services = a.serviceIds.map((id) => s.services.find((x) => x.id === id)?.name).filter(Boolean).join(' + ')
  const barber = s.barbers.find((b) => b.id === a.barberId)?.name
  return `${weekdayLabel(dateKey(a.start))}, ${brDate(dateKey(a.start)).slice(0, 5)} às ${timeOf(a.start)}${barber ? ` com ${barber}` : ''} (${services})`
}

export const waTemplates = {
  confirm: (s: DbState, c: Client, a: Appointment) =>
    `Fala, ${first(c)}! Aqui é da ${s.settings.shopName} ✂️\nPassando para confirmar seu horário: ${appointmentLine(s, a)}.\nPosso confirmar?`,
  reminder: (s: DbState, c: Client, a: Appointment) =>
    `Oi, ${first(c)}! Lembrete do seu horário na ${s.settings.shopName}: ${appointmentLine(s, a)}. Te esperamos! 💈`,
  birthday: (s: DbState, c: Client) =>
    `Feliz aniversário, ${first(c)}! 🎉 A ${s.settings.shopName} deseja um ano incrível. Que tal comemorar com o visual em dia? ${bookingUrl(s)}`,
  comeBack: (s: DbState, c: Client, daysAway?: number) =>
    `Fala, ${first(c)}! Sentimos sua falta aqui na ${s.settings.shopName}${daysAway ? ` (já são ${daysAway} dias!)` : ''}. Bora dar aquele tapa no visual? Agende em 1 minuto: ${bookingUrl(s)}`,
  charge: (s: DbState, c: Client, amountCents: number) =>
    pixKeyOf(s.settings)
      ? `Oi, ${first(c)}! Sua mensalidade do clube da ${s.settings.shopName} (${formatBRL(amountCents)}) está em aberto. Para regularizar, é só fazer um Pix para a chave:\n${pixKeyOf(s.settings)}`
      : `Oi, ${first(c)}! Sua mensalidade do clube da ${s.settings.shopName} (${formatBRL(amountCents)}) está em aberto. Quer que eu te mande o Pix para regularizar?`,
  thanks: (s: DbState, c: Client) =>
    `Valeu pela visita, ${first(c)}! 🙌 Foi um prazer te atender na ${s.settings.shopName}. Quando quiser voltar: ${bookingUrl(s)}`,
  generic: (s: DbState, c: Client) => `Oi, ${first(c)}! Aqui é da ${s.settings.shopName}.`,
}

function bookingUrl(_s: DbState) {
  return typeof location === 'undefined' ? '/agendar' : `${location.origin}/agendar`
}
