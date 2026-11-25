import { Plus, ScanLine } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, exec, nowISO, useDb } from '@/data/store'
import { METHOD_LABEL } from '@/domain/finance'
import { formatBRL } from '@/domain/money'
import { isLowStock, productByBarcode, stockAdjust, stockIn, stockOut, stockTurnover, upsertProduct, validGtin } from '@/domain/stock'
import { dateKey, dayLabel } from '@/domain/time'
import type { ID, PaymentMethod, Product } from '@/domain/types'
import { attempt, Badge, Button, Chips, Empty, Field, IconButton, Input, List, MoneyInput, PageHeader, Row, Section, Segmented, Sheet, Stat, Toggle, toast } from '@/ui/kit'
import { QrScanner } from '@/ui/scan'

const METHODS = (Object.keys(METHOD_LABEL) as PaymentMethod[]).map((value) => ({ value, label: METHOD_LABEL[value] }))
const MOVE_LABEL = { in: 'Entrada', out: 'Saída', sale: 'Venda', refund: 'Estorno', adjust: 'Ajuste' }

function ProductForm({ product, initialBarcode, onClose, onCreated }: { product?: Product; initialBarcode?: string; onClose: () => void; onCreated?: (id: ID) => void }) {
  const db = useDb()
  const [name, setName] = useState(product?.name ?? '')
  const [barcode, setBarcode] = useState(initialBarcode ?? product?.barcode ?? '')
  const [price, setPrice] = useState(product?.salePriceCents ?? 0)
  const [minQty, setMinQty] = useState(String(product?.minQty ?? 3))
  const [active, setActive] = useState(product?.active ?? true)
  const [scanning, setScanning] = useState(false)
  const [lookupMessage, setLookupMessage] = useState('')
  const lookup = async (raw: string) => {
    const code = raw.replace(/\D/g, '')
    setBarcode(code)
    setLookupMessage('')
    if (!validGtin(code)) return toast.bad('Código de barras inválido.')
    const existing = productByBarcode(code, db.products, false)
    if (existing) {
      setLookupMessage(existing.id === product?.id ? 'Código deste produto.' : `Esse código já é de ${existing.name}.`)
      return
    }
    setLookupMessage('Buscando produto...')
    try {
      const result = await api<{ found: boolean; name?: string; brand?: string }>(`/api/products/lookup?gtin=${code}`)
      if (result.found && result.name) {
        setName([result.brand, result.name].filter(Boolean).join(' · '))
        setLookupMessage('Nome preenchido. Você pode editar.')
      } else setLookupMessage('Produto não encontrado. Digite o nome.')
    } catch {
      setLookupMessage('Busca indisponível. Digite o nome.')
    }
  }
  useEffect(() => {
    if (initialBarcode) void lookup(initialBarcode)
    // A busca inicial acontece só quando o formulário abre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBarcode])
  const save = () => {
    let id: ID | null = null
    const ok = attempt(() => { id = exec(upsertProduct, { id: product?.id, name, barcode, salePriceCents: price, minQty: Number(minQty) || 0, active }) }, 'Produto salvo')
    if (!ok) return
    onClose()
    // Produto novo nasce com estoque zero: já abre a entrada para lançar quantidade e custo.
    if (!product && id) onCreated?.(id)
  }
  return (
    <Sheet title={product ? 'Editar produto' : 'Novo produto'} onClose={onClose} footer={<Button variant="primary" block onClick={save}>Salvar</Button>}>
      <Field label="Código de barras">
        <div className="flex gap-2">
          <Input inputMode="numeric" value={barcode} onChange={(e) => setBarcode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void lookup(barcode) }} />
          <Button onClick={() => void lookup(barcode)}>Buscar</Button>
          <IconButton label="Escanear código de barras" onClick={() => setScanning(true)}><ScanLine size={20} /></IconButton>
        </div>
      </Field>
      {lookupMessage && <p className="text-sm text-muted">{lookupMessage}</p>}
      {scanning && <QrScanner onClose={() => setScanning(false)} onCode={(code) => { setScanning(false); void lookup(code) }} />}
      <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <p className="text-sm text-muted">O código só traz o nome. O preço vai aqui; quantidade e custo entram na entrada de estoque, logo depois de salvar.</p>
      <Field label="Preço de venda"><MoneyInput value={price} onChange={setPrice} /></Field>
      <Field label="Avisar quando chegar em"><Input inputMode="numeric" value={minQty} onChange={(e) => setMinQty(e.target.value)} /></Field>
      {product && <Toggle checked={active} onChange={setActive} label="Ativo" />}
    </Sheet>
  )
}

function ProductSheet({ id, focusQuantity = false, onClose, onEdit }: { id: ID; focusQuantity?: boolean; onClose: () => void; onEdit: () => void }) {
  const db = useDb()
  const [mode, setMode] = useState<'in' | 'out' | 'adjust'>('in')
  const [qty, setQty] = useState('')
  const qtyRef = useRef<HTMLInputElement>(null)
  // A janela pega o foco ao abrir; depois dela, o cursor vai para a quantidade.
  useEffect(() => {
    if (!focusQuantity) return
    const t = window.setTimeout(() => qtyRef.current?.focus(), 350)
    return () => window.clearTimeout(t)
  }, [focusQuantity])
  const [cost, setCost] = useState(0)
  const [method, setMethod] = useState<PaymentMethod | 'none'>('pix')
  const [note, setNote] = useState('')
  const p = db.products.find((x) => x.id === id)
  if (!p) return null
  const moves = db.stockMovements.filter((m) => m.productId === id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8)
  const margin = p.salePriceCents > 0 ? Math.round(((p.salePriceCents - p.avgCostCents) / p.salePriceCents) * 100) : 0
  const n = Number(qty)
  const save = () => {
    const ok = attempt(() => {
      if (mode === 'in') exec(stockIn, { productId: id, qty: n, unitCostCents: cost, method: method === 'none' ? null : method, note })
      else if (mode === 'out') exec(stockOut, { productId: id, qty: n, note })
      else exec(stockAdjust, { productId: id, countedQty: n, note })
    }, 'Estoque atualizado')
    if (ok) {
      setQty('')
      setNote('')
    }
  }
  return (
    <Sheet title={p.name} onClose={onClose} footer={<Button variant="primary" block disabled={qty === ''} onClick={save}>Registrar</Button>}>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Quantidade" value={String(p.qty)} tone={isLowStock(p) ? 'warn' : undefined} />
        <Stat label="Custo médio" value={formatBRL(p.avgCostCents)} />
        <Stat label="Margem" value={`${margin}%`} />
      </div>
      <Segmented value={mode} onChange={setMode} options={[{ value: 'in', label: 'Entrada' }, { value: 'out', label: 'Saída' }, { value: 'adjust', label: 'Contagem' }]} />
      <Field label={mode === 'adjust' ? 'Quantidade contada' : 'Quantidade'}><Input ref={qtyRef} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} /></Field>
      {mode === 'in' && (
        <>
          <Field label="Custo por unidade"><MoneyInput value={cost} onChange={setCost} /></Field>
          <div>
            <span className="mb-1.5 block text-[13px] font-bold text-muted">Pago com</span>
            <Chips value={method} onChange={setMethod} options={[...METHODS, { value: 'none' as const, label: 'Não lançar no caixa' }]} />
          </div>
        </>
      )}
      {mode !== 'in' && <Field label="Motivo"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Uso interno, perda, inventário..." /></Field>}
      {moves.length > 0 && (
        <div className="divide-y divide-line/70 overflow-hidden rounded-xl bg-raised">
          {moves.map((m) => (
            <Row key={m.id} title={MOVE_LABEL[m.type]} sub={`${dayLabel(dateKey(m.at))}${m.note ? ` · ${m.note}` : ''}`} right={m.qty > 0 ? `+${m.qty}` : String(m.qty)} />
          ))}
        </div>
      )}
      <Button block onClick={onEdit}>Editar produto</Button>
    </Sheet>
  )
}

export default function StockPage() {
  const db = useDb()
  const [openId, setOpenId] = useState<ID | null>(null)
  const [focusQuantity, setFocusQuantity] = useState(false)
  const [form, setForm] = useState<{ product?: Product; barcode?: string } | null>(null)
  const [scanning, setScanning] = useState(false)
  const scan = (code: string) => {
    if (!validGtin(code)) return toast.bad('Código de barras inválido.')
    setScanning(false)
    const product = productByBarcode(code, db.products, false)
    if (product) {
      setFocusQuantity(true)
      setOpenId(product.id)
    } else {
      setForm({ barcode: code })
    }
  }
  const today = dateKey(nowISO())
  const rows = useMemo(() => stockTurnover(db, today), [db, today])
  const value = db.products.reduce((t, p) => t + p.qty * p.avgCostCents, 0)
  const low = db.products.filter(isLowStock)
  return (
    <>
      <PageHeader back title="Estoque" sub={`${db.products.filter((p) => p.active).length} produtos`} action={<IconButton label="Novo produto" className="bg-brass text-brass-ink" onClick={() => setForm({})}><Plus size={21} /></IconButton>} />
      <div className="px-4 pb-3"><Button block onClick={() => setScanning(true)}><ScanLine size={18} /> Escanear</Button></div>
      {scanning && <div className="px-4 pb-3"><QrScanner onClose={() => setScanning(false)} onCode={scan} /></div>}
      <div className="grid grid-cols-2 gap-2 px-4">
        <Stat label="Valor em estoque" value={formatBRL(value)} hint="Pelo custo médio" />
        <Stat label="Estoque baixo" value={String(low.length)} tone={low.length ? 'warn' : undefined} hint="Produtos para repor" />
      </div>
      <Section title="Produtos e giro (30 dias)">
        {rows.length === 0 ? <Empty title="Nenhum produto" sub="Cadastre o primeiro produto." /> : (
          <List>
            {rows.map(({ product: p, soldQty, coverDays }) => (
              <Row
                key={p.id}
                title={p.name}
                sub={`${soldQty} vendidos${coverDays !== null ? ` · dura ~${coverDays} dias` : ' · sem giro'}`}
                right={isLowStock(p) ? <Badge tone="warn">{p.qty} restam</Badge> : `${p.qty} un`}
                onClick={() => { setFocusQuantity(false); setOpenId(p.id) }}
              />
            ))}
          </List>
        )}
      </Section>
      {openId && <ProductSheet id={openId} focusQuantity={focusQuantity} onClose={() => setOpenId(null)} onEdit={() => { setForm({ product: db.products.find((p) => p.id === openId) }); setOpenId(null) }} />}
      {form && (
        <ProductForm
          key={form.product?.id ?? form.barcode ?? 'new'}
          product={form.product}
          initialBarcode={form.barcode}
          onClose={() => setForm(null)}
          onCreated={(id) => { setFocusQuantity(true); setOpenId(id) }}
        />
      )}
    </>
  )
}
