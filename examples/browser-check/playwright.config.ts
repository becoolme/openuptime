import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // a flaky network blip should not page anyone: one retry, then the run fails
  retries: 1,
  timeout: 60_000,
  // only this reporter: Playwright's own print element HTML on failure, which can include a typed value
  reporter: [["./step-reporter.ts"]],
  use: {
    baseURL: process.env.BASE_URL,
    // Traces record every value typed into the page, the password included, so they stay off.
    // A screenshot of the page that failed is kept instead; it shows no typed password (password fields are masked).
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
