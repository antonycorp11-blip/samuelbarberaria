import { Plus, ScanLine } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, exec, nowISO, useDb } from '@/data/store'
import { METHOD_LABEL } from '@/domain/finance'
import { formatBRL } from '@/domain/money'
import { brandMatches, isLowStock, linkBarcode, productByBarcode, productCodes, sameBarcode, stockAdjust, stockIn, stockOut, stockTurnover, upsertProduct, validGtin } from '@/domain/stock'
import { dateKey, dayLabel } from '@/domain/time'
import type { ID, PaymentMethod, Product } from '@/domain/types'
import { attempt, Badge, Button, Chips, Empty, Field, IconButton, Input, List, MoneyInput, PageHeader, Row, Section, Segmented, Sheet, Stat, Toggle, toast } from '@/ui/kit'
import { QrScanner } from '@/ui/scan'

const METHODS = (Object.keys(METHOD_LABEL) as PaymentMethod[]).map((value) => ({ value, label: METHOD_LABEL[value] }))
const MOVE_LABEL = { in: 'Entrada', out: 'Saída', sale: 'Venda', refund: 'Estorno', adjust: 'Ajuste' }

type LookupResult = { name: string; message: string }

async function lookupCode(code: string): Promise<LookupResult> {
  try {
    const result = await api<{ found: boolean; name?: string; brand?: string; reason?: string; status?: number }>(`/api/products/lookup?gtin=${code}`)
    if (result.found && result.name) return { name: [result.brand, result.name].filter(Boolean).join(' · '), message: 'Nome preenchido. Você pode editar.' }
    // Cada motivo tem sua mensagem: "não encontrado" só quando a Cosmos realmente não tem o produto.
    const why: Record<string, string> = {
      not_configured: 'Busca automática desligada: falta gravar o token da Cosmos.',
      token: `A Cosmos recusou o token (código ${result.status}). Confira o token gravado.`,
      limit: 'Limite de buscas da Cosmos atingido. Tente mais tarde.',
      unavailable: `Cosmos indisponível agora${result.status ? ` (código ${result.status})` : ''}.`,
    }
    return { name: '', message: `${result.reason ? why[result.reason] ?? 'Busca indisponível.' : `A Cosmos não tem o código ${code}.`} Digite o nome.` }
  } catch {
    return { name: '', message: 'Busca indisponível. Digite o nome.' }
  }
}

type FormState = { product?: Product; barcode?: string; name?: string; similarName?: string; price?: number; minQty?: number }

function ProductForm({ form, onClose, onCreated }: { form: FormState; onClose: () => void; onCreated?: (id: ID) => void }) {
  const db = useDb()
  const product = form.product
  const [name, setName] = useState(form.name ?? product?.name ?? '')
  const [codes, setCodes] = useState(() => product ? productCodes(product) : form.barcode ? [form.barcode] : [])
  const [barcode, setBarcode] = useState('')
  const [price, setPrice] = useState(form.price ?? product?.salePriceCents ?? 0)
  const [minQty, setMinQty] = useState(String(form.minQty ?? product?.minQty ?? 3))
  const [active, setActive] = useState(product?.active ?? true)
  const [scanning, setScanning] = useState(false)
  const [lookupMessage, setLookupMessage] = useState('')
  const addCode = async (raw: string) => {
    const code = raw.replace(/\D/g, '')
    setLookupMessage('')
    if (!validGtin(code)) return toast.bad('Código de barras inválido.')
    if (codes.some((own) => sameBarcode(own, code))) {
      setLookupMessage('Código deste produto.')
      setBarcode('')
      return
    }
    const existing = productByBarcode(code, db.products)
    if (existing) {
      setLookupMessage(existing.id === product?.id ? 'Código deste produto.' : `Esse código já é de ${existing.name}.`)
      return
    }
    setCodes((list) => [...list, code])
    setBarcode('')
    if (product) return
    setLookupMessage('Buscando produto...')
    const result = await lookupCode(code)
    if (result.name) setName(result.name)
    setLookupMessage(result.message)
  }
  const save = () => {
    let id: ID | null = null
    const ok = attempt(() => { id = exec(upsertProduct, { id: product?.id, name, barcodes: codes, salePriceCents: price, minQty: Number(minQty) || 0, active }) }, 'Produto salvo')
    if (!ok) return
    onClose()
    // Produto novo nasce com estoque zero: já abre a entrada para lançar quantidade e custo.
    if (!product && id) onCreated?.(id)
  }
  return (
    <Sheet title={product ? 'Editar produto' : 'Novo produto'} onClose={onClose} footer={<Button variant="primary" block onClick={save}>Salvar</Button>}>
      {codes.length > 0 && <div className="flex flex-wrap gap-2" aria-label="Códigos do produto">{codes.map((code) => (
        <span key={code} className="inline-flex items-center gap-1 rounded-lg bg-raised px-2.5 py-1.5 text-sm tnum">{code}
          <button type="button" aria-label={`Remover código ${code}`} className="px-1 font-bold text-muted" onClick={() => setCodes((list) => list.filter((item) => item !== code))}>×</button>
        </span>
      ))}</div>}
      <Field label="Código de barras">
        <div className="flex gap-2">
          <Input inputMode="numeric" value={barcode} onChange={(e) => setBarcode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addCode(barcode) }} />
          <Button onClick={() => void addCode(barcode)}>Adicionar</Button>
          <IconButton label="Escanear código de barras" onClick={() => setScanning(true)}><ScanLine size={20} /></IconButton>
        </div>
      </Field>
      {lookupMessage && <p className="text-sm text-muted">{lookupMessage}</p>}
      {scanning && <QrScanner onClose={() => setScanning(false)} onCode={(code) => { setScanning(false); void addCode(code) }} />}
      <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      {form.similarName && name !== form.similarName && <button type="button" className="text-sm font-bold text-brass" onClick={() => setName(form.similarName!)}>Usar o nome do parecido</button>}
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
      {productCodes(p).length > 0 && <p className="text-xs text-muted">Códigos: {productCodes(p).join(' · ')}</p>}
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

function NewCodeSheet({ code, onClose, onNew, onLinked }: {
  code: string; onClose: () => void; onNew: (form: FormState) => void; onLinked: (id: ID) => void
}) {
  const db = useDb()
  const [lookup, setLookup] = useState<LookupResult | null>(null)
  const requested = useRef(false)
  const [mode, setMode] = useState<'actions' | 'link' | 'copy' | 'confirm'>('actions')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Product | null>(null)
  useEffect(() => {
    if (requested.current) return
    requested.current = true
    void lookupCode(code).then(setLookup)
  }, [code])
  const matches = brandMatches(code, db.products).filter(({ product }) => product.name.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')))
  const choose = (product: Product) => {
    if (mode === 'copy') {
      onNew({ barcode: code, name: lookup?.name || product.name, similarName: product.name, price: product.salePriceCents, minQty: product.minQty })
    } else {
      setSelected(product)
      setMode('confirm')
    }
  }
  const confirm = () => {
    if (!selected) return
    if (attempt(() => exec(linkBarcode, { productId: selected.id, barcode: code }), 'Código vinculado')) onLinked(selected.id)
  }
  return (
    <Sheet title="Código novo" onClose={onClose}>
      <p className="tnum rounded-xl bg-raised p-3 text-center text-lg font-bold">{code}</p>
      <div className="rounded-xl bg-raised p-3 text-sm">
        <p className="font-bold">Cosmos</p>
        {lookup?.name && <p className="mt-1">{lookup.name}</p>}
        <p className="mt-1 text-muted">{lookup?.message ?? 'Buscando produto...'}</p>
      </div>
      {mode === 'actions' && <div className="space-y-2">
        <Button variant="primary" block disabled={!lookup} onClick={() => onNew({ barcode: code, name: lookup?.name })}>Produto novo</Button>
        {matches.length > 0 && <>
          <Button block onClick={() => setMode('link')}>É um produto que já tenho</Button>
          <Button block disabled={!lookup} onClick={() => setMode('copy')}>Parecido com…</Button>
        </>}
      </div>}
      {(mode === 'link' || mode === 'copy') && <div className="space-y-3">
        <Button variant="ghost" onClick={() => { setMode('actions'); setSearch('') }}>‹ Voltar</Button>
        <Input aria-label="Buscar produto" placeholder="Buscar por nome" value={search} onChange={(e) => setSearch(e.target.value)} />
        {matches.length === 0 ? <p className="text-sm text-muted">Nenhum produto encontrado.</p> : <List>{matches.map(({ product, sameCompany }) => (
          <Row key={product.id} title={product.name}
            sub={<span className="flex items-center gap-2">{sameCompany && <Badge tone="brass">Mesma marca</Badge>}{product.qty} em estoque</span>}
            right={formatBRL(product.salePriceCents)} onClick={() => choose(product)} />
        ))}</List>}
      </div>}
      {mode === 'confirm' && selected && <div className="space-y-3">
        <p>Vincular o código {code} a {selected.name}?</p>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => setMode('link')}>Voltar</Button>
          <Button variant="primary" onClick={confirm}>Vincular</Button>
        </div>
      </div>}
    </Sheet>
  )
}

export default function StockPage() {
  const db = useDb()
  const [openId, setOpenId] = useState<ID | null>(null)
  const [focusQuantity, setFocusQuantity] = useState(false)
  const [form, setForm] = useState<FormState | null>(null)
  const [newCode, setNewCode] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const scan = (raw: string) => {
    const code = raw.replace(/\D/g, '')
    if (!validGtin(code)) return toast.bad('Código de barras inválido.')
    setScanning(false)
    const product = productByBarcode(code, db.products, false)
    if (product) {
      setFocusQuantity(true)
      setOpenId(product.id)
    } else {
      setNewCode(code)
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
      {newCode && <NewCodeSheet key={newCode} code={newCode} onClose={() => setNewCode(null)}
        onNew={(next) => { setForm(next); setNewCode(null) }}
        onLinked={(id) => { setNewCode(null); setFocusQuantity(true); setOpenId(id) }} />}
      {form && (
        <ProductForm
          key={form.product?.id ?? form.barcode ?? 'new'}
          form={form}
          onClose={() => setForm(null)}
          onCreated={(id) => { setFocusQuantity(true); setOpenId(id) }}
        />
      )}
    </>
  )
}
