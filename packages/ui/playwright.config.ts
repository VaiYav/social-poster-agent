import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for @spa/ui system tests (STC-036..041).
 *
 * The UI is a Vue 3.5 SPA served by Vite on port 3101. Tests mock all backend
 * API responses via `page.route()` so no running backend is required.
 *
 * All three browser engines are configured (GAP-005 fixed):
 * Chromium, Firefox, and WebKit (Safari). Browsers installed via
 * `npx playwright install chromium firefox webkit`.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 0 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: "http://localhost:3101",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],

  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3101",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
