// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import type { BootstrapCampaignEntry } from '../../core/types.js'
import type { VioProduct } from './vio-product.js'
import type { VioProductCarousel } from './vio-product-carousel.js'
import { VioProductDetail } from './vio-product-detail.js'

/**
 * Slot identity of the three product elements (ADR-0027 / ADR-0034): every
 * element registers itself — `vio-slot` when the host set it, else an auto id
 * `${scope}-${kind}-${ordinal + 1}` with the scope inherited from the DOM —
 * on mount (and when the attributes arrive late, as the React wrappers set
 * them), releases it on disconnect, and carries the effective id plus the
 * content on every event it emits. `slot` itself is never touched: it is
 * HTML's own attribute.
 */

const sponsor = (id: number) => ({ id, name: `Sponsor ${id}`, commerce: { apiKey: `key-${id}` } })

const CAMPAIGN_12: BootstrapCampaignEntry = {
  id: 12,
  name: 'Newer',
  status: 'active',
  primarySponsor: sponsor(7),
  secondarySponsors: [],
  slots: [{ name: 'hero' }],
}
const DEFAULT_10: BootstrapCampaignEntry = {
  id: 10,
  name: 'Default',
  status: 'active',
  isDefault: true,
  primarySponsor: sponsor(4),
  secondarySponsors: [],
  slots: [],
}

const product = {
  id: 9,
  brand: 'SINDIG',
  title: 'Sindig Morris bordlampe',
  price: { amount: 1699, currency_code: 'NOK' },
  images: [],
  variants: [],
  options: [],
}

/** `Vio.registerSlot` replaced by a spy that hands out one release fn per call. */
let registerSlot: ReturnType<typeof vi.fn>
let releases: Array<ReturnType<typeof vi.fn>>

beforeEach(() => {
  releases = []
  registerSlot = vi.fn(() => {
    const release = vi.fn()
    releases.push(release)
    return release
  })
  vi.spyOn(Vio, 'registerSlot').mockImplementation(registerSlot as never)
  vi.spyOn(Vio, 'content').mockReturnValue({ id: 'article-123', title: 'Título' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  unmountAll()
  for (const attr of ['data-vio-scope', 'data-vio-scope-name']) document.body.removeAttribute(attr)
  vi.restoreAllMocks()
})

async function mountWithAttributes<T extends HTMLElement>(
  tag: string,
  attrs: Record<string, string>,
  parent: HTMLElement = document.body,
): Promise<T> {
  const el = document.createElement(tag) as T
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  parent.appendChild(el)
  await settle(el)
  return el
}

function lastEvent<T>(type: string): { detail: T | null } {
  const box: { detail: T | null } = { detail: null }
  document.addEventListener(type, (e) => {
    box.detail = (e as CustomEvent<T>).detail
  })
  return box
}

const CARD = { 'product-id': '9', 'sponsor-id': '7' }

describe('<vio-product>: identity', () => {
  it('registers `vio-slot` (and `vio-slot-name`) when the host set them, and releases on disconnect', async () => {
    const el = await mountWithAttributes<VioProduct>('vio-product', { ...CARD, 'vio-slot': 'hero', 'vio-slot-name': 'Hero banner' })
    expect(el.effectiveSlot).toBe('hero')
    expect(registerSlot).toHaveBeenCalledTimes(1)
    expect(registerSlot).toHaveBeenCalledWith('hero', 'Hero banner')
    // The native attribute is untouched.
    expect(el.getAttribute('slot')).toBeNull()
    expect(el.slot).toBe('')

    el.remove()
    expect(releases[0]).toHaveBeenCalledTimes(1)
    expect(el.effectiveSlot).toBe('')
  })

  it('a host id without a name leaves the display name undefined (the server keeps its own)', async () => {
    await mountWithAttributes<VioProduct>('vio-product', { ...CARD, 'vio-slot': 'hero' })
    expect(registerSlot).toHaveBeenCalledWith('hero', undefined)
  })

  it('without `vio-slot` it registers itself as `card-N` by position, named `Card N`', async () => {
    const first = await mountWithAttributes<VioProduct>('vio-product', CARD)
    const second = await mountWithAttributes<VioProduct>('vio-product', CARD)
    expect(first.effectiveSlot).toBe('card-1')
    expect(second.effectiveSlot).toBe('card-2')
    expect(registerSlot).toHaveBeenNthCalledWith(1, 'card-1', 'Card 1')
    expect(registerSlot).toHaveBeenNthCalledWith(2, 'card-2', 'Card 2')
  })

  it('the auto id is stable across reloads of the same layout', async () => {
    const a = await mountWithAttributes<VioProduct>('vio-product', CARD)
    const idA = a.effectiveSlot
    unmountAll()
    const b = await mountWithAttributes<VioProduct>('vio-product', CARD)
    expect(b.effectiveSlot).toBe(idA)
    expect(idA).toBe('card-1')
  })

  it('a `vio-slot` set after mount (React) replaces the auto id; clearing it goes back to it', async () => {
    const el = await mount<VioProduct>('vio-product', { productId: '9', sponsorId: '7' })
    expect(registerSlot).toHaveBeenLastCalledWith('card-1', 'Card 1')

    el.vioSlot = 'late'
    await settle(el)
    expect(releases[0]).toHaveBeenCalledTimes(1)
    expect(registerSlot).toHaveBeenLastCalledWith('late', undefined)
    expect(el.effectiveSlot).toBe('late')

    el.vioSlotName = 'Late slot'
    await settle(el)
    expect(registerSlot).toHaveBeenLastCalledWith('late', 'Late slot')

    el.vioSlot = ''
    await settle(el)
    expect(el.effectiveSlot).toBe('card-1')
    expect(registerSlot).toHaveBeenLastCalledWith('card-1', 'Late slot')
  })
})

describe('scope, inherited from the DOM', () => {
  it('`data-vio-scope` on an ancestor prefixes the auto id; `data-vio-scope-name` labels it', async () => {
    document.body.setAttribute('data-vio-scope', 'article-123')
    document.body.setAttribute('data-vio-scope-name', 'Título del artículo')
    const carousel = await mountWithAttributes<VioProductCarousel>('vio-product-carousel', {})
    const card = await mountWithAttributes<VioProduct>('vio-product', CARD)
    expect(carousel.effectiveSlot).toBe('article-123-carousel-1')
    expect(card.effectiveSlot).toBe('article-123-card-1')
    expect(registerSlot).toHaveBeenCalledWith('article-123-carousel-1', 'Carousel 1 · Título del artículo')
    expect(registerSlot).toHaveBeenCalledWith('article-123-card-1', 'Card 1 · Título del artículo')
  })

  it("the element's own `vio-scope` wins over the ancestor's, and ordinals count per scope", async () => {
    document.body.setAttribute('data-vio-scope', 'page')
    const a = await mountWithAttributes<VioProductCarousel>('vio-product-carousel', {})
    const b = await mountWithAttributes<VioProductCarousel>('vio-product-carousel', { 'vio-scope': 'sidebar', 'vio-scope-name': 'Sidebar' })
    const c = await mountWithAttributes<VioProductCarousel>('vio-product-carousel', {})
    const d = await mountWithAttributes<VioProductCarousel>('vio-product-carousel', { 'vio-scope': 'sidebar' })
    expect(a.effectiveSlot).toBe('page-carousel-1')
    expect(b.effectiveSlot).toBe('sidebar-carousel-1')
    expect(c.effectiveSlot).toBe('page-carousel-2')
    expect(d.effectiveSlot).toBe('sidebar-carousel-2')
    expect(registerSlot).toHaveBeenCalledWith('sidebar-carousel-1', 'Carousel 1 · Sidebar')
    expect(registerSlot).toHaveBeenCalledWith('sidebar-carousel-2', 'Carousel 2') // no label on d nor on body
  })

  it('a nested scope applies to its subtree only', async () => {
    const section = document.createElement('section')
    section.setAttribute('data-vio-scope', 'related')
    document.body.appendChild(section)
    const inside = await mountWithAttributes<VioProduct>('vio-product', CARD, section)
    const outside = await mountWithAttributes<VioProduct>('vio-product', CARD)
    expect(inside.effectiveSlot).toBe('related-card-1')
    expect(outside.effectiveSlot).toBe('card-1')
  })

  it('a `vio-slot` ignores the scope: it is the host\'s id as written', async () => {
    document.body.setAttribute('data-vio-scope', 'article-123')
    const el = await mountWithAttributes<VioProduct>('vio-product', { ...CARD, 'vio-slot': 'hero' })
    expect(el.effectiveSlot).toBe('hero')
  })
})

describe('<vio-product>: what its events carry', () => {
  it('vio:product-click and vio:product-add carry the effective slot and the attribution', async () => {
    vi.spyOn(Vio, 'campaignForSlot').mockImplementation((slot) => (slot === 'hero' ? CAMPAIGN_12 : DEFAULT_10))
    const click = lastEvent<Record<string, unknown>>('vio:product-click')
    const add = lastEvent<Record<string, unknown>>('vio:product-add')
    const el = await mountWithAttributes<VioProduct>('vio-product', { ...CARD, 'vio-slot': 'hero' })
    el.shadowRoot!.querySelector<HTMLElement>('.card')!.click()
    expect(click.detail).toMatchObject({
      productId: '9',
      sponsorId: '7',
      slot: 'hero',
      contentId: 'article-123',
      contentTitle: 'Título',
    })
    el.shadowRoot!.querySelector<HTMLElement>('.add-btn')!.click()
    expect(add.detail).toMatchObject({ slot: 'hero', sponsorId: '7' })
  })

  it('without `vio-slot` the auto id travels; `vio-content-id` / `vio-content-title` override the page content', async () => {
    const click = lastEvent<Record<string, unknown>>('vio:product-click')
    const el = await mountWithAttributes<VioProduct>('vio-product', {
      ...CARD,
      'vio-content-id': 'teaser-5',
      'vio-content-title': 'Teaser',
    })
    el.shadowRoot!.querySelector<HTMLElement>('.card')!.click()
    expect(click.detail).toMatchObject({ slot: 'card-1', contentId: 'teaser-5', contentTitle: 'Teaser' })
  })
})

describe('<vio-product-carousel>', () => {
  let commerceFor: ReturnType<typeof vi.fn>

  beforeEach(() => {
    Vio.init({ apiKey: 'test-key', environment: 'testing' })
    vi.spyOn(Vio, 'bootstrap').mockResolvedValue({} as never)
    vi.spyOn(Vio, 'campaignForSlot').mockImplementation((slot) => (slot === 'hero' ? CAMPAIGN_12 : DEFAULT_10))
    commerceFor = vi.fn().mockReturnValue({
      channel: { product: { getByIds: vi.fn().mockResolvedValue([product]) } },
    })
    vi.spyOn(Vio, 'commerceFor').mockImplementation(commerceFor as never)
  })

  it('registers its slot, takes the sponsor from the slot campaign and hands the slot + content to its cards', async () => {
    const el = await mountWithAttributes<VioProductCarousel>('vio-product-carousel', {
      'vio-slot': 'hero',
      'product-ids': '9',
      'vio-content-id': 'art-1',
    })
    for (let i = 0; i < 5; i++) await settle(el)

    expect(registerSlot).toHaveBeenCalledWith('hero', undefined)
    expect(commerceFor).toHaveBeenCalledWith(7)
    const card = el.shadowRoot!.querySelector<VioProduct>('vio-product')
    expect(card).not.toBeNull()
    expect(card!.vioSlot).toBe('hero')
    expect(card!.effectiveSlot).toBe('hero')
    expect(card!.vioContentId).toBe('art-1')
    expect(card!.getAttribute('sponsor-id')).toBe('7')
    expect(card!.getAttribute('slot')).toBeNull()
    // The card registers the SAME id (the registry dedupes): no `card-N` for it.
    expect(registerSlot.mock.calls.map((c) => c[0])).toEqual(['hero', 'hero'])
  })

  it('an explicit sponsor-id still wins over the slot', async () => {
    const el = await mountWithAttributes<VioProductCarousel>('vio-product-carousel', {
      'vio-slot': 'hero',
      'product-ids': '9',
      'sponsor-id': '3',
    })
    for (let i = 0; i < 5; i++) await settle(el)
    expect(commerceFor).toHaveBeenCalledWith(3)
    expect(commerceFor).not.toHaveBeenCalledWith(7)
  })

  it('without `vio-slot` it is `carousel-1`, its cards inherit that id, and the sponsor is the default campaign one', async () => {
    const el = await mountWithAttributes<VioProductCarousel>('vio-product-carousel', { 'product-ids': '9' })
    for (let i = 0; i < 5; i++) await settle(el)
    expect(el.effectiveSlot).toBe('carousel-1')
    expect(registerSlot).toHaveBeenCalledWith('carousel-1', 'Carousel 1')
    expect(commerceFor).toHaveBeenCalledWith(4)
    expect(el.shadowRoot!.querySelector<VioProduct>('vio-product')!.effectiveSlot).toBe('carousel-1')
  })
})

describe('<vio-product-detail> and the card that opened it', () => {
  let commerceFor: ReturnType<typeof vi.fn>
  let track: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const proto = VioProductDetail.prototype as unknown as Record<string, unknown>
    for (const m of ['loadAvailablePaymentMethods', 'loadVippsButton']) {
      if (typeof proto[m] === 'function') vi.spyOn(proto as never, m as never).mockResolvedValue(undefined as never)
    }
    // Only `hero` has a campaign here — as before any bootstrap for everything else.
    vi.spyOn(Vio, 'campaignForSlot').mockImplementation((slot) => (slot === 'hero' ? CAMPAIGN_12 : null))
    commerceFor = vi.fn().mockReturnValue({
      channel: {
        product: { getByIds: vi.fn().mockResolvedValue([product]), getSellerCompany: vi.fn().mockResolvedValue(null) },
      },
    })
    vi.spyOn(Vio, 'commerceFor').mockImplementation(commerceFor as never)
    track = vi.fn()
    vi.spyOn(Vio.analytics, 'track').mockImplementation(track as never)
  })

  async function click(detail: Record<string, unknown>, el: HTMLElement) {
    document.dispatchEvent(new CustomEvent('vio:product-click', { detail }))
    for (let i = 0; i < 5; i++) await settle(el)
  }

  it('registers itself as `detail-1`', async () => {
    const el = await mount<VioProductDetail>('vio-product-detail')
    expect(el.effectiveSlot).toBe('detail-1')
    expect(registerSlot).toHaveBeenCalledWith('detail-1', 'Detail 1')
  })

  it('a card without a sponsor opens with the primary sponsor of its slot campaign; view_item carries slot + content', async () => {
    const el = await mount<VioProductDetail>('vio-product-detail')
    await click({ productId: '9', sponsorId: '', slot: 'hero', contentId: 'art-9', contentTitle: 'Nine' }, el)
    expect(el.open).toBe(true)
    expect(el.sponsorId).toBe(7)
    expect(commerceFor).toHaveBeenCalledWith(7)
    expect(track).toHaveBeenCalledWith(
      'view_item',
      expect.objectContaining({
        context: expect.objectContaining({ slot: 'hero', sponsorId: 7, contentId: 'art-9', contentTitle: 'Nine' }),
      }),
    )
  })

  it('without a sponsor and without a campaign for the slot it stays closed, as before', async () => {
    const el = await mount<VioProductDetail>('vio-product-detail')
    await click({ productId: '9', sponsorId: '', slot: 'card-3' }, el)
    expect(el.open).toBe(false)
    expect(commerceFor).not.toHaveBeenCalled()
  })

  it("its own `vio-slot` is used when the card names none", async () => {
    const el = await mountWithAttributes<VioProductDetail>('vio-product-detail', { 'vio-slot': 'hero' })
    expect(registerSlot).toHaveBeenCalledWith('hero', undefined)
    await click({ productId: '9', sponsorId: '' }, el)
    expect(el.sponsorId).toBe(7)
    expect(track).toHaveBeenCalledWith(
      'view_item',
      expect.objectContaining({ context: expect.objectContaining({ slot: 'hero', contentId: 'article-123' }) }),
    )
    el.remove()
    expect(releases[0]).toHaveBeenCalledTimes(1)
  })

  it('an explicit sponsor on the card is kept; the slot still travels with the events', async () => {
    const el = await mount<VioProductDetail>('vio-product-detail')
    await click({ productId: '9', sponsorId: '3', slot: 'hero' }, el)
    expect(el.sponsorId).toBe(3)
    expect(commerceFor).toHaveBeenCalledWith(3)
    expect(track).toHaveBeenCalledWith(
      'view_item',
      expect.objectContaining({ context: expect.objectContaining({ slot: 'hero', sponsorId: 3 }) }),
    )
  })
})
