/**
 * The `client` block — the standard context of the visit (EVENTS_CONTRACT
 * "client", 2026-10-19): language, where the session landed from (the
 * referrer and `utm_*` of the LANDING page, remembered for the session),
 * screen size and time zone. What the collector derives from the request
 * itself — device type, OS, browser, country — is NOT sent: no User-Agent
 * parsing here, no duplicate of what the server knows better.
 *
 * Pure like `content.ts`: everything takes the globals it reads (defaults to
 * the real ones), never throws, and answers `{}` where there is no browser
 * (SSR, old engines). Capped to the collector's limits in ONE place: an
 * over-long value is cut — none of these is an identity, so a cut referrer
 * is still the right dimension.
 *
 * Landing memory: the first page of a session writes its referrer and utm
 * parameters to `sessionStorage`; later pages read them back, so an event on
 * page three still says the visit came from the newsletter — their own
 * `document.referrer` (an internal page) is never a source. The referrer is
 * kept as origin + path (no query, no fragment: a referrer's query is its
 * tracking tail, not where the visit came from) and dropped altogether when
 * it is this same host (a self-referral says nothing about the entry). A URL
 * with utm parameters is a new landing (another campaign click) that replaces
 * the memory — unless it was reached from this same host, i.e. an internal
 * link that propagates utm, which keeps the landing that was. Without
 * storage, or without consent to persist, each page stands alone.
 */

export interface ClientContext {
  language?: string
  referrer?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  utm_term?: string
  utm_content?: string
  screen_w?: number
  screen_h?: number
  tz?: string
}

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const
export type UtmKey = (typeof UTM_KEYS)[number]

/** The collector's caps (vio-analytics `analytics-schema.ts`, `analyticsClientSchema`). */
export const CLIENT_LANGUAGE_MAX_LENGTH = 16
export const CLIENT_REFERRER_MAX_LENGTH = 2_048
export const CLIENT_UTM_MAX_LENGTH = 128
export const CLIENT_TZ_MAX_LENGTH = 64
export const CLIENT_SCREEN_MAX = 65_535
/** Commerce's cap for the landing page on the order's entry context (`entry.landing_url`, ADR-0035). */
export const CLIENT_LANDING_URL_MAX_LENGTH = 2_048

/** Where the session remembers its landing (per tab, like the browser's own session). */
export const LANDING_KEY = 'vio.landing.v1'

/**
 * What a session remembers of the page it landed on. `url` is the landing
 * page itself — origin + path, like the referrer: no query (the utm are kept
 * apart, the rest is a tracking tail), no fragment — for the order's entry
 * context; the events do not carry it (the collector derives the landing).
 */
export interface Landing {
  referrer?: string
  utm?: Partial<Record<UtmKey, string>>
  url?: string
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

/** The globals the block is read from — injectable for tests; defaults to the real ones. */
export interface ClientEnvironment {
  navigator?: { language?: unknown } | null
  document?: { referrer?: unknown } | null
  location?: { search?: unknown; host?: unknown; href?: unknown } | null
  screen?: { width?: unknown; height?: unknown } | null
  /** The session memory for the landing; `null` = none (SSR, private mode, blocked). */
  storage?: StorageLike | null
  /** The time zone; defaults to `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  timeZone?: () => unknown
}

export function defaultClientEnvironment(): ClientEnvironment {
  return {
    navigator: typeof navigator !== 'undefined' ? navigator : null,
    document: typeof document !== 'undefined' ? document : null,
    location: typeof location !== 'undefined' ? location : null,
    screen: typeof screen !== 'undefined' ? screen : null,
    storage: sessionStorageOrNull(),
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

/**
 * The landing of this session: what is remembered — unless this page is a
 * landing itself (utm parameters in its URL, reached from outside this host)
 * or nothing is remembered yet, when this page's referrer and utm are taken
 * (and, with `persist`, kept).
 */
export function resolveLanding(env: ClientEnvironment = defaultClientEnvironment(), persist = true): Landing {
  try {
    const utm = utmOf(env.location?.search)
    const raw = text(env.document?.referrer)
    const internal = isSameHost(raw, env.location?.host)
    const stored = readLanding(env.storage)
    // An internal link that carries utm is not a new entry to the site.
    if ((utm === undefined || internal) && stored) return stored
    const landing: Landing = {}
    const referrer = internal ? undefined : landingReferrer(raw)
    if (referrer) landing.referrer = referrer
    if (utm) landing.utm = utm
    const url = landingUrl(env.location?.href)
    if (url) landing.url = url
    if (persist) writeLanding(env.storage, landing)
    return landing
  } catch {
    return {}
  }
}

/** A referrer as the landing keeps it: origin + path, no query, no fragment; capped. */
export function landingReferrer(raw: unknown): string | undefined {
  return originAndPath(raw, CLIENT_REFERRER_MAX_LENGTH)
}

/** The landing page as the landing keeps it: origin + path, no query, no fragment; capped. */
export function landingUrl(raw: unknown): string | undefined {
  return originAndPath(raw, CLIENT_LANDING_URL_MAX_LENGTH)
}

function originAndPath(raw: unknown, max: number): string | undefined {
  const value = text(raw)
  if (!value) return undefined
  try {
    const url = new URL(value)
    return cut(`${url.origin}${url.pathname}`, max)
  } catch {
    // Not an absolute URL (an old engine, a scheme-less value): without its query and fragment.
    const end = value.search(/[?#]/)
    return cut(end >= 0 ? value.slice(0, end) : value, max)
  }
}

/** True when the referrer's host is this page's host (`location.host`, port included). */
export function isSameHost(referrer: unknown, host: unknown): boolean {
  const value = text(referrer)
  const own = text(host)
  if (!value || !own) return false
  try {
    return new URL(value).host.toLowerCase() === own.toLowerCase()
  } catch {
    return false
  }
}

/** Remember a landing resolved earlier without persisting (consent granted after the first event). */
export function persistLanding(
  landing: Landing,
  storage: StorageLike | null | undefined = defaultClientEnvironment().storage,
): void {
  writeLanding(storage, landing)
}

/** Forget the landing (consent withdrawn). */
export function removeLanding(storage: StorageLike | null | undefined = defaultClientEnvironment().storage): void {
  try {
    storage?.removeItem?.(LANDING_KEY)
  } catch {
    /* blocked */
  }
}

/** The block for the wire — read once per page load by the manager and reused on every event. */
export function resolveClientContext(
  env: ClientEnvironment = defaultClientEnvironment(),
  landing: Landing = resolveLanding(env),
): ClientContext {
  const out: ClientContext = {}
  try {
    const language = cut(text(env.navigator?.language), CLIENT_LANGUAGE_MAX_LENGTH)
    if (language) out.language = language
    const referrer = cut(landing.referrer, CLIENT_REFERRER_MAX_LENGTH)
    if (referrer) out.referrer = referrer
    for (const key of UTM_KEYS) {
      const value = cut(landing.utm?.[key], CLIENT_UTM_MAX_LENGTH)
      if (value) out[key] = value
    }
    const w = dimension(env.screen?.width)
    const h = dimension(env.screen?.height)
    if (w !== undefined) out.screen_w = w
    if (h !== undefined) out.screen_h = h
    const tz = cut(text(safeCall(env.timeZone)), CLIENT_TZ_MAX_LENGTH)
    if (tz) out.tz = tz
  } catch {
    /* a getter that throws: what was read so far goes out */
  }
  return out
}

/** The utm parameters of a URL's query, capped; `undefined` when it has none. */
export function utmOf(search: unknown): Partial<Record<UtmKey, string>> | undefined {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(typeof search === 'string' ? search : '')
  } catch {
    return undefined
  }
  const out: Partial<Record<UtmKey, string>> = {}
  let any = false
  for (const key of UTM_KEYS) {
    const value = cut(text(params.get(key)), CLIENT_UTM_MAX_LENGTH)
    if (value) {
      out[key] = value
      any = true
    }
  }
  return any ? out : undefined
}

function readLanding(storage: StorageLike | null | undefined): Landing | null {
  try {
    const raw = storage?.getItem(LANDING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const p = parsed as { referrer?: unknown; utm?: unknown; url?: unknown }
    const landing: Landing = {}
    const referrer = cut(text(p.referrer), CLIENT_REFERRER_MAX_LENGTH)
    if (referrer) landing.referrer = referrer
    const url = cut(text(p.url), CLIENT_LANDING_URL_MAX_LENGTH)
    if (url) landing.url = url
    if (p.utm && typeof p.utm === 'object') {
      const utm: Partial<Record<UtmKey, string>> = {}
      let any = false
      for (const key of UTM_KEYS) {
        const value = cut(text((p.utm as Record<string, unknown>)[key]), CLIENT_UTM_MAX_LENGTH)
        if (value) {
          utm[key] = value
          any = true
        }
      }
      if (any) landing.utm = utm
    }
    return landing
  } catch {
    return null
  }
}

function writeLanding(storage: StorageLike | null | undefined, landing: Landing): void {
  try {
    storage?.setItem(LANDING_KEY, JSON.stringify(landing))
  } catch {
    /* private mode / blocked / quota — the page stands alone */
  }
}

function sessionStorageOrNull(): StorageLike | null {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage ? sessionStorage : null
  } catch {
    return null // a sandboxed frame throws on access
  }
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const s = String(value).trim()
  return s ? s : undefined
}

function cut(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined
  return value.length > max ? value.slice(0, max) : value
}

/** A screen dimension as the collector takes it: a non-negative integer ≤ 65 535. */
function dimension(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.min(Math.floor(n), CLIENT_SCREEN_MAX)
}

function safeCall(fn: (() => unknown) | undefined): unknown {
  try {
    return fn ? fn() : undefined
  } catch {
    return undefined
  }
}
