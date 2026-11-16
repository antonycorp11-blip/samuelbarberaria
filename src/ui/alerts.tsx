import { Bell, CalendarPlus, Package } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDb } from '@/data/store'
import { dateKey, dayLabel, timeOf } from '@/domain/time'
import type { Message } from '@/domain/types'
import { Empty, IconButton, Row, Sheet, toast } from './kit'

const SEEN = 'samuel-alerts-seen'

function readSeen() {
  try {
    return localStorage.getItem(SEEN) ?? ''
  } catch {
    return ''
  }
}

function saveSeen(at: string) {
  try {
    localStorage.setItem(SEEN, at)
  } catch {
    // Sem armazenamento: o contador volta ao abrir o app.
  }
}

const alertsOf = (messages: Message[]) =>
  messages.filter((m) => m.channel === 'push').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40)

/** Sininho com os avisos da equipe. Aviso novo também aparece na hora, com o app aberto. */
export function AlertsBell() {
  const db = useDb()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState(readSeen)
  const alerts = alertsOf(db.messages)
  const unread = alerts.filter((m) => m.createdAt > seen).length
  const newest = alerts[0]
  const announced = useRef(newest?.id)

  useEffect(() => {
    if (!newest || announced.current === newest.id) return
    if (announced.current !== undefined && newest.kind === 'new_booking') toast.ok(`${newest.subject}: ${newest.body}`)
    announced.current = newest.id
  }, [newest])

  const show = () => {
    setOpen(true)
    const at = newest?.createdAt ?? ''
    setSeen(at)
    saveSeen(at)
  }

  return (
    <>
      <div className="relative">
        <IconButton label={unread ? `${unread} avisos novos` : 'Avisos'} onClick={show}><Bell size={20} /></IconButton>
        {unread > 0 && (
          <span className="tnum pointer-events-none absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-bad px-1 text-[11px] font-extrabold text-[#2a0c09]">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </div>
      {open && (
        <Sheet title="Avisos" onClose={() => setOpen(false)}>
          {alerts.length === 0 ? <Empty title="Nenhum aviso ainda" sub="Novos agendamentos e estoque baixo aparecem aqui." /> : (
            <div className="divide-y divide-line/70 overflow-hidden rounded-xl bg-raised">
              {alerts.map((m) => (
                <Row
                  key={m.id}
                  left={m.kind === 'new_booking' ? <CalendarPlus size={19} className="text-brass" /> : <Package size={19} className="text-warn" />}
                  title={m.subject}
                  sub={`${m.body} · ${dayLabel(dateKey(m.createdAt))} ${timeOf(m.createdAt)}`}
                  onClick={() => {
                    setOpen(false)
                    navigate(m.kind === 'new_booking' ? '/agenda' : '/estoque')
                  }}
                />
              ))}
            </div>
          )}
        </Sheet>
      )}
    </>
  )
}
