import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createPaymentVipps,
  getVippsStatus,
  CREATE_PAYMENT_VIPPS_MUTATION,
  GET_VIPPS_STATUS_QUERY,
} from './vipps.js'
import * as cartQueries from '../../api/cart-queries.js'

describe('Vipps Payment Module', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('should define CREATE_PAYMENT_VIPPS_MUTATION correctly', () => {
    expect(CREATE_PAYMENT_VIPPS_MUTATION).toContain('mutation CreatePaymentVipps')
    expect(CREATE_PAYMENT_VIPPS_MUTATION).toContain(
      'CreatePaymentVipps(checkout_id: $checkoutId, email: $email, return_url: $returnUrl)',
    )
    expect(CREATE_PAYMENT_VIPPS_MUTATION).toContain('payment_url')
  })

  it('should define GET_VIPPS_STATUS_QUERY correctly', () => {
    expect(GET_VIPPS_STATUS_QUERY).toContain('query GetVippsStatus')
    expect(GET_VIPPS_STATUS_QUERY).toContain('GetVippsStatus(checkout_id: $checkoutId)')
    expect(GET_VIPPS_STATUS_QUERY).toContain('state')
  })

  it('createPaymentVipps calls executeCartGraphQL with mutation and variables', async () => {
    const mockPaymentUrl = 'https://pay-mt.vipps.no/?token=test_token'
    const spy = vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValueOnce({
      data: {
        Payment: {
          CreatePaymentVipps: {
            payment_url: mockPaymentUrl,
          },
        },
      },
    })

    const result = await createPaymentVipps({
      checkoutId: 'chk_123',
      email: 'test@example.com',
      returnUrl: 'https://example.com/return',
    })

    expect(spy).toHaveBeenCalledWith(
      CREATE_PAYMENT_VIPPS_MUTATION,
      {
        checkoutId: 'chk_123',
        email: 'test@example.com',
        returnUrl: 'https://example.com/return',
      },
      undefined,
    )
    expect(result).toEqual({ payment_url: mockPaymentUrl })
  })

  it('getVippsStatus calls executeCartGraphQL with query and variables', async () => {
    const spy = vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValueOnce({
      data: {
        Payment: {
          GetVippsStatus: {
            state: 'CREATED',
          },
        },
      },
    })

    const result = await getVippsStatus({ checkoutId: 'chk_123' })

    expect(spy).toHaveBeenCalledWith(GET_VIPPS_STATUS_QUERY, { checkoutId: 'chk_123' }, undefined)
    expect(result).toEqual({ state: 'CREATED' })
  })
})
