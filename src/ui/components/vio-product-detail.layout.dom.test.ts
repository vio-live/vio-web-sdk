// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioProductDetail } from './vio-product-detail.js'
import { applyVioTheme } from '../tokens.js'

/**
 * The product detail as Mote & Livsstil asked for it (2026-10-22): Vipps above
 * "Legg i handlekurv", thumbnails in one row with arrows that keep the
 * selected one in view, and every layout knob a public `--vio-*` property
 * that `applyVioTheme` sets — the same for our demo, Replit and Vev.
 */

const images = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, url: `https://img.test/${i + 1}.jpg`, order: i }))
const product = {
  id: 9,
  brand: 'Careless',
  title: 'Vilde genser - Brun',
  description: '<p>Myk genser i ull.</p>',
  quantity: 5,
  price: { amount: 599, currency_code: 'NOK' },
  images,
  variants: [],
  options: [],
}

beforeEach(() => {
  const proto = VioProductDetail.prototype as any
  vi.spyOn(proto, 'loadVippsButton').mockResolvedValue(undefined)
  vi.spyOn(proto, 'loadAvailablePaymentMethods').mockImplementation(async function (this: any) {
    this.availableMethods = ['Vipps', 'Stripe']
  })
  vi.spyOn(Vio.checkout, 'prepareApplePayFor').mockResolvedValue({ available: false, show: async () => {} } as any)
  vi.spyOn(Vio, 'commerceFor').mockReturnValue({
    channel: { product: { getByIds: vi.fn().mockResolvedValue([product]), getSellerCompany: vi.fn().mockResolvedValue(null) } },
  } as any)
})

afterEach(() => {
  unmountAll()
  document.documentElement.removeAttribute('style')
  vi.restoreAllMocks()
})

async function open() {
  const el = await mount<HTMLElement & Record<string, any>>('vio-product-detail')
  document.dispatchEvent(new CustomEvent('vio:product-click', { detail: { productId: '9', sponsorId: '4' } }))
  for (let i = 0; i < 6; i++) await settle(el)
  return el
}
const root = (el: HTMLElement) => el.shadowRoot!

describe('the buy zone', () => {
  it('Vipps comes first, above quantity and "Legg i handlekurv"', async () => {
    const el = await open()
    const buy = root(el).querySelector('.buy')!
    const order = [...buy.children].map((c) => c.className)
    // «Frakt fra … · 14 dagers angrerett» right under the sizes, then Vipps,
    // then (Express not known here — no line about the app) quantity + add to cart.
    const vipps = order.findIndex((k) => k.includes('buy-vipps'))
    expect(order.findIndex((k) => k.includes('delivery-note'))).toBeLessThan(vipps)
    expect(order[vipps + 1]).toContain('qty-cta-row')
    expect(buy.getAttribute('part')).toBe('buy')
  })

  it('scrolls with the page on every screen by default; the host can pin it', async () => {
    await open()
    const css = [(VioProductDetail as any).styles].flat().map((s: any) => s.cssText).join("\n") as string
    expect(css).toMatch(/position: var\(--vio-detail-buy-position, static\)/)
    expect(css).not.toMatch(/--vio-detail-buy-position, sticky/)
  })

  it('the description comes after the buy zone on every screen (at the very bottom)', async () => {
    const el = await open()
    const css = [(VioProductDetail as any).styles].flat().map((s: any) => s.cssText).join("\n") as string
    expect(css).not.toMatch(/\.description-block \{ order: 1; \}/)
    const purchase = root(el).querySelector('.info > .purchase')!
    const kids = [...purchase.children].map((c) => c.className)
    expect(kids.indexOf('buy')).toBeLessThan(kids.findIndex((k) => k.includes('description-block')))
  })
})

describe('the thumbnails', () => {
  it('are one row that never wraps, every thumb a part', async () => {
    const el = await open()
    const css = [(VioProductDetail as any).styles].flat().map((s: any) => s.cssText).join("\n") as string
    expect(css).toMatch(/\.gallery-thumbs \{[^}]*flex-wrap: nowrap/)
    expect(root(el).querySelectorAll('[part~="thumb"]')).toHaveLength(10)
    expect(root(el).querySelectorAll('[part~="thumb-active"]')).toHaveLength(1)
  })

  it('arrows appear when the row overflows, off at the ends, and move the row', async () => {
    const el = await open()
    const row = root(el).querySelector<HTMLElement>('.gallery-thumbs')!
    Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 720 })
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 320 })
    row.scrollBy = vi.fn() as any
    el.measureThumbs()
    await settle(el)
    expect(root(el).querySelector('.thumbs')!.classList.contains('overflows')).toBe(true)
    const [prev, next] = root(el).querySelectorAll<HTMLButtonElement>('.thumbs-arrow')
    expect(prev!.disabled).toBe(true)
    expect(next!.disabled).toBe(false)
    next!.click()
    expect(row.scrollBy).toHaveBeenCalledWith({ left: 320 * 0.8 })
  })

  it('choosing a thumb out of view scrolls the row to it, not the page', async () => {
    const el = await open()
    const row = root(el).querySelector<HTMLElement>('.gallery-thumbs')!
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 300 })
    const thumbs = row.querySelectorAll<HTMLElement>('.gallery-thumb')
    thumbs.forEach((t, i) => {
      Object.defineProperty(t, 'offsetLeft', { configurable: true, value: i * 72 })
      Object.defineProperty(t, 'offsetWidth', { configurable: true, value: 64 })
    })
    row.scrollTo = vi.fn() as any
    el.activeImageIndex = 8
    await settle(el)
    expect(row.scrollTo).toHaveBeenCalledWith({ left: 8 * 72 - (300 - 64) / 2 })
  })
})

describe('the layout knobs are public', () => {
  it('applyVioTheme sets the detail, cart, checkout, confirmation and redirect properties', () => {
    applyVioTheme({
      detailLogoHeight: '48px',
      detailImageFit: 'cover',
      detailImageAspect: '4 / 5',
      detailThumbSize: '56px',
      detailOptionHeight: '32px',
      detailBuyPosition: 'sticky',
      checkoutWidth: '480px',
      confirmLogoHeight: '36px',
      redirectSpinner: '#000',
    })
    const st = document.documentElement.style
    expect(st.getPropertyValue('--vio-detail-logo-height')).toBe('48px')
    expect(st.getPropertyValue('--vio-detail-image-fit')).toBe('cover')
    expect(st.getPropertyValue('--vio-detail-image-aspect')).toBe('4 / 5')
    expect(st.getPropertyValue('--vio-detail-thumb-size')).toBe('56px')
    expect(st.getPropertyValue('--vio-detail-option-height')).toBe('32px')
    expect(st.getPropertyValue('--vio-detail-buy-position')).toBe('sticky')
    expect(st.getPropertyValue('--vio-checkout-width')).toBe('480px')
    expect(st.getPropertyValue('--vio-confirm-logo-height')).toBe('36px')
    expect(st.getPropertyValue('--vio-redirect-spinner')).toBe('#000')
  })

  it('every new property is read by a stylesheet (none is a dead knob)', async () => {
    await open()
    const detail = [(VioProductDetail as any).styles].flat().map((s: any) => s.cssText).join("\n") as string
    for (const v of [
      '--vio-detail-logo-height', '--vio-detail-image-fit', '--vio-detail-image-aspect', '--vio-detail-image-max-height',
      '--vio-detail-image-zoom', '--vio-detail-image-inset', '--vio-detail-logo-zoom', '--vio-detail-thumb-size', '--vio-detail-thumb-gap',
      '--vio-detail-option-height', '--vio-detail-option-gap', '--vio-detail-option-wrap', '--vio-detail-button-height',
      '--vio-detail-buy-position', '--vio-detail-width', '--vio-detail-title-size', '--vio-detail-price-size',
    ]) {
      expect(detail, v).toContain(`var(${v}`)
    }
  })
})

describe('Vipps from the detail goes through the hand-over', () => {
  it('start at the tap, then Express off → cancel and the checkout opens with Vipps', async () => {
    vi.spyOn(Vio.cart, 'addProduct').mockReturnValue({} as any)
    vi.spyOn(Vio.checkout, 'getVippsExpressEnabled').mockResolvedValue(false)
    const el = await open()
    const seen: string[] = []
    const on = (e: Event) => seen.push(e.type + ((e as CustomEvent).detail?.reason ? `:${(e as CustomEvent).detail.reason}` : ''))
    for (const n of ['vio:payment-redirect-start', 'vio:payment-redirect-cancel', 'vio:checkout-open']) document.addEventListener(n, on)
    el.buyWithVipps()
    expect(document.querySelector('.vio-redirect-overlay')).not.toBeNull()
    for (let i = 0; i < 4; i++) await settle(el)
    for (const n of ['vio:payment-redirect-start', 'vio:payment-redirect-cancel', 'vio:checkout-open']) document.removeEventListener(n, on)
    expect(seen).toEqual(['vio:payment-redirect-start', 'vio:payment-redirect-cancel:express-off', 'vio:checkout-open'])
  })

  it('a start that throws → error, and the checkout still opens (a usable view)', async () => {
    vi.spyOn(Vio.cart, 'addProduct').mockReturnValue({} as any)
    vi.spyOn(Vio.checkout, 'getVippsExpressEnabled').mockResolvedValue(true)
    vi.spyOn(Vio.checkout, 'startVippsExpress').mockRejectedValue(new Error('gateway down'))
    const el = await open()
    const seen: string[] = []
    const on = (e: Event) => seen.push(e.type)
    for (const n of ['vio:payment-redirect-error', 'vio:checkout-open']) document.addEventListener(n, on)
    el.buyWithVipps()
    for (let i = 0; i < 4; i++) await settle(el)
    for (const n of ['vio:payment-redirect-error', 'vio:checkout-open']) document.removeEventListener(n, on)
    expect(seen).toEqual(['vio:payment-redirect-error', 'vio:checkout-open'])
  })
})

describe('the description', () => {
  it('shows whole, with no «Les mer», when it fits in the preview', async () => {
    const el = await open()
    const block = root(el).querySelector<HTMLElement>('.description-preview')!
    expect(block.querySelector('.desc-head')?.textContent?.trim()).toBe('Beskrivelse')
    expect(block.querySelector('.description')?.textContent).toContain('Myk genser i ull.')
    expect(block.querySelector('.description')!.classList.contains('collapsed')).toBe(false)
    expect(block.querySelector('.desc-more')).toBeNull()
    expect(block.getAttribute('part')).toBe('description')
  })

  it('a longer one: the first lines fading out and «Les mer», which opens it all and folds it back', async () => {
    const el = await open()
    const text = root(el).querySelector<HTMLElement>('.description-preview .description')!
    Object.defineProperty(text, 'scrollHeight', { configurable: true, value: 200 })
    Object.defineProperty(text, 'clientHeight', { configurable: true, value: 66 })
    el.measureDescription()
    await settle(el)
    const more = () => root(el).querySelector<HTMLButtonElement>('.desc-more')!
    expect(text.classList.contains('collapsed')).toBe(true)
    expect(more().textContent?.trim()).toBe('Les mer')
    more().click()
    await settle(el)
    expect(root(el).querySelector('.description-preview .description')!.classList.contains('collapsed')).toBe(false)
    expect(more().textContent?.trim()).toBe('Vis mindre')
    more().click()
    await settle(el)
    expect(root(el).querySelector('.description-preview .description')!.classList.contains('collapsed')).toBe(true)
  })
})

describe('the options a host sets (Replit, Vev, a page)', () => {
  it('description-mode="folded": only the heading until a tap; "open": all of it, no fold', async () => {
    const el = await open()
    el.descriptionMode = 'folded'
    el.open = false
    await settle(el)
    el.open = true
    await settle(el)
    expect(root(el).querySelector('.description-preview .description')).toBeNull()
    root(el).querySelector<HTMLButtonElement>('.desc-head')!.click()
    await settle(el)
    expect(root(el).querySelector('.description-preview .description')?.textContent).toContain('Myk genser i ull.')

    el.descriptionMode = 'open'
    el.open = false
    await settle(el)
    el.open = true
    await settle(el)
    expect(root(el).querySelector('.description-preview .description')?.textContent).toContain('Myk genser i ull.')
    expect(root(el).querySelector('.desc-more')).toBeNull()
    expect(root(el).querySelector('button.desc-head')).toBeNull()
  })

  it('the theme can hide the promises and «Frakt & retur»; the gallery and the description mode follow it too', async () => {
    await open()
    const css = [(VioProductDetail as any).styles].flat().map((s: any) => s.cssText).join("\n") as string
    expect(css).toContain('display: var(--vio-detail-highlights-display, grid)')
    expect(css).toContain('display: var(--vio-detail-shipping-returns-display, block)')
    const src = String(Object.getOwnPropertyDescriptor((VioProductDetail as any).prototype, 'willUpdate')?.value)
    expect(src).toContain('--vio-detail-description-mode')
  })
})

describe('the heading of the description', () => {
  it('«Beskrivelse» by default; the page can say «Produktbeskrivelse»; the element wins', async () => {
    const el = await open()
    const head = () => root(el).querySelector('.desc-head')?.textContent?.trim()
    expect(head()).toBe('Beskrivelse')
    Vio.configureDetail({ descriptionLabel: 'Produktbeskrivelse' })
    await settle(el)
    expect(head()).toBe('Produktbeskrivelse')
    el.descriptionLabel = 'Om produktet'
    await settle(el)
    expect(head()).toBe('Om produktet')
    el.descriptionLabel = ''
    Vio.configureDetail({ descriptionLabel: null })
    await settle(el)
    expect(head()).toBe('Beskrivelse')
  })
})

describe('the main image', () => {
  it('one 4:5 box it fills, the same for every image (no jump), inside the padding by default', async () => {
    await open()
    const css = [(VioProductDetail as any).styles].flat().map((s: any) => s.cssText).join("\n") as string
    expect(css).toContain('aspect-ratio: var(--vio-detail-image-aspect, 4 / 5)')
    expect(css).toContain('object-fit: var(--vio-detail-image-fit, cover)')
    expect(css).toMatch(/margin-inline: calc\(\s*var\(--vio-detail-image-inset, var\(--vio-detail-padding-x/)
  })
})
