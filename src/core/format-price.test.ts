import { describe, it, expect, afterEach } from 'vitest'
import { formatPrice } from './types.js'

/**
 * QA 2026-11-02, QKC product sheet: 30 % off 499 is 349.3, shown as
 * «349,3 Kr». A price has no decimals or two, never one.
 */

const g = globalThis as { __VIO_LOCALE__?: string }

afterEach(() => {
  delete g.__VIO_LOCALE__
})

const plain = (s: string) => s.replace(/\s/g, ' ')

describe('formatPrice', () => {
  it('an amount with cents always shows two decimals', () => {
    expect(plain(formatPrice(349.3, 'NOK'))).toBe('349,30 Kr')
    expect(plain(formatPrice(0.5, 'NOK'))).toBe('0,50 Kr')
    expect(plain(formatPrice(1502.25, 'NOK'))).toBe('1 502,25 Kr')
  })

  it('a whole amount shows none', () => {
    expect(plain(formatPrice(499, 'NOK'))).toBe('499 Kr')
    expect(plain(formatPrice(0, 'NOK'))).toBe('0 Kr')
  })

  it('decides on the amount rounded to cents: float noise never adds ,00', () => {
    expect(plain(formatPrice(349.999, 'NOK'))).toBe('350 Kr')
    expect(plain(formatPrice(0.1 + 0.2, 'NOK'))).toBe('0,30 Kr')
    expect(plain(formatPrice(1499.9999999, 'NOK'))).toBe('1 500 Kr')
  })

  it('follows the page locale', () => {
    g.__VIO_LOCALE__ = 'en-GB'
    expect(formatPrice(349.3, 'GBP')).toBe('349.30 £')
    expect(formatPrice(499, 'GBP')).toBe('499 £')
  })
})
