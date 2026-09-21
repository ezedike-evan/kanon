import { memo, useMemo } from 'react';
import { Text, View } from 'react-native';
import { Badge } from '../badge';
import { Card } from '../card';
import { FilterChip } from '../chip';
import { EmptyState } from '../empty-state';
import { Icon } from '../icons';
import { SkeletonRow } from '../skeleton';
import { Label, StatRow } from '../stat';
import { Num } from '../ui';
import { Link } from '../../nav';
import { cx } from '../../lib/cx';
import { monad } from '../../lib/monad-chain';
import { RECORDS_LIMIT, type RecordsState } from '../../lib/profile-hooks';
import {
  RECORD_FILTERS,
  compactDecimal,
  filterRecords,
  priceLabel,
  recordTotals,
  tableDayLabel,
  timeLabel,
  type LedgerRecord,
  type RecordFilter,
} from '../../lib/profile-logic';
import { routes, tradeRoute } from '../../lib/routes';
import { useHaptics } from '../../platform';
import type { ActivityItem } from '../../lib/domain-types';

/**
 * Trading records as a table, for the desktop pane: when, what, which way, how
 * much, what came of it, and the way to the evidence. Executed and refused sit in
 * the same rows. A refusal carries its own mark and the predicate that stopped it,
 * and no error styling: it is the product working. The whole row opens the trade,
 * where the timestamps and attestations are.
 */

/** Column widths, shared by the header and every row so they line up. `Entry` needs room, so it waits for `xl`. */
const COL = {
  when: 'w-16',
  asset: 'w-[72px]',
  side: 'w-[68px]',
  size: 'w-20 items-end pr-2',
  entry: 'hidden w-24 items-end pr-3 xl:flex',
  result: 'min-w-0 flex-1',
  evidence: 'w-[76px] items-end',
} as const;

const KIND: Record<ActivityItem['kind'], { label: string; tone: 'neutral' | 'refused' | 'signal'; icon: 'check' | 'ban' | 'clock' | 'undo' }> = {
  executed: { label: 'Executed', tone: 'neutral', icon: 'check' },
  refused: { label: 'Refused', tone: 'refused', icon: 'ban' },
  proposed: { label: 'Proposed', tone: 'signal', icon: 'clock' },
  undone: { label: 'Undone', tone: 'neutral', icon: 'undo' },
};

const STAKE_RESULT = { won: 'Won', lost: 'Lost', refunded: 'Refunded' } as const;

const ROW = 'min-h-14 flex-row items-center gap-2 border-b border-hairline px-4 py-2.5 hover:bg-raised active:bg-raised';

function When({ at, now }: { at: number; now: number }) {
  return (
    <View className={cx('gap-0.5', COL.when)}>
      <Num className="text-11 text-bone">{tableDayLabel(at, now)}</Num>
      <Num className="text-11 text-ash">{timeLabel(at)}</Num>
    </View>
  );
}

/** A side is a glyph and a word, so direction never rests on colour. */
function Side({ up, label }: { up: boolean; label: string }) {
  return (
    <View className={cx('flex-row items-center gap-1', COL.side)}>
      <Icon name={up ? 'trending-up' : 'trending-down'} size={14} color={up ? 'long' : 'short'} />
      <Text className="font-sans text-12 text-bone">{label}</Text>
    </View>
  );
}

function EvidenceCell() {
  return (
    <View className={cx('flex-row items-center justify-end gap-1', COL.evidence)}>
      <Text className="font-mono-medium text-11 uppercase tracking-w08 text-verified">Evidence</Text>
      <Icon name="arrow-right" size={12} color="verified" strokeWidth={2} />
    </View>
  );
}

const TradeLine = memo(function TradeLine({ item, now }: { item: ActivityItem; now: number }) {
  const { tap } = useHaptics();
  const kind = KIND[item.kind];
  const base = item.asset.split('/')[0] ?? item.asset;
  const long = item.direction === 'long';
  return (
    <Link
      href={tradeRoute(item.id)}
      onPressIn={tap}
      aria-label={`${kind.label}: ${item.asset} ${long ? 'long' : 'short'}${item.kind === 'refused' ? `, blocked by ${item.refusedBy ?? 'your rule'}` : ''}. Open evidence.`}
      className={ROW}
    >
      <When at={item.at} now={now} />
      <Num className={cx('text-12 font-mono-medium', COL.asset)}>{item.asset}</Num>
      <Side up={long} label={long ? 'Long' : 'Short'} />
      <View className={cx('gap-0.5', COL.size)}>
        <Num className="text-12">{compactDecimal(item.size)}</Num>
        <Num className="text-11 text-ash">{base}</Num>
      </View>
      <View className={COL.entry}>
        <Num className="text-12">{priceLabel(item.entry)}</Num>
      </View>
      <View className={cx('gap-1', COL.result)}>
        <Badge label={kind.label} tone={kind.tone} icon={kind.icon} />
        {item.kind === 'refused' ? (
          <Text numberOfLines={2} className="break-all font-mono text-11 leading-[1.4] text-ash">
            {item.refusedBy ?? 'Your rule'}
          </Text>
        ) : null}
      </View>
      <EvidenceCell />
    </Link>
  );
});

const StakeLine = memo(function StakeLine({ record, now }: { record: Extract<LedgerRecord, { type: 'stake' }>; now: number }) {
  const { tap } = useHaptics();
  const { stake } = record;
  const up = stake.side === 'above';
  return (
    <Link
      href={routes.predict}
      onPressIn={tap}
      aria-label={`Prediction: ${stake.asset} ${up ? 'up' : 'down'} to ${priceLabel(stake.target)}. Open Predict.`}
      className={ROW}
    >
      <When at={record.at} now={now} />
      <Num className={cx('text-12 font-mono-medium', COL.asset)}>{stake.asset}</Num>
      <Side up={up} label={up ? 'Up' : 'Down'} />
      <View className={cx('gap-0.5', COL.size)}>
        <Num className="text-12">{stake.stake ? compactDecimal(stake.stake) : '—'}</Num>
        <Num className="text-11 text-ash">{monad.nativeCurrency.symbol}</Num>
      </View>
      <View className={COL.entry}>
        <Num className="text-12">{priceLabel(stake.target)}</Num>
      </View>
      <View className={cx('gap-1', COL.result)}>
        <Badge label={stake.result ? STAKE_RESULT[stake.result] : 'Open'} tone="neutral" icon="target" />
        <Text numberOfLines={1} className="font-mono text-11 text-ash">
          {`${stake.window} window`}
        </Text>
      </View>
      <View className={cx('flex-row items-center justify-end gap-1', COL.evidence)}>
        <Text className="font-mono-medium text-11 uppercase tracking-w08 text-verified">Market</Text>
        <Icon name="arrow-right" size={12} color="verified" strokeWidth={2} />
      </View>
    </Link>
  );
});

function Head() {
  const cell = (label: string, cls: string) => (
    <View className={cls}>
      <Label>{label}</Label>
    </View>
  );
  return (
    <View className="h-9 flex-row items-center gap-2 border-b border-hairline bg-raised/60 px-4">
      {cell('Day', COL.when)}
      {cell('Asset', COL.asset)}
      {cell('Side', COL.side)}
      {cell('Size', COL.size)}
      {cell('Entry', COL.entry)}
      {cell('Result', COL.result)}
      {cell('Proof', COL.evidence)}
    </View>
  );
}

const FILTER_EMPTY: Record<RecordFilter, { icon: 'history' | 'check-circle' | 'ban' | 'target'; title: string; body: string }> = {
  all: { icon: 'history', title: 'Nothing recorded yet', body: 'Setups put to your rule and predictions you take collect here.' },
  executed: { icon: 'check-circle', title: 'No executed trades', body: 'A trade that satisfies your rule is executed and lands here.' },
  refused: { icon: 'ban', title: 'No blocked trades', body: 'A good day: nothing broke your rule.' },
  predictions: { icon: 'target', title: 'No predictions taken', body: 'Stakes you take on the Predict tab are recorded here.' },
};

/**
 * The records pane: totals, the filter chips, the table. The chips sit above the
 * table so what they narrow is directly beneath them.
 */
export function RecordsPane({
  state,
  filter,
  onFilter,
  now,
}: {
  state: RecordsState;
  filter: RecordFilter;
  onFilter: (next: RecordFilter) => void;
  now: number;
}) {
  const all = state.status === 'ready' || state.status === 'demo' ? state.records : NO_RECORDS;
  const totals = useMemo(() => recordTotals(all), [all]);
  const rows = useMemo(() => filterRecords(all, filter), [all, filter]);
  const setups = totals.executed + totals.refused;
  const truncated = state.status === 'ready' && state.truncated;
  const empty = FILTER_EMPTY[state.status === 'empty' ? 'all' : filter];

  return (
    <View className="gap-4">
      <StatRow
        stats={[
          { label: 'Total', value: String(totals.all) },
          { label: 'Taken', value: String(totals.executed) },
          { label: 'Refused', value: String(totals.refused) },
          { label: 'Stakes', value: String(totals.predictions) },
        ]}
      />

      <View className="flex-row flex-wrap items-center gap-2" role="radiogroup" aria-label="Filter records">
        {RECORD_FILTERS.map((f) => (
          <FilterChip
            key={f.value}
            label={f.label}
            selected={filter === f.value}
            count={f.value === 'all' ? totals.all : totals[f.value === 'predictions' ? 'predictions' : f.value]}
            onPress={() => onFilter(f.value)}
          />
        ))}
        <Text className="ml-auto font-sans text-12 text-ash">{`${setups} setups put to your rule`}</Text>
      </View>

      <Card pad="none" className="overflow-hidden">
        {state.status === 'loading' ? (
          [0, 1, 2, 3, 4, 5].map((i) => <SkeletonRow key={i} />)
        ) : rows.length === 0 ? (
          <EmptyState
            icon={empty.icon}
            title={empty.title}
            body={empty.body}
            {...(state.status === 'empty'
              ? { action: { label: 'Build a rule', href: routes.create, primary: true } }
              : filter === 'predictions'
                ? { action: { label: 'Open Predict', href: routes.predict } }
                : {})}
          />
        ) : (
          <>
            <Head />
            {rows.map((r) =>
              r.type === 'trade' ? (
                <TradeLine key={r.id} item={r.item} now={now} />
              ) : (
                <StakeLine key={r.id} record={r} now={now} />
              ),
            )}
          </>
        )}
      </Card>

      {truncated ? (
        <Text className="font-sans text-12 text-ash">
          Showing your newest {RECORDS_LIMIT} trades. Older ones are still on-chain.
        </Text>
      ) : null}
    </View>
  );
}

const NO_RECORDS: LedgerRecord[] = [];
