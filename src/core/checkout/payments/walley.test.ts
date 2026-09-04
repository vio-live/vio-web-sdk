import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createPaymentWalley,
  getWalleyOrder,
  renderWalleySnippet,
  walleyCleanHref,
  CREATE_PAYMENT_WALLEY_MUTATION,
  GET_WALLEY_ORDER_QUERY,
  WALLEY_PURCHASE_COMPLETED_EVENT,
} from './walley.js'
import { renderKustomSnippet, kustomCleanHref } from './kustom.js'
import * as cartQueries from '../../api/cart-queries.js'

describe('Walley Payment Module', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('defines CREATE_PAYMENT_WALLEY_MUTATION correctly', () => {
    expect(CREATE_PAYMENT_WALLEY_MUTATION).toContain('mutation CreatePaymentWalley')
    expect(CREATE_PAYMENT_WALLEY_MUTATION).toContain(
      'CreatePaymentWalley(checkout_id: $checkoutId, country_code: $countryCode, href: $href, email: $email)',
    )
    expect(CREATE_PAYMENT_WALLEY_MUTATION).toContain('html_snippet')
  })

  it('defines GET_WALLEY_ORDER_QUERY correctly (reads by OWNING CHECKOUT)', () => {
    expect(GET_WALLEY_ORDER_QUERY).toContain('query GetWalleyOrder')
    expect(GET_WALLEY_ORDER_QUERY).toContain('GetWalleyOrder(checkout_id: $checkoutId)')
    expect(GET_WALLEY_ORDER_QUERY).toContain('html_snippet')
  })

  it('createPaymentWalley unwraps Payment.CreatePaymentWalley', async () => {
    const order = {
      order_id: 'priv_123',
      status: 'Initialized',
      html_snippet: '<div></div>',
      public_token: 'pub_abc',
    }
    const spy = vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValue({
      data: { Payment: { CreatePaymentWalley: order } },
    } as never)
    const res = await createPaymentWalley(
      { checkoutId: 'chk_1', countryCode: 'SE', href: 'https://shop.example/page' },
      { commerceKey: 'k' },
    )
    expect(res).toEqual(order)
    expect(spy).toHaveBeenCalledWith(
      CREATE_PAYMENT_WALLEY_MUTATION,
      { checkoutId: 'chk_1', countryCode: 'SE', href: 'https://shop.example/page' },
      { commerceKey: 'k' },
    )
  })

  it('getWalleyOrder unwraps Payment.GetWalleyOrder and returns null on miss', async () => {
    const order = { order_id: 'priv_123', status: 'PurchaseCompleted', html_snippet: '<div></div>' }
    vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValue({
      data: { Payment: { GetWalleyOrder: order } },
    } as never)
    expect(await getWalleyOrder('chk_1')).toEqual(order)

    vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValue({ data: {} } as never)
    expect(await getWalleyOrder('chk_missing')).toBeNull()
  })

  it('shares the embed + href helpers with the Kustom module', () => {
    expect(renderWalleySnippet).toBe(renderKustomSnippet)
    expect(walleyCleanHref).toBe(kustomCleanHref)
  })

  it('exposes the purchase-completed DOM event name Walley dispatches', () => {
    expect(WALLEY_PURCHASE_COMPLETED_EVENT).toBe('walleyCheckoutPurchaseCompleted')
  })
})
