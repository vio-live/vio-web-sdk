// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, settle, unmountAll } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import type { BootstrapCampaignEntry, BootstrapResponse } from '../../core/types.js'

/**
 * The sponsor on the carousel's `component_impression` and `view_item_list`.
 * Hosts like Replit set no `sponsor-id`: the carousel buys with the primary
 * sponsor of the campaign its slot shows, and its events must say that same
 * sponsor — in `context.sponsor_id` and on every `commerce.items[]` line —
 * or the dashboard, filtered by brand, shows 0 impressions and a conversion of
 * 0 % (prod, 2026-11-06: `sponsor_id: 0, product_ids: ["421319"]`). A
 * carousel mixing brands (`product-refs`) names no single sponsor in the
 * context; each item carries its own.
 */

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  constructor(private readonly cb: (entries: unknown[]) => void) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(): void {}
  disconnect(): void {}
  intersect(): void {
    this.cb([{ isIntersecting: true, intersectionRatio: 1 }])
  }
}

const sponsor = (id: number) => ({ id, name: `Sponsor ${id}`, commerce: { apiKey: `key-${id}` } })

const CAMPAIGN_2: BootstrapCampaignEntry = {
  id: 2,
  name: 'Mote & Livsstil',
  status: 'active',
  primarySponsor: sponsor(1301),
  secondarySponsors: [sponsor(1327)],
  slots: [{ name: 'sp-a' }, { name: 'sp-b' }, { name: 'sp-c' }, { name: 'sp-d' }],
}

const BOOT: BootstrapResponse = {
  campaign: { id: 2, name: 'Mote & Livsstil' },
  primarySponsor: sponsor(1301),
  secondarySponsors: [sponsor(1327)],
  campaigns: [CAMPAIGN_2],
}

const products = [
  { id: 421319, title: 'Tights', price: { amount: 499, currency_code: 'NOK' }, images: [], variants: [] },
  { id: 421320, title: 'Genser', price: { amount: 899, currency_code: 'NOK' }, images: [], variants: [] },
]

const facade = () => Vio as unknown as { cachedBootstrap: BootstrapResponse | null }

const events: Array<Record<string, any>> = []
const onAnalytics = (e: Event) => events.push((e as CustomEvent).detail)

beforeEach(() => {
  events.length = 0
  FakeIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  Vio.init({ apiKey: 'test-key', eventsBase: 'https://events.test' })
  facade().cachedBootstrap = BOOT
  vi.spyOn(Vio, 'campaignForSlot').mockReturnValue(CAMPAIGN_2)
  vi.spyOn(Vio, 'commerceFor').mockImplementation(
    () =>
      ({
        channel: {
          product: {
            getByIds: vi.fn(async ({ product_ids }: { product_ids: number[] }) =>
              products.filter((p) => product_ids.includes(p.id)),
            ),
          },
        },
      }) as any,
  )
  window.addEventListener('vio:analytics', onAnalytics)
})

afterEach(() => {
  window.removeEventListener('vio:analytics', onAnalytics)
  facade().cachedBootstrap = null
  unmountAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The last observer created enters the viewport and stays 1 s. */
function seenForOneSecond(): void {
  vi.useFakeTimers()
  FakeIntersectionObserver.instances.at(-1)!.intersect()
  vi.advanceTimersByTime(1_000)
  vi.useRealTimers()
}

const impression = () => events.find((e) => e.name === 'component_impression')!
const viewItemList = () => events.find((e) => e.name === 'view_item_list')!
const itemSponsors = (ev: Record<string, any>) => ev.commerce.items.map((i: Record<string, unknown>) => i.sponsor_id)

describe('vio-product-carousel — the sponsor on the impression', () => {
  it('without sponsor-id, the slot campaign\'s primary sponsor is the context sponsor and every item\'s', async () => {
    const el = await mount<HTMLElement>('vio-product-carousel', {
      productIds: '421319,421320',
      vioSlot: 'sp-a',
    } as any)
    for (let i = 0; i < 3; i++) await settle(el)
    seenForOneSecond()

    const imp = impression()
    expect(imp.context).toMatchObject({ sponsor_id: 1301, campaign_id: 2, location_id: 'sp-a' })
    expect(imp.commerce.items.map((i: { product_id: string }) => i.product_id)).toEqual(['421319', '421320'])
    expect(itemSponsors(imp)).toEqual([1301, 1301])

    const list = viewItemList()
    expect(list.context).toMatchObject({ sponsor_id: 1301, campaign_id: 2 })
    expect(itemSponsors(list)).toEqual([1301, 1301])
  })

  it('product-refs of two sponsors: no context sponsor, each item says its own', async () => {
    const el = await mount<HTMLElement>('vio-product-carousel', {
      productRefs: '1301:421319,1327:421320',
      vioSlot: 'sp-b',
    } as any)
    for (let i = 0; i < 3; i++) await settle(el)
    seenForOneSecond()

    const imp = impression()
    expect(imp.context).not.toHaveProperty('sponsor_id')
    expect(imp.context).toMatchObject({ campaign_id: 2, location_id: 'sp-b' })
    expect(itemSponsors(imp)).toEqual([1301, 1327])

    const list = viewItemList()
    expect(list.context).not.toHaveProperty('sponsor_id')
    expect(itemSponsors(list)).toEqual([1301, 1327])
  })

  it('product-refs of one sponsor: that sponsor is the context sponsor, whatever the slot shows', async () => {
    vi.mocked(Vio.campaignForSlot).mockReturnValue({ ...CAMPAIGN_2, primarySponsor: sponsor(99) })
    const el = await mount<HTMLElement>('vio-product-carousel', {
      productRefs: '1327:421319,1327:421320',
      vioSlot: 'sp-c',
    } as any)
    for (let i = 0; i < 3; i++) await settle(el)
    seenForOneSecond()

    expect(impression().context.sponsor_id).toBe(1327)
    expect(itemSponsors(impression())).toEqual([1327, 1327])
  })

  it('a host that sets sponsor-id still wins over the slot', async () => {
    const el = await mount<HTMLElement>('vio-product-carousel', {
      productIds: '421319',
      sponsorId: 7,
      vioSlot: 'sp-d',
    } as any)
    for (let i = 0; i < 3; i++) await settle(el)
    seenForOneSecond()

    expect(impression().context.sponsor_id).toBe(7)
    expect(itemSponsors(impression())).toEqual([7])
    expect(viewItemList().context.sponsor_id).toBe(7)
  })
})
