/**
 * The page's discount code and a checkout: before a checkout is created or a
 * payment started, the manager lets the cart settle its code — and the gift
 * it brings — (`CartManager.settleDiscountCode`), for a bounded time, between
 * the cart's own mutations and the read of the server's lines. A payment
 * Commerce refuses because of the discount puts the cart right for the next
 * attempt (`discountRefusedAtPayment`); any payment that does not start gives
 * back the gift it held (`releaseGiftHold`). A cart manager that knows nothing
 * of discounts (a host's own, a test's stub) is asked nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])
const vipps = vi.hoisted(() => ({ answer: async (): Promise<unknown> => ({ payment_url: 'https://vipps.test/pay' }) }))

vi.mock('../api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCartGraphQLOptions: vi.fn(async () => ({})),
  createCheckout: vi.fn(async () => {
    calls.push('CreateCheckout')
    return { id: 'CHK-1' }
  }),
  updateCheckout: vi.fn(async (vars: { checkoutId: string }) => {
    calls.push('UpdateCheckout')
    return { id: vars.checkoutId }
  }),
}))

vi.mock('./payments/vipps.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPaymentVipps: vi.fn(async () => {
    calls.push('CreatePaymentVipps')
    return vipps.answer()
  }),
}))

import { CheckoutManager, DISCOUNT_SETTLE_BUDGET_MS } from './checkout-manager.js'

function cart(extra: Record<string, unknown> = {}) {
  return {
    waitForCartMutations: vi.fn(async () => {
      calls.push('waitForCartMutations')
    }),
    settleDiscountCode: vi.fn(async () => {
      calls.push('settleDiscountCode')
    }),
    refreshFromServer: vi.fn(async () => {
      calls.push('refreshFromServer')
      return undefined
    }),
    discountRefusedAtPayment: vi.fn(async () => {}),
    releaseGiftHold: vi.fn(),
    getCart: () => ({ cartId: 'cart-1', currency: 'NOK', items: [{ id: 'a', quantity: 2, unitPrice: 100 }] }),
    ensureCartId: async () => 'cart-1',
    subtotalForSponsor: () => 200,
    ...extra,
  }
}

/** What `executeCartGraphQL` throws for a payment the gateway refuses with a code. */
const refused = (code: string) =>
  Object.assign(new Error(`Payment Vipps not initialize: the payment was refused [${code}]`), {
    graphql: { hasData: false, errors: [{ message: `Payment Vipps not initialize: the payment was refused [${code}]`, extensions: { code } }] },
  })

beforeEach(() => {
  calls.length = 0
  vipps.answer = async () => ({ payment_url: 'https://vipps.test/pay' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('the discount code is settled before anything is built on the cart', () => {
  it('createCheckout: own mutations, the code (bounded), the server\'s lines, then CreateCheckout', async () => {
    const c = cart()
    await new CheckoutManager(c as never).createCheckout(5)
    expect(calls).toEqual(['waitForCartMutations', 'settleDiscountCode', 'refreshFromServer', 'CreateCheckout', 'UpdateCheckout'])
    expect(c.settleDiscountCode).toHaveBeenCalledWith(5, { budgetMs: DISCOUNT_SETTLE_BUDGET_MS })
  })

  it('a Vipps payment (Express from the product or the cart, or the checkout\'s): the same order, then the payment', async () => {
    const c = cart()
    const res = await new CheckoutManager(c as never).startVippsExpress(5)
    expect(res).toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(calls.filter((x) => x !== 'waitForCartMutations')).toEqual([
      'settleDiscountCode',
      'refreshFromServer',
      'CreateCheckout',
      'UpdateCheckout',
      'CreatePaymentVipps',
    ])
    expect(calls.indexOf('waitForCartMutations')).toBeLessThan(calls.indexOf('settleDiscountCode'))
    expect(c.settleDiscountCode).toHaveBeenCalledWith(5, { budgetMs: DISCOUNT_SETTLE_BUDGET_MS })
    // On its way to Vipps: nothing to put right, nothing to give back.
    expect(c.discountRefusedAtPayment).not.toHaveBeenCalled()
    expect(c.releaseGiftHold).not.toHaveBeenCalled()
  })

  it('settling that throws never costs the checkout', async () => {
    const c = cart({
      settleDiscountCode: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    await expect(new CheckoutManager(c as never).createCheckout(5)).resolves.toMatchObject({ id: 'CHK-1' })
  })

  it('a cart manager without discounts is asked nothing, and pays as before', async () => {
    const { settleDiscountCode: _s, discountRefusedAtPayment: _d, releaseGiftHold: _r, ...plain } = cart()
    await expect(new CheckoutManager(plain as never).startVippsExpress(5)).resolves.toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(calls).not.toContain('settleDiscountCode')
    vipps.answer = async () => {
      throw refused('COUPON_EXPIRED')
    }
    await expect(new CheckoutManager(plain as never).startVippsExpress(5)).rejects.toThrow(/COUPON_EXPIRED/)
  })
})

describe('a payment that does not start', () => {
  it('refused because of the discount: the cart is put right with the reason the gateway\'s code names, and the error still reaches the caller', async () => {
    for (const code of ['COUPON_EXPIRED', 'COUPON_MIN_AMOUNT', 'GIFT_MAX_ONE_UNIT', 'CHECKOUT_AMOUNT_ZERO', 'DISCOUNT_UNAVAILABLE']) {
      const c = cart()
      vipps.answer = async () => {
        throw refused(code)
      }
      await expect(new CheckoutManager(c as never).startVippsExpress(5)).rejects.toThrow(code)
      expect(c.discountRefusedAtPayment, code).toHaveBeenCalledWith(5, code)
      expect(c.releaseGiftHold, code).toHaveBeenCalledWith(5)
    }
  })

  it('for any other reason: nothing about the discount is touched, but a gift that was held back may go in', async () => {
    const c = cart()
    vipps.answer = async () => {
      throw new Error('Payment Vipps not initialize: 503')
    }
    await expect(new CheckoutManager(c as never).startVippsExpress(5)).rejects.toThrow('503')
    expect(c.discountRefusedAtPayment).not.toHaveBeenCalled()
    expect(c.releaseGiftHold).toHaveBeenCalledWith(5)
  })

  it('Express refused without an error (the checkout opens instead): the held gift may go in', async () => {
    const c = cart()
    vipps.answer = async () => ({ express: false, reason: 'several suppliers' })
    await expect(new CheckoutManager(c as never).startVippsExpress(5)).resolves.toMatchObject({ express: false })
    expect(c.discountRefusedAtPayment).not.toHaveBeenCalled()
    expect(c.releaseGiftHold).toHaveBeenCalledWith(5)
  })

  it('putting the cart right never changes what the caller gets: its failure is not the payment\'s', async () => {
    const c = cart({
      discountRefusedAtPayment: vi.fn(() => {
        throw new Error('sync boom')
      }),
    })
    vipps.answer = async () => {
      throw refused('COUPON_EXPIRED')
    }
    await expect(new CheckoutManager(c as never).startVippsExpress(5)).rejects.toThrow(/COUPON_EXPIRED/)
  })
})
