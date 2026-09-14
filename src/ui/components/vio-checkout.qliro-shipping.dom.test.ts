// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'
import { formatPrice } from '../../core/types.js'

/**
 * With Qliro the shipping is chosen INSIDE the widget (and, once nShift runs,
 * by nShift through it). Our summary next to the widget has to show the same
 * rate and total the customer is looking at — before this it kept showing
 * our own preselected rate whatever they picked in Qliro.
 */
const manager = Vio.checkout as any
const CHEAP = { id: 'sc-cheap', supplierId: '7', method: 'from seller in not', name: 'from seller in not', price: 10000, priceMajor: 100, currency: 'NOK' }
const DEAR = { id: 'sc-dear', supplierId: '7', method: 'other to NO', name: 'other to NO', price: 20000, priceMajor: 200, currency: 'NOK' }
const ITEM = { id: 'li-1', name: 'Sofa', brand: 'Bohus', quantity: 1, unitPrice: 4999, currency: 'NOK' }

beforeEach(() => {
  const proto = VioCheckout.prototype as any
  for (const m of ['loadAvailablePaymentMethods', 'loadAvailableShippings', 'refreshApplePay', 'refreshKlarna']) {
    vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(manager, 'mountQliroCheckout').mockImplementation(async (...args: unknown[]) => {
    ;(args[0] as HTMLElement).innerHTML = '<iframe></iframe>'
    return { order_id: 'QLIRO-1', html_snippet: '' }
  })
})

afterEach(() => {
  unmountAll()
  manager.state = null
  vi.restoreAllMocks()
})

async function qliroCheckout(extra: Record<string, unknown> = {}) {
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  Object.assign(el, {
    open: true,
    items: [ITEM],
    availableMethods: ['Qliro', 'Stripe'],
    paymentMethodsResolved: true,
    availableShippingsList: [CHEAP, DEAR],
    selectedShipping: CHEAP.id,
    checkoutState: { sponsorId: 5, currency: 'NOK', subtotal: 4999, paymentMethod: 'qliro' },
    ...extra,
  })
  for (let i = 0; i < 4; i++) await settle(el)
  return el
}

function qliroSays(detail: Record<string, unknown>) {
  manager.dispatchEvent(new CustomEvent('qliro-event', { detail }))
}

describe('vio-checkout — shipping chosen inside Qliro', () => {
  it('opens on our preselected rate (the cheapest)', async () => {
    const el = await qliroCheckout()
    expect(shadowText(el)).toContain('Frakt – from seller in not')
    expect(shadowText(el)).toContain(formatPrice(4999 + 100, 'NOK'))
  })

  it('follows the rate the customer picks in the widget', async () => {
    const el = await qliroCheckout()
    qliroSays({ type: 'shipping-changed', shipping: { method: DEAR.id } })
    qliroSays({ type: 'shipping-price-changed', price: 200, totalPrice: 5199 })
    for (let i = 0; i < 3; i++) await settle(el)
    const text = shadowText(el)
    expect(text).toContain('Frakt – other to NO')
    expect(text).not.toContain('from seller in not')
    expect(text).toContain(formatPrice(4999 + 200, 'NOK'))
  })

  it('shows the price Qliro reports even for a rate it cannot name', async () => {
    const el = await qliroCheckout()
    qliroSays({ type: 'shipping-price-changed', price: 149, totalPrice: 5148 })
    for (let i = 0; i < 3; i++) await settle(el)
    expect(shadowText(el)).toContain(formatPrice(4999 + 149, 'NOK'))
  })

  it('ignores Qliro when another method is chosen', async () => {
    const el = await qliroCheckout({
      checkoutState: { sponsorId: 5, currency: 'NOK', subtotal: 4999, paymentMethod: 'stripe' },
    })
    qliroSays({ type: 'shipping-price-changed', price: 200, totalPrice: 5199 })
    for (let i = 0; i < 3; i++) await settle(el)
    expect(shadowText(el)).toContain(formatPrice(4999 + 100, 'NOK'))
  })

  it('forgets what Qliro said once the checkout closes', async () => {
    const el = await qliroCheckout()
    qliroSays({ type: 'shipping-price-changed', price: 200, totalPrice: 5199 })
    await settle(el)
    el.close()
    for (let i = 0; i < 3; i++) await settle(el)
    expect(el.qliroShipping).toBeNull()
  })
})
