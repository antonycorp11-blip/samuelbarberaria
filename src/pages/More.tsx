import { BarChart3, Boxes, Crown, Link2, Megaphone, Scissors, Settings, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useActor, useDb } from '@/data/store'
import { attempt, Card, PageHeader, toast } from '@/ui/kit'

const ITEMS = [
  { to: '/financeiro', label: 'Financeiro', sub: 'Caixa, fluxo e DRE', icon: Wallet, owner: true },
  { to: '/equipe', label: 'Equipe', sub: 'Comissões e ranking', icon: Scissors, owner: false },
  { to: '/estoque', label: 'Estoque', sub: 'Produtos e giro', icon: Boxes, owner: true },
  { to: '/clube', label: 'Clube', sub: 'Assinaturas', icon: Crown, owner: true },
  { to: '/marketing', label: 'Marketing', sub: 'Cupons e campanhas', icon: Megaphone, owner: true },
  { to: '/relatorios', label: 'Relatórios', sub: 'Indicadores', icon: BarChart3, owner: true },
  { to: '/config', label: 'Ajustes', sub: 'Serviços e horários', icon: Settings, owner: false },
]

export default function MorePage() {
  const db = useDb()
  const actor = useActor()
  const link = `${location.origin}/agendar`
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
      <div className="px-4 pt-2">
        <button
          type="button"
          className="block w-full text-left"
          onClick={() =>
            attempt(() => {
              void navigator.clipboard?.writeText(link)
              toast.ok('Link copiado')
            })
          }
        >
          <Card className="flex items-center gap-3 p-3.5 active:bg-raised">
            <Link2 size={22} className="shrink-0 text-brass" />
            <div className="min-w-0">
              <div className="font-bold">Link de agendamento</div>
              <div className="truncate text-[13px] text-muted">{link}</div>
            </div>
          </Card>
        </button>
      </div>
    </>
  )
}
