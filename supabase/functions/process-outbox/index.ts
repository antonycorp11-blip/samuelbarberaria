// Envia a fila: e-mail pelo Gmail (senha de app) e push pelo OneSignal.
// As funções do Supabase não podem usar as portas 25 e 587, por isso a 465.
// Antes de ligar, confira com ?check=1 se a 465 passa. Ver docs/SUPABASE.md.
import { createClient } from 'npm:@supabase/supabase-js@2'
import nodemailer from 'npm:nodemailer@7'
import { mailOptions, processOutbox, type OutboxMessage } from './worker.ts'

const env = (name: string) => Deno.env.get(name) ?? ''
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))

const gmail = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: env('GMAIL_USER'), pass: env('GMAIL_APP_PASSWORD') },
})

async function sendPush(m: OutboxMessage) {
  const res = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: { Authorization: `Key ${env('ONESIGNAL_REST_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: env('ONESIGNAL_APP_ID'),
      target_channel: 'push',
      included_segments: ['Subscribed Users'],
      headings: { pt: m.subject, en: m.subject },
      contents: { pt: m.body, en: m.body },
    }),
  })
  if (!res.ok) throw new Error(`OneSignal ${res.status}: ${await res.text()}`)
}

const update = async (id: string, values: Record<string, unknown>) => {
  const { error } = await db.from('messages').update(values).eq('id', id)
  if (error) throw new Error(error.message)
}

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== env('CRON_SECRET')) return new Response('forbidden', { status: 403 })

  if (new URL(req.url).searchParams.get('check')) {
    try {
      await gmail.verify()
      return Response.json({ gmail: 'ok' })
    } catch (e) {
      return Response.json({ gmail: 'erro', detalhe: String(e) }, { status: 502 })
    }
  }

  const result = await processOutbox({
    claim: async () => {
      const { data, error } = await db.rpc('claim_messages', {
        p_daily_cap: Number(env('MAIL_DAILY_CAP') || 400),
        p_marketing_cap: Number(env('MAIL_MARKETING_CAP') || 200),
        p_batch: 20,
      })
      if (error) throw new Error(error.message)
      return data as OutboxMessage[]
    },
    sendEmail: async (m) => {
      await gmail.sendMail(mailOptions(m, env('MAIL_FROM_NAME') || 'Samuel Barbearia', env('GMAIL_USER')))
    },
    sendPush,
    markSent: (id) => update(id, { status: 'sent', sent_at: new Date().toISOString(), error: null }),
    requeue: (id, attempts, error) =>
      update(id, { status: 'queued', claimed_at: null, ...(attempts === undefined ? {} : { attempts, error }) }),
    markFailed: (id, attempts, error) => update(id, { status: 'failed', attempts, error }),
  })
  return Response.json(result)
})
