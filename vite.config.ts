import { defineConfig } from 'vite'

/**
 * Vite config.
 *
 * `npm run dev`   — serves the demo at `examples/index.html`. Imports
 *                   resolve to `../src/...` so live SDK edits HMR.
 *
 * Dev proxy — `/proxy-vio` and `/proxy-graphql` route to the dev backend
 * to bypass CORS during local development. Set the env vars
 *   VITE_VIO_API_BASE=/proxy-vio
 *   VITE_VIO_GRAPHQL_BASE=/proxy-graphql
 * in `.env.local` to enable. Without those, the SDK hits the real
 * `https://*.vio.live` endpoints directly (works if the backend has
 * permissive CORS for your origin).
 *
 * `npm run build` — TBD: library mode config will land when we publish.
 */
export default defineConfig({
  root: 'examples',
  envDir: '..',
  server: {
    port: 5173,
    open: true,
    host: '127.0.0.1',
    proxy: {
      '/proxy-vio': {
        target: 'https://api-dev.vio.live',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/proxy-vio/, ''),
      },
      '/proxy-graphql': {
        target: 'https://graph-ql-dev.vio.live',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/proxy-graphql/, ''),
      },
    },
  },
  resolve: {
    preserveSymlinks: false,
  },
})
