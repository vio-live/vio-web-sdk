import { describe, it, expect } from 'vitest'
import { receiptFromCheckout } from './checkout-receipt.js'

const line = (over: Record<string, unknown> = {}) => ({
  id: 'li-1',
  product_id: 101,
  variant_id: 11,
  brand: 'Careless',
  title: 'Genser',
  variant_title: 'M',
  quantity: 1,
  image: [{ url: 'https://img.example/genser.jpg' }],
  price: { amount: 1038.4, amount_incl_taxes: 1298, currency_code: 'NOK' },
  shipping: { id: 'free', name: 'Gratis frakt' },
  ...over,
})

describe('receiptFromCheckout', () => {
  it('reads a line as the cart does: «title — variant», price incl. taxes, first image', () => {
    const r = receiptFromCheckout({ cart: { currency: 'NOK', line_items: [line()] } }, 7)!
    expect(r.items).toEqual([
      expect.objectContaining({
        id: 'li-1',
        productId: 101,
        variantId: 11,
        sponsorId: 7,
        brand: 'Careless',
        name: 'Genser — M',
        unitPrice: 1298,
        currency: 'NOK',
        imageUrl: 'https://img.example/genser.jpg',
        quantity: 1,
      }),
    ])
  })

  it('a free rate is a shipping row at 0 («Gratis»), not a missing one', () => {
    const r = receiptFromCheckout(
      { cart: { line_items: [line()] }, totals: { currency_code: 'NOK', shipping: 0, total: 1298 } },
      7,
    )!
    expect(r.shipping).toEqual({ name: 'Gratis frakt', price: 0 })
    expect(r.total).toBe(1298)
    expect(r.currency).toBe('NOK')
  })

  it('no line was shipped and nothing was charged for it (a digital product): no shipping row', () => {
    const r = receiptFromCheckout({ cart: { line_items: [line({ shipping: null })] }, totals: { shipping: 0, total: 1298 } }, 7)!
    expect(r.shipping).toBeUndefined()
  })

  it('without totals: the total is the lines plus the shipping, and numeric strings count', () => {
    const r = receiptFromCheckout(
      {
        cart: {
          shipping: '49',
          line_items: [line({ quantity: 2, price: { amount_incl_taxes: '100.5' }, shipping: { name: 'Posten' } })],
        },
      },
      7,
    )!
    expect(r.shipping).toEqual({ name: 'Posten', price: 49 })
    expect(r.total).toBe(250)
  })

  it('a discount code: each line keeps its list price and what the code took off it, and the receipt says the discount', () => {
    const r = receiptFromCheckout(
      {
        discount_code: 'gratis_face_mask',
        cart: {
          currency: 'NOK',
          line_items: [
            line({ price: { amount_incl_taxes: 349, currency_code: 'NOK', discount: 0 } }),
            line({ id: 'li-2', product_id: 421306, title: 'Face mask', variant_title: '', price: { amount_incl_taxes: 52, currency_code: 'NOK', discount: 52 } }),
          ],
        },
        totals: { currency_code: 'NOK', shipping: 49, total: 398, discounts: 52 },
      },
      7,
    )!
    expect(r.items[0]).toMatchObject({ unitPrice: 349 })
    expect(r.items[0]).not.toHaveProperty('discount')
    expect(r.items[1]).toMatchObject({ unitPrice: 52, quantity: 1, discount: 52 })
    expect(r.discount).toEqual({ amount: 52, code: 'gratis_face_mask' })
    // The checkout's own total, already less the discount.
    expect(r.total).toBe(398)
  })

  it('without the checkout\'s total: the lines less their discounts, plus the shipping', () => {
    const r = receiptFromCheckout(
      {
        cart: {
          shipping: 49,
          line_items: [
            line({ quantity: 2, price: { amount_incl_taxes: 349, discount: '69.8' } }),
            line({ id: 'li-2', price: { amount_incl_taxes: 52, discount: 52 } }),
          ],
        },
      },
      7,
    )!
    expect(r.total).toBe(628.2 + 49)
    expect(r.discount).toEqual({ amount: 121.8 })
  })

  it('lines that do not say their discount: the checkout\'s own figure is the discount', () => {
    const r = receiptFromCheckout(
      { discount_code: 'TI', cart: { line_items: [line()] }, totals: { total: 1168.2, discounts: '129.8' } },
      7,
    )!
    expect(r.discount).toEqual({ amount: 129.8, code: 'TI' })
    expect(r.total).toBe(1168.2)
  })

  it('no discount: the receipt does not name one, even when the checkout carries a code that took nothing off', () => {
    expect(receiptFromCheckout({ cart: { line_items: [line()] }, totals: { total: 1298, discounts: 0 } }, 7)).not.toHaveProperty('discount')
    expect(
      receiptFromCheckout({ discount_code: 'gratis_face_mask', cart: { line_items: [line({ price: { amount_incl_taxes: 1298, discount: 0 } })] } }, 7),
    ).not.toHaveProperty('discount')
  })

  it('nothing to print: null', () => {
    expect(receiptFromCheckout({ status: 'SUCCESS' }, 7)).toBeNull()
    expect(receiptFromCheckout({ cart: { line_items: [] } }, 7)).toBeNull()
    expect(receiptFromCheckout(null, 7)).toBeNull()
  })
})
