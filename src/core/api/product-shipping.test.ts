import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildSchema, parse, validate } from 'graphql'
import { describe, expect, it } from 'vitest'
import { GET_PRODUCT_SHIPPING, shippingRatesFor } from './commerce.js'

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
      { id: 'd', name: 'Default', price: 10, currency: 'NOK', default: true },
      { id: 'x', name: 'Express', price: 100, currency: 'NOK', default: false },
    ])
    expect(shippingRatesFor(null, 'NO')).toEqual([])
  })
})

