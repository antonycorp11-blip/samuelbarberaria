import { audit, must, requireOwner, type Command } from './engine'
import { fail } from './errors'
import { addDays, dateKey } from './time'
import type { Cents, DateKey, DbState, ID, PaymentMethod, Product } from './types'

export function weightedAverage(qty: number, avg: Cents, addQty: number, addCost: Cents): Cents {
  const total = qty + addQty
  return total > 0 ? Math.round((qty * avg + addQty * addCost) / total) : addCost
}

export const upsertProduct: Command<
  { id?: ID; name: string; salePriceCents: Cents; minQty: number; active?: boolean },
  ID
> = (d, i, ctx) => {
  requireOwner(ctx)
  if (!i.name.trim()) fail('bad_name', 'Informe o nome do produto.')
  if (i.salePriceCents < 0 || i.minQty < 0) fail('bad_value', 'Valores não podem ser negativos.')
  const current = i.id ? must(d.products.find((p) => p.id === i.id), 'Produto') : null
  if (current) {
    current.name = i.name.trim()
    current.salePriceCents = i.salePriceCents
    current.minQty = i.minQty
    current.active = i.active ?? current.active
    return current.id
  }
  const id = ctx.id()
  d.products.push({
    id, name: i.name.trim(), salePriceCents: i.salePriceCents, minQty: i.minQty, avgCostCents: 0, qty: 0, active: true,
  })
  return id
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
