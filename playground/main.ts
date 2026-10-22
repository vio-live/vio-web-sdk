/**
 * SDK playground — the components straight from `src/`, on a page you can
 * deploy without publishing to npm (Vercel project `vio-demo`).
 *
 * A host page in miniature: one editorial article with a carousel and product
 * cards, the detail / cart / checkout overlays, a theme drawer that drives
 * `applyVioTheme` exactly like Vev's Config block, and width presets for the
 * article column. The surface key is pasted once and kept in THIS browser's
 * localStorage only — never in the bundle.
 *
 * Run locally: `npm run playground`. Deploy: `npm run playground:deploy`.
 */

import { Vio, SDK_VERSION, formatPrice, getGlobalCurrency } from '../src/index'
import { applyVioTheme, type VioThemeOverrides } from '../src/ui/index'

declare const __GIT_SHA__: string

type Env = 'testing' | 'production'
type Sponsor = { id: number; name: string }
type CatalogProduct = {
  id: number
  brand?: string
  title?: string
  options_enabled?: boolean
  options?: unknown[]
  variants?: Array<{ id: number; title?: string }>
  price?: { amount?: number; amount_incl_taxes?: number; currency_code?: string }
  images?: Array<{ url?: string }>
}

const STORE = 'vio.playground.v1'
type Saved = {
  env?: Env
  key?: string
  sponsorId?: number
  width?: string
  theme?: VioThemeOverrides
  corners?: string
  density?: string
  refs?: string
}

const load = (): Saved => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}') as Saved
  } catch {
    return {}
  }
}
const save = (patch: Partial<Saved>): void => {
  try {
    localStorage.setItem(STORE, JSON.stringify({ ...load(), ...patch }))
  } catch {
    /* private mode: the page still works, it just forgets */
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const status = (text: string, error = false) => {
  const el = $('pg-status')
  el.textContent = text
  el.classList.toggle('err', error)
}

$('pg-version').textContent = `SDK ${SDK_VERSION} · ${__GIT_SHA__}`

// ---- the same catalog query Vev's product picker uses ----------------------
const PRODUCTS_QUERY = `
  query Products($currency: String, $shippingCountryCode: String, $imageSize: ImageSize, $useCache: Boolean!) {
    Channel {
      Products(barcode_list: [], sku_list: [], category_ids: [], product_ids: [], currency: $currency,
        image_size: $imageSize, useCache: $useCache, shipping_country_code: $shippingCountryCode) {
        id brand title options_enabled
        options { id name values }
        variants { id title }
        price { amount amount_incl_taxes currency_code }
        images { url }
      }
    }
  }
`

let sponsors: Sponsor[] = []
let catalog: CatalogProduct[] = []

function sponsorsOf(boot: any): Sponsor[] {
  const seen = new Map<number, Sponsor>()
  const add = (s: any) => {
    const id = Number(s?.id)
    if (Number.isInteger(id) && id > 0 && !seen.has(id)) seen.set(id, { id, name: String(s?.name ?? `Sponsor ${id}`) })
  }
  add(boot?.primarySponsor)
  for (const s of boot?.secondarySponsors ?? []) add(s)
  for (const c of boot?.campaigns ?? []) {
    add(c?.primarySponsor)
    for (const s of c?.secondarySponsors ?? []) add(s)
  }
  return [...seen.values()]
}

const hasVariants = (p: CatalogProduct) =>
  Boolean(p.options_enabled) ||
  (Array.isArray(p.options) && p.options.length > 0) ||
  (Array.isArray(p.variants) && p.variants.length > 1)

function priceOf(p: CatalogProduct): string {
  const amount = p.price?.amount_incl_taxes ?? p.price?.amount
  if (amount == null) return ''
  const label = formatPrice(Number(amount), p.price?.currency_code || getGlobalCurrency())
  return hasVariants(p) ? `Fra ${label}` : label
}

async function connect(): Promise<void> {
  const env = ($('pg-env') as HTMLSelectElement).value as Env
  const key = ($('pg-key') as HTMLInputElement).value.trim()
  if (!key) {
    status('Paste a surface key first.', true)
    return
  }
  save({ env, key })
  status('Connecting…')
  try {
    Vio.init({ apiKey: key, environment: env, platform: 'web' })
    const boot = await Vio.bootstrap()
    sponsors = sponsorsOf(boot)
    if (sponsors.length === 0) throw new Error('the bootstrap answered no sponsor for this key')
    const select = $('pg-sponsor') as HTMLSelectElement
    select.innerHTML = sponsors.map((s) => `<option value="${s.id}">${s.name} (${s.id})</option>`).join('')
    const wanted = load().sponsorId
    select.value = String(sponsors.some((s) => s.id === wanted) ? wanted : sponsors[0]!.id)
    await loadSponsor(Number(select.value))
  } catch (err) {
    status(`Could not connect: ${err instanceof Error ? err.message : String(err)}`, true)
  }
}

async function loadSponsor(sponsorId: number): Promise<void> {
  save({ sponsorId })
  status(`Loading the catalog of sponsor ${sponsorId}…`)
  try {
    const data: any = await Vio.commerceFor(sponsorId).raw.request(PRODUCTS_QUERY, {
      currency: getGlobalCurrency() || 'NOK',
      shippingCountryCode: 'NO',
      imageSize: 'large',
      useCache: true,
    })
    catalog = (data?.Channel?.Products ?? []) as CatalogProduct[]
    const saved = load().refs
    const refs = saved && saved.startsWith(`${sponsorId}:`) ? saved : defaultRefs(sponsorId)
    ;($('pg-refs') as HTMLTextAreaElement).value = refs
    render(sponsorId, refs)
    const name = sponsors.find((s) => s.id === sponsorId)?.name ?? sponsorId
    status(`Connected · ${name} · ${catalog.length} products in the catalog`)
  } catch (err) {
    status(`Catalog failed: ${err instanceof Error ? err.message : String(err)}`, true)
  }
}

const defaultRefs = (sponsorId: number) =>
  catalog
    .slice(0, 8)
    .map((p) => `${sponsorId}:${p.id}`)
    .join(',')

function render(sponsorId: number, refs: string): void {
  const sponsorName = sponsors.find((s) => s.id === sponsorId)?.name ?? ''
  const slot = $('pg-carousel-slot')
  if (!refs) {
    slot.innerHTML = '<div class="pg-empty">This sponsor has no products in its catalog.</div>'
  } else {
    slot.innerHTML = ''
    const carousel = document.createElement('vio-product-carousel')
    carousel.setAttribute('label', 'Redaksjonens favoritter')
    carousel.setAttribute('heading', 'Shop favorittene')
    carousel.setAttribute('disclaimer', 'annonselenker')
    carousel.setAttribute('product-refs', refs)
    slot.appendChild(carousel)
  }

  const ids = refs
    .split(',')
    .map((r) => Number(r.split(':')[1]))
    .filter((n) => Number.isInteger(n))
  const picked = ids.map((id) => catalog.find((p) => Number(p.id) === id)).filter(Boolean) as CatalogProduct[]
  const card = (p: CatalogProduct) => {
    const el = document.createElement('vio-product')
    el.setAttribute('product-id', String(p.id))
    el.setAttribute('sponsor-id', String(sponsorId))
    el.setAttribute('brand', p.brand ?? '')
    el.setAttribute('name', p.title ?? '')
    el.setAttribute('price', priceOf(p))
    el.setAttribute('retailer', sponsorName)
    el.setAttribute('image-url', p.images?.[0]?.url ?? '')
    if (hasVariants(p)) el.setAttribute('has-variants', '')
    return el
  }
  $('pg-cards').replaceChildren(...picked.slice(0, 3).map(card))
  $('pg-single').replaceChildren(...picked.slice(3, 4).map(card))
}

// ---- the host's wiring: what Vev's Config block does ------------------------
const cartEl = () => document.querySelector('vio-cart') as (HTMLElement & { show?: () => void; close?: () => void }) | null
const checkoutEl = () =>
  document.querySelector('vio-checkout') as (HTMLElement & { show?: () => void; express?: boolean }) | null

const openCart = () => cartEl()?.show?.()
document.addEventListener('vio:open-cart', openCart)
document.addEventListener('vio:added-to-cart', openCart)
document.addEventListener('vio:checkout-open', (e: Event) => {
  const d = ((e as CustomEvent).detail ?? {}) as { sponsorId?: number; paymentMethod?: string; express?: boolean }
  cartEl()?.close?.()
  try {
    if (d.sponsorId) Vio.checkout.open(Number(d.sponsorId))
    if (d.paymentMethod) Vio.checkout.selectPaymentMethod(d.paymentMethod as any)
  } catch (err) {
    console.warn('[playground] checkout.open failed', err)
  }
  setTimeout(() => {
    const el = checkoutEl()
    if (el) el.express = !!d.express
    el?.show?.()
  }, 200)
})
$('pg-cart-fab').addEventListener('click', openCart)
const countCart = () => ($('pg-cart-count').textContent = String(Vio.cart.itemCount ?? 0))
Vio.cart.addEventListener('change', countCart)

// ---- width presets ----------------------------------------------------------
function setWidth(w: string): void {
  $('pg-frame').dataset.width = w
  for (const b of $('pg-width').querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.w === w))
  save({ width: w })
}
$('pg-width').addEventListener('click', (e) => {
  const w = (e.target as HTMLElement).dataset.w
  if (w) setWidth(w)
})

// ---- theme: the same overrides and presets as Vev's Config block -------------
const COLOR_KEYS: Array<[keyof VioThemeOverrides, string]> = [
  ['colorAccent', 'Accent'],
  ['colorTextOnPrimary', 'Text on accent'],
  ['colorText', 'Text'],
  ['colorTextSecondary', 'Secondary text'],
  ['colorTextTertiary', 'Tertiary text'],
  ['colorSurface', 'Background'],
  ['colorSurfaceMuted', 'Muted background'],
  ['colorSurfaceHover', 'Hover background'],
  ['colorBorder', 'Border'],
  ['colorBorderDefault', 'Border (strong)'],
]
const FONT_KEYS: Array<[keyof VioThemeOverrides, string]> = [
  ['fontSerif', 'Heading font'],
  ['fontSans', 'Body font'],
]
const CORNERS: Record<string, VioThemeOverrides> = {
  default: { radiusSm: undefined, radiusMd: undefined, radiusLg: undefined, radiusXl: undefined },
  sharp: { radiusSm: '0', radiusMd: '0', radiusLg: '0', radiusXl: '0' },
  rounded: { radiusSm: '4px', radiusMd: '8px', radiusLg: '14px', radiusXl: '28px' },
}
const DENSITY: Record<string, VioThemeOverrides> = {
  default: { spaceSm: undefined, spaceMd: undefined, spaceLg: undefined, spaceXl: undefined },
  compact: { spaceSm: '6px', spaceMd: '12px', spaceLg: '16px', spaceXl: '24px' },
  roomy: { spaceSm: '10px', spaceMd: '20px', spaceLg: '32px', spaceXl: '44px' },
}

let theme: VioThemeOverrides = {}
let corners = 'default'
let density = 'default'

function currentOverrides(): VioThemeOverrides {
  return { ...theme, ...CORNERS[corners], ...DENSITY[density] }
}

function applyTheme(): void {
  const all = currentOverrides()
  applyVioTheme(all)
  const set = Object.fromEntries(Object.entries(all).filter(([, v]) => v))
  $('pg-theme-json').textContent = JSON.stringify(set, null, 2)
  save({ theme, corners, density })
  for (const [id, value] of [
    ['pg-radius', corners],
    ['pg-density', density],
  ] as const) {
    for (const b of $(id).querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.v === value))
  }
}

function buildThemeFields(): void {
  const root = $('pg-theme-fields')
  const css = getComputedStyle(document.documentElement)
  const cssVar = (k: string) => `--vio-${k.replace(/^color/, 'color-').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`
  const row = (key: keyof VioThemeOverrides, label: string, kind: 'color' | 'text') => {
    const r = document.createElement('div')
    r.className = 'row'
    const name = document.createElement('span')
    name.textContent = label
    const input = document.createElement('input')
    input.type = kind
    const current = theme[key] ?? css.getPropertyValue(cssVar(key)).trim()
    input.value = kind === 'color' ? toHex(current) : (theme[key] ?? '')
    if (kind === 'text') input.placeholder = css.getPropertyValue(cssVar(key)).trim() || 'default'
    input.addEventListener('input', () => {
      theme = { ...theme, [key]: input.value || undefined }
      applyTheme()
    })
    const clear = document.createElement('button')
    clear.className = 'clear'
    clear.title = 'Back to the SDK default'
    clear.textContent = '↺'
    clear.addEventListener('click', () => {
      theme = { ...theme, [key]: undefined }
      applyTheme()
      buildThemeFields()
    })
    const right = document.createElement('span')
    right.append(input, clear)
    r.append(name, right)
    return r
  }
  const head = (t: string) => Object.assign(document.createElement('h3'), { textContent: t })
  root.replaceChildren(
    head('Colors'),
    ...COLOR_KEYS.map(([k, l]) => row(k, l, 'color')),
    head('Fonts'),
    ...FONT_KEYS.map(([k, l]) => row(k, l, 'text')),
  )
}

/** `<input type=color>` only takes #rrggbb. */
function toHex(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  if (/^#[0-9a-f]{3}$/i.test(value)) return '#' + value.slice(1).replace(/./g, (c) => c + c)
  const m = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (m) return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
  return '#000000'
}

$('pg-radius').addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).dataset.v
  if (v) {
    corners = v
    applyTheme()
  }
})
$('pg-density').addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).dataset.v
  if (v) {
    density = v
    applyTheme()
  }
})
$('pg-theme-reset').addEventListener('click', () => {
  // Every key explicitly undefined: applyVioTheme removes it, back to the SDK default.
  const cleared = Object.fromEntries([...COLOR_KEYS, ...FONT_KEYS].map(([k]) => [k, undefined])) as VioThemeOverrides
  applyVioTheme(cleared)
  theme = {}
  corners = 'default'
  density = 'default'
  applyTheme()
  buildThemeFields()
})
$('pg-theme-copy').addEventListener('click', async () => {
  const text = $('pg-theme-json').textContent ?? '{}'
  try {
    await navigator.clipboard.writeText(text)
    status('Theme copied as JSON — paste it into applyVioTheme(…) or the Vev Config fields.')
  } catch {
    status('Could not copy; select the JSON in the theme drawer instead.', true)
  }
})
$('pg-theme-toggle').addEventListener('click', () => $('pg-theme').classList.toggle('open'))
$('pg-theme-close').addEventListener('click', () => $('pg-theme').classList.remove('open'))
$('pg-refs-apply').addEventListener('click', () => {
  const refs = ($('pg-refs') as HTMLTextAreaElement).value.replace(/\s+/g, '')
  const sponsorId = Number(($('pg-sponsor') as HTMLSelectElement).value)
  save({ refs })
  render(sponsorId, refs)
})

// ---- boot -------------------------------------------------------------------
const saved = load()
;($('pg-env') as HTMLSelectElement).value = saved.env ?? 'testing'
;($('pg-key') as HTMLInputElement).value = saved.key ?? ''
theme = saved.theme ?? {}
corners = saved.corners ?? 'default'
density = saved.density ?? 'default'
setWidth(saved.width ?? 'full')
applyTheme()
buildThemeFields()
$('pg-connect').addEventListener('click', () => void connect())
;($('pg-sponsor') as HTMLSelectElement).addEventListener('change', (e) =>
  void loadSponsor(Number((e.target as HTMLSelectElement).value)),
)
if (saved.key) void connect()
