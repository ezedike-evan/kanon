import { memo, useMemo } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { formatBps } from '@kanon/spec';
import { cx } from '../../lib/cx';
import { web } from '../../lib/desktop';
import { routes } from '../../lib/routes';
import {
  bookSpread,
  chainName,
  formatSpotPrice,
  formatSpotSize,
  marketEvidence,
  networkLabel,
  sizeLimits,
  tokenLine,
  type AddressRef,
  type SpotLevel,
  type SpotMarket,
} from '../../lib/spot';
import type { SpotUnavailable } from '../../lib/spot-reads';
import { formatClockTime } from '../../lib/timed-trade';
import { Badge } from '../badge';
import { Card } from '../card';
import { EmptyState } from '../empty-state';
import { Icon } from '../icons';
import { FOCUS, Facts, TxLink } from '../reel/trade-parts';
import { SectionHeader } from '../section-header';
import { Skeleton } from '../skeleton';
import { StatRow } from '../stat';
import { Num } from '../ui';

/*
 * What the spot screen shows of the market itself: its name with the labels
 * that say what it is, the best prices, the book, and the contracts and
 * transactions behind the listing.
 *
 * Two rules hold in every piece. The base token is a test token on a testnet
 * and is never drawn without a label saying so. And the book is the gateway's:
 * a side with nothing on it says so, and no level is ever filled in.
 */

/**
 * How many levels a side shows on a phone: enough to read the book, few enough
 * that both sides sit above the fold at 390 wide. From `lg` every level the
 * gateway sent is drawn.
 */
const PHONE_LEVELS = 4;

/**
 * The pair, the two labels that say what it is, and the gateway's one sentence
 * about its tokens. The labels are not optional: the base token is a test token
 * on a testnet, and its name alone would not say so.
 */
export function MarketHead({ market }: { market: SpotMarket }) {
  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-2">
        <Text role="heading" className="font-mono-medium text-24 tracking-t20 text-bone">
          {market.asset}
        </Text>
        <View className="flex-row flex-wrap gap-1.5">
          <Badge label="Test token" tone="signal" />
          <Badge label={networkLabel(market)} />
        </View>
      </View>
      {market.note ? <Text className="font-sans text-13 leading-5 text-bone">{market.note}</Text> : null}
    </View>
  );
}

/** The best bid and the best ask as the book last stood. A side with nothing on it says so. */
export function BestPrices({ market }: { market: SpotMarket }) {
  const tile = (label: string, level: SpotLevel | undefined) => ({
    label: `${label} in ${market.quote.symbol}`,
    value: level ? formatSpotPrice(level.price) : 'None',
  });
  return <StatRow stats={[tile('Best bid', market.bids[0]), tile('Best ask', market.asks[0])]} />;
}

const LevelRow = memo(function LevelRow({ level, side, extra }: { level: SpotLevel; side: 'ask' | 'bid'; extra: boolean }) {
  return (
    // Levels past the fourth are drawn from `lg` only, so both sides stay above the fold on a phone.
    <View className={cx('h-6 flex-row items-center justify-between gap-4 px-4', extra && cx('hidden', web('lg:flex')))}>
      <Num className={cx('text-13', side === 'ask' ? 'text-short' : 'text-long')}>{formatSpotPrice(level.price)}</Num>
      <Num className="text-13">{formatSpotSize(level.size)}</Num>
    </View>
  );
});

/** A side's name with its arrow: the colour on the prices under it never stands alone. */
function SideLabel({ side }: { side: 'ask' | 'bid' }) {
  const ask = side === 'ask';
  return (
    <View className="flex-row items-center gap-1.5 px-4 pb-1 pt-2">
      <Icon name={ask ? 'arrow-down' : 'arrow-up'} size={12} color={ask ? 'short' : 'long'} strokeWidth={2} />
      <Text className={cx('font-mono-bold text-11 tracking-w14', ask ? 'text-short' : 'text-long')}>{ask ? 'ASKS' : 'BIDS'}</Text>
      <Text className="font-mono text-11 text-ash">{ask ? 'offers to sell' : 'offers to buy'}</Text>
    </View>
  );
}

function NoLevels({ side }: { side: 'ask' | 'bid' }) {
  return (
    <Text className="px-4 py-2 font-sans text-12 leading-[18px] text-ash">
      {side === 'ask' ? 'No asks on the book right now.' : 'No bids on the book right now.'}
    </Text>
  );
}

/**
 * The book: asks above, bids below, the two best prices meeting at the spread
 * in the middle. Price and size only. `stale` says the newest read failed and
 * what is drawn is the last good one, with the time it is from.
 */
export const Book = memo(function Book({ market, stale }: { market: SpotMarket; stale: boolean }) {
  const spread = useMemo(() => bookSpread(market), [market]);
  // Best first as sent; drawn with the best ask at the foot of its block, beside the spread.
  const asks = useMemo(() => market.asks.map((level, i) => ({ level, i, extra: i >= PHONE_LEVELS })).reverse(), [market.asks]);
  return (
    <Card pad="none">
      <View className="flex-row items-center justify-between border-b border-hairline px-4 py-2">
        <Text className="font-mono text-11 text-ash">{`Price in ${market.quote.symbol}`}</Text>
        <Text className="font-mono text-11 text-ash">{`Size in ${market.base.symbol}`}</Text>
      </View>

      <SideLabel side="ask" />
      {asks.length === 0 ? (
        <NoLevels side="ask" />
      ) : (
        asks.map(({ level, i, extra }) => <LevelRow key={`${i}:${level.price.atoms}`} level={level} side="ask" extra={extra} />)
      )}

      <View className="mt-1 h-8 flex-row items-center justify-between border-y border-hairline bg-raised px-4">
        <Text className="font-mono text-11 text-ash">Spread</Text>
        <Num className="text-11 text-ash">
          {spread ? `${formatSpotPrice(spread.price)} ${market.quote.symbol}, ${formatBps(spread.bps)}` : 'none to state'}
        </Num>
      </View>

      <SideLabel side="bid" />
      {market.bids.length === 0 ? (
        <NoLevels side="bid" />
      ) : (
        market.bids.map((level, i) => (
          <LevelRow key={`${i}:${level.price.atoms}`} level={level} side="bid" extra={i >= PHONE_LEVELS} />
        ))
      )}

      <View className="mt-2 gap-1 border-t border-hairline px-4 py-2.5">
        <Num className="text-11 text-ash">{`Block ${market.blockNumber}, read at ${formatClockTime(market.readAt)}`}</Num>
        {stale ? (
          <Text role="status" className="font-sans text-12 leading-[18px] text-bone">
            The last read failed. This is the book as it stood then, not as it stands now.
          </Text>
        ) : null}
      </View>
    </Card>
  );
});

/** A contract's address, one press from its page on the explorer. With no explorer for the chain it is the address alone. */
export function AddressRow({ label, address, link, last }: { label: string; address: string; link: AddressRef | null; last: boolean }) {
  const row = cx('min-h-11 flex-row items-center justify-between gap-3 px-3.5', !last && 'border-b border-hairline');
  if (!link) {
    return (
      <View className={row}>
        <Text className="font-mono text-12 text-ash">{label}</Text>
        <Num className="shrink text-right text-12">{address}</Num>
      </View>
    );
  }
  return (
    <Pressable
      role="link"
      aria-label={`${label} ${link.short} on ${link.explorer}`}
      hitSlop={6}
      // A device with nothing to open a link with rejects; that is not this screen's to report.
      onPress={() => void Linking.openURL(link.url).catch(() => undefined)}
      className={cx(row, 'hover:bg-raised/60 active:bg-raised', FOCUS)}
    >
      <Text className="font-mono text-12 text-ash">{label}</Text>
      <View className="flex-row items-center gap-1.5">
        <Num className="text-12 text-verified">{link.short}</Num>
        <Icon name="arrow-up-right" size={14} color="verified" />
      </View>
    </Pressable>
  );
}

/**
 * Below the fold: who listed the market, the terms an order is held to, and the
 * contracts and transactions behind it, each one press from the explorer.
 */
export const ThisMarket = memo(function ThisMarket({ market }: { market: SpotMarket }) {
  const evidence = useMemo(() => marketEvidence(market), [market]);
  const terms: Array<readonly [string, string]> = [
    ['Order size', sizeLimits(market)],
    ['Taker fee', formatBps(market.takerFeeBps)],
    ['Order type', 'Market, fill or kill'],
    ['Chain', chainName(market.chainId)],
  ];
  return (
    <View className="gap-2.5">
      <SectionHeader title="This market" />
      <Text className="max-w-[640px] font-sans text-13 leading-5 text-ash">
        {`Kanon listed this market on Kuru's testnet order book. ${market.base.symbol} and ${market.quote.name} are test tokens that anyone can mint, and an order here is sent from your own wallet.`}
      </Text>
      {/* Each token as the gateway describes it: its symbol, its full name and what kind of token it is. */}
      <View className="gap-1">
        {[market.base, market.quote].map((token) => (
          <Text key={token.address} className="font-sans text-12 leading-[18px] text-bone">
            {tokenLine(token)}
          </Text>
        ))}
      </View>
      <Facts rows={terms} />
      <View className="rounded-sm border border-hairline bg-panel">
        {evidence.addresses.map((entry, i) => (
          <AddressRow
            key={entry.address}
            label={entry.label}
            address={entry.address}
            link={entry.ref}
            last={i === evidence.addresses.length - 1 && evidence.transactions.length === 0}
          />
        ))}
        {evidence.transactions.map((entry, i) => (
          <View key={entry.tx.hash} className={cx(i < evidence.transactions.length - 1 && 'border-b border-hairline')}>
            <TxLink tx={entry.tx} name={entry.name} />
          </View>
        ))}
      </View>
    </View>
  );
});

/** Loading, in the shape of what is coming: the name, the two best prices, the book. */
export function SpotSkeleton() {
  return (
    <View aria-busy aria-label="Reading the market" className="gap-6">
      <View className="gap-3">
        <Skeleton width={196} height={28} />
        <Skeleton width="84%" height={12} />
      </View>
      <Card pad="none" className="flex-row">
        {[0, 1].map((i) => (
          <View key={i} className={cx('flex-1 gap-2.5 p-3.5', i > 0 && 'border-l border-hairline')}>
            <Skeleton width={84} height={10} />
            <Skeleton width={128} height={20} />
          </View>
        ))}
      </Card>
      <Card pad="none" className="py-2">
        {Array.from({ length: 2 * PHONE_LEVELS }, (_, i) => (
          <View key={i} className="h-6 flex-row items-center justify-between px-4">
            <Skeleton width={92} height={10} />
            <Skeleton width={84} height={10} />
          </View>
        ))}
      </Card>
    </View>
  );
}

/**
 * There is no book to show, said in the words it came with. Nothing listed yet
 * is an ordinary answer and gets a way on; a read that failed says so and is
 * tried again by itself. Neither is styled as a fault.
 */
export function SpotUnavailable({ code, message }: { code: SpotUnavailable; message: string }) {
  if (code === 'not_listed') {
    return (
      <Card pad="none">
        <EmptyState icon="layers" title="Not listed yet" body={message} action={{ label: 'Open the chart', href: routes.chart }} />
      </Card>
    );
  }
  return (
    <Card pad="md" className="flex-row items-center gap-3">
      <Icon name="info" size={16} color="ash" />
      <Text role="status" className="flex-1 font-sans text-13 leading-5 text-bone">
        {message}
      </Text>
    </Card>
  );
}
