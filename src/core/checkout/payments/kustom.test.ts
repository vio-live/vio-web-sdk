import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createPaymentKustom,
  getKustomOrder,
  syncPaymentKustom,
  kustomCleanHref,
  kustomApi,
  suspendKustom,
  resumeKustom,
  installKustomListeners,
  kustomReturnOutcome,
  KUSTOM_RETURN_QUERY_KEYS,
  CREATE_PAYMENT_KUSTOM_MUTATION,
  GET_KUSTOM_ORDER_QUERY,
  SYNC_PAYMENT_KUSTOM_MUTATION,
} from './kustom.js'
import * as cartQueries from '../../api/cart-queries.js'

// Node-env suite (the DOM behaviour lives in vio-checkout.kustom.dom.test.ts):
// the GraphQL wrappers, the query-less href contract, the widget's JS API
// wrapper and the return-trip parser.
describe('Kustom Payment Module', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
  })

  it('every operation selects the normalized order — snippet, totals, checkout, order_created', () => {
    expect(CREATE_PAYMENT_KUSTOM_MUTATION).toContain('mutation CreatePaymentKustom')
    expect(CREATE_PAYMENT_KUSTOM_MUTATION).toContain(
      'CreatePaymentKustom(checkout_id: $checkoutId, country_code: $countryCode, href: $href, email: $email, client: $client)',
    )
    expect(GET_KUSTOM_ORDER_QUERY).toContain('GetKustomOrder(order_id: $orderId)')
    expect(SYNC_PAYMENT_KUSTOM_MUTATION).toContain('SyncPaymentKustom(checkout_id: $checkoutId)')
    for (const doc of [CREATE_PAYMENT_KUSTOM_MUTATION, GET_KUSTOM_ORDER_QUERY, SYNC_PAYMENT_KUSTOM_MUTATION]) {
      for (const field of ['html_snippet', 'total_price', 'shipping_price', 'checkout_id', 'order_created', 'reference']) {
        expect(doc).toContain(field)
      }
    }
  })

  it('createPaymentKustom unwraps Payment.CreatePaymentKustom', async () => {
    const order = { order_id: 'kco_1', status: 'checkout_incomplete', html_snippet: '<div></div>' }
    const spy = vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValue({
      data: { Payment: { CreatePaymentKustom: order } },
    } as any)
    const result = await createPaymentKustom(
      { checkoutId: 'chk_1', countryCode: 'NO', href: 'https://vg.no/article', email: 'a@b.no', client: 'web-sdk 0.14.0' },
      { apiKey: 'k' } as any,
    )
    expect(result).toEqual(order)
    expect(spy).toHaveBeenCalledWith(
      CREATE_PAYMENT_KUSTOM_MUTATION,
      { checkoutId: 'chk_1', countryCode: 'NO', href: 'https://vg.no/article', email: 'a@b.no', client: 'web-sdk 0.14.0' },
      { apiKey: 'k' },
    )
  })

  it('getKustomOrder / syncPaymentKustom unwrap, and answer null on a miss', async () => {
    const spy = vi.spyOn(cartQueries, 'executeCartGraphQL')
    spy.mockResolvedValueOnce({ data: { Payment: { GetKustomOrder: { order_id: 'kco_1', status: 'checkout_complete', html_snippet: 'r' } } } } as any)
    expect((await getKustomOrder('kco_1'))?.status).toBe('checkout_complete')
    spy.mockResolvedValueOnce({ data: { Payment: { SyncPaymentKustom: { order_id: 'kco_1', status: 'checkout_incomplete', html_snippet: 's', total_price: 5198 } } } } as any)
    expect((await syncPaymentKustom('chk_1'))?.total_price).toBe(5198)
    expect(spy).toHaveBeenLastCalledWith(SYNC_PAYMENT_KUSTOM_MUTATION, { checkoutId: 'chk_1' }, undefined)
    spy.mockResolvedValueOnce({ errors: [{ message: 'x' }] } as any)
    expect(await getKustomOrder('nope')).toBeNull()
  })

  it('kustomCleanHref strips the query and the hash (shopcart appends its own)', () => {
    ;(globalThis as any).window = { location: { origin: 'https://vg.no', pathname: '/a/b' } }
    expect(kustomCleanHref()).toBe('https://vg.no/a/b')
    delete (globalThis as any).window
    expect(kustomCleanHref()).toBe('')
  })

  describe("the widget's JavaScript API", () => {
    it('suspend/resume do nothing before the snippet has defined the API', () => {
      ;(globalThis as any).window = {}
      expect(kustomApi()).toBeNull()
      expect(suspendKustom()).toBe(false)
      expect(resumeKustom()).toBe(false)
    })

    it('listeners reach the widget through _klarnaCheckout, and are disarmed on destroy', () => {
      const calls: string[] = []
      let registered: Record<string, (d: any) => void> = {}
      ;(globalThis as any).window = {
        _klarnaCheckout: (cb: (api: any) => void) =>
          cb({
            suspend: () => calls.push('suspend'),
            resume: () => calls.push('resume'),
            on: (l: any) => {
              registered = l
            },
          }),
      }
      const totals: number[] = []
      const shipping: any[] = []
      let cannot = 0
      const controller = installKustomListeners({
        onOrderTotalChange: (t) => totals.push(t),
        onShippingOptionChange: (o) => shipping.push(o),
        onCannotComplete: () => cannot++,
      })
      expect(suspendKustom()).toBe(true)
      expect(resumeKustom()).toBe(true)
      expect(calls).toEqual(['suspend', 'resume'])

      registered.order_total_change!({ order_total: 519800 })
      registered.order_total_change!({ order_total: 'nope' })
      registered.shipping_option_change!({ id: 'standard', name: 'Standard', price: 19900 })
      registered.can_not_complete_order!({})
      expect(totals).toEqual([519800])
      expect(shipping).toEqual([{ id: 'standard', name: 'Standard', price: 19900 }])
      expect(cannot).toBe(1)

      // Kustom has no `off`: a torn-down widget must not drive a dead summary.
      controller.destroy()
      registered.order_total_change!({ order_total: 1 })
      registered.can_not_complete_order!({})
      expect(totals).toEqual([519800])
      expect(cannot).toBe(1)
    })
  })

  describe('the return trip', () => {
    it("recognises Kustom's confirmation and our own rejection, and nothing else", () => {
      expect(kustomReturnOutcome(new URLSearchParams('order_id=KCO1&payment_processor=KUSTOM&checkout_id=CHK1'))).toEqual({
        kind: 'confirmation', orderId: 'KCO1', checkoutId: 'CHK1',
      })
      expect(kustomReturnOutcome(new URLSearchParams('vio_payment=rejected&vio_method=kustom&checkout_id=CHK1'))).toEqual({
        kind: 'rejected', checkoutId: 'CHK1',
      })
      expect(kustomReturnOutcome(new URLSearchParams('order_id=KCO1&payment_processor=QLIRO'))).toBeNull()
      expect(kustomReturnOutcome(new URLSearchParams('order_id=KCO1'))).toBeNull()
      expect(kustomReturnOutcome(new URLSearchParams('vio_payment=rejected&vio_method=adyen'))).toBeNull()
      expect([...KUSTOM_RETURN_QUERY_KEYS]).toEqual(['order_id', 'payment_processor', 'checkout_id', 'vio_payment', 'vio_method'])
    })
  })
})
