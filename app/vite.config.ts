import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// API origin for dev proxy. In prod, app + API are same-origin behind Caddy.
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Custom service worker (we need push + notificationclick handlers that
      // Workbox's generateSW can't express) — inject the precache manifest into
      // our own src/sw.ts.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: null, // we register the SW ourselves in main.tsx
      devOptions: { enabled: true, type: 'module' },
      manifest: {
        name: 'Den',
        short_name: 'Den',
        description: 'Private chat + media for a closed circle',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0b0b0f',
        theme_color: '#0b0b0f',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // docs/EMBEDS.md §4.4 — Android Web Share Target: the IG share sheet
        // (or any app sharing a URL/text) can target Den directly. GET-only,
        // no file payload, so no service-worker route is needed — it's a
        // plain navigation to `/share-target?...` that App.tsx picks up on
        // mount. ⚠️ iOS PWAs cannot register as share targets at all (Apple
        // limitation, not fixable here) — copy-paste into the composer
        // (already wired via the paste-detect chip) is the load-bearing path
        // for iPhone users. Flag for the real-device checklist.
        share_target: {
          action: '/share-target',
          method: 'GET',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
          },
        },
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // Same-origin API + WS in prod; proxy in dev so cookies/WS Just Work.
      '/api': { target: API_TARGET, changeOrigin: true },
      '/health': { target: API_TARGET, changeOrigin: true },
      '/socket.io': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
  preview: {
    port: 4300,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/health': { target: API_TARGET, changeOrigin: true },
      '/socket.io': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
});
