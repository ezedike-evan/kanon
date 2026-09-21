import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain ESM build script, no types.
import { buildRuntimeFile, outFile } from '../../scripts/build-chart-runtime.mjs';

describe('native chart bundle', () => {
  it('is regenerated after every runtime change', async () => {
    const fresh: string = await buildRuntimeFile();
    const current = readFileSync(outFile as string, 'utf8');
    // If this fails: pnpm --filter @kanon/ui build:chart
    expect(current === fresh).toBe(true);
  }, 30_000);

  it('is a self-contained script the WebView can run with no network', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../components/chart/runtime-bundle.generated.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('__kanonChart');
    expect(src).not.toMatch(/https?:\/\/cdn\./);
  });
});
