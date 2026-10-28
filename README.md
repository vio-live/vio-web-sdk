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

Every mounted element registers its id, its label and its **kind** (`card` |
`carousel` | `detail` — each manifest location is `{ id, displayName, kind }`; the
campaigns micro stores the kind from 2026-10 on and ignored the key before); after
the first successful `Vio.bootstrap()` the SDK sends **one** manifest for the whole
page (`POST /v2/mobile/components/manifest`, `mode: 'merge'`, so one page never
deprecates another page's slots) and again whenever a new id, label or kind appears.
The browser remembers **each id — under its label and the campaign it was
declared with — for 24 h** in `localStorage` (under the platform and a hash of
the key — never the key itself; one state per id), so a multi-page site posts
only the ids a page adds, a revisit posts nothing, a renamed block or a page that
changed campaign posts again; without storage it simply posts each load. A failed
attempt (or a server that ignored `merge`) is not retried for 1 h; a declaration
sends at most 100 locations and a page load at most 3 manifests (each cap warns
once). Best-effort, never throws. By hand, e.g. from an editor (`force` re-sends
everything and ignores the per-load cap):

```ts
await Vio.declareSlots(['hero', { id: 'sidebar', displayName: 'Sidebar', kind: 'carousel' }], { force: true })
// → ManifestResult | null (null = skipped as already declared, or failed — see the console)

// What an element does on mount (a host block can too). `(id, name, campaignId)` still works.
const release = Vio.registerSlot('sidebar', 'Sidebar', { kind: 'carousel', campaignId: 12 })
```

The first kind an id gets stays — the cards a carousel renders share the carousel's
id, and the slot is the carousel's.

### Which campaign a slot shows

Among the active campaigns of the bootstrap, the one whose assignment names the
slot (for this platform, or for all) and whose window is open right now; if
several, the default campaign, else the first listed. No assignment → the page's
campaign (see *Page campaign*) when the bootstrap lists it as active → the default
campaign. `Vio.campaignForSlot('hero')` answers from the last bootstrap (`null`
before it); the pure `resolveSlotCampaign(boot, slot, now?, platform?, pageCampaignId?)`
is exported from `/core`. A carousel or card **without a `sponsor-id`** uses the primary sponsor
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
`data-vio-campaign` → `Vio.init({ campaignId })`; an unusable level (not a positive
integer, paused, unknown) falls through to the next. The attributes are read when
the element mounts or its own attribute changes — there is no observer on the
ancestors. On web/Replit a **per-article** campaign needs a per-article scope too
(`data-vio-scope`, see above): without it the auto ids of every article are the
same `carousel-1`, and the articles' campaigns would overwrite one another's
assignment; Vev ids are per block, so it does not apply there. What it does:

- **Declaration.** The manifest carries the page's campaign (top-level) and an
  element's own campaign per location when it differs. The campaigns service
  (campaigns micro PR #16) turns that into assignments of the page's slots
  (`source: 'page'`) — **unless the dashboard already assigned the slot: the
  dashboard wins**, and the SDK warns once per such slot (and once when this page
  moved a slot from an earlier page assignment). A page that changes campaign
  declares again; a campaign the micro did not take up is retried after an hour.
- **Resolution, immediately.** `Vio.campaignForSlot()` / `Vio.attribution()` (and
  so the elements, the cart origins and the events) resolve as: the slot's
  assignment (a dashboard one always; a page-sourced one unless the page now
  declares a different active campaign or the known sponsor takes no part in it)
  → the page's campaign, when the bootstrap lists it as active and — with a known
  sponsor — that sponsor takes part in it → the sponsor's campaign → the default. An editor sees the effect in the Vev
  editor before the manifest round-trips.
- `Vio.pageCampaign()` returns the init-level campaign as the bootstrap lists it
  (active), else `null`.
- With a **known sponsor** (a card with `sponsor-id`), the page's campaign — and a
  slot assignment the page made itself (`source: 'page'`) — count only when that
  sponsor takes part in the campaign; otherwise the sponsor's own campaign applies.
  A dashboard assignment counts unconditionally.
- `Vio.init({ debug: true })` logs the micro's `assignment` per slot at
  `console.debug`. It is independent of `Vio.analytics.start({ debug })`, which
  logs the analytics events.

## Attribution — the slot, the campaign, the article

`Vio.attribution(slot?)` is **the** attribution helper — the SDK elements use it,
and so do the Vev blocks and the Replit site:

```ts
Vio.attribution('hero')
// → { slot: 'hero', campaignId: 12, sponsorId: 7, contentId: 'article-42', contentTitle: 'Why the lamp matters', contentUrl: 'https://host.example/article-42' } // contentUrl: origin + path
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
assigned campaign → the page's campaign (when the sponsor takes part in it) → the
sponsor's campaign → the default. Two things changed from
0.22 for carousels: a carousel's impressions and `view_item_list` report
`location_id` as its slot id (`carousel-1`, or the `vio-slot`) instead of its
`label`, and every event now carries `content_id` / `content_title` — including
the single-campaign `begin_checkout` / `purchase`. Since 0.25 every element also
says **what it is**: `component_template_id` is `product-card` for a card,
`product-carousel` for a carousel — and for the cards it renders, so a carousel's
impressions and its clicks count under one component type — and `product-detail`
for the detail (its `view_item`, `add_to_cart` and `begin_checkout`). A host that
lays cards out itself can set `component-template-id` on them (`product-grid`).

### Cart origins and the purchase per campaign

The cart remembers **where every unit came from**. The add paths take an optional
`origin` (`{ campaignId?, slot?, contentId?, componentKind?, contentUrl?, contentTitle? }`
— what `Vio.attribution(slot)` answers, plus the kind of element; the elements pass
their `componentTemplateId` as it), and so does
`adjustQuantity(lineItemId, sponsorId, delta, { origin })`:

```ts
Vio.cart.addProduct({ product, sponsorId: 1, origin: Vio.attribution('hero') })
// a host adding from the card's event:
onProductAdd={(e) => Vio.cart.addProduct({ product, sponsorId, origin: e.detail.origin })}
```

Each line keeps `origins: Array<{ campaignId?, slot?, contentId?, componentKind?,
contentUrl?, contentTitle?, quantity }>`: an add with an origin increments that
origin, without one the most recent (the `<vio-cart>` +/− buttons pass none), and
−1/remove comes off the most recent first. A place is campaign + slot + content +
kind of element (an add from a card and one from the detail of the same slot are two
origins); the page's URL and title are attributes of it. They persist with the cart;
carts from before origins read as one empty origin.

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

### Attribution on the order — what Commerce receives (0.26)

Since 0.26 the origins do not stay in the browser: **Commerce receives them**
(ADR-0035 phase B), so the order is born knowing where it was sold from.

- **Per line.** Every `AddItem` carries the line's `origin` — `{ campaign_id,
  location_id (the slot), component_kind, content_url, content_title }` — and a
  quantity **increase** carries, on `UpdateItem`, the origin of the units it adds (the
  given one, else the line's most recent; a burst of +1 from two places is two
  updates, each with its own origin); a decrease and a removal carry none, and an add
  without an origin sends none (the line inherits the order's campaign on the
  server). `component_kind` is the kind of element as the collector names it too
  (`card` | `carousel` | `detail`: the element's `componentTemplateId` without its
  `product-` / `vev-` prefix, else the kind word in the slot id), so
  `order_item.component_kind` and `breakdown?by=component_kind` agree. shopcart keeps
  every origin of a line with its units and writes `order_item.campaign_id` /
  `location_id` / `component_kind` from them.
- **Per checkout.** `CreateCheckout` and the `UpdateCheckout` right before paying
  carry `attribution`: `surface_key` (the SDK key — the gateway sets it from
  `X-API-Key` anyway, and shopcart checks it against the cart's channel, so a page
  cannot credit a sale to another surface), `campaign_id` (the page's campaign,
  `Vio.pageCampaign()` — else the campaign that explains most units of the cart under
  the same rule `purchase` is split by), `content_url` / `content_title` (the page at
  pay time) and `entry` (`{ referrer, utm_source, utm_medium, utm_campaign,
  landing_url }`: the landing the session **remembers** — the same memory the
  `client` block reads, which now keeps the landing page too — never the page the
  shopper pays on taken for a landing; without a remembered landing there is no
  `entry`). They become `order.surface_id` / `campaign_id` / `content_url` /
  `content_title` / `entry_source`. `Vio.orderAttribution(sponsorId?)` answers what
  would be sent — synchronously: nothing on the way to a payment waits for it.
- **`content_url` is origin + path**, no query string, no fragment — on the order,
  on the lines and in the landing: the query is where a page carries e-mails, tokens
  and tracking tails, and none of that belongs on an order row. A site whose article
  lives in the query or the hash identifies it through `contentId` (`Vio.init({
  contentId })`, `?vio_content=`, the `vio:content-id` meta), not through the URL.
  The analytics events keep `location.href` as before.
- **Privacy.** On a **`minimal`** surface what says *which screen* a unit was sold
  from and *why the shopper was there* stays off Commerce — the same promise the
  collector keeps for the events (vio-analytics `privacy.ts`): no `content_url`, no
  `content_title`, no `location_id` on the lines, no `entry`; `surface_key`,
  `campaign_id` and `component_kind` do travel. The mode comes from
  `Vio.init({ privacyMode: 'minimal' })` when the host knows it (always wins), else
  the bootstrap's `surface.privacyMode`, else the surface itself: `GET
  /v2/mobile/surface`, asked **once at `Vio.init()`** (and again by `bootstrap()` if
  that failed), given 1.5 s, believed for the page load — a failure or a timeout is
  believed for a minute, then asked again; a service that predates the endpoint (404)
  means `standard`; a word the SDK does not know does not. The payment path reads
  what is known at that moment (`Vio.privacyModeNow()`) and never waits; an unknown
  mode counts as `minimal`. The cart's lines wait for the ask in flight, at most its
  cap (`Vio.privacyMode()`).
- **A gateway that predates these arguments** (`origin` on `LineItemInput` /
  `UpdateItem`, `attribution` on `CreateCheckout` / `UpdateCheckout`) refuses the
  operation at validation, before anything runs: the SDK sends it again without them,
  once per page load, says so in the console, and the cart works as in 0.25. Nothing
  that ran — data in the answer, or an error with a `path` — is ever repeated.

Everything is capped to Commerce's columns in one place (`lineOriginWire`,
`checkoutAttributionOf`, exported from `/core`): slot 100, kind 32, URL 2 048, title
255, referrer 2 048, utm 128; `campaign_id` only as a positive 32-bit `Int`.

### The visit and the buyer — `client` and `buyer_id` (0.25)

Every event carries a **`client`** block, the standard context of the visit:
`language` (`navigator.language`), the **landing page's** `referrer` and
`utm_source` / `utm_medium` / `utm_campaign` / `utm_term` / `utm_content`,
`screen_w` / `screen_h` and `tz` (IANA). The landing is read once and remembered
for the session in `sessionStorage` (`vio.landing.v1`), so the third page of a visit
still says it came from the newsletter — a page's own internal referrer is never
sent. The referrer is kept as origin + path (no query string, no fragment) and
dropped when it is this same host (a self-referral says nothing about the entry). A
URL with utm parameters is a new landing that replaces the memory — unless it was
reached from this same host, i.e. an internal link that propagates utm, which keeps
the landing that was. With `requireConsent` nothing is written until
`setConsent(true)`, and `setConsent(false)` forgets it. Device type, OS, browser and
country are **not** sent: the collector derives them from the request itself. The
block is computed once per page load (capped to the collector's limits) and the
same object rides on every event. `resolveClientContext()` / `resolveLanding()` are
exported from `/core` for hosts with their own pipeline.

A `purchase` carries **`commerce.buyer_id`**: shopcart's `buyer_ref`, the keyed hash
Commerce computes from the buyer's email — one person, one ref across orders and
devices, nothing reversible — so a campaign can count distinct and repeat buyers.
The SDK never sends an email and never hashes one itself: it forwards the reference
the checkout answers (the order-number query, the Apple Pay and the Klarna native
confirmations select `buyer_ref`; a gateway that predates the field is asked again
without it, once per page load) and omits it otherwise. `Vio.checkout.getOrderReference(checkoutId, sponsorId?)`
answers `{ orderNumber, buyerRef }` (never throws; concurrent asks share one
request); `getOrderNumber` is its order-number half. The `vio:payment-success`
detail carries it as `buyerRef`; an emitter that has to ask for it asks at once (and
again at 1.2 s while the checkout has neither order nor reference — a webhook may
still be writing it), waits at most 2.5 s, fires the event at once without it when the
page hides or the element is removed, and never asks when it cannot help (the
gateway has no `buyer_ref` yet; a confirmation that already answered). The
confirmation screen never waits. A host with its own checkout passes `buyerRef` (or
`buyer_ref`) in its `vio:payment-success` / `vio:checkout-open` detail, or
`commerce.buyerId` to `Vio.analytics.track()`; anything that is not a reference
(an email, more than 128 chars, anything outside `[A-Za-z0-9._~-]`) is dropped
(`normalizeBuyerRef` / `buyerRefOf`, exported from `/core`). **Without consent**
(`requireConsent` until `setConsent(true)`) `buyer_id` is not sent at all: a visit
measured with ephemeral ids carries no stable identifier of a person.

### The purchase — `order_id` is Vio's order number, `checkout_id` beside it

A `purchase`'s **`commerce.order_id` is Vio's order number** — `4415`, the number
on the receipt, in the dashboard and in Commerce. Commerce's cancellations and
refunds (`order_cancelled` / `order_refunded`, ADR-0036) name the purchase they
compensate by that number: a purchase that carried the checkout's uuid instead
could never be netted.

- **Where the number comes from.** The `vio:payment-success` detail's
  `orderNumber` (the SDK's checkout adds it when its ask for the buyer reference
  already found the order), Apple Pay's backend confirmation
  (`result.confirmation.orderId`), or an `orderId` that is a whole number (a host
  passing the number; a checkout id is a uuid, never one). A redirect return
  (Vipps, Klarna, hosted Stripe…) or an order a webhook creates usually fires the
  event before the order exists: the SDK then **asks the checkout** —
  `Vio.checkout.getOrderReference(checkoutId)`, the receipt's own path — at once
  and after 0.5 / 1 / 2 / 3 / 3 s, for at most 10 s. Only the event waits: the
  confirmation screen, the cart and the payment flow never do. Apple Pay and the
  embedded Stripe Element (the drawer waits for the webhook's order before it
  confirms) have the number at once.
- **`commerce.checkout_id`** — Vio's checkout id (uuid) — is always there when the
  SDK knows the checkout (every SDK path, Apple Pay from the cart included): the
  second key the collector can match a purchase by. It is new and additive; a
  collector that predates it drops the key (its schema strips unknown fields) and
  keeps the event.
- **`props.order_id_kind`** says what `order_id` is: `'order'` (the number) or
  `'checkout'` — the number did not come within the 10 s, the page was hidden or
  closed while waiting (the event leaves at once, by beacon), or the page has no
  checkout manager to ask; then `order_id` is the checkout id, as before.
- **Once per checkout.** One `purchase` per checkout (or order) per page load: a
  second `vio:payment-success` for the same one adds nothing, and a number that
  arrives after the event left with the checkout id adds no second event. `ts`
  and `event_id` are fixed at the payment, whenever the event leaves; a purchase
  split per campaign waits once and every slice carries the same number.
- **Sent at once.** A `purchase` does not wait for the queue's 5 s tick: it is
  sent as soon as it is built, and when the page hides (`visibilitychange`, the
  last thing a phone is sure to say before it discards a tab) whatever is still
  queued leaves by beacon (0.29.0; order 4128 had been recorded and never sent).
- **A host with its own sink** (Vev) reads the same ids from the detail with
  `purchaseIdsOf(detail)` → `{ orderId, checkoutId, orderIdKind }` (or
  `purchaseFromPaymentSuccess(detail)`, exported from `/core`), and waits for the
  number the same way through `Vio.checkout.getOrderReference(checkoutId)`.

### `add_payment_info` — the checkout, linked to this session (0.29.0)

The moment a backend checkout exists for a payment — Vipps (from the product
detail, the cart or the checkout), a Stripe payment link or Element, Klarna, Apple
Pay, Nexi, Kustom, Qliro, Walley, Adyen — the SDK emits **`add_payment_info`**
(the GA4 name) with **`commerce.checkout_id`**, **`payment_method`**, the cart's
lines (`items`, `value`, `currency`) and the same context as `begin_checkout`
(sponsor, campaign, slot, content), split per campaign like it. Once per checkout
per page load; nothing when the checkout could not be created. When the page is
about to leave for the provider (Vipps, a Stripe payment link) it goes out by
beacon first.

Why (ADR-0039): Commerce's `order_paid` is what says a sale happened, and the
browser's `purchase` can be missing (a closed tab, a phone that discards the page
on the way back). The collector attributes an `order_paid` without a `purchase` to
the session, page and slot of the `add_payment_info` with the same `checkout_id`.

The checkout manager announces each checkout on `window` as
**`vio:checkout-created`** — `{ sponsorId, checkoutId, paymentMethod, campaignId?,
redirect }` — which is what analytics listens to; a host with its own sink can
listen to it too. With `dataLayer: true` it is pushed as GA4's `add_payment_info`
with `payment_type`.

### Impressions carry the products shown (unreleased)

`<vio-product-carousel>`'s **`component_impression`** (≥50% visible for ≥1 s, once
per session and carousel) carries the products it shows in **`commerce.items`**
(`product_id`, `name`, `price`) and `commerce.currency` — the same lines as its
`view_item_list`. The collector counts the per-product "saw" step of the funnel
from them (ADR-0041). While the products load nothing is observed: the 1 s dwell
starts once they are on screen. A carousel whose fetch failed (slotted fallback)
still counts its impression, without items. A host calling
`Vio.analytics.observeImpression(el, context, { commerce: () => ({ items, currency }) })`
does the same for its own elements: the getter is read when the impression fires.

### Internal traffic — mark your browser as a tester (unreleased)

Our own visits (testers, the team, agents) must not count in the dashboard. Mark
**each browser you test with** once:

1. Open any page of the site that runs the SDK with **`?vio_internal=1`** added to
   the URL — e.g. `https://example.com/article?vio_internal=1` (or
   `…?utm_source=x&vio_internal=1` when the URL already has a query).
2. Open the browser's console: the SDK says once
   `[Vio.analytics] this browser is marked as internal traffic …`.
3. That's it. The mark is remembered in this browser (`localStorage`,
   `vio.internal.v1`, per site) for every page and every later visit, and every
   analytics event it sends carries **`client.internal: true`**; the collector's
   reads leave those events out.

To **undo** it, open any page with **`?vio_internal=0`**. Things to know:

- The mark is per browser and per site: Safari and Chrome on the same phone, a
  private window, or another site are marked separately. Clearing the site's data
  clears the mark.
- In-app browsers (Instagram, Facebook) and private windows may not keep
  `localStorage`: there, only the page opened with `?vio_internal=1` is marked.
  Prefer a regular browser for testing.
- The URL is read once per page load (at `Vio.init()`), not on client-side
  navigation.
- The mark is the tester's own choice, not a tracking id: it is written even
  before consent (`requireConsent`).
- A host can mark from code: **`Vio.analytics.setInternal(true | false)`**
  (`Vio.analytics.isInternal` reads it). `resolveInternal()` / `INTERNAL_KEY` are
  exported from `/core`.

## Sponsor identity — name and logo

The elements say **who sells**: the sponsor's (brand's) display name and logo.

| Where | What it shows |
|---|---|
| `<vio-product-detail>` | a small brand header at the top of the detail — the logo (the name as its `alt`), or the name — for the sponsor the product was fetched with |
| `<vio-checkout>` header | «Du handler hos ‹logo \| name›» — the checkout's sponsor («Du har handlet hos …» over a provider's own receipt) |
| `<vio-checkout>` confirmation | «Takk for bestillingen! Du har handlet hos Careless.» next to the order number, with the logo above when there is one |
| `<vio-cart>` / carousel | the sponsor label over a sponsor's lines, the `retailer` line of a carousel's cards (by name) |

No logo → the name. A logo that fails to load → the name. Nothing known → nothing
(the product detail shows no header; the confirmation keeps «Takk for bestillingen!»
without the sentence). The marks are styled with the `--vio-*` tokens and exposed as
`part="sponsor"` (`vio-checkout::part(sponsor)`).

**One rule.** `Vio.sponsorIdentity(sponsorId, { checkoutId? })` answers
`{ id, name, logoUrl, avatarUrl } | null` — and every element uses it:

1. the live bootstrap's sponsor blocks: the config's `primarySponsor` and
   `secondarySponsors`, then every `campaigns[]` entry's primary and secondaries,
   first match (a surface with no active campaign still names its channel brands);
2. when the bootstrap does not know the id (not loaded yet, a redirect return): what
   this tab remembered of the checkout — when the SDK creates a checkout it keeps
   `checkoutId → { sponsorId, name, logoUrl }` in `sessionStorage`
   (`vio.checkoutSponsor.v1`, the last 20 checkouts; it works, for that page,
   without storage) — then the latest remembered checkout of that sponsor;
3. the cart's `sponsorName`;
4. `null`.

With only `{ checkoutId }` the sponsor is the one remembered for that checkout. URLs
are kept as given; an empty `logoUrl` is `null`. `sponsorIdentityFrom(bootstrap,
sponsorId)` is the pure step 1, exported from `/core`.

**From the checkout, never from the page.** In the checkout and on its confirmation
the sponsor is the **checkout's** — the cart's sponsor, the one the order is with —
from the checkout state or the return URL (`vio_sponsor`, `checkout_id`), never
`Vio.attribution()`: an article of one brand may sell another brand's product. Back
from Vipps the confirmation names the brand from the memory at once, or from the
bootstrap as soon as it lands (the thanks is shown first, the name follows).

**For hosts.** `vio:checkout-open` and `vio:payment-success` carry
`sponsor: { id, name, logoUrl }` in their detail when it can be named (the key is
absent otherwise), and `Vio.checkout.getOrderReference(checkoutId, sponsorId?)`
answers `{ orderNumber, buyerRef, sponsor? }` by the same rule. The SDK cleans its
return parameters from the URL once it has used them, so its own confirmation does
not come back on a reload — a host that wants a confirmation page that survives one
keeps the two ids in its own URL and asks again:

```ts
// On the purchase: keep what the confirmation needs in YOUR url.
document.addEventListener('vio:payment-success', (e) => {
  const d = (e as CustomEvent).detail
  const checkoutId = String(d.checkoutId ?? d.orderId ?? '')
  history.replaceState(null, '', `/takk?checkout=${checkoutId}&sponsor=${d.sponsorId ?? ''}`)
  render(d.sponsor)
})

// On /takk (also after a reload, or in another browser):
const params = new URLSearchParams(location.search)
const ref = await Vio.checkout.getOrderReference(params.get('checkout') ?? '', Number(params.get('sponsor')) || undefined)
render(ref.sponsor, ref.orderNumber) // waits for Vio.init (up to 2 s) and the bootstrap; never throws

function render(sponsor?: { name: string; logoUrl: string | null }, orderNumber?: number | null) {
  // «Takk for bestillingen! Du har handlet hos {sponsor.name}.» — the logo when sponsor.logoUrl
}
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

### Layout of the detail, cart, checkout and confirmation (0.28)

Beyond colors and fonts, the layout a host needs to fit its design is public too —
**one key in `applyVioTheme`, one `--vio-*` property behind it**. Our demo, Replit and
Vev's Config block set the same keys, so a page looks the same in the editor, the
preview and published. Set them with `applyVioTheme` (preferred) or as CSS on `:root`
or on the element (`vio-product-detail { --vio-detail-logo-height: 48px; }`).

| `applyVioTheme` key | Property | Default | What it does |
|---|---|---|---|
| `detailWidth` | `--vio-detail-width` | `440px` | Detail panel width (desktop) |
| `detailPaddingX` | `--vio-detail-padding-x` | `24px` | Side padding of the detail |
| `detailLogoHeight` | `--vio-detail-logo-height` | `44px` | Selling brand's logo, top left beside ✕ (width keeps its proportions; the name when there is no logo; a square logo — a mark — gets the name beside it) |
| `detailLogoZoom` | `--vio-detail-logo-zoom` | `1` | Zoom inside the logo's box: `1.8` crops the white around a mark in a square file |
| `detailTitleSize` / `detailPriceSize` | `--vio-detail-title-size` / `--vio-detail-price-size` | `26px` / `24px` | Name and price |
| `detailImageFit` | `--vio-detail-image-fit` | `cover` | `cover` = fills the box, crops the overflow; `contain` = whole image, bars where shapes differ |
| `detailImageAspect` | `--vio-detail-image-aspect` | `4 / 5` | One proportion for every image, so the panel never jumps: `1 / 1`, `3 / 4`… or `auto` (each image its own) |
| `detailImageMaxHeight` | `--vio-detail-image-max-height` | `85vh` | Cap on the main image's height |
| `detailImageZoom` | `--vio-detail-image-zoom` | `1` | Zoom; e.g. `1.15` crops a white margin baked into the file |
| `detailImageInset` | `--vio-detail-image-inset` | the padding | Side margin of the image; `0` = edge to edge |
| `detailImageBg` | `--vio-detail-image-bg` | muted surface | Behind the image |
| `detailThumbSize` / `detailThumbGap` | `--vio-detail-thumb-size` / `--vio-detail-thumb-gap` | `64px` / `8px` | Thumbnails — always one row: swipe on touch, arrows with a mouse, the selected one kept in view |
| `detailThumbRadius` / `detailThumbActiveColor` | `--vio-detail-thumb-radius` / `--vio-detail-thumb-active-color` | `0` / text color | Thumbnail corners, selected border |
| `detailOptionHeight` / `detailOptionGap` | `--vio-detail-option-height` / `--vio-detail-option-gap` | `36px` / `6px` | Size / option buttons (height is also their min width) |
| `detailOptionRadius` / `detailOptionWrap` | `--vio-detail-option-radius` / `--vio-detail-option-wrap` | `0` / `wrap` | `nowrap` = one line that scrolls sideways |
| `detailButtonHeight` / `detailButtonRadius` | `--vio-detail-button-height` / `--vio-detail-button-radius` | `52px` / `0` | Quantity stepper and «Legg i handlekurv» |
| `detailBuyPosition` / `detailBuyShadow` | `--vio-detail-buy-position` / `--vio-detail-buy-shadow` | `static` | `sticky` pins the buy zone (Vipps, quantity, add to cart) to the bottom of the panel while scrolling |
| `cartWidth` / `checkoutWidth` | `--vio-cart-width` / `--vio-checkout-width` | `440px` | Drawer widths (desktop) |
| `confirmLogoHeight` / `confirmTitleSize` / `confirmCheckBg` | `--vio-confirm-logo-height` / `--vio-confirm-title-size` / `--vio-confirm-check-bg` | `40px` / `24px` / green | The confirmation |
| `redirectBg` / `redirectSpinner` | `--vio-redirect-bg` / `--vio-redirect-spinner` | translucent white / Vipps orange | The «Åpner Vipps …» overlay |

Also settable as CSS only: `--vio-detail-logo-max-width` (`220px`), `--vio-detail-image-position`,
`--vio-detail-image-radius`, `--vio-detail-thumb-fit` (`cover`), `--vio-detail-thumb-border-width`,
`--vio-detail-option-padding-x` (`12px`), `--vio-detail-option-font-size`, `--vio-detail-buy-gap`,
`--vio-detail-buy-padding`, `--vio-detail-buy-bg`, `--vio-detail-info-gap`, `--vio-detail-gallery-gap`,
`--vio-detail-title-weight`, `--vio-detail-price-weight`, `--vio-confirm-logo-max-width`,
`--vio-confirm-title-weight`, `--vio-confirm-text-size`, `--vio-redirect-color`, `--vio-redirect-font`,
`--vio-detail-seller-note-size` (`12px`), `--vio-detail-seller-note-align` (`center`).

**`::part` names**, for what the properties do not cover:

- `<vio-product-detail>`: `topbar`, `sponsor`, `close`, `gallery`, `image`, `thumbs`, `thumb`
  (+ `thumb-active`), `thumbs-arrow`, `info`, `brand`, `title`, `price`, `delivery-note`
  (`delivery-shipping`, `delivery-withdrawal`), `stock`, `buy`, `buy-options`, `option-group`,
  `option-label`, `option-chosen`, `option-prompt`, `options`, `option` (+ `option-selected`),
  `buy-pending`, `buy-vipps`, `vipps-note`, `quantity-row`, `add-to-cart`, `seller-note`,
  `seller-terms`, `seller-refund`, `description`, `highlights`, `highlight`, `shipping-returns`,
  `slide`, `image-dots`, `carousel-arrow`, `added-toast` (`added-toast-checkout`,
  `added-toast-continue`).
- `<vio-cart>`: `cart-shipping`, `cart-total`.
- `<vio-checkout>`: `sponsor`, `confirmation`, `confirm-title`, `confirm-sponsor`, `confirm-details`.

```css
vio-product-detail::part(add-to-cart) { letter-spacing: 0; text-transform: none; }
vio-product-detail::part(option-selected) { background: #2b2b2b; }
```

**The detail's order:** the selling brand top left; the images (thumbnails, or a carousel);
name and stock on one line, the price; the buy zone — the sizes (none preselected; every buy
button asks «Velg størrelse» first), «Frakt fra X · 14 dagers angrerett», **Vipps first** (when
the channel has it), quantity + «Legg i handlekurv», the other ways to pay, and under them «Du
handler direkte hos {brand}.» (the product's brand, never the article's) with links to the
brand's «Kjøpsvilkår» and «Angrerett og retur» when it gave them (the sponsor block's
`termsUrl` / `refundPolicyUrl`, https only, new tab); the brand's promises; «Beskrivelse»; and
«Frakt & retur». The same order on every screen.

### Options of the detail and the product cards (0.32)

Every one is off or as before unless the host sets it: per element (attribute), or for the
whole page through `applyVioTheme` (theme key → custom property). The element wins.

**`<vio-product-detail>`**

| Attribute | Theme key | Values | What |
|---|---|---|---|
| `gallery` | `detailGallery` | `thumbs` (default) · `carousel` | `carousel`: every photo in one swipeable row with a dot per photo, no thumbnails — less height. `detailCarouselPeek` (`--vio-detail-carousel-peek`) shows the edge of the next one |
| `description-mode` | `detailDescriptionMode` | `preview` (default) · `folded` · `open` | «Beskrivelse»: the first lines fading out + «Les mer» (`detailDescriptionPreviewLines`, `3`); only the heading until a tap; or all of it |
| `highlights` | — | `[{ icon, title, text }]` (JSON) | The brand's promises under the buy zone. By default the brand's own (dashboard Settings → Brand, sponsor block `highlights`); this list replaces them on the page. Icons: `plane heart shirt truck return leaf star shield mailbox home pin clock`, or an image URL. `detailHighlightsDisplay: 'none'` hides the strip |
| `delivery-time` | — | text, e.g. `2-5 virkedager` | «Leveringstid …» in «Frakt & retur» for a brand whose rates do not say it (each rate's own text in Commerce — «Leveringstid 1-5 dager» — wins) |
| `carrier-logos` | — | `{ "Bring": "https://…" }` (JSON) | Carrier logos by the name the rate starts with («Bring - Pakke i postkasse»), for rates without their own logo in Commerce (`logo_url`, which wins); otherwise a line icon by the kind of delivery |
| — | `detailShippingReturnsDisplay` | `block` (default) · `none` | «Frakt & retur»: one row per carrier (logo or icon, carrier, how it delivers, price), the delivery time, the right of withdrawal and the brand's pages |

The sheet closes with a pull down from its top bar, or from anywhere while its content is at the top.

**`<vio-product-carousel>`** (and its cards, `<vio-product>`)

| Attribute | Theme key | Values | What |
|---|---|---|---|
| `layout` | `carouselLayout` | `carousel` (default) · `list` | `list`: one card under the other, as wide as the column (`--vio-carousel-list-max-width`, `480px`) |
| `show-description` | — | boolean | Each card shows its product's description (`cardDescriptionLines`, `4`) |
| `descriptions` | — | `{ "<productId>": "text" }` (JSON) | The editor's own text for a product, over the catalogue's — shown even without `show-description`; `""` hides that one |
| `button-style` | — | `icon` (default) · `bar` · `hidden` | The buy button: the round bag on the image, a full-width «Kjøp» bar under the price (as the Vev card), or none. Both add to the cart, or open the product when it has sizes |
| `button-label` | — | text, default `Kjøp` | The bar's text («Kjøp · 2» once two are in the cart) |

Card look, by theme key (custom property): `cardFont`, `cardBorder`, `cardImageAspect`,
`cardImageFit`, `cardImageBg`, `cardImagePadding`, `cardMetaPadding`, `cardPriceFont`,
`cardAccent`, `cardBarRadius`, `cardDescriptionLines`, `cardRetailerOrder` (`-1` lifts the seller
line above the name). CSS only: `--vio-card-border-hover-color`, `--vio-card-add-size`,
`--vio-card-add-icon-size`, `--vio-card-brand-{size,tracking,weight,color,gap}`,
`--vio-card-name-{font,size,weight,gap}`, `--vio-card-price-{size,weight,gap}`,
`--vio-card-retailer-{display,size,tracking,weight,color,margin}`,
`--vio-card-description-{size,color,gap}`, `--vio-card-accent-text`.

### The hand-over to Vipps (0.28)

Between the tap on Vipps (detail, cart or checkout) and the Vipps page, the SDK shows
a full-screen «Åpner Vipps …» with a soft fade — no empty moment, and it takes every
tap, so a second payment cannot start. Events on `document`:

| Event | Detail | When |
|---|---|---|
| `vio:payment-redirect-start` | `{ method, sponsorId, source }` | At the tap. **Cancelable**: `preventDefault()` and the SDK draws no overlay — draw your own |
| `vio:payment-redirect-error` | `… , reason` | It could not start. The overlay goes; the checkout opens with Vipps preselected |
| `vio:payment-redirect-cancel` | `… , reason` | `'express-off'` / `'not-started'`: the checkout opens instead (no error). `'back'`: the shopper came back with the browser's back button. `'cancelled'`: back through Vipps' own cancel (with `checkoutId`) |

`source` is `'detail'`, `'cart'` or `'checkout'`. The overlay is `.vio-redirect-overlay`
in the light DOM.

**The detail's Vipps button pays the whole cart.** «Kjøp nå med Vipps» on the product
detail adds the product to the sponsor's cart and the checkout is built on that cart —
every line in it. It goes straight to Vipps only when the cart was **empty**; with lines
already in it, the product is added and the checkout opens first (`vio:checkout-open`
with `paymentMethod: 'vipps'`, no hand-over events), every line and the total on screen,
so what the Vipps page lists is what the shopper saw.

**Two Vipps paths (2026-10-28).** The detail's «Kjøp nå med Vipps» is **Express**: the app
fills in name and address. The **cart's** Vipps button opens the checkout with Vipps
preselected, and the checkout's Vipps is always the **standard** payment, even when the
brand has Express on. Our form collects name, e-mail, **Mobilnummer**, address and the
delivery with its price before paying. The mobile is required for Vipps only and accepts any
market's number: the `+` prefix or the shipping country sets the calling code. The delivery is
saved on the cart first; if that fails, no payment starts. The payment goes out with
`express: false`, and the address (with `phone` + `phone_code`) is on the checkout's shipping
and billing address. **Apple Pay on the detail follows the same
rule**: its sheet's amount is fixed before the tap, so it opens only on an empty cart, for the
product × the chosen quantity; otherwise the checkout opens (`paymentMethod: 'apple-pay'`).

### What the shopper pays is what the page shows — the cart, the server, the other tabs

The cart lives in this tab's memory and in `localStorage` (`vio.cart.v1`, one entry per
sponsor with the backend cart id), and the checkout — and the Vipps / Stripe page — is
built on the **backend** cart, every line of it. Three things keep the two the same:

- **Before a checkout is created or a payment link minted**, and **when `<vio-cart>` or
  `<vio-checkout>` opens**, the SDK asks the server for the cart (`GetCart`) and draws that
  answer: a line another tab added, a cart another tab emptied. `Vio.cart.refreshFromServer(sponsorId)`
  does the same on demand and resolves with the sponsor's cart. A `GetCart` that fails leaves
  the cart as it was (and warns) — the checkout then goes on with the lines the last mutation
  answered, as before.
- **Other tabs of the site are heard.** A payment in one tab (its cart cleared) empties the
  drawer of the others and the next add there opens a new backend cart; a line added in one
  tab is in the others without a reload. Through the browser's `storage` event — a tab that
  is mid-add for a sponsor keeps its own lines until its answer lands.
- **An open checkout follows its cart**: its lines and its total are recomputed when the
  cart changes under it (the widgets that captured an amount at mount ask to be refreshed,
  as they already did for a changed cart).

`vio:cart-updated` on `document` says when either of the first two happened:

```ts
document.addEventListener('vio:cart-updated', (e) => {
  const { sponsorId, cartId, items, itemCount, subtotal, currency, source } = e.detail
  // source: 'server' (GetCart, right before a checkout / on opening) | 'storage' (another tab)
})
```

`items` are copies of the lines (`CartLineItem[]`). A host that draws its own cart or badge
redraws it from this event; `<vio-cart>` and the badge wired to `Vio.cart`'s `change` need nothing.

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
