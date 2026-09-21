import { memo, useMemo } from 'react';
import { Text, View } from 'react-native';
import { Link } from '../../nav';
import type { ActivityItem } from '../../lib/domain-types';
import { useActivity } from '../../lib/domains';
import { activityCopy, groupByDay, relativeTime } from '../../lib/home-format';
import { routes, tradeRoute } from '../../lib/routes';
import { useNowMs } from '../../lib/use-now';
import { cx } from '../../lib/cx';
import { useHaptics } from '../../platform';
import { Badge } from '../badge';
import { Card } from '../card';
import { EmptyState } from '../empty-state';
import { Icon, type Icon as IconName } from '../icons';
import { SectionHeader } from '../section-header';
import { SkeletonRow } from '../skeleton';
import { Num } from '../ui';
import type { Tone } from '../tone';

const KIND_BADGE: Record<ActivityItem['kind'], { tone: Tone; icon: IconName }> = {
  executed: { tone: 'neutral', icon: 'check' },
  // A refusal is the rule doing its job: the block glyph and the block colour, not a fault.
  refused: { tone: 'refused', icon: 'ban' },
  proposed: { tone: 'signal', icon: 'clock' },
  undone: { tone: 'neutral', icon: 'undo' },
};

/** The time on a row. Its own leaf on the shared clock, so a tick re-renders this and not the row. */
function When({ at }: { at: number }) {
  const now = useNowMs();
  return <Num className="text-11 text-ash">{relativeTime(at, now)}</Num>;
}

/** One trade or refusal, opening its evidence. Memoised on the item, which keeps its reference until it changes. */
const ActivityRow = memo(function ActivityRow({ item, divider }: { item: ActivityItem; divider: boolean }) {
  const { tap } = useHaptics();
  const copy = activityCopy(item);
  const badge = KIND_BADGE[item.kind];
  const long = item.direction === 'long';
  return (
    <Link
      href={tradeRoute(item.id)}
      onPressIn={tap}
      aria-label={`${copy.badge}: ${copy.title}. ${copy.sub}. Open evidence.`}
      className={cx(
        'min-h-16 flex-row items-center gap-3 px-4 py-3 hover:bg-raised active:bg-raised',
        divider && 'border-b border-hairline',
      )}
    >
      {/* Side glyph: direction colour is paired with the arrow and the word Long or Short in the title. */}
      <View className="size-8 items-center justify-center rounded-sm border border-hairline bg-raised">
        <Icon name={long ? 'trending-up' : 'trending-down'} size={16} color={long ? 'long' : 'short'} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="font-mono-medium text-13 text-bone">
          {copy.title}
        </Text>
        <Text numberOfLines={2} className="font-sans text-12 leading-[1.4] text-ash">
          {copy.sub}
        </Text>
      </View>
      <View className="items-end gap-1">
        <Badge label={copy.badge} tone={badge.tone} icon={badge.icon} />
        <When at={item.at} />
      </View>
    </Link>
  );
});

function DayLabel({ label }: { label: string }) {
  return (
    <View className="border-b border-hairline bg-raised/60 px-4 py-1.5">
      <Text className="font-mono text-10 uppercase tracking-w14 text-ash">{label}</Text>
    </View>
  );
}

/**
 * The last eight things the rule did: trades taken, entries it held back,
 * proposals, undos. Grouped by day like a ledger. Eight rows at most, so a plain
 * column rather than a virtualised list; the page around it is the scroller.
 */
export function ActivitySection() {
  const activity = useActivity(8);
  const now = useNowMs();
  const items = activity.status === 'ready' || activity.status === 'demo' ? activity.items : null;
  const groups = useMemo(() => (items ? groupByDay(items, now) : []), [items, now]);

  return (
    <View className="gap-2.5">
      <SectionHeader
        title="Recent activity"
        {...(items && items.length > 0 ? { count: items.length } : {})}
        action={{ label: 'See all', href: routes.blocked }}
      />
      <Card pad="none" className="overflow-hidden">
        {activity.status === 'loading' ? (
          <>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </>
        ) : items === null || items.length === 0 ? (
          <EmptyState
            icon="history"
            title="Nothing to review yet"
            body="Trades your rule takes, and setups it holds back, are listed here with their evidence."
            action={{ label: 'Open the chart', href: routes.chart }}
          />
        ) : (
          groups.map((group, g) => (
            <View key={`${group.label}-${g}`}>
              <DayLabel label={group.label} />
              {group.items.map((item, i) => (
                <ActivityRow
                  key={item.id}
                  item={item}
                  divider={!(g === groups.length - 1 && i === group.items.length - 1)}
                />
              ))}
            </View>
          ))
        )}
      </Card>
    </View>
  );
}
