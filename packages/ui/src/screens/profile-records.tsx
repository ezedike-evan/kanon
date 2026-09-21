import { memo, useCallback, useMemo, useState } from 'react';
import { FlatList, ScrollView, Text, View } from 'react-native';
import { Badge } from '../components/badge';
import { FilterChip } from '../components/chip';
import { EmptyState } from '../components/empty-state';
import { ListRow } from '../components/list-row';
import { ProfileFrame } from '../components/profile/frame';
import { RecordsPane } from '../components/profile/records-table';
import { SkeletonRow } from '../components/skeleton';
import { StatRow } from '../components/stat';
import { Num } from '../components/ui';
import { monad } from '../lib/monad-chain';
import { RECORDS_LIMIT, useRecords } from '../lib/profile-hooks';
import {
  RECORD_FILTERS,
  compactDecimal,
  filterRecords,
  priceLabel,
  recordTotals,
  timeLabel,
  withDayHeaders,
  type DayHeader,
  type LedgerRecord,
  type ListEntry,
  type RecordFilter,
  type StakeRecord,
} from '../lib/profile-logic';
import { routes, tradeRoute } from '../lib/routes';
import type { ActivityItem } from '../lib/domain-types';

/**
 * 15A · TRADING RECORDS.
 *
 * Every setup put to your rule and every prediction you took, newest first and
 * grouped by day (UTC). Executed and refused sit side by side: a refusal is the
 * product working, so it carries no error styling, only its own mark and the
 * predicate that stopped it. Every trade opens onto its evidence.
 *
 * A virtualised list, so a long record costs what a screenful costs.
 */

const KIND_LABEL: Record<ActivityItem['kind'], string> = {
  executed: 'Executed',
  refused: 'Blocked',
  proposed: 'Proposed',
  undone: 'Undone',
};

const RESULT_LABEL = { won: 'WON', lost: 'LOST', refunded: 'REFUNDED' } as const;

const TradeRow = memo(function TradeRow({ item }: { item: ActivityItem }) {
  const refused = item.kind === 'refused';
  const base = item.asset.split('/')[0] ?? item.asset;
  const side = item.direction === 'long' ? 'Long' : 'Short';
  return (
    <View className="border-x border-hairline bg-panel">
      <ListRow
        leading={refused ? 'ban' : item.direction === 'long' ? 'trending-up' : 'trending-down'}
        leadingTone={refused ? 'refused' : item.direction === 'long' ? 'long' : 'short'}
        title={`${item.asset} · ${side}`}
        subtitle={
          refused
            ? `Blocked by ${item.refusedBy ?? 'your rule'} · ${timeLabel(item.at)}`
            : `${KIND_LABEL[item.kind]} · ${timeLabel(item.at)}`
        }
        value={priceLabel(item.entry)}
        valueSub={`${compactDecimal(item.size)} ${base}`}
        href={tradeRoute(item.id)}
      />
    </View>
  );
});

const StakeRow = memo(function StakeRow({ stake }: { stake: StakeRecord }) {
  return (
    <View className="border-x border-hairline bg-panel">
      <ListRow
        leading="target"
        title={`${stake.asset} · ${stake.side === 'above' ? 'Up' : 'Down'}`}
        subtitle={`Reaches ${priceLabel(stake.target)} · ${stake.window} window · ${timeLabel(stake.at)}`}
        value={stake.stake ? `${compactDecimal(stake.stake)} ${monad.nativeCurrency.symbol}` : '—'}
        valueSub={stake.result ? RESULT_LABEL[stake.result] : 'OPEN'}
        href={routes.predict}
      />
    </View>
  );
});

const DayRow = memo(function DayRow({ header }: { header: DayHeader }) {
  return (
    <View className="mt-4 h-8 flex-row items-center justify-between rounded-t-sm border border-hairline bg-raised px-4">
      <Text role="heading" className="font-mono-medium text-11 uppercase tracking-w10 text-bone">
        {header.label}
      </Text>
      <Num className="text-11 text-ash">{header.count}</Num>
    </View>
  );
});

const keyOf = (entry: ListEntry) => entry.id;

function renderEntry({ item }: { item: ListEntry }) {
  if (item.type === 'day') return <DayRow header={item} />;
  if (item.type === 'trade') return <TradeRow item={item.item} />;
  return <StakeRow stake={item.stake} />;
}

const NO_RECORDS: LedgerRecord[] = [];

const FILTER_EMPTY: Record<RecordFilter, { icon: 'history' | 'check-circle' | 'ban' | 'target'; title: string; body: string }> = {
  all: { icon: 'history', title: 'Nothing recorded yet', body: 'Setups put to your rule and predictions you take collect here.' },
  executed: { icon: 'check-circle', title: 'No executed trades', body: 'A trade that satisfies your rule is executed and lands here.' },
  refused: { icon: 'ban', title: 'No blocked trades', body: 'A good day: nothing broke your rule.' },
  predictions: { icon: 'target', title: 'No predictions taken', body: 'Stakes you take on the Predict tab are recorded here.' },
};

export function ProfileRecordsScreen() {
  const state = useRecords();
  const [filter, setFilter] = useState<RecordFilter>('all');
  const [now] = useState(() => Date.now());

  const all = state.status === 'ready' || state.status === 'demo' ? state.records : NO_RECORDS;
  const totals = useMemo(() => recordTotals(all), [all]);
  const entries = useMemo(() => withDayHeaders(filterRecords(all, filter), now), [all, filter, now]);
  const setups = totals.executed + totals.refused;
  const truncated = state.status === 'ready' && state.truncated;

  const header = useMemo(
    () => (
      <View className="gap-3 pt-1">
        <StatRow
          stats={[
            { label: 'Total', value: String(totals.all) },
            { label: 'Taken', value: String(totals.executed) },
            { label: 'Refused', value: String(totals.refused) },
            { label: 'Stakes', value: String(totals.predictions) },
          ]}
        />
        <Text className="font-sans text-12 leading-[1.5] text-ash">
          {setups} setups put to your rule. Tap a trade for the timestamps and attestations behind it.
        </Text>
      </View>
    ),
    [totals, setups],
  );

  const footer = useMemo(
    () =>
      truncated ? (
        <Text className="pt-4 font-sans text-12 text-ash">
          Showing your newest {RECORDS_LIMIT} trades. Older ones are still on-chain.
        </Text>
      ) : (
        <View className="h-2" />
      ),
    [truncated],
  );

  const empty = useCallback(() => {
    const e = FILTER_EMPTY[state.status === 'empty' ? 'all' : filter];
    return (
      <View className="mt-4 rounded-sm border border-hairline bg-panel">
        <EmptyState
          icon={e.icon}
          title={e.title}
          body={e.body}
          {...(state.status === 'empty'
            ? { action: { label: 'Build a rule', href: routes.create, primary: true } }
            : filter === 'predictions'
              ? { action: { label: 'Open Predict', href: routes.predict } }
              : {})}
        />
      </View>
    );
  }, [filter, state.status]);

  return (
    <ProfileFrame
      section="records"
      label="15A · TRADING RECORDS"
      title="Trading records"
      pane={<RecordsPane state={state} filter={filter} onFilter={setFilter} now={now} />}
      right={state.status === 'demo' ? <Badge label="Demo" tone="signal" icon="sparkles" /> : null}
    >
      <View className="shrink-0">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 px-5 pb-3"
          role="radiogroup"
          aria-label="Filter records"
        >
          {RECORD_FILTERS.map((f) => (
            <FilterChip
              key={f.value}
              label={f.label}
              selected={filter === f.value}
              count={f.value === 'all' ? totals.all : totals[f.value === 'predictions' ? 'predictions' : f.value]}
              onPress={() => setFilter(f.value)}
            />
          ))}
        </ScrollView>
      </View>

      {state.status === 'loading' ? (
        <View className="mx-5 mt-2 rounded-sm border border-hairline bg-panel">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <SkeletonRow key={i} />
          ))}
        </View>
      ) : (
        <FlatList
          className="min-h-0 flex-1"
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}
          data={entries}
          keyExtractor={keyOf}
          renderItem={renderEntry}
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          ListEmptyComponent={empty}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          showsVerticalScrollIndicator={false}
        />
      )}
    </ProfileFrame>
  );
}
