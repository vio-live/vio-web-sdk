/**
 * `cta_click` (README «Button tracking»): the wire contract shared with the
 * collector, `trackCta` validation, and the pipeline rules every event obeys
 * (started, consent, privateContent, internal traffic).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Configuration } from '../configuration.js'
import { AnalyticsManager } from './analytics-manager.js'
import { ctaContextOf, ctaText } from './cta.js'

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
  ;(g.window as Record<string, unknown>).location = { href: 'https://host.example/article', search: '' }
  g.location = (g.window as Record<string, unknown>).location
  g.document = { title: 'Sneakers 2026 — trendy' }
  return { store }
}

let store: Map<string, string>
const sent: Array<Record<string, any>> = []
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  store = installFakeDom().store
  sent.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(...JSON.parse(init.body).events)
      return { ok: true, status: 202 } as Response
    }),
  )
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  Configuration.reset()
  Configuration.init({ apiKey: 'test-key', eventsBase: 'https://events.test' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Configuration.reset()
  const g = globalThis as Record<string, unknown>
  delete g.window
  delete g.location
  delete g.document
})

async function ctaEvents(m: AnalyticsManager) {
  await m.flush()
  m.stop()
  return sent.filter((e) => e.name === 'cta_click')
}

describe('the wire (context of cta_click)', () => {
  it('every field of the contract, in context; the product variant apart from the layout\'s experiment variant', async () => {
    const m = new AnalyticsManager()
    m.start({ host: 'replit' })
    m.trackCta({
      cta: 'add_to_cart',
      location: 'detail',
      label: 'Legg i handlekurv',
      optionValue: 'M',
      productId: 9,
      productVariantId: 102,
      sponsorId: 4,
      campaignId: 31,
      slot: 'feed-1',
      contentId: 'art-77',
      componentTemplateId: 'product-detail',
      layout: { layoutId: 'size-first', layoutRevision: '3', experimentId: 'exp-1', variantId: 'b' },
    })
    const [ev] = await ctaEvents(m)
    expect(ev).toBeDefined()
    expect(ev!.commerce).toBeUndefined()
    expect(ev!.context).toMatchObject({
      cta: 'add_to_cart',
      cta_location: 'detail',
      cta_label: 'Legg i handlekurv',
      option_value: 'M',
      product_id: '9',
      product_variant_id: '102',
      sponsor_id: 4,
      campaign_id: 31,
      location_id: 'feed-1',
      content_id: 'art-77',
      component_template_id: 'product-detail',
      layout_id: 'size-first',
      layout_revision: '3',
      experiment_id: 'exp-1',
      variant_id: 'b',
      content_url: 'https://host.example/article',
    })
    expect(ev!.context.cta_variant).toBeUndefined()
  })

  it('a host\'s block: location block, its label and the button option it tests', async () => {
    const m = new AnalyticsManager()
    m.start()
    for (const cta of ['size', 'add_to_cart', 'choose_size', 'description_open', 'vipps', 'open']) {
      m.trackCta({ cta, location: 'block', label: 'Velg størrelse', variant: 'outline-velg', optionValue: cta === 'size' ? '42' : undefined, productId: '9' })
    }
    const evs = await ctaEvents(m)
    expect(evs.map((e) => e.context.cta)).toEqual(['size', 'add_to_cart', 'choose_size', 'description_open', 'vipps', 'open'])
    for (const e of evs) expect(e.context).toMatchObject({ cta_location: 'block', cta_label: 'Velg størrelse', cta_variant: 'outline-velg', product_id: '9' })
    expect(evs[0]!.context.option_value).toBe('42')
    expect(evs[1]!.context.option_value).toBeUndefined()
  })

  it('location defaults to host', async () => {
    const m = new AnalyticsManager()
    m.start()
    m.trackCta({ cta: 'buy' })
    const [ev] = await ctaEvents(m)
    expect(ev!.context.cta_location).toBe('host')
  })

  it('no layout, no layout fields; sponsor/campaign 0 = not said', async () => {
    const m = new AnalyticsManager()
    m.start()
    m.trackCta({ cta: 'open', location: 'card', productId: 9, sponsorId: 0, campaignId: '' })
    const [ev] = await ctaEvents(m)
    for (const k of ['layout_id', 'layout_revision', 'experiment_id', 'variant_id', 'sponsor_id', 'product_variant_id']) {
      expect(ev!.context[k]).toBeUndefined()
    }
  })
})

describe('validation', () => {
  it.each([[''], ['Add To Cart'], ['add to cart'], ['a'.repeat(65)], [undefined], [42], ['kjøp']])(
    'an invalid cta (%j) sends nothing, with one console.warn',
    async (cta) => {
      const m = new AnalyticsManager()
      m.start()
      m.trackCta({ cta } as any)
      expect(await ctaEvents(m)).toHaveLength(0)
      expect(warn).toHaveBeenCalledTimes(1)
    },
  )

  it('the ids accept [a-z0-9_.:-] up to 64', () => {
    expect(ctaContextOf({ cta: 'pay_apple_pay' })?.cta).toBe('pay_apple_pay')
    expect(ctaContextOf({ cta: 'hero.v2:kjop-1' })?.cta).toBe('hero.v2:kjop-1')
    expect(ctaContextOf({ cta: 'a'.repeat(64) })?.cta).toHaveLength(64)
  })

  it('an unknown location is sent as host, with a warning', () => {
    expect(ctaContextOf({ cta: 'buy', location: 'sidebar' })?.ctaLocation).toBe('host')
    expect(warn).toHaveBeenCalledTimes(1)
    for (const location of ['detail', 'cart', 'card', 'checkout', 'host', 'block']) {
      expect(ctaContextOf({ cta: 'buy', location })?.ctaLocation).toBe(location)
    }
  })

  it('an invalid variant is left out, with a warning; the event still goes', () => {
    const ctx = ctaContextOf({ cta: 'buy', variant: 'bar kjøp' })
    expect(ctx?.cta).toBe('buy')
    expect(ctx?.ctaVariant).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(ctaContextOf({ cta: 'buy', variant: 'Bar-Kjop_2.b:x' })?.ctaVariant).toBe('Bar-Kjop_2.b:x')
  })

  it('the label: trimmed, whitespace collapsed, control characters out, cut to 64 — never inside an emoji', () => {
    expect(ctaText('  Kjøp  nå\n med\tVipps ')).toBe('Kjøp nå med Vipps')
    expect(ctaText('a'.repeat(80))).toHaveLength(64)
    const cut = ctaText('a'.repeat(63) + '😀')!
    expect(cut).toBe('a'.repeat(63))
    expect(ctaText('   ')).toBeUndefined()
    expect(ctaText(undefined)).toBeUndefined()
  })

  it('an id over the collector\'s 128 is left out, not cut', () => {
    expect(ctaContextOf({ cta: 'open', productId: 'x'.repeat(129) })?.productId).toBeUndefined()
  })
})

describe('the pipeline rules of every event', () => {
  it('nothing before start(): trackCta and the DOM event are both ignored', async () => {
    const m = new AnalyticsManager()
    m.trackCta({ cta: 'open', location: 'card' })
    window.dispatchEvent(new CustomEvent('vio:cta-click', { detail: { cta: 'open', location: 'card' } }))
    await m.flush()
    expect(sent).toHaveLength(0)
  })

  it('once started, ONE vio:cta-click is ONE cta_click', async () => {
    const m = new AnalyticsManager()
    m.start()
    window.dispatchEvent(new CustomEvent('vio:cta-click', { detail: { cta: 'vipps', location: 'cart', sponsorId: 4, label: 'Betal med Vipps' } }))
    const evs = await ctaEvents(m)
    expect(evs).toHaveLength(1)
    expect(evs[0]!.context).toMatchObject({ cta: 'vipps', cta_location: 'cart', sponsor_id: 4, cta_label: 'Betal med Vipps' })
  })

  it('autoTrack: false (a host with its own choke point) hears no vio:cta-click; its own trackCta still goes', async () => {
    const m = new AnalyticsManager()
    m.start({ autoTrack: false })
    window.dispatchEvent(new CustomEvent('vio:cta-click', { detail: { cta: 'vipps', location: 'cart' } }))
    m.trackCta({ cta: 'add_to_cart', location: 'host' })
    const evs = await ctaEvents(m)
    expect(evs.map((e) => e.context.cta)).toEqual(['add_to_cart'])
  })

  it('privateContent: no label, no option value, no content — the id and the place still go', async () => {
    const m = new AnalyticsManager()
    m.start({ privateContent: true })
    m.trackCta({ cta: 'size', location: 'detail', label: 'M', optionValue: 'M', productId: 9, contentId: 'art-77', contentTitle: 'Artikkel' })
    const [ev] = await ctaEvents(m)
    expect(ev!.context).toMatchObject({ cta: 'size', cta_location: 'detail', product_id: '9' })
    for (const k of ['cta_label', 'option_value', 'content_id', 'content_url', 'content_title']) {
      expect(ev!.context[k]).toBeUndefined()
    }
  })

  it('requireConsent without consent: measured with ephemeral ids, nothing written on the device', async () => {
    const m = new AnalyticsManager()
    m.start({ requireConsent: true })
    m.trackCta({ cta: 'open', location: 'card' })
    const evs = await ctaEvents(m)
    expect(evs).toHaveLength(1)
    expect(store.size).toBe(0)
  })

  it('internal traffic keeps its flag (client.internal)', async () => {
    const m = new AnalyticsManager()
    m.setInternal(true)
    m.start()
    m.trackCta({ cta: 'open', location: 'card' })
    const [ev] = await ctaEvents(m)
    expect(ev!.client?.internal).toBe(true)
  })

  it('the contract caps: every cta field within 64', async () => {
    const m = new AnalyticsManager()
    m.start()
    m.trackCta({ cta: 'a'.repeat(64), location: 'block', label: 'L'.repeat(200), optionValue: 'O'.repeat(200), variant: 'v'.repeat(64) })
    const [ev] = await ctaEvents(m)
    for (const k of ['cta', 'cta_label', 'option_value', 'cta_variant']) expect(String(ev!.context[k]).length).toBeLessThanOrEqual(64)
  })
})
