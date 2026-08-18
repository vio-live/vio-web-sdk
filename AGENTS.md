# Agent instructions — Vio Web SDK ecosystem

For AI agents (Claude, Replit's agent, or anyone else) working on Vio's
in-site commerce SDK or one of its integrations. Read this before touching
code — it explains how the pieces fit together, which is easy to get wrong
if you only see one repo.

## The big picture: one engine, three panels

Vio ships the same checkout/cart/payments engine to three different places.
**This repo (`vio-web-sdk`) is the ONLY place business logic lives.** Nobody
downstream re-implements checkout, Apple Pay, Klarna, Vipps, or the cart —
they all consume this package and build their own thin configuration UI on
top of it.

| Surface | What it is | Config UI ("panel") | Repo |
|---|---|---|---|
| **Web SDK** | The engine itself — `Vio.init()`, `<vio-*>` web components, React wrappers, `applyVioTheme()` | None — it's a library, not an app | `vio-web-sdk` (this repo) |
| **Vev** | Page-builder blocks for editorial sites (VG, etc.) | The `Vio Config` block — API key, environment, sponsor, theme colors/fonts | `vio-vev` (vendors this package via a build step, see below) |
| **Replit (Mote & Livsstil)** | A demo/pilot commerce site, `vio-web` repo, built with Replit's AI agent | A settings page inside whatever CMS that agent builds, calling the same functions below | `vio-web` (consumes this package from npm) |

If you're an agent working in `vio-vev` or `vio-web`/Replit: **don't
reimplement checkout, payment verification, cart logic, or theming here.**
Import it from `@vio-live/web-sdk` and build only the configuration UI native
to your platform.

## The two functions every panel needs

```ts
import { Vio } from '@vio-live/web-sdk'
import { applyVioTheme } from '@vio-live/web-sdk/ui' // or '/react'

Vio.init({ apiKey: '…', environment: 'production' }) // 'development' | 'testing' | 'production'
applyVioTheme({ colorAccent: '#0044ff', fontSerif: 'Georgia, serif' })
```

Full API, all options, and the theming token list: see `README.md`. Don't
guess at config shape or CSS variable names — they're documented there and
change over time (e.g. `environment` replaced manually passing `apiBase`/
`graphQLBase`; check the README for the current pattern before writing new
integration code).

## Where things actually live

- **This repo (`vio-web-sdk`)** — `src/core/` (headless: cart, checkout,
  payments, GraphQL) + `src/ui/` (Lit web components + design tokens) +
  `src/react/` (React wrappers). Published to npm as `@vio-live/web-sdk`.
  See `CONTRIBUTING.md` for the dev/build/publish workflow.
- **`vio-vev`** — vendors this repo's `src/` into a single bundle
  (`vio-sdk/index.js`, regenerated via `esbuild`, NEVER hand-edited — see
  `vio-vev/README.md`) and wraps it in Vev-specific components
  (`src/components/vio-config.tsx` etc.) that register as page-builder
  blocks. The `Vio Config` block's job is exactly: collect the two calls
  above from a visual panel and call them.
- **`vio-web`** (Mote & Livsstil / Replit) — installs `@vio-live/web-sdk`
  from npm directly (`package.json`), same engine, same two calls, its own
  UI for collecting the values.

## Critical operational rules (read before touching a shared resource)

1. **Branch protection is on** for `vio-web-sdk` and `vio-vev` — no direct
   push to `main`, PR required (self-merge is fine, no approval needed).
   Full workflow in `CONTRIBUTING.md`.
2. **Never hand-edit `vio-vev/vio-sdk/index.js`** — it's a generated
   artifact. Edit `vio-web-sdk/src`, then rebundle (`CONTRIBUTING.md` has
   the exact command).
3. **`npm publish` is a separate step from everything else** — merging to
   `vio-web-sdk main` does NOT update the npm package by itself, and
   `vev deploy` doesn't touch npm either. It sat frozen for 2 months once
   because nobody remembered this. See `CONTRIBUTING.md` → "Publishing to
   npm".
4. **`vev deploy` has no staging and no lock** — the live Vev package
   (`cq1lXld-TA9`) is a single shared slot; the last deploy wins,
   unconditionally, no matter who runs it. This has caused real collisions
   (a collaborator's uncommitted work got overwritten more than once).
   Before deploying anything experimental, use a personal sandbox package
   instead (`vio-vev/README.md` → "Personal sandbox package") — never
   deploy work-in-progress straight to the shared package. Before any real
   deploy to the shared package, check the deploy-version timeline for
   recent activity with no matching git commit — if you find any, stop and
   ask before overwriting it.
