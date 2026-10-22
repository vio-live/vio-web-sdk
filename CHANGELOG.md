# Changelog — `@vio-live/web-sdk`

What changed in each version, and **what a host has to know before upgrading**.
Every version has up to four parts:

- **Added** — new things you can use.
- **Changed** — the same feature behaves differently (screens, events, data on the wire).
- **Fixed** — bugs that are gone.
- **⚠️ Upgrade notes** — what a host (Vev, Replit, a custom page) must do, check or
  watch for. Read these before bumping, even for a patch.

Newest first. `Unreleased` is merged on `main` but **not published to npm** yet.
How to keep this file: see [CONTRIBUTING → Changelog](CONTRIBUTING.md#changelog).
The details of each feature live in the [README](README.md); this file says *what*
and *when*, and links there.

## Unreleased

### Added
- **The detail's layout is public**: 31 new `applyVioTheme` keys, each a `--vio-*` property
  (logo height and zoom, image fit / aspect / max height / zoom / side margin, thumbnail size and gap, option
  height and gap, button height and radius, a sticky buy zone, cart / checkout widths,
  confirmation logo and title, the redirect overlay), plus `::part` names on every piece of
  the detail and the confirmation. The same keys serve our demo, Replit and Vev's Config block.
  See [README → Layout](README.md#layout-of-the-detail-cart-checkout-and-confirmation-028).
- **The hand-over to Vipps**: a full-screen «Åpner Vipps …» with a soft fade from the tap to
  the Vipps page (detail, cart, checkout), which also stops a second tap; events
  `vio:payment-redirect-start` (cancelable — draw your own loader), `vio:payment-redirect-error`
  and `vio:payment-redirect-cancel`. See [README → The hand-over to Vipps](README.md#the-hand-over-to-vipps-028).
- `commerce.checkout_id` on every `purchase` the SDK can tie to a checkout, and
  `props.order_id_kind` (`'order'` | `'checkout'`).
- `vio:payment-success` may carry `orderNumber` when the checkout already knows it.
- `purchaseIdsOf(detail)` → `{ orderId, checkoutId, orderIdKind }` (from `/core`) for
  hosts with their own analytics sink.

### Changed
- **Product detail** (asked by Mote & Livsstil): the selling brand's logo (its name without
  one; a square logo with the name beside it) sits **top left beside ✕**, no longer above the
  image; every main image shows in **one 4:5 box it fills** (`cover`) — no white bars, no jump
  between photos of different shapes; thumbnails are **one row** (swipe, arrows with a mouse,
  the selected one kept in view) instead of wrapping; sizes are **compact** (36px); **Vipps
  comes first**, above quantity and «Legg i handlekurv»; the **description folds** («Beskrivelse»
  opens on a tap). On desktop the description comes before the buy zone, which stays pinned at
  the bottom of the panel; phones keep buy zone, then description.
- The confirmation's brand logo is 40px tall (was max 32px).

### Fixed
- **The `purchase` event's `commerce.order_id` is Vio's order number** (`4415`), not the
  checkout's uuid. Before, every purchase paid through a redirect (Vipps, Klarna, hosted
  Stripe) or whose order a webhook creates carried the uuid, so Commerce could never net
  a cancellation or refund (`order_cancelled` / `order_refunded`, ADR-0036) against it.
  ([#88](https://github.com/vio-live/vio-web-sdk/pull/88))

### ⚠️ Upgrade notes
- **The product detail looks different** after upgrading (see *Changed*). A host that styled
  `.sponsor-header` / `.topbar-brand` from outside: they are gone — use `::part(sponsor)`.
  Hosts that want the old look back: `detailImageAspect: '1 / 1'`, `detailImageFit: 'contain'`,
  `detailOptionHeight: '42px'`, `detailBuyPosition: 'static'`. The `4 / 5` box crops photos of
  other shapes: pick the proportion that fits the catalog, or `contain`.
- A host with its own «loading Vipps» screen: call `preventDefault()` on
  `vio:payment-redirect-start`, or the SDK's overlay shows on top of yours.
- **The `purchase` may leave up to 10 s after `vio:payment-success`**: the SDK asks the
  checkout for the order number at once and then after 0.5, 1, 2, 3 and 3 s. The confirmation screen, the
  cart and the payment never wait — only the analytics event. If the page hides first,
  the event leaves at once with the checkout id (`order_id_kind: 'checkout'`).
- **Hosts with their own sink (Vev):** read the ids with `purchaseIdsOf(detail)` and wait
  for the number the same way (`Vio.checkout.getOrderReference(checkoutId)`), or your
  purchases keep the uuid.
- **Dashboards / queries** that joined purchases by checkout uuid: use `checkout_id`.
- One `purchase` per checkout per page load: a second `vio:payment-success` for the same
  checkout adds nothing.

## 0.27.0 — 2026-10-21

### Added
- **The brand that sells is named** — name and logo — in the product detail (top),
  the checkout header («Du handler hos …») and the confirmation («Du har handlet hos
  …»), also after a Vipps return and a reload. ([#91](https://github.com/vio-live/vio-web-sdk/pull/91))
- `Vio.sponsorIdentity(sponsorId, { checkoutId? })` → `{ id, name, logoUrl, avatarUrl } | null`.
- `vio:checkout-open` and `vio:payment-success` carry `sponsor: { id, name, logoUrl }`.
- `Vio.checkout.getOrderReference(checkoutId, sponsorId?)` also answers `sponsor`.
- `sponsorIdentityFrom(bootstrap, sponsorId)` exported from `/core`.

### Changed
- The detail's top line names the seller only once (no repeated seller name).
- The checkout remembers, per tab, which sponsor each checkout belongs to
  (`sessionStorage` `vio.checkoutSponsor.v1`, last 20 checkouts).

### ⚠️ Upgrade notes
- The sponsor in the checkout and its confirmation is **the checkout's** (the cart's
  brand), never the article's: an article of one brand can sell another brand's product.
- A host confirmation page that must survive a reload keeps `checkoutId` and `sponsorId`
  in its own URL and asks `getOrderReference` again: the SDK cleans its return
  parameters after using them. Recipe in [README → Sponsor identity](README.md#sponsor-identity--name-and-logo).
- New marks are styled with `--vio-*` tokens and exposed as `part="sponsor"`.

## 0.26.1 — 2026-10-21

### Fixed
- A surface with **no active campaign** still names its channel sponsor in the
  attribution (before, the sponsor came out empty). ([#89](https://github.com/vio-live/vio-web-sdk/pull/89))

## 0.26.0 — 2026-10-20

### Added
- **The order is born attributed** (ADR-0035 B): every `AddItem` / quantity increase
  carries the line's `origin` (`campaign_id`, slot, `component_kind`, `content_url`,
  `content_title`), and `CreateCheckout` / the last `UpdateCheckout` carry the checkout's
  `attribution`. See [README → Attribution on the order](README.md#attribution-on-the-order--what-commerce-receives-026).

### Changed
- `content_url` is sent **without query string or fragment**.
- Privacy mode `minimal` sends neither the page nor the slot.
- The surface's privacy mode is preloaded, so the first events already respect it.
- `vio:payment-success` never waits longer than the page stays open; one reference
  request per checkout.
- The landing `referrer` has no query and is dropped when it is a self-referral;
  `buyer_id` only with consent.

### ⚠️ Upgrade notes
- **Against a gateway without the new fields** (`origin` on `LineItemInput` / `UpdateItem`,
  `attribution` on the checkout) the SDK resends the operation without them once per page
  load and says so in the console: the cart works as in 0.25, **but the order is not
  attributed**. Deploy the backend for the attribution to reach Commerce.
- Hosts that add to the cart with their own button should pass
  `origin: Vio.attribution(slot)` (or `e.detail.origin`) to `Vio.cart.addProduct`.

## 0.25.0 — 2026-10-19

### Added
- The checkout asks the gateway for **`buyer_ref`** (a keyed hash of the buyer's email)
  and puts it on `vio:payment-success` → analytics `buyer_id`.
- Every event carries a **`client`** block: language, the landing's referrer and utm
  parameters, screen size and time zone (see [README → The visit and the buyer](README.md#the-visit-and-the-buyer--client-and-buyer_id-025)).
- Slot manifests carry `kind`; every element carries `component_template_id`.

### Changed
- A slot assigned `page` counts as the page's campaign when its sponsor is known.

### ⚠️ Upgrade notes
- Never store an email from the events: `buyerRef` is the reference to keep.
- With `requireConsent`, nothing is written (landing memory, ids) until `setConsent(true)`,
  and `buyer_id` is not sent.

## 0.24.0 — 2026-10-16

### Added
- **The page says which campaign it belongs to** (ADR-0034, amendment 3):
  `Vio.init({ campaignId })`, `<body data-vio-campaign="…">`, or `vio-campaign` on one
  element. See [README → Page campaign](README.md#page-campaign--an-editorial-page-that-belongs-to-one-campaign).

### Fixed
- The cart's reconcile skips the mutation that is answering; card context per product;
  title and URL capped to the collector's limits.

### ⚠️ Upgrade notes
- The attributes are read **when an element mounts**: in an SPA, update `data-vio-campaign`
  (or call `Vio.init` again) before mounting the next article's blocks.
- A paused, unknown or non-numeric campaign falls through to the next level.

## 0.23.1 — 2026-10-16

### Added
- **Automatic slot identity**: with `data-vio-scope` (and `data-vio-scope-name`) on an
  ancestor, every element registers itself (`article-123-carousel-1`); `Vio.attribution()`.
- The cart remembers the origin of each unit; a purchase is split per campaign.

### Fixed
- Collector limits respected; a one-campaign purchase is one slice; stable origins.

## 0.23.0 — 2026-10-16

### Added
- **Slots**: the page declares its slots and each one resolves its campaign from the
  dashboard (ADR-0027 / 0034). See [README → Slots](README.md#slots--where-things-happen-on-a-page).

### Fixed
- The checkout waits for pending cart mutations before creating a checkout or a payment link.
- GraphQL cart calls time out after 15 s.

### ⚠️ Upgrade notes
- `Vio.init({ platform: 'web' | 'custom-web' | 'vev' })` — default `'web'`. Only that
  platform's assignments come back.

## 0.22.0 — 2026-10-16
Version bump only; same code as 0.21.1.

## 0.21.1 — 2026-10-16

### Fixed
- Quantity changes are serialized and coalesced per cart line: quick taps on + / − end on
  the quantity the shopper sees, with one request in flight at a time.

## 0.21.0 — 2026-10-15

### Fixed
- Analytics: `order_id` only with Vio ids, the cart's `value`, and `checkout_id` on
  payment returns.

## 0.20.5 — 2026-10-15

### Fixed
- Analytics: the real `campaign_id`, a consistent `order_id` on `purchase`, and
  `X-Api-Key` on the events request.

## 0.20.4 — 2026-10-14

### Fixed
- A bootstrap request started before a re-init no longer lands in the new configuration.

## 0.20.3 — 2026-10-12

### Changed
- A cart already paid in another tab reads «already paid», not «failed».

## 0.20.1 / 0.20.2 — 2026-10-12

### Fixed
- The dialogs' focus trap keeps keyboard focus inside in Safari, and pulls it back when the
  browser walks out of the dialog.

## 0.20.0 — 2026-10-09

### Added
- Keyboard and focus in the detail, cart and checkout: focus moves in on open, Tab stays
  inside, Esc closes, focus returns on close.

### Changed
- The detail and the cart read the corner radius from the theme (`--vio-radius-*`).
- When a payment cannot start, the shopper is told what to do (empty cart, cart changed in
  another tab, already paid) instead of a raw error.

## 0.19.0 — 2026-10-08

### Changed
- The product detail's header shows the seller's **Company name** (Vio Commerce →
  Settings → Company), the brand when there is none. *(Superseded in 0.27.0 by the
  sponsor's name and logo.)*

### ⚠️ Upgrade notes
- The name is read with its own query outside the product cache (`useCache: false`): a
  narrow query written to the gateway's product cache would hand the next product query a
  product without price or images.

## 0.18.0 — 2026-10-08

### Added
- Vipps' **official button** in the detail, the cart and the checkout; **Vipps Express**
  from the product and the cart (the app collects address and delivery).
- Stripe Connect in the embedded payment and Apple Pay (ADR-0022).

### Changed
- Back from a payment page the drawer shows **only** «Bekrefter betalingen…» until it
  knows the outcome — never the checkout behind it.
- The receipt's «Ordrenummer» is **Vio's order number** (`#4497`), never the checkout's uuid.

### ⚠️ Upgrade notes
- Payment returns come back to **the same URL** with `vio_payment`, `vio_method`,
  `vio_sponsor`, `checkout_id`: keep `<vio-checkout>` mounted on every route and do not
  strip the query string on load.
- The Vipps button loads `cdn.vippsmobilepay.com`: allow it in a CSP.

## 0.17.0 and earlier
Not recorded here — see the git history and the [releases](https://github.com/vio-live/vio-web-sdk/commits/main).
Highlights: Stripe on our own page (0.16), payment method first (0.15), Kustom (0.14),
Adyen (0.13), Nexi (0.12), analytics with consent (0.6 → 0.11).
