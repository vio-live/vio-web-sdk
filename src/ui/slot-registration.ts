/**
 * The slot identity of a `<vio-*>` element and its ONE `Vio.registerSlot()`
 * registration (ADR-0027 / ADR-0034).
 *
 * The editor types nothing: every element registers itself. Identity, in
 * order:
 *   1. `vio-slot` — the host's own id (also how several elements share one
 *      slot: the cards a carousel renders carry the carousel's id);
 *   2. otherwise an auto id, `${scope ? scope + '-' : ''}${kind}-${n}`, with
 *      `n` the first number not held by another live element of the same
 *      kind and scope ANYWHERE in the document (shadow roots included). On a
 *      fresh load elements connect in document order, so `n` is the document
 *      position (`carousel-1`, `carousel-2`, `article-123-card-3`); in a
 *      dynamic DOM an element added later takes the first free number and an
 *      id a removed element freed is reused by the next one — two live
 *      elements never share an auto id.
 * The scope is inherited from the DOM: the element's `vio-scope`, else the
 * nearest ancestor's `data-vio-scope` (through shadow hosts), else none. Its
 * human label the same way: `vio-scope-name` / `data-vio-scope-name`. This is
 * THE standard shared with Vev and Replit: a page sets
 * `<body data-vio-scope="article-123" data-vio-scope-name="Title">` and every
 * block in it gets a per-page slot with no naming; a template that wants slots
 * shared across pages sets no scope.
 *
 * Every id is capped at the server's 100 characters HERE, so the declared id,
 * `effectiveSlot`, the events' `slot` / `location_id` and the dashboard's
 * assignment are the same string.
 *
 * The display name is `vio-slot-name` when set; for an auto id it defaults to
 * `Carousel 1` (` · ${scopeName}` when the scope has a label); for a host id
 * without a name it is left undefined (the server keeps whatever it has).
 *
 * The attributes are not always there at `connectedCallback`: the React
 * wrappers set properties after the element is mounted, and a host may change
 * them later (the Vev editor, as the designer types). So the elements call
 * `connect()` on connect, `sync()` from `updated()`, and `clear()` on
 * disconnect. Registering never throws into the element — a slot is
 * attribution, not rendering — and tolerates a page whose `Vio` singleton
 * comes from an older bundle without `registerSlot`.
 */

import { Vio } from '../core/client.js'
import {
  autoSlotDisplayName,
  autoSlotId,
  campaignCandidates,
  normalizeScope,
  normalizeSlotId,
  type SlotKind,
} from '../core/slots.js'

export interface SlotIdentity {
  id: string
  displayName?: string
  /** The element's own page campaign (`vio-campaign` / ancestor `data-vio-campaign`), if any — the first candidate. */
  campaignId?: number
  /** All of the element's page-campaign candidates, own first (an unusable one falls through to the next). */
  campaignCandidates: number[]
}

export interface SlotAttributes {
  vioSlot?: string | null
  vioSlotName?: string | null
  vioScope?: string | null
  vioScopeName?: string | null
  vioCampaign?: string | number | null
}

/** Attribute names, shared by the elements and the ancestor lookup. */
export const SCOPE_ATTR = 'vio-scope'
export const SCOPE_NAME_ATTR = 'vio-scope-name'
export const SCOPE_DATA_ATTR = 'data-vio-scope'
export const SCOPE_NAME_DATA_ATTR = 'data-vio-scope-name'
export const CAMPAIGN_ATTR = 'vio-campaign'
export const CAMPAIGN_DATA_ATTR = 'data-vio-campaign'

/**
 * Live elements per auto id, document-wide. Anchored on `globalThis` like the
 * Vio facade: a page with several bundle copies (Vev chunks) must share ONE
 * map, or two copies would both hand out `carousel-1`. Only auto ids: a host
 * id may be shared on purpose.
 */
const liveAutoIds: Map<string, Set<Element>> = (() => {
  const g = globalThis as unknown as { __VIO_LIVE_SLOT_IDS__?: Map<string, Set<Element>> }
  return g.__VIO_LIVE_SLOT_IDS__ ?? (g.__VIO_LIVE_SLOT_IDS__ = new Map())
})()

export class SlotRegistration {
  private identity: SlotIdentity | null = null
  private release: (() => void) | null = null
  /** The auto identity held (its number is kept while the element lives). */
  private auto: { id: string; scope: string; number: number } | null = null
  /** Set by connect(); the scope label is read then too. */
  private connected = false
  private scope = ''
  private scopeName = ''

  constructor(
    private readonly host: HTMLElement,
    private readonly kind: SlotKind,
  ) {}

  /** The effective slot id ('' before connect / after disconnect). */
  get effective(): string {
    return this.identity?.id ?? ''
  }

  /** The element's own page campaign (`vio-campaign` / ancestor `data-vio-campaign`); undefined → `Vio.init`'s applies. */
  get campaignId(): number | undefined {
    return this.identity?.campaignId
  }

  /** The element's page-campaign candidates in order (own, ancestor) — the hint for `Vio.attribution` / `campaignForSlot`. */
  get campaignHint(): number[] {
    return this.identity?.campaignCandidates ?? []
  }

  /** On connect: read the scope from the DOM, then register. */
  connect(attrs: SlotAttributes): void {
    this.connected = true
    this.scope = scopeOf(this.host, attrs)
    this.scopeName = scopeNameOf(this.host, attrs)
    this.sync(attrs)
  }

  /** (Re)register when the attributes changed the identity. */
  sync(attrs: SlotAttributes): void {
    if (!this.connected) return
    // A scope set after connect (React) changes the identity too.
    const scope = scopeOf(this.host, attrs)
    if (scope !== this.scope) {
      this.scope = scope
      this.scopeName = scopeNameOf(this.host, attrs)
      this.releaseAuto()
    } else {
      const scopeName = scopeNameOf(this.host, attrs)
      if (scopeName !== this.scopeName) this.scopeName = scopeName
    }
    const next = this.resolve(attrs)
    if (sameIdentity(next, this.identity)) return
    this.unregister()
    if (!next) return
    try {
      // The campaign stays positional (third argument) and the kind goes in a
      // fourth options object: a facade from an older bundle (0.24) reads the
      // campaign as it always did and ignores the fourth; one older still
      // (0.23) ignores both and registers the id and name.
      this.release =
        typeof Vio.registerSlot !== 'function'
          ? null
          : next.campaignId !== undefined
            ? Vio.registerSlot(next.id, next.displayName, next.campaignId, { kind: this.kind })
            : Vio.registerSlot(next.id, next.displayName, { kind: this.kind })
      this.identity = next
    } catch {
      this.release = null
      this.identity = null
    }
  }

  /** What the identity is for these attributes (null before connect without a host id). */
  resolve(attrs: SlotAttributes): SlotIdentity | null {
    const explicit = normalizeSlotId(attrs.vioSlot)
    const name =
      typeof attrs.vioSlotName === 'string' && attrs.vioSlotName.trim() ? attrs.vioSlotName.trim() : undefined
    const campaignCandidates = campaignCandidatesOf(this.host, attrs)
    const campaignId = campaignCandidates[0]
    if (explicit) {
      // A host id frees the auto number for the next element.
      this.releaseAuto()
      return { id: explicit, displayName: name, campaignId, campaignCandidates }
    }
    if (!this.connected) return null
    const auto = this.claimAuto()
    return {
      id: auto.id,
      displayName: name ?? autoSlotDisplayName(this.kind, auto.number - 1, this.scopeName),
      campaignId,
      campaignCandidates,
    }
  }

  /** Unregister whatever is registered and free the auto number. */
  clear(): void {
    this.unregister()
    this.releaseAuto()
    this.connected = false
  }

  private unregister(): void {
    try {
      this.release?.()
    } catch {
      /* never break the element */
    }
    this.release = null
    this.identity = null
  }

  /** The element's auto id: the one it already holds, else the first free number. */
  private claimAuto(): { id: string; scope: string; number: number } {
    if (this.auto && this.auto.scope === this.scope) return this.auto
    this.releaseAuto()
    for (let number = 1; ; number++) {
      const id = autoSlotId(this.kind, number - 1, this.scope)
      const holders = liveAutoIds.get(id)
      if (!holders || holders.size === 0 || (holders.size === 1 && holders.has(this.host))) {
        const set = holders ?? new Set<Element>()
        set.add(this.host)
        liveAutoIds.set(id, set)
        this.auto = { id, scope: this.scope, number }
        return this.auto
      }
    }
  }

  private releaseAuto(): void {
    if (!this.auto) return
    const holders = liveAutoIds.get(this.auto.id)
    holders?.delete(this.host)
    if (holders && holders.size === 0) liveAutoIds.delete(this.auto.id)
    this.auto = null
  }
}

function sameIdentity(a: SlotIdentity | null, b: SlotIdentity | null): boolean {
  if (!a || !b) return a === b
  return a.id === b.id && a.displayName === b.displayName && a.campaignId === b.campaignId
}

/**
 * The element's page-campaign candidates, in precedence order: its own
 * `vio-campaign` (property or attribute), then the nearest ancestor's
 * `data-vio-campaign` (through shadow hosts); `Vio.init`'s is appended by
 * `Vio.*` itself. Invalid values (not a positive safe integer) are skipped,
 * so an unusable level falls through to the next. Read at mount / on
 * attribute change — there is no observer on the ancestors.
 */
export function campaignCandidatesOf(el: Element, attrs?: SlotAttributes): number[] {
  const own =
    attrs && attrs.vioCampaign !== undefined && attrs.vioCampaign !== null
      ? attrs.vioCampaign
      : (el as { vioCampaign?: unknown }).vioCampaign !== undefined
        ? (el as { vioCampaign?: unknown }).vioCampaign
        : el.getAttribute(CAMPAIGN_ATTR)
  const ancestor = closestAcrossShadow(el, `[${CAMPAIGN_DATA_ATTR}]`)?.getAttribute(CAMPAIGN_DATA_ATTR)
  return campaignCandidates([own as number | string | null | undefined, ancestor])
}

/** The element's own page campaign — the first usable candidate; see `campaignCandidatesOf`. */
export function campaignOf(el: Element, attrs?: SlotAttributes): number | undefined {
  return campaignCandidatesOf(el, attrs)[0]
}

/** The scope of an element: its own `vio-scope` (property or attribute), else the nearest `data-vio-scope`. */
export function scopeOf(el: Element, attrs?: SlotAttributes): string {
  const own =
    attrs && typeof attrs.vioScope === 'string'
      ? attrs.vioScope
      : typeof (el as { vioScope?: unknown }).vioScope === 'string'
        ? ((el as { vioScope?: string }).vioScope ?? '')
        : (el.getAttribute(SCOPE_ATTR) ?? '')
  return (
    normalizeScope(own) ||
    normalizeScope(closestAcrossShadow(el, `[${SCOPE_DATA_ATTR}]`)?.getAttribute(SCOPE_DATA_ATTR))
  )
}

/** The human label of the scope, looked up the same way as the scope. */
export function scopeNameOf(el: Element, attrs?: SlotAttributes): string {
  const own =
    attrs && typeof attrs.vioScopeName === 'string'
      ? attrs.vioScopeName
      : typeof (el as { vioScopeName?: unknown }).vioScopeName === 'string'
        ? ((el as { vioScopeName?: string }).vioScopeName ?? '')
        : (el.getAttribute(SCOPE_NAME_ATTR) ?? '')
  return (
    own.trim() ||
    (closestAcrossShadow(el, `[${SCOPE_NAME_DATA_ATTR}]`)?.getAttribute(SCOPE_NAME_DATA_ATTR) ?? '').trim()
  )
}

/** `closest()` that keeps walking up through shadow hosts. */
function closestAcrossShadow(start: Element, selector: string): Element | null {
  try {
    let node: Element | null = start
    while (node) {
      const found = typeof node.closest === 'function' ? node.closest(selector) : null
      if (found) return found
      const root = node.getRootNode() as Node & { host?: Element }
      node =
        root && root !== node && typeof (root as ShadowRoot).host === 'object'
          ? ((root as ShadowRoot).host ?? null)
          : null
    }
  } catch {
    /* no DOM, detached */
  }
  return null
}
