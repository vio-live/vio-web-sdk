import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createPaymentQliro,
  getQliroOrder,
  renderQliroSnippet,
  qliroCleanHref,
  CREATE_PAYMENT_QLIRO_MUTATION,
  GET_QLIRO_ORDER_QUERY,
} from './qliro.js'
import { renderKustomSnippet, kustomCleanHref } from './kustom.js'
import * as cartQueries from '../../api/cart-queries.js'

describe('Qliro Payment Module', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('defines CREATE_PAYMENT_QLIRO_MUTATION correctly', () => {
    expect(CREATE_PAYMENT_QLIRO_MUTATION).toContain('mutation CreatePaymentQliro')
    expect(CREATE_PAYMENT_QLIRO_MUTATION).toContain(
      'CreatePaymentQliro(checkout_id: $checkoutId, country_code: $countryCode, href: $href, email: $email)',
    )
    expect(CREATE_PAYMENT_QLIRO_MUTATION).toContain('html_snippet')
  })

  it('defines GET_QLIRO_ORDER_QUERY correctly (reads by OWNING CHECKOUT)', () => {
    expect(GET_QLIRO_ORDER_QUERY).toContain('query GetQliroOrder')
    expect(GET_QLIRO_ORDER_QUERY).toContain('GetQliroOrder(checkout_id: $checkoutId)')
    expect(GET_QLIRO_ORDER_QUERY).toContain('html_snippet')
  })

  it('createPaymentQliro unwraps Payment.CreatePaymentQliro', async () => {
    const order = { order_id: '12345', status: 'InProcess', html_snippet: '<div></div>' }
    const spy = vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValue({
      data: { Payment: { CreatePaymentQliro: order } },
    } as never)
    const res = await createPaymentQliro(
      { checkoutId: 'chk_1', countryCode: 'SE', href: 'https://shop.example/page' },
      { commerceKey: 'k' },
    )
    expect(res).toEqual(order)
    expect(spy).toHaveBeenCalledWith(
      CREATE_PAYMENT_QLIRO_MUTATION,
      { checkoutId: 'chk_1', countryCode: 'SE', href: 'https://shop.example/page' },
      { commerceKey: 'k' },
    )
  })

  it('getQliroOrder unwraps Payment.GetQliroOrder and returns null on miss', async () => {
    const order = { order_id: '12345', status: 'Completed', html_snippet: '<div></div>' }
    vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValue({
      data: { Payment: { GetQliroOrder: order } },
    } as never)
    expect(await getQliroOrder('chk_1')).toEqual(order)

    vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValue({ data: {} } as never)
    expect(await getQliroOrder('chk_missing')).toBeNull()
  })

  it('shares the embed + href helpers with the Kustom module', () => {
    // Same script-executing injection and query-less-href contract — one
    // implementation, two providers.
    expect(renderQliroSnippet).toBe(renderKustomSnippet)
    expect(qliroCleanHref).toBe(kustomCleanHref)
  })
})
