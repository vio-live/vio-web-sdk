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

import { storageGet, storageRemove, storageSet } from '../safe-storage.js'
import {
  formatPrice,
  getGlobalCountryCode,
  getGlobalCurrency,
  primaryImageUrl,
  type Product,
} from '../types.js'
import type { CartGift, CartLineItem, CartLineOrigin, CartOrigin, SponsorCartState } from './types.js'
import { currentOriginPage, currentPrivacyMode, lineOriginWire } from './origin-wire.js'
import { componentKindOf } from '../slots.js'
import { CONTENT_TITLE_MAX_LENGTH, originAndPath } from '../content.js'
import { normalizeLayoutOrigin } from '../detail-layout.js'
import {
  addItem as gqlAddItem,
  applyCampaignDiscount as gqlApplyCampaignDiscount,
  applyDiscount as gqlApplyDiscount,
  createCart as gqlCreateCart,
  deleteAppliedDiscount as gqlDeleteAppliedDiscount,
  deleteCartDiscount as gqlDeleteCartDiscount,
  deleteItem as gqlDeleteItem,
  getCart as gqlGetCart,
  getCartGraphQLOptions,
  getCustomerSessionId,
  getLineItemsBySupplier as gqlGetLineItemsBySupplier,
  updateItem as gqlUpdateItem,
  updateShippingsBySupplier as gqlUpdateShippingsBySupplier,
  type CartKeyContext,
  type CartQueryOptions,
  type DiscountAnswer,
} from '../api/cart-queries.js'
import { gatewayHas } from '../api/gateway-features.js'
import { normalizeDiscountRef } from '../campaign-discount.js'
import { Configuration } from '../configuration.js'
import {
  commonDiscountReason,
  discountGiftsOf,
  discountReasonOf,
  isFinalCouponReason,
  isGiftOf,
  normalizeDiscountCode,
  rememberedDiscountCode,
  summarizeDiscountOutcomes,
  type CartDiscountOutcome,
  type DiscountCodeRemoval,
  type DiscountCodeResult,
  type DiscountReason,
  type DiscountSettlement,
} from './discount-code.js'

import { cartDiscountTotal, cartListTotal, cartNetTotal, isGiftLine, serverLineDiscount } from './discount.js'

/**
 * How many times in a row the page's code is asked for on the same cart with
 * the same lines when Commerce could not say (the call failed, or the
 * brand's shop could not be asked). A refusal is asked once.
 */
const DISCOUNT_ASK_ATTEMPTS = 2

/** Where the carts are kept: one entry per connection (see `cartStorageKey`). */
export const CART_STORAGE_PREFIX = 'vio.cart.v1'

/**
 * The storage key of the carts of one connection (environment + surface key).
 * Before 0.33 every connection of a site shared `vio.cart.v1`, and every tab
 * adopted what the others wrote: two tabs on two connections (Replit's admin,
 * staging and prod side by side) took each other's cart for a moment. Now each
 * connection has its own entry and a tab only listens to its own. The scope is
 * the environment and a short hash of the key — never the key itself. `''`
 * (no connection yet) is the old shared key.
 */
export function cartStorageKey(scope: string): string {
  return scope ? `${CART_STORAGE_PREFIX}:${scope}` : CART_STORAGE_PREFIX
}

/** The scope of a connection: `environment:` + an FNV-1a hash of its key (not reversible to the key). */
export function cartScopeOf(environment: string, apiKey: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < apiKey.length; i++) {
    h ^= apiKey.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${environment || 'production'}:${h.toString(16).padStart(8, '0')}`
}

export interface CartChangeDetail {
  cartsBySponsor: Map<number, SponsorCartState>
  itemCount: number
}

/**
 * Detail of `vio:cart-updated` (on `document`): a sponsor's cart as it stands
 * after this tab learned of it from somewhere other than its own taps —
 * `source: 'server'`: GetCart, applied right before a checkout is built on it
 * (`refreshFromServer`); `source: 'storage'`: another tab of the same site
 * wrote it (an add there, a payment that cleared it). The lines are copies.
 */
export interface CartUpdatedDetail {
  sponsorId: number
  cartId?: string
  items: CartLineItem[]
  itemCount: number
  /** The lines at their list prices. */
  subtotal: number
  /** What the cart's discount code takes off them — only with one: `subtotal - discount` is what the lines cost. */
  discount?: number
  /** The discount code the cart carries, when it carries one whose code is shown (not a campaign's). */
  discountCode?: string
  /** `CAMPAIGN` when the cart carries its campaign's code: the code itself is not shown (nor known to the page). */
  discountSource?: 'CAMPAIGN'
  currency: string
  source: 'server' | 'storage'
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

/**
 * One change queued behind the request in flight: `delta` units more —
 * credited to `origin`, the place they were added from — or fewer (no
 * origin; the server takes them off the most recent, as the line does).
 */
interface QtyStep {
  delta: number
  origin?: CartOrigin
}

/** One backend quantity sync for one line. See `CartManager.qtySyncs`. */
interface QtySync {
  /** Target quantity of the request currently in flight. */
  sent: number
  /**
   * What arrived while in flight, in order, reduced as the line's own
   * origins are (a decrease comes off the most recent queued increase
   * first): one request per step once the current one settles, so every
   * increase reaches the server with ITS origin — a burst of +1 from the
   * hero and +1 from the carousel is two updates, not one credited to the
   * last. The line is heading to `sent + Σ delta`.
   */
  steps: QtyStep[]
}

/** The quantity a sync is heading to once every queued step has gone out. */
function finalTarget(sync: QtySync): number {
  return sync.steps.reduce((quantity, step) => quantity + step.delta, sync.sent)
}

/**
 * Queue a target behind the request in flight: more units go on the last
 * step when it is an increase from the same origin, else on a new one; fewer
 * come off the most recent queued increases first and, past them, become a
 * decrease below what is in flight. A target already reached queues nothing.
 */
function queueStep(sync: QtySync, target: number, origin: CartOrigin | undefined): void {
  const delta = target - finalTarget(sync)
  if (delta === 0) return
  if (delta > 0) {
    const last = sync.steps[sync.steps.length - 1]
    if (last && last.delta > 0 && sameOrigin(last.origin ?? {}, origin ?? {})) last.delta += delta
    else sync.steps.push({ delta, origin })
    return
  }
  let left = -delta
  while (left > 0 && sync.steps.length > 0) {
    const last = sync.steps[sync.steps.length - 1]!
    if (last.delta <= 0) break
    const take = Math.min(last.delta, left)
    last.delta -= take
    left -= take
    if (last.delta === 0) sync.steps.pop()
  }
  if (left > 0) {
    const last = sync.steps[sync.steps.length - 1]
    if (last && last.delta < 0) last.delta -= left
    else sync.steps.push({ delta: -left })
  }
}

/**
 * What a cart manager asks the page about the discount a CAMPAIGN gives a
 * sponsor's cart (the bootstrap's `discount.ref`, per campaign and sponsor —
 * see core/campaign-discount.ts), and whether a brand's cart may get a code
 * nobody typed. The facade answers from the bootstrap it holds; a manager
 * made without them (tests, a host's own) has no campaign codes and puts the
 * page's own on every cart — as before.
 */
export interface CartManagerHooks {
  /**
   * The discount the page's campaign gives the sponsor's cart now — its
   * reference — and that campaign's id; `undefined` when it gives none, or
   * nothing is known yet.
   */
  campaignDiscount?: (sponsorId: number) => { ref: string; campaignId: number } | undefined
  /**
   * What campaign `campaignId` gives the sponsor now: its reference; `null`
   * when it gives none any more; `undefined` when it cannot be told (no
   * bootstrap yet, another connection's) — then nothing is taken off.
   */
  campaignDiscountNow?: (sponsorId: number, campaignId: number) => string | null | undefined
  /**
   * Whether the sponsor's cart (on `channelId`, when it has one) may get a
   * code nobody typed — the campaign's or the page's own: one of the brand's
   * ways to pay takes discounts. `undefined` when it cannot be told yet (no
   * bootstrap): such a code then waits.
   */
  discountAllowed?: (sponsorId: number, channelId?: string) => boolean | undefined
}

/**
 * The code a sponsor's cart is to get by itself: one the page or the
 * shopper names (`code`), or the one a campaign gives the brand (`ref` and
 * `campaignId`: Commerce looks the code up, the page never sees it).
 */
type WantedDiscount = { code: string; ref?: undefined; campaignId?: undefined } | { code?: undefined; ref: string; campaignId: number }

/**
 * How the cart manager tells discounts apart: a code by its text; a
 * campaign's by its reference, behind a prefix with a space — something no
 * code has (`normalizeDiscountCode`). Never shown: see `shownCode`.
 */
const CAMPAIGN_KEY = 'campaign '
function campaignKey(ref: string | undefined): string {
  return CAMPAIGN_KEY + (ref ?? '?')
}
function isCampaignKey(key: string | undefined): boolean {
  return !!key && key.startsWith(CAMPAIGN_KEY)
}
/** What a key is to whoever sees it: the code; `''` for a campaign's, whose code is never shown. */
function shownCode(key: string): string {
  return isCampaignKey(key) ? '' : key
}
function wantedKey(wanted: WantedDiscount): string {
  return wanted.ref !== undefined ? campaignKey(wanted.ref) : wanted.code
}

/**
 * The key of the discount a cart carries (see `campaignKey`): its code; a
 * campaign's reference; `undefined` without one.
 */
function cartDiscountKey(cart: SponsorCartState | undefined): string | undefined {
  if (!cart) return undefined
  if (cart.discountCode) return cart.discountCode
  if (cart.discountSource === 'CAMPAIGN') return campaignKey(cart.discountRef)
  return undefined
}

/** The discount a cart carries forgotten: its code, or its campaign's. */
function clearCartDiscount(cart: SponsorCartState): void {
  delete cart.discountCode
  delete cart.discountCampaignId
  delete cart.discountRef
  delete cart.discountSource
}

/** A refusal as the cart remembers it (`discountRefusal`): the code; for a campaign's, its reference and no code. */
function refusalOf(key: string, reason: string): NonNullable<SponsorCartState['discountRefusal']> {
  return isCampaignKey(key) ? { code: '', ref: key.slice(CAMPAIGN_KEY.length), reason } : { code: key, reason }
}
function refusalKey(refusal: NonNullable<SponsorCartState['discountRefusal']>): string {
  return typeof refusal.ref === 'string' ? campaignKey(refusal.ref) : refusal.code
}

/**
 * How a discount on a cart is taken off: by its code; a campaign's — whose
 * code the page never knows — as whatever code the cart carries.
 */
interface DiscountRemoval {
  key: string
  code?: string
}

/** How the discount a cart carries is taken off; `undefined` without one. */
function removalOf(cart: SponsorCartState | undefined): DiscountRemoval | undefined {
  const key = cartDiscountKey(cart)
  if (!key || !cart) return undefined
  return cart.discountCode ? { key, code: cart.discountCode } : { key }
}

/** A line of a cart whose channel went away, as it stood then: what the new backend cart is given. */
interface CarriedLine {
  productId: number
  variantId?: number
  origins: CartLineOrigin[]
}

/** The campaign of a cart's most recent origin that names one — the campaign its lines came from. */
function cartCampaignOf(cart: SponsorCartState | undefined): number | undefined {
  const items = cart?.items ?? []
  for (let i = items.length - 1; i >= 0; i--) {
    const origins = items[i]?.origins ?? []
    for (let j = origins.length - 1; j >= 0; j--) {
      const id = Number(origins[j]?.campaignId)
      if (Number.isInteger(id) && id > 0) return id
    }
  }
  return undefined
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

/**
 * The image of a backend cart line. The commerce gateway answers `image` as a
 * LIST (`image: [{ id, url }]`); a bare string or object is read too. Before,
 * only the object was read: a line the page never drew itself — the gift of a
 * discount code, a line another tab added — showed no image (QA, 2026-11-12,
 * Alan: the gift's picture in the cart stayed grey while the carousel had it).
 */
export function lineImageUrl(image: unknown): string {
  const first = Array.isArray(image) ? image.find((i) => i != null) : image
  if (typeof first === 'string') return first
  if (first && typeof first === 'object' && typeof (first as { url?: unknown }).url === 'string') {
    return (first as { url: string }).url
  }
  return ''
}

/**
 * The same cart line: normalised product + variant ids (backend-synced lines
 * may carry ids as strings or omit fields), with a name fallback.
 */
function isSameLine(
  line: { productId?: unknown; variantId?: unknown; name?: string },
  want: { productId?: unknown; variantId?: unknown; name?: string },
): boolean {
  const p1 = normId(line.productId)
  const p2 = normId(want.productId)
  const v1 = normId(line.variantId)
  const v2 = normId(want.variantId)
  if (p1 && p2 && p1 === p2 && v1 === v2) return true
  if (v1 && v2 && v1 === v2) return true
  if (p1 && p2 && p1 === p2 && !v1 && !v2) return true
  const n1 = (line.name || '').trim().toLowerCase()
  const n2 = (want.name || '').trim().toLowerCase()
  if (n1 && n2 && n1 === n2 && v1 === v2) return true
  return false
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
  /**
   * Bumped per sponsor each time its backend cart is dropped because its
   * channel went away: the lines as they stood then (`carryOver`) go to the
   * new backend cart, so an add whose local units were already counted in
   * them must not send its own AddItem as well (see `addManual`).
   */
  private rebuildEpoch = new Map<number, number>()
  /** The lines to give the next backend cart of a sponsor, after its channel went away. */
  private carryOver = new Map<number, CarriedLine[]>()
  /**
   * The discount code asked for from code on this page load
   * (`applyDiscountCode`): it also goes on the backend carts created from now
   * on. `null` after `removeDiscountCode()` — no code at all for this page
   * load; `undefined` when nothing was said.
   */
  private askedDiscountCode: string | null | undefined = undefined
  /**
   * What Commerce last said about a code (`key`, see `campaignKey`) on a
   * sponsor's backend cart, the lines the cart had then, and how many times
   * in a row it was asked that way: the page's own code is not asked for
   * again on a cart that already answered for it (`shouldAskDiscount`).
   */
  private discountAnswers = new Map<
    number,
    { cartId: string; key: string; outcome: CartDiscountOutcome; lines: string; attempts: number }
  >()
  /**
   * The discount call in flight per sponsor (an ApplyDiscount or a
   * DeleteAppliedDiscount) and what it is about (`key`, see `campaignKey`):
   * one at a time, and what `discountBusy` reads. `asked`: someone asked for
   * it by name (`applyDiscountCode`, `removeDiscountCode`) and is told what
   * comes of it — as opposed to what the SDK does by itself with the page's
   * own code or the campaign's.
   */
  private discountCalls = new Map<
    number,
    {
      kind: 'applying' | 'removing'
      cartId: string
      key: string
      asked: boolean
      promise: Promise<unknown>
    }
  >()
  /**
   * The `applyDiscountCode` in flight per sponsor — a code someone asked for,
   * the shopper's own: a payment started meanwhile waits for its answer, and
   * does not leave for its provider when the code was not taken
   * (`settleDiscountCode`).
   */
  private typedAsks = new Map<number, Promise<DiscountCodeResult>>()
  /**
   * Sponsors whose gifts are not put in the cart for now: a payment is being
   * started on the cart as it is (`settleDiscountCode` ran out of time).
   */
  private giftHolds = new Set<number>()
  /** The gifts of a sponsor's cart being settled (`reconcileGifts`): one at a time. */
  private giftWork = new Map<number, Promise<boolean>>()
  /**
   * Codes (keys, see `campaignKey`) an `ApplyDiscount` took this page load
   * WITHOUT a gift: so the overlay that says «Legger til gave …»
   * (`discountGiftExpected`) stops promising one for a code that is a plain
   * percentage.
   */
  private giftlessCodes = new Set<string>()
  /**
   * `cartId:key` of the campaign codes that could not be taken off a cart
   * this page load (`withdrawCampaignCode`): not tried again on every change
   * of the cart — the next page load tries again.
   */
  private withdrawFailed = new Set<string>()
  /** A campaign's code being swapped on a sponsor's cart (`swapCampaignCode`): whatever else settles the cart waits for it. */
  private codeSwaps = new Map<number, Promise<void>>()
  /** What the page says about the codes its campaigns give (see `CartManagerHooks`). */
  private readonly hooks: CartManagerHooks

  /** The storage key of this connection's carts. */
  private readonly storageKey: string
  /**
   * Whether this is the page's connection now. A manager left behind by a
   * re-init (another key) still finishes its requests and keeps its own
   * carts, but says nothing to the page: no `vio:cart-*` events.
   */
  private active = true

  constructor(scope = '', hooks: CartManagerHooks = {}) {
    super()
    this.hooks = hooks ?? {}
    this.storageKey = cartStorageKey(scope)
    this.cartsBySponsor = this.loadFromStorage()
    // The carts a site kept in the shared entry before each connection had its
    // own move, once, to the first connection that opens with none of its own.
    if (scope && this.cartsBySponsor.size === 0) {
      const legacy = this.loadFromStorage(CART_STORAGE_PREFIX)
      if (legacy.size > 0) {
        this.cartsBySponsor = legacy
        this.persist()
        storageRemove('local', CART_STORAGE_PREFIX)
      }
    }
    // The carts are shared by every tab of the site through localStorage, but
    // each tab used to read them once, here, and never again: a payment in one
    // tab left the others showing — and adding to — a cart that was already
    // paid, and a line added in one tab was missing from the next until a
    // reload. Other tabs' writes arrive as `storage` events (never this tab's
    // own); see `onStorage`.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', this.onStorage)
    }
  }

  /** The page's connection is (or is no longer) this one; see `active`. */
  setActive(active: boolean): void {
    this.active = active
  }

  /** Tell the listeners what this connection's carts hold now (after the page switched to it). */
  announce(): void {
    this.emit()
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
    return sync ? finalTarget(sync) : undefined
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
        price?: { amount?: number; amount_incl_taxes?: number | null; discount?: number | string | null } | null
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
    // What the discount code takes off the line, for the quantity and price this answer says.
    const discount = serverLineDiscount(server.price?.discount, price ?? line.unitPrice, server.quantity)
    if (discount !== (line.discount ?? 0)) {
      if (discount > 0) line.discount = discount
      else delete line.discount
      changed = true
    }
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
    if (this.active && typeof document !== 'undefined') {
      document.dispatchEvent(
        new CustomEvent('vio:cart-error', { bubbles: true, detail: { message } }),
      )
    }
  }

  // MARK: - Backend cart sync (Vio Commerce GraphQL)

  /**
   * The options of a sponsor's backend cart: the key of the channel it was
   * created on (`channelMissing` when the bootstrap no longer lists it). A
   * cart from before channels were remembered keeps the sponsor's first
   * block, as when it was created, and remembers that channel from now on.
   */
  private async cartOptions(sponsorId: number): Promise<CartQueryOptions> {
    const cart = this.cartsBySponsor.get(sponsorId)
    if (cart?.cartId && cart.channelId) {
      return getCartGraphQLOptions(sponsorId, { channelId: cart.channelId })
    }
    if (!cart?.cartId) return getCartGraphQLOptions(sponsorId)
    const opts = await getCartGraphQLOptions(sponsorId, { campaignId: null })
    const now = this.cartsBySponsor.get(sponsorId)
    if (now?.cartId && !now.channelId && opts.sponsorResolved && opts.channelId) {
      now.channelId = opts.channelId
      this.persist()
    }
    return opts
  }

  /**
   * The backend cart to call for a sponsor, with the key of its channel. When
   * the bootstrap no longer lists that channel the stale cart is dropped and a
   * new one is created on the sponsor's current channel with the same lines
   * (`dropStaleBackendCart` + `ensureCartId`) — never a call with a key of
   * another channel. `undefined` when there is no backend cart (or none could
   * be made).
   */
  async liveCart(sponsorId: number): Promise<{ cartId: string; opts: CartQueryOptions } | undefined> {
    const cart = this.cartsBySponsor.get(sponsorId)
    const cartId = cart?.cartId
    if (!cart || !cartId) return undefined
    const opts = await this.cartOptions(sponsorId)
    if (!opts.channelMissing) {
      const current = this.cartsBySponsor.get(sponsorId)?.cartId
      // Moved meanwhile (another call rebuilt it): ask again for the new one.
      if (current && current !== cartId) return { cartId: current, opts: await this.cartOptions(sponsorId) }
      // Same cart — or emptied locally meanwhile, and its last removals still go to it.
      return { cartId, opts }
    }
    const now = this.cartsBySponsor.get(sponsorId)
    if (now?.cartId === cartId) this.dropStaleBackendCart(sponsorId)
    const rebuilt = await this.ensureCartId(sponsorId, now?.currency || undefined, now?.shippingCountry || undefined)
    if (!rebuilt) return undefined
    return { cartId: rebuilt, opts: await this.cartOptions(sponsorId) }
  }

  /**
   * The channel of a sponsor's cart is gone from the bootstrap (the campaign
   * moved, a refresh after hours): forget the backend cart and its line ids,
   * keep the lines, and remember them as they stand now for the next backend
   * cart (`carryOver`). Queued quantity syncs of the old cart are dropped —
   * their quantities are in the lines carried.
   */
  private dropStaleBackendCart(sponsorId: number): void {
    const cart = this.cartsBySponsor.get(sponsorId)
    if (!cart?.cartId) return
    const carried: CarriedLine[] = cart.items
      .filter((item) => item.quantity > 0)
      .map((item) => ({ productId: item.productId, variantId: item.variantId, origins: lineOrigins(item) }))
    delete cart.cartId
    delete cart.channelId
    // The code was on the backend cart that is gone; the next one is given the page's again.
    clearCartDiscount(cart)
    this.discountAnswers.delete(sponsorId)
    for (const item of cart.items) delete item.cartItemId
    for (const key of [...this.qtySyncs.keys()]) {
      if (key.startsWith(`${sponsorId}:`)) this.qtySyncs.delete(key)
    }
    this.carryOver.set(sponsorId, carried)
    this.rebuildEpoch.set(sponsorId, (this.rebuildEpoch.get(sponsorId) ?? 0) + 1)
    this.persist()
  }

  /** Give a new backend cart the lines of the one whose channel went away — each unit with its own origin. */
  private async replayCarriedLines(
    sponsorId: number,
    cartId: string,
    carried: CarriedLine[],
    opts: CartQueryOptions,
  ): Promise<void> {
    let last: unknown
    const seq = this.nextSeq(sponsorId)
    try {
      const privacyMode = await currentPrivacyMode()
      for (const line of carried) {
        for (const origin of line.origins) {
          if (!(origin.quantity > 0)) continue
          const { quantity, ...place } = origin
          const wire = Object.keys(place).length
            ? lineOriginWire(normalizeOrigin(place), { page: currentOriginPage(), privacyMode })
            : undefined
          last = await gqlAddItem(
            cartId,
            [
              {
                product_id: Number(line.productId || 0),
                quantity,
                variant_id: line.variantId != null ? Number(line.variantId) : null,
                ...(wire ? { origin: wire } : {}),
              },
            ],
            opts,
          )
        }
      }
    } catch (err) {
      this.emitError('moving the cart to the current channel failed — some lines may not be in it', err)
    }
    const res = last as { line_items?: unknown } | undefined
    if (res && Array.isArray(res.line_items)) this.applyBackendCart(sponsorId, res, seq)
    // The new backend cart has no code: the page's goes on it again (not waited for).
    this.checkDiscountCode(sponsorId)
  }

  /**
   * Ensure the sponsor cart exists server-side; returns its backend cart id.
   * A new backend cart is created on the channel of the campaign in context —
   * `ctx.campaignId` (the add's origin), else the campaign the cart's lines
   * came from, else `Vio.init`'s — and remembers it (`channelId`). An existing
   * one whose channel the bootstrap no longer lists is created again on the
   * current channel, with its lines (`liveCart`).
   */
  async ensureCartId(
    sponsorId: number,
    currency?: string,
    shippingCountry?: string,
    ctx: Pick<CartKeyContext, 'campaignId'> = {},
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
    if (cart.cartId) {
      if (!cart.channelId) return cart.cartId
      return (await this.liveCart(sponsorId))?.cartId
    }

    // Dedupe: concurrent callers share ONE CreateCart per sponsor.
    const inFlight = this.cartIdPromises.get(sponsorId)
    if (inFlight) return inFlight

    const creation = (async (): Promise<string | undefined> => {
      // The channel of the campaign in context: the add's, else the lines'.
      const campaignId = ctx.campaignId ?? cartCampaignOf(cart)
      const opts = await getCartGraphQLOptions(sponsorId, campaignId !== undefined ? { campaignId } : undefined)
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
          if (opts.channelId) cart.channelId = opts.channelId
          else delete cart.channelId
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
          // The lines of the backend cart whose channel went away.
          const carried = this.carryOver.get(sponsorId)
          if (carried) {
            this.carryOver.delete(sponsorId)
            if (carried.length > 0) await this.replayCarriedLines(sponsorId, backendCart.cart_id, carried, opts)
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
   * `opts.authoritative` is a GetCart taken with nothing of this tab's in
   * flight (`refreshFromServer`): an empty answer then means the cart IS
   * empty, and the local lines go — not an add still on its way.
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
      /** The code the cart carries — only in an answer that was asked for it (`getCart` with `discountCode`); null for a campaign's. */
      discount_code?: string | null
      /** Whose that code is: `CAMPAIGN` for a campaign's, whose text Commerce does not send; `CODE`; null without one. */
      discount_source?: string | null
      line_items?: Array<{
        id: string
        product_id: number
        variant_id?: number | string | null
        variant_title?: string | null
        brand?: string | null
        title?: string | null
        quantity: number
        image?: string | { url?: string } | Array<string | { url?: string } | null> | null
        imageUrl?: string | null
        image_url?: string | null
        price?: {
          amount?: number
          amount_incl_taxes?: number | null
          currency_code?: string
          /** What the cart's discount code takes off the line (all its units); 0 or null without one. */
          discount?: number | string | null
        } | null
        shipping?: unknown
        available_shippings?: unknown[]
      }>
    },
    opts: { settling?: Promise<unknown>; authoritative?: boolean } = {},
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
    // The code the server cart carries, when this answer says (null: none) —
    // an answer that does not name the field says nothing about it. A
    // campaign's code comes as `discount_source: CAMPAIGN`, without its text.
    if (backendCart.discount_code !== undefined || backendCart.discount_source !== undefined) {
      const serverCode = normalizeDiscountCode(backendCart.discount_code)
      const byCampaign = !serverCode && backendCart.discount_source === 'CAMPAIGN'
      const known = cartDiscountKey(cart)
      if (serverCode) {
        // Another code than the one known here: its gifts are not that one's,
        // and it is not the campaign's the SDK put on (nobody here knows whose it is).
        if (cart.discountCode !== serverCode) {
          if (known) delete cart.gifts
          clearCartDiscount(cart)
        }
        cart.discountCode = serverCode
      } else if (byCampaign) {
        // A campaign's code: the one the SDK put on stays as it knows it;
        // in place of a code it knew by its text, a campaign's it did not put on.
        if (cart.discountSource !== 'CAMPAIGN') {
          if (known) delete cart.gifts
          clearCartDiscount(cart)
          cart.discountSource = 'CAMPAIGN'
        }
      } else if (known || cart.gifts) {
        clearCartDiscount(cart)
        // The gifts the SDK put in for the code would now be paid for: they
        // go out once this answer's lines are in.
        if (cart.gifts?.some((g) => g.added)) void Promise.resolve().then(() => this.removeAddedGifts(sponsorId))
        else delete cart.gifts
      }
    }

    // Lines the shopper removed while their AddItem was still in flight: they
    // get their DeleteItem now that they have a backend id (see below).
    const removedBeforeSync: string[] = []
    if (Array.isArray(backendCart.line_items)) {
      const existingItems = cart.items || []
      if (backendCart.line_items.length === 0 && existingItems.length > 0 && !opts.authoritative) {
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
        const urlFromBackend = lineImageUrl(li.image) || li.imageUrl || li.image_url || ''
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
        const unitPrice = li.price?.amount_incl_taxes ?? li.price?.amount ?? matchedLocal?.unitPrice ?? 0
        // What the discount code takes off the line — for the quantity the
        // line is heading to, when that is not the one this answer knew.
        const discount = serverLineDiscount(li.price?.discount, unitPrice, intended ?? li.quantity, li.quantity)

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
          unitPrice,
          ...(discount > 0 ? { discount } : {}),
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
      for (const id of removedBeforeSync) this.syncQuantity(sponsorId, syncedCartId, id, 0, undefined, cart.channelId)
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

  /**
   * The cart's line for this product (and variant) when the cart's discount
   * code gives it away. That line is one unit: an add of the same product
   * changes nothing (`addManual`), so a product's page turns its «Legg i
   * handlekurv» off and says why. `undefined` otherwise.
   */
  giftLineFor(sponsorId: number, productId: unknown, variantId?: unknown): CartLineItem | undefined {
    const cart = this.cartsBySponsor.get(sponsorId)
    return cart?.items.find((i) => isSameLine(i, { productId, variantId }) && isGiftLine(i))
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
    const existing = cart.items.find((i) => isSameLine(i, opts))
    if (existing) {
      // A line the discount code gives away is one unit: adding it again
      // changes nothing (Commerce would refuse to be paid for two).
      if (isGiftLine(existing)) return existing
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
    // Whether these units are already in the lines a moved cart carries over (see `rebuildEpoch`).
    const epochAtAdd = this.rebuildEpoch.get(opts.sponsorId) ?? 0

    // Async sync with the backend cart. Optimistic — but a REJECTED AddItem
    // reverts the local line (a ghost line means the UI total and the charged
    // total diverge silently).
    const seq = this.nextSeq(opts.sponsorId)
    // This mutation, for `applyBackendCart` to tell its own answer from the others'.
    let settling: Promise<unknown> | undefined
    const mutation = (async () => {
      try {
        const cartId = await this.ensureCartId(opts.sponsorId, opts.currency || undefined, undefined, {
          campaignId: opts.origin?.campaignId,
        })
        // The cart moved to another channel after these units were counted:
        // the new backend cart was given them with the other lines.
        if ((this.rebuildEpoch.get(opts.sponsorId) ?? 0) !== epochAtAdd) return
        if (cartId) {
          const gqlOpts = await this.cartOptions(opts.sponsorId)
          // Where these units come from, for the order (ADR-0035 phase B):
          // the add's own origin; nothing when the host gave none. On a
          // `minimal` surface (or one whose mode is not known) the slot and
          // the page stay out of it — see `lineOriginWire`.
          const origin = opts.origin
            ? lineOriginWire(normalizeOrigin(opts.origin), {
                page: currentOriginPage(),
                privacyMode: await currentPrivacyMode(),
              })
            : undefined
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
          // The cart has lines now: the page's discount code, if it has one (not waited for).
          this.checkDiscountCode(opts.sponsorId)
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
    // A line the discount code gives away is one unit: it is not raised.
    if (target > item.quantity && isGiftLine(item)) return
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
      // A gift of the discount code the shopper takes out is not put back in this cart.
      const gift = cart.gifts?.find((g) => isGiftOf(g, item))
      if (gift) gift.declined = true
      // Choke point de la baja: sale acá y no en la UI para que también
      // cuente cuando el host llama removeItem() por API.
      if (this.active && typeof document !== 'undefined') {
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
              // The detail layout of those units (0.34), when they came from one.
              ...(removedOrigin?.layoutId ? { layout: normalizeLayoutOrigin(removedOrigin) } : {}),
            },
          }),
        )
      }
    } else {
      // A code is a percentage: what it takes off the line follows its units
      // until the server says (its answer to this change carries the amount).
      if (item.discount && item.quantity > 0) {
        item.discount = Math.round(((item.discount * target) / item.quantity) * 100) / 100
      }
      item.quantity = target
    }
    // What is left is only the gifts the SDK put in for the discount code:
    // they go too — a cart of gifts alone cannot be paid for.
    if (target <= 0) this.dropOrphanGifts(sponsorId)
    if (cart.items.length === 0) this.cartsBySponsor.delete(sponsorId)
    this.persist()
    this.emit()

    if (!cart.cartId) {
      // The backend cart is being created (or moved to another channel): the
      // change is replayed once its lines have their ids.
      if (this.cartIdPromises.has(sponsorId)) {
        this.pendingQtyIntents.set(this.intentKey(item.productId, item.variantId), target)
      }
      return
    }

    // The line hasn't been assigned its backend id yet (AddItem in flight):
    // sending the local id would 404. Record the intent — it's replayed as
    // soon as the reconcile lands.
    if (!targetItemId) {
      this.pendingQtyIntents.set(this.intentKey(item.productId, item.variantId), target)
      return
    }

    this.syncQuantity(sponsorId, cart.cartId, targetItemId, target, addedOrigin, cart.channelId)
  }

  /** Send a line's target quantity to the backend — ONE request in flight per
   * line. Targets that arrive while one is in flight queue behind it as
   * steps (`queueStep`): reduced like the line's origins, sent in order once
   * the current request settles — one request per queued increase from a
   * different origin, one for a net decrease — so the server ends on the
   * last intent, credits every increase to its own origin, and never sees two
   * updates racing each other. While the sync is active the line keeps its
   * optimistic quantity through any backend response (see
   * `updateFromBackendCart`); a rejection drops what was queued and
   * reconciles the cart from the server. */
  private syncQuantity(
    sponsorId: number,
    backendCartId: string,
    cartItemId: string,
    target: number,
    origin?: CartOrigin,
    channelId?: string,
  ): void {
    const key = this.qtySyncKey(sponsorId, cartItemId)
    const active = this.qtySyncs.get(key)
    if (active) {
      queueStep(active, target, origin)
      return
    }
    const sync: QtySync = { sent: target, steps: [] }
    this.qtySyncs.set(key, sync)

    // This mutation, for `applyBackendCart` to tell its own answer from the others'.
    let settling: Promise<unknown> | undefined
    const run = (async () => {
      let next: number | undefined = target
      let nextOrigin: CartOrigin | undefined = origin
      let removalRetried = false
      while (next !== undefined) {
        let gqlOpts: CartQueryOptions
        if (this.cartsBySponsor.get(sponsorId)?.cartId) {
          // The cart's channel went away and the cart moved: the new backend
          // cart was given the line's quantity as it stood — nothing to send here.
          const live = await this.liveCart(sponsorId)
          if (!live || live.cartId !== backendCartId) {
            if (this.qtySyncs.get(key) === sync) this.qtySyncs.delete(key)
            break
          }
          gqlOpts = live.opts
        } else {
          // The shopper emptied the cart: its last lines go on its own channel.
          gqlOpts = await getCartGraphQLOptions(sponsorId, channelId ? { channelId, retired: true } : undefined)
        }
        const seq = this.nextSeq(sponsorId)
        try {
          // The origin of the units this update adds (ADR-0035 phase B) —
          // when it was an increase and the SDK knows a place for them.
          const originWire =
            next > 0 && nextOrigin
              ? lineOriginWire(nextOrigin, { page: currentOriginPage(), privacyMode: await currentPrivacyMode() })
              : undefined
          const resCart =
            next <= 0
              ? await gqlDeleteItem(backendCartId, cartItemId, gqlOpts)
              : originWire
                ? await gqlUpdateItem(backendCartId, cartItemId, null, next, gqlOpts, { origin: originWire })
                : await gqlUpdateItem(backendCartId, cartItemId, null, next, gqlOpts)
          // The next queued step, if any: an increase with its origin, or a
          // decrease. It becomes `sent` at once — the line is heading there,
          // and the response being applied below must not roll it back.
          const step = sync.steps.shift()
          if (step) {
            next = sync.sent + step.delta
            nextOrigin = step.delta > 0 ? step.origin : undefined
            sync.sent = next
          } else {
            next = undefined
            nextOrigin = undefined
          }
          // Nothing queued: the server's view of this line is the truth now.
          // With a step queued the entry stays, so this (already stale)
          // response cannot roll the line back.
          if (next === undefined) this.qtySyncs.delete(key)
          if (resCart && Array.isArray(resCart.line_items)) {
            const applied = this.applyBackendCart(sponsorId, resCart, seq, settling)
            if (!applied && next === undefined) {
              this.reconcileLineFromResponse(sponsorId, cartItemId, resCart, settling)
            }
          }
          // Other quantities: a code that asked for more in the cart may be taken now (not waited for).
          if (next === undefined) this.checkDiscountCode(sponsorId)
        } catch (err) {
          // Rejected: whatever was queued is moot — the server decides — with
          // one exception. A queued REMOVAL already happened for the shopper
          // (the line is gone, vio:removed-from-cart went out), so it is sent
          // once more, once, instead of letting the reconcile bring the line
          // back without a DeleteItem ever going out.
          const retryRemoval = !removalRetried && sync.steps.length > 0 && finalTarget(sync) <= 0
          sync.steps = []
          next = undefined
          nextOrigin = undefined
          if (retryRemoval) {
            removalRetried = true
            // Entry stays (heading to 0): the reconcile below leaves the line out.
            sync.sent = 0
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
    // What Commerce said about a code was about the cart that goes.
    this.discountAnswers.delete(sponsorId)
    if (this.cartsBySponsor.delete(sponsorId)) {
      this.persist()
      this.emit()
    }
  }

  clearAllCarts(): void {
    this.discountAnswers.clear()
    if (this.cartsBySponsor.size === 0) return
    this.cartsBySponsor.clear()
    this.persist()
    this.emit()
  }

  /** Refresh the local cart from the backend (source of truth). */
  async fetchCartFromBackend(sponsorId: number): Promise<unknown> {
    const live = await this.liveCart(sponsorId)
    if (!live) return null
    const resCart = await this.readBackendCart(sponsorId, live)
    if (resCart) this.updateFromBackendCart(sponsorId, resCart)
    return resCart
  }

  /**
   * GetCart — as it always was for a cart without a discount code; with a
   * code in play (the page wants one, or the cart carries one) the answer
   * also says which code the server cart has.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readBackendCart(sponsorId: number, live: { cartId: string; opts: CartQueryOptions }): Promise<any> {
    return this.discountInPlay(sponsorId)
      ? gqlGetCart(live.cartId, live.opts, { discountCode: true })
      : gqlGetCart(live.cartId, live.opts)
  }

  /**
   * The cart as the server has it, for the moment a checkout is about to be
   * built on it: what the shopper is about to pay must be what the page shows.
   * Waits for this tab's own mutations (their answers are the server's too),
   * then applies GetCart as it is — a line another tab added, one it removed,
   * an empty cart — and tells the page: `change` for the drawer, and
   * `vio:cart-updated` on `document` (`source: 'server'`) for a host that
   * draws its own. A mutation that starts while the server is answering makes
   * that answer old: it is asked once more. Nothing to ask without a backend
   * cart. A GetCart that fails leaves the local state as it was and does not
   * throw — the checkout then goes on with the lines the last mutation
   * answered, as it always did. Resolves with the sponsor's cart.
   */
  async refreshFromServer(sponsorId: number): Promise<SponsorCartState | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.waitForCartMutations(sponsorId)
      const cart = this.cartsBySponsor.get(sponsorId)
      if (!cart?.cartId) return cart
      let resCart: unknown
      try {
        const live = await this.liveCart(sponsorId)
        if (!live) return this.cartsBySponsor.get(sponsorId)
        resCart = await this.readBackendCart(sponsorId, live)
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[CartManager] GetCart before the checkout failed — the local cart stands', err)
        }
        return cart
      }
      // Newer than this answer: a tap landed while the server was answering.
      if (this.hasMutationsInFlight(sponsorId)) continue
      const backendCart = resCart as { line_items?: unknown } | null | undefined
      if (backendCart && Array.isArray(backendCart.line_items)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.updateFromBackendCart(sponsorId, backendCart as any, { authoritative: true })
        this.emitCartUpdated(sponsorId, 'server')
        // The cart as the server has it carries no code and the page has one: asked for (not waited for).
        this.checkDiscountCode(sponsorId)
      }
      return this.cartsBySponsor.get(sponsorId)
    }
    return this.cartsBySponsor.get(sponsorId)
  }

  /** `vio:cart-updated` on `document` — see `CartUpdatedDetail`. */
  private emitCartUpdated(sponsorId: number, source: CartUpdatedDetail['source']): void {
    if (!this.active || typeof document === 'undefined') return
    const cart = this.cartsBySponsor.get(sponsorId)
    const items = (cart?.items ?? []).map((item) => ({ ...item }))
    const discount = cartDiscountTotal(items)
    const detail: CartUpdatedDetail = {
      sponsorId,
      cartId: cart?.cartId,
      items,
      itemCount: items.reduce((count, item) => count + item.quantity, 0),
      subtotal: items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
      ...(discount > 0 ? { discount } : {}),
      ...(cart?.discountCode ? { discountCode: cart.discountCode } : {}),
      ...(cart?.discountSource === 'CAMPAIGN' ? { discountSource: 'CAMPAIGN' as const } : {}),
      currency: cart?.currency || getGlobalCurrency(),
      source,
    }
    document.dispatchEvent(new CustomEvent<CartUpdatedDetail>('vio:cart-updated', { bubbles: true, detail }))
  }

  /**
   * Another tab of the site wrote the carts: adopt what it wrote, sponsor by
   * sponsor — its lines and its backend cart id, or nothing when it cleared
   * the cart (a payment) — except for a sponsor this tab is mid-write for:
   * its own answer lands in a moment and is persisted then, over whatever
   * the other tab had. `key` is null when the other tab cleared the whole
   * storage. Says `change` (the drawer) and `vio:cart-updated` per sponsor
   * that changed (`source: 'storage'`); nothing when nothing did.
   */
  private onStorage = (e: StorageEvent): void => {
    if (e.key !== null && e.key !== this.storageKey) return
    const stored = this.loadFromStorage()
    const changed: number[] = []
    for (const sponsorId of new Set([...this.cartsBySponsor.keys(), ...stored.keys()])) {
      if (this.hasMutationsInFlight(sponsorId) || this.cartIdPromises.has(sponsorId)) continue
      const mine = this.cartsBySponsor.get(sponsorId)
      const theirs = stored.get(sponsorId)
      if (JSON.stringify(mine ?? null) === JSON.stringify(theirs ?? null)) continue
      if (theirs) this.cartsBySponsor.set(sponsorId, theirs)
      else this.cartsBySponsor.delete(sponsorId)
      changed.push(sponsorId)
    }
    if (changed.length === 0) return
    this.emit()
    for (const sponsorId of changed) this.emitCartUpdated(sponsorId, 'storage')
  }

  /** Line items grouped by supplier (shipping is per-supplier server-side). */
  async fetchLineItemsBySupplier(sponsorId: number): Promise<unknown> {
    const live = await this.liveCart(sponsorId)
    if (!live) return null
    return gqlGetLineItemsBySupplier(live.cartId, live.opts)
  }

  /** Set the chosen shipping option per supplier on the backend cart. */
  async updateShippingsBySupplier(
    sponsorId: number,
    data: Array<{ shipping_id: string; supplier_id: number }>,
  ): Promise<unknown> {
    const live = await this.liveCart(sponsorId)
    if (!live) return null
    const resCart = await gqlUpdateShippingsBySupplier(live.cartId, data, live.opts)
    if (resCart && Array.isArray(resCart.line_items)) {
      this.updateFromBackendCart(sponsorId, resCart)
    }
    return resCart
  }

  // MARK: - Discount code (one per backend cart)

  /**
   * Put a discount code on the carts: on every sponsor's backend cart (or only
   * `sponsorId`'s) now, and — kept for this page load — on the backend carts
   * to come. This is what a "discount code" field calls: the code is
   * validated here, before anything is paid, and whoever asked is told what
   * came of it — taken or not, and why (the page's own code, which nobody
   * typed, is the one that is refused in silence). Commerce takes one
   * code per cart: the same code again is fine, another one while a code is
   * on the cart is refused (`removeDiscountCode()` first). It asks the
   * brand's shop about the code, so the answer can take a few seconds:
   * `discountBusy()` says so meanwhile (with `change`), nothing else in the
   * cart waits for it, and a second call for the same cart and code shares
   * the first. A cart that took the code is given the gifts the code brings
   * and has its lines read again, so each says what the code takes off it.
   *
   * Never throws: the answer says what happened (`DiscountCodeResult`, with
   * everything Commerce answered per cart), and a cart that did not take the
   * code is as it was.
   */
  async applyDiscountCode(code: string, sponsorId?: number): Promise<DiscountCodeResult> {
    const normalized = normalizeDiscountCode(code)
    if (!normalized) return { status: 'refused', code: '', carts: [] }
    const targets = this.discountTargets(sponsorId)
    const asking = this.askForDiscountCode(normalized, targets)
    // The shopper's own code: a payment started meanwhile waits for the answer.
    for (const id of targets) this.typedAsks.set(id, asking)
    try {
      return await asking
    } finally {
      for (const id of targets) {
        if (this.typedAsks.get(id) === asking) this.typedAsks.delete(id)
      }
    }
  }

  /** What `applyDiscountCode` does, for a code that is one. Never rejects. */
  private async askForDiscountCode(normalized: string, targets: number[]): Promise<DiscountCodeResult> {
    const before = this.askedDiscountCode
    // Wanted from now on: a backend cart born while Commerce answers gets it too.
    this.askedDiscountCode = normalized
    const carts: CartDiscountOutcome[] = []
    for (const id of targets) {
      const outcome = await this.assertDiscount(id, { code: normalized }, true, true)
      if (outcome) carts.push(outcome)
    }
    const status = summarizeDiscountOutcomes(carts)
    // A code no cart took is not kept for the carts to come.
    if ((status === 'refused' || status === 'failed') && this.askedDiscountCode === normalized) {
      this.askedDiscountCode = before
    }
    const reason = commonDiscountReason(carts)
    return { status, code: normalized, ...(reason ? { reason } : {}), carts }
  }

  /**
   * Take the discount code off the carts (every sponsor's, or only
   * `sponsorId`'s) and give none to the carts to come for the rest of this
   * page load — the page's configured code and the campaigns' included. A
   * cart it came off loses the gifts the SDK put in it for the code, and has
   * its lines read again. A campaign's code comes off too (its entry says
   * `source: 'CAMPAIGN'` and no code). Never throws.
   */
  async removeDiscountCode(sponsorId?: number): Promise<DiscountCodeRemoval> {
    this.askedDiscountCode = null
    const carts: DiscountCodeRemoval['carts'] = []
    for (const id of this.discountTargets(sponsorId)) {
      const removal = removalOf(this.cartsBySponsor.get(id))
      if (!removal) continue
      const code = removal.code ?? ''
      const source = removal.code ? {} : { source: 'CAMPAIGN' as const }
      try {
        const live = await this.liveCart(id)
        // The backend cart is gone (or was rebuilt without the code): nothing to take off.
        if (!live || cartDiscountKey(this.cartsBySponsor.get(id)) !== removal.key) continue
        const answer = await this.discountCall(id, { kind: 'removing', cartId: live.cartId, key: removal.key, asked: true }, () =>
          this.removeRequest(live.cartId, removal, live.opts),
        )
        if (!answer.executed) {
          carts.push({ sponsorId: id, code, ...source, status: 'refused', ...(answer.message ? { message: answer.message } : {}), answer })
          continue
        }
        this.forgetDiscount(id, live.cartId, removal.key)
        carts.push({ sponsorId: id, code, ...source, status: 'removed', answer })
        // The lines no longer carry what the code took off them.
        await this.refreshFromServer(id)
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn(`[CartManager] the discount code could not be removed from the cart of sponsor ${id}`, err)
        }
        carts.push({ sponsorId: id, code, ...source, status: 'failed', message: err instanceof Error ? err.message : String(err) })
      }
    }
    return { removed: carts.some((c) => c.status === 'removed'), carts }
  }

  /**
   * The discount code a sponsor's backend cart carries, once Commerce took
   * it — the code as it is shown. `undefined` for a campaign's code, whose
   * text the page is never told (`hasDiscountCode` says it is there).
   */
  discountCodeForSponsor(sponsorId: number): string | undefined {
    return this.cartsBySponsor.get(sponsorId)?.discountCode
  }

  /**
   * The sponsor's backend cart carries a discount code — whatever its
   * source: one the shopper typed, the page's own, or its campaign's (whose
   * code is not shown). `sponsorId` omitted: any of the carts that has lines.
   */
  hasDiscountCode(sponsorId?: number): boolean {
    if (sponsorId !== undefined) return !!cartDiscountKey(this.cartsBySponsor.get(sponsorId))
    for (const cart of this.cartsBySponsor.values()) {
      if (cart.items.length > 0 && cartDiscountKey(cart)) return true
    }
    return false
  }

  /**
   * Whose the code on the sponsor's cart is: `CAMPAIGN` — its campaign's,
   * not shown (the «Rabatt» row says no code); `CODE` — one that is shown
   * (`discountCodeForSponsor`); `undefined` without a code.
   */
  discountSourceForSponsor(sponsorId: number): 'CODE' | 'CAMPAIGN' | undefined {
    const cart = this.cartsBySponsor.get(sponsorId)
    if (cart?.discountCode) return 'CODE'
    return cart?.discountSource === 'CAMPAIGN' ? 'CAMPAIGN' : undefined
  }

  /**
   * The SDK is about to add (or is adding) the page code's gift to a cart —
   * for the overlay that says «Legger til gave …» while Vipps is prepared.
   * True when a gift is pending on the cart, or when the code the cart is to
   * get by itself (the page's own, or its campaign's for that sponsor) is one
   * that brings a gift (a code the SDK has not learned is giftless) and the
   * cart does not carry it yet (an empty-cart Express: the gift is about to
   * be added). `sponsorId` omitted: any of the carts. False on a page with no
   * code for that cart, so an ordinary purchase shows the plain overlay.
   */
  discountGiftExpected(sponsorId?: number): boolean {
    for (const id of this.discountTargets(sponsorId)) {
      const cart = this.cartsBySponsor.get(id)
      if ((cart?.gifts ?? []).some((g) => !g.added && !g.declined)) return true
      // One code per cart: what goes on a cart without a code, or in place of a
      // campaign's code its campaign changed — not on a cart whose code stays.
      const next = this.nextDiscount(id)
      const key = next ? wantedKey(next) : undefined
      if (key && !this.giftlessCodes.has(key) && cartDiscountKey(cart) !== key) return true
    }
    return false
  }

  /**
   * A discount code is being put on a cart (`applying`) or taken off it
   * (`removing`) right now — `sponsorId`'s cart, or any. `change` is said
   * when it starts and when it ends. `asked`: someone asked for it by name —
   * the field's «Bruk» or «Fjern», `applyDiscountCode()`,
   * `removeDiscountCode()` — and is to be shown what comes of it; `false`
   * for what the SDK does by itself (the page's own code or the campaign's
   * going on a cart, a refused code coming off at a payment), which shows
   * only once it is done. `code` is `''` for a campaign's code (never shown).
   */
  discountBusy(
    sponsorId?: number,
  ): { kind: 'applying' | 'removing'; code: string; sponsorId: number; asked: boolean } | undefined {
    for (const [id, call] of this.discountCalls) {
      if (sponsorId === undefined || id === sponsorId) {
        return { kind: call.kind, code: shownCode(call.key), sponsorId: id, asked: call.asked }
      }
    }
    return undefined
  }

  /**
   * The page's discount code — and the gifts it brings — on a sponsor's
   * backend cart before something is built on it (a checkout, a payment):
   * whatever discount call is in flight answers first, a campaign's code the
   * campaign changed or no longer gives is swapped (`campaignChange`), the
   * code is asked for when the cart has lines, carries none yet and Commerce
   * has not already answered for it (`shouldAskDiscount`), and its gifts are
   * put in the cart. Resolves once the cart is as discounted as it is going
   * to be.
   *
   * The page's OWN code (a campaign's gift) is waited for in full, past the
   * `budgetMs`: its apply — one to three seconds, the brand's shop asked live
   * — and the gift it adds are on the cart before the payment, so «Kjøp nå
   * med Vipps» never leaves without the gift. The request timeout (15 s) is
   * the hard cap; if the apply or the gift's AddItem fails, the purchase goes
   * on without it. A code someone typed (`applyDiscountCode`: the field's
   * «Bruk») is waited for the same way, and when Commerce does not take it
   * this says so (`notTaken`) instead of going on — whoever typed it is
   * reading why at this very moment, and a payment that leaves for its
   * provider would take the answer away with the page.
   *
   * `budgetMs` is the cap only when there is no code of the page's own to
   * settle — and then there is nothing to settle, so it never bites: a page
   * without a code waits for nothing and asks nothing more than before.
   *
   * Never throws.
   */
  async settleDiscountCode(sponsorId: number, opts: { budgetMs?: number } = {}): Promise<DiscountSettlement> {
    // A new attempt to pay: whatever an earlier one held back may go in now.
    this.giftHolds.delete(sponsorId)
    const asking = this.typedAsks.get(sponsorId)
    if (asking) {
      const result = await asking.then(
        (r) => r,
        () => undefined,
      )
      const mine = result?.carts.find((c) => c.sponsorId === sponsorId)
      if (result && mine && mine.status !== 'applied') {
        return { notTaken: { code: result.code, ...(mine.reason ? { reason: mine.reason } : {}) } }
      }
    }
    const work = this.settleDiscount(sponsorId, false)
    const budget = opts.budgetMs
    // A code of the page's own — or of its campaign, for this sponsor — is
    // waited for in full (its gift is the point of the article), and so is a
    // campaign's code coming off for the one that campaign gives now; without
    // one `work` is already done, so the budget is moot.
    if (
      !(typeof budget === 'number' && budget >= 0) ||
      this.wantedDiscount(sponsorId) !== undefined ||
      this.cartsBySponsor.get(sponsorId)?.discountCampaignId !== undefined
    ) {
      await work
      return {}
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const outOfTime = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), budget)
    })
    const first = await Promise.race([work.then(() => 'done' as const), outOfTime])
    clearTimeout(timer)
    if (first === 'late') {
      // The payment is built on the cart as it is now: nothing more goes in it.
      this.giftHolds.add(sponsorId)
      if (typeof console !== 'undefined') {
        console.warn(
          `[CartManager] the discount code of sponsor ${sponsorId}'s cart was not settled within ${budget}ms — the purchase goes on as the cart is`,
        )
      }
    }
    return {}
  }

  /**
   * The payment `settleDiscountCode` let go ahead did not start after all:
   * the gifts it held back may go in the cart now. No-op when nothing was held.
   */
  releaseGiftHold(sponsorId: number): void {
    if (!this.giftHolds.delete(sponsorId)) return
    this.checkDiscountCode(sponsorId)
  }

  /**
   * Commerce would not start a payment because of the cart's discount (the
   * code is checked again right before charging; `reason` is the word its
   * error names — `discountReasonOf`). A code that is no good any more —
   * over, unknown, used up, not for here, or asking for more than the cart
   * holds — comes off the cart with the gifts the SDK put in for it, so the
   * next attempt pays for the cart without it; and the cart is read again
   * from the server whatever the reason. Never throws.
   */
  async discountRefusedAtPayment(sponsorId: number, reason: DiscountReason): Promise<void> {
    try {
      const cart = this.cartsBySponsor.get(sponsorId)
      const removal = removalOf(cart)
      const dropsTheCode = isFinalCouponReason(reason) || reason === 'COUPON_MIN_AMOUNT'
      if (cart?.cartId && removal && dropsTheCode) {
        const cartId = cart.cartId
        if (isFinalCouponReason(reason)) cart.discountRefusal = refusalOf(removal.key, reason)
        try {
          const live = await this.liveCart(sponsorId)
          if (live && live.cartId === cartId) {
            await this.discountCall(sponsorId, { kind: 'removing', cartId, key: removal.key, asked: false }, () =>
              this.removeRequest(cartId, removal, live.opts),
            )
          }
          // Off the backend cart (or never on it any more): forgotten here, with the gifts it brought.
          this.forgetDiscount(sponsorId, cartId, removal.key, { keepAnswer: true })
        } catch (err) {
          // Still on the backend cart: kept here too, so the next refusal tries again.
          if (typeof console !== 'undefined') {
            console.warn(`[CartManager] the refused discount code could not be taken off the cart of sponsor ${sponsorId}`, err)
          }
        }
        // What Commerce said, as if it had answered an ApplyDiscount for the
        // cart as it is now (its gift gone): the page's own code is not asked
        // for again while that holds (`shouldAskDiscount`).
        this.discountAnswers.set(sponsorId, {
          cartId,
          key: removal.key,
          outcome: { sponsorId, status: 'refused', reason, message: reason },
          lines: this.discountLines(sponsorId),
          attempts: 1,
        })
      }
      await this.refreshFromServer(sponsorId)
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn(`[CartManager] the cart of sponsor ${sponsorId} could not be put right after a refused discount`, err)
      }
    }
  }

  /**
   * The page's code on the carts this page opened with — asked for, without
   * waiting, on every backend cart with lines that carries none — and a
   * campaign's code taken off (and replaced) where that campaign no longer
   * gives it. `Vio.init` calls it when the page has a code of its own; the
   * facade, when a bootstrap arrives (a code nobody typed waits for it: it
   * says whether the brand's ways to pay take codes) and when one brings the
   * campaigns' codes or changes them.
   */
  ensureDiscountCodes(): void {
    for (const id of [...this.cartsBySponsor.keys()]) this.checkDiscountCode(id)
  }

  /**
   * The code a sponsor's cart is to get by itself, in this order: the one
   * asked for from code on this page load (`null`: none at all — not even a
   * campaign's), else the page's own — `Vio.init({ discountCode })`, else the
   * `?vio_discount=` the tab remembers — for every cart; else the code the
   * page's campaign gives THIS sponsor (`hooks.campaignDiscount`), by its
   * reference, with that campaign. A code nobody typed only on a brand one
   * of whose ways to pay takes codes (`automaticAllowed`).
   */
  private wantedDiscount(sponsorId: number): WantedDiscount | undefined {
    if (this.askedDiscountCode !== undefined) {
      return this.askedDiscountCode ? { code: this.askedDiscountCode } : undefined
    }
    try {
      const configured = Configuration.isInitialized ? Configuration.get().discountCode : undefined
      const pageCode = configured ?? rememberedDiscountCode()
      if (pageCode) return this.automaticAllowed(sponsorId) ? { code: pageCode } : undefined
      return this.campaignWanted(sponsorId, this.hooks.campaignDiscount?.(sponsorId))
    } catch {
      return undefined
    }
  }

  /**
   * A campaign's discount as a cart gets it — its reference and its
   * campaign — when the gateway takes a campaign's code (a gateway that
   * refused one this page load does not get asked again) and the brand's
   * ways to pay take codes.
   */
  private campaignWanted(
    sponsorId: number,
    from: { ref?: unknown; campaignId?: unknown } | undefined,
  ): WantedDiscount | undefined {
    const ref = normalizeDiscountRef(from?.ref)
    const campaignId = Number(from?.campaignId)
    if (!ref || !Number.isInteger(campaignId) || campaignId <= 0) return undefined
    if (!gatewayHas('discount_campaign') || !this.automaticAllowed(sponsorId)) return undefined
    return { ref, campaignId }
  }

  /**
   * Whether a code nobody typed may go on the sponsor's cart now
   * (`hooks.discountAllowed`, for the cart's channel): yes only when the
   * page says so; not yet when it cannot tell (no bootstrap). A manager
   * without the hook: yes.
   */
  private automaticAllowed(sponsorId: number): boolean {
    if (!this.hooks.discountAllowed) return true
    try {
      return this.hooks.discountAllowed(sponsorId, this.cartsBySponsor.get(sponsorId)?.channelId) === true
    } catch {
      return false
    }
  }

  /**
   * The cart carries a code the SDK put on it from a campaign
   * (`discountCampaignId`) and that campaign gives the sponsor another one
   * now (`now`: its reference), or none — a newer bootstrap changed it in the
   * dashboard, or the campaign is no longer running. `undefined` when
   * nothing changed, when it cannot be told (no bootstrap yet), for a code
   * the shopper typed, the page's own, and one that could not be taken off
   * already this page load.
   */
  private campaignChange(sponsorId: number): { campaignId: number; now?: string } | undefined {
    const cart = this.cartsBySponsor.get(sponsorId)
    const campaignId = cart?.discountCampaignId
    const key = cartDiscountKey(cart)
    if (!cart || !key || campaignId === undefined || !this.hooks.campaignDiscountNow) return undefined
    if (cart.cartId && this.withdrawFailed.has(`${cart.cartId}:${key}`)) return undefined
    try {
      const said = this.hooks.campaignDiscountNow(sponsorId, campaignId)
      if (said === undefined) return undefined
      const now = normalizeDiscountRef(said)
      // The same reference: the same code. (A code put on by its text, before references, has none.)
      return now && now === cart.discountRef ? undefined : { campaignId, ...(now ? { now } : {}) }
    } catch {
      return undefined
    }
  }

  /**
   * What goes on in place of a campaign's code that campaign changed or
   * withdrew: the campaign's new one — the cart keeps following its
   * campaign — or, when it gives none now, the page's code as for any cart
   * without one. Nothing after `removeDiscountCode()` this page load.
   */
  private replacementFor(sponsorId: number, change: { campaignId: number; now?: string }): WantedDiscount | undefined {
    if (this.askedDiscountCode === null) return undefined
    return change.now
      ? this.campaignWanted(sponsorId, { ref: change.now, campaignId: change.campaignId })
      : this.wantedDiscount(sponsorId)
  }

  /**
   * The code the SDK is about to put on a sponsor's cart by itself: the
   * wanted one on a cart without a code; on a cart whose campaign's code
   * changed, its replacement; nothing on a cart whose code stays.
   */
  private nextDiscount(sponsorId: number): WantedDiscount | undefined {
    if (!cartDiscountKey(this.cartsBySponsor.get(sponsorId))) return this.wantedDiscount(sponsorId)
    const change = this.campaignChange(sponsorId)
    return change ? this.replacementFor(sponsorId, change) : undefined
  }

  /** A discount code is in play for this sponsor's cart: the page wants one for it, or the cart carries one. */
  private discountInPlay(sponsorId: number): boolean {
    return !!(this.wantedDiscount(sponsorId) || cartDiscountKey(this.cartsBySponsor.get(sponsorId)))
  }

  private discountTargets(sponsorId?: number): number[] {
    return sponsorId !== undefined ? [sponsorId] : [...this.cartsBySponsor.keys()]
  }

  /**
   * `settleDiscountCode` for whoever does not wait for it: after the cart's
   * lines changed on the server (an add, a quantity, a removal — a code that
   * asks for a minimum may be taken now, a gift may be due), after the cart
   * was read from the server, when the page opens on a cart, and when a
   * bootstrap arrives or changes the campaigns' codes. Nothing at all on a
   * page without a code for this cart whose cart carries none of a
   * campaign's.
   */
  private checkDiscountCode(sponsorId: number): void {
    const cart = this.cartsBySponsor.get(sponsorId)
    if (!cart?.gifts?.length && cart?.discountCampaignId === undefined && !this.wantedDiscount(sponsorId)) return
    void this.settleDiscount(sponsorId, true)
  }

  /**
   * What `settleDiscountCode` and `checkDiscountCode` do. `refresh`: read the
   * lines again when the code or a gift went on the cart, or a code came off
   * (a caller that reads them itself right after says no).
   */
  private async settleDiscount(sponsorId: number, refresh: boolean): Promise<void> {
    try {
      for (;;) {
        const inFlight =
          this.discountCalls.get(sponsorId)?.promise ?? this.giftWork.get(sponsorId) ?? this.codeSwaps.get(sponsorId)
        if (!inFlight) break
        await inFlight.then(
          () => undefined,
          () => undefined,
        )
      }
      const cart = this.cartsBySponsor.get(sponsorId)
      // Nothing to discount in an empty cart: a code that asks for a minimum would be refused there.
      if (!cart || cart.items.length === 0) return
      const removal = removalOf(cart)
      if (removal) {
        const change = this.campaignChange(sponsorId)
        if (change) {
          // The campaign's code changed or went: one piece of work, which
          // whatever else settles this cart meanwhile waits for.
          const swap = this.swapCampaignCode(sponsorId, removal, this.replacementFor(sponsorId, change), refresh)
          this.codeSwaps.set(sponsorId, swap)
          try {
            await swap
          } finally {
            if (this.codeSwaps.get(sponsorId) === swap) this.codeSwaps.delete(sponsorId)
          }
          return
        }
        // One code per cart, and it has one: only a gift of it may be due.
        if (!cart.gifts?.length) return
        await this.waitForCartMutations(sponsorId)
        const gifted = await this.reconcileGifts(sponsorId)
        if (gifted && refresh) await this.refreshFromServer(sponsorId)
        return
      }
      const wanted = this.wantedDiscount(sponsorId)
      if (wanted) await this.putDiscount(sponsorId, wanted, refresh)
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn(`[CartManager] the page's discount code was not settled for sponsor ${sponsorId}`, err)
      }
    }
  }

  /**
   * The code the SDK puts on a cart by itself — once the cart's own
   * mutations are in, when it has lines, carries none and Commerce has not
   * already answered for it (`shouldAskDiscount`). Resolves whether the cart
   * took it (its lines were then read again, unless `refresh` is false).
   */
  private async putDiscount(sponsorId: number, wanted: WantedDiscount, refresh: boolean): Promise<boolean> {
    await this.waitForCartMutations(sponsorId)
    const now = this.cartsBySponsor.get(sponsorId)
    if (!now?.cartId || now.items.length === 0 || cartDiscountKey(now)) return false
    if (!this.shouldAskDiscount(sponsorId, now.cartId, wantedKey(wanted))) return false
    const outcome = await this.assertDiscount(sponsorId, wanted, refresh, false)
    return outcome?.status === 'applied'
  }

  /**
   * A campaign's code its campaign changed or withdrew, swapped: it comes off
   * the cart with the gifts the SDK put in for it (`withdrawCampaignCode`),
   * then `next` goes on (`replacementFor`), and the lines are read again
   * either way (unless `refresh` is false). When it cannot be taken off,
   * nothing else happens. Never rejects.
   */
  private async swapCampaignCode(
    sponsorId: number,
    removal: DiscountRemoval,
    next: WantedDiscount | undefined,
    refresh: boolean,
  ): Promise<void> {
    try {
      if (!(await this.withdrawCampaignCode(sponsorId, removal))) return
      const taken = next ? await this.putDiscount(sponsorId, next, refresh) : false
      // The lines still say what the code that came off took off them.
      if (refresh && !taken) await this.refreshFromServer(sponsorId)
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn(`[CartManager] the campaign's discount code was not swapped for sponsor ${sponsorId}`, err)
      }
    }
  }

  /**
   * A campaign's code off the sponsor's backend cart because that campaign no
   * longer gives it (`campaignChange`) — as the field's «Fjern» does, but by
   * the SDK itself: the gifts the SDK put in for it go out with it. Resolves
   * true when the cart is without it now. When it cannot be taken off, it
   * stays — said in the console — and is not tried again for this cart this
   * page load. Never throws.
   */
  private async withdrawCampaignCode(sponsorId: number, removal: DiscountRemoval): Promise<boolean> {
    let cartId: string | undefined
    try {
      await this.waitForCartMutations(sponsorId)
      const live = await this.liveCart(sponsorId)
      // The backend cart is gone, or was rebuilt (without a code): nothing to take off.
      if (!live) return false
      cartId = live.cartId
      const stillOn = () => cartDiscountKey(this.cartsBySponsor.get(sponsorId)) === removal.key
      const answer = await this.discountCall(sponsorId, { kind: 'removing', cartId, key: removal.key, asked: false }, async () =>
        // Another settle of this cart took it off (or put another on) while this one waited its turn.
        stillOn() ? this.removeRequest(live.cartId, removal, live.opts) : null,
      )
      if (answer === null) return !cartDiscountKey(this.cartsBySponsor.get(sponsorId))
      if (!answer.executed) {
        // Not taken off: perhaps it is not on the server cart at all any more — the cart, read again, says.
        await this.refreshFromServer(sponsorId)
        if (cartDiscountKey(this.cartsBySponsor.get(sponsorId))) throw new Error(answer.message || 'not removed')
        return true
      }
      this.forgetDiscount(sponsorId, cartId, removal.key)
      return true
    } catch (err) {
      if (cartId) this.withdrawFailed.add(`${cartId}:${removal.key}`)
      if (typeof console !== 'undefined') {
        console.warn(
          `[CartManager] the campaign's discount code${removal.code ? ` "${removal.code}"` : ''} could not be taken off the cart of sponsor ${sponsorId} — it stays`,
          err,
        )
      }
      return false
    }
  }

  /** The DeleteAppliedDiscount that takes `removal` off a backend cart: by its code; a campaign's, without one. */
  private removeRequest(cartId: string, removal: DiscountRemoval, opts: CartQueryOptions): Promise<DiscountAnswer> {
    return removal.code ? gqlDeleteAppliedDiscount(cartId, removal.code, opts) : gqlDeleteCartDiscount(cartId, opts)
  }

  /**
   * Whether the page's code is asked for (again) on this backend cart: yes
   * when Commerce never answered for this cart and code. After an answer:
   * never when it took it (if the code is gone since, someone took it off);
   * never after a refusal that does not depend on the cart (remembered with
   * the cart: `discountRefusal`); when the cart's lines changed since a
   * refusal for the amount (`COUPON_MIN_AMOUNT`); when it could not say (the
   * call failed, the brand's shop could not be asked) —
   * `DISCOUNT_ASK_ATTEMPTS` times with the same lines; never after any other
   * refusal. `key`: the code, or a campaign's (see `campaignKey`).
   */
  private shouldAskDiscount(sponsorId: number, cartId: string, key: string): boolean {
    const refusal = this.cartsBySponsor.get(sponsorId)?.discountRefusal
    if (refusal && refusalKey(refusal) === key) return false
    const known = this.discountAnswers.get(sponsorId)
    if (!known || known.cartId !== cartId || known.key !== key) return true
    const { outcome } = known
    if (outcome.status === 'applied') return false
    const sameLines = known.lines === this.discountLines(sponsorId)
    const couldNotSay =
      outcome.status === 'failed' || outcome.reason === 'COUPON_UNAVAILABLE' || outcome.reason === 'DISCOUNT_UNAVAILABLE'
    if (couldNotSay) return !sameLines || known.attempts < DISCOUNT_ASK_ATTEMPTS
    if (outcome.reason === 'COUPON_MIN_AMOUNT') return !sameLines
    return false
  }

  /** The lines of a sponsor's cart as a code is asked about them: products, variants and quantities. */
  private discountLines(sponsorId: number): string {
    return (this.cartsBySponsor.get(sponsorId)?.items ?? [])
      .map((i) => `${i.productId}:${i.variantId ?? ''}:${i.quantity}`)
      .sort()
      .join('|')
  }

  /**
   * A code (or a campaign's, by reference) on a sponsor's backend cart —
   * asked once its own mutations have settled (a cart being created has its
   * id by then) — with the gifts it brings, and its lines read again when the
   * code or a gift is new to it (unless `refresh` is false). `undefined` when
   * the sponsor has no backend cart. `asked`: someone asked for this code by
   * name (`applyDiscountCode`) — see `discountBusy`. Never throws.
   */
  private async assertDiscount(
    sponsorId: number,
    wanted: WantedDiscount,
    refresh = true,
    asked = false,
  ): Promise<CartDiscountOutcome | undefined> {
    try {
      await this.waitForCartMutations(sponsorId)
      const live = await this.liveCart(sponsorId)
      if (!live) return undefined
      const key = wantedKey(wanted)
      const before = cartDiscountKey(this.cartsBySponsor.get(sponsorId))
      // This very code is already being put on this cart (two settles of one cart
      // overlapping): the call is shared, and so is reading the lines — its owner
      // does, or its caller right after (a checkout).
      const same = this.discountCalls.get(sponsorId)
      const joined = !!same && same.kind === 'applying' && same.cartId === live.cartId && same.key === key
      const outcome = await this.askDiscount(sponsorId, live.cartId, wanted, live.opts, asked)
      if (outcome.status === 'applied') {
        const gifted = await this.reconcileGifts(sponsorId)
        const cart = this.cartsBySponsor.get(sponsorId)
        if (refresh && !joined && (before !== key || gifted) && cart?.cartId === live.cartId && cart.items.length > 0) {
          await this.refreshFromServer(sponsorId)
        }
      }
      return outcome
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn(`[CartManager] the discount code could not be put on the cart of sponsor ${sponsorId}`, err)
      }
      return { sponsorId, status: 'failed', message: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * ONE `ApplyDiscount` for a backend cart and a code — or a campaign's, by
   * campaign. A call in flight for the same cart and code is shared — a
   * double tap is one request — and any other discount call of that sponsor
   * goes first. Resolves with the outcome, never rejects; a cart that took
   * the code remembers it (`discountCode`), or — a campaign's — its campaign
   * and reference (`discountSource`, `discountCampaignId`, `discountRef`),
   * and the gifts it brings (`gifts`).
   */
  private askDiscount(
    sponsorId: number,
    cartId: string,
    wanted: WantedDiscount,
    opts: CartQueryOptions,
    asked = false,
  ): Promise<CartDiscountOutcome> {
    const key = wantedKey(wanted)
    const same = this.discountCalls.get(sponsorId)
    if (same && same.kind === 'applying' && same.cartId === cartId && same.key === key) {
      // The page's own code was being put on the cart, and now someone asks for that very code: theirs from here on.
      if (asked && !same.asked) {
        same.asked = true
        this.emit()
      }
      return same.promise as Promise<CartDiscountOutcome>
    }
    const call: { kind: 'applying'; cartId: string; key: string; asked: boolean } = { kind: 'applying', cartId, key, asked }
    return this.discountCall(sponsorId, call, async (): Promise<CartDiscountOutcome> => {
      let outcome: CartDiscountOutcome
      try {
        const answer =
          wanted.ref !== undefined
            ? await gqlApplyCampaignDiscount(cartId, wanted.campaignId, opts)
            : await gqlApplyDiscount(cartId, wanted.code, opts)
        if (answer === null) {
          // A gateway that does not take a campaign's code: none on this page load (see `campaignWanted`).
          outcome = { sponsorId, status: 'failed', message: 'the commerce gateway does not take a campaign\'s code' }
        } else if (answer.executed) outcome = { sponsorId, status: 'applied', answer }
        else {
          const reason = discountReasonOf(answer.message)
          outcome = {
            sponsorId,
            status: 'refused',
            ...(reason ? { reason } : {}),
            ...(answer.message ? { message: answer.message } : {}),
            answer,
          }
        }
      } catch (err) {
        outcome = { sponsorId, status: 'failed', message: err instanceof Error ? err.message : String(err) }
      }
      const lines = this.discountLines(sponsorId)
      const known = this.discountAnswers.get(sponsorId)
      const again = !!known && known.cartId === cartId && known.key === key && known.lines === lines
      this.discountAnswers.set(sponsorId, { cartId, key, outcome, lines, attempts: (again ? known.attempts : 0) + 1 })
      // Learned what kind of code this is, for the «Legger til gave …» overlay.
      if (outcome.status === 'applied') {
        if (discountGiftsOf(outcome.answer).length > 0) this.giftlessCodes.delete(key)
        else this.giftlessCodes.add(key)
      }
      const cart = this.cartsBySponsor.get(sponsorId)
      // Still the same backend cart (it may have moved while Commerce answered).
      if (cart && cart.cartId === cartId) {
        if (outcome.status === 'applied') {
          // What became of a gift in this cart stays known when its code is taken again.
          const previous = cart.gifts ?? []
          const gifts = discountGiftsOf(outcome.answer).map((gift): CartGift => {
            const was = previous.find((g) => g.productId === gift.productId && g.variantId === gift.variantId)
            return { ...gift, ...(was?.added ? { added: true } : {}), ...(was?.declined ? { declined: true } : {}) }
          })
          clearCartDiscount(cart)
          if (wanted.ref !== undefined) {
            // A campaign's code follows its campaign; its text is never known here.
            cart.discountSource = 'CAMPAIGN'
            cart.discountCampaignId = wanted.campaignId
            cart.discountRef = wanted.ref
          } else {
            // A typed one (or the page's own) is nobody's to take off.
            cart.discountCode = wanted.code
          }
          if (gifts.length > 0) cart.gifts = gifts
          else delete cart.gifts
          delete cart.discountRefusal
          this.persist()
        } else if (outcome.status === 'refused' && isFinalCouponReason(outcome.reason)) {
          cart.discountRefusal = refusalOf(key, outcome.reason!)
          this.persist()
        }
      }
      if (outcome.status !== 'applied' && typeof console !== 'undefined') {
        // The purchase goes on without the discount: said here; a field that asked says it to the shopper.
        const what = wanted.ref !== undefined ? 'the campaign\'s discount code' : `discount code "${wanted.code}"`
        console.warn(
          `[CartManager] ${what} not applied to the cart of sponsor ${sponsorId} (${outcome.status})`,
          outcome.message ?? '',
        )
      }
      return outcome
    })
  }

  /**
   * Runs one discount call (apply or remove) for a sponsor's cart: one at a
   * time per sponsor — whatever is in flight goes first — and `discountBusy`
   * says it is going on, with `change` at its start and at its end. `what`
   * IS the entry kept while it runs (a later ask for the same code marks it
   * `asked`, and the call reads that when it is answered).
   */
  private async discountCall<T>(
    sponsorId: number,
    what: { kind: 'applying' | 'removing'; cartId: string; key: string; asked: boolean },
    run: () => Promise<T>,
  ): Promise<T> {
    for (;;) {
      const inFlight = this.discountCalls.get(sponsorId)
      if (!inFlight) break
      await inFlight.promise.then(
        () => undefined,
        () => undefined,
      )
    }
    const promise = run()
    const entry = Object.assign(what, { promise })
    this.discountCalls.set(sponsorId, entry)
    this.emit()
    try {
      return await promise
    } finally {
      if (this.discountCalls.get(sponsorId) === entry) this.discountCalls.delete(sponsorId)
      this.emit()
    }
  }

  /**
   * The code (`key`, see `campaignKey`) is off the backend cart: forgotten
   * here too, with what Commerce said about it (unless `keepAnswer`: a
   * refusal to remember) and the gifts the SDK put in the cart for it.
   */
  private forgetDiscount(sponsorId: number, cartId: string, key: string, opts: { keepAnswer?: boolean } = {}): void {
    if (!opts.keepAnswer) this.discountAnswers.delete(sponsorId)
    const cart = this.cartsBySponsor.get(sponsorId)
    if (!cart || cart.cartId !== cartId || cartDiscountKey(cart) !== key) return
    clearCartDiscount(cart)
    this.removeAddedGifts(sponsorId)
    this.persist()
    this.emit()
  }

  // MARK: - Gifts of the discount code

  /**
   * The gifts the cart's code brings, in the cart: one unit of each is added
   * when the cart has something to pay for, the gift is not in it and was
   * never put in or taken out of this cart; and the gifts the SDK put in go
   * out again when nothing else is left (a cart of gifts alone cannot be
   * paid for). One reconcile at a time per sponsor. Resolves with whether the
   * cart's lines changed; never rejects.
   */
  private reconcileGifts(sponsorId: number): Promise<boolean> {
    const inFlight = this.giftWork.get(sponsorId)
    if (inFlight) return inFlight
    const work = this.reconcileGiftsNow(sponsorId)
    this.giftWork.set(sponsorId, work)
    void work.then(() => {
      if (this.giftWork.get(sponsorId) === work) this.giftWork.delete(sponsorId)
    })
    return work
  }

  private async reconcileGiftsNow(sponsorId: number): Promise<boolean> {
    let changed = false
    try {
      const cart = this.cartsBySponsor.get(sponsorId)
      if (!cart?.cartId || !cartDiscountKey(cart) || !cart.gifts?.length) return false
      // A payment is being started on the cart as it is: nothing goes in it now.
      if (this.giftHolds.has(sponsorId)) return false
      const cartId = cart.cartId
      for (const gift of [...cart.gifts]) {
        const now = this.cartsBySponsor.get(sponsorId)
        if (!now || now.cartId !== cartId || !cartDiscountKey(now)) break
        if (gift.added || gift.declined) continue
        const gifts = now.gifts ?? []
        if (now.items.some((item) => isGiftOf(gift, item))) continue
        // Something to pay for: a line that is no gift.
        if (!now.items.some((item) => !gifts.some((g) => isGiftOf(g, item)))) continue
        if (this.giftHolds.has(sponsorId)) break
        changed = (await this.addGift(sponsorId, cartId, gift)) || changed
      }
      changed = this.dropOrphanGifts(sponsorId) || changed
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn(`[CartManager] the gifts of the discount code were not settled for sponsor ${sponsorId}`, err)
      }
    }
    return changed
  }

  /**
   * One unit of a gift into the backend cart (AddItem), as a mutation of the
   * cart like any other — whoever waits for the cart waits for it. When it
   * cannot be added (the product is not sold on this channel, out of
   * stock…) the purchase goes on without it: a line in the console, nothing
   * on screen, and it is not tried again for this cart.
   */
  private async addGift(sponsorId: number, cartId: string, gift: CartGift): Promise<boolean> {
    let added = false
    const seq = this.nextSeq(sponsorId)
    let settling: Promise<unknown> | undefined
    const mutation = (async () => {
      try {
        const live = await this.liveCart(sponsorId)
        // The cart moved to another backend cart meanwhile: its code — and this gift — go on that one.
        if (!live || live.cartId !== cartId) return
        const resCart = await gqlAddItem(
          cartId,
          [{ product_id: gift.productId, quantity: 1, variant_id: gift.variantId ?? null }],
          live.opts,
        )
        if (resCart && Array.isArray(resCart.line_items)) this.applyBackendCart(sponsorId, resCart, seq, settling)
        added = true
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn(
            `[CartManager] the gift of the discount code (product ${gift.productId}) could not be added to the cart of sponsor ${sponsorId} — the purchase goes on without it`,
            err,
          )
        }
      }
      const now = this.cartsBySponsor.get(sponsorId)
      const entry = now?.gifts?.find((g) => g.productId === gift.productId && g.variantId === gift.variantId)
      // Settled for this backend cart either way: in it, or not to be tried again.
      if (entry && now?.cartId === cartId) {
        if (added) entry.added = true
        else entry.declined = true
        this.persist()
      }
    })()
    settling = mutation
    this.trackMutation(sponsorId, mutation)
    await mutation
    return added
  }

  /**
   * Only gifts the SDK put there are left in the cart: they go out too — a
   * cart of gifts alone cannot be paid for — without `vio:removed-from-cart`
   * (the shopper removed nothing). True when lines went.
   */
  private dropOrphanGifts(sponsorId: number): boolean {
    const cart = this.cartsBySponsor.get(sponsorId)
    const gifts = cart?.gifts ?? []
    if (!cart || gifts.length === 0 || cart.items.length === 0) return false
    const putInBySdk = (item: CartLineItem) => gifts.some((g) => g.added && isGiftOf(g, item))
    if (!cart.items.every(putInBySdk)) return false
    return this.removeLinesQuietly(sponsorId, [...cart.items])
  }

  /** The gifts the SDK put in the cart go out (the code that brought them is gone); the cart forgets its gifts. */
  private removeAddedGifts(sponsorId: number): boolean {
    const cart = this.cartsBySponsor.get(sponsorId)
    const gifts = cart?.gifts ?? []
    if (!cart || gifts.length === 0) return false
    const lines = cart.items.filter((item) => gifts.some((g) => g.added && isGiftOf(g, item)))
    delete cart.gifts
    return this.removeLinesQuietly(sponsorId, lines)
  }

  /** Lines out of the cart, here and on the backend, with `change` but without `vio:removed-from-cart`. */
  private removeLinesQuietly(sponsorId: number, lines: CartLineItem[]): boolean {
    const cart = this.cartsBySponsor.get(sponsorId)
    if (!cart || lines.length === 0) return false
    cart.items = cart.items.filter((item) => !lines.includes(item))
    if (cart.items.length === 0) this.cartsBySponsor.delete(sponsorId)
    this.persist()
    this.emit()
    if (cart.cartId) {
      for (const line of lines) {
        if (line.cartItemId) this.syncQuantity(sponsorId, cart.cartId, line.cartItemId, 0, undefined, cart.channelId)
      }
    }
    return true
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

  /** A sponsor's lines at their list prices — the «Sum» of its cart, before a discount code. */
  subtotalForSponsor(sponsorId: number): number {
    const cart = this.cartsBySponsor.get(sponsorId)
    if (!cart) return 0
    return cart.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0)
  }

  /** What the discount code of a sponsor's cart takes off its lines. 0 without one. */
  discountForSponsor(sponsorId: number): number {
    return cartDiscountTotal(this.cartsBySponsor.get(sponsorId)?.items)
  }

  /** What a sponsor's lines cost: their list prices less the discount (shipping apart). */
  totalForSponsor(sponsorId: number): number {
    return cartNetTotal(this.cartsBySponsor.get(sponsorId)?.items)
  }

  /** What every cart's lines cost together: list prices less discounts (shipping apart). */
  get totalAcrossSponsors(): number {
    let sum = 0
    for (const cart of this.cartsBySponsor.values()) sum += cartNetTotal(cart.items)
    return sum
  }

  /** Every cart's lines at their list prices. */
  get listTotalAcrossSponsors(): number {
    let sum = 0
    for (const cart of this.cartsBySponsor.values()) sum += cartListTotal(cart.items)
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

  /**
   * Keep the carts for the next page and the other tabs. Where storage
   * refuses (in-app browsers, private modes) nothing throws (safe-storage.ts):
   * the carts stay in this manager's own map, the add to cart and the
   * checkout go on, and the cart just does not survive a reload there.
   */
  private persist(): void {
    try {
      const obj: Record<string, SponsorCartState> = {}
      for (const [k, v] of this.cartsBySponsor) obj[String(k)] = v
      storageSet('local', this.storageKey, JSON.stringify(obj), { memory: false })
    } catch {
      // A cart that cannot be serialised is not worth an exception.
    }
  }

  private loadFromStorage(key: string = this.storageKey): Map<number, SponsorCartState> {
    try {
      const raw = storageGet('local', key)
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
 * the page as origin + path (`contentUrl`) and its title, within Commerce's caps.
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
  const contentUrl = originAndPath(origin.contentUrl)
  if (contentUrl) out.contentUrl = contentUrl
  if (typeof origin.contentTitle === 'string' && origin.contentTitle.trim()) {
    out.contentTitle = origin.contentTitle.trim().slice(0, CONTENT_TITLE_MAX_LENGTH)
  }
  // The detail layout the units were added from (0.34) — validated, only with its id.
  Object.assign(out, normalizeLayoutOrigin(origin))
  return out
}

/**
 * Two origins are the same place when campaign, slot, content and kind of
 * element all match (the page's URL and title are attributes of the place, not
 * its identity) — and the same detail layout (0.34): units added under two
 * layouts stay two origins, so each layout is credited with its own.
 */
export function sameOrigin(a: CartOrigin, b: CartOrigin): boolean {
  return (
    a.campaignId === b.campaignId &&
    a.slot === b.slot &&
    a.contentId === b.contentId &&
    a.componentKind === b.componentKind &&
    a.layoutId === b.layoutId &&
    a.layoutRevision === b.layoutRevision &&
    a.experimentId === b.experimentId &&
    a.variantId === b.variantId
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
