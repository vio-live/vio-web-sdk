import { describe, it, expect } from 'vitest'
import { shippingRatesShown, splitRateName } from './vio-product-detail.js'

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

describe('shippingRatesShown — a description that is only filler is no delivery time', () => {
  const rate = (name: string, description: string) => ({ name, description, price: 49, currency: 'NOK', logoUrl: '' })

  it('drops a description equal to the product title, the brand or the seller (products defaults on imports)', () => {
    const shown = shippingRatesShown(
      [
        rate('Helthjem', '  Ullgenser Merino '),
        rate('Bring', 'careless'),
        rate('Posten', 'Ola Nordmann'),
        rate('PostNord', 'Leveringstid 1-5 dager'),
      ],
      ['Ullgenser merino', 'Careless', 'Ola Nordmann', undefined, null],
    )
    expect(shown.map((r) => r.description)).toEqual(['', '', '', 'Leveringstid 1-5 dager'])
  })

  it('drops the rate’s own name and the fixed fillers, and does not touch the input', () => {
    const input = [rate('Hjemlevering', 'hjemlevering'), rate('Bring', 'By Outshifter'), rate('Bring', 'default shipping method ')]
    expect(shippingRatesShown(input).map((r) => r.description)).toEqual(['', '', ''])
    expect(input[0]!.description).toBe('hjemlevering')
  })
})
