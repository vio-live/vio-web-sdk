// @vitest-environment jsdom
/**
 * Button tracking (`cta_click`, README «Button tracking»): every marked button
 * of the SDK's elements dispatches ONE `vio:cta-click` per tap — before its
 * own handler runs, never instead of it — and `Vio.analytics` turns it into
 * ONE `cta_click` once started.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { mount, unmountAll, settle } from './test-harness.js'
import { Vio } from '../core/client.js'
import { VioProductDetail } from './components/vio-product-detail.js'
import { VioCart } from './components/vio-cart.js'
import { VioProduct } from './components/vio-product.js'
import { VioCheckout } from './components/vio-checkout.js'
import type { CtaClickDetail } from '../core/analytics/cta.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

let clicks: CtaClickDetail[] = []
let wire: Array<Record<string, any>> = []
const onCta = (ev: Event) => clicks.push((ev as CustomEvent<CtaClickDetail>).detail)
const onWire = (ev: Event) => {
  const e = (ev as CustomEvent).detail
  if (e?.name === 'cta_click') wire.push(e)
}

beforeEach(() => {
  clicks = []
  wire = []
  window.addEventListener('vio:cta-click', onCta)
  window.addEventListener('vio:analytics', onWire)
})

afterEach(() => {
  window.removeEventListener('vio:cta-click', onCta)
  window.removeEventListener('vio:analytics', onWire)
  Vio.analytics.stop()
  unmountAll()
  vi.restoreAllMocks()
})

const root = (el: HTMLElement) => el.shadowRoot!
const q = <T extends Element = HTMLElement>(el: HTMLElement, sel: string) => root(el).querySelector<T>(sel)!

/** Click `sel` and return the ONE `vio:cta-click` it produced. */
async function tap(el: HTMLElement, sel: string | Element): Promise<CtaClickDetail> {
  const before = clicks.length
  const target = typeof sel === 'string' ? q(el, sel) : sel
  expect(target, `no ${String(sel)}`).toBeTruthy()
  ;(target as HTMLElement).click()
  await settle(el)
  expect(clicks.length - before).toBe(1)
  return clicks[clicks.length - 1]!
}

// ── <vio-product-detail> ─────────────────────────────────────────────────────

const variant = (id: number, size: string, quantity: number) => ({
  id,
  title: size,
  quantity,
  price: { amount: 599, currency_code: 'NOK' },
  images: [],
})

const PRODUCT = {
  id: 9,
  brand: 'Careless',
  title: 'Vilde genser',
  description: 'En myk genser.',
  quantity: 14,
  price: { amount: 599, currency_code: 'NOK' },
  images: [
    { id: 1, url: 'https://img.test/1.jpg', order: 0 },
    { id: 2, url: 'https://img.test/2.jpg', order: 1 },
    { id: 3, url: 'https://img.test/3.jpg', order: 2 },
  ],
  options: [{ id: 1, name: 'Størrelse', order: 0, values: ['S', 'M', 'L'] }],
  variants: [variant(101, 'S', 2), variant(102, 'M', 12), variant(103, 'L', 4)],
}

describe('<vio-product-detail> buttons (cta_location: detail)', () => {
  let actions: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    const proto = VioProductDetail.prototype as any
    vi.spyOn(proto, 'loadVippsButton').mockResolvedValue(undefined)
    vi.spyOn(proto, 'loadAvailablePaymentMethods').mockImplementation(async function (this: any) {
      this.availableMethods = ['Vipps', 'Stripe', 'Klarna', 'Apple Pay']
    })
    vi.spyOn(proto, 'prepareApplePaySheet').mockImplementation(function (this: any) {
      this.applePayOk = true
    })
    // The buttons' own actions: each must still run, once, after the event.
    actions = {}
    for (const m of ['buyWithVipps', 'addToCart', 'buyWithApplePay', 'buyWithStripe', 'buyWithKlarna', 'buyNow']) {
      actions[m] = vi.fn(() => {
        expect(clicks.length).toBeGreaterThan(0) // the event went out first
      })
      vi.spyOn(proto, m).mockImplementation(actions[m] as any)
    }
    vi.spyOn(Vio, 'commerceFor').mockImplementation(
      () =>
        ({
          channel: {
            product: {
              getByIds: vi.fn().mockResolvedValue([PRODUCT]),
              getSellerCompany: vi.fn().mockResolvedValue(null),
              getShippingRates: vi.fn().mockResolvedValue([]),
            },
          },
        }) as any,
    )
    vi.spyOn(Vio, 'sponsorIdentity' as any).mockReturnValue(null as any)
  })

  async function open(props: Record<string, unknown> = {}) {
    const el = await mount<HTMLElement & Record<string, any>>('vio-product-detail', props as any)
    document.dispatchEvent(
      new CustomEvent('vio:product-click', { detail: { productId: '9', sponsorId: '4', slot: 'feed-1', contentId: 'art-77' } }),
    )
    for (let i = 0; i < 6; i++) await settle(el)
    return el
  }

  it('the buy zone: vipps, add_to_cart, apple_pay, stripe, klarna, buy_now — each once, with its label, then its action', async () => {
    const el = await open()
    el.availableMethods = ['Vipps', 'Stripe', 'Klarna', 'Apple Pay', 'Kustom']
    await settle(el)
    const cases: Array<[string, string, string, string]> = [
      ['.buy-vipps', 'vipps', 'Kjøp nå med Vipps', 'buyWithVipps'],
      ['.add-to-cart', 'add_to_cart', 'Legg i handlekurv', 'addToCart'],
      ['.buy-applepay', 'apple_pay', 'Kjøp nå med Apple Pay', 'buyWithApplePay'],
      ['.buy-stripe', 'stripe', 'Kjøp nå med Stripe', 'buyWithStripe'],
      ['.buy-klarna', 'klarna', 'Kjøp nå med Klarna', 'buyWithKlarna'],
      ['.buy-now', 'buy_now', 'Kjøp nå', 'buyNow'],
    ]
    for (const [sel, cta, label, action] of cases) {
      const d = await tap(el, sel)
      expect(d).toMatchObject({ cta, location: 'detail', label, productId: 9, sponsorId: 4, slot: 'feed-1', contentId: 'art-77' })
      expect(d.componentTemplateId).toBe('product-detail')
      expect(actions[action]).toHaveBeenCalledTimes(1)
    }
  })

  it('size: the value chosen as option_value; the product variant once every option is chosen', async () => {
    const el = await open()
    const pill = [...root(el).querySelectorAll<HTMLButtonElement>('.option-pill')].find((b) => b.textContent?.trim() === 'M')!
    const d = await tap(el, pill)
    expect(d).toMatchObject({ cta: 'size', location: 'detail', optionValue: 'M', label: 'M', productId: 9 })
    // Before the tap nothing was chosen: no variant is said.
    expect(d.productVariantId).toBeUndefined()
    const add = await tap(el, '.add-to-cart')
    expect(add.productVariantId).toBe(102)
  })

  it('quantity_plus / quantity_minus', async () => {
    const el = await open()
    const [minus, plus] = [...root(el).querySelectorAll<HTMLButtonElement>('.qty-btn')]
    expect((await tap(el, plus!)).cta).toBe('quantity_plus')
    expect(el.quantity).toBe(2)
    expect((await tap(el, minus!)).cta).toBe('quantity_minus')
    expect(el.quantity).toBe(1)
  })

  it('description_open only when the tap opens the fold; «Les mer» counts once', async () => {
    const el = await open({ descriptionMode: 'folded' })
    const d = await tap(el, '.desc-head')
    expect(d).toMatchObject({ cta: 'description_open', label: 'Beskrivelse' })
    // Closing it again is not reported.
    q(el, '.desc-head').click()
    await settle(el)
    expect(clicks.filter((c) => c.cta === 'description_open')).toHaveLength(1)
  })

  it('shipping_returns_open when «Frakt & retur» opens; terms_link / refund_link on the brand\'s pages', async () => {
    vi.spyOn(Vio, 'sponsorIdentity' as any).mockReturnValue({
      id: 4,
      name: 'Careless',
      logoUrl: null,
      termsUrl: 'https://careless.test/terms',
      refundPolicyUrl: 'https://careless.test/refund',
    } as any)
    // The links open a new tab: not in a test.
    const noNav = (e: Event) => {
      if ((e.composedPath()[0] as Element)?.tagName === 'A') e.preventDefault()
    }
    document.addEventListener('click', noNav)
    onTestFinished(() => document.removeEventListener('click', noNav))
    const el = await open()
    const summary = q(el, '.shipping-returns summary')
    expect(summary).toBeTruthy()
    expect(await tap(el, summary)).toMatchObject({ cta: 'shipping_returns_open', location: 'detail', label: 'Frakt & retur' })
    expect((summary.parentElement as HTMLDetailsElement).open).toBe(true)
    summary.click() // closing it is not reported
    await settle(el)
    expect(clicks.filter((c) => c.cta === 'shipping_returns_open')).toHaveLength(1)
    expect(await tap(el, '[part="seller-terms"]')).toMatchObject({ cta: 'terms_link', label: 'Kjøpsvilkår' })
    expect(await tap(el, '[part="seller-refund"]')).toMatchObject({ cta: 'refund_link', label: 'Angrerett og retur' })
    expect(await tap(el, '.sr-links a[data-vio-cta="refund_link"]')).toMatchObject({ cta: 'refund_link' })
  })

  it('close: the X, the backdrop and the handle — one each', async () => {
    const el = await open()
    expect(await tap(el, '.close')).toMatchObject({ cta: 'close', location: 'detail', label: 'Lukk' })
    el.open = true
    await settle(el)
    const back = await tap(el, '.backdrop')
    expect(back.cta).toBe('close')
    expect(back.label).toBeUndefined()
  })

  it('gallery_swipe: the first change of photo per open product, never again', async () => {
    const el = await open()
    const thumbs = [...root(el).querySelectorAll<HTMLButtonElement>('.gallery-thumb')]
    expect(thumbs.length).toBe(3)
    const d = await tap(el, thumbs[1]!)
    expect(d).toMatchObject({ cta: 'gallery_swipe', location: 'detail', productId: 9 })
    thumbs[2]!.click()
    await settle(el)
    expect(clicks.filter((c) => c.cta === 'gallery_swipe')).toHaveLength(1)
  })

  it('a swipe on the carousel (a finger, then the scroll) is gallery_swipe, once', async () => {
    const el = await open({ gallery: 'carousel' })
    const track = q(el, '.carousel-track')
    track.dispatchEvent(new Event('touchstart'))
    track.dispatchEvent(new Event('scroll'))
    track.dispatchEvent(new Event('touchstart'))
    track.dispatchEvent(new Event('scroll'))
    // A scroll the SDK makes (no finger) is not a swipe.
    track.dispatchEvent(new Event('scroll'))
    expect(clicks.map((c) => c.cta)).toEqual(['gallery_swipe'])
  })

  it('a non-default layout rides along (layout.variantId is the EXPERIMENT variant)', async () => {
    const el = await open({
      layout: { id: 'size-first', revision: '3', sections: ['title', 'options', 'price', 'purchase'], experimentId: 'exp-1', variantId: 'b' },
    })
    const d = await tap(el, '.add-to-cart')
    expect(d.layout).toEqual({ layoutId: 'size-first', layoutRevision: '3', experimentId: 'exp-1', variantId: 'b' })
  })

  it('once started, each tap is ONE cta_click on the wire with the contract fields', async () => {
    Vio.analytics.start({ host: 'test' })
    const el = await open({
      layout: { id: 'size-first', revision: '3', sections: ['title', 'options', 'price', 'purchase'], experimentId: 'exp-1', variantId: 'b' },
    })
    const pill = [...root(el).querySelectorAll<HTMLButtonElement>('.option-pill')].find((b) => b.textContent?.trim() === 'L')!
    pill.click()
    await settle(el)
    q(el, '.add-to-cart').click()
    await settle(el)
    expect(wire.map((e) => e.context.cta)).toEqual(['size', 'add_to_cart'])
    expect(wire[0]!.context).toMatchObject({ cta_location: 'detail', option_value: 'L', cta_label: 'L', product_id: '9', sponsor_id: 4 })
    expect(wire[1]!.context).toMatchObject({
      cta: 'add_to_cart',
      cta_location: 'detail',
      cta_label: 'Legg i handlekurv',
      product_id: '9',
      product_variant_id: '103',
      sponsor_id: 4,
      location_id: 'feed-1',
      content_id: 'art-77',
      component_template_id: 'product-detail',
      layout_id: 'size-first',
      layout_revision: '3',
      experiment_id: 'exp-1',
      variant_id: 'b',
    })
    expect(wire[1]!.context.cta_variant).toBeUndefined()
  })

  it('before Vio.analytics.start() the DOM event still goes out, but nothing reaches the pipeline', async () => {
    const el = await open()
    q(el, '.add-to-cart').click()
    await settle(el)
    expect(clicks).toHaveLength(1)
    expect(wire).toHaveLength(0)
  })
})

// ── <vio-cart> ───────────────────────────────────────────────────────────────

describe('<vio-cart> buttons (cta_location: cart)', () => {
  const line = {
    id: 'line-1',
    productId: 9,
    sponsorId: 4,
    variantId: 102,
    brand: 'Careless',
    name: 'Vilde genser',
    unitPrice: 599,
    currency: 'NOK',
    imageUrl: '',
    quantity: 2,
    origins: [{ quantity: 2, campaignId: 31, slot: 'feed-1', contentId: 'art-77' }],
  }
  let actions: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    const proto = VioCart.prototype as any
    vi.spyOn(proto, 'loadVippsButton').mockResolvedValue(undefined)
    vi.spyOn(proto, 'loadAvailablePaymentMethods').mockImplementation(async function (this: any) {
      this.availableMethods = ['Vipps', 'Stripe', 'Klarna', 'Apple Pay']
    })
    actions = {}
    for (const m of ['onCheckout', 'onVipps', 'onApplePay', 'onStripe', 'onKlarnaExpress']) {
      actions[m] = vi.fn()
      vi.spyOn(proto, m).mockImplementation(actions[m] as any)
    }
    vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(
      new Map([[4, { sponsorId: 4, items: [line], currency: 'NOK' } as any]]),
    )
    vi.spyOn(Vio.cart, 'itemCount', 'get').mockReturnValue(2)
    vi.spyOn(Vio.cart, 'adjustQuantity').mockImplementation((() => undefined) as any)
    vi.spyOn(Vio.cart, 'removeItem').mockImplementation((() => undefined) as any)
  })

  async function cart() {
    const el = await mount<HTMLElement & Record<string, any>>('vio-cart')
    el.applePayAvailable = true
    await settle(el)
    return el
  }

  it('the footer: checkout, vipps, apple_pay, stripe, klarna — once each, with the sponsor, then the action', async () => {
    const el = await cart()
    const cases: Array<[string, string, string, string]> = [
      ['.checkout-btn', 'checkout', 'Til kassen', 'onCheckout'],
      ['.vipps-btn', 'vipps', 'Betal med Vipps', 'onVipps'],
      ['.applepay-btn', 'apple_pay', 'Betal med Apple Pay', 'onApplePay'],
      ['.stripe-btn', 'stripe', 'Betal med Stripe', 'onStripe'],
      ['.klarna-btn', 'klarna', 'Betal med Klarna', 'onKlarnaExpress'],
    ]
    for (const [sel, cta, label, action] of cases) {
      const d = await tap(el, sel)
      expect(d).toMatchObject({ cta, location: 'cart', label, sponsorId: 4 })
      expect(actions[action]).toHaveBeenCalledTimes(1)
    }
  })

  it('a line: quantity_minus, quantity_plus, remove — its product, variant, sponsor and where it came from', async () => {
    const el = await cart()
    const [minus, plus, remove] = [...root(el).querySelectorAll<HTMLButtonElement>('.item .qty-btn')]
    const expected = { productId: 9, productVariantId: 102, sponsorId: 4, campaignId: 31, slot: 'feed-1', contentId: 'art-77', location: 'cart' }
    expect(await tap(el, minus!)).toMatchObject({ cta: 'quantity_minus', ...expected })
    expect(await tap(el, plus!)).toMatchObject({ cta: 'quantity_plus', ...expected })
    expect(await tap(el, remove!)).toMatchObject({ cta: 'remove', label: 'Fjern', ...expected })
    expect(Vio.cart.adjustQuantity).toHaveBeenCalledTimes(2)
    expect(Vio.cart.removeItem).toHaveBeenCalledTimes(1)
  })

  it('close', async () => {
    const el = await cart()
    expect(await tap(el, '.header .close')).toMatchObject({ cta: 'close', location: 'cart' })
    expect(await tap(el, '.handle')).toMatchObject({ cta: 'close', location: 'cart' })
  })
})

// ── <vio-product> card ───────────────────────────────────────────────────────

describe('<vio-product> card (cta_location: card)', () => {
  beforeEach(() => {
    vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(new Map())
  })

  it('open (a tap on the card) and add (its button) — never both for one tap', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-product', {
      productId: '9',
      sponsorId: '4',
      brand: 'Careless',
      name: 'Vilde genser',
      price: '599 kr',
      imageUrl: 'https://img.test/1.jpg',
      buttonStyle: 'bar',
      buttonLabel: 'Kjøp',
      vioSlot: 'feed-1',
    } as any)
    const productAdds: unknown[] = []
    el.addEventListener('vio:product-add', (e) => productAdds.push(e))
    const open = await tap(el, '.image')
    expect(open).toMatchObject({ cta: 'open', location: 'card', productId: '9', sponsorId: '4', slot: 'feed-1', componentTemplateId: 'product-card' })
    expect(open.label).toBeUndefined()
    const add = await tap(el, '.bar-btn')
    expect(add).toMatchObject({ cta: 'add', location: 'card', label: 'Kjøp', productId: '9' })
    expect(productAdds).toHaveLength(1)
  })

  it('Enter on the card is its tap', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-product', { productId: '9', sponsorId: '4', name: 'X' } as any)
    q(el, '.card').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }))
    expect(clicks.map((c) => c.cta)).toEqual(['open'])
  })

  it('the DOM event bubbles and is composed: the host hears it on the card itself and on the window', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-product', { productId: '9', sponsorId: '4', name: 'X' } as any)
    const heard: Event[] = []
    el.addEventListener('vio:cta-click', (e) => heard.push(e))
    q(el, '.card').click()
    expect(heard).toHaveLength(1)
    expect(heard[0]!.bubbles).toBe(true)
    expect(heard[0]!.composed).toBe(true)
    expect(clicks).toHaveLength(1)
  })
})

// ── <vio-checkout> ───────────────────────────────────────────────────────────

describe('<vio-checkout> buttons (cta_location: checkout)', () => {
  const manager = Vio.checkout as any

  beforeEach(() => {
    vi.spyOn(manager, 'getOrderReference').mockResolvedValue({ orderNumber: 1, buyerRef: null })
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null)
    const proto = VioCheckout.prototype as any
    for (const m of ['loadAvailablePaymentMethods', 'refreshApplePay', 'refreshKlarna', 'loadVippsButton']) {
      vi.spyOn(proto, m).mockResolvedValue(undefined)
    }
    vi.spyOn(proto, 'loadAvailableShippings').mockResolvedValue(undefined)
    vi.spyOn(proto, 'onPay').mockResolvedValue(undefined)
    vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
    vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(new Map([[5, {} as any]]))
    vi.spyOn(manager, 'open').mockImplementation((...args: unknown[]) => {
      manager.state = { sponsorId: args[0], session: 1, subtotal: 4999, currency: 'NOK' }
      manager.emit()
      return manager.state
    })
    window.history.replaceState({}, '', '/')
  })
  afterEach(() => {
    manager.state = null
  })

  async function checkout(methods: string[]) {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.open(5)
    el.show()
    for (let i = 0; i < 4; i++) await settle(el)
    el.availableMethods = methods
    el.paymentMethodsResolved = true
    for (let i = 0; i < 4; i++) await settle(el)
    return el
  }

  it('the method list: select_<method>, with the sponsor', async () => {
    const el = await checkout(['Stripe', 'Vipps', 'Kustom'])
    const buttons = [...root(el).querySelectorAll<HTMLButtonElement>('.payment-grid .payment-btn')]
    const ids: string[] = []
    for (const b of buttons) {
      const d = await tap(el, b)
      expect(d).toMatchObject({ location: 'checkout', sponsorId: 5 })
      ids.push(d.cta)
    }
    expect(ids).toEqual(['select_stripe', 'select_kustom', 'select_vipps'])
  })

  it('the pay button of the chosen method: pay_vipps, pay_stripe', async () => {
    for (const [method, cta] of [['vipps', 'pay_vipps'], ['stripe', 'pay_stripe']] as const) {
      const el = await checkout(['Stripe', 'Vipps'])
      manager.state = { ...manager.state, paymentMethod: method }
      manager.emit()
      for (let i = 0; i < 3; i++) await settle(el)
      // The buttons wait for the form; for this tap it is complete.
      const pay = q<HTMLButtonElement>(el, '.complete-cta')
      pay.disabled = false
      const d = await tap(el, pay)
      expect(d).toMatchObject({ cta, location: 'checkout', sponsorId: 5 })
      expect(d.label).toMatch(/^Betal .* med /)
      unmountAll()
    }
  })

  it('close', async () => {
    const el = await checkout(['Stripe', 'Vipps'])
    expect(await tap(el, '.topbar .close')).toMatchObject({ cta: 'close', location: 'checkout', sponsorId: 5 })
  })
})

// ── Vio.trackCta ─────────────────────────────────────────────────────────────

describe('Vio.trackCta — a host\'s own buttons', () => {
  it('sends the same cta_click (block, label, variant), and nothing before start', () => {
    Vio.trackCta({ cta: 'add_to_cart', location: 'block', productId: 9 })
    expect(wire).toHaveLength(0)
    Vio.analytics.start({ host: 'replit' })
    Vio.trackCta({
      cta: 'choose_size',
      location: 'block',
      label: '  Velg   størrelse ',
      variant: 'outline-velg',
      productId: 9,
      sponsorId: 4,
      campaignId: 31,
      slot: 'feed-1',
      contentId: 'art-77',
    })
    expect(wire).toHaveLength(1)
    expect(wire[0]!.context).toMatchObject({
      cta: 'choose_size',
      cta_location: 'block',
      cta_label: 'Velg størrelse',
      cta_variant: 'outline-velg',
      product_id: '9',
      sponsor_id: 4,
      campaign_id: 31,
      location_id: 'feed-1',
      content_id: 'art-77',
    })
    // A host's tap is no SDK button: no `vio:cta-click` (it would be counted twice).
    expect(clicks).toHaveLength(0)
  })
})
