// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * The `purchase` of a paid Vipps redirect return must leave the page.
 *
 * Order 4128 (Careless, prod, 2026-10-23 22:40, Replit page, SDK
 * 0.28.0): the page processed the return — it asked `payment-vipps/status`
 * 1–2 s after Vipps' AUTHORIZED, the order existed — and Commerce sent its
 * `order_paid`, but no browser `purchase` reached the collector. It was the
 * third trip to the Vipps app in 90 s (two abandoned, the cart emptied in
 * between).
 *
 * On that return the checkout already knows Vio's order number when it emits
 * `vio:payment-success` (its ask for the buyer reference found the order), so
 * analytics records the `purchase` at once — into the queue, which the page
 * sent every 5 s. Hiding the page (back to the Vipps app, the home screen,
 * another tab) beaconed only a purchase still WAITING for its order number:
 * one already in the queue stayed there, and a phone that discards a hidden
 * tab never runs the next tick. The purchase is the one event that must not
 * wait: it is sent as soon as it is built, and whatever is queued leaves by
 * beacon when the page hides.
 */

const SPONSOR = 1327
const CHECKOUT = '0b7c6f6e-1111-4222-8333-444455556666'
const manager = Vio.checkout as any

/** What the collector got, by fetch or by beacon: the event names. */
let sent: string[] = []

function bodyNames(body: unknown): string[] {
  try {
    const parsed = JSON.parse(String(body)) as { events?: Array<{ name: string }> }
    return (parsed.events ?? []).map((e) => e.name)
  } catch {
    return []
  }
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  sent = []
  Vio.init({ apiKey: 'test-key', environment: 'production' } as any)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: unknown }) => {
      if (String(url).includes('/v1/events')) sent.push(...bodyNames(init?.body))
      return { ok: true, status: 202, json: async () => ({}) } as Response
    }),
  )
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: vi.fn((_url: string, data: Blob) => {
      // jsdom's Blob has no sync reader; the test keeps the text it was built from.
      sent.push(...bodyNames((data as unknown as { __text?: string }).__text))
      return true
    }),
  })
  // Keep a Blob's text readable synchronously for the beacon stub above.
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
  const proto = VioCheckout.prototype as any
  for (const m of ['loadAvailablePaymentMethods', 'loadAvailableShippings', 'refreshApplePay', 'refreshKlarna']) {
    vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  // The order exists by the time the page asks (the webhook came first).
  vi.spyOn(manager, 'getOrderReference').mockResolvedValue({ orderNumber: 4128, buyerRef: null })
  vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(4128)
  vi.spyOn(manager, 'getVippsStatus').mockResolvedValue({ state: 'AUTHORIZED', duplicate_of: null })
  vi.spyOn(Vio.cart, 'refreshFromServer').mockResolvedValue(undefined as any)
  setVisibility('visible')
  Vio.analytics.start({ host: 'replit' })
})

afterEach(() => {
  Vio.analytics.stop()
  unmountAll()
  manager.state = null
  window.history.replaceState({}, '', '/')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setVisibility('visible')
})

describe('the purchase of a paid Vipps return leaves the page', () => {
  it('order 4128: the shopper leaves the page right after the confirmation — the purchase has already gone', async () => {
    const recorded: string[] = []
    const onAnalytics = (e: Event) => recorded.push((e as CustomEvent<{ name: string }>).detail.name)
    window.addEventListener('vio:analytics', onAnalytics)
    window.history.replaceState(
      {},
      '',
      `/?vio_payment=success&vio_method=vipps&vio_sponsor=${SPONSOR}&checkout_id=${CHECKOUT}`,
    )
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    for (let i = 0; i < 8; i++) await settle(el)
    window.removeEventListener('vio:analytics', onAnalytics)

    // The return was read as paid and the purchase was built — exactly once.
    expect(el.orderConfirmed).toBe(true)
    expect(recorded.filter((n) => n === 'purchase')).toHaveLength(1)

    // Seconds later (well before the next 5 s tick) the page is hidden, and a
    // phone may never run it again.
    setVisibility('hidden')
    await Promise.resolve()

    expect(sent.filter((n) => n === 'purchase')).toHaveLength(1)
  })

  it('anything still queued leaves by beacon when the page hides', async () => {
    Vio.analytics.track('view_item', { commerce: { items: [{ productId: 1 }] } })
    expect(sent).not.toContain('view_item')
    setVisibility('hidden')
    expect(sent).toContain('view_item')
    expect((navigator as any).sendBeacon).toHaveBeenCalledTimes(1)
  })
})
