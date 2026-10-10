/**
 * Trade markers on the candle series.
 *
 * A marker is a fact about one bucket: a trade executed there, or a trade the
 * rule refused there. `TradeMarker` is what a screen supplies; `EngineMarker`
 * is the plain, library-free shape that crosses to the chart runtime as a
 * `markers` command, the same on the web and inside the native WebView, so the
 * mapping from meaning to glyph and colour lives here once and the two clients
 * cannot drift apart.
 *
 * Direction is carried by placement, not colour: a long sits below its bar and
 * a short above it. Executed trades are arrows in the direction colours. A
 * refusal is a circle in `refused` — the token docs/DESIGN.md sets aside for
 * blocks so one never reads as a losing trade — and it is a plain mark, never
 * an error glyph, because a block is the product working.
 *
 * A close is a square in the neutral ink, on the side of the position it
 * closed. It takes neither direction colour on purpose: a green or a red mark
 * where a position ended would read as how it ended, and the chart states no
 * result.
 */
import { colors } from '@kanon/tokens';
import type { EngineMarker } from '../../lib/chart-protocol';

export type { EngineMarker } from '../../lib/chart-protocol';

export interface TradeMarker {
  /** Start of the bucket the trade landed in, unix seconds. A timestamp that
   * is not a candle's own start has no bar to sit on. */
  timestamp: number;
  /** For `closed`, the side of the position that was closed. */
  side: 'long' | 'short';
  kind: 'executed' | 'blocked' | 'closed';
}

/** Ascending by time: lightweight-charts requires markers in order. */
export function toEngineMarkers(
  markers: readonly TradeMarker[],
  palette: { up: string; down: string; refused: string; closed: string } = {
    up: colors.long,
    down: colors.short,
    refused: colors.refused,
    closed: colors.bone,
  },
): EngineMarker[] {
  return [...markers]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((m) => {
      const long = m.side === 'long';
      const position = long ? 'belowBar' : 'aboveBar';
      if (m.kind === 'blocked') {
        return { time: m.timestamp, position, shape: 'circle', color: palette.refused };
      }
      if (m.kind === 'closed') {
        return { time: m.timestamp, position, shape: 'square', color: palette.closed };
      }
      return {
        time: m.timestamp,
        position,
        shape: long ? 'arrowUp' : 'arrowDown',
        color: long ? palette.up : palette.down,
      };
    });
}
