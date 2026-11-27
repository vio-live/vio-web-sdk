// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  readSnapshot,
  isFresh,
  snapshotProducts,
  snapshotState,
  startSnapshot,
  snapshotUrl,
  resetSnapshots,
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_TIMEOUT_MS,
} from './snapshot.js'

const KEY = 'surface-key-123'
const HASH = createHash('sha256').update(KEY).digest('hex').slice(0, 32)
const PROD_BASE = 'https://container.vio.live/reachu-uploads-production/snapshots/'

const product = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `P${id}`,
  sku: `S${id}`,
  tags: [],
  price: { amount: 100, currency_code: 'NOK' },
  images: [],
  ...extra,
})

function doc(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    market: { currency: 'NOK', shippingCountryCode: 'NO' },
    config: {
      primarySponsor: { id: 10, commerce: { apiKey: 'channel-key-A', channelId: 487 } },
      campaigns: [
        {
          id: 8,
          primarySponsor: { id: 10, commerce: { apiKey: 'channel-key-A', channelId: 487 } },
          secondarySponsors: [{ id: 11, commerce: { apiKey: 'channel-key-B', channelId: 488 } }],
        },
      ],
    },
    catalogs: [
      { campaignId: 8, sponsorId: 10, channelId: '487', productIds: [1, 2, 3] },
      { campaignId: 8, sponsorId: 11, channelId: '488', productIds: [3, 4] },
    ],
    products: [product(1), product(2), product(3), product(4)],
    ...overrides,
  }
}

const ask = (over: Partial<Parameters<typeof snapshotProducts>[1]> = {}) => ({
  commerceKey: 'channel-key-A',
  productIds: [2, 1],
  currency: 'NOK',
  shippingCountryCode: 'NO',
  imageSize: 'large',
  useCache: true,
  ...over,
})

describe('readSnapshot / snapshotProducts', () => {
  it('reads a v1 document and answers the products of a channel in the order asked', () => {
    const s = readSnapshot(doc())!
    expect(s).not.toBeNull()
    expect(s.channelOfKey.get('channel-key-A')).toBe('487')
    expect(snapshotProducts(s, ask())!.map((p) => (p as { id: number }).id)).toEqual([2, 1])
  })

  it('refuses another version, a document without config, or junk', () => {
    expect(readSnapshot(doc({ version: 2 }))).toBeNull()
    expect(readSnapshot(doc({ config: null }))).toBeNull()
    expect(readSnapshot('nope')).toBeNull()
    expect(readSnapshot(null)).toBeNull()
  })

  it('does not answer what the API would answer differently', () => {
    const s = readSnapshot(doc())!
    expect(snapshotProducts(s, ask({ useCache: false }))).toBeNull() // a fresh read was asked
    expect(snapshotProducts(s, ask({ imageSize: 'medium' }))).toBeNull()
    expect(snapshotProducts(s, ask({ currency: 'EUR' }))).toBeNull()
    expect(snapshotProducts(s, ask({ shippingCountryCode: 'SE' }))).toBeNull()
    expect(snapshotProducts(s, ask({ commerceKey: 'unknown-key' }))).toBeNull()
    expect(snapshotProducts(s, ask({ productIds: [1, 99] }))).toBeNull() // one missing → the API answers all
    expect(snapshotProducts(s, ask({ productIds: [4] }))).toBeNull() // another channel's product
    expect(snapshotProducts(s, ask({ productIds: [3] }))).toBeNull() // in two channels: its copy may differ
    expect(snapshotProducts(s, ask({ productIds: [] }))).toBeNull()
  })

  it('compares the market without caring about case', () => {
    const s = readSnapshot(doc())!
    expect(snapshotProducts(s, ask({ currency: 'nok', shippingCountryCode: 'no' }))).not.toBeNull()
  })

  it('never answers with a product from an older snapshot without the full fields', () => {
    const old = doc({ products: [{ id: 1, title: 'P1', price: { amount: 1 } }, product(2)] })
    expect(snapshotProducts(readSnapshot(old)!, ask())).toBeNull()
  })

  it('is fresh under ten minutes only', () => {
    const now = Date.now()
    const s = readSnapshot(doc({ generatedAt: new Date(now - 60_000).toISOString() }))
    expect(isFresh(s, now)).toBe(true)
    expect(isFresh(readSnapshot(doc({ generatedAt: new Date(now - SNAPSHOT_MAX_AGE_MS - 1).toISOString() })), now)).toBe(false)
    expect(isFresh(readSnapshot(doc({ generatedAt: 'not a date' })), now)).toBe(false)
  })
})

describe('startSnapshot (the script on the page)', () => {
  beforeEach(() => {
    resetSnapshots()
    document.head.innerHTML = ''
    delete (window as { __vioSnapshots?: unknown }).__vioSnapshots
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const script = () => document.head.querySelector('script') as HTMLScriptElement | null

  it('snapshotUrl gives the address of the script, and a tag the page already carries with it is the one used', async () => {
    const url = await snapshotUrl({ apiKey: KEY, environment: 'production' })
    expect(url).toBe(`${PROD_BASE}${HASH}.web.js`)
    expect(await snapshotUrl({ apiKey: KEY, environment: 'production', platform: 'vev' })).toBe(`${PROD_BASE}${HASH}.vev.js`)
    expect(await snapshotUrl({ apiKey: KEY, environment: 'production', platform: 'ios' })).toBeNull()
    expect(await snapshotUrl({ apiKey: ' ', environment: 'production' })).toBeNull()
    // The host's server wrote the tag in the HTML.
    const own = document.createElement('script')
    own.async = true
    own.src = url!
    document.head.appendChild(own)
    const p = startSnapshot({ apiKey: KEY, environment: 'production' })
    await vi.waitFor(() => expect(snapshotState({ apiKey: KEY, environment: 'production' }).status).toBe('pending'))
    expect(document.head.querySelectorAll('script')).toHaveLength(1)
    ;(window as { __vioSnapshots?: Record<string, unknown> }).__vioSnapshots = { [`${HASH}.web`]: doc() }
    window.dispatchEvent(new CustomEvent('vio:snapshot', { detail: `${HASH}.web` }))
    expect(await p).not.toBeNull()
  })

  it('loads <base><hash>.<platform>.js of the environment and resolves on its event', async () => {
    const p = startSnapshot({ apiKey: KEY, environment: 'production', platform: 'web' })
    await vi.waitFor(() => expect(script()).not.toBeNull())
    expect(script()!.src).toBe(`${PROD_BASE}${HASH}.web.js`)
    expect(script()!.async).toBe(true)
    expect(snapshotState({ apiKey: KEY, environment: 'production', platform: 'web' }).status).toBe('pending')
    // What the published script does.
    ;(window as { __vioSnapshots?: Record<string, unknown> }).__vioSnapshots = { [`${HASH}.web`]: doc() }
    window.dispatchEvent(new CustomEvent('vio:snapshot', { detail: `${HASH}.web` }))
    const s = await p
    expect(s?.channelOfKey.get('channel-key-B')).toBe('488')
    const state = snapshotState({ apiKey: KEY, environment: 'production', platform: 'web' })
    expect(state.status).toBe('ready')
  })

  it('loads once per key, environment and platform; the same load for a second caller', async () => {
    const a = startSnapshot({ apiKey: KEY, environment: 'production', platform: 'vev' })
    const b = startSnapshot({ apiKey: KEY, environment: 'production', platform: 'vev' })
    expect(a).toBe(b)
    await vi.waitFor(() => expect(script()).not.toBeNull())
    expect(document.head.querySelectorAll('script')).toHaveLength(1)
    expect(script()!.src).toBe(`${PROD_BASE}${HASH}.vev.js`)
  })

  it('uses QA’s container for development and testing', async () => {
    void startSnapshot({ apiKey: KEY, environment: 'testing' })
    await vi.waitFor(() => expect(script()).not.toBeNull())
    expect(script()!.src).toBe(`https://containerqasc.blob.core.windows.net/reachu-uploads-qa/snapshots/${HASH}.web.js`)
  })

  it('resolves null on a script error, and the page goes on as before', async () => {
    const p = startSnapshot({ apiKey: KEY, environment: 'production' })
    await vi.waitFor(() => expect(script()).not.toBeNull())
    script()!.dispatchEvent(new Event('error'))
    expect(await p).toBeNull()
    expect(snapshotState({ apiKey: KEY, environment: 'production' }).status).toBe('none')
  })

  it('gives up after the timeout and removes the element', async () => {
    const p = startSnapshot({ apiKey: KEY, environment: 'production' })
    await vi.waitFor(() => expect(script()).not.toBeNull())
    vi.useFakeTimers()
    vi.advanceTimersByTime(SNAPSHOT_TIMEOUT_MS + 1)
    expect(await p).toBeNull()
    expect(script()).toBeNull()
  })

  it('treats an old snapshot as none', async () => {
    const p = startSnapshot({ apiKey: KEY, environment: 'production' })
    await vi.waitFor(() => expect(script()).not.toBeNull())
    ;(window as { __vioSnapshots?: Record<string, unknown> }).__vioSnapshots = {
      [`${HASH}.web`]: doc({ generatedAt: new Date(Date.now() - SNAPSHOT_MAX_AGE_MS - 5_000).toISOString() }),
    }
    window.dispatchEvent(new CustomEvent('vio:snapshot', { detail: `${HASH}.web` }))
    expect(await p).toBeNull()
  })

  it('has no snapshot for a platform campaigns does not write, or without a key', async () => {
    expect(await startSnapshot({ apiKey: KEY, environment: 'production', platform: 'ios' })).toBeNull()
    expect(await startSnapshot({ apiKey: '  ', environment: 'production' })).toBeNull()
    expect(script()).toBeNull()
  })
})
