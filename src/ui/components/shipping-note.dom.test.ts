// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioProductDetail } from './vio-product-detail.js'

/**
 * What delivery costs, said before the checkout (Mote & Livsstil,
 * 2026-10-28): under the price «Frakt fra X · 14 dagers angrerett» from the
 * product's own rates, and in the cart the rate and the total with it.
 */

const product = {
  id: 9,
  brand: 'Careless',
  title: 'Vilde genser',
  quantity: 10,
  price: { amount: 699, currency_code: 'NOK' },
  images: [{ id: 1, url: 'https://img.test/1.jpg', order: 0 }],
  options: [],
  variants: [],
}

let rates: unknown = null

beforeEach(() => {
  rates = null
  const proto = VioProductDetail.prototype as any
  vi.spyOn(proto, 'loadVippsButton').mockResolvedValue(undefined)
  vi.spyOn(proto, 'loadAvailablePaymentMethods').mockImplementation(async function (this: any) {
    this.availableMethods = ['Vipps']
  })
  vi.spyOn(Vio.checkout, 'prepareApplePayFor').mockResolvedValue({ available: false, show: async () => {} } as any)
  vi.spyOn(Vio, 'commerceFor').mockReturnValue({
    channel: {
      product: {
        getByIds: vi.fn().mockResolvedValue([product]),
        getSellerCompany: vi.fn().mockResolvedValue(null),
        getShippingRates: vi.fn().mockImplementation(async () => rates),
      },
    },
  } as any)
})

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

async function open() {
  const el = await mount<HTMLElement & Record<string, any>>('vio-product-detail')
  document.dispatchEvent(new CustomEvent('vio:product-click', { detail: { productId: '9', sponsorId: '4' } }))
  for (let i = 0; i < 6; i++) await settle(el)
  return el
}
const note = (el: HTMLElement) =>
  el.shadowRoot!.querySelector('.delivery-note')?.textContent?.replace(/\s+/g, ' ').trim()

describe('under the price in the detail', () => {
  it('«Frakt fra <cheapest> · 14 dagers angrerett»', async () => {
    rates = [
      { id: 'a', name: 'Standard', price: 49, currency: 'NOK', default: true },
      { id: 'b', name: 'Express', price: 99, currency: 'NOK', default: false },
    ]
    const el = await open()
    expect(note(el)).toBe('Frakt fra 49 Kr · 14 dagers angrerett')
  })

  it('a cheapest rate of 0 says «Gratis frakt»', async () => {
    rates = [{ id: 'a', name: 'Gratis', price: 0, currency: 'NOK', default: true }]
    const el = await open()
    expect(note(el)).toBe('Gratis frakt · 14 dagers angrerett')
  })

  it('no rate known (none, unreadable, another currency): only «14 dagers angrerett»', async () => {
    for (const r of [null, [], [{ id: 'a', name: 'x', price: 5, currency: 'EUR', default: true }]]) {
      rates = r
      const el = await open()
      expect(note(el)).toBe('14 dagers angrerett')
      unmountAll()
    }
  })
})

describe('a brand whose checkout picks the delivery (Kustom only, Boots 2026-11-25)', () => {
  const kustomOnly = () =>
    vi.spyOn(Vio, 'sponsorCommerce').mockReturnValue({ id: 4, name: 'Boots', commerce: { apiKey: 'k', paymentMethods: ['kustom'] } } as any)

  it('the detail says «Frakt beregnes i kassen», never its placeholder rate, and asks for no rates', async () => {
    kustomOnly()
    rates = [{ id: 'a', name: 'Levering velges i kassen', price: 1, currency: 'NOK', default: true }]
    const el = await open()
    expect(note(el)).toBe('Frakt beregnes i kassen · 14 dagers angrerett')
    const product = (Vio.commerceFor as any).mock.results[0].value.channel.product
    expect(product.getShippingRates).not.toHaveBeenCalled()
    expect(el.shadowRoot!.querySelector('.sr-rates')).toBeNull()
  })

  it('a brand also paid with Vipps keeps «Frakt fra» its rates', async () => {
    vi.spyOn(Vio, 'sponsorCommerce').mockReturnValue({ id: 4, name: 'B', commerce: { apiKey: 'k', paymentMethods: ['kustom', 'vipps'] } } as any)
    rates = [{ id: 'a', name: 'Standard', price: 49, currency: 'NOK', default: true }]
    const el = await open()
    expect(note(el)).toBe('Frakt fra 49 Kr · 14 dagers angrerett')
  })

  it('the cart: «Beregnes i kassen», no total with the placeholder, and the delivery is picked in the checkout', async () => {
    kustomOnly()
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Kustom' }] as any)
    const el = await mount<HTMLElement & Record<string, any>>('vio-cart')
    const placeholder = { id: 'r', name: 'Levering velges i kassen', price: { amount: 0.8, amount_incl_taxes: 1, currency_code: 'NOK' } }
    el.carts = new Map([
      [4, { sponsorId: 4, currency: 'NOK', items: [{ id: 'i1', productId: 1, name: 'Skin Sip', quantity: 1, unitPrice: 183.92, currency: 'NOK', availableShippings: [placeholder] }] }],
    ])
    el.itemCount = 1
    el.open = true
    await settle(el)
    const row = (sel: string) => el.shadowRoot!.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim()
    expect(row('.shipping-row')).toBe('Frakt Beregnes i kassen')
    expect(el.shadowRoot!.querySelector('.total-row')).toBeNull()
    expect(row('.shipping-hint')).toBe('Frakt velger du i kassen.')
  })
})

describe('the cart drawer', () => {
  const rate = (amount: number) => ({ id: 'r', name: 'Posten', price: { amount: amount * 0.8, amount_incl_taxes: amount, currency_code: 'NOK' } })
  async function cart(item: Record<string, unknown>) {
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Vipps' }] as any)
    const el = await mount<HTMLElement & Record<string, any>>('vio-cart')
    el.carts = new Map([
      [5, { sponsorId: 5, currency: 'NOK', items: [{ id: 'i1', productId: 1, name: 'Genser', quantity: 2, unitPrice: 699, currency: 'NOK', ...item }] }],
    ])
    el.itemCount = 2
    el.open = true
    await settle(el)
    return el
  }
  const row = (el: HTMLElement, sel: string) => el.shadowRoot!.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim()

  it('the chosen rate, and the total including it', async () => {
    const el = await cart({ shipping: rate(79), availableShippings: [rate(49), rate(79)] })
    expect(row(el, '.shipping-row')).toBe('Frakt 79 Kr')
    expect(row(el, '.total-row')).toBe('Totalt 1 477 Kr')
  })

  it('no rate chosen yet among several: «fra» the cheapest, and the total «fra»', async () => {
    const el = await cart({ availableShippings: [rate(99), rate(49)] })
    expect(row(el, '.shipping-row')).toBe('Frakt fra 49 Kr')
    expect(row(el, '.total-row')).toBe('Totalt fra 1 447 Kr')
  })

  it('a single rate offered is its price, no «fra»; the note says where shipping is chosen', async () => {
    const el = await cart({ availableShippings: [rate(59)] })
    expect(row(el, '.shipping-row')).toBe('Frakt 59 Kr')
    expect(row(el, '.total-row')).toBe('Totalt 1 457 Kr')
    expect(row(el, '.shipping-hint')).toBe('Frakt velger du i Vipps eller i neste steg.')
  })

  it('a free rate says «Gratis»; no rate known says it is worked out in the checkout, with no total', async () => {
    let el = await cart({ availableShippings: [rate(0)] })
    expect(row(el, '.shipping-row')).toBe('Frakt Gratis')
    expect(row(el, '.total-row')).toBe('Totalt 1 398 Kr')
    unmountAll()
    el = await cart({})
    expect(row(el, '.shipping-row')).toBe('Frakt Beregnes i kassen')
    expect(el.shadowRoot!.querySelector('.total-row')).toBeNull()
  })
})
