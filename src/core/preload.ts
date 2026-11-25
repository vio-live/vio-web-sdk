/**
 * Start what the first paint needs before the SDK itself has loaded: the
 * surface's snapshot on the CDN (see `snapshot.ts`) and the connections to
 * the API, the commerce GraphQL and the CDN. `Vio.init()` does the same — and
 * picks up a load this started — so a host that imports the SDK lazily calls
 * `preloadVio()` from `@vio-live/web-sdk/preload` (a few hundred bytes) as
 * early as it knows the key.
 *
 * Never throws; does nothing outside a browser.
 */

import { ENVIRONMENT_URLS, type Environment } from './environments.js'
import { startSnapshot } from './snapshot.js'

export interface PreloadOptions {
  /** The surface's Vio API key — the same as `Vio.init({ apiKey })`. */
  apiKey: string
  environment?: Environment
  /** As `Vio.init({ platform })`; `web` when omitted. */
  platform?: 'web' | 'custom-web' | 'vev'
  /** As `Vio.init({ apiBase })` / `graphQLBase`, when the host overrides them. */
  apiBase?: string
  graphQLBase?: string
}

export function preloadVio(options: PreloadOptions): void {
  try {
    if (typeof window === 'undefined' || !options) return
    const env = options.environment ?? 'development'
    const urls = ENVIRONMENT_URLS[env]
    if (!urls) return
    preconnect([
      { href: options.apiBase ?? urls.apiBase, cors: true },
      { href: options.graphQLBase ?? urls.graphQLBase, cors: true },
      { href: urls.snapshotBase, cors: false },
    ])
    void startSnapshot({ apiKey: options.apiKey, environment: env, platform: options.platform ?? 'web' })
  } catch {
    /* a hint, never an error */
  }
}

/** `preconnect` (+ `dns-prefetch`) to each origin, once per page. */
export function preconnect(targets: Array<{ href: string; cors: boolean }>): void {
  try {
    if (typeof document === 'undefined' || !document.head) return
    for (const t of targets) {
      let origin: string
      try {
        origin = new URL(t.href).origin
      } catch {
        continue
      }
      if (!/^https:\/\//.test(origin)) continue
      for (const rel of ['preconnect', 'dns-prefetch']) {
        if (document.head.querySelector(`link[rel="${rel}"][href="${origin}"]`)) continue
        const link = document.createElement('link')
        link.rel = rel
        link.href = origin
        // fetch() to the API and GraphQL is CORS: its connections come from the anonymous pool.
        if (rel === 'preconnect' && t.cors) link.crossOrigin = 'anonymous'
        document.head.appendChild(link)
      }
    }
  } catch {
    /* a hint, never an error */
  }
}
