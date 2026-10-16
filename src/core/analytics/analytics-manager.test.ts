/**
 * Vio.analytics — queue/session/wire-format semantics.
 *
 * Runs in a minimal fake-DOM (node env): the manager only needs `window`,
 * `localStorage`, `location` and `fetch`, all stubbed here. What matters:
 * pre-init queuing, session rotation, wire shape (snake_case contract v1),
 * retry-safe flush, and no module side-effects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Configuration } from '../configuration.js'
import type { BootstrapResponse } from '../types.js'
import {
  AnalyticsManager,
  purchaseFromPaymentSuccess,
  resolveCampaignId,
} from './analytics-manager.js'

// ── Fake browser environment ────────────────────────────────────────────────

function installFakeDom() {
  const store = new Map<string, string>()
  const listeners = new Map<string, Set<(ev: Event) => void>>()
  const g = globalThis as Record<string, unknown>

  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    addEventListener: (t: string, h: (ev: Event) => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set())
      listeners.get(t)!.add(h)
    },
    removeEventListener: (t: string, h: (ev: Event) => void) => {
      listeners.get(t)?.delete(h)
    },
    dispatchEvent: (ev: Event) => {
      listeners.get(ev.type)?.forEach((h) => h(ev))
      return true
    },
  }
  ;(g.window as Record<string, unknown>).location = { href: 'https://host.example/article' }
  g.location = (g.window as Record<string, unknown>).location
  g.document = { title: 'Sneakers 2026 — trendy' }
  return { store, listeners }
}

function removeFakeDom() {
  const g = globalThis as Record<string, unknown>
  delete g.window
  delete g.location
  delete g.document
}

const flushedBatches: Array<{ apiKey: string; events: Array<Record<string, unknown>> }> = []

beforeEach(() => {
  installFakeDom()
  flushedBatches.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      flushedBatches.push(JSON.parse(init.body))
      return { ok: true, status: 202 } as Response
    }),
  )
  Configuration.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Configuration.reset()
  removeFakeDom()
})

function initVio() {
  Configuration.init({ apiKey: 'test-key', eventsBase: 'https://events.test' })
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('wire format (contract v1)', () => {
  it('builds snake_case events with ids, version and enrichment', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.track('component_impression', {
      context: { campaignComponentId: 512, sponsorId: 9, variant: 'top-b' },
    })
    await m.flush()

    expect(flushedBatches).toHaveLength(1)
    const batch = flushedBatches[0]!
    expect(batch.apiKey).toBe('test-key')
    // session_start (auto) + the tracked event
    const names = batch.events.map((e) => e.name)
    expect(names).toEqual(['session_start', 'component_impression'])

    const ev = batch.events[1]!
    expect(ev.surface).toBe('web')
    expect(ev.sdk_version).toBeTruthy()
    expect(String(ev.session_id)).toMatch(/^s-/)
    expect(String(ev.anon_id)).toMatch(/^a-/)
    const ctx = ev.context as Record<string, unknown>
    expect(ctx.campaign_component_id).toBe(512)
    expect(ctx.sponsor_id).toBe(9)
    expect(ctx.variant).toBe('top-b')
    expect(ctx.content_url).toBe('https://host.example/article')
    expect(ctx.content_title).toBe('Sneakers 2026 — trendy')
  })

  it('normalizes commerce ids to strings', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.track('add_to_cart', {
      commerce: { items: [{ productId: 408948, variantId: 100, price: 299 }], value: 299, currency: 'NOK' },
    })
    await m.flush()
    const item = (flushedBatches[0]!.events[1]!.commerce as { items: Array<Record<string, unknown>> })
      .items[0]!
    expect(item.product_id).toBe('408948')
    expect(item.variant_id).toBe('100')
  })
})

describe('pre-init queue', () => {
  it('holds events until Vio.init, then flushes them', async () => {
    const m = new AnalyticsManager()
    m.track('view_item', { commerce: { items: [{ productId: '1' }] } })
    await m.flush()
    expect(flushedBatches).toHaveLength(0) // no transport yet — held, not dropped

    initVio()
    await m.flush()
    expect(flushedBatches).toHaveLength(1)
    expect(flushedBatches[0]!.events.map((e) => e.name)).toContain('view_item')
  })
})

describe('sessions', () => {
  it('persists anon id across manager instances, rotates session after 30 min idle', async () => {
    initVio()
    const m1 = new AnalyticsManager()
    m1.track('view_item')
    await m1.flush()
    const first = flushedBatches[0]!.events.at(-1) as Record<string, unknown>

    // Same page, later manager instance (e.g. another chunk) — same ids.
    const m2 = new AnalyticsManager()
    m2.track('view_item')
    await m2.flush()
    const second = flushedBatches[1]!.events.at(-1) as Record<string, unknown>
    expect(second.anon_id).toBe(first.anon_id)
    expect(second.session_id).toBe(first.session_id)

    // 31 minutes of inactivity → new session (+ session_start re-emitted).
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 31 * 60 * 1000)
    m2.track('view_item')
    await m2.flush()
    const third = flushedBatches[2]!.events
    expect(third.map((e) => e.name)).toContain('session_start')
    const rotated = third.at(-1) as Record<string, unknown>
    expect(rotated.session_id).not.toBe(first.session_id)
    expect(rotated.anon_id).toBe(first.anon_id) // anon survives rotation
  })
})

describe('flush + retry', () => {
  it('requeues the batch with the SAME event_ids on failure (server dedupes)', async () => {
    initVio()
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('net down')).mockResolvedValue({
      ok: true,
      status: 202,
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const m = new AnalyticsManager()
    m.track('view_item')
    await m.flush() // fails — requeued, backoff armed
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await m.flush() // inside backoff window — no call
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 10_000) // past backoff
    await m.flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const firstBody = JSON.parse((fetchMock.mock.calls[0]! as [string, { body: string }])[1].body)
    const retryBody = JSON.parse((fetchMock.mock.calls[1]! as [string, { body: string }])[1].body)
    expect(retryBody.events.map((e: { event_id: string }) => e.event_id)).toEqual(
      firstBody.events.map((e: { event_id: string }) => e.event_id),
    )
  })

  it('drops the batch on 401 instead of looping forever', async () => {
    initVio()
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response)
    vi.stubGlobal('fetch', fetchMock)
    const m = new AnalyticsManager()
    m.track('view_item')
    await m.flush()
    await m.flush()
    expect(fetchMock).toHaveBeenCalledTimes(1) // queue emptied, nothing to resend
  })
})

describe('SSR safety', () => {
  it('is a silent no-op without window', async () => {
    removeFakeDom()
    const m = new AnalyticsManager()
    expect(() => {
      m.track('view_item')
      m.start()
    }).not.toThrow()
    await m.flush()
    expect(flushedBatches).toHaveLength(0)
  })
})

describe('autoTrack option', () => {
  it('start({autoTrack:false}) keeps the engine but installs no funnel listeners', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.start({ host: 'vev', autoTrack: false })
    // Host dispatches an SDK funnel event — with autoTrack off, nothing queues.
    ;(globalThis as Record<string, unknown> as { window: Window }).window.dispatchEvent(
      new CustomEvent('vio:added-to-cart', { detail: { productId: 1 } }) as unknown as Event,
    )
    m.track('view_item') // manual track still works through the same engine
    await m.flush()
    const names = flushedBatches[0]!.events.map((e) => e.name)
    expect(names).not.toContain('add_to_cart')
    expect(names).toContain('view_item')
    m.stop()
  })
})

describe('UI auto-instrumentation', () => {
  it('vio:product-click from SDK components becomes select_item', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.start({ host: 'custom' }) // autoTrack default: on
    ;(globalThis as Record<string, unknown> as { window: Window }).window.dispatchEvent(
      new CustomEvent('vio:product-click', {
        detail: { productId: 408948, sponsorId: 9, name: 'Bonding Oil', price: 300 },
      }) as unknown as Event,
    )
    await m.flush()
    const events = flushedBatches[0]!.events
    const sel = events.find((e) => e.name === 'select_item') as Record<string, unknown>
    expect(sel).toBeDefined()
    const commerce = sel.commerce as { items: Array<Record<string, unknown>> }
    expect(commerce.items[0]!.product_id).toBe('408948')
    expect(commerce.items[0]!.price).toBe(300)
    m.stop()
  })
})

describe('host attribution', () => {
  it('carries the host content id on the wire so it can join its own reporting', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.track('purchase', { context: { contentId: 123, contentUrl: '/artikkel/hostens-jakker' } })
    await m.flush()

    const ev = flushedBatches[0]!.events.at(-1) as Record<string, unknown>
    const ctx = ev.context as Record<string, unknown>
    expect(ctx.content_id).toBe(123)
    expect(ctx.content_url).toBe('/artikkel/hostens-jakker')
  })

  it('adopts a host-supplied session id instead of minting one', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.start({ sessionId: 'ml-sid-abc', collector: true })
    m.track('add_to_cart')
    await m.flush()

    const events = flushedBatches.flatMap((b) => b.events)
    expect(events.length).toBeGreaterThan(0)
    for (const ev of events) expect(ev.session_id).toBe('ml-sid-abc')
    m.stop()
  })

  it('keeps minting its own session when the host supplies none', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.track('add_to_cart')
    await m.flush()

    const ev = flushedBatches[0]!.events.at(-1) as Record<string, unknown>
    expect(String(ev.session_id)).toMatch(/^s-/)
  })
})

describe('consentimiento (ePrivacy) y diagnósticos', () => {
  const ls = () =>
    (globalThis as Record<string, any>).window.localStorage as {
      getItem: (k: string) => string | null
    }
  const fire = (type: string, detail: unknown) =>
    (globalThis as Record<string, any>).window.dispatchEvent(
      new CustomEvent(type, { detail }) as unknown as Event,
    )

  it('sin requireConsent persiste el anon_id — comportamiento de siempre', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.start({ host: 'custom' })
    await m.flush()
    expect(ls().getItem('vio.anon.v1')).not.toBeNull()
    m.stop()
  })

  it('con requireConsent NO escribe nada en el dispositivo, pero igual mide', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.start({ host: 'custom', requireConsent: true })
    m.track('view_item')
    await m.flush()

    expect(ls().getItem('vio.anon.v1')).toBeNull()
    expect(ls().getItem('vio.session.v1')).toBeNull()

    // La visita se mide igual: el evento sale con ids efímeros.
    const events = flushedBatches[0]!.events
    const ev = events.find((e) => e.name === 'view_item')!
    expect(ev.anon_id).toMatch(/^a-/)
    expect(ev.session_id).toMatch(/^s-/)
    m.stop()
  })

  it('setConsent(true) promueve los ids efímeros sin partir la visita', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.start({ host: 'custom', requireConsent: true })
    m.track('view_item')
    await m.flush()
    const anonAntes = flushedBatches[0]!.events[0]!.anon_id

    m.setConsent(true)
    m.track('add_to_cart')
    await m.flush()

    expect(ls().getItem('vio.anon.v1')).toBe(anonAntes)
    const despues = flushedBatches[flushedBatches.length - 1]!.events[0]!
    expect(despues.anon_id).toBe(anonAntes)
    m.stop()
  })

  it('setConsent(false) borra lo que había en el dispositivo', () => {
    initVio()
    const m = new AnalyticsManager()
    m.start({ host: 'custom' })
    expect(ls().getItem('vio.anon.v1')).not.toBeNull()

    m.setConsent(false)

    expect(ls().getItem('vio.anon.v1')).toBeNull()
    expect(ls().getItem('vio.session.v1')).toBeNull()
    m.stop()
  })

  it('vio:removed-from-cart se convierte en remove_from_cart', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.start({ host: 'custom' })
    fire('vio:removed-from-cart', { productId: 408948, name: 'Bonding Oil', price: 300, quantity: 2, currency: 'NOK' })
    await m.flush()

    const ev = flushedBatches
      .flatMap((b) => b.events)
      .find((e) => e.name === 'remove_from_cart') as Record<string, any>
    expect(ev).toBeDefined()
    expect(ev.commerce.items[0].product_id).toBe('408948')
    expect(ev.commerce.value).toBe(600)
    m.stop()
  })

  it('un fallo del carrito se reporta como sdk_error con error_code', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.start({ host: 'custom' })
    fire('vio:cart-error', { message: 'AddItem failed' })
    await m.flush()

    const ev = flushedBatches
      .flatMap((b) => b.events)
      .find((e) => e.name === 'sdk_error') as Record<string, any>
    expect(ev).toBeDefined()
    expect(ev.context.error_code).toBe('cart_error')
    expect(ev.props.message).toBe('AddItem failed')
    m.stop()
  })
})

// ── Atribución: campaign_id, order_id y cabecera X-Api-Key ──────────────────

type FakeLine = {
  productId: number
  variantId?: number
  name?: string
  brand?: string
  unitPrice: number
  quantity: number
  currency: string
  sponsorId: number
}

/** Lo mínimo del CartManager que lee el manager: carritos por sponsor + change. */
function fakeCart(linesBySponsor: Record<number, FakeLine[]> = {}) {
  const carts = new Map<number, { items: FakeLine[] }>()
  for (const [sid, items] of Object.entries(linesBySponsor)) carts.set(Number(sid), { items })
  return {
    getAllCarts: () => carts,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

function installFacade(bootstrapCache: unknown, cart = fakeCart()) {
  ;(globalThis as Record<string, unknown>).__VIO_FACADE__ = { bootstrapCache, cart }
}

function removeFacade() {
  delete (globalThis as Record<string, unknown>).__VIO_FACADE__
}

const sponsor = (id: number) => ({ id, name: `Sponsor ${id}`, commerce: { apiKey: `key-${id}` } })

/** Respuesta de `/v2/mobile/config` del micro: `campaign` + `campaigns[]`. */
const BOOT: BootstrapResponse = {
  campaign: { id: 10, name: 'Default', isActive: true, isPaused: false },
  primarySponsor: sponsor(4),
  secondarySponsors: [sponsor(5)],
  campaigns: [
    {
      id: 12,
      name: 'Newer',
      isDefault: false,
      status: 'active',
      primarySponsor: sponsor(7),
      secondarySponsors: [sponsor(8), sponsor(5)],
      slots: [],
    },
    {
      id: 10,
      name: 'Default',
      isDefault: true,
      status: 'active',
      primarySponsor: sponsor(4),
      secondarySponsors: [sponsor(5)],
      slots: [],
    },
    {
      id: 13,
      name: 'Paused',
      isDefault: false,
      status: 'paused',
      primarySponsor: sponsor(9),
      secondarySponsors: [],
      slots: [],
    },
  ],
}

describe('campaign_id desde la respuesta real de /v2/mobile/config', () => {
  afterEach(removeFacade)

  const contextOf = async (context: Record<string, unknown>) => {
    initVio()
    const m = new AnalyticsManager()
    m.track('view_item', { context })
    await m.flush()
    return (flushedBatches.at(-1)!.events.at(-1)!.context ?? {}) as Record<string, unknown>
  }

  it('el campaignId explícito del contexto gana sobre todo', async () => {
    installFacade(BOOT)
    expect((await contextOf({ campaignId: 99, sponsorId: 8 })).campaign_id).toBe(99)
  })

  it('un secundario de una campaña activa no-default atribuye a ESA campaña', async () => {
    installFacade(BOOT)
    expect((await contextOf({ sponsorId: 8 })).campaign_id).toBe(12)
  })

  it('el primario de una campaña activa no-default atribuye a ESA campaña', async () => {
    installFacade(BOOT)
    expect((await contextOf({ sponsorId: 7 })).campaign_id).toBe(12)
  })

  it('un sponsor en varias campañas activas va a la campaña por defecto', async () => {
    installFacade(BOOT)
    expect((await contextOf({ sponsorId: 5 })).campaign_id).toBe(10)
  })

  it('un sponsor que solo está en una campaña pausada cae a campaign.id', async () => {
    installFacade(BOOT)
    expect((await contextOf({ sponsorId: 9 })).campaign_id).toBe(10)
  })

  it('sin sponsor en el evento, campaign.id', async () => {
    installFacade(BOOT)
    expect((await contextOf({})).campaign_id).toBe(10)
  })

  it('acepta el sponsorId como string (los web components lo pasan por atributo)', async () => {
    installFacade(BOOT)
    expect((await contextOf({ sponsorId: '8' as unknown as number })).campaign_id).toBe(12)
  })

  it('sin bootstrap no inventa campaign_id, y el viejo `campaignId` plano ya no cuenta', async () => {
    installFacade({ campaignId: 77, primarySponsor: sponsor(4) })
    expect((await contextOf({ sponsorId: 4 })).campaign_id).toBeUndefined()
    removeFacade()
    expect((await contextOf({ sponsorId: 4 })).campaign_id).toBeUndefined()
  })

  it('un sponsor en varias campañas activas no-default (y no en la default) va a la primera que lista el backend', async () => {
    installFacade({
      campaign: { id: 10, name: 'Default' },
      campaigns: [
        { id: 10, name: 'Default', status: 'active', isDefault: true, primarySponsor: sponsor(4) },
        { id: 21, name: 'A', status: 'active', primarySponsor: sponsor(7), secondarySponsors: [sponsor(8)] },
        { id: 22, name: 'B', status: 'active', primarySponsor: sponsor(8) },
      ],
    })
    expect((await contextOf({ sponsorId: 8 })).campaign_id).toBe(21)
  })

  it('un campaigns[] malformado no rompe track(): cae a campaign.id', async () => {
    installFacade({ campaign: { id: 10, name: 'Default' }, campaigns: 'nope' })
    expect((await contextOf({ sponsorId: 8 })).campaign_id).toBe(10)

    installFacade({
      campaign: { id: 10, name: 'Default' },
      campaigns: [null, { id: 12, status: 'active', primarySponsor: sponsor(8), secondarySponsors: 'x' }, 7],
    })
    expect((await contextOf({ sponsorId: 8 })).campaign_id).toBe(12)
    expect((await contextOf({ sponsorId: 9 })).campaign_id).toBe(10)

    expect(() =>
      resolveCampaignId({ sponsorId: 8 }, { campaign: { id: 3, name: 'x' }, campaigns: [{}] as never }),
    ).not.toThrow()
  })

  it('resolveCampaignId es pura y sigue la misma cascada', () => {
    expect(resolveCampaignId({ campaignId: 1, sponsorId: 8 }, BOOT)).toBe(1)
    expect(resolveCampaignId({ sponsorId: 8 }, BOOT)).toBe(12)
    expect(resolveCampaignId({ sponsorId: 5 }, BOOT)).toBe(10)
    expect(resolveCampaignId({ sponsorId: 9 }, BOOT)).toBe(10)
    expect(resolveCampaignId({}, BOOT)).toBe(10)
    expect(resolveCampaignId({ sponsorId: 8 }, { campaign: { id: 3, name: 'x' } })).toBe(3)
    expect(resolveCampaignId({ sponsorId: 8 }, null)).toBeUndefined()
  })
})

describe('order_id coherente en purchase (cuatro emisores de vio:payment-success)', () => {
  afterEach(removeFacade)

  const fire = (detail: unknown) =>
    (globalThis as Record<string, any>).window.dispatchEvent(
      new CustomEvent('vio:payment-success', { detail }) as unknown as Event,
    )

  const purchaseAfter = async (detail: unknown, cart = fakeCart()) => {
    initVio()
    installFacade(BOOT, cart)
    const m = new AnalyticsManager()
    m.start({ host: 'custom' })
    fire(detail)
    await m.flush()
    m.stop()
    const ev = flushedBatches
      .flatMap((b) => b.events)
      .find((e) => e.name === 'purchase') as Record<string, any>
    expect(ev).toBeDefined()
    return ev
  }

  const line = (over: Partial<FakeLine> = {}): FakeLine => ({
    productId: 408948,
    name: 'Bonding Oil',
    unitPrice: 300,
    quantity: 1,
    currency: 'NOK',
    sponsorId: 4,
    ...over,
  })

  it('retorno de redirect (Vipps/Klarna/Stripe): orderId = checkout id de Vio', async () => {
    const ev = await purchaseAfter({ method: 'vipps', sponsorId: 4, orderId: 'CHK-1' })
    expect(ev.commerce.order_id).toBe('CHK-1')
    expect(ev.commerce.payment_method).toBe('vipps')
    expect(ev.context.sponsor_id).toBe(4)
    expect(ev.context.campaign_id).toBe(10)
  })

  it('confirmOrder con result de Qliro: su order.orderId es del proveedor, order_id es el checkout de Vio', async () => {
    const ev = await purchaseAfter(
      {
        method: 'qliro',
        sponsorId: 4,
        result: { order: { orderId: 3361254 }, chargedTotal: 5198 },
        checkoutId: 'CHK-2',
      },
      fakeCart({ 4: [line({ unitPrice: 4999 })] }),
    )
    expect(ev.commerce.order_id).toBe('CHK-2')
    expect(ev.commerce.value).toBe(4999) // el carrito, no lo cobrado (chargedTotal lleva envío)
  })

  it('recibo del proveedor (Walley): su orderId no cuenta, order_id es el checkout de Vio', async () => {
    const ev = await purchaseAfter({
      method: 'walley',
      sponsorId: 4,
      result: { orderId: 'W-9' },
      checkoutId: 'CHK-3',
    })
    expect(ev.commerce.order_id).toBe('CHK-3')
  })

  it('value y currency salen SIEMPRE del carrito, no del result', async () => {
    const ev = await purchaseAfter(
      {
        method: 'stripe',
        sponsorId: 4,
        result: { chargedTotal: 350, total: 999, currency: 'SEK' },
        checkoutId: 'CHK-4',
      },
      fakeCart({ 4: [line()] }),
    )
    expect(ev.commerce.order_id).toBe('CHK-4')
    expect(ev.commerce.value).toBe(300)
    expect(ev.commerce.currency).toBe('NOK')
    expect(ev.commerce.items[0].product_id).toBe('408948')
  })

  it('sin carrito ni snapshot, purchase sale sin value ni currency (nunca inventados)', async () => {
    const ev = await purchaseAfter({ method: 'nexi', sponsorId: 4, result: { chargedTotal: 350 }, checkoutId: 'CHK-5' })
    expect(ev.commerce.order_id).toBe('CHK-5')
    expect(ev.commerce.value).toBeUndefined()
    expect(ev.commerce.currency).toBeUndefined()
  })

  it('Apple Pay express desde el carrito: order_id es el de la confirmación del backend', async () => {
    const ev = await purchaseAfter(
      { method: 'apple-pay', result: { paymentMethodId: 'pm_1', confirmation: { orderId: 'ORD-77', status: 'paid' } } },
      fakeCart({ 4: [line({ unitPrice: 200, quantity: 2 })] }),
    )
    expect(ev.commerce.order_id).toBe('ORD-77')
    expect(ev.commerce.value).toBe(400)
    expect(ev.commerce.payment_method).toBe('apple-pay')
    expect(ev.context.sponsor_id).toBeUndefined()
    expect(ev.context.campaign_id).toBe(10)
  })

  it('purchaseFromPaymentSuccess es pura: solo ids de Vio, nunca del proveedor ni totales', () => {
    expect(purchaseFromPaymentSuccess({})).toEqual({})
    expect(purchaseFromPaymentSuccess({ orderId: 'A', checkoutId: 'D' })).toEqual({ orderId: 'A' })
    expect(purchaseFromPaymentSuccess({ orderId: '', checkoutId: 'D' })).toEqual({ orderId: 'D' })
    expect(
      purchaseFromPaymentSuccess({ result: { confirmation: { orderId: 42 } }, checkoutId: 'D' }),
    ).toEqual({ orderId: '42' })
    expect(
      purchaseFromPaymentSuccess({ result: { orderId: 'B', order: { orderId: 'C' } }, checkoutId: 'D' }),
    ).toEqual({ orderId: 'D' })
    expect(purchaseFromPaymentSuccess({ result: { orderId: 'B', order: { orderId: 'C' } } })).toEqual({})
    expect(purchaseFromPaymentSuccess({ checkoutId: 'D', result: null })).toEqual({ orderId: 'D' })
    expect(
      purchaseFromPaymentSuccess({ result: { total: '12.5', chargedTotal: 99, currency: 'NOK' } }),
    ).toEqual({})
  })
})

describe('X-Api-Key en el fetch de eventos', () => {
  it('manda la key en la cabecera además del body (el colector limita por key, no por IP)', async () => {
    initVio()
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }) as Response)
    vi.stubGlobal('fetch', fetchMock)

    const m = new AnalyticsManager()
    m.track('view_item')
    await m.flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ]
    expect(url).toBe('https://events.test/v1/events')
    expect(init.headers['X-Api-Key']).toBe('test-key')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body).apiKey).toBe('test-key')
  })
})

describe('slot → campaign_id (ADR-0027): explícito → slot → sponsor → default', () => {
  afterEach(removeFacade)

  /** `campaigns[].slots[]` como lo manda el micro: solo ventanas abiertas. */
  const SLOT_BOOT: BootstrapResponse = {
    campaign: { id: 10, name: 'Default' },
    primarySponsor: sponsor(4),
    secondarySponsors: [sponsor(5)],
    campaigns: [
      {
        id: 12,
        name: 'Newer',
        status: 'active',
        primarySponsor: sponsor(7),
        secondarySponsors: [sponsor(8)],
        slots: [
          { name: 'hero', platform: null },
          { name: 'sidebar', platform: 'vev' },
        ],
      },
      {
        id: 10,
        name: 'Default',
        status: 'active',
        isDefault: true,
        primarySponsor: sponsor(4),
        secondarySponsors: [sponsor(5)],
        slots: [],
      },
      { id: 13, name: 'Paused', status: 'paused', primarySponsor: sponsor(9), slots: [{ name: 'footer' }] },
    ],
  }

  const contextOf = async (context: Record<string, unknown>) => {
    initVio()
    const m = new AnalyticsManager()
    m.track('view_item', { context })
    await m.flush()
    return (flushedBatches.at(-1)!.events.at(-1)!.context ?? {}) as Record<string, unknown>
  }

  it('la campaña asignada al slot gana sobre la regla del sponsor', () => {
    // El sponsor 4 diría 10 (default); el slot `hero` está asignado a 12.
    expect(resolveCampaignId({ slot: 'hero', sponsorId: 4 }, SLOT_BOOT)).toBe(12)
    expect(resolveCampaignId({ slot: 'hero' }, SLOT_BOOT)).toBe(12)
  })

  it('el campaignId explícito sigue ganando sobre el slot', () => {
    expect(resolveCampaignId({ campaignId: 99, slot: 'hero', sponsorId: 4 }, SLOT_BOOT)).toBe(99)
  })

  it('un slot sin asignación vigente cae a la regla del sponsor, y sin sponsor al default', () => {
    expect(resolveCampaignId({ slot: 'unknown', sponsorId: 8 }, SLOT_BOOT)).toBe(12)
    expect(resolveCampaignId({ slot: 'unknown' }, SLOT_BOOT)).toBe(10)
    // `footer` solo está en una campaña pausada: no cuenta.
    expect(resolveCampaignId({ slot: 'footer', sponsorId: 8 }, SLOT_BOOT)).toBe(12)
    expect(resolveCampaignId({ slot: 'footer' }, SLOT_BOOT)).toBe(10)
    expect(resolveCampaignId({ slot: '' , sponsorId: 8 }, SLOT_BOOT)).toBe(12)
  })

  it('respeta la plataforma de Vio.init: una asignación solo-vev no aplica en web', () => {
    Configuration.init({ apiKey: 'k', eventsBase: 'https://events.test', platform: 'web' })
    expect(resolveCampaignId({ slot: 'sidebar' }, SLOT_BOOT)).toBe(10)
    Configuration.init({ apiKey: 'k', eventsBase: 'https://events.test', platform: 'vev' })
    expect(resolveCampaignId({ slot: 'sidebar' }, SLOT_BOOT)).toBe(12)
    Configuration.reset()
    // Sin init no hay plataforma: cualquier asignación cuenta.
    expect(resolveCampaignId({ slot: 'sidebar' }, SLOT_BOOT)).toBe(12)
  })

  it('unos slots[] malformados no rompen track()', () => {
    const boot = {
      campaign: { id: 3, name: 'D' },
      campaigns: [
        { id: 4, status: 'active', slots: 'x' },
        { id: 5, status: 'active', slots: [null, 7, { name: 'hero', startDate: 'bad', endDate: {} }] },
      ],
    } as unknown as BootstrapResponse
    expect(() => resolveCampaignId({ slot: 'hero' }, boot)).not.toThrow()
    expect(resolveCampaignId({ slot: 'hero' }, boot)).toBe(5)
    expect(resolveCampaignId({ slot: 'hero' }, { campaign: { id: 3, name: 'D' }, campaigns: 'nope' } as never)).toBe(3)
    expect(resolveCampaignId({ slot: 'hero' }, null)).toBeUndefined()
  })

  it('en el cable: campaign_id del slot y location_id = slot salvo locationId explícito', async () => {
    installFacade(SLOT_BOOT)
    const ctx = await contextOf({ slot: 'hero', sponsorId: 4 })
    expect(ctx.campaign_id).toBe(12)
    expect(ctx.location_id).toBe('hero')
    expect(ctx.sponsor_id).toBe(4)
    const explicit = await contextOf({ slot: 'hero', locationId: 'carousel-top' })
    expect(explicit.location_id).toBe('carousel-top')
    expect(explicit.campaign_id).toBe(12)
    const none = await contextOf({ sponsorId: 4 })
    expect(none.location_id).toBeUndefined()
  })

  it('los eventos vio:* de los componentes llevan el slot al contexto', async () => {
    installFacade(SLOT_BOOT)
    initVio()
    const m = new AnalyticsManager()
    m.start({ host: 'custom' })
    const win = (globalThis as Record<string, unknown> as { window: Window }).window
    win.dispatchEvent(
      new CustomEvent('vio:product-click', {
        detail: { productId: 408948, sponsorId: 4, name: 'Bonding Oil', price: 300, slot: 'hero' },
      }) as unknown as Event,
    )
    win.dispatchEvent(
      new CustomEvent('vio:added-to-cart', { detail: { productId: 408948, sponsorId: 4, slot: 'hero' } }) as unknown as Event,
    )
    win.dispatchEvent(
      new CustomEvent('vio:checkout-open', { detail: { sponsorId: 4, slot: ' hero ' } }) as unknown as Event,
    )
    win.dispatchEvent(
      new CustomEvent('vio:checkout-open', { detail: { sponsorId: 4, slot: 7 } }) as unknown as Event,
    )
    await m.flush()
    const events = flushedBatches.flatMap((b) => b.events)
    const byName = (name: string) =>
      events.filter((e) => e.name === name).map((e) => e.context as Record<string, unknown>)
    expect(byName('select_item')[0]).toMatchObject({ campaign_id: 12, location_id: 'hero', sponsor_id: 4 })
    expect(byName('add_to_cart')[0]).toMatchObject({ campaign_id: 12, location_id: 'hero' })
    expect(byName('begin_checkout')[0]).toMatchObject({ campaign_id: 12, location_id: 'hero' })
    // Un slot que no es string se ignora: cae a la regla del sponsor (4 → default).
    expect(byName('begin_checkout')[1]).toMatchObject({ campaign_id: 10 })
    expect(byName('begin_checkout')[1]!.location_id).toBeUndefined()
    m.stop()
  })
})
