import { memo, useCallback, useMemo } from 'react';
import { FlatList, Text, View } from 'react-native';
import { formatBps } from '@kanon/spec';
import { Link } from '../../nav';
import { cx } from '../../lib/cx';
import type { CopyLeadSummary } from '../../lib/home-types';
import { useCopyLeads, useFollows } from '../../lib/domains';
import { routes } from '../../lib/routes';
import { useHaptics } from '../../platform';
import { Avatar } from '../avatar';
import { Card } from '../card';
import { EmptyState } from '../empty-state';
import { Icon } from '../icons';
import { ListRow } from '../list-row';
import { SectionHeader } from '../section-header';
import { Skeleton } from '../skeleton';
import { Label } from '../stat';
import { Num } from '../ui';

const CARD_W = 264;
const GAP = 12;
const GUTTER = 20;
/** How many leads the desktop side column lists before "See all". */
const LIST_MAX = 3;

/**
 * A strategy to follow. Adherence and followers lead, because a lead is judged by how
 * faithfully it followed its own rule and not by profit. The whole card opens copy
 * trading, where the terms and a worked example come before any sign-off.
 */
const LeadCard = memo(function LeadCard({ lead, fluid = false }: { lead: CopyLeadSummary; fluid?: boolean }) {
  const { tap } = useHaptics();
  const adherence = lead.adherenceBps;
  return (
    <Link
      href={routes.copy}
      onPressIn={tap}
      aria-label={`${lead.name}${lead.asset ? ` on ${lead.asset}` : ''}. ${
        adherence === null ? 'Not yet tested' : `Adherence ${formatBps(adherence, { dp: 1 })}`
      }, ${lead.followers} followers. Open copy trading.`}
      className="justify-between overflow-hidden rounded-sm border border-hairline bg-panel active:bg-raised hover:bg-raised"
      style={fluid ? undefined : { width: CARD_W }}
    >
      <View className="gap-3 p-3.5">
        <View className="flex-row items-start gap-2.5">
          <Avatar name={lead.name} size="sm" />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text numberOfLines={2} className="font-mono-medium text-12 leading-[1.35] text-bone">
              {lead.name}
            </Text>
            <Num className="text-11 text-ash">{[lead.asset, lead.timeframe].filter(Boolean).join(' · ') || '—'}</Num>
          </View>
        </View>

        <View className="flex-row gap-4">
          <View className="flex-1 gap-1">
            <Label>Adherence</Label>
            <Num className="font-mono-medium text-20 tracking-t20">
              {adherence === null ? '—' : formatBps(adherence, { dp: 1 })}
            </Num>
          </View>
          <View className="flex-1 gap-1">
            <Label>Followers</Label>
            <Num className="font-mono-medium text-20 tracking-t20">{lead.followers}</Num>
          </View>
        </View>

        <View className="h-1 overflow-hidden rounded-xs bg-raised" aria-hidden>
          <View className="h-full bg-signal" style={{ width: `${Math.round((adherence ?? 0) / 100)}%` }} />
        </View>

        <Num className="text-11 text-ash">{`${lead.taken} taken · ${lead.blocked} held`}</Num>
      </View>

      <View className="flex-row items-center justify-between border-t border-hairline px-3.5 py-2.5">
        <Num className="text-11 text-ash">{`Fee ${formatBps(lead.profitShareBps, { dp: 0 })} of profit`}</Num>
        <View className="h-6 flex-row items-center gap-1 rounded-xs border border-signal/40 bg-signal/15 px-2">
          <Icon name="plus" size={12} color="signal" strokeWidth={2} />
          <Text className="font-mono-medium text-11 tracking-w04 text-signal">Follow</Text>
        </View>
      </View>
    </Link>
  );
});

function LeadSkeleton({ fluid = false }: { fluid?: boolean }) {
  return (
    <View
      className="gap-3 rounded-sm border border-hairline bg-panel p-3.5"
      style={fluid ? undefined : { width: CARD_W }}
    >
      <View className="flex-row items-center gap-2.5">
        <Skeleton width={32} height={32} />
        <View className="flex-1 gap-1.5">
          <Skeleton width="80%" height={12} />
          <Skeleton width="45%" height={10} />
        </View>
      </View>
      <View className="flex-row gap-4">
        <Skeleton width="40%" height={28} />
        <Skeleton width="30%" height={28} />
      </View>
      <Skeleton width="100%" height={4} />
      <Skeleton width="55%" height={10} />
    </View>
  );
}

const Separator = () => <View style={{ width: GAP }} />;
const keyOf = (lead: CopyLeadSummary) => lead.leadId;

/**
 * Copy trading, on Home: who is worth following, and who you already follow.
 * The carousel is a horizontal FlatList (it can grow), bleeding to the screen
 * edges so the next card peeks and the row reads as scrollable.
 */
export function LeadsSection({
  variant = 'carousel',
  className,
}: {
  /**
   * `carousel` is the phone's bleeding row. `list` is the desktop side column: the
   * same cards stacked and full width, the first few, the rest one link away.
   */
  variant?: 'carousel' | 'list';
  className?: string | undefined;
}) {
  const leads = useCopyLeads();
  const follows = useFollows();

  const list = leads.status === 'ready' || leads.status === 'demo' ? leads.leads : null;
  const active = useMemo(() => (follows ?? []).filter((f) => f.active), [follows]);

  const followingRow = useMemo(() => {
    if (active.length === 0) return null;
    const names = active.map((f) => list?.find((l) => l.strategyId === f.leaderStrategyId)?.name ?? 'A listed strategy');
    const allocated = active.reduce((sum, f) => sum + f.allocationBps, 0);
    return { names, allocated };
  }, [active, list]);

  const renderItem = useCallback(({ item }: { item: CopyLeadSummary }) => <LeadCard lead={item} />, []);

  const stacked = variant === 'list';

  return (
    <View className={cx('gap-2.5', className)}>
      <SectionHeader title="Traders to follow" action={{ label: 'See all', href: routes.copy }} />

      {followingRow ? (
        <Card pad="none">
          <ListRow
            leading="users"
            leadingTone="signal"
            title={`Following ${active.length}`}
            subtitle={followingRow.names.join(' · ')}
            value={formatBps(followingRow.allocated, { dp: 1 })}
            valueSub="allocated"
            href={routes.copy}
            divider={false}
          />
        </Card>
      ) : null}

      {leads.status === 'loading' && stacked ? (
        <View className="gap-3">
          <LeadSkeleton fluid />
          <LeadSkeleton fluid />
        </View>
      ) : leads.status === 'loading' ? (
        <View className="flex-row overflow-hidden" style={{ marginHorizontal: -GUTTER, paddingHorizontal: GUTTER, gap: GAP }}>
          <LeadSkeleton />
          <LeadSkeleton />
        </View>
      ) : list === null || list.length === 0 ? (
        <Card pad="none">
          <EmptyState
            icon="users"
            title="No strategies listed yet"
            body="A strategy appears here once its owner lists it for copying. Yours can be the first."
            action={{ label: 'Open copy trading', href: routes.copy }}
          />
        </Card>
      ) : stacked ? (
        <View className="gap-3">
          {list.slice(0, LIST_MAX).map((lead) => (
            <LeadCard key={lead.leadId} lead={lead} fluid />
          ))}
        </View>
      ) : (
        <FlatList
          horizontal
          data={list}
          keyExtractor={keyOf}
          renderItem={renderItem}
          ItemSeparatorComponent={Separator}
          showsHorizontalScrollIndicator={false}
          snapToInterval={CARD_W + GAP}
          snapToAlignment="start"
          decelerationRate="fast"
          initialNumToRender={3}
          windowSize={5}
          style={{ marginHorizontal: -GUTTER }}
          contentContainerStyle={{ paddingHorizontal: GUTTER }}
        />
      )}
    </View>
  );
}
