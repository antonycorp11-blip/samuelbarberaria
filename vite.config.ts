import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // Versão do app mostrada em Ajustes: data e hora da publicação, em Cuiabá.
  define: { __APP_VERSION__: JSON.stringify(new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')) },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // O registro fica em src/integrations/update.ts: procura versão nova a cada minuto e só recarrega fora de uma venda.
      injectRegister: false,
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
        // A versão nova assume assim que é baixada, sem esperar todos os apps abertos fecharem.
        skipWaiting: true,
        clientsClaim: true,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/push\//],
        globPatterns: ['**/*.{js,css,html,webp,woff2}', 'icon-192.png', 'apple-touch-icon.png'],
        globIgnores: ['push/**'],
      },
    }),
  ],
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 60000, hookTimeout: 60000 },
})
