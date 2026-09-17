// @vitest-environment jsdom
/**
 * Adyen at the manager: our form first, a session that is a photo, and a
 * "Pay" that only verifies.
 *
 * Adyen collects no email, address or shipping — so before a session exists
 * the shopper's form has to be SAVED on the checkout, and the session has to
 * be created from that. And nothing that changes the amount may happen at
 * pay time (lesson 2026-09-17, payment f6116e6d…): "Pay" asks the backend
 * whether the session still pays for the checkout, and if not, Adyen is
 * stopped and the caller told to start over.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let handlers: any

vi.mock('./payments/adyen.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./payments/adyen.js')>()
  return {
    ...real,
    createPaymentAdyen: vi.fn(async () => ({
      order_id: 'CS1', session_id: 'CS1', session_data: 'DATA', client_key: 'test_K', environment: 'test',
      country_code: 'NO', shopper_locale: 'no-NO', purchase_currency: 'NOK', amount: 519800, total_price: 5198,
    })),
    getAdyenPayment: vi.fn(async () => ({ order_id: 'CS1', status: 'authorised', psp_reference: 'PSP1', order_created: false })),
    confirmAdyenPayment: vi.fn(async () => ({ ok: true })),
    mountAdyen: vi.fn(async (_container: unknown, _session: unknown, h: unknown) => {
      handlers = h
      return { sessionId: 'CS1', unmount: vi.fn() }
    }),
  }
})
vi.mock('../api/cart-queries.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api/cart-queries.js')>()
  return {
    ...real,
    getCartGraphQLOptions: vi.fn(async () => ({})),
    updateCheckout: vi.fn(async () => ({ id: 'CHK-1' })),
    createCheckout: vi.fn(async () => ({ id: 'CHK-1' })),
  }
})

import { CheckoutManager } from './checkout-manager.js'
import * as adyen from './payments/adyen.js'
import * as cartQueries from '../api/cart-queries.js'

const SPONSOR = 5
const FORM = {
  firstName: 'Kari', lastName: 'Nordmann', email: 'kari@example.no',
  address: 'Storgata 12B', postalCode: '0194', city: 'Oslo',
}

function manager() {
  const cart = {
    getCart: () => ({ cartId: 'cart-1', items: [{ id: 'armchair' }] }),
    ensureCartId: async () => 'cart-1',
    subtotalForSponsor: () => 4999,
  }
  const m = new CheckoutManager(cart as never) as any
  m.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK', checkoutId: 'CHK-1' }
  return m
}

const callbacks = () => ({ onCompleted: vi.fn(), onFailed: vi.fn(), onReplaced: vi.fn(), onError: vi.fn() })

const setLocation = (href: string) =>
  window.history.replaceState({}, '', href.replace(/^https?:\/\/[^/]+/, ''))

beforeEach(() => {
  vi.mocked(adyen.createPaymentAdyen).mockClear()
  vi.mocked(adyen.confirmAdyenPayment).mockClear()
  vi.mocked(adyen.getAdyenPayment).mockClear()
  vi.mocked(cartQueries.updateCheckout).mockClear()
})
afterEach(() => setLocation('/'))

describe('CheckoutManager.mountAdyenCheckout', () => {
  it("saves the shopper's form on the checkout BEFORE the session is created from it", async () => {
    const order: string[] = []
    vi.mocked(cartQueries.updateCheckout).mockImplementationOnce(async () => {
      order.push('form saved')
      return { id: 'CHK-1' }
    })
    vi.mocked(adyen.createPaymentAdyen).mockImplementationOnce(async (...a: any[]) => {
      order.push('session created')
      return (await (adyen.createPaymentAdyen as any).getMockImplementation?.()?.(...a)) ?? ({ session_id: 'CS1' } as any)
    })
    const m = manager()
    await m.mountAdyenCheckout(document.createElement('div'), SPONSOR, FORM, callbacks())

    expect(order).toEqual(['form saved', 'session created'])
    expect(cartQueries.updateCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutId: 'CHK-1',
        email: 'kari@example.no',
        paymentMethod: 'Adyen',
        buyerAcceptsPurchaseConditions: true,
        shippingAddress: expect.anything(),
      }),
      expect.anything(),
    )
  })

  it('names the checkout in the return URL — no storage needed to come back', async () => {
    setLocation('/artikkel?utm=x&redirectResult=OLD&sessionId=OLDSESSION')
    const m = manager()
    await m.mountAdyenCheckout(document.createElement('div'), SPONSOR, FORM, callbacks())
    const vars = vi.mocked(adyen.createPaymentAdyen).mock.calls[0]![0] as any
    const url = new URL(vars.returnUrl)

    expect(url.searchParams.get('vio_method')).toBe('adyen')
    expect(url.searchParams.get('checkout_id')).toBe('CHK-1')
    expect(url.searchParams.get('vio_sponsor')).toBe(String(SPONSOR))
    expect(url.searchParams.get('utm')).toBe('x') // the publisher's own query survives
    // A pair left by an earlier return is never sent back to Adyen.
    expect(url.searchParams.has('redirectResult')).toBe(false)
    expect(url.searchParams.has('sessionId')).toBe(false)
    // No personal data in a URL Adyen stores and logs.
    expect(vars.returnUrl).not.toContain('kari')
    expect(vars).toMatchObject({ checkoutId: 'CHK-1', channel: 'Web', email: 'kari@example.no' })
    expect(vars.client).toMatch(/^web-sdk \d+\.\d+\.\d+/)
  })

  it("drops the page's own query when the URL would exceed Adyen's 1024 characters", async () => {
    setLocation(`/artikkel?tracking=${'a'.repeat(1200)}`)
    const m = manager()
    await m.mountAdyenCheckout(document.createElement('div'), SPONSOR, FORM, callbacks())
    const { returnUrl } = vi.mocked(adyen.createPaymentAdyen).mock.calls[0]![0] as any

    expect(returnUrl.length).toBeLessThanOrEqual(1024)
    expect(returnUrl).toContain('/artikkel')
    expect(returnUrl).toContain('checkout_id=CHK-1')
    expect(returnUrl).not.toContain('tracking=')
  })

  it('"Pay" charges only when the backend confirms THIS session', async () => {
    const m = manager()
    const cb = callbacks()
    await m.mountAdyenCheckout(document.createElement('div'), SPONSOR, FORM, cb)

    expect(await handlers.onBeforePay()).toBe(true)
    expect(adyen.confirmAdyenPayment).toHaveBeenCalledWith({ checkoutId: 'CHK-1', sessionId: 'CS1' }, expect.anything())
    expect(cb.onReplaced).not.toHaveBeenCalled()

    vi.mocked(adyen.confirmAdyenPayment).mockResolvedValueOnce({ ok: false, reason: 'AMOUNT_CHANGED' })
    expect(await handlers.onBeforePay()).toBe(false)
    expect(cb.onReplaced).toHaveBeenCalledWith('AMOUNT_CHANGED')

    // No answer is not a yes.
    vi.mocked(adyen.confirmAdyenPayment).mockResolvedValueOnce(null)
    expect(await handlers.onBeforePay()).toBe(false)
  })

  it("asks ADYEN (through the backend) what happened — the browser's result is not the answer", async () => {
    const m = manager()
    const cb = callbacks()
    await m.mountAdyenCheckout(document.createElement('div'), SPONSOR, FORM, cb)
    handlers.onCompleted({ resultCode: 'Authorised', sessionResult: 'SR' })
    await vi.waitFor(() => expect(cb.onCompleted).toHaveBeenCalled())

    expect(adyen.getAdyenPayment).toHaveBeenCalledWith({ checkoutId: 'CHK-1', sessionResult: 'SR' }, expect.anything())
    expect(cb.onCompleted.mock.calls[0]![0]).toMatchObject({ status: 'authorised', psp_reference: 'PSP1' })
  })

  it('still reports completion when the read fails — with no payment, never a made-up one', async () => {
    vi.mocked(adyen.getAdyenPayment).mockRejectedValueOnce(new Error('network'))
    const m = manager()
    const cb = callbacks()
    await m.mountAdyenCheckout(document.createElement('div'), SPONSOR, FORM, cb)
    handlers.onCompleted({ resultCode: 'Authorised', sessionResult: 'SR' })
    await vi.waitFor(() => expect(cb.onCompleted).toHaveBeenCalled())
    expect(cb.onCompleted.mock.calls[0]![0]).toBeNull()
  })

  it('refuses to start without an email: the order would have nowhere to go', async () => {
    const m = manager()
    await expect(
      m.mountAdyenCheckout(document.createElement('div'), SPONSOR, { ...FORM, email: '' }, callbacks()),
    ).rejects.toThrow(/email/)
    expect(adyen.createPaymentAdyen).not.toHaveBeenCalled()
  })

  it('a new mount takes the previous Drop-in down first; destroy is safe when idle', async () => {
    const m = manager()
    m.destroyAdyen()
    await m.mountAdyenCheckout(document.createElement('div'), SPONSOR, FORM, callbacks())
    const first = m.adyenHandle
    await m.mountAdyenCheckout(document.createElement('div'), SPONSOR, FORM, callbacks())
    expect(first.unmount).toHaveBeenCalled()
    m.destroyAdyen()
    expect(m.adyenHandle).toBeNull()
  })

  it('reads a redirect return through the backend', async () => {
    const m = manager()
    await m.getAdyenPayment('CHK-1', { redirectResult: 'RR' }, SPONSOR)
    expect(adyen.getAdyenPayment).toHaveBeenCalledWith({ checkoutId: 'CHK-1', redirectResult: 'RR' }, expect.anything())
  })
})
