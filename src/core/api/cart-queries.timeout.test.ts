/**
 * A commerce GraphQL call that never answers must not hang its caller: a
 * line's quantity sync — and the checkout awaiting `waitForCartMutations` —
 * would otherwise be stuck for good (review of 2026-10-16, W5).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CART_GRAPHQL_TIMEOUT_MS, UPDATE_ITEM_MUTATION, executeCartGraphQL } from './cart-queries.js'

const OPTS = { apiKey: 'k', endpoint: 'http://commerce.test' }

describe('executeCartGraphQL — timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it(`rejects after ${CART_GRAPHQL_TIMEOUT_MS}ms and aborts the fetch`, async () => {
    vi.useFakeTimers()
    const fetchSpy = vi.fn(() => new Promise<never>(() => {}))
    vi.stubGlobal('fetch', fetchSpy)

    let outcome: string | undefined
    const call = executeCartGraphQL(UPDATE_ITEM_MUTATION, { cartId: 'c', cartItemId: 'i', qty: 2 }, OPTS)
    call.then(() => (outcome = 'resolved'), (e: Error) => (outcome = e.message))

    await vi.advanceTimersByTimeAsync(CART_GRAPHQL_TIMEOUT_MS - 1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(outcome).toBeUndefined() // still waiting, as it should
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toMatch(/timed out/)
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.signal?.aborted).toBe(true)
  })

  it('an answer in time clears the timer and leaves nothing behind', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { Cart: {} } }) })),
    )
    await executeCartGraphQL(UPDATE_ITEM_MUTATION, {}, OPTS)
    expect(vi.getTimerCount()).toBe(0)
  })
})
