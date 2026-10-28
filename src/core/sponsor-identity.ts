/**
 * Who sells — the sponsor's (brand's) display identity: its name and logo.
 *
 * ONE rule for every place that names a sponsor (the product detail, the
 * carousel's retailer line, the cart, the checkout header, the confirmation,
 * the payment event and `getOrderReference`): the bootstrap's sponsor block —
 * the config's primary and secondaries, then every `campaigns[]` primary and
 * secondaries, first match — and, when the bootstrap does not know the id,
 * what this tab remembered of the checkout, then the cart's `sponsorName`.
 *
 * In a checkout and on its confirmation the sponsor is the CHECKOUT's (the
 * cart's sponsor, the one the order is with), never the page's attribution:
 * an article of brand A may sell a product of brand B.
 *
 * Pure helpers and a tiny per-checkout memory in `sessionStorage`; no DOM.
 */

import type { BootstrapResponse, Sponsor } from './types.js'

/** What a sponsor looks like to a shopper. `name` is the brand's display name. */
export interface SponsorIdentity {
  id: number
  name: string
  /** The brand's logo, as the bootstrap gives it (never rewritten); `null` when it has none. */
  logoUrl: string | null
  avatarUrl: string | null
  /** The brand's purchase terms page — https only; `null` when it has none. */
  termsUrl?: string | null
  /** The brand's returns / refund policy page — https only; `null` when it has none. */
  refundPolicyUrl?: string | null
}

/** The sponsor of a checkout / an order as events and `getOrderReference` carry it. */
export type CheckoutSponsor = Pick<SponsorIdentity, 'id' | 'name' | 'logoUrl'>

/** `sessionStorage` key of the per-checkout memory. */
export const CHECKOUT_SPONSOR_STORAGE_KEY = 'vio.checkoutSponsor.v1'
/** How many checkouts the memory keeps (the most recent). */
export const CHECKOUT_SPONSOR_MEMORY_MAX = 20

/** A positive integer id, from a number or a numeric string; `undefined` otherwise. */
export function toSponsorId(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** A non-empty string, trimmed; `null` for anything else (an empty `logoUrl` is no logo). */
function urlOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return v ? v : null
}

/** A page link the shopper will open: an absolute https URL, or nothing. */
function pageUrlOrNull(value: unknown): string | null {
  const v = urlOrNull(value)
  if (!v) return null
  try {
    return new URL(v).protocol === 'https:' ? v : null
  } catch {
    return null
  }
}

function nameOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The sponsor block of `sponsorId` in a bootstrap: the config's
 * `primarySponsor`, its `secondarySponsors`, then every `campaigns[]` entry's
 * primary and secondaries — the first match. Tolerates any shape.
 */
export function findSponsorIn(
  boot: BootstrapResponse | null | undefined,
  sponsorId: number | string | null | undefined,
): Sponsor | undefined {
  const id = toSponsorId(sponsorId)
  if (id === undefined || !boot || typeof boot !== 'object') return undefined
  const match = (s: unknown): s is Sponsor =>
    !!s && typeof s === 'object' && Number((s as { id?: unknown }).id) === id
  if (match(boot.primarySponsor)) return boot.primarySponsor
  const secondary = Array.isArray(boot.secondarySponsors) ? boot.secondarySponsors.find(match) : undefined
  if (secondary) return secondary
  // A sponsor may live only in a non-default campaign (the one a slot shows).
  const campaigns = Array.isArray(boot.campaigns) ? boot.campaigns : []
  for (const c of campaigns) {
    if (!c || typeof c !== 'object') continue
    if (match(c.primarySponsor)) return c.primarySponsor
    const s = Array.isArray(c.secondarySponsors) ? c.secondarySponsors.find(match) : undefined
    if (s) return s
  }
  return undefined
}

/**
 * The identity of a sponsor from a bootstrap (`findSponsorIn`): its trimmed
 * name and its logo / avatar URLs as given (an empty string is `null`).
 * `null` when the bootstrap does not know the id, or the block says neither
 * a name nor a logo. Pure, never throws.
 */
export function sponsorIdentityFrom(
  boot: BootstrapResponse | null | undefined,
  sponsorId: number | string | null | undefined,
): SponsorIdentity | null {
  try {
    const id = toSponsorId(sponsorId)
    if (id === undefined) return null
    const sponsor = findSponsorIn(boot, id)
    if (!sponsor) return null
    const name = nameOf(sponsor.name)
    const logoUrl = urlOrNull(sponsor.logoUrl)
    if (!name && !logoUrl) return null
    // The brand's pages only when it gave them: an identity without them keeps its shape.
    const termsUrl = pageUrlOrNull((sponsor as { termsUrl?: unknown }).termsUrl)
    const refundPolicyUrl = pageUrlOrNull((sponsor as { refundPolicyUrl?: unknown }).refundPolicyUrl)
    return {
      id,
      name,
      logoUrl,
      avatarUrl: urlOrNull(sponsor.avatarUrl),
      ...(termsUrl ? { termsUrl } : {}),
      ...(refundPolicyUrl ? { refundPolicyUrl } : {}),
    }
  } catch {
    return null
  }
}

/** The event / order-reference shape of an identity (`{ id, name, logoUrl }`). */
export function checkoutSponsorOf(identity: SponsorIdentity | CheckoutSponsor | null | undefined): CheckoutSponsor | undefined {
  if (!identity) return undefined
  return { id: identity.id, name: identity.name, logoUrl: identity.logoUrl ?? null }
}

// MARK: - Per-checkout memory

/** What this tab remembers of a checkout: whose it is, and how that sponsor looked then. */
export interface RememberedCheckoutSponsor {
  checkoutId: string
  sponsorId: number
  name: string
  logoUrl: string | null
}

/**
 * Same-page fallback when `sessionStorage` is unavailable (private mode, a
 * sandboxed iframe): the memory still serves the page it was written on.
 */
let inMemory: RememberedCheckoutSponsor[] = []
/** A write to `sessionStorage` failed on this page (quota, blocked): read the in-page copy from then on. */
let storageRefusedWrite = false

function sessionStore(): Storage | null {
  try {
    const s = (globalThis as { sessionStorage?: Storage }).sessionStorage
    return s && typeof s.getItem === 'function' && typeof s.setItem === 'function' ? s : null
  } catch {
    return null
  }
}

function normalizeEntry(raw: unknown): RememberedCheckoutSponsor | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const checkoutId = typeof r.checkoutId === 'string' ? r.checkoutId.trim() : ''
  const sponsorId = toSponsorId(r.sponsorId)
  if (!checkoutId || sponsorId === undefined) return null
  return { checkoutId, sponsorId, name: nameOf(r.name), logoUrl: urlOrNull(r.logoUrl) }
}

function readEntries(): RememberedCheckoutSponsor[] {
  const store = storageRefusedWrite ? null : sessionStore()
  if (store) {
    try {
      const raw = store.getItem(CHECKOUT_SPONSOR_STORAGE_KEY)
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeEntry).filter((e): e is RememberedCheckoutSponsor => e !== null)
      }
    } catch {
      /* unreadable or blocked: fall back to what this page wrote */
    }
  }
  return inMemory.slice()
}

function writeEntries(entries: RememberedCheckoutSponsor[]): void {
  inMemory = entries.slice()
  const store = sessionStore()
  if (!store) return
  try {
    store.setItem(CHECKOUT_SPONSOR_STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Quota / blocked: the in-page copy serves this page from now on.
    storageRefusedWrite = true
  }
}

/**
 * Remember whose checkout `checkoutId` is (and the sponsor's name and logo as
 * known now), so the confirmation after a redirect (Vipps, Stripe) or a
 * reload can still name the brand when the bootstrap is late or the cart is
 * already cleared. The last 20 checkouts are kept, most recent last; a name
 * already remembered is not replaced by an empty one. Never throws.
 */
export function rememberCheckoutSponsor(
  checkoutId: string | null | undefined,
  sponsor: { sponsorId: number | string | null | undefined; name?: string | null; logoUrl?: string | null },
): void {
  try {
    const id = typeof checkoutId === 'string' ? checkoutId.trim() : ''
    const sponsorId = toSponsorId(sponsor?.sponsorId)
    if (!id || sponsorId === undefined) return
    const entries = readEntries()
    const previous = entries.find((e) => e.checkoutId === id)
    let name = nameOf(sponsor.name)
    let logoUrl = urlOrNull(sponsor.logoUrl)
    if (previous && previous.sponsorId === sponsorId && !name && !logoUrl) {
      name = previous.name
      logoUrl = previous.logoUrl
    }
    const next = entries.filter((e) => e.checkoutId !== id)
    next.push({ checkoutId: id, sponsorId, name, logoUrl })
    writeEntries(next.slice(-CHECKOUT_SPONSOR_MEMORY_MAX))
  } catch {
    /* memory is a convenience — never a failure */
  }
}

/** What this tab remembers of a checkout, or `null`. Never throws. */
export function rememberedCheckoutSponsor(checkoutId: string | null | undefined): RememberedCheckoutSponsor | null {
  try {
    const id = typeof checkoutId === 'string' ? checkoutId.trim() : ''
    if (!id) return null
    return readEntries().find((e) => e.checkoutId === id) ?? null
  } catch {
    return null
  }
}

/** The most recent remembered checkout of a sponsor that names it, or `null`. Never throws. */
export function rememberedSponsor(sponsorId: number | string | null | undefined): RememberedCheckoutSponsor | null {
  try {
    const id = toSponsorId(sponsorId)
    if (id === undefined) return null
    const entries = readEntries()
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!
      if (e.sponsorId === id && (e.name || e.logoUrl)) return e
    }
    return null
  } catch {
    return null
  }
}

/** For tests: forget the in-page copy (storage is the test's own). */
export function resetCheckoutSponsorMemory(): void {
  inMemory = []
  storageRefusedWrite = false
}
