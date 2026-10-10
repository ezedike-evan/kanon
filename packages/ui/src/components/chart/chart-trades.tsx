import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { normalizeSymbol } from '../../lib/chart-assets';
import { cx } from '../../lib/cx';
import type { VenueTicket } from '../../lib/use-venue-ticket';
import { isClosing, positionRowView } from '../../lib/venue-trade';
import type { VenuePositionView, VenueSide } from '../../lib/venue-types';
import { useHaptics } from '../../platform';
import { Icon } from '../icons';
import { SectionHeader } from '../section-header';
import { Skeleton } from '../skeleton';
import { Num } from '../ui';

/*
 * What the shared account holds open, on every market: the list behind the
 * desktop panel's Trades tab and inside the phone's ticket sheet. It draws the
 * ticket's own state (`useVenueTicket`) and reads nothing itself, so a close
 * from a row goes out through the same one-order-at-a-time path as every other
 * order and its answer is shown where the ticket shows answers.
 *
 * A row is a position's own figures: market, side, size, entry and leverage.
 * No mark price and no result of it, here or anywhere on the ticket.
 */

export const SIDE_WORD: Record<VenueSide, string> = { long: 'LONG', short: 'SHORT' };

/** A direction's arrow. Green and red never stand alone: its word is always beside it. */
export function SideGlyph({ side, size = 14, onFill }: { side: VenueSide; size?: number; onFill?: boolean }) {
  return (
    <Icon
      name={side === 'long' ? 'arrow-up' : 'arrow-down'}
      size={size}
      color={onFill ? 'void' : side}
      strokeWidth={2}
    />
  );
}

const PositionRow = memo(function PositionRow({
  position,
  selected,
  onAsset,
  onClose,
  closing,
  locked,
  dense,
  last,
}: {
  position: VenuePositionView;
  /** This position's market is the one on the chart. */
  selected: boolean;
  onAsset?: ((asset: string) => void) | undefined;
  onClose: (asset: string) => void;
  /** This position's close is the order on its way. */
  closing: boolean;
  locked: boolean;
  dense: boolean;
  last: boolean;
}) {
  const { select, tap } = useHaptics();
  const row = positionRowView(position);
  const long = row.side === 'long';
  const target = onAsset ? row.chartAsset : null;

  const figures = (
    <>
      <View className="flex-row items-center gap-1.5">
        <SideGlyph side={row.side} size={12} />
        <Text className={cx('font-mono-bold text-11 tracking-w14', long ? 'text-long' : 'text-short')}>
          {row.sideWord}
        </Text>
        <Text numberOfLines={1} className="shrink font-mono-medium text-12 text-bone">
          {row.asset}
        </Text>
        <Num className="text-11 text-ash">{row.leverage}</Num>
      </View>
      {/* Two figures that wrap as wholes: the panel is narrow, and a size cut in half reads as another size. */}
      <View className="flex-row flex-wrap gap-x-2">
        <Num className="text-11 leading-4 text-ash">{row.size}</Num>
        <Num className="text-11 leading-4 text-ash">{`entry ${row.entry}`}</Num>
      </View>
    </>
  );

  return (
    <View
      className={cx(
        'relative min-h-14 flex-row items-center gap-2',
        dense ? 'px-4' : 'px-3.5',
        !last && 'border-b border-hairline',
        selected && dense && 'bg-raised',
      )}
    >
      {/* The market on the chart, marked as the watchlist marks it. */}
      <View className={cx('absolute inset-y-2 left-0 w-0.5 bg-signal', selected ? 'opacity-100' : 'opacity-0')} />
      {target ? (
        <Pressable
          role="button"
          aria-label={row.accessibilityLabel}
          aria-pressed={selected}
          onPress={() => {
            if (selected) return;
            select();
            onAsset?.(target);
          }}
          className={cx(
            'min-w-0 flex-1 justify-center gap-1 self-stretch py-2.5',
            !selected && 'hover:opacity-80 active:opacity-70',
          )}
        >
          {figures}
        </Pressable>
      ) : (
        <View aria-label={row.accessibilityLabel} className="min-w-0 flex-1 justify-center gap-1 self-stretch py-2.5">
          {figures}
        </View>
      )}
      <Pressable
        role="button"
        aria-label={row.closeLabel}
        aria-busy={closing}
        disabled={locked}
        hitSlop={dense ? 6 : 0}
        onPressIn={tap}
        onPress={() => onClose(position.asset)}
        className={cx(
          'shrink-0 items-center justify-center rounded-xs border border-bone hover:bg-bone/10 active:bg-bone/15',
          dense ? 'h-7 px-2.5' : 'h-11 px-3.5',
          locked && 'opacity-40',
        )}
      >
        <Text className="font-mono-bold text-10 tracking-w14 text-bone">{closing ? 'CLOSING…' : 'CLOSE'}</Text>
      </Pressable>
    </View>
  );
});

/**
 * Every position open on the shared account, each with its own close. A press
 * on a row puts its market on the chart, and the ticket then is for it.
 *
 * `dense` is the desktop panel: rows run edge to edge with the panel's gutter,
 * as the watchlist's do. Without it the list is a ruled table for a thumb,
 * inside a sheet that has its own gutter.
 */
export const OpenPositions = memo(function OpenPositions({
  ticket,
  onAsset,
  dense,
  className,
}: {
  ticket: VenueTicket;
  /** Shows a market on the chart. Left out, a row is figures and a close, and no way to the chart. */
  onAsset?: ((asset: string) => void) | undefined;
  dense: boolean;
  className?: string | undefined;
}) {
  const { view, positions, sending, locked } = ticket;
  const pad = dense ? 'px-4' : '';
  const note = cx('font-sans text-12 leading-[18px] text-ash', pad);
  const chart = normalizeSymbol(ticket.asset);

  return (
    <View {...(className ? { className } : {})}>
      <SectionHeader
        title="Open positions"
        {...(positions.length > 0 ? { count: positions.length } : {})}
        className={cx('pb-2.5', pad)}
      />
      {view.status === 'loading' ? (
        <View aria-busy aria-label="Reading the open positions" className={cx('gap-1.5 pb-4', pad)}>
          <Skeleton width="55%" height={12} />
          <Skeleton width="80%" height={10} />
        </View>
      ) : view.status === 'unavailable' ? (
        // The account's own words for why it cannot be read. Not a fault of this list.
        <Text className={cx(note, 'pb-4')}>{view.message}</Text>
      ) : positions.length === 0 ? (
        <Text className={cx(note, 'pb-4')}>No open positions on the shared account.</Text>
      ) : (
        <>
          <Text className={cx(note, 'pb-2.5')}>
            Every position on the shared account, whoever opened it. Anyone signed in can close one.
          </Text>
          <View className={dense ? 'border-t border-hairline' : 'border border-hairline bg-panel'}>
            {positions.map((position, i) => (
              <PositionRow
                key={`${position.asset}:${position.side}`}
                position={position}
                selected={normalizeSymbol(position.asset) === chart}
                onAsset={onAsset}
                onClose={ticket.closeAsset}
                closing={isClosing(sending, position.asset)}
                locked={locked}
                dense={dense}
                last={i === positions.length - 1}
              />
            ))}
          </View>
        </>
      )}
    </View>
  );
});
