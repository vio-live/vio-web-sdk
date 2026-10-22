// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioProductDetail } from './vio-product-detail.js'
import { resetFailedLogos } from '../sponsor-identity.js'
import type { BootstrapResponse } from '../../core/types.js'

/**
 * The product detail says who sells the product: the logo of the sponsor it
 * was fetched with (its name as `alt`). Without a logo that loads, the
 * topbar's seller name does it, and the brand header shows the name only when
 * the topbar names nobody. Asked for by the host (Mote & Livsstil).
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

describe('the brand header of the product detail', () => {
  it('shows the logo of the sponsor the product was fetched with, the name as alt', async () => {
    const el = await open(4)
    const img = root(el).querySelector<HTMLImageElement>('.sponsor-header .sponsor-logo')
    expect(img?.getAttribute('src')).toBe('https://cdn.vio.live/careless.png')
    expect(img?.getAttribute('alt')).toBe('Careless')
    expect(root(el).querySelector('.sponsor-header .sponsor-name')).toBeNull()
    // At the top of the detail, before the gallery.
    expect(root(el).querySelector('.body')?.firstElementChild?.classList.contains('sponsor-header')).toBe(true)
  })

  it('without a logo, the topbar names the seller and the header adds nothing (no name twice)', async () => {
    const el = await open(5)
    expect(root(el).querySelector('.sponsor-header')).toBeNull()
    expect(root(el).querySelector('.topbar-brand')?.textContent?.trim()).toBe('Seller AS')
  })

  it('without a logo and with a topbar that names nobody, the name as text', async () => {
    noSellerName()
    const el = await open(5)
    expect(root(el).querySelector('.sponsor-header .sponsor-logo')).toBeNull()
    expect(root(el).querySelector('.sponsor-header .sponsor-name')?.textContent?.trim()).toBe('Bohus')
  })

  it('a sponsor that only appears in campaigns[] is named too', async () => {
    const el = await open(7)
    expect(root(el).querySelector('.sponsor-header .sponsor-logo')?.getAttribute('alt')).toBe('Sindig')
  })

  it('a logo that fails to load leaves the naming to the topbar', async () => {
    const el = await open(4)
    root(el).querySelector('.sponsor-logo')!.dispatchEvent(new Event('error'))
    await settle(el)
    expect(root(el).querySelector('.sponsor-header')).toBeNull()
    expect(root(el).querySelector('.topbar-brand')?.textContent?.trim()).toBe('Seller AS')
  })

  it('a logo that fails to load, with a topbar that names nobody, falls back to the name', async () => {
    noSellerName()
    const el = await open(4)
    root(el).querySelector('.sponsor-logo')!.dispatchEvent(new Event('error'))
    await settle(el)
    expect(root(el).querySelector('.sponsor-header .sponsor-logo')).toBeNull()
    expect(root(el).querySelector('.sponsor-header .sponsor-name')?.textContent?.trim()).toBe('Careless')
  })

  it('no identity known: no header at all', async () => {
    const el = await open(99)
    expect(root(el).querySelector('.sponsor-header')).toBeNull()
    // The rest of the detail is there.
    expect(root(el).querySelector('.name')?.textContent).toContain('Sindig Morris')
  })

  it("keeps the topbar's seller name as it was", async () => {
    const el = await open(4)
    expect(root(el).querySelector('.topbar-brand')?.textContent?.trim()).toBe('Seller AS')
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
