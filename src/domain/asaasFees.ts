import { applyBps } from './money'
import { addDays } from './time'
import type { AsaasFees, Cents, DateKey } from './types'

/**
 * Taxas padrão publicadas pelo Asaas (sem a promoção dos 3 primeiros meses).
 * O dono ajusta para as da conta dele em Asaas > Minha conta > Taxas.
 */
export const DEFAULT_ASAAS_FEES: AsaasFees = {
  cardFixedCents: 49,
  cardBps: 299,
  pixCents: 199,
  anticipationMonthlyBps: 125,
  cardDays: 32,
}

export function asaasFees(f: Partial<AsaasFees> | undefined): AsaasFees {
  return { ...DEFAULT_ASAAS_FEES, ...f }
}

export interface FeeQuote {
  feeCents: Cents
  netCents: Cents
  /** Dia em que o dinheiro fica disponível para saque. */
  availableOn: DateKey
}

export interface AsaasQuote {
  pix: FeeQuote
  card: FeeQuote
  /** Cartão com antecipação de todo o prazo: taxa do cartão + juros proporcionais aos dias. */
  cardAnticipated: FeeQuote
}

const clampNet = (amount: Cents, fee: Cents): FeeQuote['netCents'] => Math.max(0, amount - fee)

/** Quanto cai líquido de uma cobrança no Asaas, por forma de pagamento. */
export function quoteAsaas(amountCents: Cents, fees: AsaasFees, today: DateKey): AsaasQuote {
  const pixFee = Math.min(amountCents, fees.pixCents)
  const cardFee = Math.min(amountCents, fees.cardFixedCents + applyBps(amountCents, fees.cardBps))
  const cardNet = clampNet(amountCents, cardFee)
  // A antecipação cobra sobre o valor líquido, proporcional aos dias que faltam (mês de 30 dias).
  const anticipation = Math.round((cardNet * fees.anticipationMonthlyBps * fees.cardDays) / (30 * 10000))
  return {
    pix: { feeCents: pixFee, netCents: clampNet(amountCents, pixFee), availableOn: today },
    card: { feeCents: cardFee, netCents: cardNet, availableOn: addDays(today, fees.cardDays) },
    cardAnticipated: { feeCents: cardFee + anticipation, netCents: clampNet(cardNet, anticipation), availableOn: today },
  }
}
