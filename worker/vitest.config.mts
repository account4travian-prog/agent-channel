import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/wrangler.test.toml" },
    }),
  ],
  test: {
    // node:test handles worker/test/logic.test.js + office-logic.test.js; vitest runs the rest
    include: ["test/channel.test.js", "test/office.test.js", "test/office-batch.test.js"],
  },
});
