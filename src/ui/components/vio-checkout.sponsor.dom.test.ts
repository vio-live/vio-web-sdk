// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { Configuration } from '../../core/configuration.js'
import { VioCheckout } from './vio-checkout.js'
import { resetFailedLogos } from '../sponsor-identity.js'
import { rememberCheckoutSponsor, resetCheckoutSponsorMemory } from '../../core/sponsor-identity.js'
import type { BootstrapResponse } from '../../core/types.js'

/**
 * The checkout says who you buy from, and the confirmation who you bought
 * from — «Takk for bestillingen! Du har handlet hos Careless.» — with the
 * CHECKOUT's sponsor (the cart's), never the page's: an article of one brand
 * may sell another brand's product. After Vipps (a redirect: the page is new,
 * the bootstrap may not be there yet) it still names the brand — from the
 * bootstrap when it lands, from what this tab remembered of the checkout
 * before it.
 */

const PAGE_SPONSOR = 4 // the page's: the surface's primary sponsor, what Vio.attribution() names
const CHECKOUT_SPONSOR = 7 // the cart's: only in a non-default campaign
const CHECKOUT = '9a1c2b3d-4e5f-4a6b-8c7d-6e5f4a3b2c1d'
const manager = Vio.checkout as any

const sponsor = (id: number, name: string, logoUrl: string | null) => ({
  id,
  name,
  logoUrl,
  avatarUrl: null,
  commerce: { apiKey: `key-${id}` },
})

const BOOT: BootstrapResponse = {
  campaign: { id: 10, name: 'Default' },
  primarySponsor: sponsor(PAGE_SPONSOR, 'Careless', 'https://cdn.vio.live/careless.png'),
  secondarySponsors: [sponsor(5, 'Bohus', '')],
  campaigns: [
    { id: 10, name: 'Default', isDefault: true, status: 'active', primarySponsor: sponsor(PAGE_SPONSOR, 'Careless', 'https://cdn.vio.live/careless.png') },
    { id: 12, name: 'Hero', status: 'active', primarySponsor: sponsor(CHECKOUT_SPONSOR, 'Sindig', 'https://cdn.vio.live/sindig.svg') },
  ],
}

const facade = () => Vio as unknown as { cachedBootstrap: BootstrapResponse | null }

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** A Storage that lives in a Map — the test's own. */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  }
}

const landOn = (search: string) => window.history.replaceState({}, '', `/${search}`)
const vippsReturn = (sponsorId: number) =>
  `?vio_payment=success&vio_method=vipps&vio_sponsor=${sponsorId}&checkout_id=${CHECKOUT}`

async function renderCycles(el: HTMLElement, n = 6) {
  for (let i = 0; i < n; i++) await settle(el)
}

const q = (el: HTMLElement, sel: string) => el.shadowRoot?.querySelector(sel) ?? null
const text = (el: HTMLElement, sel: string) => (q(el, sel)?.textContent ?? '').replace(/\s+/g, ' ').trim()

function listen() {
  const seen: any[] = []
  const on = (e: Event) => seen.push((e as CustomEvent).detail)
  document.addEventListener('vio:payment-success', on)
  return { seen, off: () => document.removeEventListener('vio:payment-success', on) }
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', memoryStorage())
  resetCheckoutSponsorMemory()
  resetFailedLogos()
  vi.spyOn(manager, 'getOrderReference').mockResolvedValue({ orderNumber: 1, buyerRef: null })
  vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null)
  const proto = VioCheckout.prototype as any
  for (const m of ['loadAvailablePaymentMethods', 'loadAvailableShippings', 'refreshApplePay', 'refreshKlarna', 'loadVippsButton']) {
    vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(new Map([[5, {} as any]]))
  vi.spyOn(Vio.cart, 'clearSponsorCart').mockImplementation(() => {})
  vi.spyOn(manager, 'open').mockImplementation((...args: unknown[]) => {
    manager.state = { sponsorId: args[0], session: 1, subtotal: 4999, currency: 'NOK' }
    manager.emit()
    return manager.state
  })
})

afterEach(() => {
  unmountAll()
  manager.state = null
  facade().cachedBootstrap = null
  Configuration.reset()
  window.history.replaceState({}, '', '/')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetCheckoutSponsorMemory()
})

describe('the checkout header names the checkout\'s sponsor', () => {
  it("«Du handler hos <logo>» — the cart's sponsor, even when the page's attribution names another", async () => {
    facade().cachedBootstrap = BOOT
    expect(Vio.attribution().sponsorId).toBe(PAGE_SPONSOR) // the page says Careless
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.open(CHECKOUT_SPONSOR)
    el.show()
    await renderCycles(el)
    expect(text(el, '.topbar-sponsor')).toContain('Du handler hos')
    const logo = q(el, '.topbar-sponsor .topbar-sponsor-logo') as HTMLImageElement | null
    expect(logo?.getAttribute('src')).toBe('https://cdn.vio.live/sindig.svg')
    expect(logo?.getAttribute('alt')).toBe('Sindig')
    expect(shadowText(el)).not.toContain('Careless')
  })

  it('no logo: the name; a logo that does not load: the name', async () => {
    facade().cachedBootstrap = BOOT
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.open(5)
    el.show()
    await renderCycles(el)
    expect(text(el, '.topbar-sponsor')).toBe('Du handler hos Bohus')

    manager.close()
    manager.open(CHECKOUT_SPONSOR)
    el.show()
    await renderCycles(el)
    q(el, '.topbar-sponsor-logo')!.dispatchEvent(new Event('error'))
    await renderCycles(el)
    expect(q(el, '.topbar-sponsor-logo')).toBeNull()
    expect(text(el, '.topbar-sponsor')).toBe('Du handler hos Sindig')
  })

  it('nothing names it: no line at all', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.open(99)
    el.show()
    await renderCycles(el)
    expect(q(el, '.topbar-sponsor')).toBeNull()
  })
})

describe('the confirmation: «Takk for bestillingen! Du har handlet hos …»', () => {
  it("an in-page payment: the checkout's sponsor by name and logo; the event carries it", async () => {
    facade().cachedBootstrap = BOOT
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: CHECKOUT_SPONSOR, session: 1, subtotal: 1699, currency: 'NOK', checkoutId: CHECKOUT }
    manager.emit()
    const { seen, off } = listen()
    try {
      el.confirmOrder('stripe', CHECKOUT_SPONSOR, { chargedTotal: 1699 })
      await renderCycles(el)
    } finally {
      off()
    }
    expect(text(el, '.confirm-title')).toBe('Takk for bestillingen!')
    expect(text(el, '.confirm-sponsor')).toBe('Du har handlet hos Sindig.')
    expect(q(el, '.confirm-brand .confirm-brand-logo')?.getAttribute('alt')).toBe('Sindig')
    // The header says it in the body on our own confirmation, not twice.
    expect(q(el, '.topbar-sponsor')).toBeNull()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      method: 'stripe',
      sponsorId: CHECKOUT_SPONSOR,
      checkoutId: CHECKOUT,
      sponsor: { id: CHECKOUT_SPONSOR, name: 'Sindig', logoUrl: 'https://cdn.vio.live/sindig.svg' },
    })
    expect(shadowText(el)).not.toContain('Careless')
  })

  it('a sponsor without a logo is named in the sentence alone; a broken logo leaves the sentence', async () => {
    facade().cachedBootstrap = BOOT
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: 5, session: 1, subtotal: 1, currency: 'NOK', checkoutId: 'chk-bohus' }
    manager.emit()
    el.confirmOrder('stripe', 5)
    await renderCycles(el)
    expect(text(el, '.confirm-sponsor')).toBe('Du har handlet hos Bohus.')
    expect(q(el, '.confirm-brand')).toBeNull()

    manager.close()
    await renderCycles(el)
    manager.state = { sponsorId: CHECKOUT_SPONSOR, session: 2, subtotal: 1, currency: 'NOK', checkoutId: CHECKOUT }
    manager.emit()
    el.confirmOrder('stripe', CHECKOUT_SPONSOR)
    await renderCycles(el)
    q(el, '.confirm-brand-logo')!.dispatchEvent(new Event('error'))
    await renderCycles(el)
    expect(q(el, '.confirm-brand')).toBeNull()
    expect(text(el, '.confirm-sponsor')).toBe('Du har handlet hos Sindig.')
  })

  it('nothing names the sponsor: the thanks as before, no sentence', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: 99, session: 1, subtotal: 1, currency: 'NOK', checkoutId: 'chk-x' }
    manager.emit()
    el.confirmOrder('stripe', 99)
    await renderCycles(el)
    expect(text(el, '.confirm-title')).toBe('Takk for bestillingen!')
    expect(q(el, '.confirm-sponsor')).toBeNull()
  })
})

describe('back from Vipps (vio_sponsor + checkout_id in the return URL)', () => {
  beforeEach(() => {
    vi.spyOn(manager, 'getVippsStatus').mockResolvedValue({ state: 'AUTHORIZED' })
  })

  it('with the bootstrap there: the URL\'s sponsor while verifying and on the confirmation — not the page\'s', async () => {
    facade().cachedBootstrap = BOOT
    landOn(vippsReturn(CHECKOUT_SPONSOR))
    const { seen, off } = listen()
    let el: HTMLElement & Record<string, any>
    try {
      el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
      await renderCycles(el)
    } finally {
      off()
    }
    expect(text(el, '.confirm-title')).toBe('Takk for bestillingen!')
    expect(text(el, '.confirm-sponsor')).toBe('Du har handlet hos Sindig.')
    expect(shadowText(el)).not.toContain('Careless')
    expect(seen[0]).toMatchObject({
      method: 'vipps',
      sponsorId: CHECKOUT_SPONSOR,
      orderId: CHECKOUT,
      sponsor: { id: CHECKOUT_SPONSOR, name: 'Sindig', logoUrl: 'https://cdn.vio.live/sindig.svg' },
    })
  })

  it('before the bootstrap: the thanks at once, the brand as soon as the bootstrap lands', async () => {
    Configuration.init({ apiKey: 'k', environment: 'testing' })
    const boot = deferred<BootstrapResponse>()
    const bootstrap = vi.spyOn(Vio, 'bootstrap').mockImplementation(() =>
      boot.promise.then((res) => {
        facade().cachedBootstrap = res
        return res
      }),
    )
    landOn(vippsReturn(CHECKOUT_SPONSOR))
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await renderCycles(el)
    expect(text(el, '.confirm-title')).toBe('Takk for bestillingen!')
    expect(q(el, '.confirm-sponsor')).toBeNull()
    expect(bootstrap).toHaveBeenCalled()

    boot.resolve(BOOT)
    await renderCycles(el)
    expect(text(el, '.confirm-sponsor')).toBe('Du har handlet hos Sindig.')
    expect(q(el, '.confirm-brand-logo')?.getAttribute('src')).toBe('https://cdn.vio.live/sindig.svg')
  })

  it('before the bootstrap, with this tab\'s memory of the checkout: named at once', async () => {
    rememberCheckoutSponsor(CHECKOUT, { sponsorId: CHECKOUT_SPONSOR, name: 'Sindig', logoUrl: 'https://cdn.vio.live/sindig.svg' })
    landOn(vippsReturn(CHECKOUT_SPONSOR))
    const { seen, off } = listen()
    let el: HTMLElement & Record<string, any>
    try {
      el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
      await renderCycles(el)
    } finally {
      off()
    }
    expect(text(el, '.confirm-sponsor')).toBe('Du har handlet hos Sindig.')
    expect(seen[0]?.sponsor).toEqual({ id: CHECKOUT_SPONSOR, name: 'Sindig', logoUrl: 'https://cdn.vio.live/sindig.svg' })
  })

  it('while Vipps is being asked, the header already says who', async () => {
    facade().cachedBootstrap = BOOT
    const status = deferred<{ state: string }>()
    vi.spyOn(manager, 'getVippsStatus').mockReturnValue(status.promise)
    landOn(vippsReturn(CHECKOUT_SPONSOR))
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await renderCycles(el)
    expect(q(el, '.verifying')).not.toBeNull()
    expect(q(el, '.topbar-sponsor-logo')?.getAttribute('alt')).toBe('Sindig')
    status.resolve({ state: 'AUTHORIZED' })
    await renderCycles(el)
    expect(text(el, '.confirm-sponsor')).toBe('Du har handlet hos Sindig.')
  })
})

describe('a return without vio_sponsor (Qliro): the sponsor this tab remembered for the checkout', () => {
  it("names the checkout's sponsor, not whichever cart comes first", async () => {
    facade().cachedBootstrap = BOOT
    rememberCheckoutSponsor('CHK-Q', { sponsorId: CHECKOUT_SPONSOR, name: 'Sindig' })
    vi.spyOn(manager, 'getQliroOrder').mockResolvedValue({ order_id: 'Q-1', status: 'Completed', total_price: 1699 })
    landOn('?checkout_id=CHK-Q&payment_processor=QLIRO')
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await renderCycles(el)
    expect(text(el, '.confirm-title')).toBe('Takk for bestillingen!')
    expect(text(el, '.confirm-sponsor')).toBe('Du har handlet hos Sindig.')
  })
})
