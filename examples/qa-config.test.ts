/**
 * The QA page's URL → what `Vio.init` gets (examples/qa-config.ts). Alan runs
 * this branch locally against QA (`npm run dev`) and shapes the page with the
 * URL, e.g. `?env=testing&campaignId=18` — the code is the campaign's, set in
 * the dashboard — or `&discountCode=qa_gave&discountField=true` to try a page's own.
 */
import { describe, expect, it } from 'vitest'
import { describeQaConfig, readQaConfig } from './qa-config'

describe('the campaign\'s code: the URL names none', () => {
  it('only the campaign: nothing about codes goes to Vio.init — the SDK takes the campaign\'s from the bootstrap', () => {
    const c = readQaConfig('?env=testing&campaignId=18', { VITE_VIO_API_KEY: 'surface-key' })
    expect(c.init).toEqual({ apiKey: 'surface-key', environment: 'testing', campaignId: 18 })
    expect(describeQaConfig(c)).toBe('env testing · campaña 18 · código: el de la campaña · campo: por defecto')
  })

  it('the bar says the code the campaign gives the brand once the bootstrap is in — or that it gives none', () => {
    const c = readQaConfig('?campaignId=18', { VITE_VIO_API_KEY: 'k' })
    expect(describeQaConfig(c, 'qa_gave')).toContain('código qa_gave (campaña)')
    expect(describeQaConfig(c, null)).toContain('sin código (la campaña no da ninguno)')
  })

  it('a page\'s own code (config or ?vio_discount=) is what the bar says: it wins over the campaign\'s', () => {
    expect(describeQaConfig(readQaConfig('?apiKey=k&discountCode=SIDE'), 'qa_gave')).toContain('código SIDE (config)')
    expect(describeQaConfig(readQaConfig('?apiKey=k&vio_discount=LENKE'), 'qa_gave')).toContain('código LENKE (?vio_discount)')
  })
})

describe('readQaConfig', () => {
  it('the QA URL of the discount campaign: QA, the campaign, its code and the field', () => {
    const c = readQaConfig('?env=testing&campaignId=18&discountCode=qa_gave&discountField=true', { VITE_VIO_API_KEY: 'surface-key' })
    expect(c.init).toEqual({ apiKey: 'surface-key', environment: 'testing', campaignId: 18, discountCode: 'qa_gave', discountField: true })
    expect(c.productIds).toEqual([])
    expect(describeQaConfig(c)).toBe('env testing · campaña 18 · código qa_gave (config) · campo: sí')
  })

  it('the key: the URL\'s first, else .env.local\'s; none at all, nothing is initialised', () => {
    expect(readQaConfig('?apiKey=from-url', { VITE_VIO_API_KEY: 'from-env' }).init?.apiKey).toBe('from-url')
    expect(readQaConfig('', { VITE_VIO_API_KEY: ' from-env ' }).init?.apiKey).toBe('from-env')
    const none = readQaConfig('?campaignId=18', {})
    expect(none.apiKey).toBe('')
    expect(none.init).toBeNull()
  })

  it('env: testing unless the URL names another the SDK knows', () => {
    expect(readQaConfig('?apiKey=k').env).toBe('testing')
    expect(readQaConfig('?apiKey=k&env=production').init?.environment).toBe('production')
    expect(readQaConfig('?apiKey=k&env=staging').env).toBe('testing')
  })

  it('discountField: true / false as written, anything else is the SDK\'s default (left out)', () => {
    expect(readQaConfig('?apiKey=k&discountField=false').init).toMatchObject({ discountField: false })
    for (const v of ['', 'yes', '1', 'TRUE']) {
      expect(readQaConfig(`?apiKey=k&discountField=${v}`).init, v).not.toHaveProperty('discountField')
    }
    expect(readQaConfig('?apiKey=k').init).not.toHaveProperty('discountField')
  })

  it('no code, no campaign: neither goes to Vio.init (a plain page)', () => {
    const c = readQaConfig('?apiKey=k&campaignId=abc&discountCode=%20')
    expect(c.init).toEqual({ apiKey: 'k', environment: 'testing' })
    // The code, if any, is the default campaign's: known once the bootstrap is in.
    expect(describeQaConfig(c)).toBe('env testing · sin campaña (la de la surface) · código: el de la campaña · campo: por defecto')
  })

  it('?vio_discount= is left to the SDK — only said on the page; discountCode wins when both are there', () => {
    const url = readQaConfig('?apiKey=k&vio_discount=FRA-LENKE')
    expect(url.init).not.toHaveProperty('discountCode')
    expect(describeQaConfig(url)).toContain('código FRA-LENKE (?vio_discount)')
    expect(describeQaConfig(readQaConfig('?apiKey=k&vio_discount=FRA-LENKE&discountCode=qa_gave'))).toContain('código qa_gave (config)')
  })

  it('productIds: the numbers in it, in order; anything else is skipped', () => {
    expect(readQaConfig('?apiKey=k&productIds=421306, 9,x,-3,0,12.5').productIds).toEqual([421306, 9])
  })

  it('the dev proxies of .env.local go to QA: used for testing, never for production', () => {
    const vars = { VITE_VIO_API_KEY: 'k', VITE_VIO_API_BASE: '/proxy-vio', VITE_VIO_GRAPHQL_BASE: '/proxy-graphql' }
    expect(readQaConfig('?env=testing', vars).init).toMatchObject({ apiBase: '/proxy-vio', graphQLBase: '/proxy-graphql' })
    const prod = readQaConfig('?env=production', vars).init
    expect(prod).not.toHaveProperty('apiBase')
    expect(prod).not.toHaveProperty('graphQLBase')
  })
})
