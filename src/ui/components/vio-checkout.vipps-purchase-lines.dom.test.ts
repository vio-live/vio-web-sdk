// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * The `purchase` of a paid Vipps return says WHAT was bought — from the
 * checkout that was paid, never from whatever the cart holds by then.
 *
 * Faves (campaign 4, surface 1, prod, 2026-11-05): orders 4136, 4139 and 4142
 * reached the collector as a `purchase` with `value: 0`, `items: []`, no
 * `location_id` and `order_id_kind: 'checkout'`, while the `order_paid` of the
 * same checkouts carried the amount and the line. The shopper bought one
 * product per checkout, several in a row, each through the Vipps app: back on
 * the page the cart of this tab was empty (another return had cleared it) or
 * already held the NEXT product, and the purchase was built from it. The
 * purchases of the same session that went right (4137, 4138, 4141) are the
 * ones whose cart was still the paid one.
 *
 * Every test lands like the phone does: a fresh page load from the return URL.
 */

const SPONSOR = 1338
/** One checkout per test: analytics reports one purchase per checkout for the life of the page. */
let n = 0
let CHECKOUT = ''
let ORDER = 0
const manager = Vio.checkout as any

/** What GetCheckout answers for the checkout that was paid: one Genser, two Luer. */
function paidCheckout() {
  return {
    id: CHECKOUT,
    status: 'SUCCESS',
    cart: {
      cart_id: 'cart-1',
      currency: 'NOK',
      line_items: [
        {
          id: 'li-1',
          product_id: 101,
          variant_id: 11,
          brand: 'Faves',
          title: 'Genser',
          variant_title: 'M',
          quantity: 1,
          image: [],
          price: { amount: 1038.4, amount_incl_taxes: 1298, currency_code: 'NOK' },
        },
        {
          id: 'li-2',
          product_id: 102,
          variant_id: null,
          brand: 'Faves',
          title: 'Lue',
          variant_title: null,
          quantity: 2,
          image: [],
          price: { amount: 199.6, amount_incl_taxes: 249.5, currency_code: 'NOK' },
        },
      ],
    },
    totals: { currency_code: 'NOK', subtotal: 1797, shipping: 0, total: 1797 },
  }
}

type Wire = { name: string; commerce?: Record<string, any>; props?: Record<string, unknown> }
let recorded: Wire[] = []
const onAnalytics = (e: Event) => recorded.push((e as CustomEvent<Wire>).detail)
const purchases = () => recorded.filter((e) => e.name === 'purchase')

const landFromVipps = () =>
  window.history.replaceState(
    {},
    '',
    `/?vio_payment=success&vio_method=vipps&vio_sponsor=${SPONSOR}&checkout_id=${CHECKOUT}`,
  )

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function cycles(el: HTMLElement, n = 10) {
  for (let i = 0; i < n; i++) await settle(el)
}

beforeEach(() => {
  recorded = []
  ORDER = 4136 + n++
  CHECKOUT = `23e75f5e-0000-4000-8000-${String(ORDER).padStart(12, '0')}`
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}) }) as unknown as Response),
  )
  Vio.init({ apiKey: 'test-key', environment: 'production' } as any)
  const proto = VioCheckout.prototype as any
  for (const m of [
    'loadAvailablePaymentMethods',
    'loadAvailableShippings',
    'refreshApplePay',
    'refreshKlarna',
    'prefillFormFromCheckout',
  ]) {
    vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  // The order exists already: the purchase says its number, not the checkout's.
  vi.spyOn(manager, 'getOrderReference').mockResolvedValue({ orderNumber: ORDER, buyerRef: null })
  vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(ORDER)
  vi.spyOn(manager, 'getVippsStatus').mockResolvedValue({ state: 'AUTHORIZED', duplicate_of: null })
  vi.spyOn(Vio.cart, 'refreshFromServer').mockResolvedValue(undefined as any)
  Vio.cart.clearAllCarts()
  setVisibility('visible')
  window.addEventListener('vio:analytics', onAnalytics)
  Vio.analytics.start({ host: 'replit' })
})

afterEach(() => {
  window.removeEventListener('vio:analytics', onAnalytics)
  Vio.analytics.stop()
  unmountAll()
  manager.state = null
  Vio.cart.clearAllCarts()
  window.history.replaceState({}, '', '/')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setVisibility('visible')
})

describe('the purchase of a Vipps return comes from the checkout that was paid', () => {
  it('the cart of this tab is already empty: the lines and the value are the checkout’s', async () => {
    const read = vi.spyOn(manager, 'getCheckout').mockResolvedValue(paidCheckout())
    landFromVipps()
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await cycles(el)

    expect(el.orderConfirmed).toBe(true)
    expect(read).toHaveBeenCalledWith(CHECKOUT, SPONSOR)
    expect(purchases()).toHaveLength(1)
    const [ev] = purchases()
    expect(ev!.commerce).toMatchObject({
      order_id: String(ORDER),
      checkout_id: CHECKOUT,
      value: 1797,
      currency: 'NOK',
      payment_method: 'vipps',
    })
    expect(ev!.commerce!.items).toEqual([
      expect.objectContaining({ product_id: '101', variant_id: '11', price: 1298, quantity: 1 }),
      expect.objectContaining({ product_id: '102', price: 249.5, quantity: 2 }),
    ])
  })

  it('the cart already holds the NEXT purchase: it is not reported as this one', async () => {
    vi.spyOn(manager, 'getCheckout').mockResolvedValue(paidCheckout())
    // The shopper went on shopping before this return was processed.
    Vio.cart.addManual({
      productId: 999,
      sponsorId: SPONSOR,
      brand: 'Faves',
      name: 'Skjerf',
      unitPrice: 499,
      currency: 'NOK',
      imageUrl: '',
      quantity: 1,
    })
    landFromVipps()
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await cycles(el)

    expect(purchases()).toHaveLength(1)
    const [ev] = purchases()
    expect(ev!.commerce!.value).toBe(1797)
    expect(ev!.commerce!.items.map((i: { product_id: string }) => i.product_id)).toEqual(['101', '102'])
  })

  it('the checkout cannot be read: no purchase at all — never one with value 0 and no lines', async () => {
    vi.spyOn(manager, 'getCheckout').mockRejectedValue(new Error('503'))
    landFromVipps()
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await cycles(el)
    // Past every retry.
    await new Promise((r) => setTimeout(r, 50))
    await cycles(el)

    expect(el.orderConfirmed).toBe(true)
    expect(purchases()).toHaveLength(0)
  })
})
