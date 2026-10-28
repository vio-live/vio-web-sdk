// @vitest-environment jsdom
/**
 * «Kjøp nå med Vipps» on the product detail pays the sponsor's WHOLE cart: the
 * checkout is built on the cart, not on the product. Mote & Livsstil,
 * 2026-10-23: a jumper left in the cart 13 minutes earlier was paid along with
 * the top bought «nå», and only Vipps' page had said so. With an empty cart
 * the tap goes straight to Vipps, as before; with lines already in the cart
 * the product is added and the checkout opens first — every line, the total,
 * Vipps preselected — so the shopper sees what Vipps will charge before the
 * page leaves.
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

describe('vio-product-detail — «Kjøp nå med Vipps» and a cart that already has lines', () => {
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

  it('an empty cart: the product is added and the page leaves for Vipps Express, as before', async () => {
    const el = await openDetail()
    const express = vi
      .spyOn(Vio.checkout, 'startVippsExpress')
      .mockResolvedValue({ payment_url: 'https://apitest.vipps.no/landing', express: true } as never)
    const opened = heard('vio:checkout-open')
    const started = heard('vio:payment-redirect-start')

    el.buyWithVipps()
    await settle(el)
    await settle(el)

    expect(productIds()).toEqual([9])
    expect(started.calls).toHaveLength(1)
    expect(express).toHaveBeenCalledWith(SPONSOR)
    expect(opened.calls).toHaveLength(0)
  })

  it('a line already in the cart: the product is added and the checkout opens first — no hand-over to Vipps', async () => {
    // The jumper, added earlier and left in the cart.
    Vio.cart.addManual({ productId: 146, sponsorId: SPONSOR, brand: 'Careless', name: 'Sofie genser XL', unitPrice: 1299, currency: 'NOK', imageUrl: '' })
    await Vio.cart.waitForCartMutations(SPONSOR)
    const el = await openDetail()
    const express = vi
      .spyOn(Vio.checkout, 'startVippsExpress')
      .mockResolvedValue({ payment_url: 'https://apitest.vipps.no/landing', express: true } as never)
    const opened = heard('vio:checkout-open')
    const started = heard('vio:payment-redirect-start')

    el.buyWithVipps()
    await settle(el)
    await settle(el)

    // Both lines are in the cart the checkout will show.
    expect(productIds()).toEqual([146, 9])
    expect(express).not.toHaveBeenCalled()
    expect(started.calls).toHaveLength(0)
    expect(document.querySelector('.vio-redirect-overlay')).toBeNull()
    expect(opened.calls).toHaveLength(1)
    expect(opened.calls[0]!.detail).toMatchObject({ sponsorId: SPONSOR, paymentMethod: 'vipps', express: false })
    expect(el.open).toBe(false)
  })
})
