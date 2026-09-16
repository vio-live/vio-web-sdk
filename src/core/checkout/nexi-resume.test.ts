// @vitest-environment jsdom
/**
 * A remembered Nexi session is resumed only on the redirect return it exists
 * for.
 *
 * 2026-09-16, testing on bohus-demo: three lamps went through Nexi (2 247 kr),
 * the cart was emptied, an armchair (4 999 kr) went to the checkout — and Nexi
 * opened the LAMPS' payment. The session kept for the Vipps/Swish/MobilePay
 * return was read on every opening, so the next purchase in the same tab
 * reused the previous cart's payment: its lines and its total.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const widgetEvents: Record<string, (...a: any[]) => void> = {}

vi.mock('./payments/nexi.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./payments/nexi.js')>()
  return {
    ...real,
    createPaymentNexi: vi.fn(async () => ({
      order_id: 'NEW', status: 'Created', checkout_key: 'k', checkout_js_url: 'x', total_price: 4999,
    })),
    getNexiOrder: vi.fn(async () => ({
      order_id: 'OLD', status: 'Created', checkout_key: 'k', checkout_js_url: 'x', total_price: 2247,
    })),
    updateNexiShipping: vi.fn(async () => ({ ok: true, order_id: 'OLD', shipping_id: '10' })),
    mountNexi: vi.fn(async () => ({
      on: (event: string, cb: (...a: any[]) => void) => { widgetEvents[event] = cb },
      freezeCheckout: () => {}, thawCheckout: () => {}, cleanup: () => {},
    })),
  }
})
vi.mock('../api/cart-queries.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api/cart-queries.js')>()
  return { ...real, getCartGraphQLOptions: vi.fn(async () => ({})) }
})

import { CheckoutManager } from './checkout-manager.js'
import * as nexi from './payments/nexi.js'

const SPONSOR = 5

function manager() {
  const cart = {
    getCart: () => ({ cartId: 'cart-2', items: [{ id: 'armchair' }] }),
    ensureCartId: async () => 'cart-2',
    subtotalForSponsor: () => 4999,
  }
  const m = new CheckoutManager(cart as never) as any
  vi.spyOn(m, 'createCheckout').mockResolvedValue({ id: 'CHK-NEW' })
  m.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK' }
  return m
}

beforeEach(() => {
  // What the previous purchase in this tab left behind.
  nexi.rememberNexiPending({ checkoutId: 'CHK-OLD', sponsorId: SPONSOR, paymentId: 'OLD' })
  vi.mocked(nexi.createPaymentNexi).mockClear()
  vi.mocked(nexi.getNexiOrder).mockClear()
})

afterEach(() => {
  nexi.clearNexiPending()
})

describe('CheckoutManager.mountNexiCheckout — resuming', () => {
  it('a normal opening creates a payment for the cart as it is', async () => {
    const m = manager()
    const order = await m.mountNexiCheckout(document.createElement('div'), SPONSOR)

    expect(order.order_id).toBe('NEW')
    expect(nexi.getNexiOrder).not.toHaveBeenCalled()
    expect(nexi.createPaymentNexi).toHaveBeenCalledWith(
      expect.objectContaining({ checkoutId: 'CHK-NEW' }),
      expect.anything(),
    )
    // …and it becomes the session a redirect would resume.
    expect(nexi.readNexiPending()).toMatchObject({ checkoutId: 'CHK-NEW', paymentId: 'NEW' })
  })

  it('the ?paymentId= return resumes the remembered payment', async () => {
    const m = manager()
    const order = await m.mountNexiCheckout(document.createElement('div'), SPONSOR, {}, { paymentId: 'OLD' })

    expect(order.order_id).toBe('OLD')
    expect(nexi.getNexiOrder).toHaveBeenCalledWith('CHK-OLD', expect.anything())
    expect(nexi.createPaymentNexi).not.toHaveBeenCalled()
  })

  it('a return naming another payment does not resume this one', async () => {
    const m = manager()
    const order = await m.mountNexiCheckout(document.createElement('div'), SPONSOR, {}, { paymentId: 'SOMETHING-ELSE' })

    expect(order.order_id).toBe('NEW')
    expect(nexi.getNexiOrder).not.toHaveBeenCalled()
  })

  it('a resumed payment hands over the shipping it carries, and a pick re-prices that address', async () => {
    // The widget comes back with the address filled in and Nexi does not
    // announce it again: without this the rates never showed.
    const carried = {
      ok: true, order_id: 'OLD', shipping_id: '10', shipping_name: 'Standard', shipping_price: 199,
      options: [{ id: '10', name: 'Standard', price: 199 }, { id: '20', name: 'Express', price: 300 }],
      country: 'NO', postal_code: '0250',
    }
    vi.mocked(nexi.getNexiOrder).mockResolvedValueOnce({
      order_id: 'OLD', status: 'Created', checkout_key: 'k', checkout_js_url: 'x', shipping: carried,
    } as never)
    const onShipping = vi.fn()
    const m = manager()
    await m.mountNexiCheckout(document.createElement('div'), SPONSOR, { onShipping }, { paymentId: 'OLD' })

    expect(onShipping).toHaveBeenCalledWith(carried)

    await m.pickNexiShipping('20')
    expect(nexi.updateNexiShipping).toHaveBeenCalledWith(
      { checkoutId: 'CHK-OLD', countryCode: 'NO', postalCode: '0250', shippingId: '20' },
      expect.anything(),
    )
  })

  it('a payment with no shipping state hands over nothing', async () => {
    const onShipping = vi.fn()
    const m = manager()
    await m.mountNexiCheckout(document.createElement('div'), SPONSOR, { onShipping })
    expect(onShipping).not.toHaveBeenCalled()
  })

  it('a new payment offers its rates at once; a pick is remembered and asked for with the address', async () => {
    const preview = {
      ok: false, reason: 'AWAITING_ADDRESS', order_id: 'NEW', shipping_id: '10',
      shipping_name: 'Standard', shipping_price: 199, country: 'NO',
      options: [{ id: '10', name: 'Standard', price: 199 }, { id: '20', name: 'Express', price: 300 }],
    }
    vi.mocked(nexi.createPaymentNexi).mockResolvedValueOnce({
      order_id: 'NEW', status: 'Created', checkout_key: 'k', checkout_js_url: 'x', shipping: preview,
    } as never)
    vi.mocked(nexi.updateNexiShipping).mockClear()
    const onShipping = vi.fn()
    const m = manager()
    await m.mountNexiCheckout(document.createElement('div'), SPONSOR, { onShipping })
    expect(onShipping).toHaveBeenLastCalledWith(preview)

    // Picked before any address: shown, nothing sent.
    await m.pickNexiShipping('20')
    expect(nexi.updateNexiShipping).not.toHaveBeenCalled()
    expect(onShipping).toHaveBeenLastCalledWith(expect.objectContaining({ shipping_id: '20', shipping_price: 300 }))

    // The address arrives: the pick travels with it.
    widgetEvents['address-changed']!({ countryCode: 'NOR', postalCode: '0250' })
    await new Promise((r) => setTimeout(r, 0))
    expect(nexi.updateNexiShipping).toHaveBeenCalledWith(
      { checkoutId: 'CHK-NEW', countryCode: 'NOR', postalCode: '0250', shippingId: '20' },
      expect.anything(),
    )
  })
})
