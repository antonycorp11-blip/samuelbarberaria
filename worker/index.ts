import { WorkerMailer } from 'worker-mailer'
import { deliver, handleApi, type Deps, type EmailSender, type Env } from './api'
import { renderEmail } from './email'
import { ServerStore, supabaseDb } from './store'

// Porta 465 com TLS direto. A Cloudflare só bloqueia a porta 25.
const sendEmail: EmailSender = async (env, n) => {
  const secure = env.SMTP_SECURE !== 'false'
  const shop = env.MAIL_FROM_NAME ?? 'Samuel Barber Shop'
  await WorkerMailer.send(
    {
      host: env.SMTP_HOST ?? 'smtp.gmail.com',
      port: Number(env.SMTP_PORT ?? 465),
      secure,
      startTls: secure,
      credentials: { username: env.GMAIL_USER ?? '', password: env.GMAIL_APP_PASSWORD ?? '' },
      authType: ['plain', 'login'],
    },
    {
      from: { name: shop, email: env.GMAIL_USER ?? '' },
      to: n.to,
      subject: n.subject,
      text: n.body,
      html: renderEmail(n, env.APP_URL ?? '', shop),
    },
  )
}

interface ExecutionContext {
  waitUntil(work: Promise<unknown>): void
}

let store: ServerStore | undefined

function deps(env: Env, ctx: ExecutionContext): Deps {
  const db = supabaseDb(env.SUPABASE_URL ?? '', env.SUPABASE_KEY ?? '', env.STORE_SECRET ?? '')
  // Mantida entre requisições: só baixa o que mudou desde a última vez.
  store ??= new ServerStore(db)
  return { env, store, db, sendEmail, later: (work) => ctx.waitUntil(work.catch((e) => console.error(e))) }
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    if (!env.STORE_SECRET || !env.SESSION_SECRET) {
      return Response.json({ error: { message: 'Servidor sem configuração.' } }, { status: 503 })
    }
    return handleApi(req, deps(env, ctx))
  },
  async scheduled(event: { scheduledTime: number }, env: Env, ctx: ExecutionContext) {
    if (!env.STORE_SECRET) return
    // A fila sai a cada minuto; as automações, a cada dez.
    const automations = new Date(event.scheduledTime).getUTCMinutes() % 10 === 0
    await deliver(deps(env, ctx), automations)
  },
}
