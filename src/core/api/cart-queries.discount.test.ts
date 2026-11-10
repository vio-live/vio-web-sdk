/**
 * The discount code of a cart on the wire: `Discounts.ApplyDiscount` /
 * `DeleteAppliedDiscount`, and `GetCart` asking which code the cart carries —
 * only when asked to, so a page without discounts sends the query it always
 * sent, and a gateway that predates the field gets that same query.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APPLY_DISCOUNT_MUTATION,
  APPLY_DISCOUNT_MUTATION_LEGACY,
  DELETE_APPLIED_DISCOUNT_MUTATION,
  GET_CART_QUERY,
  GET_CART_WITH_DISCOUNT_CODE_QUERY,
  applyDiscount,
  deleteAppliedDiscount,
  getCart,
} from './cart-queries.js'
import { gatewayHas, resetGatewayFeatures } from './gateway-features.js'

const OPTS = { apiKey: 'k', commerceKey: 'ck', endpoint: 'http://commerce.test' }

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** What call `i` sent: its query and variables. */
const sent = (fetchMock: { mock: { calls: unknown[][] } }, i = 0) =>
  JSON.parse((fetchMock.mock.calls[i]![1] as { body: string }).body) as { query: string; variables: Record<string, unknown> }

beforeEach(() => {
  resetGatewayFeatures()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  resetGatewayFeatures()
})

describe('applyDiscount / deleteAppliedDiscount', () => {
  it('ApplyDiscount goes out with the cart and the code, with the cart\'s commerce key', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => response({ data: { Discounts: { ApplyDiscount: { executed: true, message: 'ok' } } } }))
    const answer = await applyDiscount('cart-1', 'GAVE', OPTS)
    expect(answer).toEqual({ executed: true, message: 'ok' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sent(fetchMock).query).toBe(APPLY_DISCOUNT_MUTATION)
    expect(sent(fetchMock).variables).toEqual({ cartId: 'cart-1', code: 'GAVE' })
    const headers = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('ck')
  })

  it('a refusal is an answer, not an error: executed false with Commerce\'s words', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      response({ data: { Discounts: { ApplyDiscount: { executed: false, message: 'COUPON_NOT_FOUND' } } } }),
    )
    await expect(applyDiscount('cart-1', 'NOPE', OPTS)).resolves.toEqual({ executed: false, message: 'COUPON_NOT_FOUND' })
  })

  it('asks for the gifts of the code, and hands them over with whatever else the answer carries', async () => {
    const gifts = [{ product_id: 421306, variant_id: null, quantity: 1 }]
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => response({ data: { Discounts: { ApplyDiscount: { executed: true, message: '', gifts, later: 'field' } } } }))
    await expect(applyDiscount('cart-1', 'GAVE', OPTS)).resolves.toEqual({ executed: true, message: '', gifts, later: 'field' })
    expect(sent(fetchMock).query).toContain('gifts')
  })

  it('a gateway that predates `gifts` refuses the selection (nothing ran): sent once more without them, and from then on straight without', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ errors: [{ message: 'Cannot query field "gifts" on type "ApplyDiscountDTO".' }] }, 400))
      .mockImplementation(async () => response({ data: { Discounts: { ApplyDiscount: { executed: true, message: '' } } } }))
    await expect(applyDiscount('cart-1', 'GAVE', OPTS)).resolves.toEqual({ executed: true, message: '' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sent(fetchMock, 0).query).toBe(APPLY_DISCOUNT_MUTATION)
    expect(sent(fetchMock, 1).query).toBe(APPLY_DISCOUNT_MUTATION_LEGACY)
    expect(gatewayHas('discount_gifts')).toBe(false)

    await applyDiscount('cart-1', 'GAVE', OPTS)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sent(fetchMock, 2).query).toBe(APPLY_DISCOUNT_MUTATION_LEGACY)
  })

  it('an ApplyDiscount that ran and failed is never sent twice', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        response({ data: { Discounts: { ApplyDiscount: null } }, errors: [{ message: 'gifts could not be read', path: ['Discounts', 'ApplyDiscount'] }] }),
      )
    await expect(applyDiscount('cart-1', 'GAVE', OPTS)).rejects.toThrow('gifts could not be read')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(gatewayHas('discount_gifts')).toBe(true)
  })

  it('an answer without the payload reads as not executed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({ data: { Discounts: {} } }))
    await expect(applyDiscount('cart-1', 'GAVE', OPTS)).resolves.toEqual({ executed: false, message: '' })
  })

  it('a call that fails rejects — the caller decides the purchase goes on without it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({ errors: [{ message: 'boom' }] }, 500))
    await expect(applyDiscount('cart-1', 'GAVE', OPTS)).rejects.toThrow('boom')
  })

  it('DeleteAppliedDiscount takes the code off that cart', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => response({ data: { Discounts: { DeleteAppliedDiscount: { executed: true, message: '' } } } }))
    await expect(deleteAppliedDiscount('cart-1', 'GAVE', OPTS)).resolves.toEqual({ executed: true, message: '' })
    expect(sent(fetchMock).query).toBe(DELETE_APPLIED_DISCOUNT_MUTATION)
    expect(sent(fetchMock).variables).toEqual({ cartId: 'cart-1', code: 'GAVE' })
  })
})

describe('GetCart and the cart\'s discount code', () => {
  const CART = { cart_id: 'cart-1', line_items: [] }

  it('the query a page without discounts sends has no discount_code — the other one differs by that line alone', () => {
    expect(GET_CART_QUERY).not.toContain('discount_code')
    expect(GET_CART_WITH_DISCOUNT_CODE_QUERY).toContain('discount_code')
    expect(GET_CART_WITH_DISCOUNT_CODE_QUERY.replace('\n      discount_code', '')).toBe(GET_CART_QUERY)
  })

  it('getCart as it always was: the legacy query, and nothing learned about the gateway', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({ data: { Cart: { GetCart: CART } } }))
    await expect(getCart('cart-1', OPTS)).resolves.toEqual(CART)
    expect(sent(fetchMock).query).toBe(GET_CART_QUERY)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('with a code in play it also asks which code the cart carries', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => response({ data: { Cart: { GetCart: { ...CART, discount_code: 'GAVE' } } } }))
    await expect(getCart('cart-1', OPTS, { discountCode: true })).resolves.toMatchObject({ discount_code: 'GAVE' })
    expect(sent(fetchMock).query).toBe(GET_CART_WITH_DISCOUNT_CODE_QUERY)
  })

  it('a gateway that predates the field: asked once more without it, and from then on straight without', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ errors: [{ message: 'Cannot query field "discount_code" on type "GetCartDTO".' }] }, 400))
      .mockImplementation(async () => response({ data: { Cart: { GetCart: CART } } }))
    await expect(getCart('cart-1', OPTS, { discountCode: true })).resolves.toEqual(CART)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sent(fetchMock, 0).query).toBe(GET_CART_WITH_DISCOUNT_CODE_QUERY)
    expect(sent(fetchMock, 1).query).toBe(GET_CART_QUERY)
    expect(gatewayHas('cart_discount_code')).toBe(false)

    await getCart('cart-1', OPTS, { discountCode: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sent(fetchMock, 2).query).toBe(GET_CART_QUERY)
  })

  it('a GetCart that ran and failed is not a missing field: it fails, and is not asked again', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => response({ data: { Cart: { GetCart: null } }, errors: [{ message: 'Cart not found', path: ['Cart', 'GetCart'] }] }))
    await expect(getCart('cart-1', OPTS, { discountCode: true })).rejects.toThrow('Cart not found')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(gatewayHas('cart_discount_code')).toBe(true)
  })
})
