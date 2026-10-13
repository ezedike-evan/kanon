import { Text, View } from 'react-native';
import { AutopilotEvidenceRow } from '../autopilot';
import { Badge } from '../badge';
import { BottomSheet } from '../bottom-sheet';
import { SIDE_WORD, SideGlyph } from '../chart/chart-trades';
import { Icon } from '../icons';
import { TradeSheet } from '../reel/reel-trades';
import { DirectionMark, Facts, MoveMark, TxLink, TxMissing } from '../reel/trade-parts';
import { GhostButton, Num } from '../ui';
import { cx } from '../../lib/cx';
import type { LedgerRecord } from '../../lib/profile-logic';
import { routes } from '../../lib/routes';
import { countdownText, runningView } from '../../lib/timed-trade';
import type { TimedTrade } from '../../lib/timed-types';
import { chartTradeDetail, chartTradeView, runningFacts, type ChartTrade } from '../../lib/trade-records';
import { useCountdownClock, useDue } from '../../lib/use-clock';
import { NOT_REPORTED_YET } from '../../lib/venue-trade';

/*
 * The details of one record, as a bottom sheet over the list it was pressed in.
 * It is the one place in Profile a trade's result is stated: a row in the table
 * of its figures, in the same neutral type as the rest, above the transactions
 * that are its evidence.
 */

/**
 * Everything about one chart trade. The headline is the side taken and what the
 * price did between entry and exit. Its figures follow as a table, then each
 * order's settling transaction, oldest first.
 */
function ChartTradeSheet({ trade, onClose }: { trade: ChartTrade; onClose: () => void }) {
  const view = chartTradeView(trade);
  const detail = chartTradeDetail(trade);
  return (
    <BottomSheet open onClose={onClose} title={`TRADE · ${view.asset}`}>
      <View className="gap-4 pb-5">
        <View className="gap-2">
          <View className="flex-row items-center justify-between gap-3">
            <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-2 gap-y-1">
              {view.side ? (
                <View className="shrink-0 flex-row items-center gap-1">
                  <SideGlyph side={view.side} size={16} />
                  <Text className={cx('font-mono-bold text-13 tracking-w14', view.side === 'long' ? 'text-long' : 'text-short')}>
                    {SIDE_WORD[view.side]}
                  </Text>
                </View>
              ) : null}
              {view.terms ? <Num className="text-12 text-ash">{view.terms}</Num> : null}
            </View>
            <Badge label={view.state} size="md" className="self-center" />
          </View>
          <View className="flex-row flex-wrap items-baseline gap-x-2">
            {view.entry ? (
              <Num className={cx('font-mono-medium text-24 tracking-t25', view.entry === NOT_REPORTED_YET && 'text-13 text-ash')}>
                {view.entry}
              </Num>
            ) : null}
            {view.entry && view.exit ? <Icon name="arrow-right" size={16} color="ash" /> : null}
            {view.exit ? (
              <Num className={cx('font-mono-medium text-24 tracking-t25', view.exit === NOT_REPORTED_YET && 'text-13 text-ash')}>
                {view.exit}
              </Num>
            ) : null}
          </View>
          {view.move ? <MoveMark move={view.move} large /> : null}
          <Text className="font-sans text-13 leading-5 text-ash">{view.stateLine}</Text>
        </View>

        <Facts rows={detail.facts} />

        <View className="rounded-sm border border-hairline bg-panel">
          {detail.txs.map(({ name, tx }, i) => (
            <View key={name} className={cx(i > 0 && 'border-t border-hairline')}>
              {tx ? <TxLink tx={tx} name={name} /> : <TxMissing name={name} />}
            </View>
          ))}
        </View>
      </View>
    </BottomSheet>
  );
}

/**
 * A timed trade that is still running: what was called, the time it has left
 * and its entry, with its opening transaction. It carries no result, since it
 * has none yet, and no "end now": that is on Predict, one press from the foot,
 * where its countdown is watched. One autopilot opened also leads to the
 * proposal that is its evidence.
 *
 * A list sends a person's own running trade straight to Predict. This is what
 * a link to one trade opens (a proposal's "open the timed trade"), and what a
 * running trade autopilot opened shows when its row is pressed.
 */
function RunningTradeSheet({ trade, onClose }: { trade: TimedTrade; onClose: () => void }) {
  const due = useDue(trade.expiresAt);
  const now = useCountdownClock(trade.expiresAt);
  // Nothing is sent from here, so the row is read as locked: it only says where the trade stands.
  const row = runningView(trade, { due, sending: null, locked: true });
  const left = countdownText(trade.expiresAt, now);
  return (
    <BottomSheet
      open
      onClose={onClose}
      title={`TRADE · ${row.asset}`}
      footer={<GhostButton href={routes.predict}>WATCH ON PREDICT</GhostButton>}
    >
      <View className="gap-4 pb-5">
        <View className="gap-2">
          <View className="flex-row items-center justify-between gap-3">
            <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-2 gap-y-1">
              <DirectionMark direction={row.direction} large />
              <Num className="text-12 text-ash">{row.terms}</Num>
            </View>
            <Badge label={row.label} tone={row.closing ? 'neutral' : 'signal'} icon="timer" size="md" className="self-center" />
          </View>
          <View className="flex-row flex-wrap items-baseline gap-x-3 gap-y-1">
            <Text
              role="timer"
              aria-label={`Time left ${left}`}
              className="font-mono-medium text-24 tracking-t25 text-bone"
              style={{ fontVariant: ['tabular-nums'] }}
            >
              {left}
            </Text>
            <Num className="text-12 text-ash">{row.closesAt}</Num>
          </View>
          {row.note ? <Num className="text-12 leading-[18px] text-ash">{row.note}</Num> : null}
        </View>

        {trade.origin === 'autopilot' ? <AutopilotEvidenceRow proposalId={trade.proposalId} /> : null}

        <Facts rows={runningFacts(trade)} />

        <View className="rounded-sm border border-hairline bg-panel">
          {row.openTx ? <TxLink tx={row.openTx} name="Open" /> : <TxMissing name="Open" />}
        </View>
      </View>
    </BottomSheet>
  );
}

/**
 * The details of the record that was pressed, or nothing. A chart trade and a
 * timed trade have a sheet, the timed trade's being its finished details or,
 * while it runs, where it stands. A rule's trade opens its own screen.
 */
export function RecordSheet({ record, onClose }: { record: LedgerRecord | null; onClose: () => void }) {
  if (!record) return null;
  if (record.type === 'chart') return <ChartTradeSheet trade={record.trade} onClose={onClose} />;
  if (record.type !== 'timed') return null;
  return record.trade.status === 'closed' ? (
    <TradeSheet trade={record.trade} onClose={onClose} />
  ) : (
    <RunningTradeSheet trade={record.trade} onClose={onClose} />
  );
}
