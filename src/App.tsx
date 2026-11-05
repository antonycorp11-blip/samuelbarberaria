import { CalendarDays, Home, Plus, Users, LayoutGrid } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { useActor } from '@/data/store'
import AgendaPage from '@/pages/Agenda'
import ClientDetailPage from '@/pages/ClientDetail'
import ClientsPage from '@/pages/Clients'
import ClubPage from '@/pages/Club'
import FinancePage from '@/pages/Finance'
import HomePage from '@/pages/Home'
import MarketingPage from '@/pages/Marketing'
import MorePage from '@/pages/More'
import PublicBookingPage from '@/pages/PublicBooking'
import ReportsPage from '@/pages/Reports'
import SettingsPage from '@/pages/Settings'
import StockPage from '@/pages/Stock'
import TeamPage from '@/pages/Team'
import { cx, Toasts } from '@/ui/kit'
import { BlockSheet, BookingSheet, CheckoutSheet, QuickActions } from '@/ui/operations'

function Tab({ to, label, icon: Icon, end }: { to: string; label: string; icon: typeof Home; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx('flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-bold', isActive ? 'text-brass' : 'text-muted')
      }
    >
      <Icon size={22} />
      {label}
    </NavLink>
  )
}

function Shell() {
  const [panel, setPanel] = useState<'menu' | 'booking' | 'fitin' | 'sale' | 'block' | null>(null)
  const location = useLocation()
  return (
    <div className="mx-auto min-h-dvh max-w-2xl">
      <main key={location.pathname} className="pb-nav anim-fade"><Outlet /></main>
      <nav aria-label="Principal" className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center px-2 pt-1">
          <Tab to="/" label="Início" icon={Home} end />
          <Tab to="/agenda" label="Agenda" icon={CalendarDays} />
          <div className="flex flex-1 justify-center">
            <button
              type="button"
              aria-label="Nova ação"
              onClick={() => setPanel('menu')}
              className="grid size-13 place-items-center rounded-2xl bg-brass text-brass-ink shadow-lg shadow-brass/20 active:brightness-90"
            >
              <Plus size={26} strokeWidth={2.6} />
            </button>
          </div>
          <Tab to="/clientes" label="Clientes" icon={Users} />
          <Tab to="/mais" label="Mais" icon={LayoutGrid} />
        </div>
      </nav>
      {panel === 'menu' && <QuickActions onClose={() => setPanel(null)} onPick={setPanel} />}
      {panel === 'booking' && <BookingSheet onClose={() => setPanel(null)} />}
      {panel === 'fitin' && <BookingSheet initial={{ fitIn: true }} onClose={() => setPanel(null)} />}
      {panel === 'sale' && <CheckoutSheet onClose={() => setPanel(null)} />}
      {panel === 'block' && <BlockSheet onClose={() => setPanel(null)} />}
    </div>
  )
}

function OwnerOnly({ children }: { children: ReactNode }) {
  return useActor().role === 'owner' ? children : <Navigate to="/" replace />
}

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/agendar" element={<PublicBookingPage />} />
        <Route element={<Shell />}>
          <Route index element={<HomePage />} />
          <Route path="agenda" element={<AgendaPage />} />
          <Route path="clientes" element={<ClientsPage />} />
          <Route path="clientes/:id" element={<ClientDetailPage />} />
          <Route path="mais" element={<MorePage />} />
          <Route path="equipe" element={<TeamPage />} />
          <Route path="financeiro" element={<OwnerOnly><FinancePage /></OwnerOnly>} />
          <Route path="estoque" element={<OwnerOnly><StockPage /></OwnerOnly>} />
          <Route path="clube" element={<OwnerOnly><ClubPage /></OwnerOnly>} />
          <Route path="marketing" element={<OwnerOnly><MarketingPage /></OwnerOnly>} />
          <Route path="relatorios" element={<OwnerOnly><ReportsPage /></OwnerOnly>} />
          <Route path="config" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toasts />
    </>
  )
}
