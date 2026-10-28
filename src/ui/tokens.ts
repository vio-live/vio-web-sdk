/**
 * Vio Design Tokens — editorial commerce aesthetic.
 *
 * Extracted from the Allermedia "Mote & Livsstil" reference (the target
 * pilot site). Mood: Vogue-like fashion magazine — serif headlines,
 * sans-serif body, near-monochrome palette, terracotta accent for
 * editorial labels ("REDAKSJONENS FAVORITTER").
 *
 * Tokens are exposed both as a typed TS object (`VioTokens`) and as
 * CSS custom properties on `:root` (auto-injected when this module is
 * imported in a browser). Consumers can override individual variables
 * to re-skin without touching SDK source.
 */

export const VioTokens = {
  color: {
    text: {
      primary: '#0a0a0a',
      secondary: '#666666',
      tertiary: '#999999',
      onPrimary: '#ffffff',
    },
    accent: {
      editorial: '#c14a3b', // "REDAKSJONENS FAVORITTER" red
    },
    surface: {
      base: '#ffffff',
      muted: '#f2f2f2', // product image background
      hover: '#fafafa',
    },
    border: {
      subtle: '#e5e5e5',
      default: '#cccccc',
    },
  },
  font: {
    serif: '"Tinos", "Playfair Display", Georgia, serif',
    sans: '"Inter", -apple-system, "Helvetica Neue", Arial, sans-serif',
  },
  size: {
    xs: '12px',
    sm: '14px',
    md: '16px',
    lg: '20px',
    xl: '24px',
    '2xl': '32px',
    '3xl': '40px',
  },
  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  tracking: {
    label: '0.1em', // uppercase labels (BRAND, RETAILER, REDAKSJONENS FAVORITTER)
    title: '0',
  },
  lineHeight: {
    tight: 1.1,
    snug: 1.3,
    normal: 1.5,
  },
  space: {
    xs: '4px',
    sm: '8px',
    md: '16px',
    lg: '24px',
    xl: '32px',
    '2xl': '48px',
    '3xl': '64px',
  },
  radius: {
    none: '0',
    sm: '2px',
    md: '4px',
    lg: '8px',
    /** Sheet/drawer corners — the largest surface radius in the checkout. */
    xl: '16px',
    full: '9999px',
  },
} as const

/**
 * CSS Custom Properties — generated from VioTokens. Injected once into
 * the document head on first import. Consumers can override any
 * `--vio-*` var on their root or component selector to customise.
 */
const VIO_TOKENS_CSS = `
  :root {
    /* color — text */
    --vio-color-text:           ${VioTokens.color.text.primary};
    --vio-color-text-secondary: ${VioTokens.color.text.secondary};
    --vio-color-text-tertiary:  ${VioTokens.color.text.tertiary};
    --vio-color-text-on-primary:${VioTokens.color.text.onPrimary};

    /* color — accent */
    --vio-color-accent: ${VioTokens.color.accent.editorial};

    /* color — surface */
    --vio-color-surface:       ${VioTokens.color.surface.base};
    --vio-color-surface-muted: ${VioTokens.color.surface.muted};
    --vio-color-surface-hover: ${VioTokens.color.surface.hover};

    /* color — border */
    --vio-color-border:         ${VioTokens.color.border.subtle};
    --vio-color-border-default: ${VioTokens.color.border.default};

    /* font */
    --vio-font-serif: ${VioTokens.font.serif};
    --vio-font-sans:  ${VioTokens.font.sans};

    /* size */
    --vio-size-xs: ${VioTokens.size.xs};
    --vio-size-sm: ${VioTokens.size.sm};
    --vio-size-md: ${VioTokens.size.md};
    --vio-size-lg: ${VioTokens.size.lg};
    --vio-size-xl: ${VioTokens.size.xl};

    /* tracking (uppercase letterspacing) */
    --vio-tracking-label: ${VioTokens.tracking.label};

    /* space */
    --vio-space-xs: ${VioTokens.space.xs};
    --vio-space-sm: ${VioTokens.space.sm};
    --vio-space-md: ${VioTokens.space.md};
    --vio-space-lg: ${VioTokens.space.lg};
    --vio-space-xl: ${VioTokens.space.xl};

    /* radius */
    --vio-radius-sm: ${VioTokens.radius.sm};
    --vio-radius-md: ${VioTokens.radius.md};
    --vio-radius-lg: ${VioTokens.radius.lg};
    --vio-radius-xl: ${VioTokens.radius.xl};
  }
`

function injectTokens(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-vio="tokens"]') !== null) return
  const style = document.createElement('style')
  style.setAttribute('data-vio', 'tokens')
  style.textContent = VIO_TOKENS_CSS
  document.head.appendChild(style)
}

injectTokens()

/**
 * Theming — override design tokens without touching SDK source.
 *
 * Every `<vio-*>` component reads colors/fonts via `var(--vio-color-accent,
 * …)` etc. (shadow DOM inherits CSS custom properties from the light DOM,
 * so this reaches every component including Apple Pay/Klarna/Vipps panels).
 * `applyVioTheme` is the one supported way to set them: an inline style on
 * `:root` (or a scoped element) always wins over the stylesheet rule
 * `injectTokens` installs above, regardless of import/injection order — no
 * specificity fights, no reaching for `!important`.
 *
 * A curated subset on purpose — colors, fonts, corner radius and the spacing
 * steps the checkout actually uses. Radius and spacing were added once the
 * need was real (brand panels in Vev/Replit): corner shape is the strongest
 * identity lever after colour, and the spacing steps drive comfortable-vs-
 * compact density. The rest of the token set (sizes, tracking, line heights)
 * stays internal — don't speculatively surface it as public API.
 *
 * Panels are expected to present these as a few opinionated choices (e.g.
 * "Sharp / Default / Rounded") rather than four raw pixel inputs; the API
 * stays per-token so a panel can compose whatever presets it wants.
 *
 * Host integrations (the Vio Config panel in Vev, a future Replit CMS
 * panel, anything else) should call this ONE function — never set
 * `--vio-*` custom properties by hand. If the injection mechanism changes
 * later, only this function needs updating, not every panel that theme.
 */
export interface VioThemeOverrides {
  colorText?: string
  colorTextSecondary?: string
  colorTextTertiary?: string
  colorTextOnPrimary?: string
  colorAccent?: string
  colorSurface?: string
  colorSurfaceMuted?: string
  colorSurfaceHover?: string
  colorBorder?: string
  colorBorderDefault?: string
  fontSerif?: string
  fontSans?: string
  /** Corner radius. `sm` = drag handles, `lg` = controls (chips, notices,
   *  shipping options), `xl` = the sheet/drawer itself. Set all three to `0`
   *  for a square look, or raise `xl` for a softer one. */
  radiusSm?: string
  radiusMd?: string
  radiusLg?: string
  radiusXl?: string
  /** Spacing steps — drive checkout density (compact vs comfortable). */
  spaceSm?: string
  spaceMd?: string
  spaceLg?: string
  spaceXl?: string
  /* Product detail, cart, checkout, confirmation and the hand-over to a
   * payment page (0.28) — layout knobs a host needs to fit its own design.
   * Every one is a `--vio-*` custom property too (README → Styling). */
  /** Product detail panel width on desktop (default `440px`). */
  detailWidth?: string
  /** Side padding of the detail (default the `lg` space, `24px`). */
  detailPaddingX?: string
  /** Height of the selling brand's logo in the detail's top bar (default `44px`; width follows its proportions). A square logo gets the brand's name beside it. */
  detailLogoHeight?: string
  /** Zoom on that logo inside its box (default `1`); e.g. `1.8` crops the white around a mark in a square file. */
  detailLogoZoom?: string
  /** Product name size in the detail. */
  detailTitleSize?: string
  /** Price size in the detail (default `24px`). */
  detailPriceSize?: string
  /** How the main image fits its box: `cover` (fills it, crops the overflow — default) or `contain` (whole image, bars where the shapes differ). */
  detailImageFit?: string
  /** Main image box proportion, the same for every image so the panel never jumps: `4 / 5` (default), `1 / 1`, `3 / 4`, or `auto` (each image its own). */
  detailImageAspect?: string
  /** Cap on the main image's height (default `85vh`). */
  detailImageMaxHeight?: string
  /** Zoom on the main image (default `1`); e.g. `1.15` to crop a white margin baked into the file. */
  detailImageZoom?: string
  /** Side margin of the main image (default: the panel's padding, aligned with the text); `0` = edge to edge. */
  detailImageInset?: string
  /** Background behind the main image (default the muted surface). */
  detailImageBg?: string
  /** `thumbs` (default: one image, thumbnails under it) or `carousel` (every image in one swipeable row with a dot per photo, no thumbnails — less height). An element's `gallery` attribute wins over it. */
  detailGallery?: string
  /** In the carousel, how much of the next photo shows at the edge (default `0px`), e.g. `32px`. */
  detailCarouselPeek?: string
  /** «Beskrivelse»: `preview` (default — first lines + «Les mer»), `folded` (heading only until a tap) or `open`. An element's `description-mode` wins. */
  detailDescriptionMode?: string
  /** Lines the «Beskrivelse» preview shows (default `3`). */
  detailDescriptionPreviewLines?: string
  /** The brand's promises under the buy zone: `grid` (default, shown when the brand has some) or `none` (hidden). */
  detailHighlightsDisplay?: string
  /** «Frakt & retur» in the detail: `block` (default) or `none` (hidden). */
  detailShippingReturnsDisplay?: string
  /** `<vio-product-carousel>`: `carousel` (default, one row) or `list` (cards one under the other). Its `layout` attribute wins. */
  carouselLayout?: string
  /** Thumbnail size (default `64px`). One row, scrolls sideways. */
  detailThumbSize?: string
  /** Space between thumbnails (default `8px`). */
  detailThumbGap?: string
  /** Thumbnail corners (default `0`). */
  detailThumbRadius?: string
  /** Border of the selected thumbnail (default the text colour). */
  detailThumbActiveColor?: string
  /** Height (and min width) of a size / option button (default `36px`). */
  detailOptionHeight?: string
  /** Space between option buttons (default `6px`). */
  detailOptionGap?: string
  /** Option button corners (default `0`). */
  detailOptionRadius?: string
  /** `wrap` (default, several lines) or `nowrap` (one line that scrolls). */
  detailOptionWrap?: string
  /** Height of the quantity stepper and «Legg i handlekurv» (default `52px`). */
  detailButtonHeight?: string
  /** Corners of «Legg i handlekurv» (default `0`). */
  detailButtonRadius?: string
  /** `sticky` or `static`: whether the buy zone (Vipps, quantity, add to cart) stays at the bottom of the panel while scrolling. Default: `static` on phones, `sticky` on desktop (with the description above it). */
  detailBuyPosition?: string
  /** Shadow over a sticky buy zone, e.g. `0 -8px 16px rgba(0,0,0,.06)`. */
  detailBuyShadow?: string
  /* Product cards (<vio-product>, the carousel's and the list's) — 0.32. Each
   * defaults to the card's look before 0.32; see README → Styling for the rest
   * of the --vio-card-* properties. */
  /** Font of the card (default the SDK's sans). */
  cardFont?: string
  /** Frame around the card, e.g. `1px solid rgba(230,230,230,.6)` (default none). */
  cardBorder?: string
  /** Image box proportion (default `1 / 1`), e.g. `3 / 4`. */
  cardImageAspect?: string
  /** `cover` (default, fills and crops) or `contain` (whole image). */
  cardImageFit?: string
  /** Background behind the card image (default the muted surface). */
  cardImageBg?: string
  /** Space around the image inside its box (default `0`). */
  cardImagePadding?: string
  /** Padding of the text under the image (default `14px 0 0`), e.g. `16px` in a framed card. */
  cardMetaPadding?: string
  /** Font of the price (default the card's), e.g. a serif. */
  cardPriceFont?: string
  /** Colour of the `bar` buy button (default the text colour). */
  cardAccent?: string
  /** Corners of the `bar` buy button (default `6px`). */
  cardBarRadius?: string
  /** Lines of the description a card shows (default `4`). */
  cardDescriptionLines?: string
  /** `-1` lifts the seller line above the name (where a brand line goes); default `0` (at the bottom). */
  cardRetailerOrder?: string
  /** Cart drawer width on desktop (default `440px`). */
  cartWidth?: string
  /** Checkout panel width on desktop (default `440px`). */
  checkoutWidth?: string
  /** Height of the brand's logo on the confirmation (default `40px`). */
  confirmLogoHeight?: string
  /** «Takk for bestillingen!» size (default `24px`). */
  confirmTitleSize?: string
  /** Background of the confirmation's check mark (default green). */
  confirmCheckBg?: string
  /** Background of the «Åpner Vipps …» overlay (default translucent white). */
  redirectBg?: string
  /** Spinner colour of that overlay (default Vipps orange). */
  redirectSpinner?: string
}

const THEME_KEY_TO_CSS_VAR: Record<keyof VioThemeOverrides, string> = {
  colorText: '--vio-color-text',
  colorTextSecondary: '--vio-color-text-secondary',
  colorTextTertiary: '--vio-color-text-tertiary',
  colorTextOnPrimary: '--vio-color-text-on-primary',
  colorAccent: '--vio-color-accent',
  colorSurface: '--vio-color-surface',
  colorSurfaceMuted: '--vio-color-surface-muted',
  colorSurfaceHover: '--vio-color-surface-hover',
  colorBorder: '--vio-color-border',
  colorBorderDefault: '--vio-color-border-default',
  fontSerif: '--vio-font-serif',
  fontSans: '--vio-font-sans',
  radiusSm: '--vio-radius-sm',
  radiusMd: '--vio-radius-md',
  radiusLg: '--vio-radius-lg',
  radiusXl: '--vio-radius-xl',
  spaceSm: '--vio-space-sm',
  spaceMd: '--vio-space-md',
  spaceLg: '--vio-space-lg',
  spaceXl: '--vio-space-xl',
  detailWidth: '--vio-detail-width',
  detailPaddingX: '--vio-detail-padding-x',
  detailLogoHeight: '--vio-detail-logo-height',
  detailLogoZoom: '--vio-detail-logo-zoom',
  detailTitleSize: '--vio-detail-title-size',
  detailPriceSize: '--vio-detail-price-size',
  detailImageFit: '--vio-detail-image-fit',
  detailImageAspect: '--vio-detail-image-aspect',
  detailImageMaxHeight: '--vio-detail-image-max-height',
  detailImageZoom: '--vio-detail-image-zoom',
  detailImageInset: '--vio-detail-image-inset',
  detailImageBg: '--vio-detail-image-bg',
  detailGallery: '--vio-detail-gallery',
  carouselLayout: '--vio-carousel-layout',
  detailCarouselPeek: '--vio-detail-carousel-peek',
  detailDescriptionMode: '--vio-detail-description-mode',
  detailDescriptionPreviewLines: '--vio-detail-description-preview-lines',
  detailHighlightsDisplay: '--vio-detail-highlights-display',
  detailShippingReturnsDisplay: '--vio-detail-shipping-returns-display',
  detailThumbSize: '--vio-detail-thumb-size',
  detailThumbGap: '--vio-detail-thumb-gap',
  detailThumbRadius: '--vio-detail-thumb-radius',
  detailThumbActiveColor: '--vio-detail-thumb-active-color',
  detailOptionHeight: '--vio-detail-option-height',
  detailOptionGap: '--vio-detail-option-gap',
  detailOptionRadius: '--vio-detail-option-radius',
  detailOptionWrap: '--vio-detail-option-wrap',
  detailButtonHeight: '--vio-detail-button-height',
  detailButtonRadius: '--vio-detail-button-radius',
  detailBuyPosition: '--vio-detail-buy-position',
  detailBuyShadow: '--vio-detail-buy-shadow',
  cardFont: '--vio-card-font',
  cardBorder: '--vio-card-border',
  cardImageAspect: '--vio-card-image-aspect',
  cardImageFit: '--vio-card-image-fit',
  cardImageBg: '--vio-card-image-bg',
  cardImagePadding: '--vio-card-image-padding',
  cardMetaPadding: '--vio-card-meta-padding',
  cardPriceFont: '--vio-card-price-font',
  cardAccent: '--vio-card-accent',
  cardBarRadius: '--vio-card-bar-radius',
  cardDescriptionLines: '--vio-card-description-lines',
  cardRetailerOrder: '--vio-card-retailer-order',
  cartWidth: '--vio-cart-width',
  checkoutWidth: '--vio-checkout-width',
  confirmLogoHeight: '--vio-confirm-logo-height',
  confirmTitleSize: '--vio-confirm-title-size',
  confirmCheckBg: '--vio-confirm-check-bg',
  redirectBg: '--vio-redirect-bg',
  redirectSpinner: '--vio-redirect-spinner',
}

/**
 * Apply (or clear) theme overrides. Pass `null`/`undefined` for a key to
 * revert it to the SDK default instead of leaving a stale override behind
 * — lets a host re-apply a full overrides object on every save without
 * having to track which keys it previously set.
 *
 * `target` defaults to `document.documentElement` (`:root`, matching where
 * `injectTokens` installs the defaults). Pass a specific element to scope
 * the theme to one subtree instead of the whole page — e.g. multiple
 * differently-branded sponsors on the same page.
 */
export function applyVioTheme(
  overrides: VioThemeOverrides,
  target: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
): void {
  if (!target) return
  for (const key of Object.keys(THEME_KEY_TO_CSS_VAR) as Array<keyof VioThemeOverrides>) {
    const cssVar = THEME_KEY_TO_CSS_VAR[key]
    const value = overrides[key]
    if (value) {
      target.style.setProperty(cssVar, value)
    } else if (key in overrides) {
      target.style.removeProperty(cssVar)
    }
  }
}
