import { defineConfig, devices } from '@playwright/test';

// Server URL - can be overridden with SERVER_URL env var for remote testing
const serverUrl = process.env.SERVER_URL || 'http://127.0.0.1:8080';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60000,

  use: {
    baseURL: serverUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },

  projects: [
    // Default project for CI/desktop environments
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
      },
    },
    // Firefox option
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        headless: true,
      },
    },
  ],

  // Only start webServer when not using remote server
  ...(process.env.SERVER_URL ? {} : {
    webServer: {
      command: 'cd .. && cargo run',
      url: 'http://127.0.0.1:8080',
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
  }),
});
