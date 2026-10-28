/**
 * The collector's caps (vio-analytics `src/contract/analytics-schema.ts`),
 * mirrored here: an event over them is REJECTED WHOLE, silently (202 with
 * `rejected`), so the SDK must never send one. `buildEvent` is the one choke
 * point: long ids fall back to the next content candidate or are omitted,
 * titles are cut.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Configuration } from '../configuration.js'
import { AnalyticsManager } from './analytics-manager.js'

/** The limits of `analyticsContextSchema` / the top level that the SDK can hit. */
const CONTEXT_CAPS: Record<string, number> = {
  broadcast_id: 64,
  location_id: 128,
  component_template_id: 128,
  content_url: 2_048,
  content_title: 255,
  content_id: 128,
  error_code: 64,
  variant: 64,
}

/** Throws like the collector's zod would reject. */
function assertCollectorCaps(event: Record<string, unknown>): void {
  const ctx = (event.context ?? {}) as Record<string, unknown>
  for (const [field, max] of Object.entries(CONTEXT_CAPS)) {
    const v = ctx[field]
    if (typeof v === 'string' && v.length > max) {
      throw new Error(`context.${field} is ${v.length} chars, max ${max}`)
    }
  }
  const commerce = (event.commerce ?? {}) as Record<string, unknown>
  if (typeof commerce.order_id === 'string' && commerce.order_id.length > 128) throw new Error('order_id > 128')
  // New in 0.27 (optional in the collector; one that predates it strips the key — `.strip()` — and keeps the event).
  if (typeof commerce.checkout_id === 'string' && commerce.checkout_id.length > 128) throw new Error('checkout_id > 128')
  if (typeof commerce.payment_method === 'string' && commerce.payment_method.length > 64) throw new Error('payment_method > 64')
  if (typeof commerce.buyer_id === 'string' && commerce.buyer_id.length > 128) throw new Error('buyer_id > 128')
  const client = (event.client ?? {}) as Record<string, unknown>
  for (const [field, max] of Object.entries(CLIENT_CAPS)) {
    const v = client[field]
    if (typeof v === 'string' && v.length > max) throw new Error(`client.${field} is ${v.length} chars, max ${max}`)
  }
  for (const field of ['screen_w', 'screen_h']) {
    const v = client[field]
    if (v !== undefined && (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 65_535)) {
      throw new Error(`client.${field} is not an int in 0..65535`)
    }
  }
}

/** The limits of `analyticsClientSchema`. */
const CLIENT_CAPS: Record<string, number> = {
  language: 16,
  referrer: 2_048,
  utm_source: 128,
  utm_medium: 128,
  utm_campaign: 128,
  utm_term: 128,
  utm_content: 128,
  tz: 64,
}

const flushed: Array<{ events: Array<Record<string, unknown>> }> = []
let doc: { title: string; querySelector: (sel: string) => { getAttribute: (n: string) => string | null } | null }
let loc: { href: string; pathname: string; search: string }
let metas: Record<string, string>

beforeEach(() => {
  flushed.length = 0
  metas = {}
  doc = {
    title: 'Title',
    querySelector: (sel: string) => (metas[sel] ? { getAttribute: () => metas[sel]! } : null),
  }
  loc = { href: 'https://host.example/a', pathname: '/a', search: '' }
  const g = globalThis as Record<string, unknown>
  g.window = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    location: loc,
  }
  g.location = loc
  g.document = doc
  delete g.__VIO_FACADE__
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      flushed.push(JSON.parse(init.body))
      return { ok: true, status: 202 } as Response
    }),
  )
  Configuration.reset()
  Configuration.init({ apiKey: 'k', eventsBase: 'https://events.test' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  Configuration.reset()
  const g = globalThis as Record<string, unknown>
  delete g.window
  delete g.location
  delete g.document
})

async function tracked(context: Record<string, unknown> = {}) {
  const m = new AnalyticsManager()
  m.track('view_item', { context })
  await m.flush()
  const ev = flushed.at(-1)!.events.at(-1)!
  assertCollectorCaps(ev)
  return ev.context as Record<string, unknown>
}

describe('buildEvent never sends what the collector rejects', () => {
  it('a 146-char pathname: content_id is omitted, the event passes', async () => {
    loc.pathname = '/' + 'a'.repeat(145)
    const ctx = await tracked()
    expect(ctx.content_id).toBeUndefined()
    expect(ctx.content_title).toBe('Title')
  })

  it('a long pathname but a canonical that fits: the canonical is the id', async () => {
    loc.pathname = '/' + 'a'.repeat(145)
    metas['link[rel="canonical"]'] = 'https://host.example/sport/42'
    expect((await tracked()).content_id).toBe('https://host.example/sport/42')
  })

  it('an explicit contentId over 128 chars falls back to the next candidate (meta → canonical → pathname)', async () => {
    metas['meta[name="vio:content-id"]'] = 'meta-7'
    expect((await tracked({ contentId: 'x'.repeat(129) })).content_id).toBe('meta-7')
    delete metas['meta[name="vio:content-id"]']
    expect((await tracked({ contentId: 'x'.repeat(129) })).content_id).toBe('/a')
    loc.pathname = '/' + 'a'.repeat(145)
    expect((await tracked({ contentId: 'x'.repeat(129) })).content_id).toBeUndefined()
    expect((await tracked({ contentId: 'x'.repeat(128) })).content_id).toHaveLength(128)
  })

  it('a location_id / slot over 128 chars is omitted; a title over 255 is cut', async () => {
    const ctx = await tracked({ slot: 's'.repeat(129), contentTitle: 't'.repeat(300) })
    expect(ctx.location_id).toBeUndefined()
    expect(ctx.content_title).toHaveLength(255)
    const ok = await tracked({ locationId: 'l'.repeat(128) })
    expect(ok.location_id).toHaveLength(128)
    doc.title = 'd'.repeat(400)
    expect((await tracked()).content_title).toHaveLength(255)
  })

  it('an over-long explicit locationId gives way to the slot when that fits', async () => {
    expect((await tracked({ locationId: 'l'.repeat(200), slot: 'carousel-1' })).location_id).toBe('carousel-1')
    expect((await tracked({ locationId: 'l'.repeat(200), slot: 's'.repeat(200) })).location_id).toBeUndefined()
  })

  it('content_url is cut to 2 048 — the query string first, else the URL itself', async () => {
    loc.href = 'https://host.example/a?' + 'q'.repeat(3_000)
    expect((await tracked()).content_url).toBe('https://host.example/a')
    loc.href = 'https://host.example/' + 'p'.repeat(3_000) + '#x'
    expect((await tracked()).content_url).toHaveLength(2_048)
    expect((await tracked({ contentUrl: 'https://host.example/short?x=1' })).content_url).toBe('https://host.example/short?x=1')
  })
})

describe('checkout_id respects the cap the collector gives it', () => {
  it('a uuid travels; anything over 128 chars is omitted, not cut — the event still goes', async () => {
    const m = new AnalyticsManager()
    m.track('purchase', { commerce: { orderId: '4415', checkoutId: '0b6f3c1e-2d4a-4f5b-9c8d-7e6f5a4b3c2d' } })
    m.track('purchase', { commerce: { orderId: '4416', checkoutId: 'c'.repeat(129) } })
    await m.flush()
    const [a, b] = flushed.at(-1)!.events.filter((e) => e.name === 'purchase')
    for (const ev of [a!, b!]) assertCollectorCaps(ev)
    expect((a!.commerce as Record<string, unknown>).checkout_id).toBe('0b6f3c1e-2d4a-4f5b-9c8d-7e6f5a4b3c2d')
    expect(b!.commerce as Record<string, unknown>).not.toHaveProperty('checkout_id')
    expect((b!.commerce as Record<string, unknown>).order_id).toBe('4416')
  })
})

describe('the client block and buyer_id respect the caps too', () => {
  it('referrer 2048, utm 128, language 16, tz 64, screen ints; buyer_id over 128 is omitted, not cut', async () => {
    vi.stubGlobal('navigator', { language: 'l'.repeat(40) })
    vi.stubGlobal('screen', { width: 1e9, height: 10.6 })
    ;(doc as Record<string, unknown>).referrer = 'https://r.example/' + 'p'.repeat(3_000)
    loc.search = '?utm_source=' + 's'.repeat(500) + '&utm_content=c'
    const m = new AnalyticsManager()
    m.track('purchase', { commerce: { orderId: 'o', buyerId: 'b'.repeat(129) } })
    await m.flush()
    const ev = flushed.at(-1)!.events.at(-1)!
    assertCollectorCaps(ev)
    const client = ev.client as Record<string, unknown>
    expect(client.language).toHaveLength(16)
    expect(client.referrer).toHaveLength(2_048)
    expect(client.utm_source).toHaveLength(128)
    expect(client.utm_content).toBe('c')
    expect(client.screen_w).toBe(65_535)
    expect(client.screen_h).toBe(10)
    expect((ev.commerce as Record<string, unknown>).buyer_id).toBeUndefined()
  })
})
