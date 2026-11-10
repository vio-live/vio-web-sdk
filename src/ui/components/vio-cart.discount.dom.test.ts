// @vitest-environment jsdom
/**
 * The cart drawer and a discount code.
 *
 * What is paid: «Sum» stays the lines at their list prices, a «Rabatt» row
 * says what the code takes off them, and «Totalt» — and whether there is
 * anything to pay at all — is the difference, so the rows add up.
 *
 * How it shows: a line the code takes something off has its list price
 * struck through and then what it costs — «Gratis» when the code gives it
 * away, and then its «+» does nothing (a gift is one unit). A cart of the
 * gift alone costs nothing: nothing in the footer starts a payment for it,
 * and a line says why. A cart without a discount is drawn as it always was.
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
  el.availableMethods = ['Vipps']
  el.open = true
  await settle(el)
  return el
}
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim()
const row = (el: HTMLElement, sel: string) => text(el.shadowRoot!.querySelector(sel))
/** The drawn lines, by the order of the cart. */
const lines = (el: HTMLElement) => [...el.shadowRoot!.querySelectorAll<HTMLElement>('.item')]
const plus = (line: HTMLElement) => line.querySelector<HTMLButtonElement>('[data-vio-cta="quantity_plus"]')!

beforeEach(() => {
  vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Vipps' }] as any)
  vi.spyOn(Vio.cart, 'refreshFromServer').mockResolvedValue(undefined as any)
  vi.spyOn(Vio.cart, 'waitForCartMutations').mockResolvedValue(undefined as any)
})

afterEach(() => {
  unmountAll()
  document.querySelectorAll('.vio-redirect-overlay').forEach((n) => n.remove())
  vi.restoreAllMocks()
})

describe('what is paid', () => {
  it('«Sum» is the list prices; «Rabatt» what the code takes off; «Totalt» the difference, plus the shipping', async () => {
    const el = await cart([{ ...CREAM, shipping: rate(49) }, MASK], { discountCode: 'gratis_face_mask' })
    expect(row(el, '.subtotal-row')).toBe('Sum 401 Kr')
    expect(row(el, '.discount-row')).toBe('Rabatt (gratis_face_mask) −52 Kr')
    expect(row(el, '.shipping-row')).toBe('Frakt 49 Kr')
    expect(row(el, '.total-row')).toBe('Totalt 398 Kr')
    // In that order: the rows add up as they are read.
    const order = [...el.shadowRoot!.querySelectorAll('.subtotal-row, .discount-row, .shipping-row, .total-row')].map((n) => n.className)
    expect(order).toEqual(['subtotal-row', 'discount-row', 'shipping-row', 'total-row'])
  })

  it('a percentage on every line', async () => {
    const el = await cart([
      { ...CREAM, quantity: 2, discount: 69.8, shipping: rate(0) },
      { ...MASK, discount: 5.2 },
    ])
    expect(row(el, '.subtotal-row')).toBe('Sum 750 Kr')
    // The code is not known here (a cart read before the server said it): the row says «Rabatt».
    expect(row(el, '.discount-row')).toBe('Rabatt −75 Kr')
    expect(row(el, '.total-row')).toBe('Totalt 675 Kr')
  })

  it('shipping not known yet: what the lines cost is still said — «Totalt uten frakt»', async () => {
    const el = await cart([CREAM, MASK])
    expect(row(el, '.shipping-row')).toBe('Frakt Beregnes i kassen')
    expect(row(el, '.total-row')).toBe('Totalt uten frakt 349 Kr')
  })

  it('without a discount the footer is the one it always was', async () => {
    const withRate = await cart([{ ...CREAM, shipping: rate(49) }, { ...MASK, discount: undefined }])
    expect(row(withRate, '.subtotal-row')).toBe('Sum 401 Kr')
    expect(withRate.shadowRoot!.querySelector('.discount-row')).toBeNull()
    expect(row(withRate, '.total-row')).toBe('Totalt 450 Kr')
    unmountAll()

    const noRate = await cart([CREAM])
    expect(noRate.shadowRoot!.querySelector('.total-row')).toBeNull()
    expect(noRate.shadowRoot!.querySelector('.discount-row, .cart-notice, .item-note')).toBeNull()
  })
})

describe('how a line shows', () => {
  it('the gift: its list price struck through, then «Gratis» — and its «+» does nothing', async () => {
    const adjust = vi.spyOn(Vio.cart, 'adjustQuantity').mockImplementation(() => {})
    const el = await cart([CREAM, MASK])
    const [cream, mask] = lines(el)

    expect(text(mask!.querySelector('.item-price s'))).toBe('52 Kr')
    expect(text(mask!.querySelector('.item-price .net-price'))).toBe('Gratis')
    // To a screen reader the struck price is «Ordinær pris 52 Kr».
    expect(text(mask!.querySelector('.item-price .list-price'))).toBe('Ordinær pris 52 Kr')
    expect(plus(mask!).disabled).toBe(true)
    expect(plus(mask!).title).toBe('Maks én gave per bestilling')
    plus(mask!).click()
    expect(adjust).not.toHaveBeenCalled()

    // It can be taken out, like any line.
    const removeItem = vi.spyOn(Vio.cart, 'removeItem').mockImplementation(() => {})
    mask!.querySelector<HTMLButtonElement>('[data-vio-cta="remove"]')!.click()
    expect(removeItem).toHaveBeenCalledWith('m', SPONSOR)

    // The line beside it is a line like any other.
    expect(text(cream!.querySelector('.item-price'))).toBe('349 Kr')
    expect(cream!.querySelector('.item-price s')).toBeNull()
    expect(plus(cream!).disabled).toBe(false)
    plus(cream!).click()
    expect(adjust).toHaveBeenCalledWith('c', SPONSOR, 1)
  })

  it('a percentage off: the list price struck through, then what the line costs — and it can still be raised', async () => {
    const el = await cart([{ ...CREAM, quantity: 2, discount: 69.8 }])
    const [cream] = lines(el)
    expect(text(cream!.querySelector('.item-price s'))).toBe('698 Kr')
    expect(text(cream!.querySelector('.item-price .net-price'))).toBe('628,20 Kr')
    expect(plus(cream!).disabled).toBe(false)
  })

  it('a gift line with two units says it has one too many (Commerce will not be paid for it)', async () => {
    const el = await cart([CREAM, { ...MASK, quantity: 2, discount: 104 }])
    const [, mask] = lines(el)
    expect(text(mask!.querySelector('.item-note'))).toBe('Du kan bare få én gave per bestilling. Reduser antallet og prøv igjen.')
    // The way out is «−», which works.
    expect(mask!.querySelector<HTMLButtonElement>('[data-vio-cta="quantity_minus"]')!.disabled).toBe(false)
  })
})

describe('a cart of a gift alone', () => {
  it('nothing to pay: «Til kassen» is off, nothing starts a payment, and a line says what to do', async () => {
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
    expect(row(el, '.cart-notice')).toBe('Legg til et produkt for å få med gaven.')
    expect(el.shadowRoot!.querySelector('.cart-notice')!.getAttribute('role')).toBe('alert')
  })

  it('with something to pay beside it, the cart is paid as any other — and says nothing', async () => {
    const el = await cart([CREAM, MASK])
    const opened = vi.fn()
    el.addEventListener('vio:checkout-open', opened)
    const checkout = el.shadowRoot!.querySelector<HTMLButtonElement>('.checkout-btn')!
    expect(checkout.disabled).toBe(false)
    expect(el.shadowRoot!.querySelector('.cart-notice')).toBeNull()
    checkout.click()
    expect(opened).toHaveBeenCalledTimes(1)
  })
})

describe('Vipps refuses the payment because of the discount code', () => {
  /** What `executeCartGraphQL` throws for the gateway's answer. */
  const refused = (code: string) => {
    const message = `Payment Vipps not initialize: the payment was refused [${code}]`
    return Object.assign(new Error(message), { graphql: { hasData: false, errors: [{ message, extensions: { code } }] } })
  }
  const tapVipps = (el: HTMLElement) => el.shadowRoot!.querySelector<HTMLButtonElement>('.vipps-btn')!.click()

  it('the reason is said on the cart, and the checkout is not opened (it would refuse the same payment)', async () => {
    vi.spyOn(Vio.checkout, 'getVippsExpressEnabled').mockResolvedValue(true)
    vi.spyOn(Vio.checkout, 'startVippsExpress').mockRejectedValue(refused('COUPON_EXPIRED'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const el = await cart([CREAM, MASK])
    const opened = vi.fn()
    document.addEventListener('vio:checkout-open', opened)

    tapVipps(el)
    for (let i = 0; i < 5; i++) await settle(el)
    document.removeEventListener('vio:checkout-open', opened)

    expect(row(el, '.cart-notice')).toBe('Rabattkoden er ikke lenger gyldig. Handlekurven er oppdatert – prøv igjen.')
    expect(opened).not.toHaveBeenCalled()
  })

  it('a gift with two units, the same way; the next tap clears what was said', async () => {
    vi.spyOn(Vio.checkout, 'getVippsExpressEnabled').mockResolvedValue(true)
    const express = vi
      .spyOn(Vio.checkout, 'startVippsExpress')
      .mockRejectedValueOnce(refused('GIFT_MAX_ONE_UNIT'))
      .mockResolvedValue({ payment_url: 'https://vipps.test' } as any)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const el = await cart([CREAM, MASK])

    tapVipps(el)
    for (let i = 0; i < 5; i++) await settle(el)
    expect(row(el, '.cart-notice')).toBe('Du kan bare få én gave per bestilling. Reduser antallet og prøv igjen.')

    tapVipps(el)
    await settle(el)
    expect(el.shadowRoot!.querySelector('.cart-notice')).toBeNull()
    for (let i = 0; i < 5; i++) await settle(el)
    expect(express).toHaveBeenCalledTimes(2)
  })

  it('any other failure opens the checkout with Vipps, as before — nothing about a discount is said', async () => {
    vi.spyOn(Vio.checkout, 'getVippsExpressEnabled').mockResolvedValue(true)
    vi.spyOn(Vio.checkout, 'startVippsExpress').mockRejectedValue(new Error('Payment Vipps not initialize: 503'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const el = await cart([CREAM])
    const opened = vi.fn()
    document.addEventListener('vio:checkout-open', opened)

    tapVipps(el)
    for (let i = 0; i < 5; i++) await settle(el)
    document.removeEventListener('vio:checkout-open', opened)

    expect(opened).toHaveBeenCalledTimes(1)
    expect(el.shadowRoot!.querySelector('.cart-notice')).toBeNull()
  })
})
