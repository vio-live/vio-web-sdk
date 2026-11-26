// @vitest-environment jsdom
/**
 * The cart drawer and a product the shop has cut the price of (Boots,
 * 2026-11-26: «vise tydelig i handlekurven og checkout … før og etter pris»).
 *
 * A line whose product has a «før-pris» (`compareAtPrice`) shows the price
 * before struck through, over what it costs — and that is all: no «Du
 * sparer» row adds the cuts up (Angelo, 2026-11-26). What is paid does not
 * change: «Sum» and «Totalt» are what they were. A cart without a cut is
 * drawn as it always was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'

const SPONSOR = 5
const rate = (amount: number) => ({ id: 'r', name: 'Posten', price: { amount: amount * 0.8, amount_incl_taxes: amount, currency_code: 'NOK' } })
const CREAM = { id: 'c', productId: 416094, sponsorId: SPONSOR, brand: 'Cosmica', name: 'Sun Face Cream', quantity: 1, unitPrice: 143.94, compareAtPrice: 239.9, currency: 'NOK', imageUrl: '' }
const BALM = { id: 'b', productId: 416095, sponsorId: SPONSOR, brand: 'Avène', name: 'Lip Butter', quantity: 1, unitPrice: 84.95, currency: 'NOK', imageUrl: '' }

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
const lines = (el: HTMLElement) => [...el.shadowRoot!.querySelectorAll<HTMLElement>('.item')]

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

describe('a line the shop has cut the price of', () => {
  it('the price before struck through — said «Ordinær pris» to a screen reader — then what it costs', async () => {
    const el = await cart([CREAM, BALM])
    const [cream, balm] = lines(el)
    expect(text(cream!.querySelector('.item-price s'))).toBe('239,90 Kr')
    expect(text(cream!.querySelector('.item-price .vh'))).toBe('Ordinær pris')
    expect(text(cream!.querySelector('.item-price .net-price'))).toBe('143,94 Kr')
    // The line that saves nothing is the plain price it always was.
    expect(balm!.querySelector('.item-price s')).toBeNull()
    expect(text(balm!.querySelector('.item-price'))).toBe('84,95 Kr')
  })

  it('every unit of it', async () => {
    const el = await cart([{ ...CREAM, quantity: 2 }])
    const [cream] = lines(el)
    expect(text(cream!.querySelector('.item-price s'))).toBe('479,80 Kr')
    expect(text(cream!.querySelector('.item-price .net-price'))).toBe('287,88 Kr')
  })

  it('a «før-pris» that is not above the price is no cut: a plain price', async () => {
    const el = await cart([{ ...CREAM, compareAtPrice: 143.94 }, { ...BALM, compareAtPrice: 50 }])
    expect(el.shadowRoot!.querySelector('.item-price s')).toBeNull()
    expect(lines(el).map((l) => text(l.querySelector('.item-price')))).toEqual(['143,94 Kr', '84,95 Kr'])
  })

  it('with a discount code too: the «før-pris» struck through, over what the line costs with the code', async () => {
    // 10 % off the cream by the code (14.39), on top of the shop's cut.
    const el = await cart([{ ...CREAM, discount: 14.39, shipping: rate(0) }, BALM], { discountCode: 'BW10' })
    const [cream] = lines(el)
    expect(text(cream!.querySelector('.item-price s'))).toBe('239,90 Kr')
    expect(text(cream!.querySelector('.item-price .net-price'))).toBe('129,55 Kr')
    // The «Rabatt» row is the code alone, as before.
    expect(row(el, '.discount-row')).toBe('Rabatt (BW10) −14,39 Kr')
  })
})

describe('the footer', () => {
  it('what is paid does not change: «Sum» and «Totalt» are the prices of today', async () => {
    const el = await cart([{ ...CREAM, shipping: rate(49) }, BALM])
    expect(row(el, '.subtotal-row')).toBe('Sum 228,89 Kr')
    expect(row(el, '.total-row')).toBe('Totalt 277,89 Kr')
    expect(el.shadowRoot!.querySelector('.discount-row')).toBeNull()
  })

  it('no row adds the cuts up: the rows are the ones a cart always had, then «Til kassen»', async () => {
    const el = await cart([{ ...CREAM, shipping: rate(49) }, BALM])
    expect(el.shadowRoot!.textContent).not.toMatch(/Du sparer/i)
    const order = [...el.shadowRoot!.querySelectorAll('.footer > div, .footer > .checkout-btn')].map((n) => n.className)
    expect(order).toEqual(['subtotal-row', 'shipping-row', 'total-row', 'checkout-btn'])
  })

  it('a cart without a cut is drawn as it always was', async () => {
    const el = await cart([BALM, { ...BALM, id: 'b2', productId: 7, unitPrice: 349 }])
    expect(el.shadowRoot!.querySelector('.item-price s, .item-price .net-price')).toBeNull()
    expect(lines(el).map((l) => text(l.querySelector('.item-price')))).toEqual(['84,95 Kr', '349 Kr'])
  })
})
