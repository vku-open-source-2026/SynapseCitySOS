// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    setupFiles: ['./e2e/setup.ts'],
    // Work-surface specs (dashboard/auth/emergency) describe the retired
    // command centre and now redirect to SynapseDX. Keep the live public map
    // and navigation surface in the browser gate.
    include: [
      'e2e/map.spec.ts',
      'e2e/navigation.spec.ts',
    ],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      // https://vitest.dev/config/browser/playwright
      instances: [
        { browser: 'chromium' },
      ],
    },
  },
})
