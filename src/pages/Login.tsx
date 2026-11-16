import { useEffect, useState } from 'react'
import { api, signIn } from '@/data/store'
import type { Actor } from '@/domain/types'
import { Button, Field, Input, toast } from '@/ui/kit'

export default function LoginPage() {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [forgot, setForgot] = useState(false)

  useEffect(() => {
    api<{ needsSetup: boolean }>('/api/auth/state')
      .then((r) => setNeedsSetup(r.needsSetup))
      .catch(() => setNeedsSetup(false))
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const path = needsSetup ? '/api/auth/setup' : forgot ? '/api/auth/reset' : '/api/auth/login'
      const body = needsSetup ? { key, name, email, password } : forgot ? { key, email, password } : { email, password }
      const r = await api<{ token: string; actor: Actor }>(path, { method: 'POST', body: JSON.stringify(body) })
      await signIn(r)
    } catch (err) {
      toast.bad(err instanceof Error ? err.message : 'Não foi possível entrar.')
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10">
      <img src="/logo.webp" alt="Samuel Barber Shop" width={132} height={132} className="mx-auto mb-6 rounded-3xl" />
      <h1 className="mb-6 text-center font-display text-[32px] leading-tight font-semibold tracking-tight">
        {needsSetup ? 'Criar conta do dono' : forgot ? 'Nova senha do dono' : 'Entrar'}
      </h1>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        {needsSetup && <Field label="Seu nome"><Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></Field>}
        <Field label="E-mail"><Input type="email" autoComplete="username" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={forgot ? 'Nova senha' : 'Senha'} hint={needsSetup || forgot ? 'Ao menos 8 caracteres.' : undefined}>
          <Input type="password" autoComplete={needsSetup || forgot ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {(needsSetup || forgot) && (
          <Field label="Chave de instalação" hint="A TEST_KEY gravada na Cloudflare. Só é pedida agora.">
            <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
        )}
        <Button type="submit" variant="primary" block disabled={busy || needsSetup === null}>
          {busy ? 'Aguarde…' : needsSetup ? 'Criar e entrar' : forgot ? 'Salvar e entrar' : 'Entrar'}
        </Button>
      </form>
      {needsSetup === false && (
        <button type="button" onClick={() => setForgot(!forgot)} className="mt-4 min-h-10 text-center text-sm font-semibold text-muted">
          {forgot ? 'Voltar para o login' : 'Esqueci a senha'}
        </button>
      )}
      {forgot && <p className="mt-1 text-center text-xs text-muted">Barbeiro: peça ao dono para criar uma nova senha na tela Equipe.</p>}
    </div>
  )
}
