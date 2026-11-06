import { defineConfig } from "@playwright/test";

const stack = process.env.HL_E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: stack ?? "http://127.0.0.1:3010",
    trace: "retain-on-failure",
  },
  webServer: stack
    ? undefined
    : {
        command:
          "corepack pnpm --filter @harnesslab/web start --hostname 127.0.0.1 --port 3010",
        url: "http://127.0.0.1:3010",
      },
});
