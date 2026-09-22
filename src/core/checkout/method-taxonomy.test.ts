import { describe, it, expect } from 'vitest'
import {
  normalizeMethodName, isMethodEnabled, isEmbeddedMethod, collectsOwnAddress,
  EMBEDDED_METHODS, COLLECTS_OWN_ADDRESS,
  isFormFirstWidgetMethod,
  NO_EXPRESS_BUTTON_METHODS,
} from './method-taxonomy.js'

/**
 * One place says what each method is. The tests exist because the answer used
 * to be written by hand in seven places, and forgetting one produced two
 * separate defects on 2026-09-08 — the cart with no button and the product
 * page with no buy button.
 */
describe('method taxonomy', () => {
  it('compares letters only — backends spell methods differently', () => {
    expect(normalizeMethodName('Apple Pay')).toBe('applepay')
    expect(normalizeMethodName('apple-pay')).toBe('applepay')
    expect(normalizeMethodName('STRIPE')).toBe('stripe')
    expect(normalizeMethodName('Qliro')).toBe('qliro')
  })

  it('knows which methods run inside their own widget', () => {
    for (const m of ['Qliro', 'Kustom', 'Walley']) expect(isEmbeddedMethod(m)).toBe(true)
    for (const m of ['Klarna', 'STRIPE', 'Apple Pay', 'Vipps']) {
      expect(isEmbeddedMethod(m)).toBe(false)
    }
  })

  it('knows which collect the address themselves — the embedded ones and Vipps', () => {
    for (const m of ['Qliro', 'Kustom', 'Walley', 'Vipps']) {
      expect(collectsOwnAddress(m)).toBe(true)
    }
    for (const m of ['Klarna', 'STRIPE', 'Apple Pay']) {
      expect(collectsOwnAddress(m)).toBe(false)
    }
  })

  it('every embedded method also collects its own address', () => {
    // If that ever stops holding, the address-form rule needs revisiting.
    for (const m of EMBEDDED_METHODS) expect(COLLECTS_OWN_ADDRESS).toContain(m)
  })

  describe('isMethodEnabled', () => {
    it('matches regardless of spelling', () => {
      expect(isMethodEnabled(['Apple Pay'], 'apple-pay')).toBe(true)
      expect(isMethodEnabled(['Qliro'], 'qliro')).toBe(true)
    })

    it('matches if ANY of the given names does', () => {
      expect(isMethodEnabled(['Apple Pay'], 'apple-pay', 'applepay')).toBe(true)
    })

    it('says no when the channel does not offer it', () => {
      expect(isMethodEnabled(['Qliro'], 'klarna')).toBe(false)
      expect(isMethodEnabled([], 'qliro')).toBe(false)
    })

    it('says YES to everything when the list is unknown', () => {
      // A backend blip must show too many methods, never none: nobody should
      // be blocked from paying because a lookup failed.
      expect(isMethodEnabled(null, 'qliro')).toBe(true)
      expect(isMethodEnabled(null, 'anything')).toBe(true)
    })
  })

  describe('Adyen — a payment widget, not an embedded checkout', () => {
    it('asks for no address of its own, so our form must stay', () => {
      // Drop-in lists cards, Vipps, Klarna… and charges. Treating it like
      // Qliro would hide the delivery form and leave nothing to ship to.
      expect(isFormFirstWidgetMethod('Adyen')).toBe(true)
      expect(isEmbeddedMethod('Adyen')).toBe(false)
      expect(collectsOwnAddress('Adyen')).toBe(false)
    })

    it('has no express button, so a page offering only Adyen still needs the generic CTA', () => {
      expect(NO_EXPRESS_BUTTON_METHODS).toContain('adyen')
      expect(NO_EXPRESS_BUTTON_METHODS).toContain('qliro')
      expect(isMethodEnabled(['Adyen'], ...NO_EXPRESS_BUTTON_METHODS)).toBe(true)
      expect(isMethodEnabled(['Klarna'], ...NO_EXPRESS_BUTTON_METHODS)).toBe(false)
    })
  })
})
