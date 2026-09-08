import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getCartGraphQLOptions } from './cart-queries.js'
import { Configuration } from '../configuration.js'

/**
 * The load-order race that made every commerce call fail with
 * "Authentication failed" on a real Vev page (2026-09-08).
 *
 * Vev blocks mount in no guaranteed order, so a cart can ask for options
 * before the config block has run `Vio.init`. Bootstrap needs the apiKey, so
 * attempting it first throws — and it used to be attempted first and never
 * retried. The sponsor stayed unknown, the commerce key fell back to the
 * platform key, and commerce rejected it. A WRONG key, not a missing one,
 * which is exactly why it read as a credentials problem.
 */
describe('getCartGraphQLOptions — bootstrap must run after init', () => {
  const g = globalThis as any

  beforeEach(() => {
    delete g.__VIO_FACADE__
    Configuration.reset?.()
  })
  afterEach(() => {
    delete g.__VIO_FACADE__
    Configuration.reset?.()
  })

  it('bootstraps only once initialization has happened', async () => {
    const order: string[] = []
    Configuration.init({ apiKey: 'vg_platform_key', environment: 'testing' } as never)
    g.__VIO_FACADE__ = {
      bootstrap: vi.fn(async () => {
        order.push(Configuration.isInitialized ? 'bootstrap-after-init' : 'bootstrap-before-init')
        g.__VIO_FACADE__.bootstrapCache = { sponsors: [] }
      }),
      findSponsor: () => ({ commerce: { apiKey: 'commerce_key_5' } }),
    }
    await getCartGraphQLOptions(5)
    expect(order).toEqual(['bootstrap-after-init'])
  })

  it("uses the sponsor's commerce key, not the platform key", async () => {
    Configuration.init({ apiKey: 'vg_platform_key', environment: 'testing' } as never)
    g.__VIO_FACADE__ = {
      bootstrap: vi.fn(async () => {
        g.__VIO_FACADE__.bootstrapCache = { sponsors: [] }
      }),
      findSponsor: () => ({ commerce: { apiKey: 'commerce_key_5' } }),
    }
    const opts = await getCartGraphQLOptions(5)
    expect(opts.commerceKey).toBe('commerce_key_5')
    expect(opts.sponsorResolved).toBe(true)
  })

  it('warns loudly when it has to fall back to the platform key', async () => {
    // The silence is what cost the day: commerce answers "Authentication
    // failed" and nothing says the key was the wrong one.
    Configuration.init({ apiKey: 'vg_platform_key', environment: 'testing' } as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    g.__VIO_FACADE__ = {
      bootstrap: vi.fn(async () => {
        g.__VIO_FACADE__.bootstrapCache = { sponsors: [] }
      }),
      findSponsor: () => undefined,
    }
    const opts = await getCartGraphQLOptions(5)
    expect(opts.sponsorResolved).toBe(false)
    expect(opts.commerceKey).toBe('vg_platform_key')
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls.map((c) => c[0]).join(' '))).toContain('sponsor 5')
    warn.mockRestore()
  })

  it('does not bootstrap twice when the cache is already warm', async () => {
    Configuration.init({ apiKey: 'vg_platform_key', environment: 'testing' } as never)
    const bootstrap = vi.fn(async () => undefined)
    g.__VIO_FACADE__ = {
      bootstrap,
      bootstrapCache: { sponsors: [] },
      findSponsor: () => ({ commerce: { apiKey: 'commerce_key_5' } }),
    }
    await getCartGraphQLOptions(5)
    expect(bootstrap).not.toHaveBeenCalled()
  })
})
