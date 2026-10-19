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
import { describe, expect, it } from 'vitest'
import { lineOriginWire } from '../cart/origin-wire.js'
import { checkoutAttributionOf } from '../checkout/attribution.js'
import {
  ADD_ITEM_MUTATION,
  CREATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION,
  UPDATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION,
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
