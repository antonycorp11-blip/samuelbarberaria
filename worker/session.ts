import type { Actor } from '../src/domain/types'

const DAYS_30 = 30 * 86_400_000
const encoder = new TextEncoder()

const b64 = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
const unb64 = (text: string) =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))

const key = (secret: string) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])

export interface Session extends Actor {
  email: string
}

export async function createSession(actor: Actor, email: string, secret: string, now = Date.now()) {
  const body = b64(encoder.encode(JSON.stringify({ ...actor, email, exp: now + DAYS_30 })))
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(body))
  return `${body}.${b64(signature)}`
}

export async function readSession(token: string | null | undefined, secret: string, now = Date.now()): Promise<Session | null> {
  const [body, signature] = (token ?? '').split('.')
  if (!body || !signature) return null
  try {
    const valid = await crypto.subtle.verify('HMAC', await key(secret), unb64(signature), encoder.encode(body))
    if (!valid) return null
    const data = JSON.parse(new TextDecoder().decode(unb64(body))) as Session & { exp: number }
    if (data.exp < now) return null
    return { role: data.role, barberId: data.barberId, name: data.name, email: data.email ?? '' }
  } catch {
    return null
  }
}
