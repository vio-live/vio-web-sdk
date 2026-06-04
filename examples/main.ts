/**
 * Demo wire-up.
 *
 * Boots the SDK, seeds the carousel with mock products, and connects
 * the existing UI components to the new `Vio.cart` + `Vio.checkout`
 * managers (multi-sponsor capable, with localStorage persistence).
 *
 * Run with: `npm run dev` from project root.
 */

import { Vio } from '../src/index'
import type { VioCart } from '../src/ui/components/vio-cart'
import type { VioCheckout } from '../src/ui/components/vio-checkout'
import type { CartChangeDetail } from '../src/core/cart/cart-manager'

// Init — env-aware. Demo uses mock key if not provided.
Vio.init({
  apiKey: (import.meta.env.VITE_VIO_API_KEY as string | undefined) ?? 'demo_api_key_xxx',
  environment: 'development',
  // Stripe publishable key — required for Apple Pay (Payment Request).
  // Without it the Apple Pay button is hidden gracefully. Use Stripe's
  // public test key for trying locally (works in Safari with Apple Pay):
  //   pk_test_TYooMQauvdEDq54NiTphI7jx
  stripePublishableKey: import.meta.env.VITE_VIO_STRIPE_PK as string | undefined,
})

interface DemoProduct {
  id: number
  brand: string
  name: string
  unitPrice: number
  retailer: string  // display retailer (Norwegian convention: separate from brand)
  imageUrl: string
}

/** Sponsor id → display name. Real ids come from the bootstrap response. */
const SPONSORS: Record<string, { id: number; name: string }> = {
  cos:      { id: 101, name: 'COS' },
  stylein:  { id: 102, name: 'STYLEIN' },
  nelly:    { id: 103, name: 'NELLY.COM' },
  villoid:  { id: 104, name: 'VILLOID' },
  bikbok:   { id: 105, name: 'BIK BOK' },
  adidas:   { id: 106, name: 'ADIDAS' },
  nike:     { id: 107, name: 'NIKE' },
  zalando:  { id: 108, name: 'ZALANDO' },
}

/** Mock products — fashion editorial vibe. Real images come via GraphQL later. */
const PRODUCTS: Array<DemoProduct & { sponsorSlug: keyof typeof SPONSORS }> = [
  { id: 1001, brand: 'COS',         name: 'Cropped Cardigan Butter Yellow', unitPrice: 990,  retailer: 'COS',       imageUrl: 'https://picsum.photos/seed/cos-cardigan-yellow/600/600',     sponsorSlug: 'cos' },
  { id: 1002, brand: 'STYLEIN',     name: 'Tove Jacket – Oyster',           unitPrice: 5500, retailer: 'STYLEIN',   imageUrl: 'https://picsum.photos/seed/stylein-tove-jacket/600/600',     sponsorSlug: 'stylein' },
  { id: 1003, brand: 'NEW BALANCE', name: 'New Balance 530',                unitPrice: 1500, retailer: 'NELLY.COM', imageUrl: 'https://picsum.photos/seed/nb-530-sneaker/600/600',          sponsorSlug: 'nelly' },
  { id: 1004, brand: 'HOLZWEILER',  name: 'Elena Polo Lt Yellow Stripe',    unitPrice: 1899, retailer: 'VILLOID',   imageUrl: 'https://picsum.photos/seed/holzweiler-elena-polo/600/600',   sponsorSlug: 'villoid' },
  { id: 1005, brand: 'BIK BOK',     name: 'Daydream Tubetop Bikini',        unitPrice: 199,  retailer: 'BIK BOK',   imageUrl: 'https://picsum.photos/seed/bikbok-daydream-bikini/600/600',  sponsorSlug: 'bikbok' },
  { id: 1006, brand: 'ADIDAS',      name: 'Samba OG Black/White',           unitPrice: 1199, retailer: 'ADIDAS',    imageUrl: 'https://picsum.photos/seed/adidas-samba-og/600/600',         sponsorSlug: 'adidas' },
  { id: 1007, brand: 'NIKE',        name: 'Air Force 1 ’07',                unitPrice: 1299, retailer: 'NIKE',      imageUrl: 'https://picsum.photos/seed/nike-airforce-one/600/600',       sponsorSlug: 'nike' },
  { id: 1008, brand: 'ASICS',       name: 'Gel-1130 Cream',                 unitPrice: 1399, retailer: 'ZALANDO',   imageUrl: 'https://picsum.photos/seed/asics-gel-1130/600/600',          sponsorSlug: 'zalando' },
]

// Helper for the carousel-card retailer display.
const NOK = (n: number) => `${n.toLocaleString('no-NO').replace(/,/g, ' ')} kr`

// Build product cards into the carousel slot.
const carousel = document.getElementById('carousel')!
for (const p of PRODUCTS) {
  const el = document.createElement('vio-product')
  el.setAttribute('brand', p.brand)
  el.setAttribute('name', p.name)
  el.setAttribute('price', NOK(p.unitPrice))
  el.setAttribute('retailer', p.retailer)
  el.setAttribute('image-url', p.imageUrl)
  el.setAttribute('product-id', String(p.id))
  el.setAttribute('sponsor-id', String(SPONSORS[p.sponsorSlug]!.id))
  carousel.appendChild(el)
}

// Wire cart trigger to open the drawer.
const cart = document.getElementById('cart') as VioCart
const checkout = document.getElementById('checkout') as VioCheckout
const trigger = document.getElementById('open-cart')!
const countEl = document.getElementById('cart-count')!

trigger.addEventListener('click', () => cart.show())

// Mirror the badge count from the CartManager itself.
function syncBadge(): void {
  countEl.textContent = String(Vio.cart.itemCount)
}
Vio.cart.addEventListener('change', (e: Event) => {
  const detail = (e as CustomEvent<CartChangeDetail>).detail
  countEl.textContent = String(detail.itemCount)
})
syncBadge()

// Cart drawer → "Til kassen" → open checkout for that sponsor.
cart.addEventListener('vio:checkout-open', (e: Event) => {
  const ev = e as CustomEvent<{ sponsorId: number }>
  cart.close()
  try {
    Vio.checkout.open(ev.detail.sponsorId)
  } catch (err) {
    console.warn('[demo] checkout.open failed:', err)
    return
  }
  // Small delay so the cart slide-out completes before the checkout slide-in.
  setTimeout(() => checkout.show(), 200)
})

// Product card click → add to Vio.cart for demo.
document.addEventListener('vio:product-click', (e: Event) => {
  const ev = e as CustomEvent<{ productId: string; sponsorId: string }>
  const productIdNum = parseInt(ev.detail.productId, 10)
  const product = PRODUCTS.find((p) => p.id === productIdNum)
  if (!product) return
  const sponsor = SPONSORS[product.sponsorSlug]!
  Vio.cart.addManual({
    productId: product.id,
    sponsorId: sponsor.id,
    sponsorName: sponsor.name,
    brand: product.brand,
    name: product.name,
    unitPrice: product.unitPrice,
    currency: 'NOK',
    imageUrl: product.imageUrl,
    quantity: 1,
  })
  cart.show()
})

// Payment selection logging (real flow lands when Stripe / Klarna / Vipps wire up).
Vio.checkout.addEventListener('payment-select', (e: Event) => {
  const ev = e as CustomEvent<{ method: string; state: { sponsorId: number; subtotal: number; currency: string } }>
  console.log('[demo] payment-select', ev.detail)
  alert(
    `Payment method: ${ev.detail.method}\n` +
      `Sponsor: ${ev.detail.state.sponsorId}\n` +
      `Total: ${NOK(ev.detail.state.subtotal)}\n\n` +
      `(Real flow will hook Stripe Payment Request / Klarna / Vipps in next iteration.)`,
  )
})
