import { Text, View } from 'react-native';
import { baseOf } from '../../lib/chart-assets';
import { cx } from '../../lib/cx';
import type { VenuePositionView } from '../../lib/venue-types';
import { Icon } from '../icons';
import { PanelRail } from '../panel-rail';

/** What the chart's panel is called, open or collapsed, so the landmark and both toggles agree. */
export const DESK_PANEL_LABEL = 'Markets and order ticket';
export const DESK_PANEL_NAME = 'markets and order ticket';

/** Web only, as the rail is: a word reads down the rail, on one line, in tabular figures. */
const DOWN_THE_RAIL = { writingMode: 'vertical-rl', whiteSpace: 'nowrap', fontVariant: ['tabular-nums'] } as never;

/**
 * The side of the position open on the chart's asset: its arrow and its word,
 * in the direction's colour, so neither the colour nor the arrow stands alone.
 * It says a position is open and which way. Its size and entry are in the panel
 * and on the chart's entry line, and no result of it is anywhere.
 */
function PositionMark({ position }: { position: Pick<VenuePositionView, 'asset' | 'side'> }) {
  const long = position.side === 'long';
  return (
    <View
      role="img"
      aria-label={`Open ${position.side} position on ${baseOf(position.asset)}`}
      className="items-center gap-1.5"
    >
      <View
        className={cx(
          'size-6 items-center justify-center rounded-xs border',
          long ? 'border-long bg-long/10' : 'border-short bg-short/10',
        )}
      >
        <Icon name={long ? 'arrow-up' : 'arrow-down'} size={14} color={position.side} strokeWidth={2} />
      </View>
      <Text className={cx('font-mono-bold text-10 tracking-w14', long ? 'text-long' : 'text-short')} style={DOWN_THE_RAIL}>
        {long ? 'LONG' : 'SHORT'}
      </Text>
    </View>
  );
}

/**
 * How many positions the shared account holds, when some are on markets other
 * than the one on the chart. A count and a word, in the neutral ink: it says
 * they exist, and the Trades tab behind the rail says what they are.
 */
function HeldCount({ held, elsewhere }: { held: number; elsewhere: number }) {
  return (
    <Text
      role="img"
      aria-label={`${held} ${held === 1 ? 'position' : 'positions'} open, ${elsewhere} on ${
        elsewhere === 1 ? 'another market' : 'other markets'
      }`}
      className="font-mono-medium text-10 tracking-w14 text-bone"
      style={DOWN_THE_RAIL}
    >
      {`${held} OPEN`}
    </Text>
  );
}

/**
 * The chart's panel, collapsed. The panel holds the only order ticket a desktop
 * has, so its rail names the ticket in the toggle and in the caption, and an
 * open position is never hidden with it: the side of the one on this chart
 * stays on the rail, and so does a count when there are others.
 */
export function DeskPanelRail({
  position,
  held,
  onOpen,
}: {
  /** The shared account's open position on the chart's asset, or null. */
  position: Pick<VenuePositionView, 'asset' | 'side'> | null;
  /** Every position open on the shared account, on any market. */
  held: number;
  onOpen: () => void;
}) {
  const elsewhere = Math.max(0, held - (position ? 1 : 0));
  return (
    <PanelRail
      side="right"
      label={DESK_PANEL_LABEL}
      name={DESK_PANEL_NAME}
      caption="Markets · Order ticket"
      onOpen={onOpen}
    >
      {position ? <PositionMark position={position} /> : null}
      {elsewhere > 0 ? <HeldCount held={held} elsewhere={elsewhere} /> : null}
    </PanelRail>
  );
}
