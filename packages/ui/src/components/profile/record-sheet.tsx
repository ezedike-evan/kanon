import { Text, View } from 'react-native';
import { Badge } from '../badge';
import { BottomSheet } from '../bottom-sheet';
import { SIDE_WORD, SideGlyph } from '../chart/chart-trades';
import { Icon } from '../icons';
import { TradeSheet } from '../reel/reel-trades';
import { Facts, MoveMark, TxLink, TxMissing } from '../reel/trade-parts';
import { Num } from '../ui';
import { cx } from '../../lib/cx';
import type { LedgerRecord } from '../../lib/profile-logic';
import { chartTradeDetail, chartTradeView, type ChartTrade } from '../../lib/trade-records';
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
 * The details of the record that was pressed, or nothing. Only a chart trade
 * and a finished timed trade have a sheet: a rule's trade opens its own screen,
 * and a running timed trade is watched on Predict.
 */
export function RecordSheet({ record, onClose }: { record: LedgerRecord | null; onClose: () => void }) {
  if (!record) return null;
  if (record.type === 'chart') return <ChartTradeSheet trade={record.trade} onClose={onClose} />;
  if (record.type === 'timed' && record.trade.status === 'closed') return <TradeSheet trade={record.trade} onClose={onClose} />;
  return null;
}
