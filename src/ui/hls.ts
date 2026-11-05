/**
 * HLS for `<vio-reel>` (ADR-0042 point 6). Cloudflare Stream serves the
 * videos as HLS manifests: Safari plays them natively; the other browsers
 * need `hls.js`, which is loaded ONCE, from a CDN, and only when a reel is on
 * the page — the SDK bundle does not grow for pages without one. A plain
 * file (`url` media, `.mp4`) goes straight into `<video src>`.
 */

/** Pinned: a `latest` could change behaviour under a page that was published once (ADR-0042 point 10). */
export const HLS_JS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js'

export interface HlsLike {
  loadSource(url: string): void
  attachMedia(video: HTMLVideoElement): void
  destroy(): void
}

export interface HlsConstructor {
  isSupported(): boolean
  new (config?: Record<string, unknown>): HlsLike
}

export const isHlsUrl = (url: string): boolean => /\.m3u8(\?|#|$)/i.test(url)

export function canPlayHlsNatively(video: HTMLVideoElement): boolean {
  try {
    return typeof video.canPlayType === 'function' && video.canPlayType('application/vnd.apple.mpegurl') !== ''
  } catch {
    return false
  }
}

let loading: Promise<HlsConstructor | null> | null = null

/** `window.Hls` once the script is there; `null` when it cannot be loaded (the reel then tries the manifest as a plain src). */
export function loadHls(url: string = HLS_JS_URL): Promise<HlsConstructor | null> {
  const w = globalThis as { Hls?: HlsConstructor; document?: Document }
  if (w.Hls) return Promise.resolve(w.Hls)
  if (loading) return loading
  if (!w.document) return Promise.resolve(null)
  loading = new Promise<HlsConstructor | null>((resolve) => {
    const script = w.document!.createElement('script')
    script.src = url
    script.async = true
    script.onload = () => resolve(w.Hls ?? null)
    script.onerror = () => {
      loading = null
      resolve(null)
    }
    w.document!.head.appendChild(script)
  })
  return loading
}

/** Tests only: forget a failed or stubbed load. */
export function resetHlsLoader(): void {
  loading = null
}

export interface AttachedSource {
  detach(): void
}

/**
 * Puts `src` into the video: natively when the browser can, through
 * `hls.js` when it must. Resolves once the source is wired (not once it
 * plays). The returned handle undoes it — the reel detaches videos far from
 * the one on screen so a long feed does not hold every stream open.
 */
export async function attachSource(
  video: HTMLVideoElement,
  src: string,
  opts: { hlsUrl?: string; load?: typeof loadHls } = {},
): Promise<AttachedSource> {
  const plain = (): AttachedSource => {
    video.src = src
    return {
      detach() {
        video.removeAttribute('src')
        try {
          video.load()
        } catch {
          /* jsdom */
        }
      },
    }
  }
  if (!isHlsUrl(src) || canPlayHlsNatively(video)) return plain()
  const Hls = await (opts.load ?? loadHls)(opts.hlsUrl)
  if (!Hls || !Hls.isSupported()) return plain()
  const hls = new Hls({ maxBufferLength: 12, backBufferLength: 10, startLevel: -1 })
  hls.loadSource(src)
  hls.attachMedia(video)
  return {
    detach() {
      try {
        hls.destroy()
      } catch {
        /* already gone */
      }
    },
  }
}
