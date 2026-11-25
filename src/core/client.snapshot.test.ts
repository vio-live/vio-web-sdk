// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

/**
 * The CDN snapshot in the client: the bootstrap and `getByIds` answer from it
 * when it is there first, and the API's bootstrap still replaces it in place.
 */
const state = vi.hoisted(() => ({
  bootstraps: [] as Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }>,
  graphql: [] as Array<{ query: string; variables: Record<string, unknown>; resolve: (v: unknown) => void }>,
}))

vi.mock('./api/vio.js', () => ({
  VioApiError: class extends Error {},
  createVioApi: () => ({
    bootstrap: () => new Promise((resolve, reject) => state.bootstraps.push({ resolve, reject })),
    surface: () => new Promise(() => {}),
  }),
}))

vi.mock('graphql-request', () => ({
  GraphQLClient: class {
    request(query: string, variables: Record<string, unknown>) {
      return new Promise((resolve) => state.graphql.push({ query, variables, resolve }))
    }
  },
}))

let Vio: typeof import('./client.js').Vio
let resetSnapshots: () => void

beforeAll(async () => {
  delete (globalThis as { __VIO_FACADE__?: unknown }).__VIO_FACADE__
  ;({ Vio } = await import('./client.js'))
  ;({ resetSnapshots } = await import('./snapshot.js'))
})

let n = 0
let key = ''
let hash = ''

beforeEach(() => {
  state.bootstraps.length = 0
  state.graphql.length = 0
  resetSnapshots()
  document.head.innerHTML = ''
  delete (window as { __vioSnapshots?: unknown }).__vioSnapshots
  key = `surface-key-${++n}`
  hash = createHash('sha256').update(key).digest('hex').slice(0, 32)
})

const sponsorBlock = (channelKey: string, channelId: number) => ({
  id: 10,
  name: 'Boots',
  commerce: { apiKey: channelKey, channelId },
})

function snapshotDoc(channelKey = 'snap-channel-key') {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    market: { currency: 'NOK', shippingCountryCode: 'NO' },
    config: { primarySponsor: sponsorBlock(channelKey, 487), campaigns: [] },
    catalogs: [{ campaignId: 8, sponsorId: 10, channelId: '487', productIds: [421638, 421579] }],
    products: [
      { id: 421638, title: 'Skin Sip', sku: '767390', price: { amount: 183.92, currency_code: 'NOK' } },
      { id: 421579, title: 'Julekalender', sku: '767377', price: { amount: 1749.5, currency_code: 'NOK' } },
    ],
  }
}

/** What the published script does once it has run. */
function publish(platform = 'web', doc: unknown = snapshotDoc()) {
  const name = `${hash}.${platform}`
  ;(window as { __vioSnapshots?: Record<string, unknown> }).__vioSnapshots = { [name]: doc }
  window.dispatchEvent(new CustomEvent('vio:snapshot', { detail: name }))
}

const script = () => document.head.querySelector('script[src*="/snapshots/"]') as HTMLScriptElement | null

describe('Vio + CDN snapshot', () => {
  it('init starts the snapshot of its key and platform, and opens the connections', async () => {
    Vio.init({ apiKey: key, environment: 'production' })
    await vi.waitFor(() => expect(script()).not.toBeNull())
    expect(script()!.src).toBe(`https://container.vio.live/reachu-uploads-production/snapshots/${hash}.web.js`)
    const preconnects = Array.from(document.head.querySelectorAll('link[rel="preconnect"]')).map((l) => (l as HTMLLinkElement).href)
    expect(preconnects).toEqual(
      expect.arrayContaining(['https://api.vio.live/', 'https://graph-ql.vio.live/', 'https://container.vio.live/']),
    )
  })

  it('snapshot: false reads nothing from the CDN', async () => {
    Vio.init({ apiKey: key, environment: 'production', snapshot: false })
    await new Promise((r) => setTimeout(r, 20))
    expect(script()).toBeNull()
  })

  it('the bootstrap answers from the snapshot when it comes first; the API then replaces it', async () => {
    Vio.init({ apiKey: key, environment: 'production', platform: 'vev' })
    await vi.waitFor(() => expect(script()).not.toBeNull())
    const pending = Vio.bootstrap()
    publish('vev')
    const res = await pending
    expect(res.primarySponsor?.commerce?.apiKey).toBe('snap-channel-key')
    expect(state.bootstraps).toHaveLength(1) // the API was asked all the same
    const fresh = { primarySponsor: sponsorBlock('api-channel-key', 487), campaigns: [] }
    state.bootstraps[0]!.resolve(fresh)
    await vi.waitFor(() => expect(Vio.bootstrapCache).toBe(fresh))
  })

  it('the API answering first wins, and a late snapshot does not replace it', async () => {
    Vio.init({ apiKey: key, environment: 'production' })
    await vi.waitFor(() => expect(script()).not.toBeNull())
    const pending = Vio.bootstrap()
    await vi.waitFor(() => expect(state.bootstraps).toHaveLength(1))
    const fromApi = { primarySponsor: sponsorBlock('api-channel-key', 487), campaigns: [] }
    state.bootstraps[0]!.resolve(fromApi)
    expect(await pending).toBe(fromApi)
    publish('web')
    await new Promise((r) => setTimeout(r, 10))
    expect(Vio.bootstrapCache).toBe(fromApi)
  })

  it('a failing API leaves the snapshot’s bootstrap in place', async () => {
    Vio.init({ apiKey: key, environment: 'production' })
    await vi.waitFor(() => expect(script()).not.toBeNull())
    publish('web')
    const res = await Vio.bootstrap()
    expect(res.primarySponsor?.commerce?.apiKey).toBe('snap-channel-key')
    state.bootstraps[0]!.reject(new Error('503'))
    await new Promise((r) => setTimeout(r, 10))
    expect(Vio.bootstrapCache?.primarySponsor?.commerce?.apiKey).toBe('snap-channel-key')
    // and no 5 s backoff: the page has a bootstrap
    await expect(Vio.bootstrap()).resolves.toBeTruthy()
  })

  it('a failing API with no snapshot still rejects as before', async () => {
    Vio.init({ apiKey: key, environment: 'production' })
    await vi.waitFor(() => expect(script()).not.toBeNull())
    const pending = Vio.bootstrap()
    script()!.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(state.bootstraps).toHaveLength(1))
    state.bootstraps[0]!.reject(new Error('503'))
    await expect(pending).rejects.toThrow('503')
  })

  it('getByIds answers from the snapshot without asking GraphQL', async () => {
    Vio.init({ apiKey: key, environment: 'production' })
    await vi.waitFor(() => expect(script()).not.toBeNull())
    publish('web')
    await Vio.bootstrap()
    const products = await Vio.commerceFor(10).channel.product.getByIds({ product_ids: [421579, 421638], currency: 'NOK' })
    expect(products.map((p) => p.id)).toEqual([421579, 421638])
    expect(state.graphql).toHaveLength(0)
  })

  it('getByIds asks GraphQL for what the snapshot cannot answer (useCache: false, an unknown id)', async () => {
    Vio.init({ apiKey: key, environment: 'production' })
    await vi.waitFor(() => expect(script()).not.toBeNull())
    publish('web')
    await Vio.bootstrap()
    const commerce = Vio.commerceFor(10)
    const a = commerce.channel.product.getByIds({ product_ids: [421638], useCache: false })
    const b = commerce.channel.product.getByIds({ product_ids: [421638, 1] })
    await vi.waitFor(() => expect(state.graphql).toHaveLength(2))
    for (const call of state.graphql) call.resolve({ Channel: { GetProductsByIds: [{ id: 421638, title: 'live' }] } })
    expect((await a)[0]!.title).toBe('live')
    expect((await b)[0]!.title).toBe('live')
  })

  it('getByIds while the snapshot loads: whichever answers first', async () => {
    Vio.init({ apiKey: key, environment: 'production' })
    await vi.waitFor(() => expect(script()).not.toBeNull())
    // The host sets the bootstrap itself (as Replit does) before the snapshot arrives.
    ;(Vio as unknown as { cachedBootstrap: unknown }).cachedBootstrap = {
      primarySponsor: sponsorBlock('snap-channel-key', 487),
      campaigns: [],
    }
    const pending = Vio.commerceFor(10).channel.product.getByIds({ product_ids: [421638] })
    await vi.waitFor(() => expect(state.graphql).toHaveLength(1))
    publish('web')
    expect((await pending)[0]!.title).toBe('Skin Sip')
  })
})
