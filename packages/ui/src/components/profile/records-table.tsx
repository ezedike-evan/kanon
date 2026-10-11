import { memo, useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Badge } from '../badge';
import { Card } from '../card';
import { FilterChip } from '../chip';
import { EmptyState, type EmptyStateProps } from '../empty-state';
import { Icon } from '../icons';
import { FOCUS, MoveMark } from '../reel/trade-parts';
import { SkeletonRow } from '../skeleton';
import { Label, StatRow, type StatTileProps } from '../stat';
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
  type RecordTotals,
} from '../../lib/profile-logic';
import { routes, tradeRoute } from '../../lib/routes';
import { chartTradeView, timedRowView, type ChartTrade } from '../../lib/trade-records';
import type { PriceMove } from '../../lib/timed-trade';
import type { TimedTrade } from '../../lib/timed-types';
import { useHaptics } from '../../platform';
import type { ActivityItem } from '../../lib/domain-types';

/**
 * Trading records as a table, for the desktop pane: when, what and where from,
 * which way, how much, what came of it, and the way to the evidence. Trades from
 * the chart, from Predict and through the rule sit in the same rows, each naming
 * its source under its asset. A refusal carries its own mark and the predicate
 * that stopped it, and no error styling: it is the product working.
 *
 * No row carries money. What came of a trade is its state and what the price did
 * between entry and exit. The whole row opens the trade: a rule's trade goes to
 * its evidence screen, a chart trade and a finished timed trade open their
 * details over the table.
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

const ROW = cx(
  'min-h-14 flex-row items-center gap-2 border-b border-hairline px-4 py-2.5 hover:bg-raised active:bg-raised',
  FOCUS,
);

function When({ at, now }: { at: number; now: number }) {
  return (
    <View className={cx('gap-0.5', COL.when)}>
      <Num className="text-11 text-bone">{tableDayLabel(at, now)}</Num>
      <Num className="text-11 text-ash">{timeLabel(at)}</Num>
    </View>
  );
}

/** The asset, and under it where the trade came from: `CHART`, `PREDICT`, `RULE`, `MARKET`. */
function Asset({ asset, source }: { asset: string; source: string }) {
  return (
    <View className={cx('gap-0.5', COL.asset)}>
      <Num className="font-mono-medium text-12">{asset}</Num>
      <Text className="font-mono text-10 uppercase tracking-w08 text-ash">{source}</Text>
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

function EvidenceCell({ label = 'Evidence' }: { label?: string }) {
  return (
    <View className={cx('flex-row items-center justify-end gap-1', COL.evidence)}>
      <Text className="font-mono-medium text-11 uppercase tracking-w08 text-verified">{label}</Text>
      <Icon name="arrow-right" size={12} color="verified" strokeWidth={2} />
    </View>
  );
}

/** What came of a trade: its state, and under it the exit with how far the price moved. */
function Outcome({ state, exit, move }: { state: string; exit: string | null; move: PriceMove | null }) {
  return (
    <View className={cx('items-start gap-1', COL.result)}>
      <Badge label={state} />
      {exit ? (
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
          <View className="flex-row items-center gap-1">
            <Icon name="arrow-right" size={12} color="ash" />
            <Num className={cx('text-11', !move && 'text-ash')}>{exit}</Num>
          </View>
          {move ? <MoveMark move={move} /> : null}
        </View>
      ) : null}
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
      <Asset asset={item.asset} source="Rule" />
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
      <Asset asset={stake.asset} source="Market" />
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

const ChartLine = memo(function ChartLine({
  id,
  trade,
  now,
  onOpen,
}: {
  id: string;
  trade: ChartTrade;
  now: number;
  onOpen: (id: string) => void;
}) {
  const { tap } = useHaptics();
  const view = chartTradeView(trade);
  const [amount = '—', unit = ''] = (view.size ?? '').split(' ');
  return (
    <Pressable role="button" aria-label={view.accessibilityLabel} onPressIn={tap} onPress={() => onOpen(id)} className={ROW}>
      <When at={view.at} now={now} />
      <Asset asset={view.asset} source="Chart" />
      {view.side ? (
        <Side up={view.side === 'long'} label={view.sideWord} />
      ) : (
        <Text className={cx('font-sans text-12 text-ash', COL.side)}>{view.sideWord}</Text>
      )}
      <View className={cx('gap-0.5', COL.size)}>
        <Num className="text-12">{amount}</Num>
        <Num className="text-11 text-ash">{unit}</Num>
      </View>
      <View className={COL.entry}>
        <Num className="text-12">{view.entry ?? '—'}</Num>
      </View>
      <Outcome state={view.state} exit={view.exit} move={view.move} />
      <EvidenceCell label="Details" />
    </Pressable>
  );
});

const TimedLine = memo(function TimedLine({
  id,
  trade,
  now,
  onOpen,
}: {
  id: string;
  trade: TimedTrade;
  now: number;
  onOpen: (id: string) => void;
}) {
  const { tap } = useHaptics();
  const view = timedRowView(trade);
  const [stake = '', ...terms] = view.terms.split(' · ');
  const cells = (
    <>
      <When at={view.at} now={now} />
      <Asset asset={view.asset} source="Predict" />
      <Side up={view.direction === 'up'} label={view.word} />
      <View className={cx('gap-0.5', COL.size)}>
        <Num className="text-12">{stake}</Num>
        <Num className="text-11 text-ash">{terms.join(' · ')}</Num>
      </View>
      <View className={COL.entry}>
        <Num className="text-12">{view.entry}</Num>
      </View>
      <Outcome state={view.state} exit={view.exit} move={view.move} />
      <EvidenceCell label={view.running ? 'Predict' : 'Details'} />
    </>
  );
  // A running trade is watched where its countdown is; a finished one has details.
  return view.running ? (
    <Link href={routes.predict} onPressIn={tap} aria-label={view.accessibilityLabel} className={ROW}>
      {cells}
    </Link>
  ) : (
    <Pressable role="button" aria-label={view.accessibilityLabel} onPressIn={tap} onPress={() => onOpen(id)} className={ROW}>
      {cells}
    </Pressable>
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

/** What an empty list says under each filter, and the way to fill it. Shared with the phone's list. */
export const RECORD_EMPTY: Record<
  RecordFilter,
  Pick<EmptyStateProps, 'icon' | 'title' | 'body'> & { action?: NonNullable<EmptyStateProps['action']> }
> = {
  all: {
    icon: 'history',
    title: 'Nothing recorded yet',
    body: 'Trades you take on the chart, on Predict and through your rule collect here, each with its transactions.',
    action: { label: 'Open the chart', href: routes.chart, primary: true },
  },
  chart: {
    icon: 'trending-up',
    title: 'No chart trades',
    body: 'A position you open from the chart is listed here, with its entry, its exit and every transaction.',
    action: { label: 'Open the chart', href: routes.chart },
  },
  predictions: {
    icon: 'target',
    title: 'No Predict trades',
    body: 'A pair called up or down for a set time is listed here, running or finished.',
    action: { label: 'Open Predict', href: routes.predict },
  },
  executed: {
    icon: 'check-circle',
    title: 'No trades through your rule',
    body: 'A setup that satisfies your pinned rule is executed and lands here.',
    action: { label: 'Build a rule', href: routes.create },
  },
  refused: { icon: 'ban', title: 'No blocked trades', body: 'A good day: nothing broke your rule.' },
};

/** The four counts above the record: everything, then one per way of trading. Counts, never money. */
export function recordStats(totals: RecordTotals): StatTileProps[] {
  return [
    { label: 'Total', value: String(totals.all) },
    { label: 'Chart', value: String(totals.chart) },
    { label: 'Predict', value: String(totals.predictions) },
    { label: 'Rule', value: String(totals.executed + totals.refused) },
  ];
}

/**
 * The records pane: totals, the filter chips, the table. The chips sit above the
 * table so what they narrow is directly beneath them.
 */
export function RecordsPane({
  state,
  filter,
  onFilter,
  onOpen,
  now,
}: {
  state: RecordsState;
  filter: RecordFilter;
  onFilter: (next: RecordFilter) => void;
  /** Opens a record's details: the screen holds the sheet. */
  onOpen: (id: string) => void;
  now: number;
}) {
  const all = state.status === 'ready' || state.status === 'demo' ? state.records : NO_RECORDS;
  const totals = useMemo(() => recordTotals(all), [all]);
  const rows = useMemo(() => filterRecords(all, filter), [all, filter]);
  const setups = totals.executed + totals.refused;
  const truncated = state.status === 'ready' && state.truncated;
  const empty = RECORD_EMPTY[state.status === 'empty' ? 'all' : filter];

  return (
    <View className="gap-4">
      <StatRow stats={recordStats(totals)} />

      <View className="flex-row flex-wrap items-center gap-2" role="radiogroup" aria-label="Filter records">
        {RECORD_FILTERS.map((f) => (
          <FilterChip
            key={f.value}
            label={f.label}
            selected={filter === f.value}
            count={totals[f.value]}
            onPress={() => onFilter(f.value)}
          />
        ))}
        <Text className="ml-auto font-sans text-12 text-ash">{`${setups} setups put to your rule`}</Text>
      </View>

      <Card pad="none" className="overflow-hidden">
        {state.status === 'loading' ? (
          [0, 1, 2, 3, 4, 5].map((i) => <SkeletonRow key={i} />)
        ) : rows.length === 0 ? (
          <EmptyState icon={empty.icon} title={empty.title} body={empty.body} {...(empty.action ? { action: empty.action } : {})} />
        ) : (
          <>
            <Head />
            {rows.map((r) => {
              switch (r.type) {
                case 'trade':
                  return <TradeLine key={r.id} item={r.item} now={now} />;
                case 'stake':
                  return <StakeLine key={r.id} record={r} now={now} />;
                case 'chart':
                  return <ChartLine key={r.id} id={r.id} trade={r.trade} now={now} onOpen={onOpen} />;
                case 'timed':
                  return <TimedLine key={r.id} id={r.id} trade={r.trade} now={now} onOpen={onOpen} />;
              }
            })}
          </>
        )}
      </Card>

      {truncated ? (
        <Text className="font-sans text-12 text-ash">
          Showing the newest {RECORDS_LIMIT} of each kind. Older ones are still on-chain.
        </Text>
      ) : null}
    </View>
  );
}

const NO_RECORDS: LedgerRecord[] = [];
