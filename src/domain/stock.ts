import { audit, must, requireOwner, type Command } from './engine'
import { fail } from './errors'
import { addDays, dateKey } from './time'
import type { Cents, DateKey, DbState, ID, PaymentMethod, Product } from './types'

export function validGtin(value: string): boolean {
  if (!/^\d{8,14}$/.test(value)) return false
  const digits = [...value].map(Number)
  const sum = digits.slice(0, -1).reverse().reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0)
  return (10 - sum % 10) % 10 === digits[digits.length - 1]
}

export function sameBarcode(a: string, b: string): boolean {
  return a === b || (a.length === 12 && b === `0${a}`) || (b.length === 12 && a === `0${b}`)
}

export function productCodes(p: Product): string[] {
  return [...new Set([...(p.barcodes ?? []), p.barcode].filter((code): code is string => Boolean(code)))]
}

export function productByBarcode(code: string, products: Product[], activeOnly = true): Product | null {
  return products.find((p) => (!activeOnly || p.active) && productCodes(p).some((own) => sameBarcode(own, code))) ?? null
}

export function brandMatches(code: string, products: Product[]): { product: Product; sameCompany: boolean }[] {
  return products.filter((p) => p.active).map((product) => {
    const common = productCodes(product).filter((own) => code.length === 13 && own.length === 13).reduce((best, own) => {
      let length = 0
      while (length < 13 && code[length] === own[length]) length++
      return Math.max(best, length)
    }, 0)
    return { product, sameCompany: common >= 7 }
  }).sort((a, b) => Number(b.sameCompany) - Number(a.sameCompany) || a.product.name.localeCompare(b.product.name, 'pt-BR'))
}

const normalizeBarcode = (barcode: string) => barcode.replace(/\D/g, '')
const uniqueCodes = (codes: string[]) => codes.filter((code, index) => codes.findIndex((other) => sameBarcode(other, code)) === index)

function checkCodes(codes: string[], products: Product[], ownId?: ID) {
  for (const code of codes) {
    if (!validGtin(code)) fail('bad_barcode', 'Código de barras inválido.')
    if (products.some((p) => p.id !== ownId && p.active && productCodes(p).some((own) => sameBarcode(own, code)))) {
      fail('duplicate_barcode', 'Esse código de barras já é de outro produto.')
    }
  }
}

export function weightedAverage(qty: number, avg: Cents, addQty: number, addCost: Cents): Cents {
  const total = qty + addQty
  return total > 0 ? Math.round((qty * avg + addQty * addCost) / total) : addCost
}

export const upsertProduct: Command<
  { id?: ID; name: string; salePriceCents: Cents; minQty: number; active?: boolean; barcode?: string | null; barcodes?: string[] },
  ID
> = (d, i, ctx) => {
  requireOwner(ctx)
  if (!i.name.trim()) fail('bad_name', 'Informe o nome do produto.')
  if (i.salePriceCents < 0 || i.minQty < 0) fail('bad_value', 'Valores não podem ser negativos.')
  const current = i.id ? must(d.products.find((p) => p.id === i.id), 'Produto') : null
  const codes = uniqueCodes((i.barcodes ?? (i.barcode !== undefined ? (i.barcode ? [i.barcode] : []) : current ? productCodes(current) : []))
    .map(normalizeBarcode))
  checkCodes(codes, d.products, i.id)
  if (current) {
    current.name = i.name.trim()
    current.salePriceCents = i.salePriceCents
    current.minQty = i.minQty
    current.barcodes = codes
    current.barcode = codes[0] ?? null
    current.active = i.active ?? current.active
    return current.id
  }
  const id = ctx.id()
  d.products.push({
    id, name: i.name.trim(), barcodes: codes, barcode: codes[0] ?? null, salePriceCents: i.salePriceCents, minQty: i.minQty, avgCostCents: 0, qty: 0, active: true,
  })
  return id
}

export const linkBarcode: Command<{ productId: ID; barcode: string }> = (d, i, ctx) => {
  requireOwner(ctx)
  const product = must(d.products.find((p) => p.id === i.productId), 'Produto')
  const code = normalizeBarcode(i.barcode)
  checkCodes([code], d.products, product.id)
  const codes = productCodes(product)
  if (codes.some((own) => sameBarcode(own, code))) return
  product.barcodes = [...codes, code]
  product.barcode = product.barcodes[0] ?? null
  audit(d, ctx, 'estoque.codigo.vincular', product.id, code)
}

export const stockIn: Command<{ productId: ID; qty: number; unitCostCents: Cents; method?: PaymentMethod | null; note?: string }> = (d, i, ctx) => {
  requireOwner(ctx)
  if (!Number.isInteger(i.qty) || i.qty <= 0) fail('bad_qty', 'Quantidade inválida.')
  if (i.unitCostCents < 0) fail('bad_value', 'Custo inválido.')
  const p = must(d.products.find((x) => x.id === i.productId), 'Produto')
  p.avgCostCents = weightedAverage(p.qty, p.avgCostCents, i.qty, i.unitCostCents)
  p.qty += i.qty
  d.stockMovements.push({
    id: ctx.id(), productId: p.id, type: 'in', qty: i.qty, unitCostCents: i.unitCostCents, at: ctx.now, saleId: null, note: i.note ?? '',
  })
  if (i.method && i.unitCostCents > 0) {
    d.transactions.push({
      id: ctx.id(), type: 'out', category: 'compra_estoque', amountCents: i.qty * i.unitCostCents, method: i.method, at: ctx.now,
      description: `Compra: ${p.name}`, saleId: null, reversalOf: null, reversed: false,
    })
  }
  audit(d, ctx, 'estoque.entrada', p.id, `qtd=${i.qty}`)
}

export const stockOut: Command<{ productId: ID; qty: number; note: string }> = (d, i, ctx) => {
  requireOwner(ctx)
  if (!Number.isInteger(i.qty) || i.qty <= 0) fail('bad_qty', 'Quantidade inválida.')
  const p = must(d.products.find((x) => x.id === i.productId), 'Produto')
  if (p.qty < i.qty) fail('no_stock', `Estoque insuficiente: restam ${p.qty}.`)
  p.qty -= i.qty
  d.stockMovements.push({
    id: ctx.id(), productId: p.id, type: 'out', qty: -i.qty, unitCostCents: p.avgCostCents, at: ctx.now, saleId: null, note: i.note,
  })
  audit(d, ctx, 'estoque.saida', p.id, i.note)
}

/** Ajuste de inventário: informa quanto foi contado e registra a diferença. */
export const stockAdjust: Command<{ productId: ID; countedQty: number; note: string }> = (d, i, ctx) => {
  requireOwner(ctx)
  if (!Number.isInteger(i.countedQty) || i.countedQty < 0) fail('bad_qty', 'Quantidade inválida.')
  const p = must(d.products.find((x) => x.id === i.productId), 'Produto')
  const diff = i.countedQty - p.qty
  if (diff === 0) return
  p.qty = i.countedQty
  d.stockMovements.push({
    id: ctx.id(), productId: p.id, type: 'adjust', qty: diff, unitCostCents: p.avgCostCents, at: ctx.now, saleId: null, note: i.note,
  })
  audit(d, ctx, 'estoque.ajuste', p.id, `diferenca=${diff}`)
}

export const isLowStock = (p: Product) => p.active && p.qty <= p.minQty

export interface StockTurnover {
  product: Product
  soldQty: number
  /** Quantas vezes o estoque girou no período. */
  turnover: number
  /** Dias até acabar no ritmo atual. null = sem venda no período. */
  coverDays: number | null
}

export function stockTurnover(s: DbState, today: DateKey, days = 30): StockTurnover[] {
  const from = addDays(today, -days + 1)
  return s.products
    .filter((p) => p.active)
    .map((product) => {
      const soldQty = s.stockMovements
        .filter((m) => m.productId === product.id && (m.type === 'sale' || m.type === 'refund'))
        .filter((m) => dateKey(m.at) >= from)
        .reduce((sum, m) => sum - m.qty, 0)
      const averageStock = (product.qty + product.qty + soldQty) / 2
      return {
        product,
        soldQty,
        turnover: averageStock > 0 ? soldQty / averageStock : 0,
        coverDays: soldQty > 0 ? Math.floor(product.qty / (soldQty / days)) : null,
      }
    })
    .sort((a, b) => b.soldQty - a.soldQty)
}
