import { defineConfig } from '@playwright/test'

// End-to-end smoke configuration.
//
// The smoke drives the REAL app in a browser to guard against the catastrophic
// "it doesn't even load / a core surface white-screens" class of regression — the
// one thing the unit suite (pure src/lib logic) can't catch.
//
// It runs against an ALREADY-RUNNING stack (this config starts no servers):
//   • CI: the `image` job's docker-compose container, served same-origin on :8000.
//   • Local: `pnpm dev` (:5188) proxying /api to a running backend (:8000).
// Point it at the stack with E2E_BASE_URL.
//
// Browser: in CI we `playwright install chromium`. In the preconfigured web
// environment the browser is already on disk — run with
//   PW_EXECUTABLE_PATH=/opt/pw-browsers/chromium
// to use it instead of downloading.
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:8000'
const executablePath = process.env.PW_EXECUTABLE_PATH || undefined

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // tablet-first app — a roomy landscape viewport mirrors the field device
    viewport: { width: 1280, height: 900 },
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: 'chromium' }],
})
