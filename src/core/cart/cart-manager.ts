/**
 * CartManager — multi-sponsor cart state.
 *
 * Mirrors iOS's `CartManager` + `cartsBySponsor`. Holds local state in
 * memory and persists to localStorage. Reactive: dispatches a `change`
 * CustomEvent that UI components subscribe to (Web Components react via
 * `requestUpdate()`).
 *
 * The backend cart (Vio Commerce GraphQL CreateCart / AddItem / UpdateItem /
 * DeleteItem) is kept in sync optimistically from here; since 0.26 every add
 * and every increase tells it where the units come from (`origin`, ADR-0035
 * phase B) so the order is born attributed — see `origin-wire.ts`.
 */

import {
  formatPrice,
  getGlobalCountryCode,
  getGlobalCurrency,
  primaryImageUrl,
  type Product,
} from '../types.js'
import type { CartLineItem, CartLineOrigin, CartOrigin, SponsorCartState } from './types.js'
import { currentOriginPage, lineOriginWire } from './origin-wire.js'
import { componentKindOf } from '../slots.js'
import { CONTENT_TITLE_MAX_LENGTH, capContentUrl } from '../content.js'
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
  /** Where these units come from (`Vio.attribution(slot)`); see `CartOrigin`. */
  origin?: CartOrigin
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
  /** Where these units come from (`Vio.attribution(slot)`); see `CartOrigin`. */
  origin?: CartOrigin
}

/** One backend quantity sync for one line. See `CartManager.qtySyncs`. */
interface QtySync {
  /** Target quantity of the request currently in flight. */
  sent: number
  /** Latest target that arrived while in flight — the only one sent next. */
  pending?: number
  /** Where the units the in-flight request ADDS come from (an increase); nothing for a decrease. */
  origin?: CartOrigin
  /** The same, for `pending`. */
  pendingOrigin?: CartOrigin
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
  /** In-flight AddItem/UpdateItem/DeleteItem per sponsor. Callers that need
   * the backend cart to reflect a just-made change (e.g. fetching shippings
   * right after an add) should `await waitForCartMutations(sponsorId)` first
   * — otherwise they can race the mutation and see the cart from before it
   * landed (Alan, 2026-08-18: shippings queried before AddItem settled,
   * came back empty). */
  private inFlightMutations = new Map<number, Set<Promise<unknown>>>()
  /** Per-line quantity sync with the backend: at most ONE UpdateItem /
   * DeleteItem in flight per line. Targets that arrive while one is in flight
   * are coalesced into `pending` (only the latest survives) and sent when the
   * current request settles. Keyed by `${sponsorId}:${cartItemId}`.
   * (Alan, 2026-10-15: a burst of +/− clicks fired one UpdateItem per click
   * in parallel; each response re-applied the whole backend cart, so an
   * older one landing after a newer optimistic change rolled the line back.) */
  private qtySyncs = new Map<string, QtySync>()

  constructor() {
    super()
    this.cartsBySponsor = this.loadFromStorage()
  }

  private nextSeq(sponsorId: number): number {
    const n = (this.mutationSeq.get(sponsorId) ?? 0) + 1
    this.mutationSeq.set(sponsorId, n)
    return n
  }

  /** Resolves once every in-flight AddItem/UpdateItem/DeleteItem for this
   * sponsor has settled (success or failure), including ones started while
   * waiting (a quantity intent replayed by an AddItem reconcile). No-op if
   * nothing is pending. */
  async waitForCartMutations(sponsorId: number): Promise<void> {
    for (;;) {
      const set = this.inFlightMutations.get(sponsorId)
      if (!set || set.size === 0) return
      // The mutations catch their own failures; allSettled is belt and braces.
      await Promise.allSettled([...set])
    }
  }

  /**
   * True while an AddItem/UpdateItem/DeleteItem of this sponsor OTHER than
   * `except` has not settled. A mutation applying its own answer passes
   * itself: its response is current for what IT sent — only the others make
   * it stale.
   */
  private hasMutationsInFlight(sponsorId: number, except?: Promise<unknown>): boolean {
    const set = this.inFlightMutations.get(sponsorId)
    if (!set || set.size === 0) return false
    for (const m of set) if (m !== except) return true
    return false
  }

  /** Register a backend mutation so `waitForCartMutations` can await it. */
  private trackMutation(sponsorId: number, mutation: Promise<unknown>): void {
    let set = this.inFlightMutations.get(sponsorId)
    if (!set) {
      set = new Set()
      this.inFlightMutations.set(sponsorId, set)
    }
    const tracked = set
    tracked.add(mutation)
    const untrack = () => {
      tracked.delete(mutation)
      if (tracked.size === 0 && this.inFlightMutations.get(sponsorId) === tracked) {
        this.inFlightMutations.delete(sponsorId)
      }
    }
    mutation.then(untrack, untrack)
  }

  private qtySyncKey(sponsorId: number, cartItemId: string): string {
    return `${sponsorId}:${cartItemId}`
  }

  /** The quantity a line is heading to (pending beats in flight), or
   * undefined when no quantity sync is active for it. */
  private intendedQuantity(sponsorId: number, cartItemId: string): number | undefined {
    const sync = this.qtySyncs.get(this.qtySyncKey(sponsorId, cartItemId))
    return sync ? (sync.pending ?? sync.sent) : undefined
  }

  /** Apply a backend response only if no newer response was applied already.
   * Returns false when it was discarded as stale. */
  private applyBackendCart(
    sponsorId: number,
    backendCart: unknown,
    seq: number,
    settling?: Promise<unknown>,
  ): boolean {
    if (seq < (this.appliedSeq.get(sponsorId) ?? 0)) return false
    this.appliedSeq.set(sponsorId, seq)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.updateFromBackendCart(sponsorId, backendCart as any, { settling })
    return true
  }

  /** The final answer of a line's sync lost the per-sponsor seq race (another
   * line answered later): the cart as a whole is stale, but for THIS line it
   * is the latest word. Copy its quantity (and price) so a server-side clamp
   * — stock — doesn't leave the optimistic value behind for good, with the
   * checkout / Apple Pay total built on it. */
  private reconcileLineFromResponse(
    sponsorId: number,
    cartItemId: string,
    resCart: {
      line_items?: Array<{
        id: string
        quantity: number
        price?: { amount?: number; amount_incl_taxes?: number | null } | null
      }>
    },
    settling?: Promise<unknown>,
  ): void {
    const cart = this.cartsBySponsor.get(sponsorId)
    const line = cart?.items.find((i) => i.cartItemId === cartItemId || i.id === cartItemId)
    const server = resCart.line_items?.find((li) => li.id === cartItemId)
    if (!cart || !line || !server) return
    const price = server.price?.amount_incl_taxes ?? server.price?.amount
    let changed = false
    if (server.quantity !== line.quantity) {
      line.quantity = server.quantity
      if (!this.hasMutationsInFlight(sponsorId, settling)) {
        line.origins = reconciledOrigins(line.origins, server.quantity)
      }
      changed = true
    }
    if (price != null && price !== line.unitPrice) {
      line.unitPrice = price
      changed = true
    }
    if (!changed) return
    this.persist()
    this.emit()
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

  /**
   * Overwrite local cart state with the backend cart response (source of
   * truth). `opts.settling` is the mutation whose answer this is: it does not
   * count as "in flight" for the origins (see `hasMutationsInFlight`).
   */
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
    opts: { settling?: Promise<unknown> } = {},
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

    // Lines the shopper removed while their AddItem was still in flight: they
    // get their DeleteItem now that they have a backend id (see below).
    const removedBeforeSync: string[] = []
    if (Array.isArray(backendCart.line_items)) {
      const existingItems = cart.items || []
      if (backendCart.line_items.length === 0 && existingItems.length > 0) {
        // Backend says empty while we have optimistic local lines (add still
        // in flight) — keep the local view; a later sync will reconcile.
        this.persist()
        this.emit()
        return
      }
      cart.items = backendCart.line_items.flatMap((li): CartLineItem[] => {
        // A line whose quantity sync is still active keeps its optimistic
        // quantity: this response predates that intent. Heading to 0 means
        // the shopper already removed it — don't resurrect it for a frame.
        const intended = this.intendedQuantity(sponsorId, li.id)
        if (intended !== undefined && intended <= 0) return []
        // Removed locally before it had a backend id: the shopper saw it go
        // and vio:removed-from-cart already went out. Don't bring it back —
        // and don't replay the removal through updateQuantity (that emitted
        // the event a second time); just send the DeleteItem.
        const earlyKey = this.intentKey(li.product_id, li.variant_id)
        const earlyIntent = this.pendingQtyIntents.get(earlyKey)
        if (earlyIntent !== undefined && earlyIntent <= 0) {
          this.pendingQtyIntents.delete(earlyKey)
          removedBeforeSync.push(li.id)
          return []
        }
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

        const line: CartLineItem = {
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
          quantity: intended ?? li.quantity,
          // The server keeps its own copy of the origins (per request); the
          // cart read model does not answer them, so keep the local ones. They
          // are squared with its quantity (a stock clamp) only when no OTHER
          // mutation is in flight for this sponsor — an AddItem answering
          // while another is pending reports a quantity that is already old
          // (see `lineOrigins`).
          origins: matchedLocal
            ? this.hasMutationsInFlight(sponsorId, opts.settling)
              ? matchedLocal.origins
              : reconciledOrigins(matchedLocal.origins, intended ?? li.quantity)
            : undefined,
          shipping: li.shipping,
          availableShippings: li.available_shippings,
        }
        return [line]
      })
    }
    this.persist()
    this.emit()

    const syncedCartId = cart.cartId
    if (syncedCartId) {
      for (const id of removedBeforeSync) this.syncQuantity(sponsorId, syncedCartId, id, 0)
    }

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
      origin: opts.origin,
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
      addOriginQuantity(existing, opts.origin, qty)
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
        origins: [{ ...normalizeOrigin(opts.origin), quantity: qty }],
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
    // This mutation, for `applyBackendCart` to tell its own answer from the others'.
    let settling: Promise<unknown> | undefined
    const mutation = (async () => {
      try {
        const cartId = await this.ensureCartId(opts.sponsorId, opts.currency || undefined)
        if (cartId) {
          const gqlOpts = await getCartGraphQLOptions(opts.sponsorId)
          // Where these units come from, for the order (ADR-0035 phase B):
          // the add's own origin; nothing when the host gave none.
          const origin = opts.origin ? lineOriginWire(normalizeOrigin(opts.origin), currentOriginPage()) : undefined
          const lineItemsInput = [
            {
              product_id: Number(opts.productId || 0),
              quantity: qty,
              variant_id: opts.variantId != null ? Number(opts.variantId) : null,
              ...(origin ? { origin } : {}),
            },
          ]
          const resCart = await gqlAddItem(cartId, lineItemsInput, gqlOpts)
          if (resCart && Array.isArray(resCart.line_items)) {
            this.applyBackendCart(opts.sponsorId, resCart, seq, settling)
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
          // Off the origin whose add failed — not whatever was added last.
          removeFromOrigin(line, opts.origin, qty)
          if (line.quantity <= 0) c.items = c.items.filter((i) => i !== line)
          if (c.items.length === 0) this.cartsBySponsor.delete(opts.sponsorId)
          this.persist()
          this.emit()
        }
        this.emitError('AddItem rejected by the backend — item removed from the cart', err)
      }
    })()
    settling = mutation
    this.trackMutation(opts.sponsorId, mutation)

    return addedItem
  }

  /** Quantity intents for lines whose backend id hasn't arrived yet — replayed
   * when the AddItem response reconciles (keyed by product::variant). */
  private pendingQtyIntents = new Map<string, number>()

  private intentKey(productId: unknown, variantId: unknown): string {
    return `${normId(productId)}::${normId(variantId)}`
  }

  private findLine(sponsorId: number, lineItemId: string): CartLineItem | undefined {
    return this.cartsBySponsor
      .get(sponsorId)
      ?.items.find((i) => i.id === lineItemId || i.cartItemId === lineItemId)
  }

  /** Change a line's quantity by `delta`, computed on the manager's CURRENT
   * quantity — not on whatever a UI rendered a moment ago. A burst of +/−
   * clicks before a re-render therefore asks for 2, 3, 4… and not for the
   * same target several times. Reaching 0 removes the line. */
  adjustQuantity(
    lineItemId: string,
    sponsorId: number,
    delta: number,
    opts: { origin?: CartOrigin } = {},
  ): void {
    const item = this.findLine(sponsorId, lineItemId)
    if (!item) return
    this.updateQuantity(lineItemId, sponsorId, item.quantity + delta, opts)
  }

  /** Set a line's quantity (0 or less removes it). Optimistic: the local
   * state and `change` update at once; the backend is synced through
   * `syncQuantity`, one request in flight per line, latest target wins. */
  updateQuantity(
    lineItemId: string,
    sponsorId: number,
    quantity: number,
    opts: { origin?: CartOrigin } = {},
  ): void {
    const cart = this.cartsBySponsor.get(sponsorId)
    if (!cart) return
    const item = cart.items.find((i) => i.id === lineItemId || i.cartItemId === lineItemId)
    if (!item) return
    const target = quantity > 0 ? quantity : 0
    // Already there (or already heading there): nothing new to say or send.
    if (target === item.quantity) return
    const targetItemId = item.cartItemId
    // The origins follow the quantity: more units go to the given origin (or
    // the most recent one), fewer come off the most recent first.
    const removedOrigin = latestOrigin(item)
    const increase = target > item.quantity
    if (increase) addOriginQuantity(item, opts.origin, target - item.quantity)
    else removeOriginQuantity(item, item.quantity - target)
    // The origin the new units were credited to (the given one, else the most
    // recent) goes to the server with the increase; a decrease names none.
    const addedOrigin = increase ? latestOrigin(item) : undefined
    if (target <= 0) {
      cart.items = cart.items.filter((i) => i !== item)
      // Choke point de la baja: sale acá y no en la UI para que también
      // cuente cuando el host llama removeItem() por API.
      if (typeof document !== 'undefined') {
        document.dispatchEvent(
          new CustomEvent('vio:removed-from-cart', {
            bubbles: true,
            detail: {
              productId: item.productId,
              variantId: item.variantId,
              name: item.name,
              brand: item.brand,
              price: item.unitPrice,
              quantity: item.quantity,
              currency: item.currency,
              sponsorId,
              // Attribution of the removed units: their most recent origin.
              slot: removedOrigin?.slot,
              campaignId: removedOrigin?.campaignId,
              contentId: removedOrigin?.contentId,
            },
          }),
        )
      }
    } else {
      item.quantity = target
    }
    if (cart.items.length === 0) this.cartsBySponsor.delete(sponsorId)
    this.persist()
    this.emit()

    if (!cart.cartId) return

    // The line hasn't been assigned its backend id yet (AddItem in flight):
    // sending the local id would 404. Record the intent — it's replayed as
    // soon as the reconcile lands.
    if (!targetItemId) {
      this.pendingQtyIntents.set(this.intentKey(item.productId, item.variantId), target)
      return
    }

    this.syncQuantity(sponsorId, cart.cartId, targetItemId, target, addedOrigin)
  }

  /** Send a line's target quantity to the backend — ONE request in flight per
   * line. A target that arrives while one is in flight replaces any earlier
   * waiting one and goes out when the current request settles, so the server
   * ends on the last intent and never sees two updates racing each other.
   * While the sync is active the line keeps its optimistic quantity through
   * any backend response (see `updateFromBackendCart`); a rejection drops
   * what was queued and reconciles the cart from the server. */
  private syncQuantity(
    sponsorId: number,
    backendCartId: string,
    cartItemId: string,
    target: number,
    origin?: CartOrigin,
  ): void {
    const key = this.qtySyncKey(sponsorId, cartItemId)
    const active = this.qtySyncs.get(key)
    if (active) {
      active.pending = target
      active.pendingOrigin = origin
      return
    }
    const sync: QtySync = { sent: target, origin }
    this.qtySyncs.set(key, sync)

    // This mutation, for `applyBackendCart` to tell its own answer from the others'.
    let settling: Promise<unknown> | undefined
    const run = (async () => {
      let next: number | undefined = target
      let nextOrigin: CartOrigin | undefined = origin
      let removalRetried = false
      while (next !== undefined) {
        sync.sent = next
        sync.origin = nextOrigin
        sync.pending = undefined
        sync.pendingOrigin = undefined
        const seq = this.nextSeq(sponsorId)
        try {
          const gqlOpts = await getCartGraphQLOptions(sponsorId)
          // The origin of the units this update adds (ADR-0035 phase B) —
          // when it was an increase and the SDK knows a place for them.
          const originWire = next > 0 && nextOrigin ? lineOriginWire(nextOrigin, currentOriginPage()) : undefined
          const resCart =
            next <= 0
              ? await gqlDeleteItem(backendCartId, cartItemId, gqlOpts)
              : originWire
                ? await gqlUpdateItem(backendCartId, cartItemId, null, next, gqlOpts, { origin: originWire })
                : await gqlUpdateItem(backendCartId, cartItemId, null, next, gqlOpts)
          next = sync.pending
          nextOrigin = sync.pendingOrigin
          // Back where the server already is (+, +, − while in flight):
          // nothing to send.
          if (next === sync.sent) next = undefined
          // Nothing newer queued: the server's view of this line is the truth
          // now. With a newer target queued the entry stays, so this (already
          // stale) response cannot roll the line back.
          if (next === undefined) this.qtySyncs.delete(key)
          if (resCart && Array.isArray(resCart.line_items)) {
            const applied = this.applyBackendCart(sponsorId, resCart, seq, settling)
            if (!applied && next === undefined) {
              this.reconcileLineFromResponse(sponsorId, cartItemId, resCart, settling)
            }
          }
        } catch (err) {
          // Rejected: whatever was queued is moot — the server decides — with
          // one exception. A queued REMOVAL already happened for the shopper
          // (the line is gone, vio:removed-from-cart went out), so it is sent
          // once more, once, instead of letting the reconcile bring the line
          // back without a DeleteItem ever going out.
          const retryRemoval = !removalRetried && sync.pending !== undefined && sync.pending <= 0
          next = undefined
          nextOrigin = undefined
          if (retryRemoval) {
            removalRetried = true
            // Entry stays (heading to 0): the reconcile below leaves the line out.
            sync.sent = 0
            sync.origin = undefined
            sync.pending = undefined
            sync.pendingOrigin = undefined
            next = 0
          } else {
            this.qtySyncs.delete(key)
          }
          // The reconcile emits `change`.
          this.emitError('Update/DeleteItem failed — cart re-synced from backend', err)
          try {
            await this.fetchCartFromBackend(sponsorId)
          } catch (fetchErr) {
            this.emitError('cart re-sync after a rejected Update/DeleteItem failed', fetchErr)
          }
        }
      }
    })()
    settling = run
    this.trackMutation(sponsorId, run)
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

// ── Origins (where each unit of a line came from) ───────────────────────────

/**
 * Only the attribution fields, trimmed; `{}` when nothing is known. The kind
 * of element is kept as Commerce and the collector name it (`card`,
 * `carousel`, `detail` — `componentKindOf`), from `componentKind` or from
 * the `componentTemplateId` an element's attribution carries (`product-card`);
 * the page (`contentUrl`, `contentTitle`) within Commerce's caps.
 */
export function normalizeOrigin(origin: CartOrigin | null | undefined): CartOrigin {
  const out: CartOrigin = {}
  if (!origin || typeof origin !== 'object') return out
  const campaignId = Number(origin.campaignId)
  if (origin.campaignId !== undefined && origin.campaignId !== null && Number.isFinite(campaignId)) {
    out.campaignId = campaignId
  }
  if (typeof origin.slot === 'string' && origin.slot.trim()) out.slot = origin.slot.trim()
  if (origin.contentId !== undefined && origin.contentId !== null && String(origin.contentId).trim()) {
    out.contentId = String(origin.contentId).trim()
  }
  const kind = componentKindOf(origin.componentKind ?? (origin as { componentTemplateId?: unknown }).componentTemplateId)
  if (kind) out.componentKind = kind
  const contentUrl = capContentUrl(origin.contentUrl)
  if (contentUrl) out.contentUrl = contentUrl
  if (typeof origin.contentTitle === 'string' && origin.contentTitle.trim()) {
    out.contentTitle = origin.contentTitle.trim().slice(0, CONTENT_TITLE_MAX_LENGTH)
  }
  return out
}

/** Two origins are the same place when campaign, slot, content and kind of element all match (the page's URL and title are attributes of the place, not its identity). */
export function sameOrigin(a: CartOrigin, b: CartOrigin): boolean {
  return (
    a.campaignId === b.campaignId &&
    a.slot === b.slot &&
    a.contentId === b.contentId &&
    a.componentKind === b.componentKind
  )
}

/** The most recent origin of a line, or undefined. */
export function latestOrigin(line: Pick<CartLineItem, 'origins'>): CartLineOrigin | undefined {
  const origins = Array.isArray(line.origins) ? line.origins : []
  return origins[origins.length - 1]
}

/**
 * `qty` more units from `origin`: added to the matching origin when there is
 * one (moved to the end, as the most recent), else to a new one. Without an
 * origin they go to the most recent origin — or to an empty `{}` one.
 */
export function addOriginQuantity(
  line: Pick<CartLineItem, 'origins'>,
  origin: CartOrigin | null | undefined,
  qty: number,
): void {
  if (!(qty > 0)) return
  const origins = Array.isArray(line.origins) ? line.origins : []
  const target: CartOrigin | undefined = origin ? normalizeOrigin(origin) : latestOrigin({ origins })
  const index = target ? origins.findIndex((o) => sameOrigin(o, target)) : -1
  if (index >= 0) {
    const [found] = origins.splice(index, 1)
    found!.quantity += qty
    origins.push(found!)
  } else {
    origins.push({ ...(target ?? {}), quantity: qty })
  }
  line.origins = origins
}

/**
 * `qty` fewer units off a given origin first (a rejected add is reverted from
 * the origin that failed), then off the most recent ones.
 */
export function removeFromOrigin(
  line: Pick<CartLineItem, 'origins'>,
  origin: CartOrigin | null | undefined,
  qty: number,
): void {
  if (!(qty > 0) || !Array.isArray(line.origins)) return
  let left = qty
  if (origin) {
    const target = normalizeOrigin(origin)
    const index = line.origins.findIndex((o) => sameOrigin(o, target))
    if (index >= 0) {
      const found = line.origins[index]!
      const take = Math.min(found.quantity, left)
      found.quantity -= take
      left -= take
      if (found.quantity <= 0) line.origins.splice(index, 1)
    }
  }
  if (left > 0) removeOriginQuantity(line, left)
}

/** `qty` fewer units: off the most recent origins first. */
export function removeOriginQuantity(line: Pick<CartLineItem, 'origins'>, qty: number): void {
  if (!(qty > 0) || !Array.isArray(line.origins)) return
  let left = qty
  const origins = line.origins
  while (left > 0 && origins.length > 0) {
    const last = origins[origins.length - 1]!
    const take = Math.min(last.quantity, left)
    last.quantity -= take
    left -= take
    if (last.quantity <= 0) origins.pop()
  }
}

/** Origins squared with a quantity the server answered (stock clamps, re-syncs). */
export function reconciledOrigins(
  origins: CartLineOrigin[] | undefined,
  quantity: number,
): CartLineOrigin[] | undefined {
  if (!Array.isArray(origins)) return undefined
  const copy = origins.map((o) => ({ ...o }))
  const total = copy.reduce((sum, o) => sum + (o.quantity > 0 ? o.quantity : 0), 0)
  const line = { origins: copy }
  if (quantity > total) addOriginQuantity(line, undefined, quantity - total)
  else if (quantity < total) removeOriginQuantity(line, total - quantity)
  return line.origins
}

/**
 * The origins of a line for reporting: what it carries, plus an empty origin
 * for any units it does not account for (a cart persisted before origins
 * existed, a server-side bump). Their quantities add up to the line's.
 */
export function lineOrigins(line: Pick<CartLineItem, 'origins' | 'quantity'>): CartLineOrigin[] {
  const known = (Array.isArray(line.origins) ? line.origins : []).filter((o) => o && o.quantity > 0)
  const total = known.reduce((sum, o) => sum + o.quantity, 0)
  const quantity = line.quantity > 0 ? line.quantity : 0
  if (total === quantity) return known.map((o) => ({ ...o }))
  if (total < quantity) return [...known.map((o) => ({ ...o })), { quantity: quantity - total }]
  // More units remembered than the line has (a server clamp while an add was
  // in flight): report the line's quantity, trimming the most recent first —
  // on a copy, the line's own origins are not touched.
  const copy = { origins: known.map((o) => ({ ...o })) }
  removeOriginQuantity(copy, total - quantity)
  return copy.origins
}
