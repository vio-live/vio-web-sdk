/**
 * Slots (ADR-0027 / ADR-0034) — the pure helpers: which campaign a slot shows
 * from a `/v2/mobile/config` answer, and how a declaration is normalized and
 * remembered.
 */

import { describe, expect, it } from 'vitest'
import type { BootstrapResponse } from './types.js'
import {
  SLOT_DECLARATION_TTL_MS,
  autoSlotDisplayName,
  autoSlotId,
  defaultCampaignEntry,
  findSlotAssignment,
  fnv1a,
  isSlotDeclarationFresh,
  normalizeScope,
  normalizeSlotId,
  normalizeSlotLocations,
  resolveSlotCampaign,
  slotDeclarationKeys,
  slotDeclarationStorageKey,
} from './slots.js'

const sponsor = (id: number) => ({ id, name: `Sponsor ${id}`, commerce: { apiKey: `key-${id}` } })

const OCT_15 = Date.parse('2026-10-15T12:00:00Z')

/** `campaign` + `campaigns[]` as the campaigns micro answers them. */
const BOOT: BootstrapResponse = {
  campaign: { id: 10, name: 'Default' },
  primarySponsor: sponsor(4),
  secondarySponsors: [sponsor(5)],
  campaigns: [
    {
      id: 12,
      name: 'Newer',
      status: 'active',
      primarySponsor: sponsor(7),
      secondarySponsors: [sponsor(8)],
      slots: [
        { name: 'hero', platform: null, startDate: null, endDate: null },
        { name: 'sidebar', platform: 'web', startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-31T00:00:00Z' },
      ],
    },
    {
      id: 10,
      name: 'Default',
      status: 'active',
      isDefault: true,
      primarySponsor: sponsor(4),
      secondarySponsors: [sponsor(5)],
      slots: [{ name: 'hero', platform: 'vev' }],
    },
    {
      id: 13,
      name: 'Paused',
      status: 'paused',
      primarySponsor: sponsor(9),
      secondarySponsors: [],
      slots: [{ name: 'hero' }, { name: 'footer' }],
    },
  ],
}

describe('resolveSlotCampaign', () => {
  it('returns the active campaign whose assignment names the slot', () => {
    expect(resolveSlotCampaign(BOOT, 'hero', OCT_15, 'web')?.id).toBe(12)
    expect(resolveSlotCampaign(BOOT, 'sidebar', OCT_15, 'web')?.id).toBe(12)
  })

  it('an assignment of another platform does not count; one with no platform counts for all', () => {
    // Default's `hero` is vev-only → on web only Newer's (platform null) matches.
    expect(resolveSlotCampaign(BOOT, 'hero', OCT_15, 'web')?.id).toBe(12)
    // `sidebar` is web-only → nothing on vev → default.
    expect(resolveSlotCampaign(BOOT, 'sidebar', OCT_15, 'vev')?.id).toBe(10)
  })

  it('when several qualify, the default campaign wins, else the first listed', () => {
    // On vev both Newer (null platform) and Default (vev) carry `hero`.
    expect(resolveSlotCampaign(BOOT, 'hero', OCT_15, 'vev')?.id).toBe(10)
    // Without a platform every assignment counts → the same tie, same winner.
    expect(resolveSlotCampaign(BOOT, 'hero', OCT_15)?.id).toBe(10)
    const twoNonDefault: BootstrapResponse = {
      campaign: { id: 1, name: 'D' },
      campaigns: [
        { id: 21, name: 'A', status: 'active', slots: [{ name: 'x' }] },
        { id: 22, name: 'B', status: 'active', slots: [{ name: 'x' }] },
      ],
    }
    expect(resolveSlotCampaign(twoNonDefault, 'x', OCT_15)?.id).toBe(21)
  })

  it('honours the window: startDate <= now < endDate, nulls open', () => {
    const before = Date.parse('2026-09-30T23:59:59Z')
    const start = Date.parse('2026-10-01T00:00:00Z')
    const end = Date.parse('2026-10-31T00:00:00Z')
    expect(resolveSlotCampaign(BOOT, 'sidebar', before, 'web')?.id).toBe(10)
    expect(resolveSlotCampaign(BOOT, 'sidebar', start, 'web')?.id).toBe(12)
    expect(resolveSlotCampaign(BOOT, 'sidebar', end - 1, 'web')?.id).toBe(12)
    expect(resolveSlotCampaign(BOOT, 'sidebar', end, 'web')?.id).toBe(10)
    // `hero` has null dates → always open.
    expect(resolveSlotCampaign(BOOT, 'hero', 0, 'web')?.id).toBe(12)
  })

  it('ignores campaigns that are not active, even with a matching slot', () => {
    // `footer` only exists on the paused campaign.
    expect(resolveSlotCampaign(BOOT, 'footer', OCT_15, 'web')?.id).toBe(10)
    expect(findSlotAssignment(BOOT, 'footer', OCT_15, 'web')).toBeNull()
  })

  it('falls back to the default campaign with no slot, a blank slot, or an unknown one', () => {
    expect(resolveSlotCampaign(BOOT, null, OCT_15, 'web')?.id).toBe(10)
    expect(resolveSlotCampaign(BOOT, undefined, OCT_15, 'web')?.id).toBe(10)
    expect(resolveSlotCampaign(BOOT, '   ', OCT_15, 'web')?.id).toBe(10)
    expect(resolveSlotCampaign(BOOT, 'nope', OCT_15, 'web')?.id).toBe(10)
    // The default comes from the list, sponsors included.
    expect(resolveSlotCampaign(BOOT, null)?.primarySponsor?.id).toBe(4)
  })

  it('trims the slot name on both sides', () => {
    expect(resolveSlotCampaign(BOOT, '  hero ', OCT_15, 'web')?.id).toBe(12)
    const padded: BootstrapResponse = {
      campaign: { id: 1, name: 'D' },
      campaigns: [{ id: 2, name: 'P', status: 'active', slots: [{ name: ' hero ' }] }],
    }
    expect(resolveSlotCampaign(padded, 'hero', OCT_15)?.id).toBe(2)
  })

  it('builds a minimal default entry from `campaign` when the list does not carry it', () => {
    const boot: BootstrapResponse = {
      campaign: { id: 3, name: 'Old shape', logo: null },
      primarySponsor: sponsor(4),
      secondarySponsors: [sponsor(5)],
    }
    const entry = resolveSlotCampaign(boot, 'hero', OCT_15, 'web')
    expect(entry).toMatchObject({ id: 3, name: 'Old shape', isDefault: true, slots: [] })
    expect(entry?.primarySponsor?.id).toBe(4)
    expect(entry?.secondarySponsors?.map((s) => s.id)).toEqual([5])
    expect(defaultCampaignEntry(boot)?.id).toBe(3)
  })

  it('returns null with no bootstrap, or with neither an assignment nor a default', () => {
    expect(resolveSlotCampaign(null, 'hero')).toBeNull()
    expect(resolveSlotCampaign(undefined, null)).toBeNull()
    expect(resolveSlotCampaign({}, 'hero', OCT_15, 'web')).toBeNull()
    expect(
      resolveSlotCampaign({ campaigns: [{ id: 2, name: 'P', status: 'active', slots: [{ name: 'hero' }] }] }, 'hero'),
    ).not.toBeNull()
  })

  it('never throws on a malformed campaigns[] or slots[]', () => {
    const garbage = [
      { campaign: { id: 1, name: 'D' }, campaigns: 'nope' },
      { campaign: { id: 1, name: 'D' }, campaigns: [null, 7, {}, { id: 2, status: 'active', slots: 'x' }] },
      { campaign: { id: 1, name: 'D' }, campaigns: [{ id: 2, status: 'active', slots: [null, 4, { name: 9 }] }] },
      { campaign: { id: 1, name: 'D' }, campaigns: [{ id: 2, status: 'active', slots: [{ name: 'hero', startDate: 'garbage', endDate: {} }] }] },
      { campaign: 'what', campaigns: [] },
      { campaign: { id: 'NaN?' } },
    ] as unknown as BootstrapResponse[]
    for (const boot of garbage) {
      expect(() => resolveSlotCampaign(boot, 'hero', OCT_15, 'web')).not.toThrow()
      expect(() => findSlotAssignment(boot, 'hero', OCT_15, 'web')).not.toThrow()
    }
    expect(resolveSlotCampaign(garbage[0], 'hero', OCT_15, 'web')?.id).toBe(1)
    expect(resolveSlotCampaign(garbage[1], 'hero', OCT_15, 'web')?.id).toBe(1)
    // Unparsable dates read as open — the assignment still applies.
    expect(resolveSlotCampaign(garbage[3], 'hero', OCT_15, 'web')?.id).toBe(2)
    expect(resolveSlotCampaign(garbage[4], 'hero', OCT_15, 'web')).toBeNull()
    expect(resolveSlotCampaign(garbage[5], 'hero', OCT_15, 'web')).toBeNull()
  })

  it('accepts ids as strings (the backend has sent them that way before)', () => {
    const boot = {
      campaign: { id: '10', name: 'D' },
      campaigns: [
        { id: '12', name: 'N', status: 'active', slots: [{ name: 'hero' }] },
        { id: '10', name: 'D', status: 'active', slots: [{ name: 'hero' }] },
      ],
    } as unknown as BootstrapResponse
    expect(resolveSlotCampaign(boot, 'hero', OCT_15)?.id).toBe('10')
  })
})

describe('normalizeSlotLocations', () => {
  it('trims, drops empties and non-strings, dedupes keeping order, caps at 100 chars', () => {
    const long = 'x'.repeat(150)
    const out = normalizeSlotLocations([
      '  hero ',
      '',
      '   ',
      { id: 'footer', displayName: ' Footer ' },
      'hero',
      { id: 'footer', displayName: 'Second name is ignored' },
      { id: long },
      null as unknown as string,
      42 as unknown as string,
      { id: '' },
    ])
    expect(out).toEqual([
      { id: 'hero' },
      { id: 'footer', displayName: 'Footer' },
      { id: 'x'.repeat(100) },
    ])
    expect(normalizeSlotLocations(null)).toEqual([])
    expect(normalizeSlotLocations('hero' as unknown as string[])).toEqual([])
  })

  it('normalizeSlotId mirrors the per-id rule', () => {
    expect(normalizeSlotId(' a ')).toBe('a')
    expect(normalizeSlotId('')).toBe('')
    expect(normalizeSlotId(undefined)).toBe('')
    expect(normalizeSlotId('y'.repeat(101))).toHaveLength(100)
  })
})

describe('declaration memory', () => {
  it('is fresh only for the same set (any order) within 24 h', () => {
    const at = OCT_15
    const memory = { keys: ['footer', 'hero'], at }
    expect(isSlotDeclarationFresh(memory, ['hero', 'footer'], at + 1_000)).toBe(true)
    expect(isSlotDeclarationFresh(memory, ['hero'], at + 1_000)).toBe(false)
    expect(isSlotDeclarationFresh(memory, ['hero', 'footer', 'x'], at + 1_000)).toBe(false)
    expect(isSlotDeclarationFresh(memory, ['hero', 'footer'], at + SLOT_DECLARATION_TTL_MS - 1)).toBe(true)
    expect(isSlotDeclarationFresh(memory, ['hero', 'footer'], at + SLOT_DECLARATION_TTL_MS)).toBe(false)
    // The clock went backwards (another device's time, a reset): not fresh.
    expect(isSlotDeclarationFresh(memory, ['hero', 'footer'], at - 1)).toBe(false)
    expect(isSlotDeclarationFresh(null, ['hero'], at)).toBe(false)
  })

  it('keys include the display name, so a renamed block is a different set', () => {
    const keys = slotDeclarationKeys([{ id: 'hero', displayName: 'Hero' }, { id: 'carousel-1' }])
    expect(keys).toEqual(['carousel-1', 'hero\u001fHero'])
    expect(slotDeclarationKeys([{ id: 'carousel-1' }, { id: 'hero', displayName: 'Hero' }])).toEqual(keys)
    expect(slotDeclarationKeys([{ id: 'hero', displayName: 'Hero banner' }, { id: 'carousel-1' }])).not.toEqual(keys)
    const at = OCT_15
    expect(isSlotDeclarationFresh({ keys, at }, slotDeclarationKeys([{ id: 'hero', displayName: 'Hero' }, { id: 'carousel-1' }]), at + 1)).toBe(true)
    expect(isSlotDeclarationFresh({ keys, at }, slotDeclarationKeys([{ id: 'hero' }, { id: 'carousel-1' }]), at + 1)).toBe(false)
  })

  it('keys storage by platform and a hash of the key — never the key itself', () => {
    const key = slotDeclarationStorageKey('vev', 'sk_live_SECRET_123')
    expect(key).not.toContain('SECRET')
    expect(key).toMatch(/^vio\.slots\.vev\.[0-9a-f]{8}$/)
    expect(slotDeclarationStorageKey('vev', 'sk_live_SECRET_123')).toBe(key)
    expect(slotDeclarationStorageKey('web', 'sk_live_SECRET_123')).not.toBe(key)
    expect(slotDeclarationStorageKey('vev', 'another-key')).not.toBe(key)
    expect(fnv1a('')).toBe('811c9dc5')
  })
})

describe('auto identity (no page path: one template, thousands of articles, one place)', () => {
  it('builds `${kind}-${ordinal + 1}`, prefixed by the scope when there is one', () => {
    expect(autoSlotId('carousel', 0)).toBe('carousel-1')
    expect(autoSlotId('card', 2)).toBe('card-3')
    expect(autoSlotId('detail', 0, '')).toBe('detail-1')
    expect(autoSlotId('carousel', 0, 'article-123')).toBe('article-123-carousel-1')
    expect(autoSlotId('card', 1, '  Sport front ')).toBe('Sport-front-card-2')
    expect(autoSlotId('card', 1, null)).toBe('card-2')
  })

  it('is stable: the same kind, ordinal and scope always give the same id', () => {
    expect(autoSlotId('carousel', 3, 'a')).toBe(autoSlotId('carousel', 3, 'a'))
    expect(autoSlotId('carousel', 3, 'a')).not.toBe(autoSlotId('carousel', 4, 'a'))
    expect(autoSlotId('carousel', 3, 'a')).not.toBe(autoSlotId('carousel', 3, 'b'))
    expect(autoSlotId('carousel', 3)).not.toBe(autoSlotId('card', 3))
  })

  it('names it `Kind N`, with the scope label when the scope has one', () => {
    expect(autoSlotDisplayName('carousel', 0)).toBe('Carousel 1')
    expect(autoSlotDisplayName('card', 2, '')).toBe('Card 3')
    expect(autoSlotDisplayName('detail', 0, ' Título del artículo ')).toBe('Detail 1 · Título del artículo')
    // The scope id alone is not a label.
    expect(autoSlotDisplayName('carousel', 0, undefined)).toBe('Carousel 1')
  })

  it('normalizeScope trims and joins inner whitespace', () => {
    expect(normalizeScope(' article 123 ')).toBe('article-123')
    expect(normalizeScope('')).toBe('')
    expect(normalizeScope(undefined)).toBe('')
    expect(normalizeScope(42 as unknown as string)).toBe('')
  })
})
