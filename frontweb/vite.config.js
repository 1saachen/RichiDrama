import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

const loopbackPeers = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const audioGenerationPath = /^\/api\/v1\/tools\/audio-generation(?:[/?]|$)/i

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    // Preserve the browser targets used before the Vite 8 upgrade.
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14']
  },
  server: {
    host: '0.0.0.0',
    port: 3013,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5679',
        changeOrigin: false,
        ws: true,
        bypass(req) {
          // The backend sees Vite's socket, so gate this route's actual client here.
          if (audioGenerationPath.test(req.url || '') && !loopbackPeers.has(req.socket.remoteAddress)) return false
        },
        proxyTimeout: 600000,
        timeout: 600000
      },
      '/static': {
        target: 'http://127.0.0.1:5679',
        changeOrigin: true
      }
    }
  }
})
