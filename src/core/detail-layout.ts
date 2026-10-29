/**
 * The order of the sections of `<vio-product-detail>` below the gallery, and
 * which layout a detail really applied (0.34).
 *
 * A layout is `{ id, revision, sections, experimentId?, variantId? }`, set for
 * the whole page with `Vio.configureDetail({ layout })` or per element with its
 * `layout` property / attribute (the element wins). This module holds the
 * page-wide one and the ONE rule that turns a requested layout into the
 * sections a detail renders (`resolveDetailLayout`). Pure but for the global
 * store, which lives on `globalThis` so every bundle of the SDK on a page
 * (Vev chunks) shares it, like the `Vio` facade.
 *
 * The applied layout of a non-default layout travels with analytics: the
 * `view_item` of the detail and, through the cart line origins, every unit
 * the detail added (see `layoutOriginOf`). Never to Commerce.
 */

/** Section ids of the detail, in the default order (exactly the DOM before 0.34). */
export const DETAIL_SECTION_IDS = [
  'brand',
  'title',
  'stock',
  'price',
  'options',
  'purchase',
  'highlights',
  'description',
  'shippingReturns',
] as const

export type DetailSectionId = (typeof DETAIL_SECTION_IDS)[number]

/** Sections a layout cannot leave out: appended, in default relative order, when missing. */
export const ESSENTIAL_DETAIL_SECTIONS: ReadonlyArray<DetailSectionId> = ['title', 'price', 'options', 'purchase']

/** What a host asks for. */
export interface DetailLayout {
  id: string
  revision: string
  sections: string[]
  experimentId?: string
  variantId?: string
}

export interface DetailLayoutAdjustment {
  section: string
  reason: 'unknown' | 'duplicate' | 'added-essential'
}

/** What a detail applied — `el.appliedLayout`, `Vio.detailLayout()`, `vio:detail-layout-applied`. */
export interface AppliedDetailLayout {
  id: string
  revision: string
  experimentId?: string
  variantId?: string
  /** The sections rendered, in order. */
  sections: DetailSectionId[]
  /** What the SDK changed in the requested list, and why. */
  adjusted: DetailLayoutAdjustment[]
  source: 'element' | 'global' | 'default'
}

/** The layout fields a cart line origin carries (CartOrigin) — only for a non-default layout. */
export interface DetailLayoutOrigin {
  layoutId?: string
  layoutRevision?: string
  experimentId?: string
  variantId?: string
}

/** ≤ 64 chars of [A-Za-z0-9._:-]. */
const LAYOUT_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/

/** A valid layout token, trimmed; `undefined` otherwise. */
export function layoutToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  return LAYOUT_TOKEN.test(v) ? v : undefined
}

const KNOWN = new Set<string>(DETAIL_SECTION_IDS)

/** The default applied layout (no configuration). */
export function defaultDetailLayout(): AppliedDetailLayout {
  return { id: 'default', revision: '0', sections: [...DETAIL_SECTION_IDS], adjusted: [], source: 'default' }
}

/** Invalid layouts already warned about (once per page and value). */
const warned = new Set<string>()

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  if (typeof console !== 'undefined') console.warn('[Vio] detail layout ignored:', message)
}

/**
 * A requested layout as the SDK uses it, or `null` when it cannot be used
 * (not an object, an invalid `id`, `sections` not an array — warned once).
 * An invalid `revision` / `experimentId` / `variantId` is treated as absent.
 */
export function normalizeDetailLayout(raw: unknown): DetailLayout | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnOnce(`type:${typeof raw}`, 'it must be an object')
    return null
  }
  const r = raw as Record<string, unknown>
  const id = layoutToken(r.id)
  if (!id) {
    warnOnce(`id:${String(r.id)}`, `invalid id ${JSON.stringify(r.id)} (≤ 64 chars of A-Z a-z 0-9 . _ : -)`)
    return null
  }
  if (!Array.isArray(r.sections)) {
    warnOnce(`sections:${id}`, `layout ${id}: sections must be an array of section ids`)
    return null
  }
  const out: DetailLayout = {
    id,
    revision: layoutToken(r.revision) ?? '',
    sections: r.sections.map((s) => (typeof s === 'string' ? s.trim() : String(s))),
  }
  const experimentId = layoutToken(r.experimentId)
  if (experimentId) out.experimentId = experimentId
  const variantId = layoutToken(r.variantId)
  if (variantId) out.variantId = variantId
  return out
}

/**
 * The sections a requested list renders: unknown ids out, duplicates out
 * (the first wins), then the missing essentials (`title`, `price`,
 * `options`, `purchase`) appended in their default relative order.
 */
export function effectiveDetailSections(requested: ReadonlyArray<string>): {
  sections: DetailSectionId[]
  adjusted: DetailLayoutAdjustment[]
} {
  const sections: DetailSectionId[] = []
  const adjusted: DetailLayoutAdjustment[] = []
  for (const raw of requested) {
    const s = String(raw).slice(0, 64)
    if (!KNOWN.has(s)) {
      adjusted.push({ section: s, reason: 'unknown' })
      continue
    }
    if (sections.includes(s as DetailSectionId)) {
      adjusted.push({ section: s, reason: 'duplicate' })
      continue
    }
    sections.push(s as DetailSectionId)
  }
  for (const essential of ESSENTIAL_DETAIL_SECTIONS) {
    if (!sections.includes(essential)) {
      sections.push(essential)
      adjusted.push({ section: essential, reason: 'added-essential' })
    }
  }
  return { sections, adjusted }
}

/**
 * The layout a detail applies: its own (valid) layout, else the page's
 * (`Vio.configureDetail`), else the default.
 */
export function resolveDetailLayout(elementLayout: unknown, globalLayout: unknown = currentGlobalDetailLayout()): AppliedDetailLayout {
  const own = normalizeDetailLayout(elementLayout)
  const page = own ? null : normalizeDetailLayout(globalLayout)
  const chosen = own ?? page
  if (!chosen) return defaultDetailLayout()
  const { sections, adjusted } = effectiveDetailSections(chosen.sections)
  return {
    id: chosen.id,
    revision: chosen.revision,
    ...(chosen.experimentId ? { experimentId: chosen.experimentId } : {}),
    ...(chosen.variantId ? { variantId: chosen.variantId } : {}),
    sections,
    adjusted,
    source: own ? 'element' : 'global',
  }
}

/** A copy a caller may keep or change without touching the SDK's. */
export function copyAppliedLayout(applied: AppliedDetailLayout): AppliedDetailLayout {
  return { ...applied, sections: [...applied.sections], adjusted: applied.adjusted.map((a) => ({ ...a })) }
}

/** Two applied layouts render and report the same. */
export function layoutSignature(applied: AppliedDetailLayout): string {
  return [applied.source, applied.id, applied.revision, applied.experimentId ?? '', applied.variantId ?? '', applied.sections.join(',')].join('|')
}

/** The origin fields of an applied layout: nothing for the default one. */
export function layoutOriginOf(applied: AppliedDetailLayout | null | undefined): DetailLayoutOrigin {
  if (!applied || applied.source === 'default') return {}
  return {
    layoutId: applied.id,
    ...(applied.revision ? { layoutRevision: applied.revision } : {}),
    ...(applied.experimentId ? { experimentId: applied.experimentId } : {}),
    ...(applied.variantId ? { variantId: applied.variantId } : {}),
  }
}

/** The layout fields of an origin (or event detail), validated; `{}` when none. */
export function normalizeLayoutOrigin(origin: unknown): DetailLayoutOrigin {
  if (!origin || typeof origin !== 'object') return {}
  const o = origin as Record<string, unknown>
  const layoutId = layoutToken(o.layoutId)
  if (!layoutId) return {}
  const out: DetailLayoutOrigin = { layoutId }
  const layoutRevision = layoutToken(o.layoutRevision)
  if (layoutRevision) out.layoutRevision = layoutRevision
  const experimentId = layoutToken(o.experimentId)
  if (experimentId) out.experimentId = experimentId
  const variantId = layoutToken(o.variantId)
  if (variantId) out.variantId = variantId
  return out
}

// MARK: - The page-wide layout (`Vio.configureDetail`)

interface DetailLayoutStore {
  layout: unknown
  /** The page's heading for the description fold (`Vio.configureDetail({ descriptionLabel })`), or null. */
  descriptionLabel?: string | null
  listeners: Set<() => void>
}

function store(): DetailLayoutStore {
  const g = globalThis as unknown as { __VIO_DETAIL_LAYOUT__?: DetailLayoutStore }
  return (g.__VIO_DETAIL_LAYOUT__ ??= { layout: null, listeners: new Set() })
}

/** What `Vio.configureDetail({ layout })` set (as given; `null` = none). */
export function currentGlobalDetailLayout(): unknown {
  return store().layout
}

/** Set (or with `null` reset) the page's layout; open and later details re-render. */
export function setGlobalDetailLayout(layout: unknown): void {
  const s = store()
  s.layout = layout ?? null
  // Validated now so a bad layout warns at the call, not at the next open.
  normalizeDetailLayout(s.layout)
  for (const listener of [...s.listeners]) {
    try {
      listener()
    } catch {
      /* a listener never breaks the call */
    }
  }
}

/** The page's heading for the description fold, or null (the detail says «Beskrivelse»). */
export function currentGlobalDescriptionLabel(): string | null {
  return store().descriptionLabel ?? null
}

/**
 * Set (or with null reset) the heading of the description fold for every
 * detail of the page — e.g. «Produktbeskrivelse». Plain text, trimmed, at most
 * 40 characters; anything else resets it. Open details re-render.
 */
export function setGlobalDescriptionLabel(label: unknown): void {
  const s = store()
  const text = typeof label === 'string' ? label.trim() : ''
  s.descriptionLabel = text && text.length <= 40 ? text : null
  for (const listener of [...s.listeners]) {
    try {
      listener()
    } catch {
      /* a listener never breaks the call */
    }
  }
}

/** Called after every change of the page's layout; returns the unsubscribe. */
export function onGlobalDetailLayoutChange(listener: () => void): () => void {
  const s = store()
  s.listeners.add(listener)
  return () => s.listeners.delete(listener)
}
