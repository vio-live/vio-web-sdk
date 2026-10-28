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
/** After a failure (or a server that ignored `merge`) the same set is not retried for this long. */
export const SLOT_DECLARATION_FAILURE_TTL_MS = 60 * 60 * 1000
/** The server takes at most this many locations per manifest. */
export const MAX_LOCATIONS_PER_DECLARATION = 100
/** Declarations a page load may POST (a `force` call bypasses it). */
export const MAX_DECLARATIONS_PER_LOAD = 3

/** What `Vio.declareSlots()` accepts per slot. */
export type SlotInput = string | { id: string; displayName?: string; campaignId?: number; kind?: string }

/** The third argument of `Vio.registerSlot(id, displayName, …)`: the element's own campaign and what kind of element it is. */
export interface RegisterSlotOptions {
  campaignId?: number | string | null
  /** `card` | `carousel` | `detail` for the SDK's elements; a host may name its own kind. */
  kind?: string
}

/** A kind is a short word (the micro stores it from 2026-10 on; before, it ignored the key). */
export const SLOT_KIND_MAX_LENGTH = 32

/**
 * The kind of component some units were sold from, as Commerce keeps it on
 * the order line (`order_item.component_kind`, ≤ 32) — the SAME rule the
 * collector applies for `breakdown?by=component_kind` (vio-analytics
 * `componentKind`), so the order and the events agree: what the element says
 * it is (`component_template_id`: `product-card`, `product-carousel`,
 * `product-detail`, a Vev block's `vev-card`) lower-cased and without its
 * `product-` / `vev-` prefix, else the kind word in the slot id the page
 * declared (`card-<key>`, `<scope>-carousel-2`, `detail-1`); `undefined` when
 * neither says.
 */
export function componentKindOf(templateId: unknown, slot?: unknown): string | undefined {
  const hint = typeof templateId === 'string' ? templateId.trim().toLowerCase() : ''
  if (hint) return hint.replace(/^(product|vev)-/, '').slice(0, SLOT_KIND_MAX_LENGTH) || undefined
  const id = typeof slot === 'string' ? slot.toLowerCase() : ''
  const m = id.match(/(?:^|-)(card|carousel|grid|detail|banner|list|hero|stepper)(?:-|$)/)
  return m?.[1]
}

/** The kind as the manifest carries it: trimmed, lower-case, cut at 32 chars; `undefined` for nothing. */
export function normalizeSlotKind(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const kind = value.trim().toLowerCase().slice(0, SLOT_KIND_MAX_LENGTH).trim()
  return kind || undefined
}

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
 * No assignment → the PAGE's campaign (`pageCampaignId`: the element's own
 * `vio-campaign`, an ancestor's `data-vio-campaign`, or `Vio.init({ campaignId })`)
 * when `campaigns[]` lists it as active — an editorial page resolves to its
 * campaign before (and regardless of) the manifest round-trip. Else the
 * default campaign: the `campaigns[]` entry whose id is `campaign.id`, or a
 * minimal entry built from `campaign` (+ the top-level sponsors) when the
 * list does not carry it. No bootstrap → null.
 */
export function resolveSlotCampaign(
  boot: BootLike | null | undefined,
  slot: string | null | undefined,
  now: number = Date.now(),
  platform?: string | null,
  pageCampaignId?: CampaignHint,
  sponsorId?: number | null,
): BootstrapCampaignEntry | null {
  if (!boot) return null
  const page = activeCampaignEntry(boot, pageCampaignId)
  const assignment = findSlotAssignmentDetail(boot, slot, now, platform)
  const sponsor = toNumber(sponsorId)
  if (assignment && assignmentApplies(assignment, page, sponsor)) return assignment.campaign
  return (
    activeCampaignEntry(boot, pageCampaignId, sponsor) ??
    (sponsor !== undefined ? sponsorCampaignEntry(boot, sponsor) : null) ??
    defaultCampaignEntry(boot)
  )
}

/**
 * The sponsor rule: the active campaign of `campaigns[]` the sponsor takes
 * part in, as its primary or one of its secondaries — when it is in several,
 * the surface's default campaign if it is one of them, else the first one
 * the backend lists. Null when none (or on a malformed list).
 */
export function sponsorCampaignEntry(
  boot: BootLike | null | undefined,
  sponsorId: number | null | undefined,
): BootstrapCampaignEntry | null {
  const id = toNumber(sponsorId)
  if (!boot || id === undefined) return null
  try {
    const matches = activeCampaigns(boot).filter((c) => campaignSponsorIds(c).includes(id))
    if (matches.length === 0) return null
    const defaultId = toNumber(boot.campaign?.id)
    return matches.find((c) => toNumber(c.id) === defaultId) ?? matches[0] ?? null
  } catch {
    return null
  }
}

/**
 * Whether a slot assignment decides the campaign. A dashboard assignment (or
 * one without `source`, an older micro) always does. One this page made
 * itself (`source: 'page'`) is treated like the page campaign: it does not
 * when the page now declares a different active campaign (it is about to be
 * re-declared), nor — with a known sponsor — when that sponsor takes no part
 * in it (the sponsor rule then says where the sponsor's campaign is).
 */
export function assignmentApplies(
  assignment: { campaign: BootstrapCampaignEntry; slot: BootstrapSlot },
  page: BootstrapCampaignEntry | null,
  sponsorId?: number,
): boolean {
  if (assignment.slot.source !== 'page') return true
  if (isStalePageAssignment(assignment, page)) return false
  return sponsorId === undefined || campaignSponsorIds(assignment.campaign).includes(sponsorId)
}

/** A page-sourced assignment that disagrees with the page's current (active) campaign. */
export function isStalePageAssignment(
  assignment: { campaign: BootstrapCampaignEntry; slot: BootstrapSlot },
  page: BootstrapCampaignEntry | null,
): boolean {
  return !!page && assignment.slot.source === 'page' && toNumber(page.id) !== toNumber(assignment.campaign.id)
}

/**
 * A page campaign as the callers give it: one id, or the candidates in
 * precedence order (the element's `vio-campaign`, an ancestor's
 * `data-vio-campaign`, `Vio.init`'s). An unusable level (invalid, paused,
 * unknown) falls through to the next one; `0`, `null`, `''` mean unset.
 */
export type CampaignHint = number | string | null | undefined | ReadonlyArray<number | string | null | undefined>

/**
 * A campaign id as the SDK accepts it: a positive safe integer, given as a
 * number or as a string of decimal digits (an attribute). Anything else —
 * `true`, `'0x10'`, `'1e3'`, an array, a float — is "absent".
 */
export function toCampaignId(value: unknown): number | undefined {
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) n = Number(value)
  else return undefined
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/** The usable ids of a hint, in order, without duplicates. */
export function campaignCandidates(hint: CampaignHint): number[] {
  const raw = Array.isArray(hint) ? hint : [hint]
  const out: number[] = []
  for (const v of raw) {
    const id = toCampaignId(v)
    if (id !== undefined && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * The first candidate of `hint` that `campaigns[]` lists as ACTIVE (and, when
 * `sponsorId` is given, that the sponsor takes part in — primary or
 * secondary); null when none — a paused, ended or unknown page campaign is
 * ignored and the resolution moves on.
 */
export function activeCampaignEntry(
  boot: BootLike | null | undefined,
  hint: CampaignHint,
  sponsorId?: number,
): BootstrapCampaignEntry | null {
  if (!boot) return null
  try {
    const active = activeCampaigns(boot)
    for (const id of campaignCandidates(hint)) {
      const entry = active.find((c) => toNumber(c.id) === id)
      if (!entry) continue
      if (sponsorId !== undefined && !campaignSponsorIds(entry).includes(sponsorId)) continue
      return entry
    }
  } catch {
    /* malformed campaigns[] */
  }
  return null
}

/** The sponsor ids of a campaign: its primary and its secondaries. */
export function campaignSponsorIds(campaign: BootstrapCampaignEntry): number[] {
  const ids: number[] = []
  const primary = toNumber(campaign.primarySponsor?.id)
  if (primary !== undefined) ids.push(primary)
  const secondaries = Array.isArray(campaign.secondarySponsors) ? campaign.secondarySponsors : []
  for (const s of secondaries) {
    const id = toNumber(s?.id)
    if (id !== undefined) ids.push(id)
  }
  return ids
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
  return findSlotAssignmentDetail(boot, slot, now, platform)?.campaign ?? null
}

/** Like `findSlotAssignment`, with the matching assignment itself (its `source` decides against a page campaign). */
export function findSlotAssignmentDetail(
  boot: BootLike | null | undefined,
  slot: string | null | undefined,
  now: number = Date.now(),
  platform?: string | null,
): { campaign: BootstrapCampaignEntry; slot: BootstrapSlot } | null {
  const name = typeof slot === 'string' ? slot.trim() : ''
  if (!boot || !name) return null
  try {
    const matches: Array<{ campaign: BootstrapCampaignEntry; slot: BootstrapSlot }> = []
    for (const campaign of activeCampaigns(boot)) {
      const match = slotsOf(campaign).find((s) => assignmentMatches(s, name, now, platform))
      if (match) matches.push({ campaign, slot: match })
    }
    if (matches.length === 0) return null
    const defaultId = toNumber(boot.campaign?.id)
    return matches.find((m) => toNumber(m.campaign.id) === defaultId) ?? matches[0] ?? null
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

/** A finite number from a number or numeric string; `undefined` otherwise. */
export function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

// ── Declaration helpers ─────────────────────────────────────────────────────

/**
 * THE normalization of a slot id — trimmed, cut at the server's 100 chars,
 * trimmed again (a space at position 100 must not survive the cut). Used by
 * the elements' identity, `registerSlot`, `declareSlots` and `attribution`,
 * so every copy of an id is the same string.
 */
export function normalizeSlotId(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, SLOT_ID_MAX_LENGTH).trim()
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
    const campaignId = raw && typeof raw === 'object' ? toCampaignId(raw.campaignId) : undefined
    const kind = raw && typeof raw === 'object' ? normalizeSlotKind(raw.kind) : undefined
    const location: ManifestLocation = { id }
    if (displayName) location.displayName = displayName
    if (campaignId !== undefined) location.campaignId = campaignId
    if (kind) location.kind = kind
    out.push(location)
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
  const tail = `${kind}-${ordinal + 1}`
  let prefix = normalizeScope(scope)
  // The whole id must fit the server's 100 chars: a long scope is cut, the
  // kind + number never are (they are what keeps the id unique).
  const room = SLOT_ID_MAX_LENGTH - tail.length - 1
  if (prefix.length > room) prefix = prefix.slice(0, Math.max(0, room)).replace(/-+$/, '')
  return `${prefix ? `${prefix}-` : ''}${tail}`
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

/**
 * What the browser remembers per (platform, key): for each declared location
 * key — `id`, `\u001f<displayName>` when it has one, `\u001e<campaignId>` when
 * it was declared with a campaign (its own, else the page's); see
 * `slotDeclarationKey` — the epoch ms it was declared. Per id — not per set —
 * because a multi-page site (Vev: one page per article, lazy blocks) makes a
 * new set on every navigation; only the ids not declared in the last 24 h go
 * out, and an id keeps ONE state (a new name or campaign forgets the old key).
 * A failed attempt is stored as if declared
 * `SLOT_DECLARATION_TTL_MS − SLOT_DECLARATION_FAILURE_TTL_MS` ago, so it is
 * retried after an hour, not on every view.
 */
export type SlotDeclarationMemory = Record<string, number>

/** The memory keeps at most this many ids (oldest dropped). */
export const SLOT_DECLARATION_MEMORY_CAP = 500

/**
 * The sortable key of one location: id, display name, the campaign it is
 * declared with (its own, else the page's) and its kind — a renamed block, a
 * page that changed campaign, or an id whose kind became known, is a new key
 * and declares again.
 */
export function slotDeclarationKey(location: ManifestLocation, pageCampaignId?: number | null): string {
  const campaignId = toCampaignId(location.campaignId) ?? toCampaignId(pageCampaignId)
  const kind = normalizeSlotKind(location.kind)
  return (
    location.id +
    (location.displayName ? `\u001f${location.displayName}` : '') +
    (campaignId !== undefined ? `\u001e${campaignId}` : '') +
    (kind !== undefined ? `\u001d${kind}` : '')
  )
}

/** Sorted keys of a set of locations (see `slotDeclarationKey`). */
export function slotDeclarationKeys(
  locations: ReadonlyArray<ManifestLocation>,
  pageCampaignId?: number | null,
): string[] {
  return locations.map((l) => slotDeclarationKey(l, pageCampaignId)).sort()
}

/** The keys not remembered within `ttl` (or remembered in the future — a clock that went back). */
export function pendingSlotKeys(
  memory: SlotDeclarationMemory | null | undefined,
  keys: ReadonlyArray<string>,
  now: number = Date.now(),
  ttl: number = SLOT_DECLARATION_TTL_MS,
): string[] {
  return keys.filter((key) => {
    const at = memory?.[key]
    if (typeof at !== 'number' || !Number.isFinite(at)) return true
    return now - at >= ttl || now < at
  })
}

/** The id part of a memory key (before the display name / campaign / kind separators). */
export function slotKeyId(key: string): string {
  const cut = key.search(/[\u001f\u001e\u001d]/)
  return cut >= 0 ? key.slice(0, cut) : key
}

/**
 * The memory with `keys` remembered at `at`, pruned to the newest `cap`
 * entries. ONE state per id: remembering `hero` under campaign B forgets
 * `hero` under campaign A (or another name), so A → B → A declares A again.
 */
export function rememberSlotKeys(
  memory: SlotDeclarationMemory | null | undefined,
  keys: ReadonlyArray<string>,
  at: number,
  cap: number = SLOT_DECLARATION_MEMORY_CAP,
): SlotDeclarationMemory {
  const next: SlotDeclarationMemory = { ...(memory ?? {}) }
  const ids = new Set(keys.map(slotKeyId))
  for (const existing of Object.keys(next)) {
    if (ids.has(slotKeyId(existing)) && !keys.includes(existing)) delete next[existing]
  }
  for (const key of keys) next[key] = at
  const entries = Object.entries(next)
  if (entries.length <= cap) return next
  entries.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, cap))
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

/** The remembered map, or `{}` (missing, malformed, no storage, old shape). */
export function readSlotDeclaration(storageKey: string): SlotDeclarationMemory {
  try {
    // Even `typeof localStorage` can throw (sandboxed iframes, cookies off).
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(storageKey)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // The 0.23.0 shape (`{ keys: [...], at }`) is not a map: forget it, declare once more.
    if (Array.isArray((parsed as { keys?: unknown }).keys)) return {}
    const out: SlotDeclarationMemory = {}
    for (const [key, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[key] = at
    }
    return out
  } catch {
    return {} // private mode, quota, corrupted JSON — all "nothing remembered"
  }
}

/** Persist the map; silently does nothing without storage. */
export function writeSlotDeclaration(storageKey: string, memory: SlotDeclarationMemory): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(storageKey, JSON.stringify(memory))
  } catch {
    /* private mode / quota — we just post again next time */
  }
}
