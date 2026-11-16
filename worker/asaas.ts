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
  subscription?: string | null
  externalReference?: string | null
}

export interface AsaasSubscription {
  id: string
  status: string
  deleted?: boolean
  checkoutSession?: string | null
  externalReference?: string | null
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
    if (!res.ok) throw new Error(`Asaas ${res.status}: ${data.errors?.map((e) => e.description).join('; ') || 'sem detalhes'}`)
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
