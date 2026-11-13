// @vitest-environment jsdom
/**
 * The product is the cart's gift already (QA 2026-11-12, Alan, #480): the
 * code gives one unit, and adding the same product changes nothing — before,
 * the page still said «Lagt i handlekurven» and sent `vio:added-to-cart`. Now
 * «Legg i handlekurv» is off, with a note that says why. Another product, or
 * the same product when it is not the gift, adds as it always did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gql = vi.hoisted(() => ({
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: true })),
  createCart: vi.fn(async () => ({ cart_id: 'cart-1', line_items: [] })),
  addItem: vi.fn(async () => ({ cart_id: 'cart-1', currency: 'NOK', line_items: [] })),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  getCart: vi.fn(),
}))

vi.mock('../../core/api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...gql,
}))

import { Vio } from '../../core/client.js'
import { VioProductDetail } from './vio-product-detail.js'
import { resetFailedLogos } from '../sponsor-identity.js'
import { ensureLocalStorage } from '../../core/cart/storage.testutil.js'
import { mount, unmountAll, settle } from '../test-harness.js'
import type { BootstrapResponse } from '../../core/types.js'

const SPONSOR = 4
const storage = ensureLocalStorage()

const product = {
  id: 9,
  brand: 'Careless',
  title: 'Vilde',
  quantity: 5,
  price: { amount: 899, currency_code: 'NOK' },
  images: [],
  variants: [],
  options: [],
}

const BOOT: BootstrapResponse = {
  campaign: { id: 10, name: 'Default' },
  primarySponsor: { id: SPONSOR, name: 'Careless', logoUrl: null, avatarUrl: null, commerce: { apiKey: 'key-4' } },
} as never

const facade = () => Vio as unknown as { cachedBootstrap: BootstrapResponse | null }

/** Document-level listeners, taken down after each test. */
const listeners: Array<() => void> = []
function heard(name: string): { calls: CustomEvent[] } {
  const calls: CustomEvent[] = []
  const on = (e: Event) => calls.push(e as CustomEvent)
  document.addEventListener(name, on)
  listeners.push(() => document.removeEventListener(name, on))
  return { calls }
}

async function openDetail(): Promise<HTMLElement & { open: boolean; buyWithVipps: () => void }> {
  const el = await mount<HTMLElement & { open: boolean; buyWithVipps: () => void }>('vio-product-detail')
  document.dispatchEvent(
    new CustomEvent('vio:product-click', { detail: { productId: '9', sponsorId: String(SPONSOR) } }),
  )
  for (let i = 0; i < 5; i++) await settle(el)
  expect(el.open).toBe(true)
  return el
}

const productIds = () => Vio.cart.getCart(SPONSOR)?.items.map((i) => i.productId) ?? []


/** The cart holds `product` as the gift: its discount is its whole price. */
function seedGift(productId = 9, variantId?: number) {
  const carts = (Vio.cart as unknown as { cartsBySponsor: Map<number, unknown> }).cartsBySponsor
  carts.set(SPONSOR, {
    sponsorId: SPONSOR,
    sponsorName: 'Careless',
    currency: 'NOK',
    items: [
      { id: 'gift', productId, variantId, sponsorId: SPONSOR, brand: 'Careless', name: 'Vilde', unitPrice: 899, discount: 899, quantity: 1, currency: 'NOK' },
      { id: 'paid', productId: 77, sponsorId: SPONSOR, brand: 'Careless', name: 'Genser', unitPrice: 1299, quantity: 1, currency: 'NOK' },
    ],
  })
  ;(Vio.cart as unknown as { emit: () => void }).emit()
}

const addButton = (el: HTMLElement) => el.shadowRoot!.querySelector<HTMLButtonElement>('.add-to-cart')!
const note = (el: HTMLElement) => el.shadowRoot!.querySelector('.gift-in-cart-note')

describe('vio-product-detail — the product is the cart\'s gift already', () => {
  beforeEach(() => {
    storage.clear()
    Vio.cart.clearAllCarts()
    resetFailedLogos()
    facade().cachedBootstrap = BOOT
    const proto = VioProductDetail.prototype as unknown as Record<string, unknown>
    for (const m of ['loadAvailablePaymentMethods', 'loadVippsButton']) {
      if (typeof proto[m] === 'function') vi.spyOn(proto as never, m as never).mockResolvedValue(undefined as never)
    }
    vi.spyOn(Vio.checkout, 'prepareApplePayFor').mockResolvedValue({ available: false, show: async () => {} } as never)
    vi.spyOn(Vio.checkout, 'getVippsExpressEnabled').mockResolvedValue(true)
    vi.spyOn(Vio, 'commerceFor').mockReturnValue({
      channel: {
        product: {
          getByIds: vi.fn().mockResolvedValue([product]),
          getSellerCompany: vi.fn().mockResolvedValue('Careless AS'),
        },
      },
    } as never)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    await Vio.cart.waitForCartMutations(SPONSOR)
    for (const off of listeners.splice(0)) off()
    unmountAll()
    Vio.cart.clearAllCarts()
    facade().cachedBootstrap = null
    vi.restoreAllMocks()
  })

  it('«Legg i handlekurv» is off, the note says why, and a tap adds nothing and says nothing', async () => {
    seedGift()
    const el = await openDetail()
    const added = heard('vio:added-to-cart')

    expect(addButton(el).disabled).toBe(true)
    expect(note(el)?.textContent?.trim()).toBe('Produktet er allerede med som gave. Maks én gave per bestilling.')

    addButton(el).click()
    await (el as unknown as { addToCart: () => Promise<void> }).addToCart()
    await settle(el)
    expect(added.calls).toHaveLength(0)
    expect(Vio.cart.getCart(SPONSOR)?.items.find((i) => i.id === 'gift')?.quantity).toBe(1)
    expect(gql.addItem).not.toHaveBeenCalled()
  })

  it('the same product, not given away: it adds as always', async () => {
    seedGift(55)
    const el = await openDetail()
    expect(addButton(el).disabled).toBe(false)
    expect(note(el)).toBeNull()
  })

  it('the gift leaves the cart: the button comes back on', async () => {
    seedGift()
    const el = await openDetail()
    expect(addButton(el).disabled).toBe(true)
    Vio.cart.removeItem('gift', SPONSOR)
    await settle(el)
    expect(addButton(el).disabled).toBe(false)
    expect(note(el)).toBeNull()
  })
})

describe('CartManager.giftLineFor', () => {
  afterEach(() => Vio.cart.clearAllCarts())

  it('the gift line of that product and variant; nothing for a paid line or another variant', () => {
    seedGift(9, 3)
    expect(Vio.cart.giftLineFor(SPONSOR, 9, 3)?.id).toBe('gift')
    expect(Vio.cart.giftLineFor(SPONSOR, '9', '3')?.id).toBe('gift')
    expect(Vio.cart.giftLineFor(SPONSOR, 9, 4)).toBeUndefined()
    expect(Vio.cart.giftLineFor(SPONSOR, 77)).toBeUndefined()
    expect(Vio.cart.giftLineFor(SPONSOR + 1, 9, 3)).toBeUndefined()
  })
})
