/**
 * The page's discount code and a checkout: before a checkout is created or a
 * payment started, the manager lets the cart settle its code — and the gift
 * it brings — (`CartManager.settleDiscountCode`), for a bounded time, between
 * the cart's own mutations and the read of the server's lines. A payment
 * Commerce refuses because of the discount puts the cart right for the next
 * attempt (`discountRefusedAtPayment`); any payment that does not start gives
 * back the gift it held (`releaseGiftHold`). A cart manager that knows nothing
 * of discounts (a host's own, a test's stub) is asked nothing.
 *
 * A code is validated BEFORE paying: when the shopper's own code — typed a
 * moment before the tap — is refused while the payment waits for it, the
 * page does not leave for the provider (the shopper is reading why).
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
    // What it found: nothing to tell (`{}`), or `notTaken`; a stub that says nothing at all is fine too.
    settleDiscountCode: vi.fn(async (): Promise<unknown> => {
      calls.push('settleDiscountCode')
      return undefined
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

describe('the shopper\'s own code, typed a moment before the tap, was not taken', () => {
  const notTaken = (reason?: string) =>
    cart({
      settleDiscountCode: vi.fn(async () => {
        calls.push('settleDiscountCode')
        return { notTaken: { code: 'FEIL', ...(reason ? { reason } : {}) } }
      }),
    })

  it('no payment is started — nothing is built on the cart — and the error names why, like a payment Commerce refuses', async () => {
    const c = notTaken('COUPON_NOT_FOUND')
    const err = await new CheckoutManager(c as never).startVippsExpress(5).then(
      () => undefined,
      (e: unknown) => e as Error & { discountCodeNotTaken?: boolean },
    )
    expect(err?.message).toMatch(/no payment started \[COUPON_NOT_FOUND\]$/)
    expect(err?.discountCodeNotTaken).toBe(true)
    // The code itself is not part of what is thrown (it reaches events and logs).
    expect(err?.message).not.toContain('FEIL')
    expect(calls.filter((x) => x !== 'waitForCartMutations')).toEqual(['settleDiscountCode'])
  })

  it('that code never was on the cart: nothing is taken off it', async () => {
    for (const reason of ['COUPON_NOT_FOUND', 'COUPON_EXPIRED', 'COUPON_MIN_AMOUNT']) {
      const c = notTaken(reason)
      await expect(new CheckoutManager(c as never).startVippsExpress(5)).rejects.toThrow(`[${reason}]`)
      expect(c.discountRefusedAtPayment, reason).not.toHaveBeenCalled()
      expect(c.releaseGiftHold, reason).toHaveBeenCalledWith(5)
    }
  })

  it('it could not be asked (no reason): «could not check the code right now»', async () => {
    const c = notTaken()
    await expect(new CheckoutManager(c as never).startVippsExpress(5)).rejects.toThrow('[COUPON_UNAVAILABLE]')
    expect(calls).not.toContain('CreatePaymentVipps')
  })

  it('the checkout\'s own Vipps payment is held back the same way', async () => {
    const c = notTaken('COUPON_EXPIRED')
    const address = { firstName: 'Kari', lastName: 'Nordmann', email: 'kari@example.no', phone: '40000000', address: 'Storgata 1', zip: '0155', city: 'Oslo', country: 'NO' }
    await expect(new CheckoutManager(c as never).startVippsPayment(5, address, { express: false })).rejects.toThrow('[COUPON_EXPIRED]')
    expect(calls).not.toContain('CreateCheckout')
    expect(calls).not.toContain('CreatePaymentVipps')
  })

  it('the next tap pays for the cart as it is', async () => {
    const c = notTaken('COUPON_NOT_FOUND')
    const manager = new CheckoutManager(c as never)
    await expect(manager.startVippsExpress(5)).rejects.toThrow('[COUPON_NOT_FOUND]')
    // The answer was read; nothing is being checked any more.
    c.settleDiscountCode.mockImplementation(async () => {
      calls.push('settleDiscountCode')
      return {}
    })
    calls.length = 0
    await expect(manager.startVippsExpress(5)).resolves.toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(calls).toContain('CreatePaymentVipps')
  })

  it('a checkout that stays on the page (createCheckout) is created all the same: the field says why right there', async () => {
    const c = notTaken('COUPON_NOT_FOUND')
    await expect(new CheckoutManager(c as never).createCheckout(5)).resolves.toMatchObject({ id: 'CHK-1' })
  })
})
