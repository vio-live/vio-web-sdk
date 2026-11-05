/**
 * Managed shoppable-video experiences — what `<vio-reel>` reads
 * (`GET /v2/experiences/:id`, ADR-0042 of the handbook).
 *
 * The experience lives in Vio: ordered videos, each with its media (HLS from
 * Cloudflare Stream or a plain file), its products and its cues («this
 * product is on screen from second N»). The page only names it
 * (`experience-id`); Vio decides what it shows. Everything here is pure —
 * the element does the DOM.
 *
 * Rules the element relies on (ADR-0042 points 6–8):
 *   - a revision is never swapped mid-interaction: the one the element
 *     mounted with stays until the next mount; a newer one is stored for it;
 *   - the last good revision is kept per experience and used when the
 *     network fails;
 *   - an experience of another campaign than the page's is NOT shown — never
 *     products of another campaign as a fallback, never a default sponsor.
 */

/* localStorage that may be missing, blocked or full (Safari private mode, a
   locked-down kiosk): read and write never throw into the element. */
function safeStorageGet(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}
function safeStorageSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    /* quota or blocked: the reel just has no offline copy */
  }
}
function safeStorageRemove(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

export const EXPERIENCE_SCHEMA_VERSION = 1

export interface ExperienceMedia {
  mediaId: number
  provider: 'cloudflare-stream' | 'url' | string
  /** HLS manifest (`.m3u8`) or the file itself. */
  playbackUrl: string
  dashUrl: string | null
  posterUrl: string | null
  durationSeconds: number | null
  width: number | null
  height: number | null
}

export interface ExperienceFocal {
  x: number
  y: number
}

export interface ExperienceProduct {
  productId: number
  /** Image the editor chose over the catalogue's; null = the catalogue's. */
  imageOverrideUrl: string | null
  focal: ExperienceFocal | null
}

export interface ExperienceCue {
  productId: number
  /** Seconds from the start of the video. */
  at: number
}

export interface ExperienceVideo {
  /** Stable id (`video_id` in analytics). */
  id: string
  title: string | null
  media: ExperienceMedia
  products: ExperienceProduct[]
  cues: ExperienceCue[]
}

/** `GET /v2/experiences/:id` — the published revision (or a preview, `revision: null`). */
export interface Experience {
  schemaVersion: number
  id: number
  revision: number | null
  publishedAt: string | null
  campaignId: number
  sponsorId: number
  campaign?: { id: number; name: string } | null
  title: string
  binding: { slot: string | null }
  /** `--vio-*` tokens the reel applies on itself. */
  theme: Record<string, string>
  videos: ExperienceVideo[]
  /** Only on a preview of the draft (editors). */
  preview?: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const positiveInt = (v: unknown): number | null => {
  const n = num(v)
  return n !== null && Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Reads what the API (or the cache) answered and keeps only what the reel
 * can play: a video without a playable `playbackUrl` is dropped, a product
 * without an id is dropped, a cue that names no product of its video is
 * dropped. `null` when it is not an experience at all (another schema
 * version, no id, no campaign): the element then renders nothing.
 */
export function parseExperience(raw: unknown): Experience | null {
  if (!isRecord(raw)) return null
  const schemaVersion = num(raw.schemaVersion) ?? EXPERIENCE_SCHEMA_VERSION
  if (schemaVersion !== EXPERIENCE_SCHEMA_VERSION) return null
  const id = positiveInt(raw.id)
  const campaignId = positiveInt(raw.campaignId)
  const sponsorId = positiveInt(raw.sponsorId)
  if (id === null || campaignId === null || sponsorId === null) return null

  const theme: Record<string, string> = {}
  if (isRecord(raw.theme)) {
    for (const [k, v] of Object.entries(raw.theme)) if (typeof v === 'string' && v.trim()) theme[k] = v.trim()
  }

  const videos: ExperienceVideo[] = []
  for (const v of Array.isArray(raw.videos) ? raw.videos : []) {
    if (!isRecord(v) || !isRecord(v.media)) continue
    const videoId = text(v.id)
    const playbackUrl = text(v.media.playbackUrl)
    if (!videoId || !playbackUrl) continue
    const products: ExperienceProduct[] = []
    for (const p of Array.isArray(v.products) ? v.products : []) {
      if (!isRecord(p)) continue
      const productId = positiveInt(p.productId)
      if (productId === null) continue
      const focal = isRecord(p.focal) && num(p.focal.x) !== null && num(p.focal.y) !== null ? { x: num(p.focal.x) as number, y: num(p.focal.y) as number } : null
      products.push({ productId, imageOverrideUrl: text(p.imageOverrideUrl), focal })
    }
    const known = new Set(products.map((p) => p.productId))
    const cues: ExperienceCue[] = []
    for (const c of Array.isArray(v.cues) ? v.cues : []) {
      if (!isRecord(c)) continue
      const productId = positiveInt(c.productId)
      const at = num(c.at)
      if (productId === null || at === null || at < 0 || !known.has(productId)) continue
      cues.push({ productId, at })
    }
    cues.sort((a, b) => a.at - b.at)
    videos.push({
      id: videoId,
      title: text(v.title),
      media: {
        mediaId: positiveInt(v.media.mediaId) ?? 0,
        provider: text(v.media.provider) ?? 'url',
        playbackUrl,
        dashUrl: text(v.media.dashUrl),
        posterUrl: text(v.media.posterUrl),
        durationSeconds: num(v.media.durationSeconds),
        width: num(v.media.width),
        height: num(v.media.height),
      },
      products,
      cues,
    })
  }

  return {
    schemaVersion,
    id,
    revision: positiveInt(raw.revision),
    publishedAt: text(raw.publishedAt),
    campaignId,
    sponsorId,
    campaign: isRecord(raw.campaign) && positiveInt(raw.campaign.id) !== null ? { id: positiveInt(raw.campaign.id) as number, name: text(raw.campaign.name) ?? '' } : null,
    title: text(raw.title) ?? '',
    binding: { slot: isRecord(raw.binding) ? text(raw.binding.slot) : null },
    theme,
    videos,
    ...(raw.preview === true ? { preview: true } : {}),
  }
}

/**
 * ADR-0042 point 7: the experience has to belong to the page's campaign. A
 * page that declares no campaign (no `vio-campaign`, no `data-vio-campaign`,
 * no `Vio.init({ campaignId })`) accepts any experience of its surface — the
 * key already scopes it; a page that declares one (or several candidates)
 * only accepts an experience of one of them. The reel never falls back.
 */
export function experienceCompatible(experience: Pick<Experience, 'campaignId'>, pageCampaigns: readonly number[]): boolean {
  if (!pageCampaigns.length) return true
  return pageCampaigns.includes(experience.campaignId)
}

/** The product the latest cue at or before `seconds` names; null before the first cue. */
export function cueProductAt(cues: readonly ExperienceCue[], seconds: number): number | null {
  let current: number | null = null
  for (const cue of cues) {
    if (cue.at <= seconds) current = cue.productId
    else break
  }
  return current
}

/**
 * The theme tokens of the experience that may be applied: `--vio-*` names
 * only, short values that cannot load anything or escape their declaration.
 * The micro already enforces this; the reel checks again because the cache
 * is just localStorage.
 */
export function safeThemeEntries(theme: Record<string, string> | null | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = []
  if (!theme) return out
  for (const [k, v] of Object.entries(theme)) {
    if (!/^--vio-[a-z0-9-]{1,48}$/.test(k)) continue
    if (typeof v !== 'string' || v.length > 64 || /[;{}<>\\]|url\s*\(|expression\s*\(|@import|javascript:/i.test(v)) continue
    out.push([k, v])
  }
  return out
}

// ── Last good revision per experience (ADR-0042 point 8) ───────────────────

export const EXPERIENCE_CACHE_PREFIX = 'vio.reel.'
/** A cached revision older than this is not used offline (the campaign may be long over). */
export const EXPERIENCE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface CachedExperience {
  etag: string | null
  experience: Experience
  savedAt: number
}

/** Short non-reversible tag of the surface key, so two surfaces on one origin never share a slot — and the key itself is not written. */
export function keyTag(apiKey: string): string {
  let h = 5381
  for (let i = 0; i < apiKey.length; i++) h = ((h << 5) + h + apiKey.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export const experienceCacheKey = (apiKey: string, experienceId: number): string =>
  `${EXPERIENCE_CACHE_PREFIX}${keyTag(apiKey)}.${experienceId}`

export function readCachedExperience(key: string, now: number = Date.now()): CachedExperience | null {
  const raw = safeStorageGet(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { etag?: unknown; experience?: unknown; savedAt?: unknown }
    const savedAt = num(parsed.savedAt)
    const experience = parseExperience(parsed.experience)
    if (!experience || savedAt === null || now - savedAt > EXPERIENCE_CACHE_TTL_MS) {
      safeStorageRemove(key)
      return null
    }
    return { etag: text(parsed.etag), experience, savedAt }
  } catch {
    safeStorageRemove(key)
    return null
  }
}

export function writeCachedExperience(key: string, value: CachedExperience): void {
  safeStorageSet(key, JSON.stringify(value))
}

/** The products of an experience, each with the sponsor that sells it (one sponsor per experience today). */
export function experienceProductRefs(experience: Experience): Array<{ sponsorId: number; productId: number }> {
  const seen = new Set<number>()
  const out: Array<{ sponsorId: number; productId: number }> = []
  for (const v of experience.videos) {
    for (const p of v.products) {
      if (seen.has(p.productId)) continue
      seen.add(p.productId)
      out.push({ sponsorId: experience.sponsorId, productId: p.productId })
    }
  }
  return out
}
