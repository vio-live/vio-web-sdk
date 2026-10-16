/**
 * Slots — the pure half of ADR-0027 / ADR-0034 on the web.
 *
 * A slot is a NAME for a place on a page. The page declares its slots to the
 * campaigns service (`Vio.declareSlots()` / `Vio.registerSlot()` in client.ts),
 * the dashboard assigns a campaign to each one, optionally with a date window,
 * and `GET /v2/mobile/config` answers with `campaigns[].slots[]` — only the
 * assignments whose window is open NOW. Whatever no slot names shows the
 * surface's default campaign (`campaign`).
 *
 * Everything here is side-effect free and never throws on a malformed
 * bootstrap: a broken `campaigns[]` must never blank a product block or break
 * `track()`.
 */

import type {
  BootstrapCampaignEntry,
  BootstrapResponse,
  BootstrapSlot,
  ManifestLocation,
} from './types.js'

/** The server caps slot ids at 100 characters; longer ones are cut, not dropped. */
export const SLOT_ID_MAX_LENGTH = 100

/** A declared set is not re-posted from the same browser for this long. */
export const SLOT_DECLARATION_TTL_MS = 24 * 60 * 60 * 1000

/** What `Vio.declareSlots()` accepts per slot. */
export type SlotInput = string | { id: string; displayName?: string }

type BootLike = Pick<
  BootstrapResponse,
  'campaign' | 'campaigns' | 'primarySponsor' | 'secondarySponsors'
>

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * The campaign a slot shows right now. Among the `status === 'active'`
 * entries of `campaigns[]`, the one with an assignment named `slot` for this
 * platform (`platform` null on the assignment, or equal to `platform`) whose
 * window contains `now` (`startDate <= now < endDate`, null = open). When
 * several qualify, the surface's default campaign wins, else the first the
 * backend lists.
 *
 * No slot, or no assignment → the default campaign: the `campaigns[]` entry
 * whose id is `campaign.id`, or a minimal entry built from `campaign` (+ the
 * top-level sponsors) when the list does not carry it. No bootstrap → null.
 */
export function resolveSlotCampaign(
  boot: BootLike | null | undefined,
  slot: string | null | undefined,
  now: number = Date.now(),
  platform?: string | null,
): BootstrapCampaignEntry | null {
  if (!boot) return null
  return findSlotAssignment(boot, slot, now, platform) ?? defaultCampaignEntry(boot)
}

/**
 * Only the ASSIGNED campaign of `slot` (see `resolveSlotCampaign`), without the
 * default fallback — attribution needs to tell "this slot has a campaign" from
 * "nothing assigned, use the sponsor rule".
 */
export function findSlotAssignment(
  boot: BootLike | null | undefined,
  slot: string | null | undefined,
  now: number = Date.now(),
  platform?: string | null,
): BootstrapCampaignEntry | null {
  const name = typeof slot === 'string' ? slot.trim() : ''
  if (!boot || !name) return null
  try {
    const matches = activeCampaigns(boot).filter((c) =>
      slotsOf(c).some((s) => assignmentMatches(s, name, now, platform)),
    )
    if (matches.length === 0) return null
    const defaultId = toNumber(boot.campaign?.id)
    return matches.find((c) => toNumber(c.id) === defaultId) ?? matches[0] ?? null
  } catch {
    return null
  }
}

/** The surface's default campaign as a `campaigns[]` entry (see above). */
export function defaultCampaignEntry(boot: BootLike | null | undefined): BootstrapCampaignEntry | null {
  if (!boot?.campaign || typeof boot.campaign !== 'object') return null
  const defaultId = toNumber(boot.campaign.id)
  if (defaultId === undefined) return null
  try {
    const listed = wellFormedCampaigns(boot).find((c) => toNumber(c.id) === defaultId)
    if (listed) return listed
  } catch {
    /* fall through to the minimal entry */
  }
  return {
    ...boot.campaign,
    isDefault: true,
    primarySponsor: boot.primarySponsor ?? null,
    secondarySponsors: Array.isArray(boot.secondarySponsors) ? boot.secondarySponsors : [],
    slots: [],
  }
}

function wellFormedCampaigns(boot: BootLike): BootstrapCampaignEntry[] {
  const list = Array.isArray(boot.campaigns) ? boot.campaigns : []
  return list.filter((c): c is BootstrapCampaignEntry => !!c && typeof c === 'object')
}

function activeCampaigns(boot: BootLike): BootstrapCampaignEntry[] {
  return wellFormedCampaigns(boot).filter((c) => c.status === 'active')
}

function slotsOf(campaign: BootstrapCampaignEntry): BootstrapSlot[] {
  const slots = Array.isArray(campaign.slots) ? campaign.slots : []
  return slots.filter((s): s is BootstrapSlot => !!s && typeof s === 'object')
}

function assignmentMatches(
  s: BootstrapSlot,
  name: string,
  now: number,
  platform?: string | null,
): boolean {
  if (typeof s.name !== 'string' || s.name.trim() !== name) return false
  if (platform && s.platform != null && s.platform !== platform) return false
  const start = parseTime(s.startDate)
  if (start !== undefined && start > now) return false
  const end = parseTime(s.endDate)
  if (end !== undefined && now >= end) return false
  return true
}

/** Epoch ms of an ISO date; `undefined` (= open) for null or unparsable. */
function parseTime(value: string | null | undefined): number | undefined {
  if (value == null || value === '') return undefined
  const t = Date.parse(String(value))
  return Number.isFinite(t) ? t : undefined
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

// ── Declaration helpers ─────────────────────────────────────────────────────

/** A single slot name as the server stores it: trimmed and cut at 100 chars. */
export function normalizeSlotId(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, SLOT_ID_MAX_LENGTH)
}

/**
 * `Vio.declareSlots()` input → manifest `locations`: ids trimmed, cut at 100
 * chars, empties dropped, duplicates collapsed (the first displayName wins),
 * original order kept.
 */
export function normalizeSlotLocations(slots: ReadonlyArray<SlotInput> | null | undefined): ManifestLocation[] {
  const out: ManifestLocation[] = []
  const seen = new Set<string>()
  if (!Array.isArray(slots)) return out
  for (const raw of slots) {
    const id = normalizeSlotId(typeof raw === 'string' ? raw : raw?.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const displayName =
      raw && typeof raw === 'object' && typeof raw.displayName === 'string'
        ? raw.displayName.trim()
        : ''
    out.push(displayName ? { id, displayName } : { id })
  }
  return out
}

// ── Auto identity (ADR-0034 refinement: the editor types nothing) ───────────

/** The kinds of Vio element that register themselves. */
export type SlotKind = 'card' | 'carousel' | 'detail'

/**
 * The id an element gets when the host set no `vio-slot`:
 * `${scope ? scope + '-' : ''}${kind}-${ordinal + 1}` (`carousel-1`, `card-3`,
 * `article-123-carousel-1`), `ordinal` being the element's index among the
 * same-kind Vio elements WITH THE SAME SCOPE, in document order at connect
 * time. The scope is inherited from the DOM (`vio-scope` on the element, else
 * the nearest `data-vio-scope` ancestor): a Vev page or a Replit article
 * (`<body data-vio-scope="article-123">`) gets per-page slots with one line
 * and no per-element naming; a template that wants slots shared across
 * articles simply sets no scope. On purpose there is NO page path in the id:
 * the article goes to analytics as `content_id`, not into the slot. Stable
 * across reloads while the layout is; a layout change leaves a stale entry,
 * which ADR-0034 accepts.
 */
export function autoSlotId(kind: SlotKind, ordinal: number, scope?: string | null): string {
  const prefix = normalizeScope(scope)
  return `${prefix ? `${prefix}-` : ''}${kind}-${ordinal + 1}`
}

/** `"Carousel 1"`, `"Card 3"` — with ` · ${scopeName}` when the scope has a human label. */
export function autoSlotDisplayName(kind: SlotKind, ordinal: number, scopeName?: string | null): string {
  const label = `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ${ordinal + 1}`
  const name = typeof scopeName === 'string' ? scopeName.trim() : ''
  return name ? `${label} · ${name}` : label
}

/** A scope value fit for an id: trimmed, inner whitespace → `-`. */
export function normalizeScope(scope: string | null | undefined): string {
  if (typeof scope !== 'string') return ''
  return scope.trim().replace(/\s+/g, '-')
}

// ── Declaration memory ──────────────────────────────────────────────────────

/** What the browser remembers about the last declaration of a (platform, key). */
export interface SlotDeclarationMemory {
  /** Sorted keys of the declared locations (see `slotDeclarationKeys`). */
  keys: string[]
  /** Epoch ms of the declaration. */
  at: number
}

/**
 * One sortable key per location, display name included — a renamed block
 * must declare again even when the set of ids is the same.
 */
export function slotDeclarationKeys(locations: ReadonlyArray<ManifestLocation>): string[] {
  return locations
    .map((l) => (l.displayName ? `${l.id}\u001f${l.displayName}` : l.id))
    .sort()
}

/**
 * localStorage key of the declaration memory. The API key itself never lands
 * in storage — only a short non-reversible hash of it, so two keys on the same
 * origin (Vev's remembered key, then the page's own) do not share a memory.
 */
export function slotDeclarationStorageKey(platform: string, apiKey: string): string {
  return `vio.slots.${platform}.${fnv1a(apiKey)}`
}

/** 32-bit FNV-1a, hex. Not cryptographic — it only has to be stable. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** The remembered declaration, or null (missing, malformed, no storage). */
export function readSlotDeclaration(storageKey: string): SlotDeclarationMemory | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SlotDeclarationMemory> | null
    if (!parsed || !Array.isArray(parsed.keys) || typeof parsed.at !== 'number') return null
    return { keys: parsed.keys.filter((x): x is string => typeof x === 'string'), at: parsed.at }
  } catch {
    return null // private mode, quota, corrupted JSON — all "nothing remembered"
  }
}

/** Remember a declaration; silently does nothing without storage. */
export function writeSlotDeclaration(storageKey: string, memory: SlotDeclarationMemory): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageKey, JSON.stringify(memory))
  } catch {
    /* private mode / quota — we just post again next time */
  }
}

/**
 * True when exactly `keys` (ids + display names, see `slotDeclarationKeys`)
 * was declared from this browser less than `SLOT_DECLARATION_TTL_MS` ago —
 * the POST can be skipped.
 */
export function isSlotDeclarationFresh(
  memory: SlotDeclarationMemory | null,
  keys: ReadonlyArray<string>,
  now: number = Date.now(),
): boolean {
  if (!memory) return false
  if (now - memory.at >= SLOT_DECLARATION_TTL_MS || now < memory.at) return false
  if (memory.keys.length !== keys.length) return false
  const remembered = [...memory.keys].sort()
  const wanted = [...keys].sort()
  return remembered.every((key, i) => key === wanted[i])
}
