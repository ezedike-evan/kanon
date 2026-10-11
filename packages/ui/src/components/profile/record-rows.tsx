import { memo } from 'react';
import { ListRow } from '../list-row';
import type { ActivityItem } from '../../lib/domain-types';
import { monad } from '../../lib/monad-chain';
import { compactDecimal, priceLabel, timeLabel, type LedgerRecord, type StakeRecord } from '../../lib/profile-logic';
import { routes, tradeRoute } from '../../lib/routes';
import type { TimedTrade } from '../../lib/timed-types';
import { chartRowFigures, chartTradeView, timedRowView, type ChartTrade } from '../../lib/trade-records';

/**
 * One row of the trading record, whichever way the trade was taken. Each says
 * where it came from first (`Chart`, `Predict`, `Rule`), so three kinds of
 * trade read as one list. The Trading records screen draws these, and so does
 * the newest handful on the Profile tab.
 *
 * A row is a direction, a state and prices. It never carries money: a trade's
 * result is in its details, one press away, beside the transactions that are
 * its evidence. A refusal is the rule working, so it takes its own mark and no
 * error styling.
 */

/** The Trading records screen opened on one record's details. */
export const recordHref = (id: string) => `${routes.profileRecords}?open=${encodeURIComponent(id)}`;

const KIND_LABEL: Record<ActivityItem['kind'], string> = {
  executed: 'Executed',
  refused: 'Blocked',
  proposed: 'Proposed',
  undone: 'Undone',
};

const RESULT_LABEL = { won: 'WON', lost: 'LOST', refunded: 'REFUNDED' } as const;

interface RowProps {
  /** Opens a record's details in place. Left out, the row goes to the Trading records screen opened on it. */
  onOpen?: ((id: string) => void) | undefined;
  divider?: boolean | undefined;
}

/** In place when the screen can show the details itself; otherwise a link to the screen that can. */
const opening = (id: string, onOpen: RowProps['onOpen']) =>
  onOpen ? { onPress: () => onOpen(id) } : { href: recordHref(id) };

const RuleRow = memo(function RuleRow({ item, divider }: { item: ActivityItem; divider?: boolean | undefined }) {
  const refused = item.kind === 'refused';
  const base = item.asset.split('/')[0] ?? item.asset;
  const long = item.direction === 'long';
  return (
    <ListRow
      leading={refused ? 'ban' : long ? 'trending-up' : 'trending-down'}
      leadingTone={refused ? 'refused' : long ? 'long' : 'short'}
      title={`${item.asset} · ${long ? 'Long' : 'Short'}`}
      subtitle={
        refused
          ? `Rule · Blocked by ${item.refusedBy ?? 'your rule'} · ${timeLabel(item.at)}`
          : `Rule · ${KIND_LABEL[item.kind]} · ${timeLabel(item.at)}`
      }
      value={priceLabel(item.entry)}
      valueSub={`${compactDecimal(item.size)} ${base}`}
      href={tradeRoute(item.id)}
      divider={divider}
    />
  );
});

const StakeRow = memo(function StakeRow({ stake, divider }: { stake: StakeRecord; divider?: boolean | undefined }) {
  return (
    <ListRow
      leading="target"
      title={`${stake.asset} · ${stake.side === 'above' ? 'Up' : 'Down'}`}
      subtitle={`Market · Reaches ${priceLabel(stake.target)} · ${stake.window} window · ${timeLabel(stake.at)}`}
      value={stake.stake ? `${compactDecimal(stake.stake)} ${monad.nativeCurrency.symbol}` : '—'}
      valueSub={stake.result ? RESULT_LABEL[stake.result] : 'OPEN'}
      href={routes.predict}
      divider={divider}
    />
  );
});

const ChartRow = memo(function ChartRow({ id, trade, onOpen, divider }: RowProps & { id: string; trade: ChartTrade }) {
  const view = chartTradeView(trade);
  const figures = chartRowFigures(view);
  const terms = view.terms ?? view.size;
  return (
    <ListRow
      leading={view.side === 'long' ? 'trending-up' : view.side === 'short' ? 'trending-down' : 'history'}
      leadingTone={view.side ?? 'neutral'}
      title={`${view.asset} · ${view.sideWord}`}
      subtitle={`Chart · ${terms ? `${terms} · ` : ''}${timeLabel(view.at)}`}
      value={figures.value}
      valueSub={figures.sub}
      divider={divider}
      {...opening(id, onOpen)}
    />
  );
});

const TimedRow = memo(function TimedRow({ id, trade, onOpen, divider }: RowProps & { id: string; trade: TimedTrade }) {
  const view = timedRowView(trade);
  return (
    <ListRow
      leading={view.direction === 'up' ? 'trending-up' : 'trending-down'}
      leadingTone={view.direction === 'up' ? 'long' : 'short'}
      title={`${view.asset} · ${view.word}`}
      subtitle={`Predict · ${view.terms} · ${timeLabel(view.at)}`}
      value={view.figures.value}
      valueSub={view.figures.sub}
      divider={divider}
      // A running trade is watched where its countdown is; a finished one has details.
      {...(view.running ? { href: routes.predict } : opening(id, onOpen))}
    />
  );
});

export const RecordRow = memo(function RecordRow({ record, onOpen, divider }: RowProps & { record: LedgerRecord }) {
  switch (record.type) {
    case 'trade':
      return <RuleRow item={record.item} divider={divider} />;
    case 'stake':
      return <StakeRow stake={record.stake} divider={divider} />;
    case 'chart':
      return <ChartRow id={record.id} trade={record.trade} onOpen={onOpen} divider={divider} />;
    case 'timed':
      return <TimedRow id={record.id} trade={record.trade} onOpen={onOpen} divider={divider} />;
  }
});
