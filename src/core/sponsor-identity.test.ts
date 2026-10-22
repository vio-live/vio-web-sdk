import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  CHECKOUT_SPONSOR_MEMORY_MAX,
  CHECKOUT_SPONSOR_STORAGE_KEY,
  findSponsorIn,
  rememberCheckoutSponsor,
  rememberedCheckoutSponsor,
  rememberedSponsor,
  resetCheckoutSponsorMemory,
  sponsorIdentityFrom,
} from './sponsor-identity.js'
import { Vio } from './client.js'
import { Configuration } from './configuration.js'
import { resetBuyerRefSupport } from './api/cart-queries.js'
import type { BootstrapResponse } from './types.js'

/**
 * Who sells — the sponsor's (brand's) name and logo, by ONE rule: the
 * bootstrap's config sponsors, then every campaigns[] sponsor (first match);
 * then what this tab remembered of the checkout; then the cart's name.
 * The host (Replit, Mote & Livsstil) asked for it on the product, in the
 * checkout and on the confirmation — after Vipps and after a reload too.
 */

const sponsor = (id: number, name: string, logoUrl: string | null = null, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  logoUrl,
  avatarUrl: null,
  commerce: { apiKey: `key-${id}` },
  ...extra,
})

const BOOT: BootstrapResponse = {
  campaign: { id: 10, name: 'Default' },
  primarySponsor: sponsor(4, 'Careless', 'https://cdn.vio.live/careless.png'),
  secondarySponsors: [sponsor(5, 'Bohus', '')],
  campaigns: [
    {
      id: 12,
      name: 'Hero',
      primarySponsor: sponsor(7, ' Sindig ', 'https://cdn.vio.live/sindig.svg?v=2', { avatarUrl: 'https://cdn.vio.live/a7.png' }),
      secondarySponsors: [sponsor(8, 'Kid Interiør')],
    },
    // A later block for an id already found earlier: the first match wins.
    { id: 13, name: 'Other', primarySponsor: sponsor(4, 'Careless (old)', 'https://cdn.vio.live/old.png') },
  ],
}

/** A Storage that lives in a Map — the test's own, never the runtime's. */
function memoryStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  }
}

const facade = () => Vio as unknown as { cachedBootstrap: BootstrapResponse | null }

let store: ReturnType<typeof memoryStorage>
beforeEach(() => {
  store = memoryStorage()
  vi.stubGlobal('sessionStorage', store)
  resetCheckoutSponsorMemory()
  // Nothing here may reach a real backend; the tests that need an answer give it.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetCheckoutSponsorMemory()
  facade().cachedBootstrap = null
  Vio.cart.clearAllCarts()
})

describe('sponsorIdentityFrom — the one resolver', () => {
  it("the config's primary sponsor: name and logo as given", () => {
    expect(sponsorIdentityFrom(BOOT, 4)).toEqual({
      id: 4,
      name: 'Careless',
      logoUrl: 'https://cdn.vio.live/careless.png',
      avatarUrl: null,
    })
  })

  it('a secondary sponsor; an empty logo is no logo', () => {
    expect(sponsorIdentityFrom(BOOT, 5)).toEqual({ id: 5, name: 'Bohus', logoUrl: null, avatarUrl: null })
  })

  it('a sponsor that only appears in campaigns[] (primary or secondary); the name trimmed, the URL untouched', () => {
    expect(sponsorIdentityFrom(BOOT, 7)).toEqual({
      id: 7,
      name: 'Sindig',
      logoUrl: 'https://cdn.vio.live/sindig.svg?v=2',
      avatarUrl: 'https://cdn.vio.live/a7.png',
    })
    expect(sponsorIdentityFrom(BOOT, 8)?.name).toBe('Kid Interiør')
  })

  it('the first match wins: the config block before a campaign block of the same id', () => {
    expect(sponsorIdentityFrom(BOOT, 4)?.name).toBe('Careless')
  })

  it('a string id (an attribute) is the same sponsor', () => {
    expect(sponsorIdentityFrom(BOOT, '7')?.name).toBe('Sindig')
  })

  it('an unknown id, no id, no bootstrap or a broken one: null, never a throw', () => {
    expect(sponsorIdentityFrom(BOOT, 99)).toBeNull()
    expect(sponsorIdentityFrom(BOOT, undefined)).toBeNull()
    expect(sponsorIdentityFrom(BOOT, 0)).toBeNull()
    expect(sponsorIdentityFrom(BOOT, 'abc')).toBeNull()
    expect(sponsorIdentityFrom(null, 4)).toBeNull()
    expect(sponsorIdentityFrom({ campaigns: 'nope', secondarySponsors: 'x' } as unknown as BootstrapResponse, 4)).toBeNull()
  })

  it('a block with neither a name nor a logo names nobody', () => {
    const boot = { primarySponsor: sponsor(3, '   ', '') } as unknown as BootstrapResponse
    expect(sponsorIdentityFrom(boot, 3)).toBeNull()
  })

  it('a surface with no active campaign (campaign null) still names its channel brands', () => {
    const boot = { campaign: null, noActiveCampaign: true, primarySponsor: sponsor(4, 'Careless'), campaigns: [] } as BootstrapResponse
    expect(sponsorIdentityFrom(boot, 4)?.name).toBe('Careless')
  })

  it('the commerce key lookup uses the same search (findSponsorIn)', () => {
    expect(findSponsorIn(BOOT, 8)?.commerce.apiKey).toBe('key-8')
    expect(findSponsorIn(BOOT, 99)).toBeUndefined()
  })
})

describe('the per-checkout memory', () => {
  it('remembers whose checkout it is, with the name and logo of then', () => {
    rememberCheckoutSponsor('chk-1', { sponsorId: 7, name: 'Sindig', logoUrl: 'https://cdn.vio.live/sindig.svg' })
    expect(rememberedCheckoutSponsor('chk-1')).toEqual({
      checkoutId: 'chk-1',
      sponsorId: 7,
      name: 'Sindig',
      logoUrl: 'https://cdn.vio.live/sindig.svg',
    })
    expect(JSON.parse(store.getItem(CHECKOUT_SPONSOR_STORAGE_KEY)!)).toHaveLength(1)
    expect(rememberedCheckoutSponsor('chk-2')).toBeNull()
  })

  it('keeps the last 20 checkouts, most recent last', () => {
    for (let i = 1; i <= CHECKOUT_SPONSOR_MEMORY_MAX + 5; i++) {
      rememberCheckoutSponsor(`chk-${i}`, { sponsorId: 4, name: `n${i}` })
    }
    const kept = JSON.parse(store.getItem(CHECKOUT_SPONSOR_STORAGE_KEY)!) as Array<{ checkoutId: string }>
    expect(kept).toHaveLength(20)
    expect(kept[0]!.checkoutId).toBe('chk-6')
    expect(kept[19]!.checkoutId).toBe('chk-25')
    expect(rememberedCheckoutSponsor('chk-5')).toBeNull()
    expect(rememberedCheckoutSponsor('chk-25')?.name).toBe('n25')
  })

  it('writing a checkout again moves it to the end and never replaces a name with nothing', () => {
    rememberCheckoutSponsor('chk-1', { sponsorId: 4, name: 'Careless', logoUrl: 'https://x/l.png' })
    rememberCheckoutSponsor('chk-2', { sponsorId: 5, name: 'Bohus' })
    rememberCheckoutSponsor('chk-1', { sponsorId: 4 })
    const kept = JSON.parse(store.getItem(CHECKOUT_SPONSOR_STORAGE_KEY)!) as Array<{ checkoutId: string }>
    expect(kept.map((e) => e.checkoutId)).toEqual(['chk-2', 'chk-1'])
    expect(rememberedCheckoutSponsor('chk-1')).toMatchObject({ name: 'Careless', logoUrl: 'https://x/l.png' })
  })

  it('the latest checkout of a sponsor that names it', () => {
    rememberCheckoutSponsor('chk-1', { sponsorId: 4, name: 'Careless' })
    rememberCheckoutSponsor('chk-2', { sponsorId: 4, name: 'Careless AS' })
    rememberCheckoutSponsor('chk-3', { sponsorId: 4 })
    expect(rememberedSponsor(4)?.name).toBe('Careless AS')
    expect(rememberedSponsor(5)).toBeNull()
  })

  it('ignores what it cannot use: no checkout id, no sponsor, junk in storage', () => {
    rememberCheckoutSponsor('', { sponsorId: 4, name: 'x' })
    rememberCheckoutSponsor('chk-1', { sponsorId: 0, name: 'x' })
    expect(store.getItem(CHECKOUT_SPONSOR_STORAGE_KEY)).toBeNull()
    store.setItem(CHECKOUT_SPONSOR_STORAGE_KEY, '{not json')
    expect(rememberedCheckoutSponsor('chk-1')).toBeNull()
    store.setItem(CHECKOUT_SPONSOR_STORAGE_KEY, JSON.stringify([null, { checkoutId: 'chk-9', sponsorId: '6', name: 'Six' }]))
    expect(rememberedCheckoutSponsor('chk-9')).toEqual({ checkoutId: 'chk-9', sponsorId: 6, name: 'Six', logoUrl: null })
  })

  it('works without storage at all, for the page it was written on — and never throws', () => {
    vi.stubGlobal('sessionStorage', undefined)
    expect(() => rememberCheckoutSponsor('chk-1', { sponsorId: 4, name: 'Careless' })).not.toThrow()
    expect(rememberedCheckoutSponsor('chk-1')?.name).toBe('Careless')
  })

  it('a storage that throws (blocked, quota) is not a failure either', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    vi.stubGlobal('sessionStorage', throwing)
    expect(() => rememberCheckoutSponsor('chk-1', { sponsorId: 4, name: 'Careless' })).not.toThrow()
    expect(rememberedCheckoutSponsor('chk-1')?.name).toBe('Careless')
    expect(rememberedSponsor(4)?.name).toBe('Careless')
  })
})

describe('Vio.sponsorIdentity — the live bootstrap, then the memory, then the cart', () => {
  it('the live bootstrap first, including sponsors only in campaigns[]', () => {
    facade().cachedBootstrap = BOOT
    expect(Vio.sponsorIdentity(4)).toMatchObject({ id: 4, name: 'Careless', logoUrl: 'https://cdn.vio.live/careless.png' })
    expect(Vio.sponsorIdentity('8')).toMatchObject({ id: 8, name: 'Kid Interiør', logoUrl: null })
  })

  it("before the bootstrap: what this tab remembered of the checkout (Vipps' return)", () => {
    rememberCheckoutSponsor('chk-1', { sponsorId: 7, name: 'Sindig', logoUrl: 'https://cdn.vio.live/sindig.svg' })
    expect(Vio.sponsorIdentity(7, { checkoutId: 'chk-1' })).toEqual({
      id: 7,
      name: 'Sindig',
      logoUrl: 'https://cdn.vio.live/sindig.svg',
      avatarUrl: null,
    })
    // Only the checkout id (a host's URL that lost the sponsor): the remembered sponsor.
    expect(Vio.sponsorIdentity(undefined, { checkoutId: 'chk-1' })?.id).toBe(7)
    // Only the sponsor: its latest remembered checkout.
    expect(Vio.sponsorIdentity(7)?.name).toBe('Sindig')
  })

  it("then the cart's sponsorName, then nothing", () => {
    // The cart's own state (an add would also sync it with the backend).
    ;(Vio.cart as unknown as { cartsBySponsor: Map<number, unknown> }).cartsBySponsor.set(9, {
      sponsorId: 9,
      sponsorName: 'Kid',
      items: [],
      currency: 'NOK',
    })
    expect(Vio.sponsorIdentity(9)).toEqual({ id: 9, name: 'Kid', logoUrl: null, avatarUrl: null })
    expect(Vio.sponsorIdentity(10)).toBeNull()
    expect(Vio.sponsorIdentity(undefined)).toBeNull()
  })

  it('the bootstrap wins over the memory once it is there (the logo arrives)', () => {
    rememberCheckoutSponsor('chk-1', { sponsorId: 4, name: 'Careless' })
    expect(Vio.sponsorIdentity(4, { checkoutId: 'chk-1' })?.logoUrl).toBeNull()
    facade().cachedBootstrap = BOOT
    expect(Vio.sponsorIdentity(4, { checkoutId: 'chk-1' })?.logoUrl).toBe('https://cdn.vio.live/careless.png')
  })
})

describe('Vio.checkout: the memory is written when a checkout exists, getOrderReference names the sponsor', () => {
  const answer = (body: unknown) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
  const manager = () => Vio.checkout as unknown as { state: unknown; emit(): void }

  beforeEach(() => {
    resetBuyerRefSupport()
    Configuration.init({ apiKey: 'k', environment: 'testing' })
  })
  afterEach(() => {
    manager().state = null
    Configuration.reset()
    resetBuyerRefSupport()
  })

  it('a state that names its backend checkout is remembered with the sponsor as known then', () => {
    facade().cachedBootstrap = BOOT
    manager().state = { sponsorId: 7, subtotal: 1, currency: 'NOK', checkoutId: 'chk-77' }
    expect(rememberedCheckoutSponsor('chk-77')).toEqual({
      checkoutId: 'chk-77',
      sponsorId: 7,
      name: 'Sindig',
      logoUrl: 'https://cdn.vio.live/sindig.svg?v=2',
    })
    // A state without a checkout yet remembers nothing.
    manager().state = { sponsorId: 4, subtotal: 1, currency: 'NOK' }
    expect(rememberedCheckoutSponsor('chk-4')).toBeNull()
  })

  it("getOrderReference().sponsor: the checkout's sponsor by the same rule — for a host's confirmation after a reload", async () => {
    facade().cachedBootstrap = BOOT
    answer({ data: { Checkout: { GetCheckout: { id: 'chk-1', order_id: 4497, buyer_ref: 'brf_1' } } } })
    expect(await Vio.checkout.getOrderReference('chk-1', 7)).toEqual({
      orderNumber: 4497,
      buyerRef: 'brf_1',
      sponsor: { id: 7, name: 'Sindig', logoUrl: 'https://cdn.vio.live/sindig.svg?v=2' },
    })
  })

  it('with only the checkout id it uses the remembered sponsor; unknown → no sponsor key, the rest unchanged', async () => {
    rememberCheckoutSponsor('chk-2', { sponsorId: 5, name: 'Bohus' })
    answer({ data: { Checkout: { GetCheckout: { id: 'chk-2', order_id: 12, buyer_ref: null } } } })
    expect(await Vio.checkout.getOrderReference('chk-2')).toEqual({
      orderNumber: 12,
      buyerRef: null,
      sponsor: { id: 5, name: 'Bohus', logoUrl: null },
    })
    const unknown = await Vio.checkout.getOrderReference('chk-3', 99)
    expect(unknown).toEqual({ orderNumber: 12, buyerRef: null })
    expect('sponsor' in unknown).toBe(false)
  })

  it('a failed question still names the sponsor (it is resolved locally)', async () => {
    facade().cachedBootstrap = BOOT
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    expect(await Vio.checkout.getOrderReference('chk-9', 4)).toEqual({
      orderNumber: null,
      buyerRef: null,
      sponsor: { id: 4, name: 'Careless', logoUrl: 'https://cdn.vio.live/careless.png' },
    })
  })
})
