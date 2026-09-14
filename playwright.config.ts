import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e", fullyParallel: true, workers: 2, timeout: 30_000,
  use: { headless: true, viewport: { width: 1440, height: 960 }, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
