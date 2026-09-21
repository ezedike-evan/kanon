import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    globals: true,
    // The forks pool fails to load envio (ansi-styles interop under vite-node in
    // this hoisted install); threads loads it fine.
    pool: "threads",
    testTimeout: 30_000,
  },
});
