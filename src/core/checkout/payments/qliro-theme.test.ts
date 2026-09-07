import { describe, it, expect, afterEach, vi } from 'vitest'
import { readVioTheme } from './qliro.js'

/**
 * The theme has to be read from the HOST's computed values, not the SDK's
 * own defaults — `--vio-*` are custom properties a Vev block or a publisher's
 * stylesheet is free to override, and the point is that Qliro matches what
 * the shopper is actually looking at.
 */
describe('readVioTheme', () => {
  const g = globalThis as any
  const originalGetComputedStyle = g.getComputedStyle
  const originalDocument = g.document

  afterEach(() => {
    g.getComputedStyle = originalGetComputedStyle
    g.document = originalDocument
  })

  const stub = (values: Record<string, string>) => {
    g.document = { documentElement: {} }
    g.getComputedStyle = vi.fn(() => ({
      getPropertyValue: (name: string) => values[name] ?? '',
    }))
  }

  it('reads the four tokens Qliro can be dressed with', () => {
    stub({
      '--vio-color-accent': '#c14a3b',
      '--vio-color-surface': '#ffffff',
      '--vio-radius-md': '4px',
      '--vio-radius-lg': '8px',
    })
    expect(readVioTheme()).toEqual({
      accent: '#c14a3b',
      surface: '#ffffff',
      radiusMd: '4px',
      radiusLg: '8px',
    })
  })

  it('picks up a host override rather than the SDK default', () => {
    stub({ '--vio-color-accent': 'rgb(0, 128, 255)' })
    expect(readVioTheme()?.accent).toBe('rgb(0, 128, 255)')
  })

  it('trims what getComputedStyle returns, which is often padded', () => {
    stub({ '--vio-color-accent': '  #c14a3b  ' })
    expect(readVioTheme()?.accent).toBe('#c14a3b')
  })

  it('leaves a token undefined rather than sending an empty string', () => {
    stub({ '--vio-color-accent': '#c14a3b', '--vio-radius-md': '   ' })
    const theme = readVioTheme()
    expect(theme?.accent).toBe('#c14a3b')
    expect(theme?.radiusMd).toBeUndefined()
  })

  it('is undefined when nothing resolved, so no theme travels at all', () => {
    stub({})
    expect(readVioTheme()).toBeUndefined()
  })

  it('is undefined outside a browser instead of throwing', () => {
    g.document = undefined
    g.getComputedStyle = undefined
    expect(readVioTheme()).toBeUndefined()
  })

  it('survives a getComputedStyle that throws', () => {
    g.document = { documentElement: {} }
    g.getComputedStyle = vi.fn(() => {
      throw new Error('detached')
    })
    expect(readVioTheme()).toBeUndefined()
  })
})
