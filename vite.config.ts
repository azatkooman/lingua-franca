import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// The Electron main process serves the API and the Socket.IO endpoint. In development the
// renderer is served by Vite instead, so both have to be proxied through to it -- without
// this, every relative /api call lands on Vite's SPA fallback and comes back as HTML.
// The plain-HTTP listener on 4174 is bound to loopback and needs no certificate exemption.
const backend = 'http://127.0.0.1:4174'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl()],
  // Absolute, not './': relative asset URLs resolve against the current route, so any nested
  // path under BrowserRouter would look for its bundle in the wrong directory.
  base: '/',
  build: {
    rollupOptions: {
      output: {
        // The media and QR libraries are large and change rarely; splitting them keeps the
        // app chunk small enough to parse quickly on an older phone.
        manualChunks: {
          mediasoup: ['mediasoup-client'],
          realtime: ['socket.io-client'],
          qr: ['qrcode.react'],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/socket.io': { target: backend, changeOrigin: true, ws: true },
    },
  },
})
