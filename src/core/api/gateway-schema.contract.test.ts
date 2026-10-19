/**
 * The contract with the commerce gateway (`vio-live/graphql#30`,
 * `src/Infra/GraphQL/schema.gql`): every input type the SDK declares as a
 * variable, every argument it passes and every field it sends for the
 * order's attribution (ADR-0035 phase B) exists in the gateway's schema under
 * that exact name. Read from the real file when `VIO_GATEWAY_SCHEMA` points
 * at a checkout of the gateway, else from the copy in `__fixtures__` (taken
 * from #30 at `133bd2a`; refresh it when the gateway changes). A name that
 * drifts here would make the SDK fall back to the legacy shape — silently
 * but for a console line — so this test is what keeps the two in step.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildSchema, getOperationAST, getVariableValues, parse, validate } from 'graphql'
import { describe, expect, it } from 'vitest'
import { lineOriginWire } from '../cart/origin-wire.js'
import { checkoutAttributionOf } from '../checkout/attribution.js'
import {
  ADD_ITEM_MUTATION,
  CREATE_CHECKOUT_MUTATION,
  CREATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION,
  UPDATE_CHECKOUT_MUTATION,
  UPDATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION,
  UPDATE_ITEM_MUTATION,
  UPDATE_ITEM_WITH_ORIGIN_MUTATION,
} from './cart-queries.js'
import { featureTokens } from './gateway-features.js'

const schemaPath = process.env.VIO_GATEWAY_SCHEMA ?? fileURLToPath(new URL('./__fixtures__/gateway-schema.gql', import.meta.url))
const schema = readFileSync(schemaPath, 'utf8')

/** `name: Type` pairs of a block, its `"""` descriptions stripped. */
function declarations(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  const bare = block.replace(/"""[\s\S]*?"""/g, '')
  for (const m of bare.matchAll(/^\s*(\w+)\s*:\s*([\w[\]!]+)/gm)) out[m[1]!] = m[2]!
  return out
}

/** The fields of `input <name> { … }`. */
function inputFields(name: string): Record<string, string> {
  const m = schema.match(new RegExp(`\\ninput ${name} \\{([\\s\\S]*?)\\n\\}`))
  if (!m) throw new Error(`input ${name} is not in ${schemaPath}`)
  return declarations(m[1]!)
}

/** The arguments of a mutation field `Name(…): Type`. */
function argsOf(field: string): Record<string, string> {
  const m = schema.match(new RegExp(`\\n  ${field}\\(([\\s\\S]*?)\\n  \\): `))
  if (!m) throw new Error(`${field}( is not in ${schemaPath}`)
  return declarations(m[1]!)
}

/** `$name: Type` of a document's variables. */
function variablesOf(document: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of document.matchAll(/\$(\w+):\s*([\w[\]!]+)/g)) out[m[1]!] = m[2]!
  return out
}

/** The argument names a document passes to `Field(`. */
function passedArgs(document: string, field: string): string[] {
  const m = document.match(new RegExp(`${field}\\(([^)]*)\\)`))
  if (!m) throw new Error(`${field}( is not in the document`)
  return [...m[1]!.matchAll(/(\w+)\s*:\s*\$/g)].map((x) => x[1]!)
}

const bareType = (type: string) => type.replace(/[[\]!]/g, '')

/** A fully filled origin / attribution: every field the SDK can ever send. */
const ORIGIN = lineOriginWire(
  { campaignId: 1, slot: 'hero', componentKind: 'card', contentUrl: 'https://h.example/a', contentTitle: 'T' },
  { privacyMode: 'standard' },
)!
const ATTRIBUTION = checkoutAttributionOf({
  surfaceKey: 'k',
  pageCampaignId: 1,
  content: { url: 'https://h.example/a', title: 'T' },
  landing: { referrer: 'https://r.example/', utm: { utm_source: 's', utm_medium: 'm', utm_campaign: 'c' }, url: 'https://h.example/l' },
  privacyMode: 'standard',
})!

describe(`the gateway schema (${process.env.VIO_GATEWAY_SCHEMA ? 'VIO_GATEWAY_SCHEMA' : 'fixture'})`, () => {
  it('has every input type the SDK declares as a variable, under that name', () => {
    for (const document of [UPDATE_ITEM_WITH_ORIGIN_MUTATION, CREATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION, UPDATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION, ADD_ITEM_MUTATION]) {
      for (const type of Object.values(variablesOf(document)).map(bareType)) {
        if (['String', 'Int', 'Boolean', 'Float', 'ID'].includes(type)) continue
        expect(schema, `input ${type} declared by the SDK`).toMatch(new RegExp(`\\ninput ${type} \\{`))
      }
    }
  })

  it('names the features by the gateway\'s own names (what a refusal would quote)', () => {
    for (const feature of ['line_origin', 'checkout_attribution'] as const) {
      const [argument, ...types] = featureTokens(feature)
      expect(types.length).toBeGreaterThan(0)
      for (const type of types) expect(schema, `input ${type} of ${feature}`).toMatch(new RegExp(`\\ninput ${type} \\{`))
      expect(argument).toMatch(/^[a-z_]+$/)
    }
    expect(featureTokens('line_origin')[0]).toBe('origin')
    expect(featureTokens('checkout_attribution')[0]).toBe('attribution')
  })

  it('AddItem: LineItemInput.origin is the line origin, with every field the SDK sends', () => {
    const lineItem = inputFields('LineItemInput')
    expect(lineItem.origin).toBeDefined()
    expect(featureTokens('line_origin')).toContain(bareType(lineItem.origin!))
    const origin = inputFields(bareType(lineItem.origin!))
    for (const field of Object.keys(ORIGIN)) expect(origin, `origin.${field}`).toHaveProperty(field)
    expect(origin.campaign_id).toBe('Int')
  })

  it('UpdateItem: takes origin of the SDK\'s variable type, and every argument the SDK passes', () => {
    const args = argsOf('UpdateItem')
    const vars = variablesOf(UPDATE_ITEM_WITH_ORIGIN_MUTATION)
    expect(args.origin).toBe(vars.origin)
    expect(featureTokens('line_origin')).toContain(bareType(args.origin!))
    for (const name of passedArgs(UPDATE_ITEM_WITH_ORIGIN_MUTATION, 'UpdateItem')) expect(args, `UpdateItem(${name})`).toHaveProperty(name)
  })

  it('CreateCheckout / UpdateCheckout: take attribution of the SDK\'s variable type, with every field and every argument the SDK sends', () => {
    for (const [field, document] of [
      ['CreateCheckout', CREATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION],
      ['UpdateCheckout', UPDATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION],
    ] as const) {
      const args = argsOf(field)
      expect(args.attribution).toBe(variablesOf(document).attribution)
      expect(featureTokens('checkout_attribution')).toContain(bareType(args.attribution!))
      for (const name of passedArgs(document, field)) expect(args, `${field}(${name})`).toHaveProperty(name)
    }
    const attribution = inputFields(bareType(argsOf('CreateCheckout').attribution!))
    for (const field of Object.keys(ATTRIBUTION)) expect(attribution, `attribution.${field}`).toHaveProperty(field)
    expect(attribution.campaign_id).toBe('Int')
    const entryType = bareType(attribution.entry!)
    expect(featureTokens('checkout_attribution')).toContain(entryType)
    const entry = inputFields(entryType)
    for (const field of Object.keys(ATTRIBUTION.entry!)) expect(entry, `entry.${field}`).toHaveProperty(field)
  })
})

describe('the gateway schema, validated for real (graphql)', () => {
  const built = buildSchema(schema)

  /** The operation validated against the schema and its variables coerced — what the gateway does before running anything. */
  function accepts(document: string, variables: Record<string, unknown>) {
    const doc = parse(document)
    const errors = validate(built, doc)
    expect(errors.map((e) => e.message)).toEqual([])
    const operation = getOperationAST(doc)!
    const coerced = getVariableValues(built, operation.variableDefinitions ?? [], variables)
    expect((coerced.errors ?? []).map((e) => e.message)).toEqual([])
    return coerced.coerced!
  }

  it('AddItem with origin on the line', () => {
    const coerced = accepts(ADD_ITEM_MUTATION, {
      cartId: 'c',
      lineItems: [{ product_id: 9, quantity: 1, variant_id: null, origin: ORIGIN }],
    })
    expect((coerced.lineItems as Array<{ origin: unknown }>)[0]!.origin).toEqual(ORIGIN)
  })

  it('UpdateItem with $origin', () => {
    const coerced = accepts(UPDATE_ITEM_WITH_ORIGIN_MUTATION, { cartId: 'c', cartItemId: 'i', shippingId: null, qty: 2, origin: ORIGIN })
    expect(coerced.origin).toEqual(ORIGIN)
  })

  it('CreateCheckout and UpdateCheckout with $attribution', () => {
    expect(accepts(CREATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION, { cartId: 'c', attribution: ATTRIBUTION }).attribution).toEqual(ATTRIBUTION)
    const vars = {
      checkoutId: 'CHK',
      email: 'kari@example.no',
      buyerAcceptsPurchaseConditions: true,
      buyerAcceptsTermsConditions: true,
      attribution: ATTRIBUTION,
    }
    expect(accepts(UPDATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION, vars).attribution).toEqual(ATTRIBUTION)
  })

  it('a campaign_id over Int would be refused at coercion — which is why the SDK never sends one', () => {
    const doc = parse(UPDATE_ITEM_WITH_ORIGIN_MUTATION)
    const operation = getOperationAST(doc)!
    const coerced = getVariableValues(built, operation.variableDefinitions ?? [], {
      cartId: 'c',
      cartItemId: 'i',
      qty: 2,
      origin: { campaign_id: 2_147_483_648 },
    })
    expect(coerced.errors?.length ?? 0).toBeGreaterThan(0)
    expect(lineOriginWire({ campaignId: 2_147_483_648, slot: 'hero' }, { privacyMode: 'standard' })).not.toHaveProperty('campaign_id')
  })

  it('the legacy documents validate too (what a gateway that predates the arguments gets)', () => {
    for (const [document, variables] of [
      [UPDATE_ITEM_MUTATION, { cartId: 'c', cartItemId: 'i', shippingId: null, qty: 1 }],
      [CREATE_CHECKOUT_MUTATION, { cartId: 'c' }],
      [UPDATE_CHECKOUT_MUTATION, { checkoutId: 'CHK' }],
    ] as const) {
      accepts(document, variables as Record<string, unknown>)
    }
  })
})
