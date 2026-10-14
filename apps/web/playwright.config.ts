import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration for Songhealth web application.
 *
 * Requirements:
 * - testDir: './tests/e2e'
 * - Project: Chromium only
 * - Explicit E2E base URL via E2E_BASE_URL (no silent production default)
 * - Deterministic single-worker execution for stateful authentication flows
 * - Dedicated failure diagnostics output directory
 * - Minimal reporter suitable for containerized and CLI execution
 */
const baseURL = process.env.E2E_BASE_URL || undefined;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: './test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
