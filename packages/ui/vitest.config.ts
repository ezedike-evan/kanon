import { defineConfig } from 'vitest/config';

// `lib/` is tested without a DOM: the mapping is pure, and the data layer's render behaviour is
// counted through a headless React renderer (`src/lib/render-harness.ts`). Screens themselves are
// rendered through react-native-web in the browser.
export default defineConfig({
  // The data layer has one `.tsx` file (the provider); plain React JSX, not NativeWind's runtime.
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: { globals: true, include: ['src/lib/**/*.test.ts'] },
});
