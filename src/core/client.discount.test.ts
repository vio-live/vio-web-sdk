/**
 * The discount code of a cart, end to end: the real facade, cart and
 * checkout managers against a fake commerce gateway that keeps the contract —
 * one code per cart; the same code again is fine, another one is refused; a
 * refusal says why with a stable word; a code can give a product away
 * (`gifts`) and every line is answered with what the code takes off it; the
 * code is checked again when a payment is started. `fetch` is stubbed:
 * bootstrap, surface and the commerce GraphQL.
 *
 * A code is validated before paying: the page's own goes on in silence (and
 * is refused in silence), a typed one always answers whoever typed it — a
 * payment tapped while it is still being checked does not leave without it.
 *
 * The case it is written for (Faves): the brand's coupon `gratis_face_mask`,
 * applied by the page (`Vio.init({ discountCode })`), minimum purchase 10 kr,
 * gives one face mask (product 421306, 52 kr) away.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Configuration } from './configuration.js'
import { resetGatewayFeatures } from './api/gateway-features.js'
import { DISCOUNT_SETTLE_BUDGET_MS } from './checkout/checkout-manager.js'
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

/** Product ids and their list prices. */
const CREAM = 100
const TINY = 101
const MASK = 421306
const PRICE: Record<number, number> = { [CREAM]: 349, [TINY]: 5, [MASK]: 52 }
const GIFT_CODE = 'gratis_face_mask'
/** The brand's coupons: a gift with a minimum purchase, and ten per cent on everything. */
const CODES: Record<string, { percentage: number; products?: number[]; gifts?: number[]; minAmount?: number }> = {
  [GIFT_CODE]: { percentage: 100, products: [MASK], gifts: [MASK], minAmount: 10 },
  TI: { percentage: 10 },
}

interface FakeLine {
  id: string
  product_id: number
  quantity: number
}

let session: Map<string, string>
/** Every commerce GraphQL call: its operation, the key it carried, its variables and its query. */
let calls: Array<{ op: string; key: string; variables: Record<string, any>; query: string }>
/** Never reset: the facade is one per page, and it remembers checkouts it announced by id. */
let cartSeq = 0
let carts: Map<string, FakeLine[]>
/** The code each backend cart carries. */
let cartCodes: Map<string, string>
/** What each CreatePaymentVipps charged: the cart's lines less what its code takes off them. */
let charged: number[]
/** How the gateway and the brand's shop behave in this test. */
let gateway: {
  /** ApplyDiscount fails as a call (shopcart down). */
  applyThrows: boolean
  /** The brand's coupons that are over. */
  expired: Set<string>
  /** Products this channel cannot sell (an AddItem of them fails). */
  unavailable: Set<number>
  /** The gateway knows `discount_code` on the cart / `gifts` on ApplyDiscount. */
  knowsCartDiscountCode: boolean
  knowsGifts: boolean
  /** When set, ApplyDiscount answers only once this is resolved (the brand's shop is slow). */
  applyGate: Promise<void> | null
  /** CreatePaymentVipps fails for a reason that has nothing to do with the discount. */
  vippsDown: boolean
}

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

const priceOf = (productId: number) => PRICE[productId] ?? 100
const ruleOf = (cartId: string) => CODES[cartCodes.get(cartId) ?? '']

/** What the cart's code takes off a line: its amount, all units, taxes included. */
function discountOf(cartId: string, l: FakeLine): number {
  const rule = ruleOf(cartId)
  if (!rule) return 0
  if (rule.products && !rule.products.includes(l.product_id)) return 0
  return (priceOf(l.product_id) * l.quantity * rule.percentage) / 100
}

/** The lines a code does not give away, summed: what its minimum is measured against. */
const paidTotal = (cartId: string, code: string) =>
  (carts.get(cartId) ?? [])
    .filter((l) => !(CODES[code]?.gifts ?? []).includes(l.product_id))
    .reduce((sum, l) => sum + priceOf(l.product_id) * l.quantity, 0)

const totalOf = (cartId: string) =>
  (carts.get(cartId) ?? []).reduce((sum, l) => sum + priceOf(l.product_id) * l.quantity - discountOf(cartId, l), 0)

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
        amount: priceOf(l.product_id) * 0.8,
        amount_incl_taxes: priceOf(l.product_id),
        currency_code: 'NOK',
        discount: discountOf(cartId, l),
      },
    })),
  }
}

/** Why the brand's shop would not take (or keep) `code` on this cart; null when it does. */
function refusal(cartId: string, code: string): string | null {
  const rule = CODES[code]
  if (!rule) return 'COUPON_NOT_FOUND'
  if (gateway.expired.has(code)) return 'COUPON_EXPIRED'
  if (rule.minAmount !== undefined && paidTotal(cartId, code) < rule.minAmount) return 'COUPON_MIN_AMOUNT'
  return null
}

async function graphql(body: { query: string; variables: Record<string, any> }, key: string): Promise<Response> {
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
        if (gateway.unavailable.has(li.product_id)) {
          return json({ data: { Cart: { AddItem: null } }, errors: [{ message: 'Product not available on this channel', path: ['Cart', 'AddItem'] }] })
        }
        const found = lines.find((l) => l.product_id === li.product_id)
        if (found) found.quantity += li.quantity
        else lines.push({ id: `${v.cartId}-l${li.product_id}`, product_id: li.product_id, quantity: li.quantity })
      }
      carts.set(v.cartId, lines)
      return json({ data: { Cart: { AddItem: cartBody(v.cartId) } } })
    }
    case 'UpdateItem': {
      const line = (carts.get(v.cartId) ?? []).find((l) => l.id === v.cartItemId)
      if (line && typeof v.qty === 'number') line.quantity = v.qty
      return json({ data: { Cart: { UpdateItem: cartBody(v.cartId) } } })
    }
    case 'DeleteItem': {
      carts.set(v.cartId, (carts.get(v.cartId) ?? []).filter((l) => l.id !== v.cartItemId))
      return json({ data: { Cart: { DeleteItem: cartBody(v.cartId) } } })
    }
    case 'GetCart':
      if (body.query.includes('discount_code') && !gateway.knowsCartDiscountCode) {
        return json({ errors: [{ message: 'Cannot query field "discount_code" on type "GetCartDTO".' }] }, 400)
      }
      return json({ data: { Cart: { GetCart: cartBody(v.cartId, body.query) } } })
    case 'ApplyDiscount': {
      if (body.query.includes('gifts') && !gateway.knowsGifts) {
        return json({ errors: [{ message: 'Cannot query field "gifts" on type "ApplyDiscountDTO".' }] }, 400)
      }
      if (gateway.applyGate) await gateway.applyGate
      if (gateway.applyThrows) return json({ errors: [{ message: 'shopcart is down' }] }, 502)
      const current = cartCodes.get(v.cartId)
      const why = current && current !== v.code ? 'COUPON_OTHER_APPLIED' : refusal(v.cartId, v.code)
      if (why) return json({ data: { Discounts: { ApplyDiscount: { executed: false, message: why } } } })
      cartCodes.set(v.cartId, v.code)
      const gifts = (CODES[v.code]!.gifts ?? []).map((product_id) => ({ product_id, variant_id: null, quantity: 1 }))
      return json({
        data: { Discounts: { ApplyDiscount: { executed: true, message: '', ...(body.query.includes('gifts') ? { gifts } : {}) } } },
      })
    }
    case 'DeleteAppliedDiscount': {
      const had = cartCodes.get(v.cartId) === v.code
      if (had) cartCodes.delete(v.cartId)
      return json({ data: { Discounts: { DeleteAppliedDiscount: { executed: had, message: had ? '' : 'COUPON_NOT_FOUND' } } } })
    }
    case 'CreateCheckout':
      return json({ data: { Checkout: { CreateCheckout: { id: `co-${v.cartId}`, status: 'open' } } } })
    case 'UpdateCheckout':
      return json({ data: { Checkout: { UpdateCheckout: { id: v.checkoutId, status: 'open' } } } })
    case 'CreatePaymentVipps': {
      if (gateway.vippsDown) {
        return json({ data: { Payment: { CreatePaymentVipps: null } }, errors: [{ message: 'Payment Vipps not initialize: 503', path: ['Payment', 'CreatePaymentVipps'] }] })
      }
      const cartId = String(v.checkoutId).replace(/^co-/, '')
      const code = cartCodes.get(cartId)
      // The code is checked again right before charging, and a gift has its own rules.
      const why =
        (code ? refusal(cartId, code) : null) ??
        ((carts.get(cartId) ?? []).some((l) => l.quantity > 1 && discountOf(cartId, l) >= priceOf(l.product_id) * l.quantity)
          ? 'GIFT_MAX_ONE_UNIT'
          : totalOf(cartId) <= 0
            ? 'CHECKOUT_AMOUNT_ZERO'
            : null)
      if (why) {
        // As the gateway answers it: HTTP 400, the code in `extensions.code` and at the end of the text.
        return json(
          { errors: [{ message: `Payment Vipps not initialize: the payment was refused [${why}]`, extensions: { code: why } }] },
          400,
        )
      }
      charged.push(totalOf(cartId))
      return json({ data: { Payment: { CreatePaymentVipps: { payment_url: 'https://vipps.test/pay', reference: 'r-1', express: v.express === true } } } })
    }
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
  charged = []
  session = new Map()
  gateway = {
    applyThrows: false,
    expired: new Set(),
    unavailable: new Set(),
    knowsCartDiscountCode: true,
    knowsGifts: true,
    applyGate: null,
    vippsDown: false,
  }
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
})

afterEach(() => {
  vi.useRealTimers()
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
  // A checkout left open by another test is not this one's.
  Vio.checkout.close()
  await Vio.bootstrap()
  await flush()
}

const add = (productId: number, quantity = 1) =>
  Vio.cart.addManual({
    productId,
    sponsorId: FAVES,
    brand: 'Faves',
    name: `P${productId}`,
    unitPrice: priceOf(productId),
    currency: 'NOK',
    imageUrl: '',
    quantity,
    origin: { campaignId: 4, slot: 'article-1' },
  })

const ops = () => calls.map((c) => c.op)
const count = (op: string) => ops().filter((o) => o === op).length
const cartIdNow = () => Vio.cart.getCart(FAVES)?.cartId ?? ''
const linesNow = () => (Vio.cart.getCart(FAVES)?.items ?? []).map((i) => `${i.productId}×${i.quantity}`)
const serverLines = () => (carts.get(cartIdNow()) ?? []).map((l) => `${l.product_id}×${l.quantity}`)
const lineOf = (productId: number) => Vio.cart.getCart(FAVES)?.items.find((i) => i.productId === productId)
/** Until nothing of the cart is in flight: its mutations, a discount call and what follows it. */
async function idle() {
  for (let quiet = 0; quiet < 5; ) {
    await Vio.cart.waitForCartMutations(FAVES)
    await flush()
    quiet = Vio.cart.discountBusy() ? 0 : quiet + 1
  }
}
const before = (first: string, second: string) => {
  const a = ops().indexOf(first)
  const b = ops().lastIndexOf(second)
  return a !== -1 && b !== -1 && a < b
}

describe('Vio.applyDiscountCode / Vio.removeDiscountCode — a "discount code" field', () => {
  it('puts the code on the backend cart with the cart\'s channel key, and reads the cart again with its code', async () => {
    await ready()
    add(CREAM)
    await idle()
    calls = []

    const result = await Vio.applyDiscountCode('TI')

    expect(result).toMatchObject({ status: 'applied', code: 'TI', carts: [{ sponsorId: FAVES, status: 'applied', answer: { executed: true } }] })
    expect(ops()).toEqual(['ApplyDiscount', 'GetCart'])
    expect(calls[0]).toMatchObject({ key: 'key-484', variables: { cartId: cartIdNow(), code: 'TI' } })
    expect(calls[1]!.query).toContain('discount_code')
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
    expect(cartCodes.get(cartIdNow())).toBe('TI')
  })

  it('a code the brand\'s shop does not know, and a second code on a cart that has one: refused with the reason, cart untouched', async () => {
    await ready()
    add(CREAM)
    await idle()

    await expect(Vio.applyDiscountCode('FINNESIKKE')).resolves.toMatchObject({ status: 'refused', reason: 'COUPON_NOT_FOUND' })
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()

    await Vio.applyDiscountCode('TI')
    await expect(Vio.applyDiscountCode(GIFT_CODE)).resolves.toMatchObject({ status: 'refused', reason: 'COUPON_OTHER_APPLIED' })
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
    expect(cartCodes.get(cartIdNow())).toBe('TI')
    expect(linesNow()).toEqual([`${CREAM}×1`])
  })

  it('removeDiscountCode takes it off, and the cart is read as a cart without a code', async () => {
    await ready()
    add(CREAM)
    await idle()
    await Vio.applyDiscountCode('TI')
    calls = []

    await expect(Vio.removeDiscountCode()).resolves.toMatchObject({ removed: true, carts: [{ sponsorId: FAVES, code: 'TI', status: 'removed' }] })

    expect(ops()).toEqual(['DeleteAppliedDiscount', 'GetCart'])
    expect(calls[0]).toMatchObject({ key: 'key-484', variables: { cartId: cartIdNow(), code: 'TI' } })
    expect(calls[1]!.query).not.toContain('discount_code')
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()
    expect(cartCodes.has(cartIdNow())).toBe(false)
  })

  it('a gateway without the cart\'s discount_code and without gifts: the code still goes on, the old documents are sent', async () => {
    gateway.knowsCartDiscountCode = false
    gateway.knowsGifts = false
    await ready()
    add(CREAM)
    await idle()
    calls = []

    await expect(Vio.applyDiscountCode('TI')).resolves.toMatchObject({ status: 'applied' })

    expect(ops()).toEqual(['ApplyDiscount', 'ApplyDiscount', 'GetCart', 'GetCart'])
    expect(calls[1]!.query).not.toContain('gifts')
    expect(calls[3]!.query).not.toContain('discount_code')
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
  })

  it('a typed gift code brings its gift too, and taking the code off takes the gift out again', async () => {
    await ready()
    add(CREAM)
    await idle()

    await expect(Vio.applyDiscountCode(GIFT_CODE)).resolves.toMatchObject({ status: 'applied' })
    expect(linesNow()).toEqual([`${CREAM}×1`, `${MASK}×1`])

    await Vio.removeDiscountCode()
    await idle()
    expect(linesNow()).toEqual([`${CREAM}×1`])
    expect(serverLines()).toEqual([`${CREAM}×1`])
  })
})

describe('Vio.init({ discountCode }) — the page\'s code, without the shopper typing it', () => {
  it('the cart gets a line; then the code goes on, with the cart\'s channel key, and its gift is put in the cart', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    await idle()

    expect(ops()).toEqual(['CreateCart', 'AddItem', 'ApplyDiscount', 'AddItem', 'GetCart'])
    expect(calls[2]).toMatchObject({ key: 'key-484', variables: { cartId: cartIdNow(), code: GIFT_CODE } })
    // The gift: one unit of the product the code names, on the same cart and key.
    expect(calls[3]).toMatchObject({
      key: 'key-484',
      variables: { cartId: cartIdNow(), lineItems: [{ product_id: MASK, quantity: 1, variant_id: null }] },
    })
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe(GIFT_CODE)
    expect(linesNow()).toEqual([`${CREAM}×1`, `${MASK}×1`])
    expect(Vio.cart.getCart(FAVES)?.gifts).toEqual([{ productId: MASK, added: true }])

    // More lines afterwards: nothing about the code is asked again, and the gift is not added twice.
    calls = []
    add(CREAM)
    await idle()
    expect(ops()).toEqual(['AddItem'])
    expect(linesNow()).toEqual([`${CREAM}×2`, `${MASK}×1`])
  })

  it('what the cart costs: the gift keeps its list price and its discount, and the totals are what is paid', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    await idle()

    expect(lineOf(MASK)).toMatchObject({ unitPrice: 52, quantity: 1, discount: 52 })
    expect(lineOf(CREAM)).not.toHaveProperty('discount')
    expect(Vio.cart.subtotalForSponsor(FAVES)).toBe(401)
    expect(Vio.cart.discountForSponsor(FAVES)).toBe(52)
    expect(Vio.cart.totalForSponsor(FAVES)).toBe(349)
    expect(Vio.checkout.open(FAVES)).toMatchObject({ subtotal: 401, discount: 52 })
    Vio.checkout.close()
  })

  it('a percentage on the whole cart: every line says its share, and a tap on + keeps the totals right', async () => {
    await ready({ discountCode: 'TI' })
    add(CREAM)
    add(TINY)
    await idle()
    expect(lineOf(CREAM)).toMatchObject({ unitPrice: 349, discount: 34.9 })
    expect(lineOf(TINY)).toMatchObject({ unitPrice: 5, discount: 0.5 })
    expect(Vio.cart.totalForSponsor(FAVES)).toBe(318.6)

    Vio.cart.adjustQuantity(lineOf(CREAM)!.id, FAVES, +1)
    // At once, before the server answers: two creams, twice the amount off.
    expect(Vio.cart.totalForSponsor(FAVES)).toBe(632.7)
    await idle()
    expect(lineOf(CREAM)).toMatchObject({ quantity: 2, discount: 69.8 })
    expect(Vio.cart.totalForSponsor(FAVES)).toBe(632.7)
  })

  it('the shopper takes the gift out: it stays out for that cart', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    await idle()
    Vio.cart.removeItem(lineOf(MASK)!.id, FAVES)
    await idle()
    add(CREAM)
    await idle()
    await Vio.cart.refreshFromServer(FAVES)
    await idle()

    expect(linesNow()).toEqual([`${CREAM}×2`])
    expect(serverLines()).toEqual([`${CREAM}×2`])
    expect(count('ApplyDiscount')).toBe(1)
    expect(Vio.cart.getCart(FAVES)?.gifts).toEqual([{ productId: MASK, added: true, declined: true }])
  })

  it('the last line to pay for goes: the gift goes with it — a cart of the gift alone cannot be paid for', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    await idle()
    const cartId = cartIdNow()

    Vio.cart.removeItem(lineOf(CREAM)!.id, FAVES)
    // At once, not after the server answered: the shopper never sees a cart of the gift alone.
    expect(Vio.cart.getCart(FAVES)).toBeUndefined()
    await idle()
    expect(carts.get(cartId)).toEqual([])

    // The next cart starts over: code, then gift.
    add(CREAM)
    await idle()
    expect(linesNow()).toEqual([`${CREAM}×1`, `${MASK}×1`])
  })

  it('a gift the shopper put in the cart themselves is theirs: it is not added twice, nor taken out', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(MASK)
    add(CREAM)
    await idle()
    expect(linesNow()).toEqual([`${MASK}×1`, `${CREAM}×1`])
    expect(count('AddItem')).toBe(2)

    Vio.cart.removeItem(lineOf(CREAM)!.id, FAVES)
    await idle()
    expect(linesNow()).toEqual([`${MASK}×1`])
  })

  it('the gift cannot be added (not sold on this channel): the purchase goes on without it, and it is not tried again', async () => {
    gateway.unavailable.add(MASK)
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    await idle()
    add(CREAM)
    await idle()

    expect(linesNow()).toEqual([`${CREAM}×2`])
    expect(calls.filter((c) => c.op === 'AddItem' && c.variables.lineItems[0].product_id === MASK)).toHaveLength(1)
    await Vio.checkout.startVippsExpress(FAVES)
    expect(charged).toEqual([698])
  })

  it('a cart below the coupon\'s minimum: asked, refused, and asked again when the cart holds more', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(TINY)
    await idle()
    expect(count('ApplyDiscount')).toBe(1)
    expect(linesNow()).toEqual([`${TINY}×1`])
    await Vio.cart.refreshFromServer(FAVES)
    await idle()
    expect(count('ApplyDiscount')).toBe(1)

    add(TINY)
    await idle()
    expect(count('ApplyDiscount')).toBe(2)
    expect(linesNow()).toEqual([`${TINY}×2`, `${MASK}×1`])
  })

  it('the coupon is over in the brand\'s shop (COUPON_EXPIRED): nothing on screen, nothing asked twice, and the article keeps selling', async () => {
    gateway.expired.add(GIFT_CODE)
    const cartErrors = vi.fn()
    await ready({ discountCode: GIFT_CODE })
    Vio.cart.addEventListener('error', cartErrors)
    add(CREAM)
    await idle()
    add(CREAM)
    await idle()
    await Vio.cart.refreshFromServer(FAVES)
    const started = await Vio.checkout.startVippsExpress(FAVES)
    await idle()

    expect(started).toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(count('ApplyDiscount')).toBe(1)
    expect(charged).toEqual([698])
    expect(linesNow()).toEqual([`${CREAM}×2`])
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()
    // No `vio:cart-error`, no error event: a line in the console is all.
    expect(cartErrors).not.toHaveBeenCalled()
    Vio.cart.removeEventListener('error', cartErrors)
    // …and a later page load with the same cart does not ask the brand's shop again.
    expect(Vio.cart.getCart(FAVES)?.discountRefusal).toEqual({ code: GIFT_CODE, reason: 'COUPON_EXPIRED' })
    calls = []
    Vio.cart.ensureDiscountCodes()
    await idle()
    expect(ops()).toEqual([])
  })

  it('the server cart no longer carries the code (GetCart says so): the gift the SDK put in for it goes out, it would be paid for', async () => {
    await ready({ discountCode: 'FINNESIKKE' })
    add(CREAM)
    await idle()
    await Vio.applyDiscountCode(GIFT_CODE)
    await idle()
    expect(linesNow()).toEqual([`${CREAM}×1`, `${MASK}×1`])

    // Taken off behind this tab's back (the brand's shop, support, another device).
    cartCodes.delete(cartIdNow())
    await Vio.cart.refreshFromServer(FAVES)
    await idle()

    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()
    expect(Vio.cart.getCart(FAVES)).not.toHaveProperty('gifts')
    expect(linesNow()).toEqual([`${CREAM}×1`])
    expect(serverLines()).toEqual([`${CREAM}×1`])
  })

  it('a code Commerce does not know: asked once, and the purchase goes on', async () => {
    await ready({ discountCode: 'FINNESIKKE' })
    add(CREAM)
    await idle()
    await Vio.checkout.startVippsExpress(FAVES)
    expect(count('ApplyDiscount')).toBe(1)
    expect(charged).toEqual([349])
  })

  it('the carts the page opens with are asked at init, without a tap', async () => {
    const key = `surface-key-${++keySeq}`
    Vio.init({ apiKey: key, environment: 'testing' } as never)
    Vio.cart.clearAllCarts()
    Vio.checkout.close()
    await Vio.bootstrap()
    add(CREAM)
    await idle()
    calls = []

    // The next page of the visit names the campaign's code.
    Vio.init({ apiKey: key, environment: 'testing', discountCode: 'TI' } as never)
    await idle()

    expect(ops()).toEqual(['ApplyDiscount', 'GetCart'])
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
  })
})

describe('paying with a discount code on the cart', () => {
  it('Vipps Express straight from the product (add, then pay): code and gift are on the cart before the checkout and the payment exist', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    const started = await Vio.checkout.startVippsExpress(FAVES)

    expect(started).toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(count('ApplyDiscount')).toBe(1)
    expect(ops().indexOf('ApplyDiscount')).toBeLessThan(ops().indexOf('CreateCheckout'))
    // The gift's AddItem (the second one) comes before the checkout too.
    expect(ops().lastIndexOf('AddItem')).toBeLessThan(ops().indexOf('CreateCheckout'))
    expect(before('CreateCheckout', 'CreatePaymentVipps')).toBe(true)
    expect(serverLines()).toEqual([`${CREAM}×1`, `${MASK}×1`])
    // What Vipps charges: the cream — the mask is the gift.
    expect(charged).toEqual([349])
  })

  it('a checkout built from the cart (createCheckout): the code first', async () => {
    await ready({ discountCode: 'TI' })
    add(CREAM)
    await Vio.checkout.createCheckout(FAVES)
    expect(before('ApplyDiscount', 'CreateCheckout')).toBe(true)
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
  })

  it('ApplyDiscount fails as a call: the purchase goes on without the discount, asked twice at most', async () => {
    gateway.applyThrows = true
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    const started = await Vio.checkout.startVippsExpress(FAVES)

    expect(started).toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(charged).toEqual([349])
    expect(count('ApplyDiscount')).toBeLessThanOrEqual(2)
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()
    expect(linesNow()).toEqual([`${CREAM}×1`])
  })

  it(`the brand's shop is slow: the payment waits ${DISCOUNT_SETTLE_BUDGET_MS} ms for the page's code, then goes on without the gift — which stays out while it is being started`, async () => {
    await ready({ discountCode: GIFT_CODE })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let open!: () => void
    gateway.applyGate = new Promise<void>((resolve) => (open = resolve))
    add(CREAM)
    const starting = Vio.checkout.startVippsExpress(FAVES)
    let started: unknown
    void starting.then((res) => (started = res))

    await vi.advanceTimersByTimeAsync(DISCOUNT_SETTLE_BUDGET_MS - 50)
    expect(count('ApplyDiscount')).toBe(1)
    expect(count('CreateCheckout')).toBe(0)
    expect(started).toBeUndefined()

    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(charged).toEqual([349])

    // The brand's shop answers when the shopper is already on their way to Vipps: no line is added to a cart being paid.
    open()
    await vi.advanceTimersByTimeAsync(50)
    expect(serverLines()).toEqual([`${CREAM}×1`])
    expect(cartCodes.get(cartIdNow())).toBe(GIFT_CODE)
  })

  it('…and when that payment does not start after all, the gift it held back goes in the cart', async () => {
    await ready({ discountCode: GIFT_CODE })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let open!: () => void
    gateway.applyGate = new Promise<void>((resolve) => (open = resolve))
    gateway.vippsDown = true
    add(CREAM)
    const starting = Vio.checkout.startVippsExpress(FAVES)
    const failed = starting.then(
      () => null,
      (err: Error) => err.message,
    )
    await vi.advanceTimersByTimeAsync(DISCOUNT_SETTLE_BUDGET_MS + 50)
    await expect(failed).resolves.toMatch(/503/)
    expect(serverLines()).toEqual([`${CREAM}×1`])

    open()
    await vi.advanceTimersByTimeAsync(50)
    vi.useRealTimers()
    await idle()
    expect(linesNow()).toEqual([`${CREAM}×1`, `${MASK}×1`])
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe(GIFT_CODE)
  })

  it('a code the shopper typed is waited for, however long the brand\'s shop takes', async () => {
    await ready()
    add(CREAM)
    await idle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let open!: () => void
    gateway.applyGate = new Promise<void>((resolve) => (open = resolve))
    const applying = Vio.applyDiscountCode('TI')
    const starting = Vio.checkout.startVippsExpress(FAVES)

    await vi.advanceTimersByTimeAsync(DISCOUNT_SETTLE_BUDGET_MS * 3)
    expect(count('CreateCheckout')).toBe(0)
    open()
    await vi.advanceTimersByTimeAsync(50)
    await expect(applying).resolves.toMatchObject({ status: 'applied' })
    await expect(starting).resolves.toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(charged).toEqual([349 * 0.9])
  })

  it('the coupon ended after it went on the cart (COUPON_EXPIRED when the payment is started): the code and its gift come off, and the next attempt pays', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    await idle()
    expect(linesNow()).toEqual([`${CREAM}×1`, `${MASK}×1`])
    gateway.expired.add(GIFT_CODE)

    await expect(Vio.checkout.startVippsExpress(FAVES)).rejects.toThrow(/COUPON_EXPIRED/)
    await idle()

    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()
    expect(cartCodes.has(cartIdNow())).toBe(false)
    expect(linesNow()).toEqual([`${CREAM}×1`])
    expect(serverLines()).toEqual([`${CREAM}×1`])
    // Not asked for again on this cart, by a tap or by the page.
    const asked = count('ApplyDiscount')
    await expect(Vio.checkout.startVippsExpress(FAVES)).resolves.toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(count('ApplyDiscount')).toBe(asked)
    expect(charged).toEqual([349])
  })

  it('the cart fell under the coupon\'s minimum (COUPON_MIN_AMOUNT when the payment is started): code and gift come off — and come back when the cart holds enough again', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(TINY, 2)
    await idle()
    expect(linesNow()).toEqual([`${TINY}×2`, `${MASK}×1`])
    // One of the two goes: 5 kr is under the 10 kr the coupon asks for.
    Vio.cart.adjustQuantity(lineOf(TINY)!.id, FAVES, -1)
    await idle()

    await expect(Vio.checkout.startVippsExpress(FAVES)).rejects.toThrow(/COUPON_MIN_AMOUNT/)
    await idle()
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()
    expect(linesNow()).toEqual([`${TINY}×1`])
    expect(serverLines()).toEqual([`${TINY}×1`])
    // Asked for nothing more with the cart as it is…
    const asked = count('ApplyDiscount')
    await Vio.cart.refreshFromServer(FAVES)
    await expect(Vio.checkout.startVippsExpress(FAVES)).resolves.toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(count('ApplyDiscount')).toBe(asked)
    expect(charged).toEqual([5])

    // …and again when the cart holds more.
    Vio.cart.adjustQuantity(lineOf(TINY)!.id, FAVES, +1)
    await idle()
    expect(count('ApplyDiscount')).toBe(asked + 1)
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe(GIFT_CODE)
    expect(linesNow()).toEqual([`${TINY}×2`, `${MASK}×1`])
  })

  it('a gift line with two units (GIFT_MAX_ONE_UNIT): the payment does not start, and the cart is read again', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(MASK, 2)
    add(CREAM)
    await idle()
    calls = []

    await expect(Vio.checkout.startVippsExpress(FAVES)).rejects.toThrow(/GIFT_MAX_ONE_UNIT/)
    await idle()

    expect(charged).toEqual([])
    // The code is fine: it stays; the cart is the server's again.
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe(GIFT_CODE)
    expect(ops().lastIndexOf('GetCart')).toBeGreaterThan(ops().indexOf('CreatePaymentVipps'))
    expect(count('DeleteAppliedDiscount')).toBe(0)
  })
})

describe('a code the shopper typed, still being checked when they tap to pay', () => {
  /** The brand's shop answers when the test says. */
  function slowShop() {
    let open!: () => void
    gateway.applyGate = new Promise<void>((resolve) => (open = resolve))
    return () => {
      gateway.applyGate = null
      open()
    }
  }

  it('not taken: no payment is started — the shopper reads why first — and the next tap pays for the cart as it is', async () => {
    await ready()
    add(CREAM)
    await idle()
    const answer = slowShop()
    const typed = Vio.applyDiscountCode('FINNESIKKE', FAVES)
    await flush()
    let outcome: unknown = 'waiting'
    const starting = Vio.checkout.startVippsExpress(FAVES)
    void starting.then(
      (res) => (outcome = res),
      (err) => (outcome = err),
    )
    await flush()
    await flush()
    // Nothing is built on the cart while its code is being checked.
    expect(outcome).toBe('waiting')
    expect(count('CreateCheckout')).toBe(0)

    answer()
    await expect(typed).resolves.toMatchObject({ status: 'refused', reason: 'COUPON_NOT_FOUND' })
    await expect(starting).rejects.toThrow(/no payment started \[COUPON_NOT_FOUND\]$/)
    await idle()
    expect(count('CreateCheckout')).toBe(0)
    expect(count('CreatePaymentVipps')).toBe(0)
    expect(charged).toEqual([])
    expect(linesNow()).toEqual([`${CREAM}×1`])

    await expect(Vio.checkout.startVippsExpress(FAVES)).resolves.toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(charged).toEqual([349])
    // The refused code is not asked for again behind the shopper's back.
    expect(count('ApplyDiscount')).toBe(1)
  })

  it(`taken: the payment waits for it — well past the ${DISCOUNT_SETTLE_BUDGET_MS} ms a page's own code gets — and charges what the code leaves`, async () => {
    await ready()
    add(CREAM)
    await idle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const answer = slowShop()
    void Vio.applyDiscountCode('TI', FAVES)
    let started: unknown
    void Vio.checkout.startVippsExpress(FAVES).then((res) => (started = res))

    await vi.advanceTimersByTimeAsync(DISCOUNT_SETTLE_BUDGET_MS * 3)
    expect(started).toBeUndefined()
    expect(count('CreateCheckout')).toBe(0)

    answer()
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(before('ApplyDiscount', 'CreateCheckout')).toBe(true)
    expect(charged).toHaveLength(1)
    expect(charged[0]).toBeCloseTo(314.1)
  })

  it('refused because the page\'s own code is on the cart: that code stays, and the next tap pays with it', async () => {
    await ready({ discountCode: 'TI' })
    add(CREAM)
    await idle()
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
    const answer = slowShop()
    const typed = Vio.applyDiscountCode(GIFT_CODE, FAVES)
    await flush()
    const starting = Vio.checkout.startVippsExpress(FAVES)
    const refusedStart = expect(starting).rejects.toThrow(/\[COUPON_OTHER_APPLIED\]$/)
    answer()
    await expect(typed).resolves.toMatchObject({ status: 'refused', reason: 'COUPON_OTHER_APPLIED' })
    await refusedStart
    await idle()
    expect(count('DeleteAppliedDiscount')).toBe(0)
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')

    await Vio.checkout.startVippsExpress(FAVES)
    expect(charged).toHaveLength(1)
    expect(charged[0]).toBeCloseTo(314.1)
  })
})

describe('?vio_discount= in the URL', () => {
  it('is the page\'s code when the config names none — and stays for the tab', async () => {
    vi.stubGlobal('location', { href: 'https://host.example/a?vio_discount=TI', pathname: '/a', search: '?vio_discount=TI', host: 'host.example' })
    await ready()
    add(CREAM)
    await idle()
    expect(calls.find((c) => c.op === 'ApplyDiscount')?.variables).toMatchObject({ code: 'TI' })

    // The next page of the visit has no parameter: the tab remembers.
    vi.stubGlobal('location', { href: 'https://host.example/b', pathname: '/b', search: '', host: 'host.example' })
    await ready()
    add(CREAM)
    await idle()
    expect(calls.filter((c) => c.op === 'ApplyDiscount').map((c) => c.variables.code)).toEqual(['TI', 'TI'])
  })

  it('the config\'s code wins over it', async () => {
    vi.stubGlobal('location', { href: 'https://host.example/a?vio_discount=TI', pathname: '/a', search: '?vio_discount=TI', host: 'host.example' })
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    await idle()
    expect(calls.find((c) => c.op === 'ApplyDiscount')?.variables).toMatchObject({ code: GIFT_CODE })
  })
})

describe('a page without discount codes', () => {
  it('adds, reads and checks out with the calls it always made — none about discounts', async () => {
    await ready()
    add(CREAM)
    await Vio.cart.waitForCartMutations(FAVES)
    await Vio.cart.refreshFromServer(FAVES)
    await Vio.checkout.createCheckout(FAVES)
    await idle()

    expect(ops()).toEqual(['CreateCart', 'AddItem', 'GetCart', 'GetCart', 'CreateCheckout', 'UpdateCheckout'])
    for (const call of calls) expect(call.query).not.toMatch(/ApplyDiscount|DeleteAppliedDiscount/)
    expect(calls.filter((c) => c.op === 'GetCart').every((c) => !c.query.includes('discount_code'))).toBe(true)
    expect(Vio.cart.getCart(FAVES)).not.toHaveProperty('discountCode')
    expect(Vio.cart.getCart(FAVES)).not.toHaveProperty('gifts')
  })

  it('pays with Vipps Express with the calls it always made', async () => {
    await ready()
    add(CREAM)
    await Vio.checkout.startVippsExpress(FAVES)
    await idle()
    expect(ops()).toEqual(['CreateCart', 'AddItem', 'GetCart', 'CreateCheckout', 'UpdateCheckout', 'CreatePaymentVipps'])
    expect(charged).toEqual([349])
  })
})
