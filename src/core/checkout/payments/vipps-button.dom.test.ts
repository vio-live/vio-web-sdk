// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  ensureVippsButton,
  vippsButtonAttributes,
  VIPPS_BUTTON_SCRIPT,
  VIPPS_BUTTON_TAG,
} from './vipps-button.js'

/**
 * Vipps' own button is progressive enhancement: callers draw their own
 * button and swap it for the web component whenever the script answers;
 * with a timeout they can also give up.
 * Order matters here — jsdom cannot undefine an element, so the "did not
 * answer" case runs first.
 */
describe('ensureVippsButton — Vipps\' own button, when its script answers', () => {
  it('gives up when the script does not answer in time, injecting it only once', async () => {
    expect(await ensureVippsButton(60)).toBe(false)
    expect(document.querySelectorAll(`script[src="${VIPPS_BUTTON_SCRIPT}"]`).length).toBe(1)
    expect(await ensureVippsButton(60)).toBe(false)
    expect(document.querySelectorAll(`script[src="${VIPPS_BUTTON_SCRIPT}"]`).length).toBe(1)
  })

  it('resolves true as soon as the element is defined, and stays true', async () => {
    const waiting = ensureVippsButton(5000)
    customElements.define(VIPPS_BUTTON_TAG, class extends HTMLElement {})
    expect(await waiting).toBe(true)
    expect(await ensureVippsButton()).toBe(true)
  })

  it('attributes: Vipps brand, Norwegian, primary, rounded, stretched by default; compact on request', () => {
    expect(vippsButtonAttributes()).toEqual({
      brand: 'vipps', language: 'no', verb: 'buy', variant: 'primary', rounded: 'true', stretched: 'true',
    })
    expect(vippsButtonAttributes('pay', { compact: true, stretched: false, language: 'en' })).toEqual({
      brand: 'vipps', language: 'en', verb: 'pay', variant: 'primary', rounded: 'true', stretched: 'false', compact: 'true',
    })
  })
})
