import { describe, it, expect } from 'vitest'
import { splitRateName } from './vio-product-detail.js'

describe('splitRateName — «Carrier - how» as the brand typed it', () => {
  it('splits the carrier from the way it delivers (Careless, prod, 2026-10-28)', () => {
    expect(splitRateName('Helthjem - til postkasse/dørmatte')).toEqual({ carrier: 'Helthjem', method: 'Til postkasse/dørmatte' })
    expect(splitRateName('Bring - Pakke i postkasse')).toEqual({ carrier: 'Bring', method: 'Pakke i postkasse' })
    expect(splitRateName('PostNord – Hentested')).toEqual({ carrier: 'PostNord', method: 'Hentested' })
  })

  it('leaves a name without the dash whole, and never splits inside a word', () => {
    expect(splitRateName('Default Shipping')).toEqual({ carrier: '', method: 'Default Shipping' })
    expect(splitRateName('Hent-selv')).toEqual({ carrier: '', method: 'Hent-selv' })
    expect(splitRateName(undefined)).toEqual({ carrier: '', method: '' })
  })
})
