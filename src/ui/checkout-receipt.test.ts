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

  it('nothing to print: null', () => {
    expect(receiptFromCheckout({ status: 'SUCCESS' }, 7)).toBeNull()
    expect(receiptFromCheckout({ cart: { line_items: [] } }, 7)).toBeNull()
    expect(receiptFromCheckout(null, 7)).toBeNull()
  })
})
