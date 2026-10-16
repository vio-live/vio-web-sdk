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
  environment: 'production', // 'development' | 'testing' | 'production'
})
```

`environment` is the recommended way to configure — it resolves the right
`apiBase`/`graphQLBase` for you (each environment has known-good defaults
baked in). Note the middle value is **`'testing'`, not `'staging'`**
(naming kept in parity with the iOS SDK).

Only pass `apiBase`/`graphQLBase`/`stripePublishableKey` directly if you need
to override those specific values — e.g. a self-hosted proxy, or a Stripe key
that differs from the environment default:

```ts
Vio.init({
  apiKey: '…',
  environment: 'production',
  apiBase: 'https://my-proxy.example.com',       // optional, overrides the environment default
  graphQLBase: 'https://my-graphql.example.com', // optional — note the casing: graphQLBase
  stripePublishableKey: 'pk_live_…',             // optional — needed for the Apple Pay button
})
```

**Apple Pay note**: the button only renders when `canMakePayment()` says the
device+browser can pay AND your domain is verified for Apple Pay in Stripe's
dashboard (Settings → Payment method domains) — Stripe serves a verification
file at `/.well-known/apple-developer-merchantid-domain-association` on that
domain. Not all hosts let you serve that file (some page builders can't) —
if the button never appears, check domain verification before assuming it's
a code bug.

**Stripe note**: the channel decides which Stripe the checkout shows. With
*Payment Intent* enabled it is **native** — Stripe's Payment Element renders
inside `<vio-checkout>` and the shopper pays without leaving the page (card
data goes straight to Stripe, in its own iframes). With only *Payment Link*
enabled the shopper is redirected to a page hosted by Stripe and comes back
to your URL. Either way the order is created server-side from Stripe's
webhook, so the receipt appears once the checkout is confirmed — never on
the browser's word alone.

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

Vio.init({ apiKey: '…', environment: 'production' })

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

Hosts with their own quantity stepper: change a line with
`Vio.cart.adjustQuantity(lineItemId, sponsorId, ±1)`, not
`updateQuantity(…, item.quantity ± 1)` — the delta is applied to the manager's
live quantity, so quick taps before a re-render never ask for the same target
twice, and the backend sees one request in flight per line.

## Slots — where things happen on a page

A **slot** is a named place on a page (ADR-0027). Each page declares its slots to
Vio, the dashboard assigns a campaign to each one (optionally with a date window),
and whatever no slot names shows the surface's **default campaign** — so several
campaigns can run on one page at the same time. **Nobody has to name anything:
every Vio element registers itself.** This is the standard the web SDK, the Vev
blocks and the Replit site all follow.

Tell the SDK which platform the page is (it travels with every declaration and with
the bootstrap, so only this platform's assignments come back):

```ts
Vio.init({ apiKey: '…', environment: 'production', platform: 'web' }) // 'web' | 'custom-web' | 'vev' — default 'web'
```

### Identity of an element

In order:

1. **`vio-slot`** — your own id, when you want to name the place or make several
   elements share one slot (the cards a carousel renders already carry the
   carousel's id). `vio-slot-name` is its optional human label for the dashboard.
2. Otherwise an **auto id**: `${scope}-${kind}-${ordinal + 1}` — `carousel-1`,
   `card-3`, `detail-1`, `article-123-carousel-1` — counted among the same kind of
   element **with the same scope**: on a fresh load elements connect in document
   order, so the number is the document position; in a dynamic DOM a later element
   takes the first free number and a removed element's number is reused — two live
   elements never share an id. Its label is `Carousel 1` (` · Title` when the
   scope has a label). Every id is capped at 100 characters (a long scope is cut,
   the kind and number are kept), and the capped id is what gets declared,
   exposed and sent.

The attribute is **`vio-slot`** (property `vioSlot`, React prop `vioSlot`) — **not
`slot`**, which is HTML's own attribute for shadow DOM slotting and stays untouched.
The id in effect is readable as `element.effectiveSlot`.

```html
<vio-product-carousel product-ids="408909,408910"></vio-product-carousel>   <!-- carousel-1 -->
<vio-product-carousel vio-slot="hero" vio-slot-name="Hero banner" product-ids="…"></vio-product-carousel>
<vio-product vio-slot="hero" product-id="408911" sponsor-id="1"></vio-product>  <!-- shares `hero` -->
```

```tsx
<VioProductCarousel vioSlot="hero" vioSlotName="Hero banner" productIds="408909,408910" />
```

### Scope — per-page slots with one line

There is **no page URL in an auto id** on purpose: one Vev design or one article
template serves thousands of articles and they are all the same *place*. When a
page wants slots of its own, it sets a **scope** once and every element inherits
it:

```html
<body data-vio-scope="article-123" data-vio-scope-name="Why the lamp matters">
  <vio-product-carousel product-ids="…"></vio-product-carousel>  <!-- article-123-carousel-1 · "Carousel 1 · Why the lamp matters" -->
```

An element's scope is its own `vio-scope` attribute, else the nearest ancestor's
`data-vio-scope` (through shadow roots), else none; the label the same way with
`vio-scope-name` / `data-vio-scope-name`. Ordinals restart per scope. A Vev page
sets the page as scope; a Replit article page sets `data-vio-scope` on `<body>`; a
template that wants slots shared across articles simply sets no scope.

### Declaration

Every mounted element registers its id (and label); after the first successful
`Vio.bootstrap()` the SDK sends **one** manifest for the whole page
(`POST /v2/mobile/components/manifest`, `mode: 'merge'`, so one page never
deprecates another page's slots) and again whenever a new id or label appears.
The browser remembers **each id (under its label) for 24 h** in `localStorage`
(under the platform and a hash of the key — never the key itself), so a
multi-page site posts only the ids a page adds, a revisit posts nothing, a
renamed block posts again; without storage it simply posts each load. A failed
attempt (or a server that ignored `merge`) is not retried for 1 h; a declaration
sends at most 100 locations and a page load at most 3 manifests (each cap warns
once). Best-effort, never throws. By hand, e.g. from an editor (`force` re-sends
everything and ignores the per-load cap):

```ts
await Vio.declareSlots(['hero', { id: 'sidebar', displayName: 'Sidebar' }], { force: true })
// → ManifestResult | null (null = skipped as already declared, or failed — see the console)
```

### Which campaign a slot shows

Among the active campaigns of the bootstrap, the one whose assignment names the
slot (for this platform, or for all) and whose window is open right now; if
several, the default campaign, else the first listed. No assignment → the default
campaign. `Vio.campaignForSlot('hero')` answers from the last bootstrap (`null`
before it); the pure `resolveSlotCampaign(boot, slot, now?, platform?)` is exported
from `/core`. A carousel or card **without a `sponsor-id`** uses the primary sponsor
of its slot's campaign (the default campaign's when the slot has none), and the
detail opened by such a card does the same — before 0.23 a sponsorless card did
nothing. An explicit `sponsor-id` still wins.

### Page campaign — an editorial page that belongs to one campaign

Native-SDK style placements stay the primary model: the **dashboard assigns**
a campaign to a slot. But an editorial page — a Vev article, a Replit article —
often *is* part of one campaign, and the page can say so:

```ts
Vio.init({ apiKey: '…', campaignId: 12 })          // the whole page
```

```html
<body data-vio-campaign="12">                        <!-- inheritable, like the scope -->
<vio-product-carousel vio-campaign="10" …>          <!-- one element of another campaign -->
```

Precedence per element: `vio-campaign` on the element → the nearest ancestor's
`data-vio-campaign` → `Vio.init({ campaignId })`. What it does:

- **Declaration.** The manifest carries the page's campaign (top-level) and an
  element's own campaign per location when it differs. The campaigns service
  turns that into assignments of the page's slots (`source: 'page'`) — **unless
  the dashboard already assigned the slot: the dashboard wins**, and the SDK warns
  once per such slot. A page that changes campaign declares again.
- **Resolution, immediately.** `Vio.campaignForSlot()` / `Vio.attribution()` (and
  so the elements, the cart origins and the events) resolve as: the slot's
  assignment → the page's campaign, when the bootstrap lists it as active → the
  default. An editor sees the effect in the Vev editor before the manifest
  round-trips; a paused or unknown page campaign is simply ignored.
- `Vio.pageCampaign()` returns the init-level campaign as the bootstrap lists it
  (active), else `null`.

## Attribution — the slot, the campaign, the article

`Vio.attribution(slot?)` is **the** attribution helper — the SDK elements use it,
and so do the Vev blocks and the Replit site:

```ts
Vio.attribution('hero')
// → { slot: 'hero', campaignId: 12, sponsorId: 7, contentId: 'article-42', contentTitle: 'Why the lamp matters' }
```

`campaignId`/`sponsorId` are the slot's campaign and its primary sponsor (`{}` before
the bootstrap); `contentId`/`contentTitle` are the **content** (the article) the page
is. The place is the slot, the article is the content — both automatic.

**Article (content) attribution.** `Vio.content()` resolves it **live** (a few
`querySelector`s, so an SPA route change or a new title is seen on the next event)
and every analytics event carries it as `content_id` / `content_title`: id from
`Vio.init({ contentId })` → `?vio_content=` (honored by design — a page may be
told which article it is) → `<meta name="vio:content-id">` →
`<link rel="canonical">` / `og:url` (without query and hash) → `location.pathname`;
title from `Vio.init({ contentTitle })` → `?vio_content_title=` →
`<meta name="vio:content-title">` → `og:title` → `document.title`. The collector
rejects a whole event over an id of 128 chars or a title of 255, so a candidate id
that does not fit is skipped for the next one (and omitted when none fits) and
titles are cut — in one place, before anything is sent. Per element,
`vio-content-id` / `vio-content-title` override it (a teaser for another article).

**What analytics gets.** Every event an element emits (`vio:product-click`,
`vio:product-add`, `vio:added-to-cart`, `vio:checkout-open`, …) and every event it
tracks carries `slot` (the effective id), `location_id` (= the slot), `content_id`
and `content_title`. `campaign_id` resolves as explicit `campaignId` (the element's
own attribution travels in its event detail and is honored as such) → the slot's
assigned campaign → the sponsor's campaign → the default. Two things changed from
0.22 for carousels: a carousel's impressions and `view_item_list` report
`location_id` as its slot id (`carousel-1`, or the `vio-slot`) instead of its
`label`, and every event now carries `content_id` / `content_title` — including
the single-campaign `begin_checkout` / `purchase`.

### Cart origins and the purchase per campaign

The cart remembers **where every unit came from**. The add paths take an optional
`origin` (`{ campaignId?, slot?, contentId? }` — what `Vio.attribution(slot)`
answers), and so does `adjustQuantity(lineItemId, sponsorId, delta, { origin })`:

```ts
Vio.cart.addProduct({ product, sponsorId: 1, origin: Vio.attribution('hero') })
// a host adding from the card's event:
onProductAdd={(e) => Vio.cart.addProduct({ product, sponsorId, origin: e.detail.origin })}
```

Each line keeps `origins: Array<{ campaignId?, slot?, contentId?, quantity }>`: an
add with an origin increments that origin, without one the most recent (the
`<vio-cart>` +/− buttons pass none), and −1/remove comes off the most recent first.
They persist with the cart; carts from before origins read as one empty origin.

At checkout and purchase the cart is **split per campaign**: `begin_checkout` and
`purchase` go out **once per campaign in the cart**, each with that campaign's
items (quantities from the origins; units without one fall into the campaign the
current rule resolves), its own `value` (two decimals), the same `order_id`, the
slice's `slot` / `content_id` only when they are unique in it, and
`props: { slice, slices }` so the collector can count the order once. A cart with a
single campaign is one event, as before; when its origins name the campaign, the
event names it too (plus the unique slot / content). A cart without origins
(0.22) reports exactly as it did.

The split is public, so a host with its own analytics sink (Vev) applies the same
rule instead of its own:

```ts
Vio.cartSlices()            // over the live cart; Vio.cartSlices(sponsorId) for one sponsor
Vio.cartSlices(undefined, { items }) // pure, over a snapshot of lines
// → CartSlice[]: { campaignId?, sponsorId?, slot?, contentId?, items: VioItem[], value, currency?, slice, slices }
```

## Theming

Every component reads its colors and fonts from `--vio-*` CSS custom properties
(shadow DOM inherits these from the light DOM, so this reaches every component,
including the Apple Pay/Klarna/Vipps panels). `applyVioTheme` is the one
supported way to override them — don't set `--vio-*` properties by hand, and
don't rely on the internal variable names staying stable across versions:

```ts
import { applyVioTheme } from '@vio-live/web-sdk/ui' // or '/react'

applyVioTheme({
  colorAccent: '#0044ff',
  colorText: '#111111',
  fontSerif: '"Playfair Display", Georgia, serif',
  fontSans: '"Inter", sans-serif',
})
```

A curated set on purpose — colors + fonts, not the full internal token list
(spacing/radius/sizes stay implementation detail). Call it again any time
(e.g. after a user picks a different brand color in a settings UI) — pass
`null`/`undefined` for a key to revert it to the SDK default instead of
leaving a stale override behind:

```ts
applyVioTheme({ colorAccent: null }) // back to the default #c14a3b
```

By default it sets the override on `document.documentElement` (`:root`, the
whole page). Pass a second argument to scope it to one element instead —
useful if you show multiple differently-branded sponsors on the same page:

```ts
applyVioTheme({ colorAccent: '#ff6600' }, document.getElementById('sponsor-2'))
```

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
