import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  confirmPaymentApplePay,
  getCheckoutOrderNumber,
  getCheckoutReference,
  isUnknownFieldError,
  resetBuyerRefSupport,
  CONFIRM_PAYMENT_APPLE_PAY_MUTATION,
  CONFIRM_PAYMENT_APPLE_PAY_MUTATION_LEGACY,
  GET_CHECKOUT_ORDER_NUMBER_QUERY,
  GET_CHECKOUT_ORDER_NUMBER_QUERY_LEGACY,
  GET_CHECKOUT_QUERY,
} from '../api/cart-queries.js'
import { Vio } from '../client.js'
import { Configuration } from '../configuration.js'

/**
 * The Vio order number (#4497) for the receipt, and the buyer reference
 * (`buyer_ref`, shopcart's keyed hash of the email → analytics `buyer_id`).
 * `order_id` is new on GetCheckout (2026-10-08) and `buyer_ref` newer
 * (2026-10-19): an API that does not have them yet answers the query with an
 * error, so they are asked apart from the payment check, a missing `buyer_ref`
 * is asked again without it (once per page load), and a failure is "no
 * number", never a failed payment check.
 */
const OPTS = { endpoint: 'https://graph.test', apiKey: 'k' }

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Every fetch gets its OWN Response — a body reads once, and some paths fetch more than once. */
const answer = (body: unknown, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(body, status))

const UNKNOWN_BUYER_REF = { errors: [{ message: 'Cannot query field "buyer_ref" on type "GetCheckoutDTO". Did you mean "buyer"?' }] }

const sentQuery = (fetchMock: { mock: { calls: unknown[][] } }, i: number) =>
  JSON.parse((fetchMock.mock.calls[i]![1] as { body: string }).body).query as string

beforeEach(resetBuyerRefSupport)
afterEach(() => {
  vi.restoreAllMocks()
  resetBuyerRefSupport()
})

describe('the order number query', () => {
  it('asks for id, order_id and buyer_ref (the legacy selection without buyer_ref); the payment check asks for none of them', () => {
    expect(GET_CHECKOUT_ORDER_NUMBER_QUERY).toContain('GetCheckout(checkout_id: $checkoutId)')
    expect(GET_CHECKOUT_ORDER_NUMBER_QUERY).toContain('order_id')
    expect(GET_CHECKOUT_ORDER_NUMBER_QUERY).toContain('buyer_ref')
    expect(GET_CHECKOUT_ORDER_NUMBER_QUERY_LEGACY).toContain('order_id')
    expect(GET_CHECKOUT_ORDER_NUMBER_QUERY_LEGACY).not.toContain('buyer_ref')
    expect(GET_CHECKOUT_QUERY).not.toMatch(/\border_id\b/)
    expect(GET_CHECKOUT_QUERY).not.toMatch(/\bbuyer_ref\b/)
  })

  it('answers the number once the order exists', async () => {
    answer({ data: { Checkout: { GetCheckout: { id: 'c', order_id: 4497 } } } })
    expect(await getCheckoutOrderNumber('c', OPTS)).toBe(4497)
  })

  it('answers null while it does not', async () => {
    answer({ data: { Checkout: { GetCheckout: { id: 'c', order_id: null } } } })
    expect(await getCheckoutOrderNumber('c', OPTS)).toBeNull()
  })
})

describe('getCheckoutReference: the buyer reference', () => {
  it('answers the order number and the buyer reference together', async () => {
    answer({ data: { Checkout: { GetCheckout: { id: 'c', order_id: 4497, buyer_ref: 'brf_7f3a9c' } } } })
    expect(await getCheckoutReference('c', OPTS)).toEqual({ orderNumber: 4497, buyerRef: 'brf_7f3a9c' })
  })

  it('null for whatever the API does not say — and never an email, never over 128 chars', async () => {
    answer({ data: { Checkout: { GetCheckout: { id: 'c', order_id: null, buyer_ref: null } } } })
    expect(await getCheckoutReference('c', OPTS)).toEqual({ orderNumber: null, buyerRef: null })
    vi.restoreAllMocks()
    answer({ data: { Checkout: { GetCheckout: { id: 'c', order_id: 1, buyer_ref: 'ola@nordmann.no' } } } })
    expect((await getCheckoutReference('c', OPTS)).buyerRef).toBeNull()
    vi.restoreAllMocks()
    answer({ data: { Checkout: { GetCheckout: { id: 'c', order_id: 1, buyer_ref: 'x'.repeat(129) } } } })
    expect((await getCheckoutReference('c', OPTS)).buyerRef).toBeNull()
  })

  it('a gateway without buyer_ref: asked again without the field, once, and remembered for the page load', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(UNKNOWN_BUYER_REF, 400))
      .mockImplementation(async () => response({ data: { Checkout: { GetCheckout: { id: 'c', order_id: 4497 } } } }))
    expect(await getCheckoutReference('c', OPTS)).toEqual({ orderNumber: 4497, buyerRef: null })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sentQuery(fetchMock, 0)).toContain('buyer_ref')
    expect(sentQuery(fetchMock, 1)).not.toContain('buyer_ref')
    // Remembered: the next ask goes straight to the legacy selection.
    expect(await getCheckoutReference('c', OPTS)).toEqual({ orderNumber: 4497, buyerRef: null })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sentQuery(fetchMock, 2)).not.toContain('buyer_ref')
  })

  it('any other error is not retried: an API without order_id still fails the query once', async () => {
    const fetchMock = answer({ errors: [{ message: 'Cannot query field "order_id" on type "GetCheckoutDTO".' }] }, 400)
    await expect(getCheckoutReference('c', OPTS)).rejects.toThrow('order_id')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('isUnknownFieldError: the validation message about THAT field, with no data; nothing that ran', () => {
    const e = (message: string, graphql?: unknown) => Object.assign(new Error(message), graphql ? { graphql } : {})
    expect(isUnknownFieldError(e('Cannot query field "buyer_ref" on type "X".'), 'buyer_ref')).toBe(true)
    expect(isUnknownFieldError(e('boom', { hasData: false, errors: [{ message: 'Unknown field "buyer_ref"' }] }), 'buyer_ref')).toBe(true)
    expect(isUnknownFieldError(e('Cannot query field "order_id" on type "X".'), 'buyer_ref')).toBe(false)
    // Something ran and failed on that field: data present — never a retry.
    expect(
      isUnknownFieldError(e('Cannot query field "buyer_ref"', { hasData: true, errors: [{ message: 'x' }] }), 'buyer_ref'),
    ).toBe(false)
    expect(isUnknownFieldError(e('GraphQL request timed out after 15000ms'), 'buyer_ref')).toBe(false)
    expect(isUnknownFieldError(null, 'buyer_ref')).toBe(false)
  })
})

describe('confirmPaymentApplePay with buyer_ref', () => {
  it('selects buyer_ref; the legacy selection does not', () => {
    expect(CONFIRM_PAYMENT_APPLE_PAY_MUTATION).toContain('buyer_ref')
    expect(CONFIRM_PAYMENT_APPLE_PAY_MUTATION_LEGACY).not.toContain('buyer_ref')
    expect(CONFIRM_PAYMENT_APPLE_PAY_MUTATION_LEGACY).toContain('order_id')
  })

  it('a gateway that refuses the selection (nothing ran): sent again without the field', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(UNKNOWN_BUYER_REF, 400))
      .mockResolvedValueOnce(response({ data: { Payment: { ConfirmPaymentApplePay: { order_id: 'o', status: 'paid' } } } }))
    expect(await confirmPaymentApplePay({ checkoutId: 'c', applePayToken: 't' }, OPTS)).toEqual({ order_id: 'o', status: 'paid' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sentQuery(fetchMock, 1)).not.toContain('buyer_ref')
  })

  it('a confirmation that ran and failed is NEVER repeated (one call, the error surfaces)', async () => {
    const fetchMock = answer({ data: { Payment: { ConfirmPaymentApplePay: null } }, errors: [{ message: 'Card declined' }] }, 200)
    await expect(confirmPaymentApplePay({ checkoutId: 'c', applePayToken: 't' }, OPTS)).rejects.toThrow('Card declined')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('Vio.checkout.getOrderNumber / getOrderReference never throw', () => {
  // Initialized, so the commerce options do not wait 2 s for an init that never comes.
  beforeEach(() => Configuration.init({ apiKey: 'k', environment: 'testing' }))
  afterEach(() => Configuration.reset())

  it('an API without the field is "no number"', async () => {
    answer({ errors: [{ message: 'Cannot query field "order_id" on type "GetCheckoutDTO".' }] }, 400)
    const m = Vio.checkout as any
    expect(await m.getOrderNumber('c', 5)).toBeNull()
    expect(await m.getOrderReference('c', 5)).toEqual({ orderNumber: null, buyerRef: null })
  })

  it('answers the reference when the API has it', async () => {
    answer({ data: { Checkout: { GetCheckout: { id: 'c', order_id: 4497, buyer_ref: 'brf_1' } } } })
    expect(await (Vio.checkout as any).getOrderReference('c', 5)).toEqual({ orderNumber: 4497, buyerRef: 'brf_1' })
  })

  it('no checkout, no question', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    expect(await (Vio.checkout as any).getOrderNumber('', 5)).toBeNull()
    expect(await (Vio.checkout as any).getOrderReference('', 5)).toEqual({ orderNumber: null, buyerRef: null })
    expect(spy).not.toHaveBeenCalled()
  })

  it('concurrent asks for the same checkout share one request (the receipt and the payment event start together)', async () => {
    const fetchMock = answer({ data: { Checkout: { GetCheckout: { id: 'c', order_id: 4497, buyer_ref: 'brf_1' } } } })
    const m = Vio.checkout as any
    const [a, b, n] = await Promise.all([m.getOrderReference('c', 5), m.getOrderReference('c', 5), m.getOrderNumber('c', 5)])
    expect(a).toEqual({ orderNumber: 4497, buyerRef: 'brf_1' })
    expect(b).toBe(a)
    expect(n).toBe(4497)
    const graphqlCalls = fetchMock.mock.calls.filter((c) => String((c[1] as { body?: string })?.body ?? '').includes('GetCheckoutOrderNumber'))
    expect(graphqlCalls).toHaveLength(1)
    // Settled: the next ask is a new request.
    await m.getOrderReference('c', 5)
    expect(fetchMock.mock.calls.filter((c) => String((c[1] as { body?: string })?.body ?? '').includes('GetCheckoutOrderNumber'))).toHaveLength(2)
  })
})
