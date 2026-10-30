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

### Fixed
- **Kustom, Qliro, Walley and Adyen: the return read is tried again while the key is refused** — on a page
  that boots in steps (Vev: init, bootstrap, init again with the page's campaign) the returning checkout's
  channel key is not known for the first seconds, the read went out with the platform key and got a 401,
  and a paid order still came back to «Vi kunne ikke bekrefte betalingen». A refused key is now retried
  (after 1.5, 3, 5 and 8 s); any other error is shown at once, as before.

## 0.37.3 — 2026-10-30

### Fixed
- **Kustom, Qliro, Walley and Adyen: the return confirms the order on a page that calls `Vio.init()` after
  mounting the checkout (Vev)** — the return read the order at once, before init: no cart yet and no key,
  so a paid Kustom order came back to «Handlekurven er tom.» over «Vi kunne ikke bekrefte betalingen», and
  the cart stayed full (a second purchase paid again). Like the Vipps return since 0.37.1, they now wait for
  init (up to 10 s), reopen on the cart and then read.

## 0.37.2 — 2026-10-30

### Fixed
- **Vipps: after a cancelled payment the delivery form comes back filled** — the page reloads on the way
  back from Vipps and the form was empty, so «Betal … med Vipps» stayed greyed out under «Vennligst fyll
  ut leveringsadresse» until the shopper typed it all again. The checkout now refills the empty fields
  (name, email, mobile, address) from the checkout it left with; nothing the shopper typed is overwritten.

## 0.37.1 — 2026-10-30

### Fixed
- **Kustom: the return confirms the order again on a page with two brands' carts** — the return read
  the order with the platform key when its own cart was already closed, and said «Vi kunne ikke
  bekrefte betalingen» for a paid order. It now reads with the returning checkout's sponsor and
  channel, as Qliro and Walley do; Kustom, Qliro, Walley and Adyen reopen on that sponsor
  ([#123](https://github.com/vio-live/vio-web-sdk/pull/123)).
- **Vipps: coming back from a cancelled payment no longer leaves «Henter betalingsmåter…» for good** —
  on a page that mounts the checkout before it calls `Vio.init()` (Vev), the return found no cart
  (each connection keeps its own), so nothing asked for the payment methods. The checkout now reopens
  on the cart once `Vio.init()` lands (up to 10 s) and lists the methods; a paid return also clears the
  connection's cart. With no checkout at all, the payment step says «Handlekurven er tom.» instead of
  loading.

## 0.37.0 — 2026-10-29

> **Deploy the collector `89f2766` (vio-analytics#38) before using this version:** an older collector rejects
> `cta_click` (the rest of the batch is kept, those clicks are lost).

### Added
- **Button tracking: `cta_click`** — which buttons shoppers use. Every tap on a button of
  `<vio-product-detail>`, `<vio-cart>`, `<vio-product>` and `<vio-checkout>` sends one `cta_click`
  (in `context`: `cta`, `cta_location`, `cta_label`, `option_value`, `product_id`,
  `product_variant_id`, the detail's layout, and the usual attribution), on the tap, before the
  action. Each tap also dispatches **`vio:cta-click`** (bubbles, composed; React `onCtaClick`).
  **`Vio.trackCta({ cta, location, label, variant, … })`** sends the same event for a host's own
  buttons (`location: 'host' | 'card' | 'block'`, `cta_variant` for the button option being
  tested). Ids and fields: [README → Button tracking](README.md#button-tracking-cta_click-unreleased).

### ⚠️ Upgrade notes
- **The collector must know `cta_click`** (and its context fields) before this ships: an older
  collector rejects the event — the rest of the batch is not affected.
- On `cta_click`, **`variant_id` is the layout's experiment variant** (as on `view_item`); the
  product variant is **`product_variant_id`**.
- Hosts with `autoTrack: false` (Vev) get no `cta_click` from the SDK's buttons unless they forward
  `vio:cta-click` themselves (`Vio.trackCta(e.detail)`).
- Nothing is sent before `Vio.analytics.start()`, `Vio.trackCta()` included.

## 0.36.0 — 2026-10-29

### Changed
- **The cart says where shipping is chosen.** Under «Frakt» / «Totalt» a note: «Frakt velger du i Vipps eller i
  neste steg.» (`part="cart-shipping-hint"`). While no rate is chosen and the brand offers several, the shipping and
  the total read «fra …» (the cheapest).

### Added
- **The heading of the description fold is configurable**: `Vio.configureDetail({ descriptionLabel: 'Produktbeskrivelse' })`
  for the page, or `description-label` on `<vio-product-detail>` (wins). Default «Beskrivelse». Feedback from Aller
  (29/10): a folded «Produktbeskrivelse» right under the price — with the section order
  `[..., 'price', 'description', 'options', 'purchase', ...]` and `detailDescriptionMode: 'folded'`.
- **The brand's promises in the cart** too, under the ways to pay (same strip as the product detail, from the
  sponsor block's `highlights`). Hide them with `applyVioTheme({ cartHighlightsDisplay: 'none' })`.

## 0.35.0 — 2026-10-29

> 0.34.0 was never published on its own: its changes (section order of the product detail and layout tracking,
> below) ship in this version too.

### Added
- **`vippsCartPayment: 'express' | 'checkout'`** (theme key, `--vio-vipps-cart-payment`) and the
  attribute **`vipps-cart-payment`** on `<vio-cart>` and `<vio-product-detail>`. `express` is the
  default; `checkout` restores the 0.31–0.34 behaviour exactly. See
  [README → The hand-over to Vipps](README.md#the-hand-over-to-vipps-028).

### Changed
- **The Vipps buttons pay the sponsor's whole cart with Vipps Express** (Angelo, 2026-10-29: «el
  botón negro va con el nuestro y el botón de Vipps paga el carrito entero»). The black «Til
  kassen» is the way into our checkout; Vipps goes to Vipps.
  - **`<vio-cart>`**: the Vipps button starts Express for the sponsor's whole cart — every line of
    that sponsor's backend cart, never another sponsor's — the same Express as the detail: the
    «Åpner Vipps …» overlay, `vio:payment-redirect-*` with `source: 'cart'`, `add_payment_info`
    once, the return from Vipps and its confirmation. It no longer dispatches
    `vio:checkout-open`. One payment at a time (the overlay takes every tap; a second tap while
    one is starting does nothing).
  - **`<vio-product-detail>`**: «Kjøp nå med Vipps» with lines already in the brand's cart adds the
    product (size and quantity) and pays the **whole cart** with Express, instead of opening our
    checkout. The line under the button says what will be paid before the tap: «Betaler hele
    handlekurven · {n} varer · {total}» (n = every unit with this product at the chosen quantity,
    total = the cart's subtotal with it; shipping is chosen in Vipps). It follows the cart and the
    quantity. With an empty cart nothing changes.
  - Express off for the brand, or a cart that cannot have it (several suppliers, no rate): the
    checkout opens with Vipps preselected, as before.
- **A redirect payment (Vipps, Stripe link) reuses only its own sponsor's open checkout.** A
  payment for one sponsor's cart started while another sponsor's checkout was open would have
  gone out on that checkout; it now creates its own.

### ⚠️ Upgrade notes
- **Hosts listening to `vio:checkout-open` from the cart's Vipps button no longer get it** by
  default: the cart goes to Vipps directly. «Til kassen» still sends `vio:checkout-open`, and the
  Vipps button sends it only when Express cannot start (then with `paymentMethod: 'vipps'`). To
  keep the old flow, set `vipps-cart-payment="checkout"` or `applyVioTheme({ vippsCartPayment:
  'checkout' })`.
- **`vio:payment-redirect-start` / `-cancel` / `-error` with `source: 'cart'` are back** (gone
  since 0.31). A host that draws its own loader (`preventDefault()` on the start) gets them from
  the cart too.
- The same for the detail with lines in the cart: no `vio:checkout-open` any more, the hand-over
  events (`source: 'detail'`) instead.
- **Backend:** nothing new. shopcart already builds Express on the checkout's cart, every line;
  it refuses Express (`express: false`, no payment) for a cart of several suppliers, and the
  checkout opens instead.

## 0.34.0 — 2026-10-29

### Added
- **Section order of `<vio-product-detail>` and layout tracking** (asked by Replit for Mote &
  Livsstil). `Vio.configureDetail({ layout: { id, revision, sections, experimentId?, variantId? } })`
  orders the sections below the gallery for the page (`{ layout: null }` resets; open details
  re-render); the element's `layout` property / attribute (JSON) wins. Section ids: `brand`,
  `title`, `stock`, `price`, `options`, `purchase`, `highlights`, `description`,
  `shippingReturns`; unknown ids are ignored, duplicates keep the first, the essentials (`title`,
  `price`, `options`, `purchase`) are appended when missing. The real DOM is reordered, the same
  on every screen. `el.appliedLayout`, `Vio.detailLayout()` and the event
  `vio:detail-layout-applied` say what was applied. See
  [README → Section order and layout tracking](README.md#section-order-and-layout-tracking-034).
- **The layout on the funnel events.** `view_item` of a non-default layout carries `layout_id`,
  `layout_revision`, `experiment_id`, `variant_id` in its `context`. The detail stores the layout
  on the cart line origin (`CartOrigin.layoutId`, `layoutRevision`, `experimentId`, `variantId`),
  and every item of `add_to_cart`, `remove_from_cart`, `view_cart`, `begin_checkout`,
  `add_payment_info` and `purchase` carries `layout_id`, `layout_revision`, `experiment_id`,
  `experiment_variant_id` (`""` when none; `items[].variant_id` stays the product variant). A line
  with units from two layouts is two items. Nothing goes to Commerce.

### ⚠️ Upgrade notes
- **No change without configuration:** the detail renders exactly as in 0.33 and `view_item`
  sends nothing new. The only difference on the wire: the items of the cart events now always
  carry the four layout keys, empty (`""`) when the units came from no layout — the collector
  ignores keys it does not know yet.

## 0.33.0 — 2026-10-28

### Fixed
- **One cart per connection.** Every connection of a site (environment + key) shared one stored
  cart, and every tab adopted what the others wrote: two tabs on two connections (Staging and Prod
  side by side) could take each other's cart for a moment. Each connection now keeps its own
  (`vio.cart.v1:<environment>:<hash of the key>` — never the key itself), a tab only listens to
  its own, and `Vio.init` with another key switches `Vio.cart` to that connection's carts (the
  first one's come back if the page switches back). An answer that arrives for the connection the
  page left lands in that connection's cart, silently — never in the new one.
- **The commerce key is the channel of the article's campaign, not the sponsor's first block.**
  With two campaigns of one sponsor on a surface (Careless: campaign 2 on channel 482, an internal
  test campaign 1 on channel 480), products, carts and checkouts used the default campaign's
  channel even for an article of the other. The key now follows the campaign in context (the
  click's `campaignId`, `vio-campaign`, `data-vio-campaign`, `Vio.init`'s), among the sponsor's
  blocks (a block with `commerce: null` is skipped instead of throwing). `Vio.commerceFor(sponsorId)`
  still works and takes an optional `{ campaignId?, channelId? }`; commerce clients are kept per
  sponsor and key. New: `Vio.sponsorCommerce(sponsorId, ctx?)`.
- **A cart remembers its channel.** `SponsorCartState.channelId` is stored when the backend cart is
  created, and every later cart and checkout call for it (also the return from Vipps / Stripe,
  through the per-checkout memory) uses that channel's key. If the bootstrap no longer lists the
  channel, the stale `cartId` is dropped and the cart is created again on the current channel with
  its lines — never a call with another channel's key. Carts from before keep the sponsor's first
  block, as when they were created.
- **The order's campaign belongs to the cart's sponsor.** `attribution.campaign_id` on the checkout
  and `campaignId` on `vio:checkout-created` (→ `add_payment_info`) took the page's campaign even
  when it was another sponsor's. Now: the campaign the cart's lines were added from, else the
  page's (`data-vio-campaign` / `vio-campaign` on the page, then `Vio.init`'s) only when the sponsor
  takes part in it, else the slices' rule — only campaigns of that sponsor.
- **The bootstrap no longer lives for the whole page.** When the tab becomes visible again and the
  cached bootstrap is older than 5 minutes, it is fetched again (the old one stays until the new
  one arrives, and if the refresh fails). Carts keep their lines; an open checkout keeps paying
  with its channel's key.
- **«Frakt & retur» no longer shows filler as the delivery time.** A rate's description equal to
  its own name (dashboard-created rates copied it), `By Outshifter` or `Default Shipping Method`
  (products' defaults) is no description in `getShippingRates`; the detail also drops one equal
  to the product's title or the brand / seller name.

### ⚠️ Upgrade notes
- **Hosts with several articles (Replit, Vev):** pass `sponsorId` **and** `campaignId` on
  `vio:product-click`, set `data-vio-campaign` on each article's wrapper, and do **not** set a
  site-wide `Vio.init({ campaignId })` — the campaign in context decides which channel sells.
- The carts kept in the old shared entry move, once, to the first connection that opens with none
  of its own. Nothing to do.
- `Vio.cart` is the same object for the whole page, so listeners added to it keep working across a
  re-init. A host that archived and restored carts per connection itself (Replit's
  `vioCartConnections`) can rely on this instead.

## 0.32.0 — 2026-10-28

> First version published to npm since 0.29.0: **0.30.0 and 0.31.0 were never published on their own** — their
> changes (below) ship in this version too. A host on 0.29.0 should read the three sections.

### Added
- **Options for the product detail** (README → *Options of the detail and the product cards*):
  `gallery="carousel"` (every photo in one swipeable row with dots, no thumbnails),
  `description-mode` (`preview` · `folded` · `open`), `highlights`, `delivery-time`,
  `carrier-logos`; theme keys `detailGallery`, `detailCarouselPeek`, `detailDescriptionMode`,
  `detailDescriptionPreviewLines`, `detailHighlightsDisplay`, `detailShippingReturnsDisplay`.
- **The brand's promises** under the buy zone (icon, title, line of text — up to three), from the
  sponsor block's `highlights` (dashboard Settings → Brand) unless the host passes its own.
- **«Frakt & retur»** fold after «Beskrivelse»: one row per carrier (its logo from Commerce's
  `logo_url`, or `carrier-logos`, or a line icon by the kind of delivery), how it delivers, the
  price; the delivery time the brand wrote on the rate («Leveringstid 1-5 dager»); the right of
  withdrawal and the brand's pages.
- **Product cards:** `<vio-product-carousel layout="list">` (one under the other),
  `show-description` / `descriptions` (the catalogue's text or the editor's own per product),
  `button-style` (`icon` · `bar` · `hidden`) and `button-label` (the Vev card's «Kjøp» bar); card
  look through theme keys `card*` and `--vio-card-*`.
- `commerce.channel.product.getShippingRates` returns each rate's `description` and `logoUrl`.

### Changed
- **The detail's order is the same on every screen**: sizes first in the buy zone, «Frakt fra …»
  under them, stock on the name's line, «Beskrivelse» at the very bottom. The buy zone no longer
  pins itself on desktop (`detailBuyPosition: 'sticky'` brings that back).
- **«Beskrivelse» shows a preview** (the first three lines and «Les mer») instead of being folded
  shut. `description-mode="folded"` keeps the old behaviour.
- **The sheets close with a pull down from anywhere** while their content is at the top, not only
  from the grab bar or the top bar (detail, cart, checkout).

### ⚠️ Upgrade notes
- Rates are asked with `logo_url`; a gateway without the field is asked again without it once
  (and not again on that page), so the rates never go missing over a logo.
- A host that styled `details.description-block` for «Beskrivelse» now gets
  `.description-preview` (`part="description"` unchanged).

## 0.31.0 — 2026-10-28

### Added
- **Delivery and returns under the price in the product detail.** It reads «Frakt fra X · 14
  dagers angrerett», where X is the product's cheapest shipping rate for the page's market (the
  same `product_shipping` rates the backend cart offers). A cheapest rate of 0 reads «Gratis frakt».
  With no known rate, only «14 dagers angrerett» is shown (`part="delivery-note"`). The rates come
  from a separate query (`commerce.channel.product.getShippingRates`), so a failure there only
  loses this line.
- **The cart drawer shows shipping and the total including it.** It uses the rate chosen on the
  server cart, or the cheapest rate offered. Without a known rate it reads «Frakt: Beregnes i
  kassen» and shows no total (`part="cart-shipping"`, `part="cart-total"`).
- **«Lagt i handlekurven» after «Legg i handlekurv».** The detail closes and a small toast offers
  **«Til kassen»** and **«Fortsett å handle»** (`part="added-toast"`). «Til kassen» dispatches
  `vio:checkout-open` for that brand, the same event the cart's «Til kassen» sends. It does nothing
  when the cart was emptied in the meantime. The toast closes by itself after 8 s.
- **A line under «Kjøp nå med Vipps» in the product detail:** «Vipps fyller inn navn og adresse –
  du godkjenner og betaler i appen» (`part="vipps-note"`). It is shown only when that button goes
  straight to the app: Express is on for the brand and the brand's cart is empty. In other cases
  the button opens the checkout first.
### Changed
- **The product detail no longer picks a size for the shopper.** Only an option with a single
  value is preselected. The chosen value is shown beside the option's name («Størrelse: M») and
  on its pill. Every buy button (Vipps, «Legg i handlekurv», «Kjøp nå», Stripe, Klarna, Apple Pay)
  checks for a missing choice first: it shows «Velg størrelse» (or «Velg farge», etc.) and adds or
  pays nothing. «Få igjen — N stk» now counts only the variant actually chosen. Before a size is
  chosen it says «På lager» if any size is in stock.
- **Two Vipps paths.** The product detail's «Kjøp nå med Vipps» stays **Express**. The
  **cart's** Vipps button now opens the checkout with Vipps preselected. It no longer starts
  Express or hands over to Vipps. **The checkout's Vipps is always the standard payment**, even
  when the brand has Express on:
  - the address form, the delivery and its price are required before paying, as for Stripe;
  - the summary counts our shipping rate, so «Velges i Vipps» is gone;
  - the payment is `startVippsPayment(sponsorId, form, { express: false })`, which now puts the
    form's complete address on the checkout's shipping and billing address.

  `COLLECTS_OWN_ADDRESS` no longer lists Vipps. See
  [README → Two Vipps paths](README.md#the-hand-over-to-vipps-028).
- **«Mobilnummer» in the checkout's address form.** It is required only for the standard Vipps
  payment, and optional for every other method; it never blocks their buttons or widgets.
  - It accepts any market's number. A `+`/`00` prefix sets the calling code; without one, the
    shipping country does (NO 47, SE 46, DK 45, FI 358, DE 49, GB 44…), falling back to the
    page's country. A trunk 0 is dropped.
  - A number that cannot be read shows «Skriv et gyldig mobilnummer…».
  - It is sent as `phone` (national digits) + `phone_code` (digits, no plus) on the shipping and
    billing address of every method that takes our form. `CheckoutAddress.phone` is new.
- **The checkout's Vipps refuses to start without the delivery saved.** If the chosen rate cannot
  be saved on the cart, the Vipps or Stripe-link payment does not start and the checkout says
  «Kunne ikke lagre fraktmetoden. Prøv igjen.». This covers a failed save and a rate without a
  supplier. `startVippsPayment(…, { express: false })` also throws before creating anything when
  the address is incomplete or has no usable mobile.

### Fixed
- **«Velg størrelse» no mueve las tallas.** El aviso sale en la misma línea que el nombre de la opción, así que tocar comprar sin talla ya no desplaza los botones bajo el dedo.
- **No checkout and no payment for an empty cart or a total of 0 kr.** `Vio.checkout.open()`
  throws for a cart that totals 0, as it already did for an empty one. Vipps (`startVippsPayment`,
  `startVippsExpress`), the Stripe link, native Stripe and Adyen read the cart from the server and
  refuse to create a checkout or a payment when it is empty or 0 kr. The buttons check the same
  thing first: the cart's «Til kassen» is disabled, the checkout's pay buttons are disabled and
  say «Handlekurven er tom.», and the detail shows no Vipps or Apple Pay button for a product at 0 kr.
- **Desktop: the product detail's pinned buy bar no longer covers the size picker.** The option
  pickers now sit at the top of the buy zone (`part="buy-options"`), so they move with the
  buttons whether the zone is static or sticky.
- **No buttons for payment methods the brand does not have while its methods load.** The
  product detail and the cart drawer show a neutral placeholder (`part="buy-pending"` /
  `.methods-pending`) until `getAvailablePaymentMethods` answers. They used to show every method,
  so a Vipps-only brand flashed Stripe and Klarna. «Legg i handlekurv» and «Til kassen» are there
  from the start. A failed lookup still shows every button, as before.
- **Storage never blocks add to cart or checkout (in-app browsers, private modes).** Every read
  and write of `localStorage`/`sessionStorage` goes through one guard, `src/core/safe-storage.ts`.
  A storage property that throws on access, a `null` storage or a refused write now falls back to
  the page's memory. This covers the cart, the customer session id, the market's
  currency/country/locale and the Klarna return. Before, `typeof localStorage` outside a `try`
  could throw while the SDK started. Without storage, every browser also sent the same customer
  session id, `cs_session_default`. It is now one id per page.

### ⚠️ Upgrade notes
- The detail's buy buttons stay enabled before a size is chosen. Tapping one shows the prompt
  instead of buying. A host that clicks `.add-to-cart` from a script needs a value in every option
  first.
- A host's `vio:checkout-open` handler that calls `Vio.checkout.open()` must still catch the throw
  (it already threw for an empty cart). It now also throws for a cart of 0 kr.
- Host CSS that placed `::part(option-group)` relative to `::part(buy)` should be checked: the
  option groups are now inside `buy`.
- A host that already answers `vio:added-to-cart` with its own UI (for example, opening its cart
  drawer) can turn the new toast off with `<vio-product-detail no-added-toast>`. The toast's
  «Til kassen» relies on the host's `vio:checkout-open` handler, like the cart's does.
- **Backend (shopcart):** the checkout's Vipps payment is now `express: false` with the address
  already on the checkout. shopcart must not request the Vipps profile on these standard
  payments, and must carry the address `phone`/`phone_code` through to the order. Until that is
  deployed, check a QA order to confirm the phone arrives.
- Hosts that pre-fill the checkout form through `Vio.checkout.setAddress()` should include
  `phone`, or the shopper has to type it when paying with Vipps. Other methods do not need it.
- **The cart's Vipps button now opens the checkout through `vio:checkout-open`**, with
  `paymentMethod: 'vipps'`. A host without a handler for that event loses direct Vipps from the
  cart. The `vio:payment-redirect-*` events with `source: 'cart'` are gone; those with
  `'detail'` and `'checkout'` remain.
- **`startVippsPayment(sponsorId, form, { express: false })` writes the full address**, including
  the mobile, to the checkout's shipping and billing address before it creates the payment.
  Without the flag, or with `express: true`, nothing changes.
- `Vio.checkout.open()` throws on a cart that totals 0, as well as on an empty one.
- The «Lagt i handlekurven» toast is on by default. Use `<vio-product-detail no-added-toast>` to
  turn it off.

## 0.30.0 — 2026-10-27

### Added
- **Internal traffic** (ADR-0041): opening any page with **`?vio_internal=1`** marks the browser
  (`localStorage`, `vio.internal.v1`) and `?vio_internal=0` clears it; read once at `Vio.init()`.
  While marked, every analytics event carries **`client.internal: true`** and the collector's
  reads leave it out. **`Vio.analytics.setInternal(boolean)`** / `Vio.analytics.isInternal` for
  hosts; one `console.info` when marked. See
  [README → Internal traffic](README.md#internal-traffic--mark-your-browser-as-a-tester-unreleased).

### Changed
- **Stripe.js (~300 KB) is downloaded only for a brand that uses Stripe.** It used to load on
  every page as soon as the SDK started, to have Apple Pay ready. Now it loads when the brand's
  payment methods come back with a Stripe key (or when the host passes `stripePublishableKey`
  to `Vio.init`). A brand that only takes Vipps never downloads it. Apple Pay still has it before
  the tap: its button waits for the same key.
- **`component_impression` of `<vio-product-carousel>` carries `commerce.items`** — the products
  shown, like its `view_item_list` — so the collector can count per-product impressions
  (ADR-0041). The impression is observed once the products have loaded (the 1 s dwell starts
  then); a failed fetch still counts it, without items. `Vio.analytics.observeImpression()` takes
  a `commerce` getter, read when the impression fires. See
  [README → Impressions carry the products shown](README.md#impressions-carry-the-products-shown-unreleased).
- Events never carry more than 100 `commerce.items` (the collector rejects the whole event above
  its cap).

### ⚠️ Upgrade notes
- `client.internal` needs the collector that knows the field; an older one strips it (the event is
  kept, just not marked). Nothing to do on the host.

## 0.29.0 — 2026-10-24

### Added
- **`vio:cart-updated`** on `document` — `{ sponsorId, cartId, items, itemCount, subtotal, currency, source }`,
  `source: 'server'` when the cart was just read from the server (right before a checkout is
  created or a payment link minted, and when the drawer or the checkout opens), `'storage'` when
  another tab of the site changed it. For hosts that draw their own cart or badge.
  `Vio.cart.refreshFromServer(sponsorId)` asks on demand. See
  [README → What the shopper pays is what the page shows](README.md#what-the-shopper-pays-is-what-the-page-shows--the-cart-the-server-the-other-tabs).
- **`add_payment_info`** (analytics, GA4 name) the moment a backend checkout exists for a payment
  — Vipps from the detail, the cart or the checkout, a Stripe payment link or Element, Klarna,
  Apple Pay, Nexi, Kustom, Qliro, Walley, Adyen — with `commerce.checkout_id`, `payment_method`,
  the cart's lines and the same context as `begin_checkout` (per campaign like it). Once per
  checkout per page load, none when the checkout could not be created, and by beacon BEFORE the
  page leaves for Vipps or a Stripe link. It is how a paid order whose `purchase` never came back
  keeps its session, page and slot (ADR-0039; order 4128, 2026-10-23). The checkout manager
  announces it on `window` as **`vio:checkout-created`** `{ sponsorId, checkoutId, paymentMethod,
  campaignId?, redirect }`. See [README → `add_payment_info`](README.md#add_payment_info--the-checkout-linked-to-this-session-0290).

### Changed
- **«Kjøp nå med Vipps» on the product detail goes straight to Vipps only when the cart is
  empty.** With lines already in the cart, the product is added and the checkout opens first
  (`vio:checkout-open`, Vipps preselected, no `vio:payment-redirect-*` events), every line and
  the total on screen. Before, the tap paid the WHOLE cart with only the Vipps page saying so
  (Mote & Livsstil, 2026-10-23: a jumper left in the cart 13 minutes earlier was paid along
  with the top bought «nå»). The cart's own Vipps button is unchanged: it pays the lines it shows.
- **Apple Pay on the product detail shows what it charges.** The sheet's amount is fixed before
  the tap and was the product's price, while the charge was the sponsor's whole cart. The sheet
  now opens only on an empty cart, prepared for the product × the chosen quantity (it is prepared
  again when the quantity or variant changes); with lines already in the cart — or while the
  sheet for a new quantity is still being prepared — the product is added and the checkout opens
  (`vio:checkout-open` with `paymentMethod: 'apple-pay'`), where Apple Pay charges the total shown.

### Fixed
- **The lines the shopper pays for are the lines the page shows.** The checkout, and the
  Vipps / Stripe page, are built on the backend cart — every line in it — while the drawer
  and the checkout summary drew this tab's memory. Now the SDK reads the server's cart right
  before a checkout is created or a payment link minted, and when `<vio-cart>` / `<vio-checkout>`
  open, and draws that; an open checkout recomputes its lines and total when the cart changes
  under it.
- **Other tabs of the site are heard.** The carts are shared through `localStorage` but each
  tab read them once, at load: a payment in one tab left the others showing — and adding to —
  a cart that was already paid; a line added in one tab was missing from the others until a
  reload. Now a tab adopts what another tab wrote (`storage` event), except for a sponsor it is
  mid-add for.
- **Vipps Express: the checkout no longer adds our shipping to the total.** The delivery is
  chosen and paid inside Vipps, but with Vipps selected the checkout still added the seller's
  first rate (Careless QA, 2026-10-24: «Frakt – Default Shipping» 10 kr, 1 308 kr on screen and
  on the button, 1 298 kr in Vipps). With Vipps as the method and Express on for the seller,
  the summary says «Frakt: Velges i Vipps» and the total and «Betal … med Vipps» are the items.
  Vipps without Express, and every other method, still add the rate as before.
- **The `purchase` of a paid return is sent, not left in the queue** (2026-10-24). Order 4128
  (Careless, prod, 2026-10-23 22:40, after two abandoned trips to Vipps): the shopper
  paid, came back, saw the confirmation, and the brand's panel never counted the sale — Commerce
  had its `order_paid`, the collector no `purchase`. The return was read as paid; the one way the
  code loses that purchase is the queue: it was built, with the order number, into a queue sent
  every 5 s, and leaving the page right away (back to the Vipps app, the home screen) beaconed
  only a purchase still waiting for its number — a phone that discards a hidden tab never runs
  the next tick. Now the purchase is sent as soon as it is built, and when the page hides
  everything still queued leaves by beacon.

### ⚠️ Upgrade notes
- **The collector must accept `add_payment_info`** before it is counted: one that does not know the
  name rejects that event alone (`202` with `rejected`), the rest of the batch is kept. Nothing to
  do in the host.
- A host that handles `vio:checkout-open` only from the cart: the product detail now emits it
  too when «Kjøp nå med Vipps» or Apple Pay is tapped on a non-empty cart (it already did when
  Express was off for the seller), now also with `paymentMethod: 'apple-pay'`. Check that your
  handler opens `<vio-checkout>` for the detail's event.
- A host with its own cart drawer or badge: listen to `vio:cart-updated` (or `Vio.cart`'s
  `change`) — the lines can now change without a tap in that tab.
- One more `GetCart` per checkout creation / payment link and per opening of the drawer or the
  checkout.

## 0.28.0 — 2026-10-22

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
  opens on a tap); under the buy buttons, **«Du handler direkte hos {brand}.»**, with links to the
  brand's «Kjøpsvilkår» and «Angrerett og retur» when its sponsor block carries `termsUrl` /
  `refundPolicyUrl` (https only; `Vio.sponsorIdentity()` returns them too). On desktop the
  description comes before the buy zone, which stays pinned at the bottom of the panel; phones
  keep buy zone, then description.
- The confirmation's brand logo is 40px tall (was max 32px).

### Fixed
- **Phones: the detail, the cart and the checkout close by pulling them down**, from the grab bar
  or the top bar (logo / title and ✕): the sheet follows the finger, and closes when let go far
  enough or with a flick, or springs back. Before, the grab bar only answered a tap — pulling it
  scrolled the sheet. The checkout never closes this way mid-payment.
- **Phones: the page behind stays put while a sheet is open.** A swipe past the end of the
  detail, cart or checkout used to scroll the article underneath. The page is locked while any
  sheet is open and comes back to the same place when the last one closes. Desktop drawers are
  unchanged.
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
- **Hosts that lock the page themselves when a Vio sheet opens** (phones): the SDK does it now —
  `position: fixed` on `<body>` at the current offset, its own inline styles restored and the
  scroll put back on close. Drop yours, or make sure it does not undo the body's styles while a
  sheet is still open.
- One `purchase` per checkout per page load: a second `vio:payment-success` for the same
  checkout adds nothing.
- **«Kjøpsvilkår · Angrerett og retur» need the backend**: the links show only when the
  sponsor block carries `termsUrl` / `refundPolicyUrl`, which the campaigns service sends
  once the brand fills them in (Settings → Brand → Shopper policies). Until then the
  sentence «Du handler direkte hos {brand}.» shows alone. Nothing to do on the host.

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
