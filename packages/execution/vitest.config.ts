import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The Ed25519 proof-of-possession test takes ~0.7s alone but exceeds vitest's
  // 5s default when every workspace suite runs at once.
  test: { globals: true, include: ['src/**/*.test.ts'], testTimeout: 20_000 },
});
