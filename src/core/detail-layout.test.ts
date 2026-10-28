/**
 * The order of `<vio-product-detail>`'s sections (0.34): the rule that turns
 * a requested layout into what renders, the page-wide layout
 * (`Vio.configureDetail` / `Vio.detailLayout`) and the element-over-global
 * precedence.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DETAIL_SECTION_IDS,
  effectiveDetailSections,
  layoutOriginOf,
  normalizeDetailLayout,
  onGlobalDetailLayoutChange,
  resolveDetailLayout,
} from './detail-layout.js'
import { Vio } from './client.js'

afterEach(() => {
  Vio.configureDetail({ layout: null })
  vi.restoreAllMocks()
})

describe('section order rules', () => {
  it('unknown ids are left out and said', () => {
    const r = effectiveDetailSections(['purchase', 'reviews', 'title', 'options', 'price'])
    expect(r.sections).toEqual(['purchase', 'title', 'options', 'price'])
    expect(r.adjusted).toEqual([{ section: 'reviews', reason: 'unknown' }])
  })

  it('duplicates: the first wins', () => {
    const r = effectiveDetailSections(['title', 'price', 'title', 'options', 'purchase', 'price'])
    expect(r.sections).toEqual(['title', 'price', 'options', 'purchase'])
    expect(r.adjusted).toEqual([
      { section: 'title', reason: 'duplicate' },
      { section: 'price', reason: 'duplicate' },
    ])
  })

  it('missing essentials are appended in the default relative order', () => {
    const r = effectiveDetailSections(['description', 'brand'])
    expect(r.sections).toEqual(['description', 'brand', 'title', 'price', 'options', 'purchase'])
    expect(r.adjusted).toEqual([
      { section: 'title', reason: 'added-essential' },
      { section: 'price', reason: 'added-essential' },
      { section: 'options', reason: 'added-essential' },
      { section: 'purchase', reason: 'added-essential' },
    ])
  })

  it('sections not listed (and not essential) are not rendered', () => {
    const r = effectiveDetailSections(['title', 'price', 'options', 'purchase'])
    expect(r.sections).not.toContain('highlights')
    expect(r.sections).not.toContain('description')
    expect(r.adjusted).toEqual([])
  })
})

describe('validation', () => {
  it('ids, revision, experiment and variant: ≤ 64 chars of [A-Za-z0-9._:-]', () => {
    expect(normalizeDetailLayout({ id: 'pdp-v2', revision: '3', sections: [], experimentId: 'exp:1', variantId: 'B.2' })).toEqual({
      id: 'pdp-v2',
      revision: '3',
      sections: [],
      experimentId: 'exp:1',
      variantId: 'B.2',
    })
    // An invalid revision / experiment / variant is treated as absent.
    expect(normalizeDetailLayout({ id: 'pdp', revision: 'with space', sections: [], experimentId: 'x'.repeat(65), variantId: 'ø' })).toEqual({
      id: 'pdp',
      revision: '',
      sections: [],
    })
  })

  it('an invalid id ignores the layout, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(normalizeDetailLayout({ id: 'bad id!', revision: '1', sections: ['title'] })).toBeNull()
    expect(normalizeDetailLayout({ id: 'bad id!', revision: '1', sections: ['title'] })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(resolveDetailLayout({ id: 'bad id!', revision: '1', sections: ['title'] }, null).source).toBe('default')
  })
})

describe('applied layout', () => {
  it('without configuration: the default, exactly', () => {
    expect(resolveDetailLayout(null, null)).toEqual({
      id: 'default',
      revision: '0',
      sections: [...DETAIL_SECTION_IDS],
      adjusted: [],
      source: 'default',
    })
    expect(Vio.detailLayout()).toEqual(resolveDetailLayout(null, null))
  })

  it('the element wins over the page; the page over the default', () => {
    const page = { id: 'page', revision: '1', sections: ['price', 'title', 'options', 'purchase'] }
    const own = { id: 'own', revision: '2', sections: ['title', 'price', 'purchase', 'options'], experimentId: 'e1', variantId: 'b' }
    expect(resolveDetailLayout(own, page)).toMatchObject({ id: 'own', revision: '2', experimentId: 'e1', variantId: 'b', source: 'element' })
    expect(resolveDetailLayout(null, page)).toMatchObject({ id: 'page', source: 'global', sections: ['price', 'title', 'options', 'purchase'] })
    // An invalid own layout falls back to the page's.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveDetailLayout({ id: '', sections: [] }, page).source).toBe('global')
  })

  it('Vio.configureDetail sets and resets the page layout, and tells the details', () => {
    const changed = vi.fn()
    const off = onGlobalDetailLayoutChange(changed)
    Vio.configureDetail({ layout: { id: 'short', revision: '7', sections: ['title', 'price', 'options', 'purchase'] } })
    expect(Vio.detailLayout()).toMatchObject({ id: 'short', revision: '7', source: 'global' })
    // A call without `layout` leaves it as it is.
    Vio.configureDetail({})
    expect(Vio.detailLayout().id).toBe('short')
    Vio.configureDetail({ layout: null })
    expect(Vio.detailLayout().source).toBe('default')
    expect(changed).toHaveBeenCalledTimes(2)
    off()
  })

  it('Vio.detailLayout() is a copy', () => {
    Vio.configureDetail({ layout: { id: 'a', revision: '1', sections: ['title'] } })
    const read = Vio.detailLayout()
    read.sections.push('brand')
    expect(Vio.detailLayout().sections).not.toContain('brand')
  })

  it('the origin of an applied layout: nothing for the default', () => {
    expect(layoutOriginOf(resolveDetailLayout(null, null))).toEqual({})
    expect(layoutOriginOf(resolveDetailLayout({ id: 'a', revision: '1', sections: [], experimentId: 'e', variantId: 'v' }, null))).toEqual({
      layoutId: 'a',
      layoutRevision: '1',
      experimentId: 'e',
      variantId: 'v',
    })
  })
})
