import {
  addToWaitlist, cancelAppointment, createAppointment, createBlock, removeBlock, removeFromWaitlist, rescheduleAppointment, setAppointmentStatus,
} from './agenda'
import { updateSettings, upsertService } from './catalog'
import { upsertClient } from './clients'
import type { Command } from './engine'
import { addTransaction, reverseTransaction } from './finance'
import { sendCampaign, upsertCoupon } from './marketing'
import { checkout, refundSale } from './sales'
import { linkBarcode, stockAdjust, stockIn, stockOut, upsertProduct } from './stock'
import { cancelSubscription, payCharge, subscribe, upsertPlan } from './subscriptions'
import { payCommissions, upsertBarber } from './team'

/** Tudo o que a equipe pode pedir ao servidor. O que não está aqui não existe para fora. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const COMMANDS: Record<string, Command<any, any>> = {
  addToWaitlist, cancelAppointment, createAppointment, createBlock, removeBlock, removeFromWaitlist, rescheduleAppointment,
  setAppointmentStatus, updateSettings, upsertService, upsertClient, addTransaction, reverseTransaction, sendCampaign, upsertCoupon,
  checkout, refundSale, linkBarcode, stockAdjust, stockIn, stockOut, upsertProduct, cancelSubscription, payCharge, subscribe, upsertPlan,
  payCommissions, upsertBarber,
}

const NAMES = new Map(Object.entries(COMMANDS).map(([name, cmd]) => [cmd, name]))

export function commandName(cmd: unknown): string {
  const name = NAMES.get(cmd as Command<unknown, unknown>)
  if (!name) throw new Error('Comando não registrado.')
  return name
}
