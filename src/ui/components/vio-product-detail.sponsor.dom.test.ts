// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioProductDetail } from './vio-product-detail.js'
import { resetFailedLogos } from '../sponsor-identity.js'
import type { BootstrapResponse } from '../../core/types.js'

/**
 * The product detail says who sells the product, in its top bar beside the
 * close (Mote & Livsstil, 2026-10-22): the logo of the sponsor it was fetched
 * with — never the article's — its name as `alt`; without a logo that loads,
 * the sponsor's name; without any identity, the seller's Company name (or
 * the product's brand), as before 0.28.
 */

const product = {
  id: 9,
  brand: 'SINDIG',
  title: 'Sindig Morris bordlampe',
  quantity: 5,
  price: { amount: 1699, currency_code: 'NOK' },
  images: [],
  variants: [],
  options: [],
}

const sponsor = (id: number, name: string, logoUrl: string | null) => ({
  id,
  name,
  logoUrl,
  avatarUrl: null,
  commerce: { apiKey: `key-${id}` },
})

const BOOT: BootstrapResponse = {
  campaign: { id: 10, name: 'Default' },
  primarySponsor: sponsor(4, 'Careless', 'https://cdn.vio.live/careless.png'),
  secondarySponsors: [sponsor(5, 'Bohus', '')],
  // Sponsor 7 lives only in a non-default campaign.
  campaigns: [{ id: 12, name: 'Hero', primarySponsor: sponsor(7, 'Sindig', 'https://cdn.vio.live/sindig.svg') }],
}

const facade = () => Vio as unknown as { cachedBootstrap: BootstrapResponse | null }
const root = (el: HTMLElement) => el.shadowRoot!

beforeEach(() => {
  resetFailedLogos()
  facade().cachedBootstrap = BOOT
  const proto = VioProductDetail.prototype as any
  for (const m of ['loadAvailablePaymentMethods', 'loadVippsButton']) {
    if (typeof proto[m] === 'function') vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(Vio.checkout, 'prepareApplePayFor').mockResolvedValue({ available: false, show: async () => {} } as any)
  vi.spyOn(Vio, 'commerceFor').mockReturnValue({
    channel: {
      product: {
        getByIds: vi.fn().mockResolvedValue([product]),
        getSellerCompany: vi.fn().mockResolvedValue('Seller AS'),
      },
    },
  } as any)
})

afterEach(() => {
  product.brand = 'SINDIG'
  unmountAll()
  facade().cachedBootstrap = null
  vi.restoreAllMocks()
})

/** The seller has no Company name and the product no brand: the topbar names nobody. */
function noSellerName() {
  product.brand = ''
  vi.spyOn(Vio, 'commerceFor').mockReturnValue({
    channel: {
      product: {
        getByIds: vi.fn().mockResolvedValue([product]),
        getSellerCompany: vi.fn().mockResolvedValue(null),
      },
    },
  } as any)
}

async function open(sponsorId: number) {
  const el = await mount<HTMLElement>('vio-product-detail')
  document.dispatchEvent(
    new CustomEvent('vio:product-click', { detail: { productId: '9', sponsorId: String(sponsorId) } }),
  )
  for (let i = 0; i < 5; i++) await settle(el)
  return el
}

describe('the brand in the top bar of the product detail', () => {
  const topbar = (el: HTMLElement) => root(el).querySelector('.topbar-sponsor')!
  const logo = (el: HTMLElement) => topbar(el).querySelector<HTMLImageElement>('.topbar-logo')
  const name = (el: HTMLElement) => topbar(el).querySelector('.topbar-name')?.textContent?.trim() ?? null

  it('shows the logo of the sponsor the product was fetched with, the name as alt, beside the close', async () => {
    const el = await open(4)
    expect(logo(el)?.getAttribute('src')).toBe('https://cdn.vio.live/careless.png')
    expect(logo(el)?.getAttribute('alt')).toBe('Careless')
    expect(name(el)).toBeNull()
    // In the top bar, not in the image area.
    expect(topbar(el).parentElement?.classList.contains('topbar')).toBe(true)
    expect(topbar(el).nextElementSibling?.classList.contains('close')).toBe(true)
    expect(root(el).querySelector('.body .topbar-logo')).toBeNull()
  })

  it("without a logo, the sponsor's name — not the seller's Company name", async () => {
    const el = await open(5)
    expect(logo(el)).toBeNull()
    expect(name(el)).toBe('Bohus')
  })

  it('a sponsor that only appears in campaigns[] is named too', async () => {
    const el = await open(7)
    expect(logo(el)?.getAttribute('alt')).toBe('Sindig')
  })

  it('a logo that fails to load falls back to the name', async () => {
    const el = await open(4)
    logo(el)!.dispatchEvent(new Event('error'))
    await settle(el)
    expect(logo(el)).toBeNull()
    expect(name(el)).toBe('Careless')
  })

  it("no identity known: the seller's Company name, as before", async () => {
    const el = await open(99)
    expect(logo(el)).toBeNull()
    expect(name(el)).toBe('Seller AS')
    expect(root(el).querySelector('.name')?.textContent).toContain('Sindig Morris')
  })

  it('no identity and no seller name: the product brand', async () => {
    noSellerName()
    product.brand = 'SINDIG'
    const el = await open(99)
    expect(name(el)).toBe('SINDIG')
  })

  it('the parts a host styles are there', async () => {
    const el = await open(4)
    for (const part of ['topbar', 'sponsor', 'close', 'gallery', 'image', 'info', 'title', 'price', 'buy']) {
      expect(root(el).querySelector(`[part~="${part}"]`), part).not.toBeNull()
    }
  })
})

describe('the same rule for the cart line and the checkout-open event', () => {
  it('add to cart keeps the brand name of a sponsor that only appears in campaigns[]', async () => {
    const add = vi.spyOn(Vio.cart, 'addProduct').mockReturnValue({} as any)
    const el = (await open(7)) as HTMLElement & Record<string, any>
    el.addCurrentToCart()
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ sponsorId: 7, sponsorName: 'Sindig' }))
  })

  it('vio:checkout-open carries the sponsor: { id, name, logoUrl }', async () => {
    vi.spyOn(Vio.cart, 'addProduct').mockReturnValue({} as any)
    const el = (await open(7)) as HTMLElement & Record<string, any>
    const seen: any[] = []
    const listener = (e: Event) => seen.push((e as CustomEvent).detail)
    document.addEventListener('vio:checkout-open', listener)
    el.buyNow()
    document.removeEventListener('vio:checkout-open', listener)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ sponsorId: 7, sponsor: { id: 7, name: 'Sindig', logoUrl: 'https://cdn.vio.live/sindig.svg' } })
  })
})

describe('the cart', () => {
  it("labels a sponsor's lines with the brand name by the same rule, and its checkout-open carries the sponsor", async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-cart')
    el.carts = new Map([
      [7, { sponsorId: 7, currency: 'NOK', items: [{ id: 'i1', productId: 9, sponsorId: 7, brand: 'SINDIG', name: 'Lampe', quantity: 1, unitPrice: 1699, currency: 'NOK', imageUrl: '' }] }],
    ])
    el.itemCount = 1
    el.availableMethods = ['Qliro']
    el.open = true
    await settle(el)
    expect(el.shadowRoot?.querySelector('.sponsor-label')?.textContent?.trim()).toBe('Sindig')
    const seen: any[] = []
    const listener = (e: Event) => seen.push((e as CustomEvent).detail)
    document.addEventListener('vio:checkout-open', listener)
    el.onCheckout()
    document.removeEventListener('vio:checkout-open', listener)
    expect(seen[0]).toMatchObject({ sponsorId: 7, sponsor: { id: 7, name: 'Sindig', logoUrl: 'https://cdn.vio.live/sindig.svg' } })
  })
})
