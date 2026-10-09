// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { DialogFocus, deepActiveElement, tabbableIn } from './dialog-focus.js'

/**
 * A stand-in for what the three components render: a host with a shadow
 * root, a `role="dialog"` container in it with a close button first, a
 * named slot projecting light-DOM content (the checkout's PSP containers)
 * and a nested web component with its own shadow root (Vipps' button).
 */
function dialog() {
  const opener = document.createElement('button')
  opener.textContent = 'Åpne'
  document.body.appendChild(opener)

  const host = document.createElement('div')
  document.body.appendChild(host)
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
    <div class="backdrop"></div>
    <div class="modal" role="dialog" aria-modal="true" tabindex="-1">
      <div class="handle" aria-hidden="true"></div>
      <button class="close">×</button>
      <input class="field" />
      <button class="hidden" hidden>skjult</button>
      <button class="off" disabled>av</button>
      <a class="plain">uten href</a>
      <div class="skip" tabindex="-1">hopp over</div>
      <slot name="widget"></slot>
      <div class="nested"></div>
      <button class="last">Betal</button>
    </div>`
  const modal = shadow.querySelector<HTMLElement>('.modal')!
  const nested = shadow.querySelector<HTMLElement>('.nested')!
  nested.attachShadow({ mode: 'open' }).innerHTML = '<button class="inner">inne</button>'
  const widget = document.createElement('div')
  widget.slot = 'widget'
  widget.innerHTML = '<iframe class="frame"></iframe>'
  host.appendChild(widget)

  const close = vi.fn()
  let canClose = true
  const focus = new DialogFocus({
    host,
    container: () => modal,
    close,
    canClose: () => canClose,
  })
  const q = (sel: string) => shadow.querySelector<HTMLElement>(sel)!
  return {
    opener,
    host,
    modal,
    focus,
    close,
    setCanClose: (v: boolean) => (canClose = v),
    el: {
      close: q('.close'),
      field: q('.field'),
      frame: widget.querySelector<HTMLElement>('.frame')!,
      inner: nested.shadowRoot!.querySelector<HTMLElement>('.inner')!,
      last: q('.last'),
    },
  }
}

const key = (target: Element, key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('tabbableIn', () => {
  it('lists what Tab reaches, in composed order: slotted content where its slot is, open shadow roots looked into', () => {
    const d = dialog()
    expect(tabbableIn(d.modal)).toEqual([d.el.close, d.el.field, d.el.frame, d.el.inner, d.el.last])
  })

  it('leaves out the hidden, the disabled, links without href and tabindex=-1', () => {
    const d = dialog()
    const classes = tabbableIn(d.modal).map((el) => el.className)
    expect(classes).not.toContain('hidden')
    expect(classes).not.toContain('off')
    expect(classes).not.toContain('plain')
    expect(classes).not.toContain('skip')
  })
})

describe('opening', () => {
  it('moves focus to the first tabbable element — the close button', () => {
    const d = dialog()
    d.opener.focus()
    d.focus.update(true)
    expect(deepActiveElement()).toBe(d.el.close)
  })

  it('focuses the container itself when nothing in it is tabbable', () => {
    const d = dialog()
    d.modal.innerHTML = '<p>Laster…</p>'
    d.focus.update(true)
    expect(deepActiveElement()).toBe(d.modal)
  })

  it('does nothing on the first render, where Lit reports open as changed from undefined to false', () => {
    const d = dialog()
    d.opener.focus()
    d.focus.update(false)
    expect(document.activeElement).toBe(d.opener)
  })
})

describe('Escape', () => {
  it('closes the dialog, and the key goes no further', () => {
    const d = dialog()
    d.focus.update(true)
    const e = key(d.el.close, 'Escape')
    expect(d.close).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
  })

  it('is ignored while the dialog says it cannot close (a payment in flight)', () => {
    const d = dialog()
    d.focus.update(true)
    d.setCanClose(false)
    key(d.el.close, 'Escape')
    expect(d.close).not.toHaveBeenCalled()
    d.setCanClose(true)
    key(d.el.close, 'Escape')
    expect(d.close).toHaveBeenCalledTimes(1)
  })

  it('pressed elsewhere on the page does nothing — and nothing once closed', () => {
    const d = dialog()
    d.focus.update(true)
    key(d.opener, 'Escape')
    expect(d.close).not.toHaveBeenCalled()
    d.focus.update(false)
    key(d.el.close, 'Escape')
    expect(d.close).not.toHaveBeenCalled()
  })

  it('opening twice adds one listener, not two', () => {
    const d = dialog()
    d.focus.update(true)
    d.focus.update(true)
    key(d.el.close, 'Escape')
    expect(d.close).toHaveBeenCalledTimes(1)
  })
})

describe('Tab', () => {
  it('from the last element wraps round to the first', () => {
    const d = dialog()
    d.focus.update(true)
    d.el.last.focus()
    const e = key(d.el.last, 'Tab')
    expect(e.defaultPrevented).toBe(true)
    expect(deepActiveElement()).toBe(d.el.close)
  })

  it('with Shift from the first element wraps back to the last', () => {
    const d = dialog()
    d.focus.update(true)
    const e = key(d.el.close, 'Tab', { shiftKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(deepActiveElement()).toBe(d.el.last)
  })

  it('from the container itself goes to the first element, and back from it to the last', () => {
    const d = dialog()
    d.focus.update(true)
    d.modal.focus()
    key(d.modal, 'Tab')
    expect(deepActiveElement()).toBe(d.el.close)
    d.modal.focus()
    key(d.modal, 'Tab', { shiftKey: true })
    expect(deepActiveElement()).toBe(d.el.last)
  })

  it('in the middle is left to the browser', () => {
    const d = dialog()
    d.focus.update(true)
    d.el.field.focus()
    const e = key(d.el.field, 'Tab')
    expect(e.defaultPrevented).toBe(false)
    expect(deepActiveElement()).toBe(d.el.field)
  })

  it('reaches the slotted widget and the nested shadow root on the way round', () => {
    const d = dialog()
    d.focus.update(true)
    d.el.frame.focus()
    key(d.el.frame, 'Tab')
    // The browser moves on by itself; what matters is that the step was not swallowed.
    expect(deepActiveElement()).toBe(d.el.frame)
    d.el.inner.focus()
    expect(deepActiveElement()).toBe(d.el.inner)
    key(d.el.inner, 'Tab', { shiftKey: true })
    expect(deepActiveElement()).toBe(d.el.inner)
  })
})

describe('closing', () => {
  it('gives focus back to the opener', () => {
    const d = dialog()
    d.opener.focus()
    d.focus.update(true)
    expect(deepActiveElement()).toBe(d.el.close)
    d.focus.update(false)
    expect(document.activeElement).toBe(d.opener)
  })

  it('lets go of the dialog when the opener has left the document', () => {
    const d = dialog()
    d.opener.focus()
    d.focus.update(true)
    d.opener.remove()
    expect(() => d.focus.update(false)).not.toThrow()
    expect(deepActiveElement()).toBe(document.body)
  })

  it('leaves focus alone when the shopper already moved on', () => {
    const d = dialog()
    d.opener.focus()
    d.focus.update(true)
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    d.focus.update(false)
    expect(document.activeElement).toBe(elsewhere)
  })

  it('does not hand focus to the page body when that is where it came from', () => {
    const d = dialog()
    ;(document.activeElement as HTMLElement | null)?.blur()
    d.focus.update(true)
    expect(deepActiveElement()).toBe(d.el.close)
    d.focus.update(false)
    expect(deepActiveElement()).toBe(document.body)
  })
})
