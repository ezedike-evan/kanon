import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Share, Text, View, type LayoutChangeEvent, type ViewToken } from 'react-native';
import { abbreviateHash, type MarketSide } from '@kanon/spec';
import { Screen, StatusBar, TabBar } from '../components/chrome';
import { ReelPage, type TakenNote } from '../components/reel/reel-page';
import { TopBar } from '../components/reel/reel-parts';
import { EvidenceSheet, InfoSheet, StakeSheet } from '../components/reel/reel-sheets';
import { ReelEmpty, ReelEnd, ReelSkeleton } from '../components/reel/reel-states';
import { useKanonSelector } from '../lib/data';
import { formatAmount } from '../lib/predict-map';
import { reelDemoMarkets } from '../lib/predict-demo';
import {
  DEFAULT_STAKE_INDEX,
  NO_FILTER,
  advanceIndex,
  assetOptions,
  filterMarkets,
  indexOfItem,
  nextTimeframe,
  pageState,
  questionText,
  reelItems,
  stakeAt,
  timeframeOptions,
  type ReelFilter,
  type ReelItem,
} from '../lib/predict-reel';
import { STAKE_PRESETS, type PredictMarket } from '../lib/predict-types';
import { isWeb, useHaptics } from '../platform';

/**
 * 11 · PREDICT.
 *
 * A vertical feed you swipe through like reels: one threshold market per
 * screen, each a plain question, the asset's line with the level across it, a
 * ring of time left, and two big sides in the thumb zone. A tap on UP or DOWN
 * opens a small sheet with three stakes and a confirm; a confirmed stake moves
 * on to the next market.
 *
 * What was here before (stake presets on every card, a ladder, terms lines, a
 * hash link) is behind the rail now: evidence, share, and how it settles. The
 * result of a market is `settleThreshold` in `@kanon/spec` and nothing on this
 * screen decides it.
 */

type Sheet =
  | { kind: 'stake'; marketId: string; side: MarketSide }
  | { kind: 'evidence'; marketId: string }
  | { kind: 'info'; marketId: string };

const VIEWABILITY = { itemVisiblePercentThreshold: 60 } as const;

export function PredictScreen() {
  const usePredict = useKanonSelector((s) => s.usePredict);
  const feed = usePredict();
  const { tap, success } = useHaptics();

  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [filter, setFilter] = useState<ReelFilter>(NO_FILTER);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [stakeIdx, setStakeIdx] = useState(DEFAULT_STAKE_INDEX);
  const [busy, setBusy] = useState(false);
  const [sheetMessage, setSheetMessage] = useState<string | null>(null);
  const [taken, setTaken] = useState<Record<string, TakenNote>>({});
  // Markets the contract itself says are crossed: closed to new sides, and not a fault.
  const [crossed, setCrossed] = useState<Record<string, true>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [swiped, setSwiped] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const listRef = useRef<FlatList<ReelItem>>(null);
  const isDemo = feed.state === 'demo';

  // Signed out, the feed is a richer set than the data layer's three fixtures. Built once: a market's clock is its own.
  const demoMarkets = useMemo(() => (isDemo ? reelDemoMarkets(Math.floor(Date.now() / 1000)) : null), [isDemo]);
  const all: readonly PredictMarket[] = demoMarkets ?? feed.markets;

  const assets = useMemo(() => assetOptions(all), [all]);
  const timeframes = useMemo(() => timeframeOptions(all), [all]);
  const shown = useMemo(() => filterMarkets(all, filter), [all, filter]);
  const items = useMemo(() => reelItems(shown), [shown]);
  const firstId = items[0]?.id ?? null;
  const active = activeId !== null && items.some((i) => i.id === activeId) ? activeId : firstId;

  const marketOf = useCallback((id: string) => all.find((m) => m.id === id), [all]);
  const sheetMarket = sheet ? marketOf(sheet.marketId) : undefined;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  }, []);

  // `onViewableItemsChanged` may not change after mount, so it reads through refs and setters only.
  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems.find((v) => v.isViewable && typeof v.item?.id === 'string');
    if (first) setActiveId(first.item.id as string);
  }).current;

  // Once the person has moved off the first page, the swipe hint has done its job.
  useEffect(() => {
    if (!swiped && active !== null && firstId !== null && active !== firstId) setSwiped(true);
  }, [active, firstId, swiped]);

  const flash = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 2200);
  }, []);

  const scrollToTop = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  const setAsset = useCallback((asset: string | null) => setFilter((f) => ({ ...f, asset })), []);
  const cycleTimeframe = useCallback(
    () => setFilter((f) => ({ ...f, timeframe: nextTimeframe(f.timeframe, timeframes) })),
    [timeframes],
  );
  const clearFilter = useCallback(() => setFilter(NO_FILTER), []);

  const onSide = useCallback(
    (market: PredictMarket, side: MarketSide) => {
      tap();
      setSheetMessage(null);
      setSheet({ kind: 'stake', marketId: market.id, side });
    },
    [tap],
  );
  const onEvidence = useCallback((market: PredictMarket) => setSheet({ kind: 'evidence', marketId: market.id }), []);
  const onInfo = useCallback((market: PredictMarket) => setSheet({ kind: 'info', marketId: market.id }), []);
  const onShare = useCallback(
    async (market: PredictMarket) => {
      const message = `${questionText(market)} Take a side on Kanon.`;
      try {
        await Share.share({ message });
      } catch {
        // No share sheet (a desktop browser): the question goes to the clipboard instead.
        if (isWeb && typeof navigator !== 'undefined' && navigator.clipboard) {
          try {
            await navigator.clipboard.writeText(message);
            flash('Copied to the clipboard');
          } catch {
            /* nothing to copy to */
          }
        }
      }
    },
    [flash],
  );
  const onCheckCrossed = useCallback(
    (market: PredictMarket) => {
      void feed.checkCrossed(market.id).then((isCrossed) => {
        if (isCrossed) setCrossed((prev) => (prev[market.id] ? prev : { ...prev, [market.id]: true }));
      });
    },
    [feed],
  );

  const confirm = useCallback(async () => {
    if (!sheet || sheet.kind !== 'stake' || busy) return;
    const market = marketOf(sheet.marketId);
    const stake = stakeAt(STAKE_PRESETS, stakeIdx);
    if (!market || !stake) return;
    setBusy(true);
    setSheetMessage(null);
    const result = await feed.takeSide(market.id, sheet.side, stake);
    setBusy(false);
    if (result.ok) {
      success();
      const label = sheet.side === 'above' ? 'UP' : 'DOWN';
      setTaken((prev) => ({
        ...prev,
        [market.id]: {
          taken: true,
          text: `${label} taken · ${formatAmount(stake)} ${feed.nativeSymbol} · ${abbreviateHash(result.txHash)}${
            result.recorded ? '' : ' · on-chain, not saved here'
          }`,
        },
      }));
      setSheet(null);
      // Let the sheet close before the feed moves on to the next market.
      const from = indexOfItem(items, market.id);
      const to = advanceIndex(from, items.length);
      if (to !== from) setTimeout(() => listRef.current?.scrollToIndex({ index: to, animated: true }), 280);
      return;
    }
    if (result.reason === 'crossed') {
      setCrossed((prev) => ({ ...prev, [market.id]: true }));
      setSheet(null);
      return;
    }
    // Every other outcome is a fact about the market or the network, said plainly in the sheet.
    setSheetMessage(result.message);
  }, [sheet, busy, marketOf, stakeIdx, feed, success, items]);

  const renderItem = useCallback(
    ({ item }: { item: ReelItem }) =>
      item.kind === 'end' ? (
        <ReelEnd width={size.w} height={size.h} onTop={scrollToTop} />
      ) : (
        <ReelPage
          market={item.market}
          width={size.w}
          height={size.h}
          active={item.id === active}
          hint={!swiped && item.id === firstId}
          availability={feed.availability}
          nativeSymbol={feed.nativeSymbol}
          crossedOnChain={crossed[item.id] === true}
          taken={taken[item.id]}
          onSide={onSide}
          onEvidence={onEvidence}
          onInfo={onInfo}
          onShare={onShare}
          onCheckCrossed={onCheckCrossed}
        />
      ),
    [
      size.w,
      size.h,
      active,
      swiped,
      firstId,
      feed.availability,
      feed.nativeSymbol,
      crossed,
      taken,
      onSide,
      onEvidence,
      onInfo,
      onShare,
      onCheckCrossed,
      scrollToTop,
    ],
  );

  const getItemLayout = useCallback(
    (_: ArrayLike<ReelItem> | null | undefined, index: number) => ({ length: size.h, offset: size.h * index, index }),
    [size.h],
  );

  const measured = size.w > 0 && size.h > 0;
  const loading = feed.state === 'loading';
  const empty = !loading && items.length === 0;

  // The stake sheet is enabled only when the page beneath would let this side be taken.
  const stakeState =
    sheet?.kind === 'stake' && sheetMarket
      ? pageState({
          market: sheetMarket,
          nowSeconds: Math.floor(Date.now() / 1000),
          crossedOnChain: crossed[sheetMarket.id] === true,
          availability: feed.availability,
        })
      : null;

  return (
    <Screen label="11 · PREDICT">
      <StatusBar />

      <View className="relative min-h-0 flex-1 bg-void" onLayout={onLayout}>
        {!measured || loading ? (
          <ReelSkeleton width={size.w || 390} height={size.h || 640} />
        ) : empty ? (
          <ReelEmpty height={size.h} filtered={filter.asset !== null || filter.timeframe !== null} onClear={clearFilter} />
        ) : (
          <FlatList
            key={`${filter.asset ?? 'all'}|${filter.timeframe ?? 'any'}`}
            ref={listRef}
            data={items}
            keyExtractor={keyOf}
            renderItem={renderItem}
            getItemLayout={getItemLayout}
            extraData={renderItem}
            pagingEnabled
            snapToInterval={size.h}
            snapToAlignment="start"
            decelerationRate="fast"
            disableIntervalMomentum
            showsVerticalScrollIndicator={false}
            initialNumToRender={1}
            maxToRenderPerBatch={2}
            windowSize={3}
            removeClippedSubviews={!isWeb}
            viewabilityConfig={VIEWABILITY}
            onViewableItemsChanged={onViewable}
          />
        )}

        {measured && !loading && (all.length > 0 || filter.asset !== null) ? (
          <TopBar
            assets={assets}
            asset={filter.asset}
            onAsset={setAsset}
            timeframe={filter.timeframe}
            timeframeCount={timeframes.length}
            onTimeframe={cycleTimeframe}
          />
        ) : null}

        {toast ? (
          <View className="absolute inset-x-0 top-16 z-10 items-center" style={{ pointerEvents: 'none' }}>
            <View className="rounded-xs border border-hairline bg-raised px-3 py-2">
              <Text className="font-mono text-11 text-bone">{toast}</Text>
            </View>
          </View>
        ) : null}
      </View>

      <TabBar active="predict" />

      {sheet?.kind === 'stake' && sheetMarket && stakeState ? (
        <StakeSheet
          key="stake"
          market={sheetMarket}
          side={sheet.side}
          presets={STAKE_PRESETS}
          stakeIdx={stakeIdx}
          onStakeIdx={setStakeIdx}
          symbol={feed.nativeSymbol}
          availability={feed.availability}
          canStake={stakeState.canStake}
          busy={busy}
          message={sheetMessage ?? stakeState.note?.text ?? null}
          onConfirm={() => void confirm()}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet?.kind === 'evidence' && sheetMarket ? (
        <EvidenceSheet key="evidence" market={sheetMarket} onClose={() => setSheet(null)} />
      ) : null}
      {sheet?.kind === 'info' && sheetMarket ? (
        <InfoSheet
          key="info"
          market={sheetMarket}
          onEvidence={() => setSheet({ kind: 'evidence', marketId: sheetMarket.id })}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </Screen>
  );
}

const keyOf = (item: ReelItem) => item.id;
