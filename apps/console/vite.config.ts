// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    TanStackRouterVite(),
    react()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    allowedHosts: true,
    // Local development talks to the SOS service, not to the Vite SPA
    // fallback. A missing service yields a proxy error instead of 200 HTML,
    // so the hazard map and command centre can show their error state.
    proxy: {
      '/v1': {
        target: process.env.VITE_DEV_API_PROXY || 'http://localhost:8084',
        changeOrigin: true,
      },
    },
  },
  preview: {
    allowedHosts: true,
  }
})