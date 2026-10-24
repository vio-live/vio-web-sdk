// @vitest-environment jsdom
/**
 * `add_payment_info` (ADR-0039 §3): the browser links its session to the
 * checkout the moment the checkout exists — `commerce.checkout_id`,
 * `payment_method`, the cart's lines — and BEFORE the page leaves for the
 * provider. The collector attributes an `order_paid` that has no `purchase`
 * (order 4128, 2026-10-23) to the session, page and slot of this event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCartGraphQLOptions: vi.fn(async () => ({})),
  createCheckout: vi.fn(async () => ({ id: 'CHK-NEW' })),
  updateCheckout: vi.fn(async (vars: { checkoutId: string }) => ({ id: vars.checkoutId })),
}))
vi.mock('../checkout/payments/vipps.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPaymentVipps: vi.fn(async () => ({ payment_url: 'https://pay.vipps.no/landing', reference: 'VIO-1', express: true })),
}))

import * as cartQueries from '../api/cart-queries.js'
import { Vio } from '../client.js'
import { CheckoutManager } from '../checkout/checkout-manager.js'
import { AnalyticsManager } from './analytics-manager.js'

const SPONSOR = 1327
const LINE = {
  id: 'l1',
  productId: 77,
  sponsorId: SPONSOR,
  brand: 'Careless',
  name: 'Vilde genser',
  unitPrice: 599,
  currency: 'NOK',
  imageUrl: '',
  quantity: 1,
}

const cartStub = () =>
  ({
    waitForCartMutations: vi.fn(async () => {}),
    refreshFromServer: vi.fn(async () => undefined),
    getCart: () => ({ cartId: 'cart-1', currency: 'NOK', items: [LINE] }),
    ensureCartId: async () => 'cart-1',
    subtotalForSponsor: () => 599,
  }) as never

/** Every event, in order, and what had left the page (beacon) at each redirect. */
let recorded: Array<{ name: string; commerce?: Record<string, unknown>; context?: Record<string, unknown> }>
let beaconed: string[]
let beaconedAtRedirect: string[] | null
let analytics: AnalyticsManager

function onAnalytics(e: Event) {
  recorded.push((e as CustomEvent).detail)
}

beforeEach(() => {
  recorded = []
  beaconed = []
  beaconedAtRedirect = null
  Vio.init({ apiKey: 'test-key', environment: 'production' } as never)
  vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(new Map([[SPONSOR, { items: [LINE] } as never]]))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}) }) as Response))
  const RealBlob = globalThis.Blob
  vi.stubGlobal(
    'Blob',
    class extends RealBlob {
      __text: string
      constructor(parts: BlobPart[], opts?: BlobPropertyBag) {
        super(parts, opts)
        this.__text = parts.map((p) => String(p)).join('')
      }
    },
  )
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: vi.fn((_url: string, data: { __text?: string }) => {
      const events = (JSON.parse(data.__text ?? '{}').events ?? []) as Array<{ name: string }>
      beaconed.push(...events.map((e) => e.name))
      return true
    }),
  })
  vi.spyOn(CheckoutManager as never as { redirectTo: (u: string) => void }, 'redirectTo').mockImplementation(() => {
    beaconedAtRedirect = [...beaconed]
  })
  vi.mocked(cartQueries.createCheckout).mockClear()
  window.addEventListener('vio:analytics', onAnalytics)
  analytics = new AnalyticsManager()
  analytics.start({ host: 'replit' })
})

afterEach(() => {
  analytics.stop()
  window.removeEventListener('vio:analytics', onAnalytics)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const paymentInfo = () => recorded.filter((e) => e.name === 'add_payment_info')

describe('add_payment_info', () => {
  it('Vipps Express from the product detail: once, with the checkout id and the cart, and gone before the redirect', async () => {
    const manager = new CheckoutManager(cartStub())
    await manager.startVippsExpress(SPONSOR)

    expect(paymentInfo()).toHaveLength(1)
    const [event] = paymentInfo()
    expect(event!.commerce).toMatchObject({
      checkout_id: 'CHK-NEW',
      payment_method: 'vipps',
      value: 599,
      currency: 'NOK',
      items: [expect.objectContaining({ product_id: '77', price: 599, quantity: 1 })],
    })
    expect(event!.context).toMatchObject({ sponsor_id: SPONSOR })
    // The page leaves right after: the event was already on its way.
    expect(beaconedAtRedirect).toContain('add_payment_info')
  })

  it('once per checkout: paying again on the same checkout adds nothing', async () => {
    const manager = new CheckoutManager(cartStub())
    await manager.startVippsExpress(SPONSOR)
    await manager.startVippsExpress(SPONSOR) // the state keeps CHK-NEW: no new checkout
    vi.mocked(cartQueries.createCheckout).mockResolvedValueOnce({ id: 'CHK-NEW' })
    await manager.createCheckout(SPONSOR, 'stripe') // the backend answers the same id
    expect(paymentInfo()).toHaveLength(1)
  })

  it('a checkout the backend did not create sends nothing', async () => {
    vi.mocked(cartQueries.createCheckout).mockRejectedValueOnce(new Error('503'))
    const manager = new CheckoutManager(cartStub())
    await expect(manager.startVippsExpress(SPONSOR)).rejects.toThrow()
    expect(paymentInfo()).toHaveLength(0)

    vi.mocked(cartQueries.createCheckout).mockResolvedValueOnce(null as never)
    await expect(manager.startVippsExpress(SPONSOR)).rejects.toThrow()
    expect(paymentInfo()).toHaveLength(0)
  })

  it('an embedded method names itself: Apple Pay / Nexi / Klarna create the checkout through createCheckout', async () => {
    const manager = new CheckoutManager(cartStub())
    await manager.createCheckout(SPONSOR, 'apple-pay')
    expect(paymentInfo()).toHaveLength(1)
    expect(paymentInfo()[0]!.commerce).toMatchObject({ checkout_id: 'CHK-NEW', payment_method: 'apple-pay' })
    // Not leaving the page: no beacon of its own, it goes with the next flush.
    expect(beaconed).not.toContain('add_payment_info')
  })
})
