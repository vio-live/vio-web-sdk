// @vitest-environment jsdom
/**
 * The cart drawer and a discount code: «Sum» stays the lines at their list
 * prices, and what is paid — «Totalt», and whether there is anything to pay
 * at all — is those less what the code takes off them. A cart of a gift
 * alone costs nothing: nothing in the footer starts a payment for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'

const SPONSOR = 5
const rate = (amount: number) => ({ id: 'r', name: 'Posten', price: { amount: amount * 0.8, amount_incl_taxes: amount, currency_code: 'NOK' } })
const CREAM = { id: 'c', productId: 100, sponsorId: SPONSOR, brand: 'Faves', name: 'Krem', quantity: 1, unitPrice: 349, currency: 'NOK', imageUrl: '' }
const MASK = { id: 'm', productId: 421306, sponsorId: SPONSOR, brand: 'Faves', name: 'Face mask', quantity: 1, unitPrice: 52, discount: 52, currency: 'NOK', imageUrl: '' }

type CartEl = HTMLElement & Record<string, any>

async function cart(items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Promise<CartEl> {
  const el = await mount<CartEl>('vio-cart')
  el.carts = new Map([[SPONSOR, { sponsorId: SPONSOR, currency: 'NOK', items, ...extra }]])
  el.itemCount = items.reduce((n, i) => n + Number(i.quantity), 0)
  el.open = true
  await settle(el)
  return el
}
const row = (el: HTMLElement, sel: string) => el.shadowRoot!.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim()

beforeEach(() => {
  vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Vipps' }] as any)
  vi.spyOn(Vio.cart, 'refreshFromServer').mockResolvedValue(undefined as any)
})

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

describe('what is paid', () => {
  it('«Sum» is the list prices; «Totalt» is those less the discount, plus the shipping', async () => {
    const el = await cart([{ ...CREAM, shipping: rate(49) }, MASK])
    expect(row(el, '.subtotal-row')).toBe('Sum 401 Kr')
    expect(row(el, '.shipping-row')).toBe('Frakt 49 Kr')
    expect(row(el, '.total-row')).toBe('Totalt 398 Kr')
  })

  it('a percentage on every line', async () => {
    const el = await cart([
      { ...CREAM, quantity: 2, discount: 69.8, shipping: rate(0) },
      { ...MASK, discount: 5.2 },
    ])
    expect(row(el, '.subtotal-row')).toBe('Sum 750 Kr')
    expect(row(el, '.total-row')).toBe('Totalt 675 Kr')
  })

  it('without a discount the footer is the one it always was', async () => {
    const el = await cart([{ ...CREAM, shipping: rate(49) }, { ...MASK, discount: undefined }])
    expect(row(el, '.subtotal-row')).toBe('Sum 401 Kr')
    expect(row(el, '.total-row')).toBe('Totalt 450 Kr')
  })
})

describe('a cart of a gift alone', () => {
  it('nothing to pay: «Til kassen» is off, and neither it nor the Vipps button starts anything', async () => {
    const express = vi.spyOn(Vio.checkout, 'startVippsExpress').mockResolvedValue({ payment_url: 'https://vipps.test' } as any)
    const el = await cart([MASK])
    const opened = vi.fn()
    el.addEventListener('vio:checkout-open', opened)

    const checkout = el.shadowRoot!.querySelector<HTMLButtonElement>('.checkout-btn')!
    expect(checkout.disabled).toBe(true)
    checkout.click()
    el.shadowRoot!.querySelector<HTMLElement>('.vipps-btn, .vipps-btn-official')?.click()
    await settle(el)

    expect(opened).not.toHaveBeenCalled()
    expect(express).not.toHaveBeenCalled()
  })

  it('with something to pay beside it, the cart is paid as any other', async () => {
    const el = await cart([CREAM, MASK])
    const opened = vi.fn()
    el.addEventListener('vio:checkout-open', opened)
    const checkout = el.shadowRoot!.querySelector<HTMLButtonElement>('.checkout-btn')!
    expect(checkout.disabled).toBe(false)
    checkout.click()
    expect(opened).toHaveBeenCalledTimes(1)
  })
})
