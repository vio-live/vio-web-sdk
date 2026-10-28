import { afterEach, describe, expect, it, vi } from 'vitest'
import { CheckoutManager } from './checkout-manager.js'
import * as cartQueries from '../api/cart-queries.js'
import * as vipps from './payments/vipps.js'
import { parsePhone } from './phone.js'

/**
 * The checkout's Vipps is the standard payment (Mote & Livsstil,
 * 2026-10-28): `express: false`, and the form's address — with the mobile
 * number — goes on the checkout's shipping and billing address before the
 * payment is created. Express (from the product detail) still sends none.
 */

const FORM = {
  firstName: 'Kari', lastName: 'Nordmann', email: 'kari@example.no', phone: '+47 912 34 567',
  address: 'Storgata 12B', postalCode: '0194', city: 'Oslo',
}

afterEach(() => {
  vi.restoreAllMocks()
})

function manager() {
  const cart = { cartId: 'cart-1', items: [{ id: 'l1', unitPrice: 699, quantity: 1 }] }
  const cm = {
    waitForCartMutations: async () => {},
    refreshFromServer: async () => undefined,
    getCart: () => cart,
    ensureCartId: async () => 'cart-1',
    subtotalForSponsor: () => 699,
  }
  const m = new CheckoutManager(cm as never) as any
  m.state = { sponsorId: 5, subtotal: 699, currency: 'NOK', checkoutId: 'CHK-1' }
  vi.spyOn(CheckoutManager as any, 'redirectTo').mockImplementation(() => undefined)
  return m
}

function spies() {
  vi.spyOn(cartQueries, 'getCartGraphQLOptions').mockResolvedValue({} as any)
  const update = vi.spyOn(cartQueries, 'updateCheckout').mockResolvedValue({ id: 'CHK-1' } as any)
  const pay = vi.spyOn(vipps, 'createPaymentVipps').mockResolvedValue({ payment_url: 'https://pay.vipps.no/x' } as any)
  return { update, pay }
}

describe('the standard Vipps payment (express: false)', () => {
  it('puts the form’s address, with the mobile as phone + phone_code, on shipping and billing', async () => {
    const { update, pay } = spies()
    const m = manager()
    await m.startVippsPayment(5, FORM, { express: false })
    const vars = update.mock.calls[0]![0] as Record<string, any>
    const expected = {
      first_name: 'Kari', last_name: 'Nordmann', address1: 'Storgata 12B', city: 'Oslo', zip: '0194',
      phone: '91234567', phone_code: '47',
    }
    expect(vars.shippingAddress).toMatchObject(expected)
    expect(vars.billingAddress).toMatchObject(expected)
    expect(vars.paymentMethod).toBe('Vipps')
    expect(pay.mock.calls[0]![0]).toMatchObject({ checkoutId: 'CHK-1', express: false, email: 'kari@example.no' })
  })

  it('an incomplete address (or no mobile) creates no checkout update and no payment — a clear error first', async () => {
    for (const form of [{ ...FORM, address: '' }, { ...FORM, phone: '' }, { ...FORM, phone: '12' }]) {
      const { update, pay } = spies()
      const m = manager()
      await expect(m.startVippsPayment(5, form, { express: false })).rejects.toThrow(/complete delivery address/)
      expect(update).not.toHaveBeenCalled()
      expect(pay).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    }
  })

  it('a Swedish number on a Swedish address goes with phone_code 46', async () => {
    const { update } = spies()
    const m = manager()
    await m.startVippsPayment(5, { ...FORM, country: 'SE', phone: '070-123 45 67' }, { express: false })
    expect((update.mock.calls[0]![0] as any).shippingAddress).toMatchObject({ phone: '701234567', phone_code: '46' })
  })

  it('Express (the product detail’s) still sends no address', async () => {
    const { update, pay } = spies()
    const m = manager()
    await m.startVippsExpress(5)
    expect(update.mock.calls[0]![0]).not.toHaveProperty('shippingAddress')
    expect(pay.mock.calls[0]![0]).toMatchObject({ express: true })
  })

  it('other methods carry the mobile too (Stripe link)', async () => {
    vi.spyOn(cartQueries, 'getCartGraphQLOptions').mockResolvedValue({} as any)
    const update = vi.spyOn(cartQueries, 'updateCheckout').mockResolvedValue({ id: 'CHK-1' } as any)
    vi.spyOn(cartQueries, 'createPaymentStripe').mockResolvedValue({ checkout_url: 'https://checkout.stripe.com/x' } as any)
    const m = manager()
    await m.startStripePayment(5, FORM)
    expect((update.mock.calls[0]![0] as any).shippingAddress).toMatchObject({ phone: '91234567', phone_code: '47' })
  })
})

describe('the mobile number', () => {
  it('Norwegian: eight digits, with or without +47 / 0047, spaces and dashes', () => {
    for (const ok of ['91234567', '912 34 567', '+47 912 34 567', '+4791234567', '0047 91234567', '912-34-567']) {
      expect(parsePhone(ok, 'NO'), ok).toEqual({ phone: '91234567', phone_code: '47' })
    }
    for (const bad of ['', '1234567', '912345678', 'abcdefgh', null, undefined]) {
      expect(parsePhone(bad, 'NO'), String(bad)).toBeNull()
    }
  })

  it('an explicit +prefix names the country, whatever the shipping country', () => {
    expect(parsePhone('+46 70 123 45 67', 'NO')).toEqual({ phone: '701234567', phone_code: '46' })
    expect(parsePhone('+358 40 1234567', 'NO')).toEqual({ phone: '401234567', phone_code: '358' })
    expect(parsePhone('+45 20 12 34 56', 'NO')).toEqual({ phone: '20123456', phone_code: '45' })
    expect(parsePhone('+49 151 23456789', 'NO')).toEqual({ phone: '15123456789', phone_code: '49' })
    expect(parsePhone('+44 7700 900123', 'NO')).toEqual({ phone: '7700900123', phone_code: '44' })
  })

  it('without a prefix, the shipping country’s code — the trunk 0 dropped', () => {
    expect(parsePhone('070-123 45 67', 'SE')).toEqual({ phone: '701234567', phone_code: '46' })
    expect(parsePhone('07700 900123', 'GB')).toEqual({ phone: '7700900123', phone_code: '44' })
    expect(parsePhone('20123456', 'DK')).toEqual({ phone: '20123456', phone_code: '45' })
    // An unknown country with no prefix: not usable.
    expect(parsePhone('12345678', 'ZZ')).toBeNull()
  })
})
