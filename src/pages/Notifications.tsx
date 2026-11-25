import { Bell, Mail, Send } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useDb } from '@/data/store'
import { sendNow, serverStatus } from '@/integrations/notify'
import { enablePush, pushStatus, type PushStatus } from '@/integrations/push'
import { Badge, Button, Card, Field, Input, List, PageHeader, Row, Section, toast } from '@/ui/kit'
import { EmailFix } from '@/ui/emailFix'

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Falha no envio.')

export default function NotificationsPage() {
  const db = useDb()
  const [server, setServer] = useState<{ email: boolean; push: boolean } | null>(null)
  const [push, setPush] = useState<PushStatus | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState('')

  const refresh = useCallback(async () => {
    setPush(await pushStatus())
    setServer(await serverStatus().catch(() => null))
  }, [])

  useEffect(() => void refresh(), [refresh])

  const run = async (name: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(name)
    try {
      await fn()
      toast.ok(success)
    } catch (e) {
      toast.bad(errorText(e))
    }
    setBusy('')
  }

  const queued = db.messages.filter((m) => m.status === 'queued' || m.status === 'sending').length
  const recent = [...db.messages].filter((m) => m.status === 'sent' || m.status === 'failed').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8)

  return (
    <>
      <PageHeader title="Notificações" sub="Teste de e-mail e push" />
      <div className="px-4"><Link to="/config" className="text-sm font-semibold text-muted">‹ Ajustes</Link></div>

      <Section title="Conexão">
        <Card className="flex flex-wrap gap-2 p-3.5">
          <Badge tone={server?.email ? 'ok' : 'bad'}>Gmail {server?.email ? 'configurado' : 'sem senha'}</Badge>
          <Badge tone={server?.push ? 'ok' : 'bad'}>OneSignal {server?.push ? 'configurado' : 'sem chave'}</Badge>
          <Badge>{queued} na fila</Badge>
        </Card>
      </Section>

      <Section title="E-mail">
        <Card className="space-y-3 p-3.5">
          <Field label="Enviar para"><Input inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="seu@email.com" /><EmailFix email={email} onFix={setEmail} /></Field>
          <Button
            variant="primary"
            block
            disabled={!server?.email || !email || busy !== ''}
            onClick={() =>
              run('email', () => sendNow({ channel: 'email', to: email.trim(), subject: 'Teste da barbearia ✂️', body: 'Se você recebeu este e-mail com acentuação correta, o envio está funcionando.' }), 'E-mail enviado. Confira a caixa de entrada.')
            }
          >
            <Mail size={18} /> {busy === 'email' ? 'Enviando…' : 'Enviar e-mail de teste'}
          </Button>
        </Card>
      </Section>

      <Section title="Push neste aparelho">
        <Card className="space-y-3 p-3.5">
          {push === null && <p className="text-sm text-muted">Verificando…</p>}
          {push && !push.available && <p className="text-sm text-muted">O OneSignal não respondeu. Recarregue o app.</p>}
          {push?.available && !push.supported && (
            <p className="text-sm text-warn">Este navegador não aceita push. No iPhone, instale o app na Tela de Início e abra por lá.</p>
          )}
          {push?.available && push.supported && (
            <div className="flex items-center justify-between">
              <span className="text-[15px] font-semibold">Este aparelho</span>
              <Badge tone={push.subscribed ? 'ok' : 'warn'}>{push.subscribed ? 'Inscrito' : 'Não inscrito'}</Badge>
            </div>
          )}
          {push?.supported && !push.subscribed && (
            <Button block disabled={busy !== ''} onClick={() => run('enable', async () => setPush(await enablePush()), 'Pedido concluído')}>
              <Bell size={18} /> Ativar notificações
            </Button>
          )}
          <Button
            variant="primary"
            block
            disabled={!server?.push || !push?.subscribed || busy !== ''}
            onClick={() => run('push', () => sendNow({ channel: 'push', to: 'equipe', subject: 'Teste da barbearia', body: 'As notificações estão funcionando.' }), 'Push enviado.')}
          >
            <Send size={18} /> {busy === 'push' ? 'Enviando…' : 'Enviar push de teste'}
          </Button>
        </Card>
      </Section>

      {recent.length > 0 && (
        <Section title="Últimas mensagens">
          <List>
            {recent.map((m) => (
              <Row key={m.id} title={m.subject} sub={m.error ?? m.to} right={m.status === 'sent' ? <Badge tone="ok">Enviada</Badge> : <Badge tone="bad">Falhou</Badge>} />
            ))}
          </List>
        </Section>
      )}
    </>
  )
}
