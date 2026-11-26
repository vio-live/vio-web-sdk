// @vitest-environment jsdom
/**
 * The payment logos under the buy buttons (Boots, 2026-11-26): for a brand
 * paid with Kustom — and only then — the product detail and the cart say,
 * under their buttons, what Kustom's checkout takes: Klarna, Vipps, Visa,
 * Mastercard, Apple Pay, Google Pay, and Kustom's own mark. Every other way
 * to pay has its own branded button and needs no strip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'lit'
import { mount, unmountAll, settle } from './test-harness.js'
import { Vio } from '../core/client.js'
import { VioProductDetail } from './components/vio-product-detail.js'
import { KUSTOM_PAYMENT_MARKS, PAYMENT_MARKS_LABEL, paymentMarksFor, renderPaymentMarks } from './payment-marks.js'

const SIX = ['klarna', 'vipps', 'visa', 'mastercard', 'apple-pay', 'google-pay']

/** The marks a strip shows, in order; null when there is no strip. */
const marksIn = (root: ParentNode | null | undefined): string[] | null => {
  const strip = root?.querySelector('.payment-marks')
  return strip ? [...strip.querySelectorAll<HTMLElement>('li[data-mark]')].map((li) => li.dataset.mark!) : null
}

afterEach(() => {
  unmountAll()
  document.querySelectorAll('.vio-redirect-overlay').forEach((n) => n.remove())
  vi.restoreAllMocks()
})

describe('which logos', () => {
  it('Kustom’s, when Kustom is among the ways to pay — however Commerce spells it', () => {
    expect(KUSTOM_PAYMENT_MARKS).toEqual(SIX)
    expect(paymentMarksFor(['Kustom'])).toEqual(SIX)
    expect(paymentMarksFor(['KUSTOM'])).toEqual(SIX)
    expect(paymentMarksFor(['Vipps', 'kustom'])).toEqual(SIX)
  })

  it('none for any other way to pay', () => {
    expect(paymentMarksFor(['Vipps'])).toEqual([])
    expect(paymentMarksFor(['Vipps', 'Apple Pay', 'Stripe', 'Klarna'])).toEqual([])
    expect(paymentMarksFor(['Qliro', 'Walley', 'Nexi', 'Adyen'])).toEqual([])
    expect(paymentMarksFor([])).toEqual([])
  })

  it('none while the ways to pay are not known', () => {
    expect(paymentMarksFor(null)).toEqual([])
    expect(paymentMarksFor(undefined)).toEqual([])
  })
})

describe('the strip', () => {
  const draw = (available: string[] | null) => {
    const host = document.createElement('div')
    render(renderPaymentMarks(available), host)
    return host
  }

  it('one logo per method, in Kustom’s order, each with its name; then Kustom’s mark', () => {
    const host = draw(['Kustom'])
    const strip = host.querySelector('.payment-marks')!
    expect(strip.getAttribute('role')).toBe('group')
    expect(strip.getAttribute('aria-label')).toBe(PAYMENT_MARKS_LABEL)
    expect(strip.getAttribute('part')).toBe('payment-marks')
    expect(marksIn(host)).toEqual(SIX)
    const logos = [...strip.querySelectorAll('li svg')]
    expect(logos.map((svg) => svg.getAttribute('aria-label'))).toEqual(['Klarna', 'Vipps', 'Visa', 'Mastercard', 'Apple Pay', 'Google Pay'])
    for (const svg of logos) {
      expect(svg.getAttribute('role')).toBe('img')
      expect(svg.getAttribute('viewBox')).toBe('0 0 120 80')
      expect(svg.querySelectorAll('path').length).toBeGreaterThan(0)
    }
    const provider = strip.querySelector('svg.payment-marks-provider')!
    expect(provider.getAttribute('aria-label')).toBe('Kustom')
    // After the logos, not among them.
    expect(strip.lastElementChild).toBe(provider)
  })

  it('the artwork is drawings only: no script, no link, nothing fetched', () => {
    const html = draw(['Kustom']).innerHTML
    expect(html).not.toMatch(/<script|<image|<use|href=|url\(\s*['"]?https?:|foreignObject/i)
  })

  it('nothing at all without Kustom', () => {
    expect(draw(['Vipps']).querySelector('.payment-marks')).toBeNull()
    expect(draw(null).querySelector('.payment-marks')).toBeNull()
  })
})

describe('in the cart', () => {
  type CartEl = HTMLElement & Record<string, any>
  const LINE = { id: 'c', productId: 100, sponsorId: 5, brand: 'Boots', name: 'Krem', quantity: 1, unitPrice: 349, currency: 'NOK', imageUrl: '' }

  async function cart(available: string[] | null): Promise<CartEl> {
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue((available ?? []).map((name) => ({ name })) as any)
    vi.spyOn(Vio.cart, 'refreshFromServer').mockResolvedValue(undefined as any)
    vi.spyOn(Vio.cart, 'waitForCartMutations').mockResolvedValue(undefined as any)
    const el = await mount<CartEl>('vio-cart')
    el.carts = new Map([[5, { sponsorId: 5, currency: 'NOK', items: [LINE] }]])
    el.itemCount = 1
    el.availableMethods = available
    el.open = true
    await settle(el)
    return el
  }

  it('a brand paid with Kustom: the logos, under «Til kassen»', async () => {
    const el = await cart(['Kustom'])
    expect(marksIn(el.shadowRoot)).toEqual(SIX)
    const button = el.shadowRoot!.querySelector('.checkout-btn')!
    const strip = el.shadowRoot!.querySelector('.payment-marks')!
    expect(button.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(strip.closest('.footer')).not.toBeNull()
  })

  it('a brand paid with Vipps: its own button, no logos', async () => {
    const el = await cart(['Vipps'])
    expect(marksIn(el.shadowRoot)).toBeNull()
  })

  it('ways to pay not known: no logos', async () => {
    const el = await cart(null)
    expect(marksIn(el.shadowRoot)).toBeNull()
  })
})

describe('in the product detail', () => {
  const product = (quantity: number) => ({
    id: 9,
    brand: 'Boots',
    title: 'Krem',
    quantity,
    price: { amount: 279.2, amount_incl_taxes: 349, currency_code: 'NOK' },
    images: [{ id: 1, url: 'https://img.test/1.jpg', order: 0 }],
    options: [],
    variants: [],
  })

  function shop(quantity = 10) {
    vi.spyOn(VioProductDetail.prototype as any, 'loadVippsButton').mockResolvedValue(undefined)
    vi.spyOn(Vio.checkout, 'prepareApplePayFor').mockResolvedValue({ available: false, show: async () => {} } as any)
    vi.spyOn(Vio, 'commerceFor').mockReturnValue({
      channel: {
        product: {
          getByIds: vi.fn().mockResolvedValue([product(quantity)]),
          getSellerCompany: vi.fn().mockResolvedValue(null),
          getShippingRates: vi.fn().mockResolvedValue(null),
        },
      },
    } as any)
  }

  async function open() {
    const el = await mount<HTMLElement & Record<string, any>>('vio-product-detail')
    document.dispatchEvent(new CustomEvent('vio:product-click', { detail: { productId: '9', sponsorId: '4' } }))
    for (let i = 0; i < 6; i++) await settle(el)
    return el
  }

  beforeEach(() => shop())

  it('a brand paid with Kustom: the logos, under «Kjøp nå»', async () => {
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Kustom' }] as any)
    const el = await open()
    expect(marksIn(el.shadowRoot)).toEqual(SIX)
    const buyNow = el.shadowRoot!.querySelector('.buy-now')!
    const strip = el.shadowRoot!.querySelector('.payment-marks')!
    expect(buyNow.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Inside the buy zone, with the buttons.
    expect(strip.closest('.buy')).not.toBeNull()
  })

  it('a brand paid with Vipps: no logos', async () => {
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Vipps' }] as any)
    const el = await open()
    expect(el.shadowRoot!.querySelector('.buy-vipps')).not.toBeNull()
    expect(marksIn(el.shadowRoot)).toBeNull()
  })

  it('a failed method lookup: the buttons show (unknown = all), the logos do not', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockRejectedValue(new Error('network'))
    const el = await open()
    expect(el.shadowRoot!.querySelector('.buy-now')).not.toBeNull()
    expect(marksIn(el.shadowRoot)).toBeNull()
  })

  it('sold out: nothing to buy, no logos', async () => {
    shop(0)
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Kustom' }] as any)
    const el = await open()
    expect(el.shadowRoot!.querySelector('.buy-now')).toBeNull()
    expect(marksIn(el.shadowRoot)).toBeNull()
  })
})
