import { Text, View } from 'react-native';
import { Badge } from '../badge';
import { EmptyState } from '../empty-state';
import { Skeleton } from '../skeleton';
import { GhostButton } from '../ui';
import { TAB_PROTRUSION, TOP_INSET, type TradesTab } from './reel-page';
import { NoteLine, PAGE_SNAP, Rail, SideButton, SlideTitle } from './reel-parts';

/*
 * The reel when it has no slide to show: still reading, nothing matching,
 * trading unavailable, and the page after the last slide. Each is the shape of
 * a slide, so the screen never collapses to a blank or a spinner.
 */

/**
 * The reel's shape while it loads: the blocks a page is made of, in the places
 * they will land, not a spinner. Opacity pulse only, and it stops with the page.
 */
export function ReelSkeleton({ width, height }: { width: number; height: number }) {
  return (
    <View style={{ width, height, paddingTop: TOP_INSET }} className="bg-void" aria-busy aria-label="Reading what can be traded">
      <View className="gap-3 px-5">
        <View className="flex-row items-center gap-2">
          <Skeleton width={40} height={18} />
          <Skeleton width={32} height={24} />
          <Skeleton width={64} height={22} />
        </View>
        <Skeleton width="92%" height={26} />
        <Skeleton width="64%" height={26} />
      </View>
      <View className="mt-5 px-5">
        <Skeleton width={190} height={36} />
      </View>
      <View className="mt-3 flex-1 justify-end px-5 pb-3">
        <Skeleton height={150} />
      </View>
      <View className="gap-2 px-5 py-3">
        <Skeleton width="72%" height={11} />
        <Skeleton width="56%" height={11} />
        <Skeleton height={36} />
      </View>
      <View className="flex-row gap-3 px-5 pb-11">
        <View className="flex-1">
          <Skeleton height={64} />
        </View>
        <View className="flex-1">
          <Skeleton height={64} />
        </View>
      </View>
    </View>
  );
}

/**
 * Trading is unavailable: nobody is signed in, trading is not connected in this
 * build, or the venue could not be read. The reason is the one it came with,
 * said once and plainly, and the two actions are in their place and off. There
 * are no slides to page through, since the pairs and the times are the server's.
 */
export function ReelUnavailable({
  height,
  message,
  onRefresh,
  running = 0,
  onTrades,
}: {
  height: number;
  /** Why, in the words it came with. */
  message: string;
  /** Reads what can be traded again. Absent while nobody is signed in: there is nothing to read. */
  onRefresh?: (() => void) | undefined;
  /** How many of the caller's trades are running. A trade opened earlier still runs while trading is unavailable. */
  running?: number | undefined;
  /** Opens the caller's trades. Absent while nobody is signed in: there are none. */
  onTrades?: ((tab: TradesTab) => void) | undefined;
}) {
  return (
    <View className="bg-void" style={{ height, paddingTop: TOP_INSET }}>
      {onTrades ? (
        <View className="absolute right-3 top-16" style={{ zIndex: 1 }}>
          <Rail horizontal running={running} onRunning={() => onTrades('running')} onHistory={() => onTrades('history')} />
        </View>
      ) : null}
      <View role="status" className="flex-1 justify-center gap-3 px-5">
        <Badge label="Unavailable" size="md" />
        <SlideTitle parts={[{ text: message, mono: false }]} />
        <Text className="font-sans text-13 leading-5 text-ash">
          Each slide is a pair and a time. UP opens a long and DOWN opens a short, at market, and the server closes it when
          the time is up. The pairs, the times and the stakes come from the server, so they appear once trading is available.
        </Text>
        {onRefresh ? (
          <View className="mt-1 max-w-64">
            <GhostButton onPress={onRefresh}>Read again</GhostButton>
          </View>
        ) : null}
      </View>
      <View className="px-5" style={{ paddingBottom: TAB_PROTRUSION }}>
        <View className="flex-row gap-3">
          <SideButton direction="up" word="UP" claim={null} label={`Up. ${message}`} disabled sending={false} onPress={noop} />
          <SideButton direction="down" word="DOWN" claim={null} label={`Down. ${message}`} disabled sending={false} onPress={noop} />
        </View>
        <NoteLine text={message} />
      </View>
    </View>
  );
}

const noop = (): void => {};

/** No slide to show. Not a fault: a filter that matches nothing, or a server that lists no market right now. */
export function ReelEmpty({ height, filtered, onClear }: { height: number; filtered: boolean; onClear: () => void }) {
  return (
    <View className="items-center justify-center bg-void" style={{ height, paddingTop: TOP_INSET }}>
      {filtered ? (
        <EmptyState
          icon="filter"
          title="No slide here"
          body="No pair and time matches this filter. Show them all to carry on."
          action={{ label: 'Show every slide', onPress: onClear }}
        />
      ) : (
        <EmptyState
          icon="clock"
          title="No market listed"
          body="The server lists no market for timed trades right now. Slides appear here as soon as it does."
        />
      )}
    </View>
  );
}

/** The closing page: the swipe past the last slide lands somewhere. */
export function ReelEnd({
  width,
  height,
  onTop,
}: {
  width: number;
  height: number;
  onTop: () => void;
}) {
  return (
    <View className="items-center justify-center bg-void" style={[{ width, height }, PAGE_SNAP]}>
      <EmptyState
        icon="check-circle"
        title="That is every slide"
        body="Every pair and time on offer is above. Your trades, running and finished, are one press from any slide."
        action={{ label: 'Back to the first slide', onPress: onTop }}
      />
    </View>
  );
}
