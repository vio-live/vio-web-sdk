import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { BootstrapResponse } from './types.js'

/**
 * The key-change race in Vio.bootstrap() (Vev, 2026-10-14).
 *
 * Vev starts with the key the browser remembers and, a moment later, the
 * config block re-inits with the page's own key. The first bootstrap is still
 * in flight when that happens, and it used to land anyway: its answer filled
 * the cache with the old key's sponsors (and their channels' commerce keys),
 * its failure blocked the new key for 5 s ("bootstrap recently failed"), and
 * its `finally` cleared the new request's slot.
 *
 * Each test controls when each key's request answers.
 */
const state = vi.hoisted(() => ({
  calls: [] as Array<{
    apiKey: string
    settled: boolean
    resolve: (value: unknown) => void
    reject: (reason: unknown) => void
  }>,
}))

vi.mock('./api/vio.js', () => ({
  createVioApi: ({ apiKey }: { apiKey: string }) => ({
    bootstrap: () =>
      new Promise((resolve, reject) => {
        state.calls.push({ apiKey, settled: false, resolve, reject })
      }),
  }),
}))

let Vio: typeof import('./client.js').Vio

beforeAll(async () => {
  // The facade is a page-wide singleton on globalThis: make sure this file
  // gets its own, wired to the mocked API above.
  delete (globalThis as { __VIO_FACADE__?: unknown }).__VIO_FACADE__
  ;({ Vio } = await import('./client.js'))
})

beforeEach(() => {
  state.calls.length = 0
})

const sponsor = (id: number, commerceKey: string) =>
  ({ id, name: `Sponsor ${id}`, commerce: { apiKey: commerceKey } }) as never

const configA: BootstrapResponse = { primarySponsor: sponsor(1, 'commerce-key-channel-A') }
const configB: BootstrapResponse = { primarySponsor: sponsor(2, 'commerce-key-channel-B') }

const init = (apiKey: string) => Vio.init({ apiKey, environment: 'testing' } as never)

/** The oldest request of `apiKey` that has not answered yet. */
function request(apiKey: string) {
  const call = state.calls.find((c) => c.apiKey === apiKey && !c.settled)
  if (!call) throw new Error(`no pending bootstrap request for ${apiKey}`)
  call.settled = true
  return call
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Vio.bootstrap() after a key change', () => {
  it('ignores the old key answering last', async () => {
    init('key-A')
    const first = Vio.bootstrap()
    init('key-B')
    const second = Vio.bootstrap()

    request('key-B').resolve(configB)
    await second
    request('key-A').resolve(configA)

    await expect(first).resolves.toEqual(configB)
    expect(Vio.bootstrapCache).toEqual(configB)
    expect(() => Vio.commerceFor(1)).toThrow(/Sponsor 1 not found/)
  })

  it('ignores the old key answering first, and still makes a single request for the new one', async () => {
    init('key-A')
    const first = Vio.bootstrap()
    init('key-B')
    const second = Vio.bootstrap()

    request('key-A').resolve(configA)
    await flush()
    // The old answer must not fill the cache, not even for a moment: a
    // commerce client built from it would keep the other channel's key.
    expect(Vio.bootstrapCache).toBeNull()

    request('key-B').resolve(configB)
    await expect(first).resolves.toEqual(configB)
    await expect(second).resolves.toEqual(configB)
    expect(state.calls.filter((c) => c.apiKey === 'key-B')).toHaveLength(1)
  })

  it("does not let the old key's failure block the new key", async () => {
    init('key-A')
    const first = Vio.bootstrap()
    init('key-B')

    request('key-A').reject(new Error('401 Unauthorized'))
    await flush()
    request('key-B').resolve(configB)

    await expect(first).resolves.toEqual(configB)
    await expect(Vio.bootstrap()).resolves.toEqual(configB)
  })

  it("still backs off after the current key's own failure", async () => {
    init('key-B')
    const attempt = Vio.bootstrap()
    request('key-B').reject(new Error('503 Service Unavailable'))

    await expect(attempt).rejects.toThrow('503')
    await expect(Vio.bootstrap()).rejects.toThrow(/recently failed/)
  })
})
