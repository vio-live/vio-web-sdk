// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { applyVioTheme } from '../tokens.js'

/**
 * The cart's Vipps button pays the sponsor's WHOLE cart with Vipps Express
 * (2026-10-29: «el botón negro va con el nuestro y el botón de Vipps paga el
 * carrito entero») — the same Express as the detail: the hand-over overlay,
 * `vio:payment-redirect-*` with source 'cart', no `vio:checkout-open`.
 * «Til kassen» is the way into our checkout. `vipps-cart-payment="checkout"`
 * (or the theme's `vippsCartPayment`) keeps 0.31–0.34: the checkout opens
 * with Vipps preselected.
 */

afterEach(() => {
  unmountAll()
  document.querySelectorAll('.vio-redirect-overlay').forEach((n) => n.remove())
  document.documentElement.style.removeProperty('--vio-vipps-cart-payment')
  vi.restoreAllMocks()
})

const line = (id: string, productId: number, unitPrice: number, quantity = 1) => ({
  id, productId, name: `P${productId}`, quantity, unitPrice, currency: 'NOK',
})

async function cart(carts: Array<[number, ReturnType<typeof line>[]]>, attrs: Record<string, string> = {}) {
  vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Vipps' }] as any)
  vi.spyOn(Vio.cart, 'waitForCartMutations').mockResolvedValue(undefined as any)
  const el = await mount<HTMLElement & Record<string, any>>('vio-cart')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  el.carts = new Map(carts.map(([sponsorId, items]) => [sponsorId, { sponsorId, currency: 'NOK', items }]))
  el.itemCount = carts.reduce((n, [, items]) => n + items.reduce((m, i) => m + i.quantity, 0), 0)
  el.availableMethods = ['Vipps']
  el.open = true
  await settle(el)
  return el
}

function listen(...names: string[]) {
  const seen: Array<{ type: string; detail: any }> = []
  const on = (e: Event) => seen.push({ type: e.type, detail: (e as CustomEvent).detail })
  for (const n of names) document.addEventListener(n, on)
  return { seen, off: () => names.forEach((n) => document.removeEventListener(n, on)) }
}

const tapVipps = (el: HTMLElement) => el.shadowRoot!.querySelector<HTMLButtonElement>('.vipps-btn')!.click()

describe('vio-cart — Vipps pays the whole cart (Express)', () => {
  it('Express for the sponsor’s cart with every line: overlay, source cart, no checkout-open', async () => {
    vi.spyOn(Vio.checkout, 'getVippsExpressEnabled').mockResolvedValue(true)
    const express = vi.spyOn(Vio.checkout, 'startVippsExpress').mockResolvedValue({ payment_url: 'https://x' } as any)
    const plain = vi.spyOn(Vio.checkout, 'startVippsPayment')
    const el = await cart([[5, [line('i1', 1, 699), line('i2', 2, 1299, 2)]]])
    const ev = listen('vio:checkout-open', 'vio:payment-redirect-start', 'vio:payment-redirect-cancel', 'vio:payment-redirect-error')
    tapVipps(el)
    // The overlay is there at the tap: a second tap goes nowhere.
    expect(document.querySelector('.vio-redirect-overlay')).not.toBeNull()
    tapVipps(el)
    for (let i = 0; i < 4; i++) await settle(el)
    ev.off()
    expect(express).toHaveBeenCalledTimes(1)
    expect(express).toHaveBeenCalledWith(5)
    expect(plain).not.toHaveBeenCalled()
    expect(ev.seen.map((e) => e.type)).toEqual(['vio:payment-redirect-start'])
    expect(ev.seen[0]!.detail).toEqual({ method: 'vipps', sponsorId: 5, source: 'cart' })
  })

  it('«Til kassen» still opens our checkout, no method preselected', async () => {
    const express = vi.spyOn(Vio.checkout, 'startVippsExpress')
    const el = await cart([[5, [line('i1', 1, 699)]]])
    const ev = listen('vio:checkout-open')
    el.shadowRoot!.querySelector<HTMLButtonElement>('.checkout-btn')!.click()
    ev.off()
    expect(ev.seen).toHaveLength(1)
    expect(ev.seen[0]!.detail).toMatchObject({ sponsorId: 5, express: false })
    expect(ev.seen[0]!.detail.paymentMethod).toBeUndefined()
    expect(express).not.toHaveBeenCalled()
  })

  it('Express off for the brand: cancel, then the checkout opens with Vipps preselected', async () => {
    vi.spyOn(Vio.checkout, 'getVippsExpressEnabled').mockResolvedValue(false)
    const express = vi.spyOn(Vio.checkout, 'startVippsExpress')
    const el = await cart([[5, [line('i1', 1, 699)]]])
    const ev = listen('vio:checkout-open', 'vio:payment-redirect-start', 'vio:payment-redirect-cancel')
    tapVipps(el)
    for (let i = 0; i < 4; i++) await settle(el)
    ev.off()
    expect(express).not.toHaveBeenCalled()
    expect(ev.seen.map((e) => e.type)).toEqual(['vio:payment-redirect-start', 'vio:payment-redirect-cancel', 'vio:checkout-open'])
    expect(ev.seen[1]!.detail).toMatchObject({ source: 'cart', reason: 'express-off' })
    expect(ev.seen[2]!.detail).toMatchObject({ sponsorId: 5, paymentMethod: 'vipps', express: false })
    // The overlay fades out (200 ms) and goes.
    await vi.waitFor(() => expect(document.querySelector('.vio-redirect-overlay')).toBeNull())
  })

  it('the cart cannot have Express (several suppliers): not-started, then the checkout with Vipps', async () => {
    vi.spyOn(Vio.checkout, 'getVippsExpressEnabled').mockResolvedValue(true)
    vi.spyOn(Vio.checkout, 'startVippsExpress').mockResolvedValue({ express: false, reason: 'several suppliers' } as any)
    const el = await cart([[5, [line('i1', 1, 699)]]])
    const ev = listen('vio:checkout-open', 'vio:payment-redirect-cancel')
    tapVipps(el)
    for (let i = 0; i < 4; i++) await settle(el)
    ev.off()
    expect(ev.seen.map((e) => e.type)).toEqual(['vio:payment-redirect-cancel', 'vio:checkout-open'])
    expect(ev.seen[0]!.detail.reason).toBe('not-started')
  })

  it('Vipps could not start (an error): error event, overlay gone, the checkout with Vipps', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Vio.checkout, 'getVippsExpressEnabled').mockResolvedValue(true)
    vi.spyOn(Vio.checkout, 'startVippsExpress').mockRejectedValue(new Error('boom'))
    const el = await cart([[5, [line('i1', 1, 699)]]])
    const ev = listen('vio:checkout-open', 'vio:payment-redirect-error')
    tapVipps(el)
    for (let i = 0; i < 4; i++) await settle(el)
    ev.off()
    expect(ev.seen.map((e) => e.type)).toEqual(['vio:payment-redirect-error', 'vio:checkout-open'])
    await vi.waitFor(() => expect(document.querySelector('.vio-redirect-overlay')).toBeNull())
  })

  it('never another sponsor’s lines: only one sponsor’s cart is paid, by its own id', async () => {
    vi.spyOn(Vio.checkout, 'getVippsExpressEnabled').mockResolvedValue(true)
    const express = vi.spyOn(Vio.checkout, 'startVippsExpress').mockResolvedValue({ payment_url: 'https://x' } as any)
    // An empty cart of sponsor 3 first, then 5's, then 8's.
    const el = await cart([[3, []], [5, [line('i1', 1, 699)]], [8, [line('i9', 9, 499)]]])
    tapVipps(el)
    for (let i = 0; i < 4; i++) await settle(el)
    expect(express).toHaveBeenCalledTimes(1)
    expect(express).toHaveBeenCalledWith(5)
  })

  it('nothing to pay for (0 kr): nothing starts', async () => {
    const express = vi.spyOn(Vio.checkout, 'startVippsExpress')
    const el = await cart([[5, [line('i1', 1, 0)]]])
    const ev = listen('vio:checkout-open', 'vio:payment-redirect-start')
    tapVipps(el)
    for (let i = 0; i < 3; i++) await settle(el)
    ev.off()
    expect(express).not.toHaveBeenCalled()
    expect(ev.seen).toHaveLength(0)
  })
})

describe('vio-cart — vipps-cart-payment="checkout" keeps 0.31–0.34', () => {
  for (const [how, setup] of [
    ['the attribute', async () => cart([[5, [line('i1', 1, 699)]]], { 'vipps-cart-payment': 'checkout' })],
    [
      'the theme (applyVioTheme)',
      async () => {
        applyVioTheme({ vippsCartPayment: 'checkout' })
        expect(document.documentElement.style.getPropertyValue('--vio-vipps-cart-payment')).toBe('checkout')
        const el = await cart([[5, [line('i1', 1, 699)]]])
        // jsdom does not inherit custom properties: the element's own, as a page would cascade it.
        el.style.setProperty('--vio-vipps-cart-payment', 'checkout')
        return el
      },
    ],
  ] as const) {
    it(`via ${how}: the checkout opens with Vipps preselected; no Express, no hand-over`, async () => {
      const express = vi.spyOn(Vio.checkout, 'startVippsExpress').mockResolvedValue({ payment_url: 'https://x' } as any)
      const plain = vi.spyOn(Vio.checkout, 'startVippsPayment').mockResolvedValue({ payment_url: 'https://x' } as any)
      vi.spyOn(Vio.checkout, 'getVippsExpressEnabled').mockResolvedValue(true)
      const el = await setup()
      const ev = listen('vio:checkout-open', 'vio:payment-redirect-start')
      tapVipps(el)
      for (let i = 0; i < 3; i++) await settle(el)
      ev.off()
      expect(ev.seen.map((e) => e.type)).toEqual(['vio:checkout-open'])
      expect(ev.seen[0]!.detail).toMatchObject({ sponsorId: 5, paymentMethod: 'vipps', express: false })
      expect(express).not.toHaveBeenCalled()
      expect(plain).not.toHaveBeenCalled()
      expect(document.querySelector('.vio-redirect-overlay')).toBeNull()
    })
  }
})
