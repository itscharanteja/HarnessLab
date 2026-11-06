import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: "http://127.0.0.1:3010" },
  webServer: {
    command:
      "corepack pnpm --filter @harnesslab/web start --hostname 127.0.0.1 --port 3010",
    url: "http://127.0.0.1:3010",
  },
});
