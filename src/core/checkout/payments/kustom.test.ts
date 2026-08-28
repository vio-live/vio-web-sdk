import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createPaymentKustom,
  getKustomOrder,
  kustomCleanHref,
  CREATE_PAYMENT_KUSTOM_MUTATION,
  GET_KUSTOM_ORDER_QUERY,
} from './kustom.js'
import * as cartQueries from '../../api/cart-queries.js'

// Node-env suite (repo has no DOM test environment): covers the GraphQL
// wrappers and the query-less href contract. renderKustomSnippet's script
// re-execution is exercised in the staging E2E pass instead.
describe('Kustom Payment Module', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
  })

  it('defines CREATE_PAYMENT_KUSTOM_MUTATION correctly', () => {
    expect(CREATE_PAYMENT_KUSTOM_MUTATION).toContain('mutation CreatePaymentKustom')
    expect(CREATE_PAYMENT_KUSTOM_MUTATION).toContain(
      'CreatePaymentKustom(checkout_id: $checkoutId, country_code: $countryCode, href: $href, email: $email)',
    )
    expect(CREATE_PAYMENT_KUSTOM_MUTATION).toContain('html_snippet')
  })

  it('defines GET_KUSTOM_ORDER_QUERY correctly', () => {
    expect(GET_KUSTOM_ORDER_QUERY).toContain('query GetKustomOrder')
    expect(GET_KUSTOM_ORDER_QUERY).toContain('GetKustomOrder(order_id: $orderId)')
    expect(GET_KUSTOM_ORDER_QUERY).toContain('html_snippet')
  })

  it('createPaymentKustom unwraps Payment.CreatePaymentKustom', async () => {
    const order = { order_id: 'kco_1', status: 'checkout_incomplete', html_snippet: '<div></div>' }
    const spy = vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValue({
      data: { Payment: { CreatePaymentKustom: order } },
    } as never)
    const res = await createPaymentKustom(
      { checkoutId: 'chk_1', countryCode: 'NO', href: 'https://shop.example/page' },
      { commerceKey: 'k' },
    )
    expect(res).toEqual(order)
    expect(spy).toHaveBeenCalledWith(
      CREATE_PAYMENT_KUSTOM_MUTATION,
      { checkoutId: 'chk_1', countryCode: 'NO', href: 'https://shop.example/page' },
      { commerceKey: 'k' },
    )
  })

  it('getKustomOrder unwraps Payment.GetKustomOrder and returns null on miss', async () => {
    const order = { order_id: 'kco_1', status: 'checkout_complete', html_snippet: '<div></div>' }
    vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValue({
      data: { Payment: { GetKustomOrder: order } },
    } as never)
    expect(await getKustomOrder('kco_1')).toEqual(order)

    vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValue({ data: {} } as never)
    expect(await getKustomOrder('kco_missing')).toBeNull()
  })

  it('kustomCleanHref strips the query string (shopcart appends ?order_id=…)', () => {
    ;(globalThis as Record<string, unknown>).window = {
      location: {
        origin: 'https://shop.example',
        pathname: '/artikkel/sofa-guide',
        search: '?utm_source=x&vio_debug=1',
      },
    }
    expect(kustomCleanHref()).toBe('https://shop.example/artikkel/sofa-guide')
  })

  it('kustomCleanHref returns empty string without a window (SSR)', () => {
    expect(kustomCleanHref()).toBe('')
  })
})
