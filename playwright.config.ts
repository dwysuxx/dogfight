import { defineConfig, devices } from "@playwright/test";

const PORT = 3210;

// The real thing: production build served by the real server; two browser
// contexts play against each other through it.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && node server/src/index.ts",
    url: `http://127.0.0.1:${PORT}/health`,
    env: { PORT: String(PORT), HOST: "127.0.0.1" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
