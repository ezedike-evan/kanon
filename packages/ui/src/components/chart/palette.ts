import { useMemo } from 'react';
import { useTheme, type ThemeColors } from '../../theme';
import type { ChartPalette } from '../../lib/chart-protocol';

/**
 * Every colour the chart runtime draws with, resolved from the active theme.
 *
 * The runtime cannot use Tailwind classes (it paints canvas), so the host
 * resolves token names to values here and sends them across the bridge. A
 * theme change is a `theme` command, not a new chart.
 *
 * Direction colours are the market's: `long` up, `short` down. User drawings
 * are `bone`, neutral on purpose: `signal` is reserved for the pinned rule and
 * the structure drawn from it, so an amber line on the chart always means the
 * rule.
 */
export function paletteFromColors(c: ThemeColors): ChartPalette {
  return {
    background: c.panel,
    text: c.ash,
    textStrong: c.bone,
    grid: c.hairline,
    border: c.hairline,
    up: c.long,
    down: c.short,
    crosshair: c.ash,
    crosshairLabel: c.raised,
    drawing: c.bone,
    tagBackground: c.bone,
    tagText: c.void,
    rule: c.signal,
    refused: c.refused,
    verified: c.verified,
  };
}

export function useChartPalette(): ChartPalette {
  const { colors } = useTheme();
  return useMemo(() => paletteFromColors(colors), [colors]);
}

/** Axis labels are numbers: monospaced, with a stack that exists inside a bare WebView. */
export const CHART_FONT = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
