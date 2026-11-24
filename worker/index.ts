import { WorkerMailer } from 'worker-mailer'
import { deliver, handleApi, type Deps, type EmailSender, type Env } from './api'
import { mailSettings, renderEmail } from './email'
import { ServerStore, supabaseDb } from './store'

const sendEmail: EmailSender = async (env, n) => {
  const { smtp, from } = mailSettings(env)
  await WorkerMailer.send(smtp, {
    from,
    to: n.to,
    subject: n.subject,
    text: n.body,
    html: renderEmail(n, env.APP_URL ?? '', from.name),
  })
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
