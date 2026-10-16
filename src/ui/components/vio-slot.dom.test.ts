// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import type { BootstrapCampaignEntry } from '../../core/types.js'
import type { VioProduct } from './vio-product.js'
import type { VioProductCarousel } from './vio-product-carousel.js'
import { VioProductDetail } from './vio-product-detail.js'

/**
 * `vio-slot` on the three product elements (ADR-0027 / ADR-0034): the slot is
 * registered on mount (and when it arrives late, as the React wrappers set
 * it), released on disconnect, carried by every event the element emits, and
 * — without a sponsor — the source of the sponsor.
 *
 * `slot` itself is never touched: it is HTML's own attribute.
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
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

async function mountWithAttributes<T extends HTMLElement>(tag: string, attrs: Record<string, string>): Promise<T> {
  const el = document.createElement(tag) as T
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.body.appendChild(el)
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

describe('<vio-product vio-slot>', () => {
  it('registers the slot from the attribute on mount and releases it on disconnect', async () => {
    const el = await mountWithAttributes<VioProduct>('vio-product', {
      'vio-slot': 'hero',
      'product-id': '9',
      'sponsor-id': '7',
    })
    expect(el.vioSlot).toBe('hero')
    expect(registerSlot).toHaveBeenCalledTimes(1)
    expect(registerSlot).toHaveBeenCalledWith('hero')
    // The native attribute is untouched.
    expect(el.getAttribute('slot')).toBeNull()
    expect(el.slot).toBe('')

    el.remove()
    expect(releases[0]).toHaveBeenCalledTimes(1)
  })

  it('registers a slot that arrives after mount (React sets properties late), re-registering on change', async () => {
    const el = await mount<VioProduct>('vio-product', { productId: '9', sponsorId: '7' })
    expect(registerSlot).not.toHaveBeenCalled()

    el.vioSlot = 'late'
    await settle(el)
    expect(registerSlot).toHaveBeenCalledWith('late')

    el.vioSlot = 'other'
    await settle(el)
    expect(releases[0]).toHaveBeenCalledTimes(1)
    expect(registerSlot).toHaveBeenLastCalledWith('other')

    el.vioSlot = ''
    await settle(el)
    expect(releases[1]).toHaveBeenCalledTimes(1)
    expect(registerSlot).toHaveBeenCalledTimes(2)
  })

  it('carries the slot on vio:product-click and vio:product-add; omits it when empty', async () => {
    const click = lastEvent<{ slot?: string; productId: string }>('vio:product-click')
    const add = lastEvent<{ slot?: string }>('vio:product-add')
    const el = await mountWithAttributes<VioProduct>('vio-product', {
      'vio-slot': 'hero',
      'product-id': '9',
      'sponsor-id': '7',
    })
    el.shadowRoot!.querySelector<HTMLElement>('.card')!.click()
    expect(click.detail).toMatchObject({ productId: '9', slot: 'hero' })
    el.shadowRoot!.querySelector<HTMLElement>('.add-btn')!.click()
    expect(add.detail).toMatchObject({ slot: 'hero' })

    unmountAll()
    const plain = await mountWithAttributes<VioProduct>('vio-product', { 'product-id': '9', 'sponsor-id': '7' })
    plain.shadowRoot!.querySelector<HTMLElement>('.card')!.click()
    expect(click.detail).toMatchObject({ productId: '9' })
    expect(click.detail!.slot).toBeUndefined()
  })
})

describe('<vio-product-carousel vio-slot>', () => {
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

  it('registers its slot, takes the sponsor from the slot campaign and hands the slot to its cards', async () => {
    const el = await mountWithAttributes<VioProductCarousel>('vio-product-carousel', {
      'vio-slot': 'hero',
      'product-ids': '9',
    })
    for (let i = 0; i < 5; i++) await settle(el)

    expect(registerSlot).toHaveBeenCalledWith('hero')
    expect(commerceFor).toHaveBeenCalledWith(7)
    const card = el.shadowRoot!.querySelector<VioProduct>('vio-product')
    expect(card).not.toBeNull()
    expect(card!.vioSlot).toBe('hero')
    expect(card!.getAttribute('sponsor-id')).toBe('7')
    expect(card!.getAttribute('slot')).toBeNull()
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

  it('without a slot it falls back to the default campaign sponsor', async () => {
    const el = await mountWithAttributes<VioProductCarousel>('vio-product-carousel', { 'product-ids': '9' })
    for (let i = 0; i < 5; i++) await settle(el)
    expect(registerSlot).not.toHaveBeenCalled()
    expect(commerceFor).toHaveBeenCalledWith(4)
  })
})

describe('<vio-product-detail> and the slot of the card that opened it', () => {
  let commerceFor: ReturnType<typeof vi.fn>
  let track: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const proto = VioProductDetail.prototype as unknown as Record<string, unknown>
    for (const m of ['loadAvailablePaymentMethods', 'loadVippsButton']) {
      if (typeof proto[m] === 'function') vi.spyOn(proto as never, m as never).mockResolvedValue(undefined as never)
    }
    vi.spyOn(Vio, 'campaignForSlot').mockImplementation((slot) =>
      slot === 'hero' ? CAMPAIGN_12 : slot ? DEFAULT_10 : null,
    )
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

  it('a card without a sponsor opens with the primary sponsor of its slot campaign, and view_item carries the slot', async () => {
    const el = await mount<VioProductDetail>('vio-product-detail')
    await click({ productId: '9', sponsorId: '', slot: 'hero' }, el)
    expect(el.open).toBe(true)
    expect(el.sponsorId).toBe(7)
    expect(commerceFor).toHaveBeenCalledWith(7)
    expect(track).toHaveBeenCalledWith(
      'view_item',
      expect.objectContaining({ context: expect.objectContaining({ slot: 'hero', sponsorId: 7 }) }),
    )
  })

  it('without a slot and without a bootstrap it stays closed, as before', async () => {
    const el = await mount<VioProductDetail>('vio-product-detail')
    await click({ productId: '9', sponsorId: '' }, el)
    expect(el.open).toBe(false)
    expect(commerceFor).not.toHaveBeenCalled()
  })

  it("its own vio-slot is registered and used when the card names none", async () => {
    const el = await mountWithAttributes<VioProductDetail>('vio-product-detail', { 'vio-slot': 'hero' })
    expect(registerSlot).toHaveBeenCalledWith('hero')
    await click({ productId: '9', sponsorId: '' }, el)
    expect(el.sponsorId).toBe(7)
    expect(track).toHaveBeenCalledWith(
      'view_item',
      expect.objectContaining({ context: expect.objectContaining({ slot: 'hero' }) }),
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
