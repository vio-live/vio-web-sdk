/**
 * The slot identity of a `<vio-*>` element and its ONE `Vio.registerSlot()`
 * registration (ADR-0027 / ADR-0034).
 *
 * The editor types nothing: every element registers itself. Identity, in
 * order:
 *   1. `vio-slot` — the host's own id (also how several elements share one
 *      slot: the cards a carousel renders carry the carousel's id);
 *   2. otherwise an auto id, `${scope ? scope + '-' : ''}${kind}-${ordinal + 1}`
 *      among the same-kind Vio elements WITH THE SAME SCOPE, in document order
 *      at connect time (`carousel-1`, `article-123-card-3`).
 * The scope is inherited from the DOM: the element's `vio-scope`, else the
 * nearest ancestor's `data-vio-scope` (through shadow hosts), else none. Its
 * human label the same way: `vio-scope-name` / `data-vio-scope-name`. This is
 * THE standard shared with Vev and Replit: a page sets
 * `<body data-vio-scope="article-123" data-vio-scope-name="Title">` and every
 * block in it gets a per-page slot with no naming; a template that wants slots
 * shared across pages sets no scope.
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
 * attribution, not rendering.
 */

import { Vio } from '../core/client.js'
import { autoSlotDisplayName, autoSlotId, normalizeScope, type SlotKind } from '../core/slots.js'

export interface SlotIdentity {
  id: string
  displayName?: string
  /** True when the id was generated, false when the host set `vio-slot`. */
  auto: boolean
  /** The scope the auto id was built in ('' when none). */
  scope: string
}

export interface SlotAttributes {
  vioSlot?: string | null
  vioSlotName?: string | null
  vioScope?: string | null
  vioScopeName?: string | null
}

/** Attribute names, shared by the elements and the ancestor lookup. */
export const SCOPE_ATTR = 'vio-scope'
export const SCOPE_NAME_ATTR = 'vio-scope-name'
export const SCOPE_DATA_ATTR = 'data-vio-scope'
export const SCOPE_NAME_DATA_ATTR = 'data-vio-scope-name'

export class SlotRegistration {
  private identity: SlotIdentity | null = null
  private release: (() => void) | null = null
  /** The element's position-based identity, fixed at connect time. */
  private position: { scope: string; scopeName: string; ordinal: number } | null = null

  constructor(
    private readonly host: HTMLElement,
    private readonly kind: SlotKind,
  ) {}

  /** The effective slot id ('' before connect / after disconnect). */
  get effective(): string {
    return this.identity?.id ?? ''
  }

  /** The identity in effect, or null. */
  get current(): SlotIdentity | null {
    return this.identity
  }

  /** On connect: fix scope + ordinal from the element's position, then register. */
  connect(attrs: SlotAttributes): void {
    this.position = positionOf(this.host, attrs)
    this.sync(attrs)
  }

  /** (Re)register when the attributes changed the identity. */
  sync(attrs: SlotAttributes): void {
    // A scope set after connect (React) changes the position too.
    if (this.position && scopeOf(this.host, attrs) !== this.position.scope) {
      this.position = positionOf(this.host, attrs)
    }
    const next = this.resolve(attrs)
    if (sameIdentity(next, this.identity)) return
    this.clear()
    if (!next) return
    try {
      this.release = Vio.registerSlot(next.id, next.displayName)
      this.identity = next
    } catch {
      this.release = null
      this.identity = null
    }
  }

  /** What the identity would be for these attributes (null before connect without a host id). */
  resolve(attrs: SlotAttributes): SlotIdentity | null {
    const explicit = typeof attrs.vioSlot === 'string' ? attrs.vioSlot.trim() : ''
    const name = typeof attrs.vioSlotName === 'string' && attrs.vioSlotName.trim() ? attrs.vioSlotName.trim() : undefined
    if (explicit) return { id: explicit, displayName: name, auto: false, scope: this.position?.scope ?? '' }
    if (!this.position) return null
    const { scope, scopeName, ordinal } = this.position
    return {
      id: autoSlotId(this.kind, ordinal, scope),
      displayName: name ?? autoSlotDisplayName(this.kind, ordinal, scopeName),
      auto: true,
      scope,
    }
  }

  /** Unregister whatever is registered. */
  clear(): void {
    try {
      this.release?.()
    } catch {
      /* never break the element */
    }
    this.release = null
    this.identity = null
  }
}

function sameIdentity(a: SlotIdentity | null, b: SlotIdentity | null): boolean {
  if (!a || !b) return a === b
  return a.id === b.id && a.displayName === b.displayName
}

/** The scope of an element: its own `vio-scope` (property or attribute), else the nearest `data-vio-scope`. */
export function scopeOf(el: Element, attrs?: SlotAttributes): string {
  const own =
    attrs && typeof attrs.vioScope === 'string'
      ? attrs.vioScope
      : typeof (el as { vioScope?: unknown }).vioScope === 'string'
        ? ((el as { vioScope?: string }).vioScope ?? '')
        : (el.getAttribute(SCOPE_ATTR) ?? '')
  const value = normalizeScope(own) || normalizeScope(closestAcrossShadow(el, `[${SCOPE_DATA_ATTR}]`)?.getAttribute(SCOPE_DATA_ATTR))
  return value
}

/** The human label of the scope, looked up the same way as the scope. */
export function scopeNameOf(el: Element, attrs?: SlotAttributes): string {
  const own =
    attrs && typeof attrs.vioScopeName === 'string'
      ? attrs.vioScopeName
      : typeof (el as { vioScopeName?: unknown }).vioScopeName === 'string'
        ? ((el as { vioScopeName?: string }).vioScopeName ?? '')
        : (el.getAttribute(SCOPE_NAME_ATTR) ?? '')
  const value = own.trim() || (closestAcrossShadow(el, `[${SCOPE_NAME_DATA_ATTR}]`)?.getAttribute(SCOPE_NAME_DATA_ATTR) ?? '').trim()
  return value
}

/**
 * Scope + label + index of `host` among the same-tag elements of its root
 * (the document, or the shadow root it was rendered into) THAT SHARE ITS
 * SCOPE, in document order; ordinal 0 when it cannot be told (no DOM, detached).
 */
function positionOf(host: HTMLElement, attrs: SlotAttributes): { scope: string; scopeName: string; ordinal: number } {
  const scope = scopeOf(host, attrs)
  const scopeName = scopeNameOf(host, attrs)
  let ordinal = 0
  try {
    const tag = host.tagName.toLowerCase()
    const root = host.getRootNode() as Document | ShadowRoot
    const scopeRoot =
      root && typeof (root as ParentNode).querySelectorAll === 'function'
        ? (root as ParentNode)
        : typeof document !== 'undefined'
          ? document
          : null
    if (scopeRoot) {
      const peers = Array.from(scopeRoot.querySelectorAll(tag)).filter(
        (el) => el === host || scopeOf(el) === scope,
      )
      const index = peers.indexOf(host)
      ordinal = index >= 0 ? index : 0
    }
  } catch {
    ordinal = 0
  }
  return { scope, scopeName, ordinal }
}

/** `closest()` that keeps walking up through shadow hosts. */
function closestAcrossShadow(start: Element, selector: string): Element | null {
  try {
    let node: Element | null = start
    while (node) {
      const found = typeof node.closest === 'function' ? node.closest(selector) : null
      if (found) return found
      const root = node.getRootNode() as Node & { host?: Element }
      node = root && root !== node && typeof (root as ShadowRoot).host === 'object' ? ((root as ShadowRoot).host ?? null) : null
    }
  } catch {
    /* no DOM, detached */
  }
  return null
}
