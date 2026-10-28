// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { beginPaymentRedirect, returnCancelled } from './payment-redirect.js'

/**
 * The hand-over to Vipps (Mote & Livsstil, 2026-10-22): no empty moment
 * between the tap and the provider, no second tap, and events a host can
 * draw its own loader from.
 */

const overlay = () => document.querySelector('.vio-redirect-overlay')
const events: Array<[string, any]> = []
const names = ['vio:payment-redirect-start', 'vio:payment-redirect-error', 'vio:payment-redirect-cancel']
const listen = (e: Event) => events.push([e.type, (e as CustomEvent).detail])

afterEach(() => {
  names.forEach((n) => document.removeEventListener(n, listen))
  events.length = 0
  document.querySelectorAll('.vio-redirect-overlay').forEach((e) => e.remove())
  vi.useRealTimers()
})
const watch = () => names.forEach((n) => document.addEventListener(n, listen))

describe('beginPaymentRedirect', () => {
  it('emits the start and shows «Åpner Vipps …» at once', () => {
    watch()
    beginPaymentRedirect({ method: 'vipps', sponsorId: 4, source: 'detail' })
    expect(events[0]).toEqual(['vio:payment-redirect-start', { method: 'vipps', sponsorId: 4, source: 'detail' }])
    expect(overlay()?.textContent).toContain('Åpner Vipps')
    expect(overlay()?.getAttribute('role')).toBe('status')
  })

  it('a host that prevents the start draws its own loader: the SDK draws none', () => {
    const takeOver = (e: Event) => e.preventDefault()
    document.addEventListener('vio:payment-redirect-start', takeOver)
    beginPaymentRedirect({ method: 'vipps', source: 'cart' })
    document.removeEventListener('vio:payment-redirect-start', takeOver)
    expect(overlay()).toBeNull()
  })

  it('a failure emits the error with its reason and takes the overlay away', () => {
    vi.useFakeTimers()
    watch()
    const h = beginPaymentRedirect({ method: 'vipps', sponsorId: 4, source: 'detail' })
    h.fail('network')
    vi.advanceTimersByTime(250)
    expect(overlay()).toBeNull()
    expect(events.at(-1)).toEqual(['vio:payment-redirect-error', { method: 'vipps', sponsorId: 4, source: 'detail', reason: 'network' }])
  })

  it('an abort (Express off, the checkout opens instead) is a cancel, not an error', () => {
    watch()
    beginPaymentRedirect({ method: 'vipps', source: 'detail' }).abort('express-off')
    expect(events.at(-1)?.[0]).toBe('vio:payment-redirect-cancel')
    expect(events.at(-1)?.[1].reason).toBe('express-off')
  })

  it('settles once: a second fail after an abort says nothing', () => {
    watch()
    const h = beginPaymentRedirect({ method: 'vipps', source: 'detail' })
    h.abort()
    h.fail('late')
    expect(events.filter(([n]) => n !== 'vio:payment-redirect-start')).toHaveLength(1)
  })

  it('back from Vipps with the back button (page from the bfcache): cancel with reason back, overlay gone', () => {
    vi.useFakeTimers()
    watch()
    beginPaymentRedirect({ method: 'vipps', source: 'checkout' })
    const ev = new Event('pageshow') as PageTransitionEvent
    Object.defineProperty(ev, 'persisted', { value: true })
    window.dispatchEvent(ev)
    vi.advanceTimersByTime(250)
    expect(overlay()).toBeNull()
    expect(events.at(-1)?.[1].reason).toBe('back')
  })

  it('every tap on the overlay stops there (no second payment)', () => {
    beginPaymentRedirect({ method: 'vipps', source: 'detail' })
    const behind = vi.fn()
    document.body.addEventListener('click', behind)
    overlay()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.body.removeEventListener('click', behind)
    expect(behind).not.toHaveBeenCalled()
  })
})

describe('returnCancelled', () => {
  it('a return through the provider’s own cancel is a cancel with reason cancelled', () => {
    watch()
    returnCancelled({ method: 'vipps', sponsorId: 4, source: 'checkout', checkoutId: 'c1' })
    expect(events.at(-1)).toEqual(['vio:payment-redirect-cancel', { method: 'vipps', sponsorId: 4, source: 'checkout', checkoutId: 'c1', reason: 'cancelled' }])
  })
})
