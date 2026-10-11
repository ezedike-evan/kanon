import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, View, type LayoutChangeEvent, type ViewToken } from 'react-native';
import { Screen, StatusBar, TabBar, useLayout } from '../components/chrome';
import { ReelLeftPanel, ReelTradesPanel } from '../components/reel/reel-desk';
import { ReelPage, type TradesTab } from '../components/reel/reel-page';
import { TopBar } from '../components/reel/reel-parts';
import { ReelEmpty, ReelEnd, ReelSkeleton, ReelUnavailable } from '../components/reel/reel-states';
import { TimedTradesFeed, TradeSheet, TradesSheet } from '../components/reel/reel-trades';
import { cx } from '../lib/cx';
import { web } from '../lib/desktop';
import { stepIndex, type Step } from '../lib/reel-paging';
import {
  NO_FILTER,
  assetOptions,
  indexOfItem,
  nextTime,
  reelItems,
  reelSlides,
  slideForTrade,
  timeOptions,
  type ReelFilter,
  type ReelItem,
} from '../lib/timed-reel';
import type { TimedTrade } from '../lib/timed-types';
import { useReelPaging } from '../lib/use-reel-paging';
import { useTimedTicket } from '../lib/use-timed-ticket';
import { isWeb } from '../platform';

/**
 * 11 · PREDICT.
 *
 * A vertical reel you swipe through: one slide per pair and time, each a plain
 * question (which way does this pair move in this time), the pair's line, and
 * two big actions in the thumb zone. The market is not a price to be reached,
 * it is the time. A press on UP opens a long and a press on DOWN opens a short,
 * at market, with the stake that is on the slide; the server closes it when the
 * slide's time is up. Nothing is signed and no wallet is asked for anything:
 * the press is the whole of it, as it is on the chart's order ticket.
 *
 * While a trade runs, every slide of its pair shows it in place of the two
 * actions: countdown, entry, the move from entry, "End now". When it ends the
 * slide says what was called and what the price did. The caller's other
 * trades, running and finished, are one press from any slide (the rail), and
 * a finished trade's details, its result in money among them, are a sheet
 * further. No money figure is on a slide.
 *
 * On a desktop the reel is a 440px column, paged by wheel and by the arrow and
 * page keys, between a left panel (pairs with live prices, the time, the slides
 * in view) and, from 1280, a right panel (what is running, and the history).
 *
 * This file is the reel's mechanics: which slide is on screen and how to get to
 * another. What a slide offers, says and sends is `lib/timed-reel.ts`,
 * `lib/timed-trade.ts` and `lib/use-timed-ticket.ts`.
 */

/** A sheet over the reel: the caller's trades, or one finished trade. `back` is the tab the detail was opened from. */
type Sheet = { kind: 'trades'; tab: TradesTab } | { kind: 'trade'; id: string; back: TradesTab | null };

const VIEWABILITY = { itemVisiblePercentThreshold: 60 } as const;

export function PredictScreen() {
  const ticket = useTimedTicket();
  const { listed, base, history } = ticket;

  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [filter, setFilter] = useState<ReelFilter>(NO_FILTER);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [swiped, setSwiped] = useState(false);

  const listRef = useRef<FlatList<ReelItem>>(null);
  // Desktop: the left panel subscribes to prices, so it gets its rows only where it is drawn.
  const desktop = useLayout() === 'desktop';
  const stage = useRef<View>(null);

  // Built from what the server last listed: a read that fails afterwards turns the slides' actions off, and keeps the slides.
  const assets = useMemo(() => assetOptions(listed), [listed]);
  const times = useMemo(() => timeOptions(listed), [listed]);
  const slides = useMemo(() => reelSlides(listed, filter), [listed, filter]);
  const items = useMemo(() => reelItems(slides), [slides]);
  const firstId = items[0]?.id ?? null;
  const active = activeId !== null && items.some((i) => i.id === activeId) ? activeId : firstId;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  }, []);

  // `onViewableItemsChanged` may not change after mount, so it reads through refs and setters only.
  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems.find((v) => v.isViewable && typeof v.item?.id === 'string');
    if (first) setActiveId(first.item.id as string);
  }).current;

  // Once the person has moved off the first slide, the swipe hint has done its job.
  useEffect(() => {
    if (!swiped && active !== null && firstId !== null && active !== firstId) setSwiped(true);
  }, [active, firstId, swiped]);

  const scrollToTop = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  // Desktop paging and navigation. The reel moves through `goTo`, so a wheel, a key and a click on a row all share one path.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const slidesRef = useRef(slides);
  slidesRef.current = slides;
  const activeRef = useRef(active);
  activeRef.current = active;
  const lastSent = useRef<{ index: number; at: number } | null>(null);
  /** A trade whose slide the filter had left out: gone to once the filter is cleared and the reel rebuilt. */
  const pendingFocus = useRef<Pick<TimedTrade, 'asset' | 'seconds'> | null>(null);

  const goTo = useCallback((index: number) => {
    lastSent.current = { index, at: Date.now() };
    listRef.current?.scrollToIndex({ index, animated: true });
  }, []);

  const onStep = useCallback(
    (step: Step) => {
      const list = itemsRef.current;
      if (list.length === 0) return;
      // A slide still on its way is where the next key starts from, so two quick presses go two slides.
      const recent = lastSent.current && Date.now() - lastSent.current.at < 700 ? lastSent.current.index : null;
      const from = recent ?? Math.max(0, indexOfItem(list, activeRef.current ?? ''));
      const to = stepIndex(from, step, list.length);
      if (to !== from) goTo(to);
    },
    [goTo],
  );

  const focusSlide = useCallback(
    (id: string) => {
      const at = indexOfItem(itemsRef.current, id);
      if (at >= 0) goTo(at);
    },
    [goTo],
  );

  /** Shows a trade's slide: its own pair and time, or any slide of its pair. The sheet it was asked from closes. */
  const goToTrade = useCallback(
    (trade: TimedTrade) => {
      setSheet(null);
      const slide = slideForTrade(slidesRef.current, trade);
      if (slide) {
        focusSlide(slide.id);
        return;
      }
      // Filtered out: show every slide, and go there once the reel has rebuilt.
      pendingFocus.current = { asset: trade.asset, seconds: trade.seconds };
      setFilter(NO_FILTER);
    },
    [focusSlide],
  );

  useEffect(() => {
    const wanted = pendingFocus.current;
    if (!wanted) return undefined;
    const slide = slideForTrade(slides, wanted);
    const at = slide ? indexOfItem(items, slide.id) : -1;
    if (at < 0) return undefined;
    pendingFocus.current = null;
    const timer = setTimeout(() => listRef.current?.scrollToIndex({ index: at, animated: false }), 60);
    return () => clearTimeout(timer);
  }, [items, slides]);

  const setAsset = useCallback((asset: string | null) => setFilter((f) => ({ ...f, asset })), []);
  const setTime = useCallback((seconds: number | null) => setFilter((f) => ({ ...f, seconds })), []);
  const cycleTime = useCallback(() => setFilter((f) => ({ ...f, seconds: nextTime(f.seconds, times) })), [times]);
  const clearFilter = useCallback(() => setFilter(NO_FILTER), []);

  const openTrades = useCallback((tab: TradesTab) => setSheet({ kind: 'trades', tab }), []);
  const setTradesTab = useCallback((tab: TradesTab) => setSheet({ kind: 'trades', tab }), []);
  /** A finished trade's details, from a slide or the desktop panel: closing them returns to the reel. */
  const openDetails = useCallback((id: string) => setSheet({ kind: 'trade', id, back: null }), []);
  /** The same from the trades sheet: closing them returns to the list they were picked from. */
  const openDetailsFromList = useCallback((id: string) => setSheet({ kind: 'trade', id, back: 'history' }), []);
  const closeSheet = useCallback(() => setSheet(null), []);
  const closeDetails = useCallback(
    () => setSheet((open) => (open?.kind === 'trade' && open.back ? { kind: 'trades', tab: open.back } : null)),
    [],
  );

  const renderItem = useCallback(
    ({ item }: { item: ReelItem }) =>
      item.kind === 'end' ? (
        <ReelEnd width={size.w} height={size.h} onTop={scrollToTop} />
      ) : (
        <ReelPage
          slide={item.slide}
          width={size.w}
          height={size.h}
          active={item.id === active}
          hint={!swiped && item.id === firstId}
          ticket={ticket}
          onTrades={openTrades}
          onDetails={openDetails}
        />
      ),
    [size.w, size.h, active, swiped, firstId, ticket, openTrades, openDetails, scrollToTop],
  );

  const getItemLayout = useCallback(
    (_: ArrayLike<ReelItem> | null | undefined, index: number) => ({ length: size.h, offset: size.h * index, index }),
    [size.h],
  );

  useReelPaging(stage, sheet === null, onStep);

  const measured = size.w > 0 && size.h > 0;
  const loading = listed.status === 'loading';
  const unavailable = listed.status === 'unavailable';
  const filtered = filter.asset !== null || filter.seconds !== null;
  const detail = sheet?.kind === 'trade' ? (history.find((trade) => trade.id === sheet.id) ?? null) : null;

  return (
    // A column on a phone and a tablet, as it always was; the whole pane on desktop.
    <Screen size="column" desktop="full" active="predict">
      <StatusBar />

      {/* Desktop: a panel either side of the reel. Below `lg` the reel is the screen. */}
      <View className={cx('min-h-0 flex-1 bg-void', web('lg:flex-row'))}>
        {isWeb ? (
          <ReelLeftPanel
            live={desktop}
            ticket={ticket}
            times={times}
            filter={filter}
            onAsset={setAsset}
            onTime={setTime}
            slides={slides}
            activeId={active}
            onPick={focusSlide}
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
            ) : unavailable ? (
              <ReelUnavailable
                height={size.h}
                message={base.message ?? ''}
                onRefresh={ticket.canRefresh ? ticket.refresh : undefined}
                running={ticket.running.length}
                onTrades={ticket.canRefresh ? openTrades : undefined}
              />
            ) : items.length === 0 ? (
              <ReelEmpty height={size.h} filtered={filtered} onClear={clearFilter} />
            ) : (
              <FlatList
                key={`${filter.asset ?? 'all'}|${filter.seconds ?? 'any'}`}
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

            {measured && !loading && !unavailable && (items.length > 0 || filtered) ? (
              <TopBar
                assets={assets}
                asset={filter.asset}
                onAsset={setAsset}
                seconds={filter.seconds}
                timeCount={times.length}
                onTime={cycleTime}
                className={web('lg:hidden')}
              />
            ) : null}
          </View>
        </View>

        {isWeb ? <ReelTradesPanel ticket={ticket} onGo={goToTrade} onDetails={openDetails} /> : null}
      </View>

      <TabBar active="predict" />

      <TradesSheet
        open={sheet?.kind === 'trades'}
        tab={sheet?.kind === 'trades' ? sheet.tab : 'running'}
        onTab={setTradesTab}
        onClose={closeSheet}
        ticket={ticket}
        onGo={goToTrade}
        onDetails={openDetailsFromList}
      />
      <TradeSheet trade={detail} onClose={closeDetails} />
      {/* Draws nothing: the caller's own trades, read while the screen is mounted. */}
      <TimedTradesFeed onTrades={ticket.followTrades} />
    </Screen>
  );
}

const keyOf = (item: ReelItem) => item.id;
