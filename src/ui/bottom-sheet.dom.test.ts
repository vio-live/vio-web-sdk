// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { BottomSheet, pageScrollLocks } from './bottom-sheet.js'

/** jsdom has no PointerEvent: a MouseEvent with the pointer fields is enough for the controller. */
function pointer(type: string, target: EventTarget, clientY: number, timeStamp = 0, pointerId = 1): Event {
  const e = new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, clientY, button: 0 })
  Object.defineProperty(e, 'pointerId', { value: pointerId })
  Object.defineProperty(e, 'isPrimary', { value: true })
  Object.defineProperty(e, 'pointerType', { value: 'touch' })
  Object.defineProperty(e, 'timeStamp', { value: timeStamp })
  target.dispatchEvent(e)
  return e
}

/** A touch event with one finger (jsdom has no Touch constructor); returns it to check preventDefault. */
function touch(type: string, target: EventTarget, clientX: number, clientY: number, timeStamp = 0): Event {
  const e = new Event(type, { bubbles: true, composed: true, cancelable: true })
  const finger = { clientX, clientY }
  Object.defineProperty(e, 'touches', { value: type === 'touchend' || type === 'touchcancel' ? [] : [finger] })
  Object.defineProperty(e, 'timeStamp', { value: timeStamp })
  target.dispatchEvent(e)
  return e
}

function phone(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
}

const created: BottomSheet[] = []

/** What the components render, minus the content: a host, a backdrop and a sheet with a grab bar and a top bar. */
function sheet(opts: { canClose?: () => boolean } = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <div class="backdrop"></div>
    <div class="modal">
      <div class="handle"></div>
      <div class="topbar"><button class="close">×</button></div>
      <div class="body"><p class="text">Beskrivelse</p></div>
    </div>`
  const modal = root.querySelector<HTMLElement>('.modal')!
  const close = vi.fn()
  const closeButton = root.querySelector<HTMLButtonElement>('.close')!
  const tapped = vi.fn()
  closeButton.addEventListener('click', tapped)
  const controller = new BottomSheet({
    host,
    sheet: () => modal,
    backdrop: () => root.querySelector<HTMLElement>('.backdrop'),
    dragZones: '.handle, .topbar',
    close,
    canClose: opts.canClose,
  })
  created.push(controller)
  return {
    host,
    controller,
    modal,
    close,
    tapped,
    handle: root.querySelector<HTMLElement>('.handle')!,
    closeButton,
    text: root.querySelector<HTMLElement>('.text')!,
  }
}

describe('BottomSheet', () => {
  let scrollTo: ReturnType<typeof vi.fn>

  beforeEach(() => {
    phone(true)
    scrollTo = vi.fn()
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo
    Object.defineProperty(window, 'scrollY', { value: 840, configurable: true })
    document.body.style.cssText = 'margin: 0'
  })

  afterEach(() => {
    // Sheets a test left open (the drag tests mock `close`) let go of the page.
    for (const c of created.splice(0)) c.disconnect()
    expect(pageScrollLocks()).toBe(0)
    document.body.innerHTML = ''
  })

  describe('the page behind', () => {
    it('is locked where it was while the sheet is open, and returns there on close', () => {
      const s = sheet()
      s.controller.update(true)
      expect(document.body.style.position).toBe('fixed')
      expect(document.body.style.top).toBe('-840px')
      expect(document.body.style.overflow).toBe('hidden')

      s.controller.update(false)
      expect(document.body.style.position).toBe('')
      expect(document.body.style.top).toBe('')
      expect(document.body.style.margin).toBe('0px')
      expect(scrollTo).toHaveBeenCalledWith(0, 840)
      expect(pageScrollLocks()).toBe(0)
    })

    it('stays locked until the last open sheet closes (detail under the checkout)', () => {
      const detail = sheet()
      const checkout = sheet()
      detail.controller.update(true)
      checkout.controller.update(true)
      expect(pageScrollLocks()).toBe(2)

      detail.controller.update(false)
      expect(document.body.style.position).toBe('fixed')
      expect(scrollTo).not.toHaveBeenCalled()

      checkout.controller.update(false)
      expect(document.body.style.position).toBe('')
      expect(scrollTo).toHaveBeenCalledWith(0, 840)
    })

    it('is let go when a sheet is torn down while open', () => {
      const s = sheet()
      s.controller.update(true)
      s.controller.disconnect()
      expect(pageScrollLocks()).toBe(0)
      expect(document.body.style.position).toBe('')
    })

    it('is not touched on desktop (side drawers)', () => {
      phone(false)
      const s = sheet()
      s.controller.update(true)
      expect(document.body.style.position).toBe('')
      expect(pageScrollLocks()).toBe(0)
      s.controller.update(false)
      expect(scrollTo).not.toHaveBeenCalled()
    })
  })

  describe('pulling it down', () => {
    it('moves the sheet with the finger and closes it when let go far enough down', () => {
      const s = sheet()
      s.controller.update(true)
      pointer('pointerdown', s.handle, 100, 0)
      pointer('pointermove', s.handle, 160, 100)
      expect(s.modal.style.transform).toBe('translateY(60px)')
      expect(s.modal.style.transition).toBe('none')
      pointer('pointermove', s.handle, 300, 600)
      pointer('pointerup', s.handle, 300, 610)
      expect(s.close).toHaveBeenCalledTimes(1)
      expect(s.modal.style.transform).toBe('translateY(100%)')
      expect(s.modal.style.transition).toBe('')
    })

    it('closes on a quick flick from the top bar, even if short', () => {
      const s = sheet()
      s.controller.update(true)
      pointer('pointerdown', s.closeButton, 100, 0)
      pointer('pointermove', s.closeButton, 120, 10)
      pointer('pointermove', s.closeButton, 160, 30)
      pointer('pointerup', s.closeButton, 160, 32)
      expect(s.close).toHaveBeenCalledTimes(1)
    })

    it('springs back after a short, slow pull', () => {
      const s = sheet()
      s.controller.update(true)
      pointer('pointerdown', s.handle, 100, 0)
      pointer('pointermove', s.handle, 130, 400)
      pointer('pointermove', s.handle, 140, 800)
      pointer('pointerup', s.handle, 140, 1200)
      expect(s.close).not.toHaveBeenCalled()
      expect(s.modal.style.transform).toBe('')
      expect(s.modal.style.transition).toBe('')
    })

    it('does not turn the drag into a tap on ✕', () => {
      const s = sheet()
      s.controller.update(true)
      pointer('pointerdown', s.closeButton, 100, 0)
      pointer('pointermove', s.closeButton, 130, 400)
      pointer('pointerup', s.closeButton, 130, 800)
      s.closeButton.click()
      expect(s.tapped).not.toHaveBeenCalled()
      // The next, real tap works.
      s.closeButton.click()
      expect(s.tapped).toHaveBeenCalledTimes(1)
    })

    it('leaves a plain tap alone', () => {
      const s = sheet()
      s.controller.update(true)
      pointer('pointerdown', s.closeButton, 100, 0)
      pointer('pointermove', s.closeButton, 103, 50)
      pointer('pointerup', s.closeButton, 103, 80)
      s.closeButton.click()
      expect(s.tapped).toHaveBeenCalledTimes(1)
      expect(s.close).not.toHaveBeenCalled()
      expect(s.modal.style.transform).toBe('')
    })

    it('ignores a press that starts in the content (that is the sheet scrolling)', () => {
      const s = sheet()
      s.controller.update(true)
      pointer('pointerdown', s.text, 100, 0)
      pointer('pointermove', s.text, 400, 100)
      pointer('pointerup', s.text, 400, 120)
      expect(s.close).not.toHaveBeenCalled()
      expect(s.modal.style.transform).toBe('')
    })

    it('closes from the content too, pulling down with it at the top (the grab bar scrolls away)', () => {
      const s = sheet()
      s.controller.update(true)
      touch('touchstart', s.text, 100, 100, 0)
      const first = touch('touchmove', s.text, 102, 130, 50)
      expect(first.defaultPrevented).toBe(true) // the browser does not overscroll
      expect(s.modal.style.transform).toBe('translateY(30px)')
      touch('touchmove', s.text, 104, 400, 500)
      touch('touchend', s.text, 104, 400, 510)
      expect(s.close).toHaveBeenCalledTimes(1)
    })

    it('leaves the content a scroll when the finger goes sideways (a photo carousel) or up', () => {
      const s = sheet()
      s.controller.update(true)
      touch('touchstart', s.text, 100, 100, 0)
      const sideways = touch('touchmove', s.text, 30, 112, 50)
      touch('touchmove', s.text, 0, 300, 100)
      touch('touchend', s.text, 0, 300, 110)
      expect(sideways.defaultPrevented).toBe(false)
      touch('touchstart', s.text, 100, 300, 200)
      touch('touchmove', s.text, 100, 200, 250)
      touch('touchmove', s.text, 100, 500, 300)
      touch('touchend', s.text, 100, 500, 310)
      expect(s.close).not.toHaveBeenCalled()
      expect(s.modal.style.transform).toBe('')
    })

    it('leaves the content a scroll when it is not at its top', () => {
      const s = sheet()
      s.controller.update(true)
      Object.defineProperty(s.modal, 'scrollTop', { value: 200, configurable: true })
      touch('touchstart', s.text, 100, 100, 0)
      const move = touch('touchmove', s.text, 100, 400, 100)
      touch('touchend', s.text, 100, 400, 110)
      expect(move.defaultPrevented).toBe(false)
      expect(s.close).not.toHaveBeenCalled()
    })

    it('springs back while a payment is in flight', () => {
      let paying = true
      const s = sheet({ canClose: () => !paying })
      s.controller.update(true)
      pointer('pointerdown', s.handle, 100, 0)
      pointer('pointermove', s.handle, 400, 100)
      pointer('pointerup', s.handle, 400, 120)
      expect(s.close).not.toHaveBeenCalled()
      expect(s.modal.style.transform).toBe('')
      paying = false
    })

    it('puts the sheet back when the browser cancels the gesture', () => {
      const s = sheet()
      s.controller.update(true)
      pointer('pointerdown', s.handle, 100, 0)
      pointer('pointermove', s.handle, 200, 100)
      pointer('pointercancel', s.handle, 200, 110)
      expect(s.close).not.toHaveBeenCalled()
      expect(s.modal.style.transform).toBe('')
    })

    it('does nothing on desktop or once closed', () => {
      phone(false)
      const desktop = sheet()
      desktop.controller.update(true)
      pointer('pointerdown', desktop.handle, 100, 0)
      pointer('pointermove', desktop.handle, 400, 100)
      pointer('pointerup', desktop.handle, 400, 120)
      expect(desktop.close).not.toHaveBeenCalled()

      phone(true)
      const closed = sheet()
      closed.controller.update(true)
      closed.controller.update(false)
      pointer('pointerdown', closed.handle, 100, 0)
      pointer('pointermove', closed.handle, 400, 100)
      pointer('pointerup', closed.handle, 400, 120)
      expect(closed.close).not.toHaveBeenCalled()
      expect(closed.modal.style.transform).toBe('')
    })
  })
})
