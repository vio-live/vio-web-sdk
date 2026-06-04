# Vio Web SDK

In-site shoppable + native checkout for editorial commerce sites. Web SDK companion to Vio's iOS, Android (Kotlin) and Apple TV SDKs.

**Status**: scaffolding, under active development. Not yet published to npm.

## Why this exists

Editorial publishers (magazines, fashion/lifestyle hubs, news sites) typically integrate commerce via **affiliate click-out** — the reader leaves the site to buy on a third-party retailer. That introduces friction and breaks attribution outside the cookie model.

Vio replaces click-out with **in-site native checkout**: the reader stays in the article, taps a product card, completes the purchase via Apple Pay / Klarna / Vipps, and the affiliate publisher still gets paid through the standard `click_id` + postback model (Adtraction-compatible by default).

## Quick start (planned API — components in progress)

```ts
import { Vio } from 'vio'
import 'vio/ui'  // registers <vio-product-carousel>, <vio-product>, etc.

Vio.init({ apiKey: import.meta.env.VITE_VIO_API_KEY })
```

```html
<!-- Drop-in carousel that matches the editorial style of the host site -->
<vio-product-carousel
  campaign-id="36"
  location="news-favorites"
  label="REDAKSJONENS FAVORITTER"
  heading="Shop Favorittene"
  disclaimer="annonselenker"
></vio-product-carousel>
```

React opt-in:

```tsx
import { VioProvider, useCart } from 'vio/react'
```

## Architecture

```
src/
├── core/         config, Vio + Commerce GraphQL clients, cart, checkout, adtraction
├── ui/           Web Components + design tokens
└── react/        Optional React hooks + components
```

Single npm package, single install, single version. Sub-folders are organisational only; the `exports` map allows partial imports for tree-shaking.

## Repo

Lives in `vio-live/...` (TBD — currently developed locally, not yet pushed).
