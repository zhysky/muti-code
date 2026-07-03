import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"]
  },
  resolve: {
    alias: {
      "@agent-gateway/core": `${root}packages/core/src/index.ts`,
      "@agent-gateway/db": `${root}packages/db/src/index.ts`,
      "@agent-gateway/drivers": `${root}packages/drivers/src/index.ts`,
      "@agent-gateway/im": `${root}packages/im/src/index.ts`,
      "@agent-gateway/security": `${root}packages/security/src/index.ts`,
      "@agent-gateway/observability": `${root}packages/observability/src/index.ts`
    }
  }
});
