/**
 * Content (article) attribution — the other half of "where did this happen".
 *
 * The SLOT says the place on the page (`carousel-1`, `hero`); the CONTENT says
 * the article/page the place was rendered in. One Vev design serves thousands
 * of article URLs, so the article must not leak into the slot id — it travels
 * on every analytics event as `content_id` / `content_title` instead, and this
 * module finds it without the editor doing anything.
 *
 * Pure: `resolveContent()` takes the document and location (defaults to the
 * globals) so it can be tested, never throws, and answers `{}` where there is
 * no DOM (SSR, node tests). `Vio.content()` resolves it live on every call —
 * an SPA route change or a new title is seen on the next event.
 */

export interface ContentRef {
  id?: string
  title?: string
  /** The page's URL (`location.href`) within the collector's cap — what `content_url` carries. */
  url?: string
}

export interface ContentInit {
  contentId?: string | number | null
  contentTitle?: string | null
}

/** The URL query parameters a host can set per page. */
export const CONTENT_ID_QUERY = 'vio_content'
export const CONTENT_TITLE_QUERY = 'vio_content_title'

/**
 * The collector's caps (vio-analytics `analytics-schema.ts`): an event with a
 * longer `content_id` is rejected whole, silently. A candidate id that does
 * not fit is skipped — the next source is tried — never cut, since a cut
 * canonical URL is not the article any more. Titles are cut.
 */
export const CONTENT_ID_MAX_LENGTH = 128
export const CONTENT_TITLE_MAX_LENGTH = 255
/** The collector (and Commerce's `order.content_url`) cap `content_url` at 2 048 chars. */
export const CONTENT_URL_MAX_LENGTH = 2_048

/**
 * A page URL within the cap — as is, else without its query string (a long
 * one is usually the tracking tail, not the page), else cut. The ONE rule for
 * `content_url`, shared by the analytics events and the cart's origins.
 */
export function capContentUrl(value: unknown): string | undefined {
  const url = text(value)
  if (!url) return undefined
  if (url.length <= CONTENT_URL_MAX_LENGTH) return url
  const cut = url.search(/[?#]/)
  const withoutQuery = cut >= 0 ? url.slice(0, cut) : url
  return withoutQuery.length <= CONTENT_URL_MAX_LENGTH ? withoutQuery : withoutQuery.slice(0, CONTENT_URL_MAX_LENGTH)
}

/**
 * Id: `Vio.init({ contentId })` → `?vio_content=` → `<meta name="vio:content-id">`
 * → `<link rel="canonical">` href or `<meta property="og:url">` (without query
 * and hash) → `location.pathname`.
 * Title: `Vio.init({ contentTitle })` → `?vio_content_title=` →
 * `<meta name="vio:content-title">` → `<meta property="og:title">` → `document.title`.
 */
export function resolveContent(
  init?: ContentInit | null,
  doc: Document | null | undefined = typeof document !== 'undefined' ? document : null,
  loc: Location | { href?: string; pathname?: string; search?: string } | null | undefined = typeof location !==
  'undefined'
    ? location
    : null,
): ContentRef {
  const out: ContentRef = {}
  try {
    // The URL first: a document that throws below must not cost the page.
    const url = capContentUrl(loc?.href)
    if (url !== undefined) out.url = url
  } catch {
    /* no location */
  }
  try {
    const query = parseQuery(loc?.search)
    const id =
      fits(text(init?.contentId)) ??
      fits(text(query.get(CONTENT_ID_QUERY))) ??
      fits(text(meta(doc, 'name', 'vio:content-id'))) ??
      fits(stripQueryAndHash(text(attr(doc, 'link[rel="canonical"]', 'href')))) ??
      fits(stripQueryAndHash(text(meta(doc, 'property', 'og:url')))) ??
      fits(text(loc?.pathname))
    const title =
      text(init?.contentTitle) ??
      text(query.get(CONTENT_TITLE_QUERY)) ??
      text(meta(doc, 'name', 'vio:content-title')) ??
      text(meta(doc, 'property', 'og:title')) ??
      text(doc?.title)
    if (id !== undefined) out.id = id
    if (title !== undefined) out.title = title.slice(0, CONTENT_TITLE_MAX_LENGTH)
    return out
  } catch {
    return out
  }
}

/** The candidate when it fits the collector's id cap; `undefined` (= try the next) otherwise. */
function fits(value: string | undefined): string | undefined {
  return value !== undefined && value.length <= CONTENT_ID_MAX_LENGTH ? value : undefined
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const s = String(value).trim()
  return s ? s : undefined
}

function parseQuery(search: string | null | undefined): URLSearchParams {
  try {
    return new URLSearchParams(typeof search === 'string' ? search : '')
  } catch {
    return new URLSearchParams()
  }
}

function meta(doc: Document | null | undefined, key: 'name' | 'property', value: string): string | undefined {
  return attr(doc, `meta[${key}="${value}"]`, 'content')
}

function attr(doc: Document | null | undefined, selector: string, name: string): string | undefined {
  try {
    if (!doc || typeof doc.querySelector !== 'function') return undefined
    const el = doc.querySelector(selector)
    const v = el?.getAttribute?.(name)
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

/** `https://host/a/b?x=1#y` → `https://host/a/b`; untouched when it has neither. */
function stripQueryAndHash(url: string | undefined): string | undefined {
  if (!url) return undefined
  const cut = url.search(/[?#]/)
  const clean = cut >= 0 ? url.slice(0, cut) : url
  return clean.trim() || undefined
}
