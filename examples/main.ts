/**
 * QA en local — el SDK de esta rama contra QA, configurado por la URL.
 *
 *   npm run dev   →   http://127.0.0.1:5173/?env=testing&campaignId=18&discountCode=qa_gave&discountField=true
 *
 * Parámetros (todos opcionales salvo la key):
 *   apiKey         la key PÚBLICA de la surface (X-Api-Key), nunca la de gestión.
 *                  Sin ella: VITE_VIO_API_KEY de `.env.local`.
 *   env            testing (por defecto, QA) | production | development
 *   campaignId     la campaña del artículo: la página es de esa campaña y se pintan
 *                  los productos del canal de su marca (los que tienen stock, hasta 12)
 *   discountCode   el código de la campaña, aplicado solo (`Vio.init({ discountCode })`)
 *   discountField  true | false — enseñar / ocultar el campo «Rabattkode»
 *                  (sin él: lo que haga el SDK, que lo enseña cuando hay código)
 *   productIds     1,2,3 — estos productos en vez de los del canal
 *   vio_discount   el código por la URL, como en cualquier página (`discountCode` gana)
 *
 * Los tres caminos de Vipps:
 *   1. Ficha con carrito vacío: «Tøm handlekurven», abrir un producto, «Kjøp nå med Vipps».
 *   2. Carrito, Vipps Express: añadir un producto, «Handlekurv», el botón de Vipps.
 *   3. Checkout, Vipps estándar: en el carrito «Til kassen» → Vipps → el formulario →
 *      «Betal … med Vipps».
 *
 * Ojo:
 *   - La vuelta de Vipps: el SDK hace https la URL de retorno
 *     (https://127.0.0.1:5173/…), que el servidor de desarrollo no sirve. Para probar
 *     Vipps de verdad (y desde el móvil), sirve la página por un túnel https:
 *       cloudflared tunnel --url http://127.0.0.1:5173
 *     y abre la URL https://….trycloudflare.com que imprime, con los mismos parámetros.
 *     Sin túnel: cambia https por http en la barra al volver.
 *   - CORS: si QA rechaza 127.0.0.1, pon en `.env.local`
 *     VITE_VIO_API_BASE=/proxy-vio y VITE_VIO_GRAPHQL_BASE=/proxy-graphql
 *     (vite.config.ts los manda a QA). Se ignoran con env=production.
 */

import { Vio } from '../src/index'
import '../src/ui/index' // registra los <vio-*>
import type { VioCart } from '../src/ui/components/vio-cart'
import type { VioCheckout } from '../src/ui/components/vio-checkout'
import type { PaymentMethod } from '../src/core/checkout/types'
import { describeQaConfig, readQaConfig } from './qa-config'

const env = import.meta.env as Record<string, string | undefined>
const qa = readQaConfig(location.search, {
  VITE_VIO_API_KEY: env.VITE_VIO_API_KEY,
  VITE_VIO_API_BASE: env.VITE_VIO_API_BASE,
  VITE_VIO_GRAPHQL_BASE: env.VITE_VIO_GRAPHQL_BASE,
  VITE_VIO_STRIPE_PK: env.VITE_VIO_STRIPE_PK,
})
const { campaignId, productIds } = qa

/** Cuántos productos del canal se pintan. */
const MAX_PRODUCTS = 12

const statusEl = document.getElementById('qa-status')!
const hintEl = document.getElementById('qa-hint')!
const productsEl = document.getElementById('qa-products')!
const say = (el: HTMLElement, text: string) => {
  el.textContent = text
  el.hidden = !text
}

if (!qa.init) {
  say(hintEl, 'Falta la key: ?apiKey=<key pública de la surface>, o VITE_VIO_API_KEY en .env.local.')
} else {
  Vio.init(qa.init)
  say(statusEl, describeQaConfig(qa))
  wireCartAndCheckout()
  void paintProducts()
}

/** Los productos a pintar: los de `productIds`, o los del canal de la marca de la campaña. */
async function paintProducts(): Promise<void> {
  try {
    await Vio.bootstrap()
  } catch (err) {
    say(hintEl, `El bootstrap falló (¿key o env equivocados?): ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const campaign = Vio.campaignForSlot(null, campaignId ? { campaignId } : undefined)
  if (campaignId && campaign?.id !== campaignId) {
    say(hintEl, `La campaña ${campaignId} no está en el bootstrap de esta key (¿key de otra surface, o campaña no activa?).`)
    return
  }
  const sponsorId = campaign?.primarySponsor?.id
  let ids = productIds
  if (ids.length === 0 && sponsorId) {
    try {
      ids = await channelProducts(sponsorId)
    } catch (err) {
      say(hintEl, `No se pudieron listar los productos del canal: ${err instanceof Error ? err.message : String(err)}. Pasa ?productIds=…`)
      return
    }
  }
  if (ids.length === 0) {
    say(hintEl, 'No hay productos que pintar: pasa ?campaignId=… (con productos en stock en su canal) o ?productIds=1,2,3')
    return
  }
  const carousel = document.createElement('vio-product-carousel')
  carousel.setAttribute('heading', campaign?.name ? `Shop · ${campaign.name}` : 'Shop')
  carousel.setAttribute('product-ids', ids.join(','))
  if (sponsorId) carousel.setAttribute('sponsor-id', String(sponsorId))
  if (campaignId) carousel.setAttribute('vio-campaign', String(campaignId))
  productsEl.replaceChildren(carousel)
}

/**
 * Los productos con stock del canal de la marca (una campaña = un canal), con la
 * key del canal: `Channel.GetProducts`, por la vía de escape del cliente del SDK.
 */
async function channelProducts(sponsorId: number): Promise<number[]> {
  const client = Vio.commerceFor(sponsorId, campaignId ? { campaignId } : undefined)
  const data = await client.raw.request<{ Channel: { GetProducts: Array<{ id: number; quantity: number | null }> } }>(
    /* GraphQL */ `
      query QaChannelProducts {
        Channel {
          GetProducts(useCache: true) {
            id
            quantity
          }
        }
      }
    `,
  )
  return (data?.Channel?.GetProducts ?? [])
    .filter((p) => (p.quantity ?? 0) > 0)
    .map((p) => p.id)
    .slice(0, MAX_PRODUCTS)
}

/** El carrito, el checkout y lo que los abre: lo que haría un host. */
function wireCartAndCheckout(): void {
  const cart = document.getElementById('cart') as VioCart
  const checkout = document.getElementById('checkout') as VioCheckout
  const countEl = document.getElementById('cart-count')!

  document.getElementById('open-cart')!.addEventListener('click', () => cart.show())
  document.getElementById('clear-cart')!.addEventListener('click', () => Vio.cart.clearAllCarts())

  const syncBadge = () => {
    countEl.textContent = String(Vio.cart.itemCount)
  }
  Vio.cart.addEventListener('change', syncBadge)
  syncBadge()

  // El carrito («Til kassen», Vipps sin Express) y la ficha piden el checkout con este evento.
  document.addEventListener('vio:checkout-open', (e: Event) => {
    const detail = (e as CustomEvent<{ sponsorId: number; paymentMethod?: string; express?: boolean }>).detail
    cart.close()
    try {
      Vio.checkout.open(detail.sponsorId)
      if (detail.paymentMethod) Vio.checkout.selectPaymentMethod(detail.paymentMethod as PaymentMethod)
    } catch (err) {
      console.warn('[qa] checkout.open falló:', err)
      return
    }
    checkout.express = detail.express === true
    // Que el carrito termine de salir antes de que entre el checkout.
    setTimeout(() => checkout.show(), 200)
  })

  // Para seguir el flujo en la consola.
  for (const name of ['vio:payment-redirect-start', 'vio:payment-redirect-error', 'vio:payment-redirect-cancel', 'vio:payment-success']) {
    document.addEventListener(name, (e) => console.info(`[qa] ${name}`, (e as CustomEvent).detail))
  }
}
