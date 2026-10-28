import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildSchema, parse, validate } from 'graphql'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommerceClient,
  GET_PRODUCT_SHIPPING,
  GET_PRODUCT_SHIPPING_WITH_LOGO,
  resetShippingLogoSupport,
  shippingRatesFor,
} from './commerce.js'

/** The product's shipping rates, for «Frakt fra» in the detail (2026-10-28). */
describe('the rates query', () => {
  it('is valid against the gateway schema', () => {
    const schema = buildSchema(
      readFileSync(fileURLToPath(new URL('./__fixtures__/gateway-schema.gql', import.meta.url)), 'utf8'),
    )
    expect(validate(schema, parse(GET_PRODUCT_SHIPPING))).toEqual([])
  })

  it('reads the page country’s price, tax included, cheapest first', () => {
    const raw = [
      { id: 'x', name: 'Express', default: false, shipping_country: [{ country: 'NO', price: { amount: 80, amount_incl_taxes: 100, currency_code: 'NOK' } }] },
      { id: 'd', name: 'Default', default: true, shipping_country: [
        { country: 'SE', price: { amount: 1, currency_code: 'SEK' } },
        { country: 'NO', price: { amount: 8, amount_incl_taxes: 10, currency_code: 'NOK' } },
      ] },
      { id: 'z', name: 'Sweden only', default: false, shipping_country: [{ country: 'SE', price: { amount: 1, currency_code: 'SEK' } }] },
    ]
    expect(shippingRatesFor(raw, 'NO')).toEqual([
      { id: 'd', name: 'Default', price: 10, currency: 'NOK', default: true, description: '', logoUrl: '' },
      { id: 'x', name: 'Express', price: 100, currency: 'NOK', default: false, description: '', logoUrl: '' },
    ])
    expect(shippingRatesFor(null, 'NO')).toEqual([])
  })
})

/** What the brand wrote on each rate and the carrier's logo, for «Frakt & retur» (2026-10-28). */
describe('the delivery time and the carrier logo of a rate', () => {
  const NO = (amount: number) => [{ country: 'NO', price: { amount, currency_code: 'NOK' } }]

  it('carries the rate’s description (Careless in prod: «Leveringstid 1-5 dager») and an https logo only', () => {
    const raw = [
      { id: 'h', name: 'Helthjem - til postkasse/dørmatte', description: ' Leveringstid 1-5 dager ', logo_url: 'https://cdn.vio.live/helthjem.svg', default: true, shipping_country: NO(59) },
      { id: 'b', name: 'Bring - Pakke i postkasse', description: null, logo_url: 'http://insecure/bring.png', default: false, shipping_country: NO(79) },
      { id: 'j', name: 'Hent selv', logo_url: 'javascript:alert(1)', default: false, shipping_country: NO(0) },
    ]
    const rates = shippingRatesFor(raw, 'NO')
    expect(rates.map((r) => [r.id, r.description, r.logoUrl])).toEqual([
      ['j', '', ''],
      ['h', 'Leveringstid 1-5 dager', 'https://cdn.vio.live/helthjem.svg'],
      ['b', '', ''],
    ])
  })

  it('the query with logo_url is the plain one plus that field (refused by a gateway without it, as today’s)', () => {
    const schema = buildSchema(
      readFileSync(fileURLToPath(new URL('./__fixtures__/gateway-schema.gql', import.meta.url)), 'utf8'),
    )
    expect(GET_PRODUCT_SHIPPING).toContain('description')
    expect(GET_PRODUCT_SHIPPING_WITH_LOGO.replace(/\s*logo_url/, '').replace('WithLogo', '')).toBe(GET_PRODUCT_SHIPPING)
    const errors = validate(schema, parse(GET_PRODUCT_SHIPPING_WITH_LOGO))
    if (errors.length) expect(errors.map((e) => e.message).join(' ')).toContain('logo_url')
  })

  describe('against the gateway', () => {
    const answer = { Channel: { GetProductsByIds: [{ id: 1, product_shipping: [{ id: 'h', name: 'Helthjem - x', description: 'Leveringstid 1-5 dager', default: true, shipping_country: NO(59) }] }] } }
    beforeEach(() => resetShippingLogoSupport())

    it('a gateway without logo_url: asked again without it, the rates arrive, and the page stops asking for it', async () => {
      const client = new CommerceClient({ endpoint: 'https://graph.example', apiKey: 'k' })
      const request = vi.spyOn(client.raw, 'request').mockImplementation((async (query: string) => {
        if (String(query).includes('logo_url')) throw new Error('Cannot query field "logo_url" on type "ProductShipping".')
        return answer
      }) as any)
      const first = await client.channel.product.getShippingRates(1, { country: 'NO', currency: 'NOK' })
      expect(first?.map((r) => r.description)).toEqual(['Leveringstid 1-5 dager'])
      expect(request).toHaveBeenCalledTimes(2)
      await client.channel.product.getShippingRates(1, { country: 'NO', currency: 'NOK' })
      expect(request).toHaveBeenCalledTimes(3) // straight to the plain query
      expect(String(request.mock.calls[2]?.[0])).not.toContain('logo_url')
    })

    it('any other failure is still «could not be read» (null), not a second try', async () => {
      const client = new CommerceClient({ endpoint: 'https://graph.example', apiKey: 'k' })
      const request = vi.spyOn(client.raw, 'request').mockRejectedValue(new Error('socket hang up'))
      expect(await client.channel.product.getShippingRates(1, { country: 'NO' })).toBeNull()
      expect(request).toHaveBeenCalledTimes(1)
    })
  })
})
