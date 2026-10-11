import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, ScrollView, Text, View } from 'react-native';
import { Badge } from '../components/badge';
import { FilterChip } from '../components/chip';
import { EmptyState } from '../components/empty-state';
import { ProfileFrame } from '../components/profile/frame';
import { RecordRow } from '../components/profile/record-rows';
import { RecordSheet } from '../components/profile/record-sheet';
import { RECORD_EMPTY, RecordsPane, recordStats } from '../components/profile/records-table';
import { SkeletonRow } from '../components/skeleton';
import { StatRow } from '../components/stat';
import { Num } from '../components/ui';
import { RECORDS_LIMIT, useRecords } from '../lib/profile-hooks';
import {
  RECORD_FILTERS,
  filterRecords,
  recordTotals,
  withDayHeaders,
  type DayHeader,
  type LedgerRecord,
  type ListEntry,
  type RecordFilter,
} from '../lib/profile-logic';
import { useRouteParam } from '../nav';

/**
 * 15A · TRADING RECORDS.
 *
 * Every trade the person took, however they took it: by hand on the chart, on a
 * timer in Predict, or through their rule. Newest first, grouped by the UTC day
 * each was opened. Executed and refused sit side by side: a refusal is the
 * product working, so it carries no error styling, only its own mark and the
 * predicate that stopped it.
 *
 * A row never carries money. A press opens the trade's details, a bottom sheet
 * with its figures and the transactions behind them; a rule's trade opens its
 * own evidence screen. `/profile/records?open=<id>` opens on one record, which
 * is how the Profile tab's newest trades link here.
 *
 * A virtualised list, so a long record costs what a screenful costs.
 */

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

const NO_RECORDS: LedgerRecord[] = [];

export function ProfileRecordsScreen() {
  const state = useRecords();
  const [filter, setFilter] = useState<RecordFilter>('all');
  const [now] = useState(() => Date.now());
  const [openId, setOpenId] = useState<string | null>(null);

  // `?open=<id>` opens on that record. Read after mount, like every route parameter.
  const requested = useRouteParam('open');
  useEffect(() => {
    if (requested) setOpenId(requested);
  }, [requested]);

  const all = state.status === 'ready' || state.status === 'demo' ? state.records : NO_RECORDS;
  const totals = useMemo(() => recordTotals(all), [all]);
  const entries = useMemo(() => withDayHeaders(filterRecords(all, filter), now), [all, filter, now]);
  // Looked up by id on every change, so the sheet gains a fill's figures as they are reported.
  const opened = useMemo(() => (openId ? (all.find((r) => r.id === openId) ?? null) : null), [all, openId]);
  const truncated = state.status === 'ready' && state.truncated;
  const close = useCallback(() => setOpenId(null), []);

  const renderEntry = useCallback(({ item }: { item: ListEntry }) => {
    if (item.type === 'day') return <DayRow header={item} />;
    return (
      <View className="border-x border-hairline bg-panel">
        <RecordRow record={item} onOpen={setOpenId} />
      </View>
    );
  }, []);

  const header = useMemo(
    () => (
      <View className="gap-3 pt-1">
        <StatRow stats={recordStats(totals)} />
        <Text className="font-sans text-12 leading-[1.5] text-ash">
          From the chart, from Predict and through your rule, by the day each was opened. Tap a trade for its figures
          and the transactions behind it.
        </Text>
      </View>
    ),
    [totals],
  );

  const footer = useMemo(
    () =>
      truncated ? (
        <Text className="pt-4 font-sans text-12 text-ash">
          Showing the newest {RECORDS_LIMIT} of each kind. Older ones are still on-chain.
        </Text>
      ) : (
        <View className="h-2" />
      ),
    [truncated],
  );

  const empty = useCallback(() => {
    const e = RECORD_EMPTY[state.status === 'empty' ? 'all' : filter];
    return (
      <View className="mt-4 rounded-sm border border-hairline bg-panel">
        <EmptyState icon={e.icon} title={e.title} body={e.body} {...(e.action ? { action: e.action } : {})} />
      </View>
    );
  }, [filter, state.status]);

  return (
    <ProfileFrame
      section="records"
      label="15A · TRADING RECORDS"
      title="Trading records"
      pane={<RecordsPane state={state} filter={filter} onFilter={setFilter} onOpen={setOpenId} now={now} />}
      right={state.status === 'demo' ? <Badge label="Demo" tone="signal" icon="sparkles" /> : null}
      overlay={<RecordSheet record={opened} onClose={close} />}
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
              count={totals[f.value]}
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
