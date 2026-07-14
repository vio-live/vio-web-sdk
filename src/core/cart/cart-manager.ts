/**
 * CartManager — multi-sponsor cart state.
 *
 * Mirrors iOS's `CartManager` + `cartsBySponsor`. Holds local state in
 * memory and persists to localStorage. Reactive: dispatches a `change`
 * CustomEvent that UI components subscribe to (Web Components react via
 * `requestUpdate()`).
 *
 * Server-side cart sync (Vio Commerce GraphQL CreateCart / AddToCart
 * mutations) is deferred to checkout time via the CheckoutManager —
 * this manager is purely client-side state for now.
 */

import { formatPrice, primaryImageUrl, type Product } from '../types.js'
import type { CartLineItem, SponsorCartState } from './types.js'

const STORAGE_KEY = 'vio.cart.v1'

export interface CartChangeDetail {
  cartsBySponsor: Map<number, SponsorCartState>
  itemCount: number
}

export interface AddProductOptions {
  product: Product
  sponsorId: number
  sponsorName?: string
  quantity?: number
  variantId?: number
}

/** Minimal product shape — for callers who only have e.g. mock data, not a full Product. */
export interface AddManualOptions {
  productId: number
  sponsorId: number
  sponsorName?: string
  brand: string
  name: string
  unitPrice: number
  currency: string
  imageUrl: string
  quantity?: number
  variantId?: number
}

function lineId(): string {
  return 'li_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export class CartManager extends EventTarget {
  private cartsBySponsor: Map<number, SponsorCartState>

  constructor() {
    super()
    this.cartsBySponsor = this.loadFromStorage()
  }

  // MARK: - Mutations

  /** Add a Product DTO to a sponsor's cart. Bumps quantity if already present.
   * When a variantId is given, the line uses the VARIANT's price / image / title
   * (not the product base), so different combinations are priced correctly. */
  addProduct(opts: AddProductOptions): CartLineItem {
    const variant =
      opts.variantId != null
        ? opts.product.variants?.find((v) => v.id === opts.variantId)
        : undefined
    const price = variant?.price ?? opts.product.price
    // Prefer `amount` (matches the catalog / detail display); some feeds ship a
    // broken `amount_incl_taxes`.
    const unitPrice = price.amount ?? price.amount_incl_taxes ?? 0
    const imageUrl = variant?.images?.[0]?.url ?? primaryImageUrl(opts.product) ?? ''
    const name = variant?.title
      ? `${opts.product.title} — ${variant.title}`
      : opts.product.title
    return this.addManual({
      productId: opts.product.id,
      sponsorId: opts.sponsorId,
      sponsorName: opts.sponsorName,
      brand: opts.product.brand ?? '',
      name,
      unitPrice,
      currency: price.currency_code,
      imageUrl,
      quantity: opts.quantity,
      variantId: opts.variantId,
    })
  }

  /** Add a manually-specified line item (no Product DTO). */
  addManual(opts: AddManualOptions): CartLineItem {
    const qty = Math.max(1, opts.quantity ?? 1)
    let cart = this.cartsBySponsor.get(opts.sponsorId)
    if (!cart) {
      cart = {
        sponsorId: opts.sponsorId,
        sponsorName: opts.sponsorName,
        items: [],
        currency: opts.currency,
      }
      this.cartsBySponsor.set(opts.sponsorId, cart)
    } else if (opts.sponsorName && !cart.sponsorName) {
      cart.sponsorName = opts.sponsorName
    }

    const existing = cart.items.find(
      (i) => i.productId === opts.productId && i.variantId === opts.variantId,
    )
    if (existing) {
      existing.quantity += qty
      this.persist()
      this.emit()
      return existing
    }

    const item: CartLineItem = {
      id: lineId(),
      productId: opts.productId,
      sponsorId: opts.sponsorId,
      variantId: opts.variantId,
      brand: opts.brand,
      name: opts.name,
      unitPrice: opts.unitPrice,
      currency: opts.currency,
      imageUrl: opts.imageUrl,
      quantity: qty,
    }
    cart.items.push(item)
    this.persist()
    this.emit()
    return item
  }

  updateQuantity(lineItemId: string, sponsorId: number, quantity: number): void {
    const cart = this.cartsBySponsor.get(sponsorId)
    if (!cart) return
    const item = cart.items.find((i) => i.id === lineItemId)
    if (!item) return
    if (quantity <= 0) {
      cart.items = cart.items.filter((i) => i.id !== lineItemId)
    } else {
      item.quantity = quantity
    }
    if (cart.items.length === 0) this.cartsBySponsor.delete(sponsorId)
    this.persist()
    this.emit()
  }

  removeItem(lineItemId: string, sponsorId: number): void {
    this.updateQuantity(lineItemId, sponsorId, 0)
  }

  clearSponsorCart(sponsorId: number): void {
    if (this.cartsBySponsor.delete(sponsorId)) {
      this.persist()
      this.emit()
    }
  }

  clearAllCarts(): void {
    if (this.cartsBySponsor.size === 0) return
    this.cartsBySponsor.clear()
    this.persist()
    this.emit()
  }

  // MARK: - Read accessors

  getAllCarts(): Map<number, SponsorCartState> {
    return new Map(this.cartsBySponsor)
  }

  getCart(sponsorId: number): SponsorCartState | undefined {
    return this.cartsBySponsor.get(sponsorId)
  }

  get itemCount(): number {
    let count = 0
    for (const cart of this.cartsBySponsor.values()) {
      for (const item of cart.items) count += item.quantity
    }
    return count
  }

  subtotalForSponsor(sponsorId: number): number {
    const cart = this.cartsBySponsor.get(sponsorId)
    if (!cart) return 0
    return cart.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0)
  }

  get totalAcrossSponsors(): number {
    let sum = 0
    for (const cart of this.cartsBySponsor.values()) {
      for (const item of cart.items) sum += item.unitPrice * item.quantity
    }
    return sum
  }

  get primaryCurrency(): string {
    for (const cart of this.cartsBySponsor.values()) return cart.currency
    return 'NOK'
  }

  formatTotal(): string {
    return formatPrice(this.totalAcrossSponsors, this.primaryCurrency)
  }

  // MARK: - Persistence

  private persist(): void {
    if (typeof localStorage === 'undefined') return
    try {
      const obj: Record<string, SponsorCartState> = {}
      for (const [k, v] of this.cartsBySponsor) obj[String(k)] = v
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
    } catch {
      // Ignore quota / privacy errors.
    }
  }

  private loadFromStorage(): Map<number, SponsorCartState> {
    if (typeof localStorage === 'undefined') return new Map()
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return new Map()
      const obj = JSON.parse(raw) as Record<string, SponsorCartState>
      const map = new Map<number, SponsorCartState>()
      for (const [k, v] of Object.entries(obj)) {
        const id = parseInt(k, 10)
        if (!Number.isNaN(id) && v && Array.isArray(v.items)) map.set(id, v)
      }
      return map
    } catch {
      return new Map()
    }
  }

  private emit(): void {
    const detail: CartChangeDetail = {
      cartsBySponsor: this.getAllCarts(),
      itemCount: this.itemCount,
    }
    this.dispatchEvent(new CustomEvent<CartChangeDetail>('change', { detail }))
  }
}
