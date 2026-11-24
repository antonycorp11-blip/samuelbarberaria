// Cliente da API do Asaas: checkout com assinatura recorrente no cartão.

export interface AsaasEnv {
  ASAAS_API_KEY?: string
  ASAAS_WEBHOOK_TOKEN?: string
  /** "true" usa o ambiente de testes (sandbox). */
  ASAAS_SANDBOX?: string
  ASAAS_API_URL?: string
}

export interface AsaasPayment {
  id: string
  status: string
  value: number
  /** Valor que cai na conta depois da taxa do Asaas. */
  netValue?: number | null
  dueDate?: string
  subscription?: string | null
  externalReference?: string | null
}

export interface AsaasSubscription {
  id: string
  status: string
  deleted?: boolean
  checkoutSession?: string | null
  externalReference?: string | null
  pixAutomaticAuthorizationMode?: string | null
}

export interface AsaasPixQrCode {
  encodedImage: string
  payload: string
  expirationDate: string
}

/** Erro devolvido pela API, com o código HTTP para separar dado recusado de falha do Asaas. */
export class AsaasError extends Error {
  constructor(readonly status: number, readonly description: string) {
    super(`Asaas ${status}: ${description}`)
  }
}

/** Situações em que o dinheiro do cartão já foi aprovado. */
export const PAID_STATUSES = ['CONFIRMED', 'RECEIVED']

export function asaas(env: AsaasEnv, http: typeof fetch = fetch) {
  const sandbox = env.ASAAS_SANDBOX === 'true'
  const base = env.ASAAS_API_URL ?? (sandbox ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3')
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await http(`${base}${path}`, {
      ...init,
      headers: { access_token: env.ASAAS_API_KEY ?? '', 'Content-Type': 'application/json', 'User-Agent': 'SamuelBarberShop/1.0', ...init?.headers },
    })
    const data = (await res.json().catch(() => ({}))) as T & { errors?: { description?: string }[] }
    if (!res.ok) throw new AsaasError(res.status, data.errors?.map((e) => e.description).join('; ') || 'sem detalhes')
    return data
  }
  return {
    configured: Boolean(env.ASAAS_API_KEY && env.ASAAS_WEBHOOK_TOKEN),
    checkoutUrl: (id: string) => `${sandbox ? 'https://sandbox.asaas.com' : 'https://asaas.com'}/checkoutSession/show?id=${encodeURIComponent(id)}`,
    /** Página de pagamento do Asaas que, depois de paga, cria a assinatura mensal no cartão. */
    createCheckout: (c: { subscriptionId: string; name: string; amountCents: number; firstDueDate: string; appUrl: string }) =>
      call<{ id: string }>('/checkouts', {
        method: 'POST',
        body: JSON.stringify({
          billingTypes: ['CREDIT_CARD'],
          chargeTypes: ['RECURRENT'],
          minutesToExpire: 1440,
          externalReference: c.subscriptionId,
          callback: {
            successUrl: `${c.appUrl}/clube/obrigado`,
            cancelUrl: `${c.appUrl}/clube`,
            expiredUrl: `${c.appUrl}/clube`,
          },
          items: [{ name: c.name, description: 'Assinatura mensal', quantity: 1, value: c.amountCents / 100 }],
          subscription: { cycle: 'MONTHLY', nextDueDate: c.firstDueDate },
        }),
      }),
    /** Reaproveita o cliente pelo CPF para não duplicar cadastro no Asaas. */
    customerFor: async (c: { name: string; cpf: string; email: string; phone: string; externalReference: string }) => {
      const cpf = c.cpf.replace(/\D/g, '')
      const found = await call<{ data?: { id: string }[] }>(`/customers?cpfCnpj=${cpf}&limit=1`)
      const existing = found.data?.[0]
      if (existing) return existing.id
      const created = await call<{ id: string }>('/customers', {
        method: 'POST',
        body: JSON.stringify({
          // Os avisos do Asaas ficam ligados: quem não autorizar o Pix Automático recebe o Pix do mês por e-mail.
          name: c.name, cpfCnpj: cpf, email: c.email, mobilePhone: c.phone, externalReference: c.externalReference,
        }),
      })
      return created.id
    },
    /**
     * Assinatura mensal no Pix com a oferta de Pix Automático. Conta que ainda não pode usar
     * o Pix Automático recebe a mesma assinatura sem a oferta: o cliente paga o Pix todo mês.
     */
    createPixSubscription: async (c: { customer: string; amountCents: number; firstDueDate: string; description: string; subscriptionId: string }) => {
      const body = (mode: 'OPTIONAL' | 'DISABLED') => JSON.stringify({
        customer: c.customer, billingType: 'PIX', cycle: 'MONTHLY', value: c.amountCents / 100, nextDueDate: c.firstDueDate,
        description: c.description, externalReference: c.subscriptionId, pixAutomaticAuthorizationMode: mode,
      })
      try {
        return await call<AsaasSubscription>('/subscriptions', { method: 'POST', body: body('OPTIONAL') })
      } catch (e) {
        if (!(e instanceof AsaasError) || e.status !== 400) throw e
        return call<AsaasSubscription>('/subscriptions', { method: 'POST', body: body('DISABLED') })
      }
    },
    subscriptionPayments: (id: string) => call<{ data: AsaasPayment[] }>(`/subscriptions/${encodeURIComponent(id)}/payments`),
    pixQrCode: (paymentId: string) => call<AsaasPixQrCode>(`/payments/${encodeURIComponent(paymentId)}/pixQrCode`),
    getPayment: (id: string) => call<AsaasPayment>(`/payments/${encodeURIComponent(id)}`),
    getSubscription: (id: string) => call<AsaasSubscription>(`/subscriptions/${encodeURIComponent(id)}`),
    /** Encerra a recorrência: o Asaas para de gerar cobranças e remove as pendentes. */
    deleteSubscription: (id: string) => call<{ deleted: boolean }>(`/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  }
}

/** O Asaas manda o token configurado no cabeçalho asaas-access-token. Comparação em tempo constante. */
export function validWebhookToken(req: Request, expected: string | undefined): boolean {
  const got = req.headers.get('asaas-access-token') ?? ''
  if (!expected || got.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}
