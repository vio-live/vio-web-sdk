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

import {
  formatPrice,
  getGlobalCountryCode,
  getGlobalCurrency,
  primaryImageUrl,
  type Product,
} from '../types.js'
import type { CartLineItem, SponsorCartState } from './types.js'
import {
  addItem as gqlAddItem,
  createCart as gqlCreateCart,
  deleteItem as gqlDeleteItem,
  getCart as gqlGetCart,
  getCartGraphQLOptions,
  getCustomerSessionId,
  getLineItemsBySupplier as gqlGetLineItemsBySupplier,
  updateItem as gqlUpdateItem,
  updateShippingsBySupplier as gqlUpdateShippingsBySupplier,
} from '../api/cart-queries.js'

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

/** Normalise an id-ish value for matching: null/0/'null' → '' (no id). */
function normId(val: unknown): string {
  if (val === null || val === undefined || val === 0 || val === '0' || val === 'null' || val === 'undefined') {
    return ''
  }
  return String(val).trim()
}

export class CartManager extends EventTarget {
  private cartsBySponsor: Map<number, SponsorCartState>
  /** In-flight CreateCart per sponsor — two quick adds must share ONE backend
   * cart (two CreateCarts split the items and one silently disappears). */
  private cartIdPromises = new Map<number, Promise<string | undefined>>()
  /** Monotonic mutation counter per sponsor + last applied response, so a
   * slow response can't overwrite the state of a newer one. */
  private mutationSeq = new Map<number, number>()
  private appliedSeq = new Map<number, number>()

  constructor() {
    super()
    this.cartsBySponsor = this.loadFromStorage()
  }

  private nextSeq(sponsorId: number): number {
    const n = (this.mutationSeq.get(sponsorId) ?? 0) + 1
    this.mutationSeq.set(sponsorId, n)
    return n
  }

  /** Apply a backend response only if no newer response was applied already. */
  private applyBackendCart(sponsorId: number, backendCart: unknown, seq: number): void {
    if (seq < (this.appliedSeq.get(sponsorId) ?? 0)) return
    this.appliedSeq.set(sponsorId, seq)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.updateFromBackendCart(sponsorId, backendCart as any)
  }

  /** Surface a cart sync problem to hosts/UI (and the console). */
  private emitError(message: string, err?: unknown): void {
    if (typeof console !== 'undefined') console.warn('[CartManager]', message, err ?? '')
    this.dispatchEvent(new CustomEvent('error', { detail: { message } }))
    if (typeof document !== 'undefined') {
      document.dispatchEvent(
        new CustomEvent('vio:cart-error', { bubbles: true, detail: { message } }),
      )
    }
  }

  // MARK: - Backend cart sync (Vio Commerce GraphQL)

  /** Ensure the sponsor cart exists server-side; returns its backend cart id. */
  async ensureCartId(
    sponsorId: number,
    currency?: string,
    shippingCountry?: string,
  ): Promise<string | undefined> {
    const activeCurrency = currency || getGlobalCurrency()
    const activeCountry = shippingCountry || getGlobalCountryCode()
    let cart = this.cartsBySponsor.get(sponsorId)
    if (!cart) {
      cart = { sponsorId, items: [], currency: activeCurrency, shippingCountry: activeCountry }
      this.cartsBySponsor.set(sponsorId, cart)
    } else {
      cart.shippingCountry = activeCountry
    }
    if (cart.cartId) return cart.cartId

    // Dedupe: concurrent callers share ONE CreateCart per sponsor.
    const inFlight = this.cartIdPromises.get(sponsorId)
    if (inFlight) return inFlight

    const creation = (async (): Promise<string | undefined> => {
      const opts = await getCartGraphQLOptions(sponsorId)
      // Never create a backend cart with the wrong key — a cart signed with
      // the host apiKey is orphaned once the sponsor key resolves later.
      if (!opts.sponsorResolved) {
        this.emitError(`no commerce key resolved for sponsor ${sponsorId} — cart not synced`)
        return undefined
      }
      const customerSessionId = getCustomerSessionId()
      try {
        const backendCart = await gqlCreateCart(
          customerSessionId,
          activeCurrency,
          activeCountry,
          opts,
        )
        if (backendCart?.cart_id) {
          cart.cartId = backendCart.cart_id
          if (Array.isArray(backendCart.line_items) && backendCart.line_items.length > 0) {
            this.updateFromBackendCart(sponsorId, backendCart)
          } else {
            // Fresh backend cart (no lines yet) — adopt the meta only. Calling
            // updateFromBackendCart here would wipe the optimistic local items.
            if (backendCart.currency) cart.currency = backendCart.currency
            if (backendCart.shipping_country) cart.shippingCountry = backendCart.shipping_country
            if (backendCart.subtotal != null) cart.subtotal = backendCart.subtotal
            if (backendCart.shipping != null) cart.shipping = backendCart.shipping
            if (backendCart.available_shipping_countries) {
              cart.availableShippingCountries = backendCart.available_shipping_countries
            }
            this.persist()
            this.emit()
          }
        }
      } catch (err) {
        this.emitError('createCart failed', err)
      }
      return cart.cartId
    })().finally(() => {
      this.cartIdPromises.delete(sponsorId)
    })

    this.cartIdPromises.set(sponsorId, creation)
    return creation
  }

  /** Overwrite local cart state with the backend cart response (source of truth). */
  updateFromBackendCart(
    sponsorId: number,
    backendCart: {
      cart_id?: string
      currency?: string
      shipping_country?: string
      subtotal?: number
      shipping?: number
      available_shipping_countries?: string[]
      line_items?: Array<{
        id: string
        product_id: number
        variant_id?: number | string | null
        variant_title?: string | null
        brand?: string | null
        title?: string | null
        quantity: number
        image?: string | { url?: string } | null
        imageUrl?: string | null
        image_url?: string | null
        price?: {
          amount?: number
          amount_incl_taxes?: number | null
          currency_code?: string
        } | null
        shipping?: unknown
        available_shippings?: unknown[]
      }>
    },
  ): void {
    const cart = this.cartsBySponsor.get(sponsorId)
    if (!cart) return
    if (backendCart.cart_id) cart.cartId = backendCart.cart_id
    if (backendCart.currency) cart.currency = backendCart.currency
    if (backendCart.shipping_country) cart.shippingCountry = backendCart.shipping_country
    if (backendCart.subtotal != null) cart.subtotal = backendCart.subtotal
    if (backendCart.shipping != null) cart.shipping = backendCart.shipping
    if (backendCart.available_shipping_countries) {
      cart.availableShippingCountries = backendCart.available_shipping_countries
    }

    if (Array.isArray(backendCart.line_items)) {
      const existingItems = cart.items || []
      if (backendCart.line_items.length === 0 && existingItems.length > 0) {
        // Backend says empty while we have optimistic local lines (add still
        // in flight) — keep the local view; a later sync will reconcile.
        this.persist()
        this.emit()
        return
      }
      cart.items = backendCart.line_items.map((li): CartLineItem => {
        const urlFromBackend =
          (typeof li.image === 'string' ? li.image : li.image?.url) ||
          li.imageUrl ||
          li.image_url ||
          ''
        // Match the backend line to a local one to preserve display fields the
        // backend may omit (image, brand, name, price).
        const matchedLocal = existingItems.find((existing) => {
          const p1 = normId(existing.productId)
          const p2 = normId(li.product_id)
          const v1 = normId(existing.variantId)
          const v2 = normId(li.variant_id)
          if (p1 && p2 && p1 === p2 && v1 === v2) return true
          if (v1 && v2 && v1 === v2) return true
          if (p1 && p2 && p1 === p2 && !v1 && !v2) return true
          const n1 = (existing.name || '').trim().toLowerCase()
          const n2 = (li.title || '').trim().toLowerCase()
          if (n1 && n2 && n1 === n2 && v1 === v2) return true
          return false
        })
        const imageUrl = urlFromBackend || matchedLocal?.imageUrl || ''

        return {
          id: li.id,
          cartItemId: li.id,
          productId: li.product_id,
          sponsorId,
          variantId: li.variant_id != null ? Number(li.variant_id) : undefined,
          brand: li.brand || matchedLocal?.brand || '',
          name: li.title
            ? li.variant_title
              ? `${li.title} — ${li.variant_title}`
              : li.title
            : matchedLocal?.name || '',
          unitPrice: li.price?.amount_incl_taxes ?? li.price?.amount ?? matchedLocal?.unitPrice ?? 0,
          currency: li.price?.currency_code || backendCart.currency || matchedLocal?.currency || 'NOK',
          imageUrl,
          quantity: li.quantity,
          shipping: li.shipping,
          availableShippings: li.available_shippings,
        }
      })
    }
    this.persist()
    this.emit()

    // Replay quantity intents recorded while the line had no backend id yet.
    if (this.pendingQtyIntents.size > 0) {
      const currentCart = this.cartsBySponsor.get(sponsorId)
      for (const [key, qty] of [...this.pendingQtyIntents]) {
        const line = currentCart?.items.find(
          (i) => this.intentKey(i.productId, i.variantId) === key && i.cartItemId,
        )
        if (line) {
          this.pendingQtyIntents.delete(key)
          if (line.quantity !== qty) {
            this.updateQuantity(line.cartItemId!, sponsorId, qty)
          }
        }
      }
    }
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
    // Tax-inclusive is the consumer-facing price; `amount` is the fallback.
    const unitPrice = price.amount_incl_taxes ?? price.amount ?? 0
    const imageUrl = variant?.images?.[0]?.url || primaryImageUrl(opts.product) || ''
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

    // Robust dedupe: backend-synced lines may carry ids as strings / omit
    // fields, so match on normalised product+variant ids with a name fallback.
    const existing = cart.items.find((i) => {
      const p1 = normId(i.productId)
      const p2 = normId(opts.productId)
      const v1 = normId(i.variantId)
      const v2 = normId(opts.variantId)
      if (p1 && p2 && p1 === p2 && v1 === v2) return true
      if (v1 && v2 && v1 === v2) return true
      if (p1 && p2 && p1 === p2 && !v1 && !v2) return true
      const n1 = (i.name || '').trim().toLowerCase()
      const n2 = (opts.name || '').trim().toLowerCase()
      if (n1 && n2 && n1 === n2 && v1 === v2) return true
      return false
    })
    if (existing) {
      existing.quantity += qty
    } else {
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
    }
    this.persist()
    this.emit()

    const addedItem = existing ?? cart.items[cart.items.length - 1]!
    const addedLineId = addedItem.id

    // Async sync with the backend cart. Optimistic — but a REJECTED AddItem
    // reverts the local line (a ghost line means the UI total and the charged
    // total diverge silently).
    const seq = this.nextSeq(opts.sponsorId)
    void (async () => {
      try {
        const cartId = await this.ensureCartId(opts.sponsorId, opts.currency || undefined)
        if (cartId) {
          const gqlOpts = await getCartGraphQLOptions(opts.sponsorId)
          const lineItemsInput = [
            {
              product_id: Number(opts.productId || 0),
              quantity: qty,
              variant_id: opts.variantId != null ? Number(opts.variantId) : null,
            },
          ]
          const resCart = await gqlAddItem(cartId, lineItemsInput, gqlOpts)
          if (resCart && Array.isArray(resCart.line_items)) {
            this.applyBackendCart(opts.sponsorId, resCart, seq)
          }
        }
        // No cartId (no commerce key): the cart stays local-only; checkout is
        // blocked upstream, so no ghost-charge risk.
      } catch (err) {
        // Revert the optimistic add — subtract what THIS add contributed.
        const c = this.cartsBySponsor.get(opts.sponsorId)
        const line = c?.items.find((i) => i.id === addedLineId)
        if (c && line) {
          line.quantity -= qty
          if (line.quantity <= 0) c.items = c.items.filter((i) => i !== line)
          if (c.items.length === 0) this.cartsBySponsor.delete(opts.sponsorId)
          this.persist()
          this.emit()
        }
        this.emitError('AddItem rejected by the backend — item removed from the cart', err)
      }
    })()

    return addedItem
  }

  /** Quantity intents for lines whose backend id hasn't arrived yet — replayed
   * when the AddItem response reconciles (keyed by product::variant). */
  private pendingQtyIntents = new Map<string, number>()

  private intentKey(productId: unknown, variantId: unknown): string {
    return `${normId(productId)}::${normId(variantId)}`
  }

  updateQuantity(lineItemId: string, sponsorId: number, quantity: number): void {
    const cart = this.cartsBySponsor.get(sponsorId)
    if (!cart) return
    const item = cart.items.find((i) => i.id === lineItemId || i.cartItemId === lineItemId)
    if (!item) return
    const targetItemId = item.cartItemId
    if (quantity <= 0) {
      cart.items = cart.items.filter((i) => i !== item)
    } else {
      item.quantity = quantity
    }
    if (cart.items.length === 0) this.cartsBySponsor.delete(sponsorId)
    this.persist()
    this.emit()

    if (!cart.cartId) return

    // The line hasn't been assigned its backend id yet (AddItem in flight):
    // sending the local id would 404. Record the intent — it's replayed as
    // soon as the reconcile lands.
    if (!targetItemId) {
      this.pendingQtyIntents.set(this.intentKey(item.productId, item.variantId), quantity)
      return
    }

    const backendCartId = cart.cartId
    const seq = this.nextSeq(sponsorId)
    void (async () => {
      try {
        const gqlOpts = await getCartGraphQLOptions(sponsorId)
        const resCart =
          quantity <= 0
            ? await gqlDeleteItem(backendCartId, targetItemId, gqlOpts)
            : await gqlUpdateItem(backendCartId, targetItemId, null, quantity, gqlOpts)
        if (resCart && Array.isArray(resCart.line_items)) {
          this.applyBackendCart(sponsorId, resCart, seq)
        }
      } catch (err) {
        this.emitError('Update/DeleteItem failed — cart re-synced from backend', err)
        void this.fetchCartFromBackend(sponsorId)
      }
    })()
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

  /** Refresh the local cart from the backend (source of truth). */
  async fetchCartFromBackend(sponsorId: number): Promise<unknown> {
    const cart = this.cartsBySponsor.get(sponsorId)
    if (!cart?.cartId) return null
    const gqlOpts = await getCartGraphQLOptions(sponsorId)
    const resCart = await gqlGetCart(cart.cartId, gqlOpts)
    if (resCart) this.updateFromBackendCart(sponsorId, resCart)
    return resCart
  }

  /** Line items grouped by supplier (shipping is per-supplier server-side). */
  async fetchLineItemsBySupplier(sponsorId: number): Promise<unknown> {
    const cart = this.cartsBySponsor.get(sponsorId)
    if (!cart?.cartId) return null
    const gqlOpts = await getCartGraphQLOptions(sponsorId)
    return gqlGetLineItemsBySupplier(cart.cartId, gqlOpts)
  }

  /** Set the chosen shipping option per supplier on the backend cart. */
  async updateShippingsBySupplier(
    sponsorId: number,
    data: Array<{ shipping_id: string; supplier_id: number }>,
  ): Promise<unknown> {
    const cart = this.cartsBySponsor.get(sponsorId)
    if (!cart?.cartId) return null
    const gqlOpts = await getCartGraphQLOptions(sponsorId)
    const resCart = await gqlUpdateShippingsBySupplier(cart.cartId, data, gqlOpts)
    if (resCart && Array.isArray(resCart.line_items)) {
      this.updateFromBackendCart(sponsorId, resCart)
    }
    return resCart
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
