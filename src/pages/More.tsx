import { BarChart3, Boxes, Calculator, Copy, Crown, Megaphone, MessageCircle, QrCode, Scissors, Settings, Wallet } from 'lucide-react'
import { useState } from 'react'
import { QrSheet } from '@/ui/qr'
import { Link } from 'react-router-dom'
import { useActor, useDb } from '@/data/store'
import { Button, Card, PageHeader, Section, toast } from '@/ui/kit'

const bookingInvite = (shop: string, link: string) =>
  `Fala! Agora ficou fácil cuidar do visual na ${shop} ✂️\n\nAgende seu horário direto pelo celular, em menos de 1 minuto:\n👉 ${link}\n\nEscolha o serviço, o barbeiro e o melhor horário. Funciona 24 horas!`

const ITEMS = [
  { to: '/financeiro', label: 'Financeiro', sub: 'Caixa, fluxo e DRE', icon: Wallet, owner: true },
  { to: '/equipe', label: 'Equipe', sub: 'Comissões e ranking', icon: Scissors, owner: false },
  { to: '/estoque', label: 'Estoque', sub: 'Produtos e giro', icon: Boxes, owner: true },
  { to: '/assinaturas', label: 'Clube', sub: 'Assinaturas', icon: Crown, owner: true },
  { to: '/taxas', label: 'Taxas', sub: 'Quanto cai líquido', icon: Calculator, owner: true },
  { to: '/qr-servicos', label: 'QR dos serviços', sub: 'Folha para a bancada', icon: QrCode, owner: true },
  { to: '/marketing', label: 'Marketing', sub: 'Cupons e campanhas', icon: Megaphone, owner: true },
  { to: '/relatorios', label: 'Relatórios', sub: 'Indicadores', icon: BarChart3, owner: true },
  { to: '/config', label: 'Ajustes', sub: 'Serviços e horários', icon: Settings, owner: false },
]

export default function MorePage() {
  const db = useDb()
  const actor = useActor()
  const invite = bookingInvite(db.settings.shopName, `${location.origin}/agendar`)
  const [qr, setQr] = useState<'agendar' | 'clube' | null>(null)
  return (
    <>
      <PageHeader title="Mais" sub={db.settings.shopName} />
      <div className="grid grid-cols-2 gap-2 px-4">
        {ITEMS.filter((i) => !i.owner || actor.role === 'owner').map((i) => (
          <Link key={i.to} to={i.to}>
            <Card className="h-full p-3.5 active:bg-raised">
              <i.icon size={22} className="text-brass" />
              <div className="mt-2 font-bold">{i.label}</div>
              <div className="text-[13px] text-muted">{i.sub}</div>
            </Card>
          </Link>
        ))}
      </div>
      <Section title="Link de agendamento">
        <Card className="space-y-3 p-3.5">
          <p className="rounded-xl bg-raised p-3 text-sm whitespace-pre-line text-muted">{invite}</p>
          <a href={`https://wa.me/?text=${encodeURIComponent(invite)}`} target="_blank" rel="noreferrer" className="block">
            <Button variant="primary" block tabIndex={-1}><MessageCircle size={18} /> Enviar no WhatsApp</Button>
          </a>
          <div className="grid grid-cols-2 gap-2">
            <Button
              onClick={() =>
                void navigator.clipboard?.writeText(invite).then(() => toast.ok('Mensagem copiada'), () => toast.bad('Não foi possível copiar.'))
              }
            >
              <Copy size={17} /> Copiar
            </Button>
            <Button onClick={() => setQr('agendar')}><QrCode size={17} /> QR code</Button>
          </div>
          <Button block variant="ghost" onClick={() => setQr('clube')}><QrCode size={16} /> QR do clube de assinatura</Button>
        </Card>
      </Section>
      {qr && (
        <QrSheet
          text={`${location.origin}/${qr}`}
          title={qr === 'agendar' ? 'Agende seu horário' : 'Clube de assinatura'}
          caption={qr === 'agendar' ? 'Escolha o serviço e o horário pelo celular' : 'Visual em dia com mensalidade fixa'}
          onClose={() => setQr(null)}
        />
      )}
    </>
  )
}
