/**
 * The brand's promises strip («Rask levering · 2-5 virkedager», «Designet i
 * Norge»…) and its line icons, shared by the product detail (under the buy
 * zone) and the cart (under the ways to pay). Items come from the sponsor
 * block's `highlights` (dashboard Settings → Brand) unless a host passes its own.
 */
import { css, html, nothing } from 'lit'

export interface HighlightItem {
  /** A built-in icon name (HIGHLIGHT_ICONS) or an image URL. */
  icon?: string
  title: string
  text?: string | null
}

/** Line icons in the brand-strip style: 24×24, stroke = the text colour. */
export const HIGHLIGHT_ICONS: Record<string, string> = {
  plane: 'M21.5 2.5 2.5 10l7 3m12-10.5-12 10.5m12-10.5L17 21l-7.5-8m0 0V20l3-4M5 17l-2.5 2.5M7.5 18.5 6 20',
  heart: 'M12 20.5s-8.5-5-8.5-11A4.75 4.75 0 0 1 12 6.75 4.75 4.75 0 0 1 20.5 9.5c0 6-8.5 11-8.5 11Z',
  shirt: 'M8.5 3.5 3 6l1.75 4.25L7 9.5v11h10v-11l2.25.75L21 6l-5.5-2.5a3.5 3.5 0 0 1-7 0Z',
  truck: 'M2.5 5.5h11v10h-11zM13.5 9.5h4l3 3.5v2.5h-7M6.5 18.5a2 2 0 1 0 0-.01M17 18.5a2 2 0 1 0 0-.01',
  return: 'M4 9h11.5a4.5 4.5 0 0 1 0 9H8M4 9l4-4M4 9l4 4',
  leaf: 'M5 19C5 10 10 4.5 20 4.5c0 10-5.5 15-14 15M5 19l7-7',
  star: 'm12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9-4.3-4.1 5.9-.8Z',
  shield: 'M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6Z',
  mailbox: 'M3 19v-8a4 4 0 0 1 8 0v8m-8 0h18v-7a4 4 0 0 0-4-4H7m8 0V4h3M6 12h2',
  home: 'M3 11 12 4l9 7M5.5 9.5V20h13V9.5M10 20v-5h4v5',
  pin: 'M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l3 2',
}

/** The strip: one column per promise, an icon over a title and a line of text. Nothing without items. */
export function renderHighlights(items: ReadonlyArray<HighlightItem> | null | undefined) {
  const list = (Array.isArray(items) ? items : []).filter((h) => h && h.title)
  if (list.length === 0) return nothing
  return html`<ul class="highlights" part="highlights">
    ${list.map((h) => {
      const path = h.icon ? HIGHLIGHT_ICONS[h.icon] : undefined
      const icon = path
        ? html`<svg class="hl-icon" viewBox="0 0 24 24" aria-hidden="true"><path d=${path}></path></svg>`
        : h.icon
          ? html`<img class="hl-icon" src=${h.icon} alt="" />`
          : nothing
      return html`<li class="hl" part="highlight">
        ${icon}
        <span class="hl-title">${h.title}</span>
        ${h.text ? html`<span class="hl-text">${h.text}</span>` : nothing}
      </li>`
    })}
  </ul>`
}

/**
 * The strip's styles. `display` comes from `--vio-<scope>-highlights-display`
 * (theme `detailHighlightsDisplay` / `cartHighlightsDisplay`), so each place can hide it.
 */
export function highlightsStyles(scope: 'detail' | 'cart') {
  const display = scope === 'detail' ? css`var(--vio-detail-highlights-display, grid)` : css`var(--vio-cart-highlights-display, grid)`
  const padding = scope === 'detail' ? css`var(--vio-detail-highlights-padding, 16px 0 2px)` : css`var(--vio-cart-highlights-padding, 14px 0 2px)`
  return css`
    /* Like a shop's trust strip: a thin icon, the promise in regular weight,
       a smaller line under it — nothing bold. */
    .highlights {
      list-style: none;
      margin: 0;
      padding: ${padding};
      display: ${display};
      grid-auto-flow: column;
      grid-auto-columns: 1fr;
      gap: 10px;
      border-top: 1px solid var(--vio-color-border, #e5e5e5);
    }
    .hl { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 2px; min-width: 0; }
    .hl-icon {
      width: var(--vio-detail-highlight-icon-size, 22px);
      height: var(--vio-detail-highlight-icon-size, 22px);
      margin-bottom: 8px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.2;
      stroke-linecap: round;
      stroke-linejoin: round;
      object-fit: contain;
    }
    .hl-title { font-size: 12px; font-weight: 400; line-height: 1.3; letter-spacing: 0.01em; color: var(--vio-color-text, #0a0a0a); }
    .hl-text { font-size: 10.5px; line-height: 1.35; letter-spacing: 0.01em; color: var(--vio-color-text-secondary, #666); }
  `
}
