/**
 * The discount code of a cart, end to end: the real facade, cart and
 * checkout managers against a fake commerce gateway that keeps the contract
 * (one code per cart; the same code again is fine, another one is refused; a
 * gift code may go on the cart before the gift; every line is answered with
 * what the code takes off it). `fetch` is stubbed: bootstrap, surface and the
 * commerce GraphQL.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Configuration } from './configuration.js'
import { resetGatewayFeatures } from './api/gateway-features.js'
import { resetCheckoutSponsorMemory } from './sponsor-identity.js'
import type { BootstrapResponse, Sponsor } from './types.js'

let Vio: typeof import('./client.js').Vio

const FAVES = 7
const faves: Sponsor = { id: FAVES, name: 'Faves', commerce: { apiKey: 'key-484', channelId: '484' } }
const boot = (): BootstrapResponse => ({
  campaign: { id: 4, name: 'Faves høst' },
  primarySponsor: faves,
  campaigns: [{ id: 4, name: 'Faves høst', status: 'active', isDefault: true, primarySponsor: faves, slots: [] }],
})

/** Product ids and their list prices; `GAVE` makes the serum free. */
const CREAM = 100
const SERUM = 500
const PRICE: Record<number, number> = { [CREAM]: 349, [SERUM]: 499 }
const CODES: Record<string, { percentage: number; products?: number[] }> = {
  GAVE: { percentage: 100, products: [SERUM] },
  TI: { percentage: 10 },
}

let session: Map<string, string>
/** Every commerce GraphQL call: its operation, the key it carried, its variables and its query. */
let calls: Array<{ op: string; key: string; variables: Record<string, any>; query: string }>
/** Never reset: the facade is one per page, and it remembers checkouts it announced by id. */
let cartSeq = 0
let carts: Map<string, Array<{ id: string; product_id: number; quantity: number }>>
/** The code each backend cart carries. */
let cartCodes: Map<string, string>
/** What the gateway does with the next ApplyDiscount, when not the contract's own answer. */
let applyFails: 'never' | 'throws'
/** Whether this gateway knows `discount_code` on the cart. */
let knowsCartDiscountCode: boolean

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

/** What the cart's code takes off a line: its amount, all units, taxes included. */
function discountOf(cartId: string, l: { product_id: number; quantity: number }): number {
  const rule = CODES[cartCodes.get(cartId) ?? '']
  if (!rule) return 0
  if (rule.products && !rule.products.includes(l.product_id)) return 0
  return ((PRICE[l.product_id] ?? 100) * l.quantity * rule.percentage) / 100
}

function cartBody(cartId: string, query = '') {
  return {
    cart_id: cartId,
    currency: 'NOK',
    shipping_country: 'NO',
    ...(query.includes('discount_code') ? { discount_code: cartCodes.get(cartId) ?? null } : {}),
    line_items: (carts.get(cartId) ?? []).map((l) => ({
      id: l.id,
      product_id: l.product_id,
      title: `P${l.product_id}`,
      quantity: l.quantity,
      price: {
        amount: (PRICE[l.product_id] ?? 100) * 0.8,
        amount_incl_taxes: PRICE[l.product_id] ?? 100,
        currency_code: 'NOK',
        discount: discountOf(cartId, l),
      },
    })),
  }
}

function graphql(body: { query: string; variables: Record<string, any> }, key: string): Response {
  const op = /(?:mutation|query)\s+(\w+)/.exec(body.query)?.[1] ?? '?'
  calls.push({ op, key, variables: body.variables, query: body.query })
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
      if (body.query.includes('discount_code') && !knowsCartDiscountCode) {
        return json({ errors: [{ message: 'Cannot query field "discount_code" on type "GetCartDTO".' }] }, 400)
      }
      return json({ data: { Cart: { GetCart: cartBody(v.cartId, body.query) } } })
    case 'ApplyDiscount': {
      if (applyFails === 'throws') return json({ errors: [{ message: 'shopcart is down' }] }, 502)
      const current = cartCodes.get(v.cartId)
      const answer = !CODES[v.code]
        ? { executed: false, message: 'COUPON_NOT_FOUND' }
        : current && current !== v.code
          ? { executed: false, message: 'COUPON_OTHER_APPLIED' }
          : { executed: true, message: '' }
      if (answer.executed) cartCodes.set(v.cartId, v.code)
      return json({ data: { Discounts: { ApplyDiscount: answer } } })
    }
    case 'DeleteAppliedDiscount': {
      const had = cartCodes.get(v.cartId) === v.code
      if (had) cartCodes.delete(v.cartId)
      return json({ data: { Discounts: { DeleteAppliedDiscount: { executed: had, message: had ? '' : 'Discount not applied' } } } })
    }
    case 'CreateCheckout':
      return json({ data: { Checkout: { CreateCheckout: { id: `co-${v.cartId}`, status: 'open' } } } })
    case 'UpdateCheckout':
      return json({ data: { Checkout: { UpdateCheckout: { id: v.checkoutId, status: 'open' } } } })
    default:
      return json({ data: {} })
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeAll(async () => {
  delete (globalThis as { __VIO_FACADE__?: unknown }).__VIO_FACADE__
  ;({ Vio } = await import('./client.js'))
})

beforeEach(() => {
  calls = []
  carts = new Map()
  cartCodes = new Map()
  session = new Map()
  applyFails = 'never'
  knowsCartDiscountCode = true
  resetGatewayFeatures()
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    if (url.includes('/v2/mobile/config')) return json(boot())
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
    visibilityState: 'visible',
    addEventListener: () => {},
  })
  vi.stubGlobal('location', { href: 'https://host.example/a', pathname: '/a', search: '', host: 'host.example' })
  vi.stubGlobal('localStorage', undefined)
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  })
  resetCheckoutSponsorMemory()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  Vio.cart.clearAllCarts()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Configuration.reset()
  resetGatewayFeatures()
})

/** One connection per test: its own cart manager, so a code asked for in one test is not the next one's. */
let keySeq = 0

async function ready(config: Record<string, unknown> = {}) {
  Vio.init({ apiKey: `surface-key-${++keySeq}`, environment: 'testing', ...config } as never)
  Vio.cart.clearAllCarts()
  await Vio.bootstrap()
  await flush()
}

const add = (productId: number, quantity = 1) =>
  Vio.cart.addManual({
    productId,
    sponsorId: FAVES,
    brand: 'Faves',
    name: `P${productId}`,
    unitPrice: PRICE[productId] ?? 100,
    currency: 'NOK',
    imageUrl: '',
    quantity,
    origin: { campaignId: 4, slot: 'article-1' },
  })

const ops = () => calls.map((c) => c.op)
const cartIdNow = () => Vio.cart.getCart(FAVES)?.cartId ?? ''

describe('Vio.applyDiscountCode / Vio.removeDiscountCode — a host\'s own code field', () => {
  it('puts the code on the backend cart with the cart\'s channel key, and reads the cart again with its code', async () => {
    await ready()
    add(CREAM)
    await Vio.cart.waitForCartMutations(FAVES)
    calls = []

    const result = await Vio.applyDiscountCode('TI')

    expect(result).toEqual({
      status: 'applied',
      code: 'TI',
      carts: [{ sponsorId: FAVES, status: 'applied', answer: { executed: true, message: '' } }],
    })
    expect(ops()).toEqual(['ApplyDiscount', 'GetCart'])
    expect(calls[0]).toMatchObject({ key: 'key-484', variables: { cartId: cartIdNow(), code: 'TI' } })
    expect(calls[1]!.query).toContain('discount_code')
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
    expect(cartCodes.get(cartIdNow())).toBe('TI')
  })

  it('a code Commerce does not know, and a second code on a cart that has one: refused, cart untouched', async () => {
    await ready()
    add(CREAM)
    await Vio.cart.waitForCartMutations(FAVES)

    await expect(Vio.applyDiscountCode('FINNESIKKE')).resolves.toMatchObject({ status: 'refused', reason: 'COUPON_NOT_FOUND' })
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()

    await Vio.applyDiscountCode('TI')
    await expect(Vio.applyDiscountCode('GAVE')).resolves.toMatchObject({ status: 'refused', reason: 'COUPON_OTHER_APPLIED' })
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
    expect(cartCodes.get(cartIdNow())).toBe('TI')
  })

  it('removeDiscountCode takes it off, and the cart is read as a cart without a code', async () => {
    await ready()
    add(CREAM)
    await Vio.cart.waitForCartMutations(FAVES)
    await Vio.applyDiscountCode('TI')
    calls = []

    await expect(Vio.removeDiscountCode()).resolves.toMatchObject({ removed: true, carts: [{ sponsorId: FAVES, code: 'TI', status: 'removed' }] })

    expect(ops()).toEqual(['DeleteAppliedDiscount', 'GetCart'])
    expect(calls[0]).toMatchObject({ key: 'key-484', variables: { cartId: cartIdNow(), code: 'TI' } })
    expect(calls[1]!.query).not.toContain('discount_code')
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()
    expect(cartCodes.has(cartIdNow())).toBe(false)
  })

  it('a gateway without the cart\'s discount_code: the code still goes on, and the cart is read the old way', async () => {
    knowsCartDiscountCode = false
    await ready()
    add(CREAM)
    await Vio.cart.waitForCartMutations(FAVES)
    calls = []

    await expect(Vio.applyDiscountCode('TI')).resolves.toMatchObject({ status: 'applied' })

    expect(ops()).toEqual(['ApplyDiscount', 'GetCart', 'GetCart'])
    expect(calls[2]!.query).not.toContain('discount_code')
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
  })
})

describe('a page without discount codes', () => {
  it('adds, reads and checks out with the calls it always made — none about discounts', async () => {
    await ready()
    add(CREAM)
    await Vio.cart.waitForCartMutations(FAVES)
    await Vio.cart.refreshFromServer(FAVES)
    await Vio.checkout.createCheckout(FAVES)

    expect(ops()).toEqual(['CreateCart', 'AddItem', 'GetCart', 'GetCart', 'CreateCheckout', 'UpdateCheckout'])
    for (const call of calls) expect(call.query).not.toMatch(/ApplyDiscount|DeleteAppliedDiscount|discount_code\n {4}\}/)
    expect(calls.filter((c) => c.op === 'GetCart').every((c) => !c.query.includes('discount_code'))).toBe(true)
    expect(Vio.cart.getCart(FAVES)).not.toHaveProperty('discountCode')
  })
})
