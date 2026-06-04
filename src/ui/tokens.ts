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
