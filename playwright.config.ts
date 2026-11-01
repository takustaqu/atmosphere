import { defineConfig } from '@playwright/test';

// What only a real browser can say: that what is asked of the API reaches the
// canvas. `pnpm test:e2e`, with the Chrome installed on this machine, whose GPU
// is the one these skies are drawn on. (Not in the Pages workflow, whose runner
// has neither.)
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    channel: 'chrome',
    launchOptions: { args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'] },
  },
});
