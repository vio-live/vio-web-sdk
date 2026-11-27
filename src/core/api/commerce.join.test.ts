import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `getByIds` calls of the same turn go out as one request (an article asks
 * once per block), and each caller gets its own products in the order it
 * asked. A call on its own is sent and answered exactly as before.
 */
const state = vi.hoisted(() => ({
  calls: [] as Array<{ variables: { productIds: number[]; useCache: boolean; currency: string }; resolve: (v: unknown) => void; reject: (e: unknown) => void }>,
}))

vi.mock('graphql-request', () => ({
  GraphQLClient: class {
    request(_query: string, variables: { productIds: number[]; useCache: boolean; currency: string }) {
      return new Promise((resolve, reject) => state.calls.push({ variables, resolve, reject }))
    }
  },
}))

import { createCommerceClient, JOINED_REQUEST_MAX_IDS } from './commerce.js'

const answer = (ids: number[]) => ({ Channel: { GetProductsByIds: ids.map((id) => ({ id, title: `p${id}` })) } })
const client = () => createCommerceClient({ endpoint: 'https://graph-ql.example', apiKey: 'channel-key' }).channel.product
const sent = () => vi.waitFor(() => expect(state.calls.length).toBeGreaterThan(0))

beforeEach(() => {
  state.calls.length = 0
})

describe('getByIds — calls of the same turn joined', () => {
  it('a call on its own: its own ids, and the API’s answer untouched (its order, not the caller’s)', async () => {
    const pending = client().getByIds({ product_ids: [3, 1, 2], currency: 'NOK' })
    await sent()
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]!.variables.productIds).toEqual([3, 1, 2])
    state.calls[0]!.resolve(answer([1, 2, 3]))
    expect((await pending).map((p) => p.id)).toEqual([1, 2, 3])
  })

  it('several calls: one request with every id once; each caller its own, in the order it asked, missing ones left out', async () => {
    const product = client()
    const a = product.getByIds({ product_ids: [5], currency: 'NOK' })
    const b = product.getByIds({ product_ids: [7, 5, 9], currency: 'NOK' })
    const c = product.getByIds({ product_ids: [8], currency: 'NOK' })
    await sent()
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]!.variables.productIds).toEqual([5, 7, 9, 8])
    state.calls[0]!.resolve(answer([9, 5, 7]))
    expect((await a).map((p) => p.id)).toEqual([5])
    expect((await b).map((p) => p.id)).toEqual([7, 5, 9])
    expect(await c).toEqual([])
  })

  it('calls asking something else are not joined (useCache, currency)', async () => {
    const product = client()
    const a = product.getByIds({ product_ids: [1], currency: 'NOK' })
    const b = product.getByIds({ product_ids: [2], currency: 'NOK', useCache: false })
    const c = product.getByIds({ product_ids: [3], currency: 'SEK' })
    await vi.waitFor(() => expect(state.calls).toHaveLength(3))
    expect(state.calls.map((x) => x.variables.productIds)).toEqual([[1], [2], [3]])
    state.calls.forEach((x) => x.resolve(answer(x.variables.productIds)))
    expect((await a)[0]!.id).toBe(1)
    expect((await b)[0]!.id).toBe(2)
    expect((await c)[0]!.id).toBe(3)
  })

  it('a later turn is another request', async () => {
    const product = client()
    const a = product.getByIds({ product_ids: [1], currency: 'NOK' })
    await sent()
    const b = product.getByIds({ product_ids: [2], currency: 'NOK' })
    await vi.waitFor(() => expect(state.calls).toHaveLength(2))
    state.calls.forEach((x) => x.resolve(answer(x.variables.productIds)))
    expect((await a)[0]!.id).toBe(1)
    expect((await b)[0]!.id).toBe(2)
  })

  it('a failed joined request rejects every caller with the API’s error', async () => {
    const product = client()
    const a = product.getByIds({ product_ids: [1], currency: 'NOK' })
    const b = product.getByIds({ product_ids: [2], currency: 'NOK' })
    await sent()
    state.calls[0]!.reject(new Error('503'))
    await expect(a).rejects.toThrow('503')
    await expect(b).rejects.toThrow('503')
  })

  it('more ids than one request takes are split; a caller fails only if one of its ids was in the part that failed', async () => {
    const product = client()
    const many = Array.from({ length: JOINED_REQUEST_MAX_IDS }, (_, i) => i + 1)
    const a = product.getByIds({ product_ids: many, currency: 'NOK' })
    const b = product.getByIds({ product_ids: [9001, 9002], currency: 'NOK' })
    await vi.waitFor(() => expect(state.calls).toHaveLength(2))
    expect(state.calls[0]!.variables.productIds).toEqual(many)
    expect(state.calls[1]!.variables.productIds).toEqual([9001, 9002])
    state.calls[0]!.resolve(answer(many))
    state.calls[1]!.reject(new Error('timeout'))
    expect(await a).toHaveLength(JOINED_REQUEST_MAX_IDS)
    await expect(b).rejects.toThrow('timeout')
  })

  it('no ids: nothing is asked', async () => {
    expect(await client().getByIds({ product_ids: [] })).toEqual([])
    await new Promise((r) => setTimeout(r, 10))
    expect(state.calls).toHaveLength(0)
  })
})
