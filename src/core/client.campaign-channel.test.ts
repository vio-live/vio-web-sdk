/**
 * One article = one campaign = one channel = one sponsor (Angelo,
 * 2026-10-28). A sponsor may run several campaigns on one surface, each on
 * its own commerce channel (Careless: campaign 2 on channel 482, an internal
 * test campaign 1 on channel 480). The commerce key is the one of the
 * campaign in context — never just the first sponsor block — a cart
 * remembers the channel it was created on and is only ever called with that
 * channel's key, a cart whose channel the bootstrap no longer lists moves to
 * the current one with its lines, the order's campaign is always one of the
 * cart's sponsor, and the bootstrap is fetched again when a tab comes back
 * after five minutes. Against the real facade, cart and checkout managers,
 * with `fetch` stubbed (bootstrap, surface and the commerce GraphQL).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Configuration } from './configuration.js'
import { getCartGraphQLOptions } from './api/cart-queries.js'
import { resetCheckoutSponsorMemory, sponsorCommerceIn } from './sponsor-identity.js'
import type { BootstrapResponse, Sponsor } from './types.js'

let Vio: typeof import('./client.js').Vio

const CARELESS = 7
const OTHER = 9
const careless = (channelId: string, apiKey: string): Sponsor => ({
  id: CARELESS,
  name: 'Careless',
  commerce: { apiKey, channelId },
})
const other: Sponsor = { id: OTHER, name: 'Other', commerce: { apiKey: 'key-other', channelId: '900' } }

/** Default campaign 1 (internal test, channel 480); campaign 2 (the real one, channel 482); campaign 3 of another sponsor. */
const twoCampaigns = (): BootstrapResponse => ({
  campaign: { id: 1, name: 'Intern test' },
  primarySponsor: careless('480', 'key-480'),
  campaigns: [
    { id: 1, name: 'Intern test', status: 'active', isDefault: true, primarySponsor: careless('480', 'key-480'), slots: [] },
    { id: 2, name: 'Careless høst', status: 'active', primarySponsor: careless('482', 'key-482'), slots: [] },
    { id: 3, name: 'Other', status: 'active', primarySponsor: other, slots: [] },
  ],
})

/** Campaign 1 is gone (and with it channel 480): campaign 2 is the default now. */
const onlyCampaignTwo = (): BootstrapResponse => ({
  campaign: { id: 2, name: 'Careless høst' },
  primarySponsor: careless('482', 'key-482'),
  campaigns: [
    { id: 2, name: 'Careless høst', status: 'active', isDefault: true, primarySponsor: careless('482', 'key-482'), slots: [] },
    { id: 3, name: 'Other', status: 'active', primarySponsor: other, slots: [] },
  ],
})

let boot: BootstrapResponse
let bootCalls: number
let failBootstrap: boolean
let session: Map<string, string>
/** Every commerce GraphQL call: its operation, the key it carried, its variables. */
let calls: Array<{ op: string; key: string; variables: Record<string, any> }>
/** Never reset: the facade is one per page, and it remembers checkouts it announced by id. */
let cartSeq = 0
/** Lines per backend cart id, as the fake gateway keeps them. */
let carts: Map<string, Array<{ id: string; product_id: number; quantity: number }>>

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

function cartBody(cartId: string) {
  return {
    cart_id: cartId,
    currency: 'NOK',
    shipping_country: 'NO',
    line_items: (carts.get(cartId) ?? []).map((l) => ({
      id: l.id,
      product_id: l.product_id,
      title: `P${l.product_id}`,
      quantity: l.quantity,
      price: { amount: 100, currency_code: 'NOK' },
    })),
  }
}

function graphql(body: { query: string; variables: Record<string, any> }, key: string): Response {
  const op = /(?:mutation|query)\s+(\w+)/.exec(body.query)?.[1] ?? '?'
  calls.push({ op, key, variables: body.variables })
  const v = body.variables
  switch (op) {
    case 'CreateCart': {
      const id = `cart-${++cartSeq}`
      carts.set(id, [])
      return json({ data: { Cart: { CreateCart: cartBody(id) } } })
    }
    case 'AddItem': {
      const lines = carts.get(v.cartId) ?? []
      for (const li of v.lineItems) {
        const found = lines.find((l) => l.product_id === li.product_id)
        if (found) found.quantity += li.quantity
        else lines.push({ id: `${v.cartId}-l${li.product_id}`, product_id: li.product_id, quantity: li.quantity })
      }
      carts.set(v.cartId, lines)
      return json({ data: { Cart: { AddItem: cartBody(v.cartId) } } })
    }
    case 'GetCart':
      return json({ data: { Cart: { GetCart: cartBody(v.cartId) } } })
    case 'CreateCheckout':
      return json({ data: { Checkout: { CreateCheckout: { id: `co-${v.cartId}`, status: 'open' } } } })
    case 'UpdateCheckout':
      return json({ data: { Checkout: { UpdateCheckout: { id: v.checkoutId, status: 'open' } } } })
    case 'GetVippsStatus':
      return json({ data: { Payment: { GetVippsStatus: { state: 'AUTHORIZED' } } } })
    default:
      return json({ data: {} })
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => {
  for (let i = 0; i < 6; i++) await flush()
}

let visibility: 'visible' | 'hidden'
let visibilityListeners: Array<() => void>

beforeAll(async () => {
  delete (globalThis as { __VIO_FACADE__?: unknown }).__VIO_FACADE__
  ;({ Vio } = await import('./client.js'))
})

beforeEach(() => {
  boot = twoCampaigns()
  bootCalls = 0
  failBootstrap = false
  calls = []
  carts = new Map()
  session = new Map()
  visibility = 'visible'
  visibilityListeners = []
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    if (url.includes('/v2/mobile/config')) {
      bootCalls++
      if (failBootstrap) return json({ error: 'down' }, 503)
      return json(boot)
    }
    if (url.endsWith('/v2/mobile/surface')) return json({ surface: { id: 1, name: 'S', privacyMode: 'standard' } })
    if (init?.body && String(init.body).includes('"query"')) {
      return graphql(JSON.parse(String(init.body)), String(init.headers?.Authorization ?? ''))
    }
    return json({ error: 'not found' }, 404)
  })
  vi.stubGlobal('document', {
    referrer: '',
    dispatchEvent: () => true,
    querySelectorAll: () => [],
    get visibilityState() {
      return visibility
    },
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'visibilitychange') visibilityListeners.push(fn)
    },
  })
  vi.stubGlobal('location', { href: 'https://host.example/a', pathname: '/a', search: '', host: 'host.example' })
  vi.stubGlobal('localStorage', undefined)
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  })
  resetCheckoutSponsorMemory()
  // The facade installs its visibilitychange listener once per page: on this test's document.
  ;(Vio as unknown as { visibilityHooked: boolean }).visibilityHooked = false
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  Vio.cart.clearAllCarts()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  Configuration.reset()
})

async function ready(config: Record<string, unknown> = {}) {
  Vio.init({ apiKey: 'surface-key', environment: 'testing', ...config } as never)
  await Vio.bootstrap()
  await flush()
}

const add = (productId: number, campaignId?: number, quantity = 1) =>
  Vio.cart.addManual({
    productId,
    sponsorId: CARELESS,
    brand: 'Careless',
    name: `P${productId}`,
    unitPrice: 100,
    currency: 'NOK',
    imageUrl: '',
    quantity,
    ...(campaignId !== undefined ? { origin: { campaignId, slot: 'article-1' } } : {}),
  })

const keysOf = (op: string) => calls.filter((c) => c.op === op).map((c) => c.key)

describe('sponsorCommerceIn — the block a sponsor sells with', () => {
  it('the campaign in context picks its block; a channel is strict; no context = the first block, as before', () => {
    const b = twoCampaigns()
    expect(sponsorCommerceIn(b, CARELESS, { campaignId: 2 })?.commerce.apiKey).toBe('key-482')
    expect(sponsorCommerceIn(b, CARELESS, { campaignId: [3, '2'] })?.commerce.apiKey).toBe('key-482')
    expect(sponsorCommerceIn(b, CARELESS, { campaignId: 3 })?.commerce.apiKey).toBe('key-480') // not Careless's
    expect(sponsorCommerceIn(b, CARELESS)?.commerce.apiKey).toBe('key-480')
    expect(sponsorCommerceIn(b, CARELESS, { channelId: 482 })?.commerce.apiKey).toBe('key-482')
    expect(sponsorCommerceIn(b, CARELESS, { channelId: '999' })).toBeUndefined()
  })

  it('a block with commerce: null is skipped — never a TypeError', () => {
    const b: BootstrapResponse = {
      campaign: { id: 1, name: 'x' },
      primarySponsor: { id: CARELESS, name: 'Careless', commerce: null as never },
      campaigns: [{ id: 2, name: 'y', status: 'active', primarySponsor: careless('482', 'key-482') }],
    }
    expect(sponsorCommerceIn(b, CARELESS)?.commerce.apiKey).toBe('key-482')
    expect(sponsorCommerceIn({ primarySponsor: { id: 1, name: 'n', commerce: null as never } }, 1)).toBeUndefined()
  })
})

describe('Vio.commerceFor and getCartGraphQLOptions follow the campaign in context', () => {
  it('commerceFor(sponsor, { campaignId }) uses that campaign’s channel; clients are kept per sponsor and key', async () => {
    await ready()
    const forTwo = Vio.commerceFor(CARELESS, { campaignId: 2 })
    const forDefault = Vio.commerceFor(CARELESS)
    expect(forTwo).not.toBe(forDefault)
    expect(Vio.commerceFor(CARELESS, { campaignId: [2] })).toBe(forTwo)
    expect(Vio.commerceFor(CARELESS, { channelId: '482' })).toBe(forTwo)
    expect(() => Vio.commerceFor(CARELESS, { channelId: '999' })).toThrow(/Channel 999/)
  })

  it('Vio.init({ campaignId }) is the page campaign when no element says one', async () => {
    await ready({ campaignId: 2 })
    expect((await getCartGraphQLOptions(CARELESS)).commerceKey).toBe('key-482')
    expect((await getCartGraphQLOptions(CARELESS, { campaignId: 1 })).commerceKey).toBe('key-480')
    // `campaignId: null`: no campaign at all — the first block, as before.
    expect((await getCartGraphQLOptions(CARELESS, { campaignId: null })).commerceKey).toBe('key-480')
  })

  it('a channel the bootstrap does not list is not answered with another channel’s key', async () => {
    await ready()
    const opts = await getCartGraphQLOptions(CARELESS, { channelId: '999' })
    expect(opts.sponsorResolved).toBe(false)
    expect(opts.channelMissing).toBe(true)
    expect(opts.commerceKey).not.toBe('key-480')
    expect(opts.commerceKey).not.toBe('key-482')
    const ok = await getCartGraphQLOptions(CARELESS, { channelId: 482 })
    expect(ok).toMatchObject({ commerceKey: 'key-482', channelId: '482', sponsorResolved: true })
  })
})

describe('the cart remembers its channel', () => {
  it('created on the channel of the article’s campaign, and every later call uses that key', async () => {
    await ready()
    add(11, 2)
    await settle()
    expect(keysOf('CreateCart')).toEqual(['key-482'])
    expect(keysOf('AddItem')).toEqual(['key-482'])
    expect(Vio.cart.getCart(CARELESS)?.channelId).toBe('482')

    // A later add from the default campaign's article: same cart, same channel.
    add(12, 1)
    await settle()
    expect(keysOf('CreateCart')).toHaveLength(1)
    expect(keysOf('AddItem')).toEqual(['key-482', 'key-482'])

    // The checkout is built on that cart with that key.
    await Vio.checkout.createCheckout(CARELESS, 'vipps')
    expect(keysOf('GetCart')).toEqual(['key-482'])
    expect(keysOf('CreateCheckout')).toEqual(['key-482'])
    expect(keysOf('UpdateCheckout')).toEqual(['key-482'])
  })

  it('without a campaign in context the cart is created as before (the first block)', async () => {
    await ready()
    add(11)
    await settle()
    expect(keysOf('CreateCart')).toEqual(['key-480'])
    expect(Vio.cart.getCart(CARELESS)?.channelId).toBe('480')
  })

  it('a channel no longer in the bootstrap: the cart is created again on the current channel, with its lines, once', async () => {
    await ready()
    add(11, 1, 2)
    await settle()
    expect(keysOf('CreateCart')).toEqual(['key-480'])
    const oldCartId = Vio.cart.getCart(CARELESS)?.cartId

    // The bootstrap changes under the page (refresh after the tab came back).
    boot = onlyCampaignTwo()
    ;(Vio as unknown as { cachedBootstrap: BootstrapResponse }).cachedBootstrap = onlyCampaignTwo()
    calls = []
    add(12, 2)
    await settle()

    // Never a call with a key of another channel to the old cart.
    expect(calls.every((c) => c.key === 'key-482')).toBe(true)
    expect(calls.some((c) => c.variables?.cartId === oldCartId)).toBe(false)
    expect(keysOf('CreateCart')).toHaveLength(1)
    const cart = Vio.cart.getCart(CARELESS)!
    expect(cart.channelId).toBe('482')
    expect(cart.cartId).not.toBe(oldCartId)
    // Both lines are in the new backend cart, each counted once.
    expect(carts.get(cart.cartId!)?.map((l) => [l.product_id, l.quantity])).toEqual([
      [11, 2],
      [12, 1],
    ])
    expect(cart.items.map((i) => [i.productId, i.quantity])).toEqual([
      [11, 2],
      [12, 1],
    ])
    expect(cart.items.every((i) => i.cartItemId)).toBe(true)
  })

  it('the return from Vipps (cart already cleared) asks with the checkout’s channel, not the default', async () => {
    await ready()
    add(11, 2)
    await settle()
    const checkout = await Vio.checkout.createCheckout(CARELESS, 'vipps')
    Vio.cart.clearAllCarts()
    Vio.checkout.close()
    calls = []
    await Vio.checkout.getVippsStatus(checkout.id)
    await Vio.checkout.getVippsStatus(checkout.id, CARELESS)
    expect(keysOf('GetVippsStatus')).toEqual(['key-482', 'key-482'])
  })

  it('an open checkout keeps its channel’s key after a refresh drops that channel', async () => {
    await ready()
    add(11, 1)
    await settle()
    await Vio.checkout.createCheckout(CARELESS, 'vipps')
    ;(Vio as unknown as { cachedBootstrap: BootstrapResponse }).cachedBootstrap = onlyCampaignTwo()
    calls = []
    await Vio.checkout.updateCheckout({ email: 'kari@example.no' }, CARELESS)
    expect(keysOf('UpdateCheckout')).toEqual(['key-480'])
  })
})

describe('the order’s campaign is always one of the cart’s sponsor', () => {
  it('a page campaign of another sponsor is not credited; the lines’ campaign is', async () => {
    await ready({ campaignId: 3 })
    add(11, 2)
    expect(Vio.orderAttribution(CARELESS)?.campaign_id).toBe(2)
    Vio.cart.clearAllCarts()
    // Lines without a campaign: the page campaign is another sponsor's → the sponsor's own rule.
    add(11)
    expect(Vio.orderAttribution(CARELESS)?.campaign_id).toBe(1)
  })

  it('the lines win over the page campaign, and data-vio-campaign on the page is honoured', async () => {
    const els = [{ getAttribute: (n: string) => (n === 'data-vio-campaign' ? '2' : null) }]
    vi.stubGlobal('document', { referrer: '', dispatchEvent: () => true, querySelectorAll: () => els, addEventListener: () => {} })
    await ready()
    // Empty cart: the page's data-vio-campaign (Careless takes part in 2).
    expect(Vio.orderAttribution(CARELESS)?.campaign_id).toBe(2)
    // …but not for a sponsor that is not in it.
    expect(Vio.orderAttribution(OTHER)?.campaign_id).not.toBe(2)
    // Lines added from campaign 1 win over the page.
    add(11, 1)
    expect(Vio.orderAttribution(CARELESS)?.campaign_id).toBe(1)
  })

  it('vio:checkout-created carries that campaign', async () => {
    await ready({ campaignId: 3 })
    const seen: unknown[] = []
    vi.stubGlobal('window', { dispatchEvent: (e: CustomEvent) => (seen.push(e.detail), true) })
    add(11, 2)
    await settle()
    await Vio.checkout.createCheckout(CARELESS, 'vipps')
    expect(seen).toEqual([expect.objectContaining({ sponsorId: CARELESS, campaignId: 2 })])
  })
})

describe('the bootstrap is fetched again when the tab comes back after five minutes', () => {
  it('only when older than five minutes; the cache stays meanwhile and through a failure; carts keep their lines', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-28T10:00:00Z'))
    await ready()
    expect(bootCalls).toBe(1)
    add(11, 2)
    await settle()
    const cartBefore = Vio.cart.getCart(CARELESS)?.cartId
    const fire = async () => {
      for (const fn of visibilityListeners) fn()
      await settle()
    }
    expect(visibilityListeners).toHaveLength(1)

    vi.setSystemTime(new Date('2026-10-28T10:04:00Z'))
    await fire()
    expect(bootCalls).toBe(1) // fresh enough

    visibility = 'hidden'
    vi.setSystemTime(new Date('2026-10-28T10:06:00Z'))
    await fire()
    expect(bootCalls).toBe(1) // hidden: nothing

    visibility = 'visible'
    failBootstrap = true
    await fire()
    expect(bootCalls).toBe(2)
    expect(Vio.bootstrapCache?.campaigns).toHaveLength(3) // the old one stands

    failBootstrap = false
    vi.setSystemTime(new Date('2026-10-28T10:08:00Z'))
    boot = onlyCampaignTwo()
    await fire()
    expect(bootCalls).toBe(3)
    expect(Vio.bootstrapCache?.campaign?.id).toBe(2)
    // The refresh touches no cart.
    expect(Vio.cart.getCart(CARELESS)?.cartId).toBe(cartBefore)
    expect(Vio.cart.getCart(CARELESS)?.items.map((i) => i.quantity)).toEqual([1])
  })
})
