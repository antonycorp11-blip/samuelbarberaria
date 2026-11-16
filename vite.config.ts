import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'Samuel Barber Shop',
        short_name: 'Samuel',
        description: 'Gestão da barbearia: agenda, caixa, equipe e clientes.',
        lang: 'pt-BR',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/push\//],
        globPatterns: ['**/*.{js,css,html,webp,woff2}', 'icon-192.png', 'apple-touch-icon.png'],
        globIgnores: ['push/**'],
      },
    }),
  ],
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 60000, hookTimeout: 60000 },
})
