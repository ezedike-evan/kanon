import { View } from 'react-native';
import { EmptyState } from '../empty-state';
import { Skeleton } from '../skeleton';
import { TOP_INSET } from './reel-page';
import { PAGE_SNAP } from './reel-parts';

/**
 * The reel's shape while it loads: the blocks a page is made of, in the places
 * they will land, not a spinner. Opacity pulse only, and it stops with the page.
 */
export function ReelSkeleton({ width, height }: { width: number; height: number }) {
  return (
    <View style={{ width, height, paddingTop: TOP_INSET }} className="bg-void" aria-busy aria-label="Loading markets">
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
      <View className="flex-row items-center justify-between px-5 py-3">
        <View className="flex-row items-center gap-3">
          <Skeleton width={44} height={44} />
          <View className="gap-1.5">
            <Skeleton width={56} height={11} />
            <Skeleton width={96} height={18} />
          </View>
        </View>
        <Skeleton width={72} height={30} />
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

/** No live market. Not an error: markets open from a fresh Pyth print. */
export function ReelEmpty({ height, filtered, onClear }: { height: number; filtered: boolean; onClear: () => void }) {
  return (
    <View className="items-center justify-center bg-void" style={{ height, paddingTop: TOP_INSET }}>
      {filtered ? (
        <EmptyState
          icon="filter"
          title="Nothing here yet"
          body="No market matches this filter right now. Show them all, or wait for the next print."
          action={{ label: 'Show all markets', onPress: onClear }}
        />
      ) : (
        <EmptyState
          icon="clock"
          title="No live markets"
          body="Each market opens from a fresh Pyth print. None is fresh enough right now, so the next print opens them."
        />
      )}
    </View>
  );
}

/** The closing page: the swipe past the last market lands somewhere. */
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
        title="You have seen them all"
        body="New markets open from each fresh Pyth print. Settled ones stay here with their evidence."
        action={{ label: 'Back to the first market', onPress: onTop }}
      />
    </View>
  );
}
