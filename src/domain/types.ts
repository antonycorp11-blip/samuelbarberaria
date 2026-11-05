export type ID = string
/** Dinheiro sempre em centavos inteiros: nunca usar float para valores. */
export type Cents = number
/** Percentual em basis points: 4500 = 45%. */
export type Bps = number
/** Instante em ISO-8601 UTC. */
export type ISO = string
/** Dia civil da barbearia: YYYY-MM-DD. */
export type DateKey = string

export type PaymentMethod = 'pix' | 'cash' | 'debit' | 'credit'
export type Role = 'owner' | 'barber'

export interface Actor {
  role: Role
  barberId: ID | null
  name: string
}

export interface DayHours {
  open: string
  close: string
}

export interface Settings {
  shopName: string
  phone: string
  address: string
  slug: string
  slotMinutes: number
  /** Índice 0 = domingo. null = fechado. */
  hours: (DayHours | null)[]
  feeBps: Record<PaymentMethod, Bps>
  bookingWindowDays: number
  minAdvanceMinutes: number
  inactiveDays: number
  loyaltyStampsRequired: number
  subscriptionCommissionBps: Bps
  subscriptionGraceDays: number
}

export interface Service {
  id: ID
  name: string
  priceCents: Cents
  durationMin: number
  active: boolean
}

export interface Barber {
  id: ID
  name: string
  email: string
  phone: string
  serviceBps: Bps
  productBps: Bps
  active: boolean
  /** Dias da semana de folga (0 = domingo). */
  daysOff: number[]
  breakStart: string | null
  breakEnd: string | null
}

export interface Client {
  id: ID
  name: string
  phone: string
  email: string
  /** MM-DD: o ano não importa para a mensagem de aniversário. */
  birthday: string | null
  notes: string
  marketingOptIn: boolean
  stamps: number
  rewards: number
  createdAt: ISO
}

export type AppointmentStatus =
  | 'scheduled'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show'

export interface Appointment {
  id: ID
  clientId: ID
  barberId: ID
  serviceIds: ID[]
  start: ISO
  end: ISO
  status: AppointmentStatus
  source: 'staff' | 'online' | 'fit_in'
  notes: string
  saleId: ID | null
  createdAt: ISO
}

export interface Block {
  id: ID
  /** null = barbearia inteira. */
  barberId: ID | null
  start: ISO
  end: ISO
  reason: string
}

export interface WaitlistEntry {
  id: ID
  clientId: ID
  serviceIds: ID[]
  barberId: ID | null
  date: DateKey
  status: 'waiting' | 'notified' | 'booked' | 'expired'
  createdAt: ISO
}

export interface Product {
  id: ID
  name: string
  salePriceCents: Cents
  avgCostCents: Cents
  qty: number
  minQty: number
  active: boolean
}

export type StockMovementType = 'in' | 'out' | 'sale' | 'refund' | 'adjust'

export interface StockMovement {
  id: ID
  productId: ID
  type: StockMovementType
  /** Positivo entra no estoque, negativo sai. */
  qty: number
  unitCostCents: Cents
  at: ISO
  saleId: ID | null
  note: string
}

export interface SaleItem {
  id: ID
  kind: 'service' | 'product'
  refId: ID
  name: string
  qty: number
  unitPriceCents: Cents
  /** Valor antes de descontos. */
  grossCents: Cents
  discountCents: Cents
  /** Valor final do item, base de comissão. */
  netCents: Cents
  unitCostCents: Cents
  barberId: ID
  coverage: 'subscription' | 'reward' | null
}

export interface SalePayment {
  method: PaymentMethod
  amountCents: Cents
  feeCents: Cents
}

export interface Sale {
  id: ID
  clientId: ID | null
  barberId: ID
  appointmentId: ID | null
  items: SaleItem[]
  subtotalCents: Cents
  discountCents: Cents
  totalCents: Cents
  couponId: ID | null
  subscriptionId: ID | null
  usedReward: boolean
  stampAwarded: boolean
  rewardEarned: boolean
  payments: SalePayment[]
  status: 'paid' | 'refunded'
  at: ISO
  refundedAt: ISO | null
  refundReason: string
}

export type TxCategory =
  | 'venda'
  | 'assinatura'
  | 'taxa_pagamento'
  | 'estorno'
  | 'comissao'
  | 'compra_estoque'
  | 'aluguel'
  | 'energia_agua'
  | 'internet_software'
  | 'marketing'
  | 'manutencao'
  | 'salarios'
  | 'impostos'
  | 'outras_despesas'
  | 'outras_receitas'

export interface Transaction {
  id: ID
  type: 'in' | 'out'
  category: TxCategory
  amountCents: Cents
  method: PaymentMethod
  at: ISO
  description: string
  saleId: ID | null
  /** Lançamentos nunca são apagados: a correção é um lançamento oposto. */
  reversalOf: ID | null
  reversed: boolean
}

export interface Commission {
  id: ID
  barberId: ID
  saleId: ID | null
  chargeId: ID | null
  kind: 'service' | 'product' | 'subscription' | 'reversal'
  baseCents: Cents
  bps: Bps
  /** Negativo em estornos: abate do próximo pagamento. */
  amountCents: Cents
  status: 'pending' | 'paid'
  payoutId: ID | null
  at: ISO
}

export interface Payout {
  id: ID
  barberId: ID
  amountCents: Cents
  method: PaymentMethod
  at: ISO
}

export interface Plan {
  id: ID
  name: string
  priceCents: Cents
  /** null = ilimitado. */
  visitsPerCycle: number | null
  serviceIds: ID[]
  productDiscountBps: Bps
  benefits: string[]
  active: boolean
}

export interface Subscription {
  id: ID
  clientId: ID
  planId: ID
  status: 'active' | 'past_due' | 'cancelled'
  startedAt: ISO
  periodStart: DateKey
  periodEnd: DateKey
  usedVisits: number
  autoRenew: boolean
  cancelledAt: ISO | null
}

export interface SubscriptionCharge {
  id: ID
  subscriptionId: ID
  periodStart: DateKey
  periodEnd: DateKey
  amountCents: Cents
  dueDate: DateKey
  status: 'pending' | 'paid' | 'void'
  paidAt: ISO | null
  method: PaymentMethod | null
  feeCents: Cents
  commissionClosed: boolean
}

export interface Coupon {
  id: ID
  code: string
  type: 'percent' | 'fixed'
  /** bps quando percent, centavos quando fixed. */
  value: number
  minCents: Cents
  maxUses: number | null
  uses: number
  validFrom: DateKey
  validTo: DateKey
  active: boolean
}

export type CampaignAudience = 'all' | 'inactive' | 'subscribers' | 'birthday_month'

export interface Campaign {
  id: ID
  name: string
  audience: CampaignAudience
  subject: string
  body: string
  couponId: ID | null
  recipients: number
  sentAt: ISO
}

export type MessageKind =
  | 'booking_confirmation'
  | 'reminder_24h'
  | 'reminder_2h'
  | 'cancellation'
  | 'waitlist_slot'
  | 'welcome'
  | 'birthday'
  | 'recovery'
  | 'campaign'
  | 'charge_due'
  | 'charge_overdue'
  | 'low_stock'

export interface Message {
  id: ID
  channel: 'email' | 'push'
  to: string
  clientId: ID | null
  kind: MessageKind
  subject: string
  body: string
  /** Garante que automações rodem várias vezes sem mandar em dobro. */
  dedupeKey: string
  status: 'queued' | 'sent' | 'failed'
  createdAt: ISO
  sentAt: ISO | null
  error: string | null
}

export interface AuditEntry {
  id: ID
  at: ISO
  actor: string
  action: string
  entityId: ID | null
  detail: string
}

export interface DbState {
  schemaVersion: number
  settings: Settings
  services: Service[]
  barbers: Barber[]
  clients: Client[]
  appointments: Appointment[]
  blocks: Block[]
  waitlist: WaitlistEntry[]
  products: Product[]
  stockMovements: StockMovement[]
  sales: Sale[]
  transactions: Transaction[]
  commissions: Commission[]
  payouts: Payout[]
  plans: Plan[]
  subscriptions: Subscription[]
  charges: SubscriptionCharge[]
  coupons: Coupon[]
  campaigns: Campaign[]
  messages: Message[]
  audit: AuditEntry[]
}

export const SCHEMA_VERSION = 1

export function emptyState(): DbState {
  const week = { open: '09:00', close: '20:00' }
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: {
      shopName: 'Samuel Barbearia',
      phone: '',
      address: '',
      slug: 'samuel',
      slotMinutes: 15,
      hours: [null, week, week, week, week, week, { open: '09:00', close: '18:00' }],
      feeBps: { pix: 0, cash: 0, debit: 199, credit: 349 },
      bookingWindowDays: 30,
      minAdvanceMinutes: 60,
      inactiveDays: 45,
      loyaltyStampsRequired: 10,
      subscriptionCommissionBps: 4000,
      subscriptionGraceDays: 5,
    },
    services: [],
    barbers: [],
    clients: [],
    appointments: [],
    blocks: [],
    waitlist: [],
    products: [],
    stockMovements: [],
    sales: [],
    transactions: [],
    commissions: [],
    payouts: [],
    plans: [],
    subscriptions: [],
    charges: [],
    coupons: [],
    campaigns: [],
    messages: [],
    audit: [],
  }
}
