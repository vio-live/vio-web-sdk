// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioProductDetail } from './vio-product-detail.js'

/**
 * The buy zone (Mote & Livsstil, 2026-10-28):
 * - the size picker lives inside it, so the bar pinned to the bottom of the
 *   panel on desktop never covers it;
 * - while the brand's payment methods load, a neutral placeholder stands
 *   where the buttons go — never Stripe or Klarna for a Vipps-only brand.
 */

const product = {
  id: 9,
  brand: 'Careless',
  title: 'Vilde genser',
  quantity: 10,
  price: { amount: 599, currency_code: 'NOK' },
  images: [{ id: 1, url: 'https://img.test/1.jpg', order: 0 }],
  options: [{ id: 1, name: 'Størrelse', order: 0, values: ['S', 'M'] }],
  variants: [
    { id: 101, title: 'S', quantity: 5, price: { amount: 599, currency_code: 'NOK' }, images: [] },
    { id: 102, title: 'M', quantity: 5, price: { amount: 599, currency_code: 'NOK' }, images: [] },
  ],
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  vi.spyOn(VioProductDetail.prototype as any, 'loadVippsButton').mockResolvedValue(undefined)
  vi.spyOn(Vio.checkout, 'prepareApplePayFor').mockResolvedValue({ available: false, show: async () => {} } as any)
  vi.spyOn(Vio, 'commerceFor').mockReturnValue({
    channel: { product: { getByIds: vi.fn().mockResolvedValue([product]), getSellerCompany: vi.fn().mockResolvedValue(null) } },
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
const q = (el: HTMLElement, sel: string) => el.shadowRoot!.querySelector(sel)

describe('the size picker is inside the buy zone', () => {
  it('the option groups are children of .buy, above the buttons', async () => {
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Vipps' }] as any)
    const el = await open()
    const buy = q(el, '.buy')!
    expect(buy.querySelector('.option-group')).not.toBeNull()
    const kids = [...buy.children].map((c) => c.className)
    expect(kids[0]).toContain('buy-options')
    expect(kids.findIndex((k) => k.includes('buy-vipps'))).toBeGreaterThan(0)
    // The zone a host can pin starts after name, price and stock: sliding up
    // it can cover the description, never them. «Frakt fra …» sits in it,
    // right under the sizes.
    const purchase = q(el, '.info > .purchase')!
    expect(purchase.contains(buy)).toBe(true)
    for (const sel of ['.name', '.price-row', '.stock']) {
      const node = q(el, sel)
      if (node) expect(purchase.contains(node), sel).toBe(false)
    }
    expect(buy.querySelector('.delivery-note')).not.toBeNull()
    // …and pinning, when the host asks for it, applies to the buy zone.
    const css = [(VioProductDetail as any).styles].flat().map((s: any) => s.cssText).join("\n") as string
    expect(css).toMatch(/\.buy \{[\s\S]*position: var\(--vio-detail-buy-position, static\)/)
  })
})

describe('while the payment methods load', () => {
  it('a neutral placeholder, no method’s button; then only the brand’s methods', async () => {
    const methods = deferred<unknown>()
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockReturnValue(methods.promise as any)
    const el = await open()
    expect(q(el, '.buy-pending')).not.toBeNull()
    for (const sel of ['.buy-vipps', '.buy-stripe', '.buy-klarna', '.buy-now', '.buy-applepay']) {
      expect(q(el, sel), sel).toBeNull()
    }
    // Adding to the cart needs no method: it is there from the start.
    expect(q(el, '.add-to-cart')).not.toBeNull()

    methods.resolve([{ name: 'Vipps' }])
    for (let i = 0; i < 3; i++) await settle(el)
    expect(q(el, '.buy-pending')).toBeNull()
    expect(q(el, '.buy-vipps')).not.toBeNull()
    expect(q(el, '.buy-stripe')).toBeNull()
    expect(q(el, '.buy-klarna')).toBeNull()
  })

  it('a failed lookup still leaves a way to buy (unknown = every button, as before)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockRejectedValue(new Error('network'))
    const el = await open()
    expect(q(el, '.buy-pending')).toBeNull()
    expect(q(el, '.buy-vipps')).not.toBeNull()
  })
})

describe('vio-cart while the payment methods load', () => {
  it('shows «Til kassen» and a placeholder, no method’s button; then only the brand’s', async () => {
    const methods = deferred<unknown>()
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockReturnValue(methods.promise as any)
    const el = await mount<HTMLElement & Record<string, any>>('vio-cart')
    el.carts = new Map([
      [5, { sponsorId: 5, currency: 'NOK', items: [{ id: 'i1', productId: 1, name: 'Genser', quantity: 1, unitPrice: 599, currency: 'NOK' }] }],
    ])
    el.itemCount = 1
    el.open = true
    el.show()
    await settle(el)
    expect(q(el, '.methods-pending')).not.toBeNull()
    expect(q(el, '.checkout-btn')).not.toBeNull()
    for (const sel of ['.stripe-btn', '.klarna-btn', '.vipps-btn', '.applepay-btn']) expect(q(el, sel), sel).toBeNull()

    methods.resolve([{ name: 'Vipps' }])
    for (let i = 0; i < 3; i++) await settle(el)
    expect(q(el, '.methods-pending')).toBeNull()
    expect(q(el, '.vipps-btn')).not.toBeNull()
    expect(q(el, '.stripe-btn')).toBeNull()
    expect(q(el, '.klarna-btn')).toBeNull()
  })
})
