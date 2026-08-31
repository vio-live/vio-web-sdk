import { describe, it, expect, vi } from 'vitest'
import { applyVioTheme, VioTokens } from './tokens.js'

/** Minimal CSSStyleDeclaration-shaped mock — avoids pulling in a DOM test
 * environment (jsdom/happy-dom) just for two method calls. */
function mockTarget() {
  return {
    style: {
      setProperty: vi.fn(),
      removeProperty: vi.fn(),
    },
  } as unknown as HTMLElement
}

describe('VioTokens', () => {
  it('exposes the editorial defaults applyVioTheme overrides live against', () => {
    expect(VioTokens.color.accent.editorial).toBe('#c14a3b')
    expect(VioTokens.font.serif).toContain('Tinos')
    expect(VioTokens.font.sans).toContain('Inter')
  })
})

describe('applyVioTheme', () => {
  it('maps each override key to its --vio-* CSS custom property', () => {
    const target = mockTarget()
    applyVioTheme(
      {
        colorAccent: '#0044ff',
        fontSerif: 'Georgia, serif',
      },
      target,
    )
    expect(target.style.setProperty).toHaveBeenCalledWith('--vio-color-accent', '#0044ff')
    expect(target.style.setProperty).toHaveBeenCalledWith('--vio-font-serif', 'Georgia, serif')
  })

  it('maps the radius and spacing keys too (corner shape + density)', () => {
    const target = mockTarget()
    applyVioTheme({ radiusXl: '0', radiusLg: '0', spaceMd: '12px' }, target)
    expect(target.style.setProperty).toHaveBeenCalledWith('--vio-radius-xl', '0')
    expect(target.style.setProperty).toHaveBeenCalledWith('--vio-radius-lg', '0')
    expect(target.style.setProperty).toHaveBeenCalledWith('--vio-space-md', '12px')
  })

  it('only touches keys actually present in the overrides object', () => {
    const target = mockTarget()
    applyVioTheme({ colorAccent: '#0044ff' }, target)
    // 20 keys total in VioThemeOverrides; only 1 was passed.
    expect(target.style.setProperty).toHaveBeenCalledTimes(1)
    expect(target.style.removeProperty).not.toHaveBeenCalled()
  })

  it('clears an override (falls back to the SDK default) when a key is set to null/undefined', () => {
    const target = mockTarget()
    applyVioTheme({ colorAccent: null as unknown as undefined }, target)
    expect(target.style.removeProperty).toHaveBeenCalledWith('--vio-color-accent')
    expect(target.style.setProperty).not.toHaveBeenCalled()
  })

  it('is a no-op with no target and no document (SSR-safe)', () => {
    expect(() => applyVioTheme({ colorAccent: '#0044ff' }, null)).not.toThrow()
  })
})
