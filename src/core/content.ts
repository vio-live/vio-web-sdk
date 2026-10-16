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
 * no DOM (SSR, node tests). `Vio.content()` caches it per page and forgets the
 * cache on every `Vio.init()`.
 */

export interface ContentRef {
  id?: string
  title?: string
}

export interface ContentInit {
  contentId?: string | number | null
  contentTitle?: string | null
}

/** The URL query parameters a host can set per page. */
export const CONTENT_ID_QUERY = 'vio_content'
export const CONTENT_TITLE_QUERY = 'vio_content_title'

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
  try {
    const query = parseQuery(loc?.search)
    const id =
      text(init?.contentId) ??
      text(query.get(CONTENT_ID_QUERY)) ??
      text(meta(doc, 'name', 'vio:content-id')) ??
      stripQueryAndHash(text(attr(doc, 'link[rel="canonical"]', 'href')) ?? text(meta(doc, 'property', 'og:url'))) ??
      text(loc?.pathname)
    const title =
      text(init?.contentTitle) ??
      text(query.get(CONTENT_TITLE_QUERY)) ??
      text(meta(doc, 'name', 'vio:content-title')) ??
      text(meta(doc, 'property', 'og:title')) ??
      text(doc?.title)
    const out: ContentRef = {}
    if (id !== undefined) out.id = id
    if (title !== undefined) out.title = title.slice(0, 255)
    return out
  } catch {
    return {}
  }
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
