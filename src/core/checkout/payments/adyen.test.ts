import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ADYEN_RETURN_QUERY_KEYS,
  ADYEN_WEB_VERSION,
  AdyenOriginError,
  CONFIRM_ADYEN_PAYMENT_MUTATION,
  CREATE_PAYMENT_ADYEN_MUTATION,
  GET_ADYEN_PAYMENT_QUERY,
  adyenAssetUrls,
  adyenReturnOutcome,
  adyenReturnParams,
  confirmAdyenPayment,
  createPaymentAdyen,
  getAdyenPayment,
  loadAdyenWeb,
  mountAdyen,
  type AdyenSession,
} from './adyen.js'
import * as cartQueries from '../../api/cart-queries.js'

const session = (over: Partial<AdyenSession> = {}): AdyenSession => ({
  order_id: 'CS123',
  session_id: 'CS123',
  session_data: 'DATA',
  client_key: 'test_ABC',
  environment: 'test',
  country_code: 'NO',
  shopper_locale: 'no-NO',
  purchase_currency: 'NOK',
  amount: 519800,
  total_price: 5198,
  ...over,
})

/** Just enough DOM for the loader: a head that records what is appended. */
function fakeDocument() {
  const appended: any[] = []
  const head = {
    appendChild: (el: any) => {
      appended.push(el)
      return el
    },
    querySelector: (sel: string) =>
      appended.find((el) => el.tag === 'link' && sel.includes(el.attrs?.['data-vio-adyen'] ?? '§')) ?? null,
  }
  const createElement = (tag: string) => {
    const el: any = { tag, attrs: {}, setAttribute: (k: string, v: string) => (el.attrs[k] = v) }
    return el
  }
  return { doc: { head, createElement }, appended }
}

describe('Adyen payment module', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    delete (globalThis as any).document
    delete (globalThis as any).AdyenWeb
    delete (globalThis as any).__vioAdyenWeb
  })

  it('asks the gateway for everything Drop-in is created with — and nothing secret', () => {
    expect(CREATE_PAYMENT_ADYEN_MUTATION).toContain(
      'CreatePaymentAdyen(checkout_id: $checkoutId, return_url: $returnUrl, country_code: $countryCode, channel: $channel, email: $email, client: $client)',
    )
    for (const f of ['session_id', 'session_data', 'client_key', 'environment', 'shopper_locale', 'amount', 'total_price']) {
      expect(CREATE_PAYMENT_ADYEN_MUTATION).toContain(f)
    }
    expect(CREATE_PAYMENT_ADYEN_MUTATION).not.toMatch(/api_?key|hmac/i)
    expect(GET_ADYEN_PAYMENT_QUERY).toContain(
      'GetAdyenPayment(checkout_id: $checkoutId, session_result: $sessionResult, redirect_result: $redirectResult)',
    )
    expect(GET_ADYEN_PAYMENT_QUERY).toContain('order_created')
    expect(CONFIRM_ADYEN_PAYMENT_MUTATION).toContain('ConfirmAdyenPayment(checkout_id: $checkoutId, session_id: $sessionId)')
  })

  it('unwraps the three operations and answers null on a miss', async () => {
    const spy = vi.spyOn(cartQueries, 'executeCartGraphQL')
    spy.mockResolvedValueOnce({ data: { Payment: { CreatePaymentAdyen: session() } } } as never)
    expect((await createPaymentAdyen({ checkoutId: 'c', returnUrl: 'https://x' }))?.session_id).toBe('CS123')
    spy.mockResolvedValueOnce({ data: { Payment: { GetAdyenPayment: { order_id: 'CS123', status: 'authorised', order_created: false } } } } as never)
    expect((await getAdyenPayment({ checkoutId: 'c', redirectResult: 'R' }))?.status).toBe('authorised')
    expect(spy).toHaveBeenLastCalledWith(GET_ADYEN_PAYMENT_QUERY, { checkoutId: 'c', redirectResult: 'R' }, undefined)
    spy.mockResolvedValueOnce({ data: { Payment: { ConfirmAdyenPayment: { ok: false, reason: 'AMOUNT_CHANGED' } } } } as never)
    expect(await confirmAdyenPayment({ checkoutId: 'c', sessionId: 'CS123' })).toEqual({ ok: false, reason: 'AMOUNT_CHANGED' })
    spy.mockResolvedValueOnce({ data: {} } as never)
    expect(await createPaymentAdyen({ checkoutId: 'c', returnUrl: 'https://x' })).toBeNull()
  })

  it("loads Adyen Web from Adyen's CDN for the session's environment, pinned", () => {
    expect(adyenAssetUrls('test').js).toBe(
      `https://checkoutshopper-test.cdn.adyen.com/checkoutshopper/sdk/${ADYEN_WEB_VERSION}/adyen.js`,
    )
    expect(adyenAssetUrls('live').css).toBe(
      `https://checkoutshopper-live.cdn.adyen.com/checkoutshopper/sdk/${ADYEN_WEB_VERSION}/adyen.css`,
    )
    // An unknown value never builds a host name out of thin air.
    expect(adyenAssetUrls('evil.example/x?').js).toContain('checkoutshopper-test.cdn.adyen.com')
  })

  it('injects script AND stylesheet with Subresource Integrity, once per environment', async () => {
    const { doc, appended } = fakeDocument()
    ;(globalThis as any).document = doc
    const first = loadAdyenWeb('test')
    const second = loadAdyenWeb('test')
    expect(second).toBe(first) // memoised while in flight
    const link = appended.find((el) => el.tag === 'link')
    const script = appended.find((el) => el.tag === 'script')
    expect(link).toMatchObject({ rel: 'stylesheet', crossOrigin: 'anonymous' })
    expect(link.integrity).toMatch(/^sha384-/)
    expect(script.integrity).toMatch(/^sha384-/)
    expect(script.crossOrigin).toBe('anonymous')
    ;(globalThis as any).AdyenWeb = { AdyenCheckout: () => undefined, Dropin: class {} }
    script.onload()
    await expect(first).resolves.toBeUndefined()
    expect(appended.filter((el) => el.tag === 'script')).toHaveLength(1)
  })

  it('a script that loads without AdyenWeb, or does not load, is an error — and can be retried', async () => {
    const { doc, appended } = fakeDocument()
    ;(globalThis as any).document = doc
    const broken = loadAdyenWeb('test')
    appended.find((el) => el.tag === 'script').onload()
    await expect(broken).rejects.toThrow(/AdyenWeb/)
    const blocked = loadAdyenWeb('test')
    expect(blocked).not.toBe(broken) // a failed load is not remembered
    appended.filter((el) => el.tag === 'script')[1].onerror()
    await expect(blocked).rejects.toThrow(/could not load/)
    // The stylesheet is only ever added once.
    expect(appended.filter((el) => el.tag === 'link')).toHaveLength(1)
  })

  describe('mountAdyen', () => {
    let config: any
    let dropinConfig: any
    const container: any = { style: { setProperty: vi.fn() } }
    const unmount = vi.fn()

    beforeEach(() => {
      const { doc } = fakeDocument()
      ;(globalThis as any).document = doc
      ;(globalThis as any).__vioAdyenWeb = adyenAssetUrls('test').js
      ;(globalThis as any).AdyenWeb = {
        AdyenCheckout: vi.fn(async (c: any) => {
          config = c
          return { core: true }
        }),
        Dropin: class {
          constructor(_checkout: unknown, c: unknown) {
            dropinConfig = c
          }
          mount() {
            return { unmount }
          }
        },
      }
    })

    const handlers = (before: () => Promise<boolean> = async () => true) => ({
      onBeforePay: vi.fn(before),
      onCompleted: vi.fn(),
      onFailed: vi.fn(),
      onError: vi.fn(),
    })

    it('creates Drop-in on the session, in the locale and environment the backend chose', async () => {
      const handle = await mountAdyen(container, session(), handlers(), { theme: { accent: '#c14a3b', radiusMd: '6px' } })
      expect(config).toMatchObject({
        session: { id: 'CS123', sessionData: 'DATA' },
        clientKey: 'test_ABC',
        environment: 'test',
        locale: 'no-NO',
        countryCode: 'NO',
        amount: { value: 519800, currency: 'NOK' },
      })
      expect(dropinConfig).toMatchObject({ disableFinalAnimation: true })
      expect(container.style.setProperty).toHaveBeenCalledWith('--adyen-sdk-border-radius-m', '6px')
      expect(handle.sessionId).toBe('CS123')
      handle.unmount()
      expect(unmount).toHaveBeenCalled()
    })

    it('"Pay" only goes through when the backend confirms the session', async () => {
      const h = handlers(async () => false)
      await mountAdyen(container, session(), h)
      const actions = { resolve: vi.fn(), reject: vi.fn() }
      await config.beforeSubmit({ paymentMethod: {} }, {}, actions)
      expect(actions.reject).toHaveBeenCalled()
      expect(actions.resolve).not.toHaveBeenCalled()

      const ok = handlers(async () => true)
      await mountAdyen(container, session(), ok)
      const go = { resolve: vi.fn(), reject: vi.fn() }
      await config.beforeSubmit({ paymentMethod: { type: 'vipps' } }, {}, go)
      expect(go.resolve).toHaveBeenCalledWith({ paymentMethod: { type: 'vipps' } })
    })

    it('a confirmation that fails to answer stops the payment — never "pay anyway"', async () => {
      const h = handlers(async () => {
        throw new Error('network')
      })
      await mountAdyen(container, session(), h)
      const actions = { resolve: vi.fn(), reject: vi.fn() }
      await config.beforeSubmit({}, {}, actions)
      expect(actions.reject).toHaveBeenCalled()
      expect(actions.resolve).not.toHaveBeenCalled()
    })

    it('refuses a second submit while the first is in flight (Enter + click)', async () => {
      let release!: (v: boolean) => void
      const h = handlers(() => new Promise<boolean>((r) => (release = r)))
      await mountAdyen(container, session(), h)
      const first = { resolve: vi.fn(), reject: vi.fn() }
      const second = { resolve: vi.fn(), reject: vi.fn() }
      const inFlight = config.beforeSubmit({}, {}, first)
      await config.beforeSubmit({}, {}, second)
      expect(second.reject).toHaveBeenCalled()
      expect(h.onBeforePay).toHaveBeenCalledTimes(1)
      release(true)
      await inFlight
      expect(first.resolve).toHaveBeenCalled()
    })

    it('hands completion and failure to the caller', async () => {
      const h = handlers()
      await mountAdyen(container, session(), h)
      config.onPaymentCompleted({ resultCode: 'Authorised', sessionResult: 'SR' })
      expect(h.onCompleted).toHaveBeenCalledWith({ resultCode: 'Authorised', sessionResult: 'SR' })
      config.onPaymentFailed({ resultCode: 'Refused' })
      expect(h.onFailed).toHaveBeenCalledWith({ resultCode: 'Refused' })
    })

    it('names the real cause when the page is not an allowed origin', async () => {
      ;(globalThis as any).AdyenWeb.AdyenCheckout = vi.fn(async () => {
        throw new Error('Invalid client key or unknown origin')
      })
      ;(globalThis as any).location = { origin: 'https://www.vg.no' }
      await expect(mountAdyen(container, session(), handlers())).rejects.toBeInstanceOf(AdyenOriginError)
      await expect(mountAdyen(container, session(), handlers())).rejects.toThrow(/https:\/\/www\.vg\.no.*Allowed origins/)
      delete (globalThis as any).location
    })

    it('refuses a session it could not pay with', async () => {
      await expect(mountAdyen(container, session({ session_data: '' }), handlers())).rejects.toThrow(/missing/)
    })
  })

  it('reads a return ONLY when Adyen appended a redirectResult', () => {
    expect(adyenReturnParams('?vio_method=adyen&checkout_id=c&sessionId=CS1&redirectResult=X6Xt%21Y')).toEqual({
      redirectResult: 'X6Xt!Y',
      sessionId: 'CS1',
    })
    // Our own params alone are not a return: nothing to finalise, nothing resumed.
    expect(adyenReturnParams('?vio_method=adyen&checkout_id=c')).toBeNull()
    expect(adyenReturnParams('')).toBeNull()
    for (const k of ['redirectResult', 'sessionId', 'checkout_id', 'vio_method']) {
      expect(ADYEN_RETURN_QUERY_KEYS).toContain(k)
    }
  })

  it("maps Adyen's outcome to paid / failed / pending — unknown is never \"pay again\"", () => {
    const p = (status: string) => ({ order_id: 'CS', status, order_created: false })
    expect(adyenReturnOutcome(p('authorised'))).toBe('paid')
    expect(adyenReturnOutcome(p('refused'))).toBe('failed')
    expect(adyenReturnOutcome(p('cancelled'))).toBe('failed')
    expect(adyenReturnOutcome(p('error'))).toBe('failed')
    expect(adyenReturnOutcome(p('pending'))).toBe('pending')
    expect(adyenReturnOutcome(p('unknown'))).toBe('pending')
    expect(adyenReturnOutcome(null)).toBe('pending')
  })
})
