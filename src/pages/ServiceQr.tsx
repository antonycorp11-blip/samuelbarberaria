import { Printer } from 'lucide-react'
import { useDb } from '@/data/store'
import { serviceQrText } from '@/domain/scan'
import { Button, Empty, PageHeader } from '@/ui/kit'
import { QrSvg } from '@/ui/qr'

/** Folha para colar na bancada: um QR por serviço, só com o nome (o preço vem do cadastro). */
export default function ServiceQrPage() {
  const db = useDb()
  const services = db.services.filter((s) => s.active)
  return (
    <>
      <div className="print:hidden">
        <PageHeader
          back
          title="QR dos serviços"
          sub="Imprima e cole na bancada"
          action={services.length > 0 ? <Button className="min-h-10 px-3 text-sm" onClick={() => window.print()}><Printer size={16} /> Imprimir</Button> : undefined}
        />
        <p className="px-4 pb-3 text-sm text-muted">
          No fechamento do atendimento, toque em Escanear e leia o QR de cada serviço feito. Mudar o preço não exige imprimir de novo; criar um serviço novo, sim.
        </p>
      </div>
      {services.length === 0 ? (
        <Empty title="Nenhum serviço ativo" sub="Cadastre os serviços em Ajustes." />
      ) : (
        <div className="grid grid-cols-2 gap-3 px-4 pb-8 print:grid-cols-3 print:gap-6 print:p-0">
          {services.map((s) => (
            <div key={s.id} className="flex break-inside-avoid flex-col items-center gap-2 rounded-2xl bg-white p-3 text-black print:border print:border-black/20">
              <QrSvg text={serviceQrText(s.id)} size={150} />
              <span className="text-center text-base font-bold">{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
