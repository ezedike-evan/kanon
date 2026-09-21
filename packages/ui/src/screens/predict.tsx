import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Share, Text, View, type LayoutChangeEvent, type ViewToken } from 'react-native';
import { abbreviateHash, type MarketSide } from '@kanon/spec';
import { Screen, StatusBar, TabBar, useLayout } from '../components/chrome';
import { ReelPage, type TakenNote } from '../components/reel/reel-page';
import { ReelLeftPanel, ReelRightPanel } from '../components/reel/reel-desk';
import { TopBar, usePageClock } from '../components/reel/reel-parts';
import { EvidenceSheet, InfoSheet, StakeSheet } from '../components/reel/reel-sheets';
import { ReelEmpty, ReelEnd, ReelSkeleton } from '../components/reel/reel-states';
import { cx } from '../lib/cx';
import { useKanonSelector } from '../lib/data';
import { web } from '../lib/desktop';
import { stepIndex, type Step } from '../lib/reel-paging';
import { useReelPaging } from '../lib/use-reel-paging';
import { formatAmount } from '../lib/predict-map';
import { reelDemoMarkets } from '../lib/predict-demo';
import {
  DEFAULT_STAKE_INDEX,
  NO_FILTER,
  advanceIndex,
  assetCode,
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
import { isMarketAsset } from '@kanon/spec';
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
  // Desktop: the panels beside the reel subscribe to prices, so they get content only where they are drawn.
  const desktop = useLayout() === 'desktop';
  const stage = useRef<View>(null);
  const clock = usePageClock(desktop);
  const now = clock ?? Math.floor(Date.now() / 1000);

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

  // Desktop paging and navigation. The reel moves through `goTo`, so a wheel, a key and a click on a row all share one path.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeRef = useRef(active);
  activeRef.current = active;
  const lastSent = useRef<{ index: number; at: number } | null>(null);
  const pendingFocus = useRef<string | null>(null);

  const goTo = useCallback((index: number) => {
    lastSent.current = { index, at: Date.now() };
    listRef.current?.scrollToIndex({ index, animated: true });
  }, []);

  const onStep = useCallback(
    (step: Step) => {
      const list = itemsRef.current;
      if (list.length === 0) return;
      // A page still on its way is where the next key starts from, so two quick presses go two pages.
      const recent = lastSent.current && Date.now() - lastSent.current.at < 700 ? lastSent.current.index : null;
      const from = recent ?? Math.max(0, indexOfItem(list, activeRef.current ?? ''));
      const to = stepIndex(from, step, list.length);
      if (to !== from) goTo(to);
    },
    [goTo],
  );

  const focusMarket = useCallback(
    (id: string) => {
      const at = indexOfItem(itemsRef.current, id);
      if (at >= 0) {
        goTo(at);
        return;
      }
      // Filtered out: show them all, and go there once the list has rebuilt.
      pendingFocus.current = id;
      setFilter(NO_FILTER);
    },
    [goTo],
  );

  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return undefined;
    const at = indexOfItem(items, id);
    if (at < 0) return undefined;
    pendingFocus.current = null;
    const timer = setTimeout(() => listRef.current?.scrollToIndex({ index: at, animated: false }), 60);
    return () => clearTimeout(timer);
  }, [items]);

  const setAsset = useCallback((asset: string | null) => setFilter((f) => ({ ...f, asset })), []);
  const cycleTimeframe = useCallback(
    () => setFilter((f) => ({ ...f, timeframe: nextTimeframe(f.timeframe, timeframes) })),
    [timeframes],
  );
  const clearFilter = useCallback(() => setFilter(NO_FILTER), []);
  const setTimeframe = useCallback((timeframe: string | null) => setFilter((f) => ({ ...f, timeframe })), []);

  // What the desktop panels list: markets per asset, and the ones in view, in reel order.
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of all) if (isMarketAsset(m.asset)) c[assetCode(m.asset)] = (c[assetCode(m.asset)] ?? 0) + 1;
    return c;
  }, [all]);
  const total = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts]);
  const inView = useMemo(() => items.flatMap((i) => (i.kind === 'market' ? [i.market] : [])), [items]);

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

  useReelPaging(stage, sheet === null, onStep);

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
    // A column on a phone and a tablet, as it always was; the whole pane on desktop.
    <Screen size="column" desktop="full" active="predict">
      <StatusBar />

      {/* Desktop: a panel either side of the reel. Below `lg` the reel is the screen. */}
      <View className={cx('min-h-0 flex-1 bg-void', web('lg:flex-row'))}>
        {isWeb ? (
          <ReelLeftPanel
            live={desktop}
            assets={assets}
            counts={counts}
            total={total}
            windows={timeframes}
            filter={filter}
            onAsset={setAsset}
            onTimeframe={setTimeframe}
            markets={inView}
            activeId={active}
            now={now}
            onPick={focusMarket}
          />
        ) : null}

        {/* On desktop the reel is a 440px column, centred and full height; the wheel over either side pages it too. */}
        <View ref={stage} className={cx('min-h-0 min-w-0 flex-1', web('lg:items-center'))}>
          <View
            className={cx('relative min-h-0 w-full flex-1 bg-void', web('lg:w-[440px] lg:max-w-full lg:border-x lg:border-hairline'))}
            onLayout={onLayout}
          >
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
                className={web('lg:hidden')}
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
        </View>

        {isWeb ? (
          <ReelRightPanel
            market={active !== null ? marketOf(active) : undefined}
            markets={all}
            nativeSymbol={feed.nativeSymbol}
            onEvidence={onEvidence}
            onPick={focusMarket}
          />
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
