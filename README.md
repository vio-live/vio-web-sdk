# @vio-live/web-sdk

In-site shoppable + native checkout for editorial commerce sites. Web SDK companion to Vio's iOS, Android (Kotlin) and Apple TV SDKs.

Lit **web components** (`<vio-*>`) on top of a headless **core** (cart, checkout, Apple Pay, Klarna, Vio Commerce). Published on npm — **public**, MIT.

## Why this exists

Editorial publishers typically integrate commerce via **affiliate click-out** — the reader leaves the site to buy on a third-party retailer, which adds friction and breaks attribution outside the cookie model. Vio replaces click-out with **in-site native checkout**: the reader stays in the article, taps a product card, and pays via Apple Pay / Klarna — while the publisher still gets paid through the standard `click_id` + postback model.

## Install

```bash
npm install @vio-live/web-sdk
# The React wrappers also need React 18+ (optional peer dependency):
npm install react react-dom
```

## Quick start — web components

```ts
import { Vio } from '@vio-live/web-sdk'
import '@vio-live/web-sdk/ui'   // registers <vio-product-carousel>, <vio-cart>, …

Vio.init({
  apiKey: import.meta.env.VITE_VIO_API_KEY,
  // apiBase, graphqlBase, stripePublishableKey — optional overrides
})
```

```html
<vio-product-carousel
  label="Ukens funn"
  heading="Våre favoritter"
  disclaimer="annonselenker"
  product-refs="1:408909,1:408910,1:408911"
  currency="NOK"
></vio-product-carousel>

<!-- Add once near the root for the slide-in cart + express checkout -->
<vio-cart></vio-cart>
```

`product-refs` is a comma-separated list of `sponsorId:productId` pairs; the carousel fetches them from Vio Commerce and renders the cards.

## React

Typed wrappers (built on `@lit/react`). Importing this entry **registers the elements** — no separate `/ui` import needed.

```tsx
import { Vio } from '@vio-live/web-sdk'
import { VioProductCarousel, VioCart } from '@vio-live/web-sdk/react'

Vio.init({ apiKey: '…' })

function Shop() {
  return (
    <>
      <VioProductCarousel
        label="Ukens funn"
        heading="Våre favoritter"
        productRefs="1:408909,1:408910"
        onProductAdd={(e) => console.log('added', e.detail)}
      />
      <VioCart onPaymentSuccess={(e) => console.log('paid', e.detail)} />
    </>
  )
}
```

Wrappers: `VioProduct`, `VioProductCarousel`, `VioProductDetail`, `VioCart`, `VioCheckout`.

## Headless / SSR

The root and `/core` entries export the framework-agnostic core with **no DOM side-effects** — SSR-safe and **tree-shakeable** (importing one helper pulls only that helper, ~0.5 kB):

```ts
import { Vio, formatPrice, type Product } from '@vio-live/web-sdk/core'
```

## Entry points

| Import | What you get | Registers `<vio-*>` |
|---|---|---|
| `@vio-live/web-sdk` | headless core (`Vio`, managers, types) — tree-shakeable | no |
| `@vio-live/web-sdk/core` | same as above, explicit | no |
| `@vio-live/web-sdk/ui` | registers the web components (+ injects design tokens) | yes |
| `@vio-live/web-sdk/react` | typed React wrappers | yes |

> **Registration is explicit.** The root/`core` entries are headless so they tree-shake cleanly. Render the components by importing `/ui` (side-effect) or `/react`. `registerVioElements()` is also exported from `/ui` if you'd rather register manually.

## License

MIT © Vio
