// @vitest-environment jsdom
/**
 * The Payment Element, the piece that keeps a Stripe shopper on our page.
 *
 * What matters here is that the browser's answer is READ HONESTLY: Stripe
 * says `succeeded`, `processing` or nothing of the sort, and only the first
 * of those may ever become a receipt. Everything else is a promise we cannot
 * keep — the order is created by the webhook, server-side.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mountStripeElement, type StripeIntent } from './stripe-embedded.js'

const INTENT: StripeIntent = {
  client_secret: 'pi_1_secret_x',
  publishable_key: 'pk_test_seller',
}

let confirmPayment: ReturnType<typeof vi.fn>
let elementsArgs: any
let created: any
let elementMount: ReturnType<typeof vi.fn>
let elementUnmount: ReturnType<typeof vi.fn>
let keyUsed: string | undefined

beforeEach(() => {
  confirmPayment = vi.fn().mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'succeeded' } })
  elementMount = vi.fn()
  elementUnmount = vi.fn()
  keyUsed = undefined
  ;(globalThis as any).Stripe = (key: string) => {
    keyUsed = key
    return {
      elements: (args: any) => {
        elementsArgs = args
        return {
          create: (type: string, opts: any) => {
            created = { type, opts }
            return { mount: elementMount, unmount: elementUnmount }
          },
        }
      },
      confirmPayment,
    }
  }
})

const container = () => document.createElement('div')

describe('mounting', () => {
  it('uses the key that came WITH the secret, and mounts into our container', async () => {
    const el = container()
    el.innerHTML = '<span>leftover</span>'
    await mountStripeElement(el, INTENT, { returnUrl: 'https://shop.example/back' })
    expect(keyUsed).toBe('pk_test_seller')
    expect(elementsArgs.clientSecret).toBe('pi_1_secret_x')
    expect(created.type).toBe('payment')
    expect(el.innerHTML).toBe('')
    expect(elementMount).toHaveBeenCalledWith(el)
  })

  it('speaks Norwegian, like the rest of the checkout', async () => {
    await mountStripeElement(container(), INTENT, { returnUrl: 'https://shop.example/back' })
    expect(elementsArgs.locale).toBe('nb')
  })

  it('refuses half an account: a secret without its publishable key', async () => {
    await expect(
      mountStripeElement(container(), { client_secret: 'pi_1_secret_x' } as StripeIntent, {
        returnUrl: 'https://shop.example/back',
      }),
    ).rejects.toThrow(/publishable key/)
  })

  it('carries the host theme into Stripe’s appearance', async () => {
    await mountStripeElement(container(), INTENT, {
      returnUrl: 'https://shop.example/back',
      theme: { accent: '#ff0066', radiusMd: '12px' },
    })
    expect(elementsArgs.appearance.variables).toEqual({
      colorPrimary: '#ff0066',
      borderRadius: '12px',
    })
  })
})

describe('confirming', () => {
  const mounted = () =>
    mountStripeElement(container(), INTENT, { returnUrl: 'https://shop.example/back' })

  it('succeeded is the only outcome that may become a receipt', async () => {
    const handle = await mounted()
    expect(await handle.confirm()).toEqual({ status: 'succeeded', paymentIntentId: 'pi_1' })
    expect(confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmParams: { return_url: 'https://shop.example/back' },
        redirect: 'if_required',
      }),
    )
  })

  it('processing is pending — authorised, not settled', async () => {
    confirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'processing' } })
    expect(await (await mounted()).confirm()).toEqual({ status: 'pending', paymentIntentId: 'pi_1' })
  })

  it('a Stripe error is a failure, in Stripe’s own words', async () => {
    confirmPayment.mockResolvedValue({ error: { message: 'Kortet ble avvist.', code: 'card_declined' } })
    expect(await (await mounted()).confirm()).toEqual({
      status: 'failed',
      message: 'Kortet ble avvist.',
      code: 'card_declined',
    })
  })

  it('an intent that still wants a card is NOT paid', async () => {
    confirmPayment.mockResolvedValue({
      paymentIntent: { id: 'pi_1', status: 'requires_payment_method' },
    })
    expect(await (await mounted()).confirm()).toEqual({
      status: 'failed',
      code: 'requires_payment_method',
    })
  })

  it('a second press while one is in flight does not charge twice', async () => {
    let release: (v: unknown) => void = () => {}
    confirmPayment.mockImplementation(() => new Promise((r) => (release = r)))
    const handle = await mounted()
    const first = handle.confirm()
    const second = await handle.confirm()
    expect(second).toEqual({ status: 'pending' })
    expect(confirmPayment).toHaveBeenCalledTimes(1)
    release({ paymentIntent: { id: 'pi_1', status: 'succeeded' } })
    expect(await first).toEqual({ status: 'succeeded', paymentIntentId: 'pi_1' })
  })

  it('unmount survives an Element Stripe already took down', async () => {
    elementUnmount.mockImplementation(() => {
      throw new Error('already gone')
    })
    const handle = await mounted()
    expect(() => handle.unmount()).not.toThrow()
  })
})
