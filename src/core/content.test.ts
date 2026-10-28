/**
 * Content (article) attribution — `resolveContent()`: where the id and the
 * title of the page come from, in order, and that it never throws.
 */

import { describe, expect, it } from 'vitest'
import { CONTENT_URL_MAX_LENGTH, capContentUrl, originAndPath, resolveContent } from './content.js'

/** A document with only what the resolver asks: metas/links by selector + title. */
function fakeDocument(nodes: Record<string, Record<string, string>>, title = '') {
  return {
    title,
    querySelector: (selector: string) => {
      const attrs = nodes[selector]
      return attrs ? { getAttribute: (name: string) => attrs[name] ?? null } : null
    },
  } as unknown as Document
}

const loc = (pathname: string, search = '') => ({ pathname, search })

describe('resolveContent — id', () => {
  const full = fakeDocument(
    {
      'meta[name="vio:content-id"]': { content: ' meta-7 ' },
      'link[rel="canonical"]': { href: 'https://host.example/sport/7?utm=x#top' },
      'meta[property="og:url"]': { content: 'https://host.example/og/7' },
    },
    'Doc title',
  )

  it('init option > URL query > meta > canonical > pathname', () => {
    const at = loc('/sport/7', '?vio_content=q-7&vio_content_title=Q%20title')
    expect(resolveContent({ contentId: 42 }, full, at).id).toBe('42')
    expect(resolveContent({}, full, at).id).toBe('q-7')
    expect(resolveContent(null, full, loc('/sport/7')).id).toBe('meta-7')
    const noMeta = fakeDocument({
      'link[rel="canonical"]': { href: 'https://host.example/sport/7?utm=x#top' },
      'meta[property="og:url"]': { content: 'https://host.example/og/7' },
    })
    expect(resolveContent(undefined, noMeta, loc('/sport/7')).id).toBe('https://host.example/sport/7')
    const ogOnly = fakeDocument({ 'meta[property="og:url"]': { content: 'https://host.example/og/7?a=1' } })
    expect(resolveContent(undefined, ogOnly, loc('/sport/7')).id).toBe('https://host.example/og/7')
    expect(resolveContent(undefined, fakeDocument({}), loc('/sport/7')).id).toBe('/sport/7')
  })

  it('ignores blank values at every step', () => {
    const blanks = fakeDocument({
      'meta[name="vio:content-id"]': { content: '   ' },
      'link[rel="canonical"]': { href: '' },
    })
    expect(resolveContent({ contentId: '' }, blanks, loc('/x', '?vio_content=')).id).toBe('/x')
    expect(resolveContent({ contentId: null }, blanks, loc('', '')).id).toBeUndefined()
  })
})

describe('resolveContent — the collector\'s caps', () => {
  it('skips an id that does not fit 128 chars and tries the next source; omits it when none fits', () => {
    const long = '/' + 'a'.repeat(145) // a 146-char pathname
    const canonicalLong = 'https://host.example/' + 'b'.repeat(140)
    expect(resolveContent({ contentId: 'x'.repeat(129) }, fakeDocument({}), loc('/short')).id).toBe('/short')
    expect(resolveContent({}, fakeDocument({ 'link[rel="canonical"]': { href: canonicalLong } }), loc('/short')).id).toBe('/short')
    expect(resolveContent({}, fakeDocument({ 'link[rel="canonical"]': { href: canonicalLong } }), loc(long)).id).toBeUndefined()
    expect(resolveContent({}, fakeDocument({}), loc(long)).id).toBeUndefined()
    expect(resolveContent({}, fakeDocument({}), loc('/' + 'a'.repeat(127))).id).toHaveLength(128)
    // The query and the metas are candidates like any other.
    expect(resolveContent({}, fakeDocument({ 'meta[name="vio:content-id"]': { content: 'm'.repeat(200) } }), loc('/p', `?vio_content=${'q'.repeat(200)}`)).id).toBe('/p')
  })
})

describe('resolveContent — title', () => {
  it('init option > URL query > vio:content-title meta > og:title > document.title', () => {
    const doc = fakeDocument(
      {
        'meta[name="vio:content-title"]': { content: 'Meta title' },
        'meta[property="og:title"]': { content: 'OG title' },
      },
      'Document title',
    )
    expect(resolveContent({ contentTitle: 'Init title' }, doc, loc('/a', '?vio_content_title=Query')).title).toBe('Init title')
    expect(resolveContent({}, doc, loc('/a', '?vio_content_title=Query%20title')).title).toBe('Query title')
    expect(resolveContent({}, doc, loc('/a')).title).toBe('Meta title')
    expect(resolveContent({}, fakeDocument({ 'meta[property="og:title"]': { content: 'OG title' } }, 'Document title'), loc('/a')).title).toBe('OG title')
    expect(resolveContent({}, fakeDocument({}, 'Document title'), loc('/a')).title).toBe('Document title')
    expect(resolveContent({}, fakeDocument({}, ''), loc('/a')).title).toBeUndefined()
  })

  it('caps the title at 255 characters', () => {
    expect(resolveContent({ contentTitle: 'x'.repeat(300) }, fakeDocument({}), loc('/a')).title).toHaveLength(255)
  })
})

describe('resolveContent — safety', () => {
  it('answers {} with no document and no location (SSR, node tests)', () => {
    expect(resolveContent(undefined, null, null)).toEqual({})
    expect(resolveContent({ contentId: 5 }, null, null)).toEqual({ id: '5' })
  })

  it('never throws on a hostile document or location', () => {
    const throwing = {
      get title(): string {
        throw new Error('no')
      },
      querySelector: () => {
        throw new Error('no')
      },
    } as unknown as Document
    expect(() => resolveContent({}, throwing, { pathname: '/p', search: '?%E0%A4%A' })).not.toThrow()
    expect(resolveContent({}, { title: 'T' } as unknown as Document, { pathname: '/p' })).toEqual({ id: '/p', title: 'T' })
    expect(resolveContent({}, fakeDocument({}), { search: 'not a query' })).toEqual({})
  })
})

describe('resolveContent — url (what the order and the cart\'s origins carry as `content_url`)', () => {
  it('is location.href as origin + path — no query, no fragment — whatever the id resolves to', () => {
    const at = { href: 'https://host.example/sport/7?email=kari@example.no&x=1#top', pathname: '/sport/7', search: '?x=1' }
    expect(resolveContent({}, fakeDocument({}), at)).toEqual({ id: '/sport/7', url: 'https://host.example/sport/7' })
    expect(resolveContent({}, fakeDocument({}), { pathname: '/p' })).toEqual({ id: '/p' })
    // A document that throws still leaves the url.
    const throwing = { querySelector: () => { throw new Error('no') } } as unknown as Document
    expect(resolveContent({}, throwing, at).url).toBe('https://host.example/sport/7')
  })

  it('originAndPath: origin + path within the cap; a relative value without its query and fragment', () => {
    expect(originAndPath('https://h/a/b?x=1#y')).toBe('https://h/a/b')
    expect(originAndPath('/a/b?x=1#y')).toBe('/a/b')
    expect(originAndPath(`https://h/${'p'.repeat(3_000)}`)).toHaveLength(CONTENT_URL_MAX_LENGTH)
    expect(originAndPath('https://h/a', 5)).toBe('https')
    expect(originAndPath('  ')).toBeUndefined()
    expect(originAndPath(undefined)).toBeUndefined()
  })

  it('capContentUrl (the analytics events): as is, else without the query string, else cut', () => {
    const long = 'p'.repeat(2_100)
    expect(capContentUrl('https://h/a?x=1')).toBe('https://h/a?x=1')
    expect(capContentUrl(`https://h/a?q=${long}`)).toBe('https://h/a')
    expect(capContentUrl(`https://h/${long}?q=1`)).toHaveLength(CONTENT_URL_MAX_LENGTH)
    expect(capContentUrl('  ')).toBeUndefined()
    expect(capContentUrl(undefined)).toBeUndefined()
  })
})
