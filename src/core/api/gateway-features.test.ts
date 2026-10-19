/**
 * What the commerce gateway may not know yet (gateway-features): a cart
 * line's `origin`, the checkout's `attribution` (ADR-0035 phase B) — like
 * `buyer_ref` before them. A gateway that refuses the field at validation
 * (nothing ran, no data) gets the operation again without it, once per page
 * load; anything that ran is never repeated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  gatewayHas,
  isUnknownFeatureError,
  isUnknownTokenError,
  resetGatewayFeatures,
  withGatewayFeature,
} from './gateway-features.js'
import {
  ADD_ITEM_MUTATION,
  CREATE_CHECKOUT_MUTATION,
  CREATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION,
  UPDATE_CHECKOUT_MUTATION,
  UPDATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION,
  UPDATE_ITEM_MUTATION,
  UPDATE_ITEM_WITH_ORIGIN_MUTATION,
  addItem,
  createCheckout,
  gatewayHasBuyerRef,
  isUnknownFieldError,
  updateCheckout,
  updateItem,
  withBuyerRef,
} from './cart-queries.js'

const OPTS = { endpoint: 'https://graph.test', apiKey: 'k' }
const ORIGIN = { campaign_id: 12, location_id: 'hero', component_kind: 'card', content_url: 'https://host.example/a' }
const ATTRIBUTION = { surface_key: 'surface-key', campaign_id: 7, content_url: 'https://host.example/a' }

const e = (message: string, graphql?: unknown) => Object.assign(new Error(message), graphql ? { graphql } : {})

/** Answers the fetches in order (each its own Response) and keeps what was sent. */
function gateway(...bodies: Array<{ body: unknown; status?: number }>) {
  const sent: Array<{ query: string; variables: Record<string, unknown> }> = []
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    sent.push(JSON.parse((init as { body: string }).body))
    const next = bodies.shift() ?? { body: { data: {} } }
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  })
  return { sent, spy }
}

const refusal = (message: string) => ({ body: { errors: [{ message }] }, status: 400 })
const UNKNOWN_FIELD_ORIGIN = refusal(
  'Variable "$lineItems" got invalid value { origin: {…} } at "lineItems[0]"; Field "origin" is not defined by type "LineItemInput".',
)
const UNKNOWN_TYPE_ORIGIN = refusal('Unknown type "CartLineOriginInput".')
const UNKNOWN_ARG_ATTRIBUTION = refusal('Unknown argument "attribution" on field "CheckoutMutations.UpdateCheckout".')
const UNKNOWN_TYPE_ATTRIBUTION = refusal('Unknown type "CheckoutAttributionInput".')

beforeEach(() => {
  resetGatewayFeatures()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  resetGatewayFeatures()
})

describe('isUnknownTokenError / isUnknownFeatureError', () => {
  it('a validation message naming THAT token, with no data', () => {
    expect(isUnknownTokenError(e('Unknown argument "origin" on field "CartMutations.UpdateItem".'), 'origin')).toBe(true)
    expect(isUnknownTokenError(e('Unknown type "CartLineOriginInput".'), 'CartLineOriginInput')).toBe(true)
    expect(isUnknownTokenError(e('x', { hasData: false, errors: [{ message: 'Field "origin" is not defined by type "LineItemInput".' }] }), 'origin')).toBe(true)
    expect(isUnknownTokenError(e('Cannot query field "buyer_ref" on type "X".'), 'buyer_ref')).toBe(true)
    // Another token, something that ran, a timeout, nothing at all.
    expect(isUnknownTokenError(e('Unknown argument "attribution" on field "X".'), 'origin')).toBe(false)
    expect(isUnknownTokenError(e('Unknown argument "origin"', { hasData: true, errors: [] }), 'origin')).toBe(false)
    expect(isUnknownTokenError(e('GraphQL request timed out after 15000ms'), 'origin')).toBe(false)
    expect(isUnknownTokenError(e('Origin "https://x" not allowed by CORS'), 'origin')).toBe(false)
    expect(isUnknownTokenError(null, 'origin')).toBe(false)
  })

  it('a feature goes by its argument and its input types', () => {
    expect(isUnknownFeatureError(e('Unknown type "CartLineOriginInput".'), 'line_origin')).toBe(true)
    expect(isUnknownFeatureError(e('Unknown argument "origin" on field "X".'), 'line_origin')).toBe(true)
    expect(isUnknownFeatureError(e('Unknown type "CheckoutAttributionEntryInput".'), 'checkout_attribution')).toBe(true)
    expect(isUnknownFeatureError(e('Unknown type "CheckoutAttributionInput".'), 'line_origin')).toBe(false)
  })

  it('isUnknownFieldError (buyer_ref) is the same rule by field name', () => {
    expect(isUnknownFieldError(e('Cannot query field "buyer_ref" on type "X".'), 'buyer_ref')).toBe(true)
    expect(isUnknownFieldError(e('Cannot query field "order_id" on type "X".'), 'buyer_ref')).toBe(false)
  })
})

describe('withGatewayFeature', () => {
  it('tries with the feature, falls back without it on a refusal, and remembers for the page load', async () => {
    const request = vi.fn(async (supported: boolean) => {
      if (supported) throw e('Unknown type "CartLineOriginInput".')
      return 'legacy'
    })
    expect(gatewayHas('line_origin')).toBe(true)
    expect(await withGatewayFeature('line_origin', request)).toBe('legacy')
    expect(request.mock.calls.map((c) => c[0])).toEqual([true, false])
    expect(gatewayHas('line_origin')).toBe(false)
    expect(await withGatewayFeature('line_origin', request)).toBe('legacy')
    expect(request.mock.calls.map((c) => c[0])).toEqual([true, false, false])
    // Said once.
    expect(console.warn).toHaveBeenCalledTimes(1)
    // Per feature: the others are untouched.
    expect(gatewayHas('checkout_attribution')).toBe(true)
    expect(gatewayHasBuyerRef()).toBe(true)
  })

  it('an error with a path is a resolver that failed — something ran — even with data: null, and is never retried', async () => {
    const ran = e('Unknown argument "origin" said a resolver, not the validator', {
      hasData: false,
      errors: [{ message: 'Unknown argument "origin" said a resolver, not the validator', path: ['Cart', 'UpdateItem'] }],
    })
    expect(isUnknownTokenError(ran, 'origin')).toBe(false)
    expect(isUnknownFeatureError(ran, 'line_origin')).toBe(false)
    const request = vi.fn(async () => {
      throw ran
    })
    await expect(withGatewayFeature('line_origin', request)).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
    expect(gatewayHas('line_origin')).toBe(true)
    // An empty path says nothing.
    expect(isUnknownTokenError(e('x', { hasData: false, errors: [{ message: 'Unknown type "CartLineOriginInput".', path: [] }] }), 'CartLineOriginInput')).toBe(true)
  })

  it('any other failure is thrown as is — and never retried', async () => {
    const request = vi.fn(async () => {
      throw e('boom', { hasData: true, errors: [{ message: 'Unknown argument "origin"' }] })
    })
    await expect(withGatewayFeature('line_origin', request)).rejects.toThrow('boom')
    expect(request).toHaveBeenCalledTimes(1)
    expect(gatewayHas('line_origin')).toBe(true)
  })

  it('buyer_ref rides on the same mechanism', async () => {
    const request = vi.fn(async (withRef: boolean) => (withRef ? Promise.reject(e('Cannot query field "buyer_ref" on type "X".')) : 'ok'))
    expect(await withBuyerRef(request)).toBe('ok')
    expect(gatewayHasBuyerRef()).toBe(false)
    expect(gatewayHas('line_origin')).toBe(true)
  })
})

describe('the mutations', () => {
  it('declare the new argument only in their attributed variant', () => {
    expect(UPDATE_ITEM_WITH_ORIGIN_MUTATION).toContain('$origin: CartLineOriginInput')
    expect(UPDATE_ITEM_WITH_ORIGIN_MUTATION).toContain('origin: $origin')
    expect(UPDATE_ITEM_MUTATION).not.toContain('origin')
    expect(CREATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION).toContain('$attribution: CheckoutAttributionInput')
    expect(CREATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION).toContain('attribution: $attribution')
    expect(CREATE_CHECKOUT_MUTATION).not.toContain('attribution')
    expect(UPDATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION).toContain('$attribution: CheckoutAttributionInput')
    expect(UPDATE_CHECKOUT_MUTATION).not.toContain('attribution')
    // AddItem's origin travels inside LineItemInput: the document does not change.
    expect(ADD_ITEM_MUTATION).not.toContain('origin')
  })

  it('addItem: the origin on the line; refused → the lines again without it, then straight without', async () => {
    const { sent } = gateway(UNKNOWN_FIELD_ORIGIN, { body: { data: { Cart: { AddItem: { cart_id: 'c' } } } } }, { body: { data: { Cart: { AddItem: { cart_id: 'c' } } } } })
    const line = { product_id: 9, quantity: 1, variant_id: null, origin: ORIGIN }
    expect(await addItem('c', [line], OPTS)).toEqual({ cart_id: 'c' })
    expect(sent).toHaveLength(2)
    expect((sent[0]!.variables.lineItems as unknown[])[0]).toEqual(line)
    expect((sent[1]!.variables.lineItems as unknown[])[0]).toEqual({ product_id: 9, quantity: 1, variant_id: null })
    await addItem('c', [line], OPTS)
    expect(sent).toHaveLength(3)
    expect((sent[2]!.variables.lineItems as unknown[])[0]).not.toHaveProperty('origin')
  })

  it('addItem without origins is one plain request, whatever the gateway knows', async () => {
    const { sent } = gateway({ body: { data: { Cart: { AddItem: {} } } } })
    await addItem('c', [{ product_id: 9, quantity: 1, variant_id: null }], OPTS)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.query).toBe(ADD_ITEM_MUTATION)
  })

  it('updateItem: the attributed document with $origin; refused → the legacy one', async () => {
    const { sent } = gateway(UNKNOWN_TYPE_ORIGIN, { body: { data: { Cart: { UpdateItem: { cart_id: 'c' } } } } })
    expect(await updateItem('c', 'i', null, 2, OPTS, { origin: ORIGIN })).toEqual({ cart_id: 'c' })
    expect(sent[0]!.query).toBe(UPDATE_ITEM_WITH_ORIGIN_MUTATION)
    expect(sent[0]!.variables).toEqual({ cartId: 'c', cartItemId: 'i', shippingId: null, qty: 2, origin: ORIGIN })
    expect(sent[1]!.query).toBe(UPDATE_ITEM_MUTATION)
    expect(sent[1]!.variables).toEqual({ cartId: 'c', cartItemId: 'i', shippingId: null, qty: 2 })
    expect(gatewayHas('line_origin')).toBe(false)
  })

  it('updateItem without origin never declares it', async () => {
    const { sent } = gateway({ body: { data: { Cart: { UpdateItem: {} } } } })
    await updateItem('c', 'i', null, 1, OPTS)
    expect(sent[0]!.query).toBe(UPDATE_ITEM_MUTATION)
    expect(sent[0]!.variables).not.toHaveProperty('origin')
  })

  it('createCheckout: born attributed; refused → legacy', async () => {
    const { sent } = gateway(UNKNOWN_TYPE_ATTRIBUTION, { body: { data: { Checkout: { CreateCheckout: { id: 'CHK' } } } } })
    expect(await createCheckout('c', OPTS, { attribution: ATTRIBUTION })).toEqual({ id: 'CHK' })
    expect(sent[0]!.query).toBe(CREATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION)
    expect(sent[0]!.variables).toEqual({ cartId: 'c', attribution: ATTRIBUTION })
    expect(sent[1]!.query).toBe(CREATE_CHECKOUT_MUTATION)
    expect(sent[1]!.variables).toEqual({ cartId: 'c' })
  })

  it('updateCheckout: attribution among the variables; refused → the same variables without it', async () => {
    const { sent } = gateway(UNKNOWN_ARG_ATTRIBUTION, { body: { data: { Checkout: { UpdateCheckout: { id: 'CHK' } } } } })
    const vars = { checkoutId: 'CHK', email: 'kari@example.no', attribution: ATTRIBUTION }
    expect(await updateCheckout(vars, OPTS)).toEqual({ id: 'CHK' })
    expect(sent[0]!.query).toBe(UPDATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION)
    expect(sent[0]!.variables).toEqual(vars)
    expect(sent[1]!.query).toBe(UPDATE_CHECKOUT_MUTATION)
    expect(sent[1]!.variables).toEqual({ checkoutId: 'CHK', email: 'kari@example.no' })
    // One refusal covers both checkout mutations: the next CreateCheckout goes legacy at once.
    await createCheckout('c', OPTS, { attribution: ATTRIBUTION })
    expect(sent[2]!.query).toBe(CREATE_CHECKOUT_MUTATION)
  })

  it('an UpdateCheckout that RAN and failed is thrown, not retried (it would be a second write)', async () => {
    gateway({ body: { data: { Checkout: null }, errors: [{ message: 'Unknown argument "attribution" — but something ran' }] } })
    await expect(updateCheckout({ checkoutId: 'CHK', attribution: ATTRIBUTION }, OPTS)).rejects.toThrow()
    expect(gatewayHas('checkout_attribution')).toBe(true)
    // Apollo's shape for a resolver that failed under a non-null root: data null, the error with a path.
    const { sent } = gateway({
      body: { data: null, errors: [{ message: 'Unknown argument "attribution" in a resolver message', path: ['Checkout', 'UpdateCheckout'] }] },
      status: 200,
    })
    await expect(updateCheckout({ checkoutId: 'CHK', attribution: ATTRIBUTION }, OPTS)).rejects.toThrow()
    expect(sent).toHaveLength(1)
    expect(gatewayHas('checkout_attribution')).toBe(true)
  })
})
