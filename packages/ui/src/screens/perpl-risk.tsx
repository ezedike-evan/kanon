import { memo, useMemo } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Badge } from '../components/badge';
import { Card } from '../components/card';
import { SIDE_WORD, SideGlyph } from '../components/chart/chart-trades';
import { Body, Screen, StatusBar, TabBar } from '../components/chrome';
import { EmptyState } from '../components/empty-state';
import { Icon } from '../components/icons';
import { SubHeader } from '../components/profile-parts';
import { FOCUS, Facts } from '../components/reel/trade-parts';
import { SectionHeader } from '../components/section-header';
import { Skeleton } from '../components/skeleton';
import { StatRow } from '../components/stat';
import { Num } from '../components/ui';
import { Link } from '../nav';
import { cx } from '../lib/cx';
import { usePerplRisk, useSession, useVenueAccount } from '../lib/domains';
import {
  FLAG_LABEL,
  LEVEL_LABEL,
  accountRisk,
  flagLine,
  formatAusdAmount,
  formatBpsPercent,
  formatFee,
  formatFundingRate,
  formatFundingYearly,
  formatInterval,
  formatRiskPrice,
  formatUsdWhole,
  fundingDirection,
  marketRisks,
  positionLine,
  positionRisks,
  type MarketRisk,
  type PositionRisk,
  type RiskMarketTerms,
} from '../lib/perpl-risk';
import { routes } from '../lib/routes';
import { formatClockTime } from '../lib/timed-trade';
import { useNowMs } from '../lib/use-now';
import { formatLeverage, formatVenueSize } from '../lib/venue-trade';
import type { VenuePositionView } from '../lib/venue-types';

/**
 * 16 · PERPL RISK.
 *
 * What the venue's own data says about risk, live: every Perpl market with its
 * funding, its book and its margin terms, and each position on the trading
 * account with the price it is liquidated at and how far the mark is from
 * there. Markets are public data, so a visitor sees them too; the account is
 * for someone signed in.
 *
 * Risk is said as a price and a distance, never as money made or lost. The
 * liquidation price is Perpl's published formula, before funding, and the note
 * at the foot says so and links to it.
 */

const PERPL_LIQUIDATION_DOCS = 'https://docs.perpl.xyz/exchange/liquidation';

const NO_TERMS: RiskMarketTerms[] = [];
const NO_POSITIONS: VenuePositionView[] = [];

/** A signed move with its arrow: direction colour never stands alone. */
function Move({ bps }: { bps: number }) {
  if (bps === 0) return <Num className="text-11 text-ash">0.00%</Num>;
  const up = bps > 0;
  return (
    <View className="flex-row items-center gap-1">
      <Icon name={up ? 'arrow-up' : 'arrow-down'} size={12} color={up ? 'long' : 'short'} strokeWidth={2} />
      <Num className={cx('text-11', up ? 'text-long' : 'text-short')}>{formatBpsPercent(Math.abs(bps))}</Num>
    </View>
  );
}

/** How much of the way from entry to liquidation the mark has gone, as a bar with its level beside it. */
function Meter({ risk }: { risk: PositionRisk }) {
  if (risk.usedBps === null || risk.level === null) return null;
  const used = Math.max(0, Math.min(10_000, risk.usedBps));
  const near = risk.level === 'near';
  return (
    <View
      role="meter"
      aria-label={`${Math.round(used / 100)} percent of the way from entry to liquidation`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(used / 100)}
      className="flex-row items-center gap-2.5"
    >
      <View className="h-1 flex-1 overflow-hidden rounded-xs bg-raised">
        <View className={cx('h-full', near ? 'bg-short' : 'bg-bone')} style={{ width: `${used / 100}%` }} />
      </View>
      <Badge label={LEVEL_LABEL[risk.level]} tone={near ? 'short' : 'neutral'} />
    </View>
  );
}

const PositionRow = memo(function PositionRow({ risk, last }: { risk: PositionRisk; last: boolean }) {
  return (
    <View className={cx('gap-2.5 px-4 py-3.5', !last && 'border-b border-hairline')}>
      <View className="flex-row items-center justify-between gap-3">
        <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
          <View className="flex-row items-center gap-1">
            <SideGlyph side={risk.side} size={12} />
            <Text className={cx('font-mono-bold text-11 tracking-w14', risk.side === 'long' ? 'text-long' : 'text-short')}>
              {SIDE_WORD[risk.side]}
            </Text>
          </View>
          <Text className="font-mono-medium text-13 text-bone">{risk.asset}</Text>
          <Num className="text-11 text-ash">{`${formatVenueSize(risk.size, risk.asset)} · ${formatLeverage(risk.leverage)}`}</Num>
        </View>
        <View className="items-end">
          <Num className="text-10 uppercase tracking-w10 text-ash">Liquidation</Num>
          <Num className="font-mono-medium text-15 tracking-t20">
            {risk.liquidation ? formatRiskPrice(risk.liquidation) : '—'}
          </Num>
        </View>
      </View>
      <Meter risk={risk} />
      <View className="flex-row flex-wrap gap-x-4 gap-y-0.5">
        <Num className="text-11 text-ash">{`entry ${formatRiskPrice(risk.entryPrice)}`}</Num>
        <Num className="text-11 text-ash">{`mark ${risk.mark ? formatRiskPrice(risk.mark) : 'not stated'}`}</Num>
        <Num className="text-11 text-ash">{`margin ${formatAusdAmount(risk.collateral)}`}</Num>
      </View>
      <Text className="font-sans text-12 leading-[18px] text-ash">{positionLine(risk)}</Text>
    </View>
  );
});

const MarketCard = memo(function MarketCard({ market }: { market: MarketRisk }) {
  const funding: Array<readonly [string, string]> = [
    [
      `Funding / ${formatInterval(market.fundingInterval)}`,
      `${formatFundingRate(market.fundingRate)} · ${fundingDirection(market.fundingRate).toLowerCase()}`,
    ],
    ['Funding a year', market.fundingYearly === null ? '—' : formatFundingYearly(market.fundingYearly)],
    ['Open interest', market.openInterestUsd ? formatUsdWhole(market.openInterestUsd) : '—'],
    ['Volume, 24h', market.volumeUsd ? formatUsdWhole(market.volumeUsd) : '—'],
    ['Book width', market.spreadBps === null ? '—' : formatBpsPercent(market.spreadBps)],
    ['Mark to oracle', market.basisBps === null ? '—' : formatBpsPercent(market.basisBps, { signed: true })],
    ['Margin kept', `${formatBpsPercent(market.maintenanceBps)} · max ${market.maxLeverage}x`],
    ['Taker fee', formatFee(market.takerFee)],
  ];
  return (
    <Card pad="md" className="gap-3">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1 gap-1.5">
          <Text role="heading" className="font-mono-medium text-13 text-bone">
            {market.asset}
          </Text>
          {market.flags.length > 0 ? (
            <View className="flex-row flex-wrap gap-1.5">
              {market.flags.map((flag) => (
                <Badge key={flag} label={FLAG_LABEL[flag]} />
              ))}
            </View>
          ) : null}
        </View>
        <View className="items-end gap-0.5">
          <Num className="font-mono-medium text-18 tracking-t20">{market.mark ? formatRiskPrice(market.mark) : '—'}</Num>
          {market.dayMoveBps === null ? (
            <Num className="text-11 text-ash">no day-old price</Num>
          ) : (
            <View className="flex-row items-center gap-1.5">
              <Move bps={market.dayMoveBps} />
              <Num className="text-10 text-ash">24H</Num>
            </View>
          )}
        </View>
      </View>
      <Facts rows={funding} dense />
    </Card>
  );
});

/** What is worth a look right now, each line with its figure. Calm when there is nothing. */
function WorthALook({ risks, markets, ready }: { risks: readonly PositionRisk[]; markets: readonly MarketRisk[]; ready: boolean }) {
  const lines = useMemo(() => {
    const out: Array<{ key: string; text: string; near: boolean }> = [];
    for (const r of risks) {
      if (r.level === 'near' || r.level === 'watch') {
        out.push({ key: `p:${r.asset}:${r.side}`, text: `${r.asset} ${r.side}: ${positionLine(r)}`, near: r.level === 'near' });
      }
    }
    for (const m of markets) for (const flag of m.flags) out.push({ key: `m:${m.id}:${flag}`, text: flagLine(m, flag), near: false });
    return out;
  }, [risks, markets]);

  if (!ready) return null;
  return (
    <View className="gap-2.5">
      <SectionHeader title="Worth a look" {...(lines.length > 0 ? { count: lines.length } : {})} />
      <Card pad="none">
        {lines.length === 0 ? (
          <View className="flex-row items-center gap-3 px-4 py-3.5">
            <Icon name="shield-check" size={16} color="ash" />
            <Text className="flex-1 font-sans text-13 leading-5 text-ash">
              Nothing is flagged. No position is half-way to its liquidation price, and every book, mark and funding
              rate is inside its usual range.
            </Text>
          </View>
        ) : (
          lines.map((line, i) => (
            <View
              key={line.key}
              className={cx('flex-row items-center gap-3 px-4 py-3', i < lines.length - 1 && 'border-b border-hairline')}
            >
              <Icon name="info" size={16} color={line.near ? 'short' : 'ash'} />
              <Text className="flex-1 font-sans text-13 leading-5 text-bone">{line.text}</Text>
            </View>
          ))
        )}
      </Card>
    </View>
  );
}

export function PerplRiskScreen() {
  const feed = usePerplRisk();
  const account = useVenueAccount();
  const session = useSession();
  const now = useNowMs();

  const terms = feed.status === 'ready' ? feed.markets : NO_TERMS;
  const markets = useMemo(() => marketRisks(terms, now), [terms, now]);
  const view = account.state;
  const positions = view.status === 'ready' ? view.positions : NO_POSITIONS;
  const risks = useMemo(() => positionRisks(positions, markets, terms), [positions, markets, terms]);
  const summary = useMemo(() => (view.status === 'ready' ? accountRisk(view.balance, risks) : null), [view, risks]);
  const newest = useMemo(() => markets.reduce((latest, m) => Math.max(latest, m.at ?? 0), 0), [markets]);

  return (
    <Screen size="column" desktop="wide" label="16 · PERPL RISK">
      <StatusBar />
      <SubHeader
        title="Perpl risk"
        right={view.status === 'ready' ? <Badge label={view.network === 'testnet' ? 'Testnet' : 'Mainnet'} /> : null}
      />
      <Body contentClassName="gap-6 pb-8 pt-2">
        <Text className="max-w-[640px] font-sans text-13 leading-5 text-ash">
          Every Perpl market and every open position, read from the venue as it changes: where each position is
          liquidated, how far the mark is from there, and which books, marks and funding rates are out of line.
        </Text>

        <WorthALook risks={risks} markets={markets} ready={feed.status === 'ready'} />

        <View className="gap-2.5">
          <SectionHeader title="The account" {...(positions.length > 0 ? { count: positions.length } : {})} />
          {session.pending || view.status === 'loading' ? (
            <Skeleton height={84} />
          ) : !session.signedIn ? (
            <Card pad="none">
              <EmptyState
                icon="wallet"
                title="Sign in to see the account"
                body="Its positions, the price each is liquidated at and how far the mark is from there. The markets below need no account."
                action={{ label: 'Sign in', href: routes.landing, primary: true }}
              />
            </Card>
          ) : view.status === 'unavailable' ? (
            // The account's own words for why it cannot be read.
            <Card pad="md">
              <Text className="font-sans text-13 leading-5 text-ash">{view.message}</Text>
            </Card>
          ) : summary ? (
            <>
              <StatRow
                stats={[
                  { label: 'Free', value: formatAusdAmount(summary.free).replace(' AUSD', ''), unit: 'AUSD' },
                  { label: 'In positions', value: formatAusdAmount(summary.locked).replace(' AUSD', ''), unit: 'AUSD' },
                  { label: 'Exposure', value: summary.exposure ? formatUsdWhole(summary.exposure) : '—', sub: 'at the mark' },
                  { label: 'Flagged', value: String(summary.flagged), sub: `of ${summary.positions}` },
                ]}
              />
              <Text className="font-sans text-12 leading-[18px] text-ash">
                One {view.network} account, shared by everyone signed in. Margin is per position: a position can lose
                its own margin and no more.
              </Text>
              <Card pad="none">
                {risks.length === 0 ? (
                  <Text className="px-4 py-3.5 font-sans text-13 leading-5 text-ash">No open positions.</Text>
                ) : (
                  risks.map((risk, i) => (
                    <PositionRow key={`${risk.asset}:${risk.side}`} risk={risk} last={i === risks.length - 1} />
                  ))
                )}
              </Card>
            </>
          ) : null}
        </View>

        <View className="gap-2.5">
          <SectionHeader title="Markets" {...(markets.length > 0 ? { count: markets.length } : {})} />
          {feed.status === 'loading' ? (
            <View aria-busy aria-label="Reading Perpl's markets" className="gap-3">
              <Skeleton height={168} />
              <Skeleton height={168} />
            </View>
          ) : feed.status === 'unavailable' ? (
            <Card pad="md">
              <Text role="status" className="font-sans text-13 leading-5 text-ash">
                {feed.message}
              </Text>
            </Card>
          ) : markets.length === 0 ? (
            <Card pad="md">
              <Text className="font-sans text-13 leading-5 text-ash">Perpl lists no markets right now.</Text>
            </Card>
          ) : (
            <>
              <Text className="font-sans text-12 leading-[18px] text-ash">
                Perpl&apos;s public market data{newest > 0 ? `, last stamped at ${formatClockTime(newest)}` : ''}. Read
                again every few seconds while this screen is open.
              </Text>
              <View className="gap-3 lg:flex-row lg:flex-wrap">
                {markets.map((market) => (
                  <View key={market.id} className="lg:w-[calc(50%-6px)]">
                    <MarketCard market={market} />
                  </View>
                ))}
              </View>
            </>
          )}
        </View>

        <Card pad="md" className="gap-2">
          <Text className="font-mono-medium text-11 uppercase tracking-w10 text-bone">How this is worked out</Text>
          <Text className="font-sans text-12 leading-[18px] text-ash">
            The liquidation price is Perpl&apos;s own formula: the entry price, moved by the margin the market makes a
            position keep less the margin it holds, per unit of size. It is stated before funding, which the venue
            adds to or takes from a position over time. Funding a year is one funding event&apos;s rate carried over a
            year at the market&apos;s interval. Nothing on this screen is estimated from anything but the venue&apos;s
            figures.
          </Text>
          <Pressable
            role="link"
            aria-label="Perpl's documentation on liquidation"
            onPress={() => void Linking.openURL(PERPL_LIQUIDATION_DOCS).catch(() => undefined)}
            className={cx('flex-row items-center gap-1.5 self-start py-1 active:opacity-70', FOCUS)}
          >
            <Text className="font-mono-medium text-11 uppercase tracking-w08 text-verified">Perpl&apos;s formula</Text>
            <Icon name="external-link" size={12} color="verified" />
          </Pressable>
        </Card>

        <Link href={routes.profileRecords} aria-label="Open your trading records" className={cx('self-start py-1', FOCUS)}>
          <Text className="font-mono-medium text-11 uppercase tracking-w08 text-verified">Your trading records</Text>
        </Link>
      </Body>
      <TabBar active="profile" />
    </Screen>
  );
}
