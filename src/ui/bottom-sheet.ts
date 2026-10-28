/**
 * The phone behaviour of the SDK's sheets — <vio-product-detail>, <vio-cart>
 * and <vio-checkout> — while they are bottom sheets (≤ 600px wide).
 *
 * Two things the shopper expects from a sheet and did not get (Angelo,
 * 2026-10-22):
 *
 *   - **The page behind stays put.** With the sheet open, a swipe that ran
 *     past the end of the sheet scrolled the article underneath. While any
 *     sheet is open the page is locked: `position: fixed` on the body at the
 *     current offset (`overflow: hidden` alone does not stop iOS Safari), and
 *     on release the body gets its own styles back and the page returns to
 *     the same place. The lock is counted: the detail and the checkout can be
 *     open at once, and the page unlocks when the last one closes.
 *   - **Pull down to close.** The grab bar on top of the sheet only answered
 *     a tap: pulling it scrolled the sheet instead. Now a drag that starts on
 *     the grab bar or the sheet's top bar (logo / title and ✕) moves the
 *     sheet with the finger; let go far enough down — or with a quick flick —
 *     and it closes, otherwise it springs back. Those zones need
 *     `touch-action: none` in the component's CSS, or the browser keeps the
 *     gesture for scrolling. A drag never turns into a tap on ✕.
 *   - **…and from anywhere, at the top.** The grab bar scrolls away with the
 *     content and nobody aims for it (Angelo, 2026-10-28): with the content
 *     scrolled to the top, a finger pulling DOWN on the image or the text
 *     moves the sheet too, like the system's own sheets. Sideways (a photo
 *     carousel), upwards, or with the content scrolled, it stays a scroll.
 *     This one runs on touch events: only a non-passive `touchmove` can keep
 *     the browser from taking the pull for its overscroll.
 *
 * Desktop (the side drawers) is untouched: nothing locks, nothing drags.
 * One instance per component, driven from its `updated()` like `DialogFocus`.
 */

export interface BottomSheetOptions {
  /** The component. The drag listener lives on it; its render root holds the sheet. */
  host: HTMLElement
  /** The panel that moves (looked up on every use — Lit re-renders it). */
  sheet: () => HTMLElement | null
  /** The dimmed page behind, faded while dragging. */
  backdrop?: () => HTMLElement | null
  /** Where a drag can start, inside the sheet: e.g. `'.handle, .topbar'`. */
  dragZones: string
  /** What a drag past the threshold does: the component's `close()`. */
  close: () => void
  /** Answer false while the sheet must stay open (a payment in flight): it springs back. */
  canClose?: () => boolean
  /** What scrolls inside the sheet (default the sheet itself): a pull from the content closes only when it is at the top. */
  scroller?: () => HTMLElement | null
}

/** Same breakpoint as the components' CSS: below it they are bottom sheets. */
const PHONE = '(max-width: 600px)'
/** Movement before a press becomes a drag (a tap on ✕ wiggles a little). */
const SLOP = 6
/** Let go this far down (px, or a quarter of the sheet if shorter) and it closes. */
const CLOSE_DISTANCE = 120
/** …or flick faster than this (px/ms) after at least FLICK_MIN px. */
const FLICK_VELOCITY = 0.5
const FLICK_MIN = 24
/** A click this soon after a drag ends is the drag's own, not a tap. */
const CLICK_AFTER_DRAG_MS = 400

export function isPhoneSheet(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE).matches
}

interface Drag {
  pointerId: number
  startY: number
  lastY: number
  lastT: number
  velocity: number
  moving: boolean
  offset: number
}

export class BottomSheet {
  private active = false
  private locked = false
  private drag: Drag | null = null
  private dragEndedAt = -Infinity
  /** A finger down in the content, not yet known to be a pull (down) or a scroll. */
  private pull: { startX: number; startY: number } | null = null

  constructor(private readonly opts: BottomSheetOptions) {}

  /** Call from `updated()` when `open` changed. Same value twice is a no-op. */
  update(open: boolean): void {
    if (open === this.active) return
    this.active = open
    if (open) this.opened()
    else this.closed()
  }

  /** Call from `disconnectedCallback()`: a sheet torn down while open must not keep the page locked. */
  disconnect(): void {
    if (this.active) {
      this.active = false
      this.closed()
    }
  }

  private opened(): void {
    if (isPhoneSheet()) {
      lockPageScroll()
      this.locked = true
    }
    this.opts.host.addEventListener('pointerdown', this.onPointerDown)
    this.opts.host.addEventListener('click', this.onClickCapture, true)
    this.opts.host.addEventListener('touchstart', this.onTouchStart, { passive: true })
    this.opts.host.addEventListener('touchmove', this.onTouchMove, { passive: false })
    this.opts.host.addEventListener('touchend', this.onTouchEnd)
    this.opts.host.addEventListener('touchcancel', this.onTouchCancel)
  }

  private closed(): void {
    this.opts.host.removeEventListener('pointerdown', this.onPointerDown)
    this.opts.host.removeEventListener('click', this.onClickCapture, true)
    this.opts.host.removeEventListener('touchstart', this.onTouchStart)
    this.opts.host.removeEventListener('touchmove', this.onTouchMove)
    this.opts.host.removeEventListener('touchend', this.onTouchEnd)
    this.opts.host.removeEventListener('touchcancel', this.onTouchCancel)
    this.stopTracking()
    this.drag = null
    this.pull = null
    // The close animation runs from wherever the finger left the sheet to the
    // CSS's closed position; dropping the inline transform now keeps that
    // animation going (same end value) and leaves the next open clean.
    const sheet = this.opts.sheet()
    if (sheet) {
      sheet.style.transform = ''
      sheet.style.transition = ''
    }
    const backdrop = this.opts.backdrop?.()
    if (backdrop) {
      backdrop.style.opacity = ''
      backdrop.style.transition = ''
    }
    if (this.locked) {
      this.locked = false
      unlockPageScroll()
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
    if (this.drag || !isPhoneSheet()) return
    const sheet = this.opts.sheet()
    if (!sheet || !inZone(e, sheet, this.opts.dragZones)) return
    this.drag = {
      pointerId: e.pointerId,
      startY: e.clientY,
      lastY: e.clientY,
      lastT: e.timeStamp,
      velocity: 0,
      moving: false,
      offset: 0,
    }
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerCancel)
  }

  private onPointerMove = (e: PointerEvent): void => {
    const drag = this.drag
    if (!drag || e.pointerId !== drag.pointerId) return
    const dy = e.clientY - drag.startY
    if (!drag.moving) {
      if (dy < -SLOP) return this.abandon() // upwards: not ours
      if (dy <= SLOP) return
      this.startMoving(drag)
    }
    this.follow(drag, e.clientY, e.timeStamp)
    if (e.cancelable) e.preventDefault()
  }

  private onPointerUp = (e: PointerEvent): void => {
    const drag = this.drag
    if (!drag || e.pointerId !== drag.pointerId) return
    this.stopTracking()
    this.finish(drag)
  }

  // ── Pull from the content (touch) ─────────────────────────────────────────

  private onTouchStart = (e: TouchEvent): void => {
    this.pull = null
    if (this.drag || e.touches.length !== 1 || !isPhoneSheet()) return
    const sheet = this.opts.sheet()
    if (!sheet || !e.composedPath().includes(sheet)) return
    if (inZone(e, sheet, this.opts.dragZones)) return // the pointer path has it
    const t = e.touches[0]
    if (t) this.pull = { startX: t.clientX, startY: t.clientY }
  }

  private onTouchMove = (e: TouchEvent): void => {
    const t = e.touches[0]
    if (!t) return
    if (this.pull) {
      const dx = t.clientX - this.pull.startX
      const dy = t.clientY - this.pull.startY
      if (Math.max(Math.abs(dx), Math.abs(dy)) <= SLOP) return
      const startY = this.pull.startY
      this.pull = null
      // Sideways (a carousel), upwards, or content not at its top: a scroll.
      if (Math.abs(dx) >= Math.abs(dy) || dy < 0 || this.scrolledDown(e)) return
      this.drag = { pointerId: -1, startY, lastY: startY, lastT: e.timeStamp, velocity: 0, moving: false, offset: 0 }
      this.startMoving(this.drag)
    }
    const drag = this.drag
    if (!drag || drag.pointerId !== -1) return
    this.follow(drag, t.clientY, e.timeStamp)
    if (e.cancelable) e.preventDefault()
  }

  private onTouchEnd = (e: TouchEvent): void => {
    this.pull = null
    const drag = this.drag
    if (!drag || drag.pointerId !== -1 || e.touches.length > 0) return
    this.finish(drag)
  }

  private onTouchCancel = (): void => {
    this.pull = null
    if (this.drag?.pointerId === -1) this.abandon()
  }

  /** Is the content under the finger scrolled away from its top (the sheet's scroller, or one inside it)? */
  private scrolledDown(e: Event): boolean {
    const sheet = this.opts.sheet()
    const scroller = this.opts.scroller?.() ?? sheet
    if (scroller && scroller.scrollTop > 0) return true
    for (const node of e.composedPath()) {
      if (node === sheet) break
      if (node instanceof HTMLElement && node.scrollTop > 0 && node.scrollHeight > node.clientHeight) return true
    }
    return false
  }

  // ── Shared by both ────────────────────────────────────────────────────────

  /** The press is a drag now: the sheet and backdrop follow the finger without easing. */
  private startMoving(drag: Drag): void {
    drag.moving = true
    const sheet = this.opts.sheet()
    if (sheet) sheet.style.transition = 'none'
    const backdrop = this.opts.backdrop?.()
    if (backdrop) backdrop.style.transition = 'none'
  }

  private follow(drag: Drag, y: number, timeStamp: number): void {
    const dt = timeStamp - drag.lastT
    if (dt > 0) drag.velocity = 0.8 * ((y - drag.lastY) / dt) + 0.2 * drag.velocity
    drag.lastY = y
    drag.lastT = timeStamp
    drag.offset = Math.max(0, y - drag.startY)
    const sheet = this.opts.sheet()
    if (sheet) sheet.style.transform = `translateY(${drag.offset}px)`
    const backdrop = this.opts.backdrop?.()
    if (backdrop && sheet) {
      const height = sheet.getBoundingClientRect().height || window.innerHeight
      backdrop.style.opacity = String(Math.max(0, 1 - drag.offset / height))
    }
  }

  /** Let go: close if far or fast enough (and allowed), else spring back. */
  private finish(drag: Drag): void {
    this.drag = null
    if (!drag.moving) return // a tap: the click goes through
    this.dragEndedAt = performance.now()
    const sheet = this.opts.sheet()
    const height = sheet?.getBoundingClientRect().height || window.innerHeight
    const far = drag.offset >= Math.min(CLOSE_DISTANCE, height / 4)
    const flick = drag.velocity >= FLICK_VELOCITY && drag.offset >= FLICK_MIN
    const allowed = !this.opts.canClose || this.opts.canClose()
    this.release()
    if ((far || flick) && allowed) {
      // Animate on from here to fully down, then close (closed() drops the inline style).
      if (sheet) sheet.style.transform = 'translateY(100%)'
      this.opts.close()
    } else if (sheet) {
      sheet.style.transform = ''
    }
  }

  private onPointerCancel = (e: PointerEvent): void => {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return
    this.abandon()
  }

  /** The press that ended a drag also fires a click on ✕ or the grab bar: swallow it. */
  private onClickCapture = (e: MouseEvent): void => {
    if (performance.now() - this.dragEndedAt > CLICK_AFTER_DRAG_MS) return
    this.dragEndedAt = -Infinity
    e.stopPropagation()
    e.preventDefault()
  }

  /** Give up on this press and put the sheet back where it was. */
  private abandon(): void {
    const moving = this.drag?.moving
    this.stopTracking()
    this.drag = null
    if (!moving) return
    this.release()
    const sheet = this.opts.sheet()
    if (sheet) sheet.style.transform = ''
  }

  /** Hand the sheet and backdrop back to their CSS transitions. */
  private release(): void {
    const sheet = this.opts.sheet()
    if (sheet) sheet.style.transition = ''
    const backdrop = this.opts.backdrop?.()
    if (backdrop) {
      backdrop.style.transition = ''
      backdrop.style.opacity = ''
    }
  }

  private stopTracking(): void {
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerCancel)
  }
}

/** Did the press start on one of the drag zones of this sheet? (Composed path: the sheet is in a shadow root.) */
function inZone(e: Event, sheet: HTMLElement, zones: string): boolean {
  for (const node of e.composedPath()) {
    if (node === sheet) return false
    if (node instanceof Element && node.matches(zones)) return sheet.contains(node)
  }
  return false
}

// ── Page scroll lock, shared by every open sheet ────────────────────────────

let locks = 0
let saved: { scrollY: number; body: Partial<Record<LockedProperty, string>> } | null = null
const LOCKED = ['position', 'top', 'left', 'right', 'width', 'overflow'] as const
type LockedProperty = (typeof LOCKED)[number]

export function lockPageScroll(): void {
  if (typeof document === 'undefined') return
  locks += 1
  if (locks > 1) return
  const body = document.body
  const scrollY = window.scrollY || document.documentElement.scrollTop || 0
  saved = { scrollY, body: {} }
  for (const p of LOCKED) saved.body[p] = body.style[p]
  body.style.position = 'fixed'
  body.style.top = `-${scrollY}px`
  body.style.left = '0'
  body.style.right = '0'
  body.style.width = '100%'
  body.style.overflow = 'hidden'
}

export function unlockPageScroll(): void {
  if (typeof document === 'undefined' || locks === 0) return
  locks -= 1
  if (locks > 0 || !saved) return
  const { scrollY, body } = saved
  saved = null
  for (const p of LOCKED) document.body.style[p] = body[p] ?? ''
  // Back to the same place, instantly — a page with `scroll-behavior: smooth`
  // would otherwise glide there from the top.
  const root = document.documentElement
  const behavior = root.style.scrollBehavior
  root.style.scrollBehavior = 'auto'
  window.scrollTo(0, scrollY)
  root.style.scrollBehavior = behavior
}

/** Tests only: how many sheets hold the lock. */
export function pageScrollLocks(): number {
  return locks
}
