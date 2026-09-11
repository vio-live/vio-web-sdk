import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createPaymentNexi,
  getNexiOrder,
  updateNexiShipping,
  nexiCleanHref,
  isNexiPaid,
  nexiLanguageFor,
  nexiThemeFrom,
  rememberNexiPending,
  readNexiPending,
  clearNexiPending,
  nexiReturnPaymentId,
  NEXI_PENDING_KEY,
  CREATE_PAYMENT_NEXI_MUTATION,
  GET_NEXI_ORDER_QUERY,
  UPDATE_NEXI_SHIPPING_MUTATION,
} from './nexi.js'
import { kustomCleanHref } from './kustom.js'
import * as cartQueries from '../../api/cart-queries.js'

/** Minimal sessionStorage for node — the module only uses these three. */
function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    },
  } as Storage
}

describe('Nexi Payment Module', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    ;(globalThis as any).sessionStorage = fakeStorage()
  })
  afterEach(() => {
    delete (globalThis as any).sessionStorage
  })

  it('defines the GraphQL documents with the fields the widget needs (no html_snippet)', () => {
    expect(CREATE_PAYMENT_NEXI_MUTATION).toContain('mutation CreatePaymentNexi')
    expect(CREATE_PAYMENT_NEXI_MUTATION).toContain(
      'CreatePaymentNexi(checkout_id: $checkoutId, country_code: $countryCode, href: $href, email: $email)',
    )
    for (const f of ['checkout_key', 'checkout_js_url', 'order_id', 'status']) {
      expect(CREATE_PAYMENT_NEXI_MUTATION).toContain(f)
      expect(GET_NEXI_ORDER_QUERY).toContain(f)
    }
    expect(CREATE_PAYMENT_NEXI_MUTATION).not.toContain('html_snippet')
    expect(GET_NEXI_ORDER_QUERY).toContain('GetNexiOrder(checkout_id: $checkoutId)')
    expect(UPDATE_NEXI_SHIPPING_MUTATION).toContain(
      'UpdateNexiShipping(checkout_id: $checkoutId, country_code: $countryCode, postal_code: $postalCode)',
    )
  })

  it('createPaymentNexi unwraps Payment.CreatePaymentNexi', async () => {
    const order = {
      order_id: '886424d3c2164167b6dbf4e6c69084b6',
      status: 'Created',
      checkout_key: 'test-checkout-key-abc',
      checkout_js_url: 'https://test.checkout.dibspayment.eu/v1/checkout.js?v=1',
    }
    const spy = vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValue({
      data: { Payment: { CreatePaymentNexi: order } },
    } as never)
    const vars = { checkoutId: 'chk_1', countryCode: 'NO', href: 'https://shop.example/page' }
    expect(await createPaymentNexi(vars, { commerceKey: 'k' })).toEqual(order)
    expect(spy).toHaveBeenCalledWith(CREATE_PAYMENT_NEXI_MUTATION, vars, { commerceKey: 'k' })
  })

  it('getNexiOrder / updateNexiShipping unwrap and return null on a miss', async () => {
    vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValue({
      data: { Payment: { GetNexiOrder: { order_id: 'p1', status: 'Reserved' } } },
    } as never)
    expect(await getNexiOrder('chk_1')).toMatchObject({ status: 'Reserved' })

    vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValue({
      data: { Payment: { UpdateNexiShipping: { ok: false, reason: 'NO_SHIPPING', order_id: 'p1' } } },
    } as never)
    expect(await updateNexiShipping({ checkoutId: 'chk_1', countryCode: 'NOR' })).toEqual({
      ok: false,
      reason: 'NO_SHIPPING',
      order_id: 'p1',
    })

    vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValue({ data: {} } as never)
    expect(await getNexiOrder('chk_missing')).toBeNull()
  })

  it('shares the query-less href helper with Kustom', () => {
    expect(nexiCleanHref).toBe(kustomCleanHref)
  })

  it('treats Reserved and Charged as paid, nothing else', () => {
    expect(isNexiPaid('Reserved')).toBe(true)
    expect(isNexiPaid('Charged')).toBe(true)
    for (const s of ['Created', 'Cancelled', 'Terminated', 'Unknown', '', undefined, null]) {
      expect(isNexiPaid(s)).toBe(false)
    }
  })

  it('maps markets to Nexi language tags, en-GB otherwise', () => {
    expect(nexiLanguageFor('NO')).toBe('nb-NO')
    expect(nexiLanguageFor('se')).toBe('sv-SE')
    expect(nexiLanguageFor('DK')).toBe('da-DK')
    expect(nexiLanguageFor('FI')).toBe('fi-FI')
    expect(nexiLanguageFor('XX')).toBe('en-GB')
    expect(nexiLanguageFor(undefined)).toBe('en-GB')
  })

  it('maps Vio theme tokens to Nexi theme keys and drops non-px radii', () => {
    expect(nexiThemeFrom(undefined)).toBeUndefined()
    expect(nexiThemeFrom({})).toBeUndefined()
    expect(nexiThemeFrom({ accent: '#c14a3b', surface: '#fff', radiusMd: '8px' })).toEqual({
      primaryColor: '#c14a3b',
      panelColor: '#fff',
      buttonRadius: '8px',
    })
    expect(nexiThemeFrom({ accent: '#000', radiusMd: '0.5rem' })).toEqual({ primaryColor: '#000' })
  })

  it('remembers, reads and clears the pending session, ignoring stale ones', () => {
    expect(readNexiPending()).toBeNull()
    rememberNexiPending({ checkoutId: 'chk_1', sponsorId: 7, paymentId: 'p1' })
    expect(readNexiPending()).toMatchObject({ checkoutId: 'chk_1', sponsorId: 7, paymentId: 'p1' })
    // Older than Nexi's 48 h session → treated as gone.
    ;(globalThis as any).sessionStorage.setItem(
      NEXI_PENDING_KEY,
      JSON.stringify({ checkoutId: 'chk_1', sponsorId: 7, paymentId: 'p1', createdAt: Date.now() - 49 * 3600 * 1000 }),
    )
    expect(readNexiPending()).toBeNull()
    rememberNexiPending({ checkoutId: 'chk_2', sponsorId: 7, paymentId: 'p2' })
    clearNexiPending()
    expect(readNexiPending()).toBeNull()
  })

  it('survives a missing sessionStorage', () => {
    delete (globalThis as any).sessionStorage
    expect(() => rememberNexiPending({ checkoutId: 'c', sponsorId: 1, paymentId: 'p' })).not.toThrow()
    expect(readNexiPending()).toBeNull()
    expect(() => clearNexiPending()).not.toThrow()
  })

  it('reads the ?paymentId= Nexi appends on a third-party return, and only a real one', () => {
    expect(nexiReturnPaymentId('?paymentId=886424d3c2164167b6dbf4e6c69084b6')).toBe(
      '886424d3c2164167b6dbf4e6c69084b6',
    )
    expect(nexiReturnPaymentId('?paymentId=<script>')).toBeNull()
    expect(nexiReturnPaymentId('?utm_source=x')).toBeNull()
    expect(nexiReturnPaymentId('')).toBeNull()
  })
})
