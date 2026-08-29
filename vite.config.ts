import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves a project site from https://<user>.github.io/tradex/,
// not from the domain root — every asset/manifest/service-worker path needs
// that prefix in production, but dev/preview still runs at the server root.
const BASE = '/tradex/'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? BASE : '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      // Serve the manifest + a working service worker under `npm run dev`
      // too, not just the production build — makes installability testable
      // without a separate preview server.
      devOptions: { enabled: true },
      manifest: {
        name: 'TradeX — Trade Tracker',
        short_name: 'TradeX',
        description: 'Cost basis / breakeven tracker for covered calls, diagonals, and other options income strategies.',
        theme_color: '#0f1420',
        background_color: '#0f1420',
        display: 'standalone',
        orientation: 'any',
        // Left unset deliberately — vite-plugin-pwa derives start_url/scope
        // from the `base` above, so these stay correct in both dev (`/`) and
        // the GitHub Pages build (`/tradex/`) without duplicating the value.
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Everything this app needs is static (no backend calls) — precache
        // the whole built app shell so it works fully offline once installed.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
      },
    }),
  ],
  server: {
    port: 5174,
    strictPort: true,
  },
}))
