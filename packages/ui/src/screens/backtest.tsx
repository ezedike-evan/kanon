import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Badge } from '../components/badge';
import { BottomSheet } from '../components/bottom-sheet';
import { Card } from '../components/card';
import { Body, Footer, NavBar, Screen } from '../components/chrome';
import { FiguredText } from '../components/figured-text';
import { Icon } from '../components/icons';
import { FOCUS, Facts } from '../components/reel/trade-parts';
import { SectionHeader } from '../components/section-header';
import { SignInLink } from '../components/sign-in-link';
import { Skeleton } from '../components/skeleton';
import { Label } from '../components/stat';
import { GhostButton, Meta, Num, PrimaryButton } from '../components/ui';
import {
  FILTER_EMPTY,
  NOT_AUTOPILOT,
  OUTCOME_ICON,
  coverageRows,
  filterTrades,
  freshnessLine,
  gapRows,
  gapSummary,
  haltView,
  paramRows,
  rangeLine,
  tiles,
  tradeRow,
  tradeSheet,
  verdictView,
  winRateFigure,
  winRateLine,
  type TradeFilter,
} from '../lib/backtest';
import type { BacktestParams, BacktestRead, BacktestResult, BacktestState, BacktestTrade } from '../lib/backtest-types';
import { cx } from '../lib/cx';
import { useBacktest } from '../lib/domains';
import { routes } from '../lib/routes';
import { useHaptics } from '../platform';

/**
 * 04B · TEST ON RECORDED PRICES.
 *
 * The rule, walked over every recorded candle of its pair, oldest first: at each
 * close it is put to the candles behind it exactly as it is put to the market,
 * a pass is entered at that close at the rule's own stop and target, and each
 * trade is counted a win, a loss, or cannot tell. Black and white: where the
 * recorded prices cannot say what happened, the test says so rather than guess.
 *
 * Above the fold there is no money. The win rate with the count it is taken
 * over, the four counts that make it (each one the filter that lists its trades,
 * which are the evidence), a neutral verdict against break-even, and the data
 * range. Below: the trades, every constant the test ran under, what was judged
 * and the gaps. A trade's sheet shows the predicate values it passed on, its
 * levels, the candle it ended in and the comparison that ended it.
 *
 * A rule the test cannot judge is not a fault: it stops, with the server's
 * sentence. Opening the screen asks only for the stored answer; a run waits for
 * the action at the foot.
 *
 * The test is of the rule's stated stop and target. Autopilot opens a timed
 * trade for a fixed hold instead, and the screen says so: nothing here is a
 * promise about what autopilot would have done.
 */
export function BacktestScreen({ ruleId }: { ruleId?: string | undefined }) {
  // A route that names a rule tests that rule, even one that turns out not to exist; no id is the review.
  const subject = useMemo(
    () => (ruleId !== undefined ? { kind: 'rule' as const, id: ruleId } : { kind: 'review' as const }),
    [ruleId],
  );
  const read = useBacktest(subject);
  const { state } = read;
  const [tradeOpen, setTradeOpen] = useState<BacktestTrade | null>(null);
  const [gapsOpen, setGapsOpen] = useState(false);
  const closeTrade = useCallback(() => setTradeOpen(null), []);
  const closeGaps = useCallback(() => setGapsOpen(false), []);

  const back = ruleId !== undefined ? { label: '←  RULE', href: routes.home } : { label: '←  REVIEW', href: routes.compileReview };
  const right = read.subject ? `${read.subject.asset} · ${read.subject.timeframe}` : undefined;
  const result = state.status === 'result' ? state.result : null;

  return (
    <Screen label="04B · TEST ON RECORDED PRICES">
      <NavBar left={back.label} leftHref={back.href} leftClassName="text-ash tracking-w12" right={right} />

      <Body contentClassName="pb-6">
        <View className="mt-5 flex-row items-center justify-between gap-3">
          <Text role="heading" className="font-mono-medium text-11 tracking-w16 text-bone">
            TEST ON RECORDED PRICES
          </Text>
          {state.status === 'result' && state.sample ? <Badge label="Sample" tone="signal" icon="sparkles" /> : null}
        </View>

        {state.status === 'loading' ? <Loading /> : null}
        {state.status === 'result' ? (
          <Result state={state} onTrade={setTradeOpen} onGaps={() => setGapsOpen(true)} />
        ) : null}
        {state.status === 'halted' ? <Halted halt={state.halt} /> : null}
        {state.status === 'not_run' ? <NotRun /> : null}
        {state.status === 'nothing' ? <Plain title="Nothing to test" body={state.message} /> : null}
        {state.status === 'failed' ? <Plain title="The test could not be asked" body={state.message} /> : null}
      </Body>

      <Foot read={read} />

      {result ? <TradeSheet trade={tradeOpen} params={result.params} onClose={closeTrade} /> : null}
      {result ? <GapsSheet result={result} open={gapsOpen} onClose={closeGaps} /> : null}
    </Screen>
  );
}

/* -------------------------------------------------------------------------- */
/* Above the fold                                                              */
/* -------------------------------------------------------------------------- */

function Result({
  state,
  onTrade,
  onGaps,
}: {
  state: Extract<BacktestState, { status: 'result' }>;
  onTrade: (trade: BacktestTrade) => void;
  onGaps: () => void;
}) {
  const { result } = state;
  const { tap, select } = useHaptics();
  const [filter, setFilter] = useState<TradeFilter>('all');
  const [shown, setShown] = useState(PAGE);
  const figure = winRateFigure(result);
  const verdict = verdictView(result);
  const range = rangeLine(result);
  const listed = useMemo(() => filterTrades(result.trades, filter), [result.trades, filter]);

  const pick = (next: TradeFilter) => {
    select();
    setShown(PAGE);
    setFilter((current) => (current === next ? 'all' : next));
  };

  return (
    <View>
      {/* The win rate, with the count it is taken over. A rate, never money. */}
      <View className="mt-4 gap-1.5">
        <Meta>WIN RATE</Meta>
        {figure ? (
          <Num className="font-mono-medium text-31 tracking-t30 leading-[1.05]">{figure}</Num>
        ) : (
          <Num className="font-mono-medium text-20 tracking-t20 leading-[1.3] text-ash">NONE DECIDED</Num>
        )}
        <FiguredText text={winRateLine(result)} className="font-mono text-12 text-ash" />
      </View>

      <View className="mt-3.5 gap-1.5">
        <Badge label={verdict.label} icon={verdict.icon} size="md" />
        <FiguredText text={verdict.line} className="font-sans text-12 leading-[18px] text-ash" />
        {verdict.more ? <FiguredText text={verdict.more} className="font-sans text-12 leading-[18px] text-ash" /> : null}
      </View>

      {/* Each count is the filter that lists its trades: the evidence for the figure above it. */}
      <Card pad="none" className="mt-4">
        {[0, 2].map((row) => (
          <View key={row} className={cx('flex-row', row > 0 && 'border-t border-hairline')}>
            {tiles(result)
              .slice(row, row + 2)
              .map((tile, i) => {
                const on = filter === tile.filter;
                return (
                  <Pressable
                    key={tile.filter}
                    role="button"
                    aria-pressed={on}
                    aria-label={`${tile.label}: ${tile.value}. ${on ? 'Show every trade.' : `List the ${tile.label.toLowerCase()}.`}`}
                    onPress={() => pick(tile.filter)}
                    className={cx(
                      'min-h-16 flex-1 gap-1.5 px-3.5 py-3 hover:bg-raised/60 active:bg-raised',
                      i > 0 && 'border-l border-hairline',
                      on && 'bg-raised',
                      FOCUS,
                    )}
                  >
                    <View className="flex-row items-center justify-between gap-2">
                      <Label className={on ? 'text-bone' : undefined}>{tile.label}</Label>
                      <Icon name={on ? 'check' : 'filter'} size={12} color={on ? 'signal' : 'ash'} />
                    </View>
                    <Num className="text-20 tracking-t20">{tile.value}</Num>
                  </Pressable>
                );
              })}
          </View>
        ))}
      </Card>

      <View className="mt-3.5 gap-1">
        <View className="flex-row items-baseline gap-2.5">
          <Meta>DATA</Meta>
          <Num className="shrink text-12">{range.span}</Num>
        </View>
        <FiguredText text={range.detail} className="font-mono text-11 text-ash" />
        <FiguredText text={freshnessLine(state)} className="font-mono text-11 text-ash" />
      </View>

      {/* Below the fold. */}
      <Note className="mt-6" text={NOT_AUTOPILOT} />

      <SectionHeader
        className="mt-6"
        title={filter === 'all' ? 'Trades' : tiles(result).find((t) => t.filter === filter)!.label}
        count={listed.length}
        action={filter === 'all' ? undefined : { label: 'Show all', onPress: () => pick(filter) }}
      />
      <Card pad="none" className="mt-2.5">
        {listed.length === 0 ? (
          <Text className="px-4 py-4 font-sans text-13 leading-5 text-ash">{FILTER_EMPTY[filter]}</Text>
        ) : (
          listed.slice(0, shown).map((trade, i) => (
            <TradeRow
              key={trade.n}
              trade={trade}
              first={i === 0}
              onPress={() => {
                tap();
                onTrade(trade);
              }}
            />
          ))
        )}
        {listed.length > shown ? (
          <Pressable
            role="button"
            onPress={() => setShown((n) => n + PAGE)}
            className={cx('min-h-11 items-center justify-center border-t border-hairline hover:bg-raised/60 active:bg-raised', FOCUS)}
          >
            <Text className="font-mono-medium text-11 tracking-w10 text-verified">
              SHOW {Math.min(PAGE, listed.length - shown)} MORE OF {listed.length - shown}
            </Text>
          </Pressable>
        ) : null}
      </Card>

      <SectionHeader className="mt-6" title="Rules of the test" count={paramRows(result.params).length} />
      <View className="mt-2.5">
        <Facts rows={paramRows(result.params).map((r) => [r.label, r.value] as const)} />
      </View>

      <SectionHeader className="mt-6" title="What was judged" />
      <View className="mt-2.5">
        <Facts rows={coverageRows(result)} />
      </View>

      <SectionHeader className="mt-6" title="Gaps" count={result.gaps.length} />
      <Card pad="none" className="mt-2.5">
        <FiguredText text={gapSummary(result)} className="px-4 py-3 font-sans text-13 leading-5 text-ash" />
        {result.gaps.length > 0 ? (
          <Pressable
            role="button"
            aria-label="List every gap"
            onPress={() => {
              tap();
              onGaps();
            }}
            className={cx(
              'min-h-11 flex-row items-center justify-between gap-3 border-t border-hairline px-4 hover:bg-raised/60 active:bg-raised',
              FOCUS,
            )}
          >
            <Text className="font-mono text-12 text-ash">Where they are</Text>
            <View className="flex-row items-center gap-1.5">
              <Text className="font-mono-medium text-11 uppercase tracking-w08 text-verified">List</Text>
              <Icon name="chevron-right" size={14} color="verified" />
            </View>
          </Pressable>
        ) : null}
      </Card>
    </View>
  );
}

/** Trades drawn at a time: a long history stays light on a mid-range phone. */
const PAGE = 50;

const TradeRow = memo(function TradeRow({
  trade,
  first,
  onPress,
}: {
  trade: BacktestTrade;
  first: boolean;
  onPress: () => void;
}) {
  const row = tradeRow(trade);
  return (
    <Pressable
      role="button"
      aria-label={`Trade ${row.n}, set up ${row.setup} UTC: ${row.label}, ${row.held}. Open its evidence.`}
      onPress={onPress}
      className={cx(
        'min-h-14 flex-row items-center gap-3 px-4 py-2.5 hover:bg-raised/60 active:bg-raised',
        !first && 'border-t border-hairline',
        FOCUS,
      )}
    >
      <Num className="w-8 text-11 text-ash">{row.ordinal}</Num>
      <View className="min-w-0 flex-1 gap-1">
        <Num className="text-12">{row.setup}</Num>
        <FiguredText text={row.held} className="font-mono text-11 text-ash" />
      </View>
      <Badge label={row.label} icon={OUTCOME_ICON[row.outcome]} className="self-center" />
      <Icon name="chevron-right" size={14} color="ash" />
    </Pressable>
  );
});

/* -------------------------------------------------------------------------- */
/* The other states                                                            */
/* -------------------------------------------------------------------------- */

function Loading() {
  return (
    <View aria-busy aria-label="Reading the stored test" className="mt-4 gap-3">
      <Skeleton width={64} height={9} />
      <Skeleton width={150} height={30} />
      <Skeleton width={130} height={11} />
      <Skeleton height={130} className="mt-2" />
      <Skeleton width="80%" height={11} />
    </View>
  );
}

function Halted({ halt }: { halt: Extract<BacktestState, { status: 'halted' }>['halt'] }) {
  const view = haltView(halt);
  return (
    <View>
      <View className="mt-4 rounded-sm border border-hairline bg-panel px-4 py-3.5">
        <Meta>{view.title}</Meta>
        <FiguredText text={view.message} className="mt-2 font-sans text-15 leading-[22px] text-bone" />
        <Text className="mt-2 font-sans text-12 leading-[18px] text-ash">
          No win rate is given for a rule the test cannot judge.
        </Text>
      </View>
      <SectionHeader className="mt-6" title="Rules of the test" count={paramRows(halt.params).length} />
      <View className="mt-2.5">
        <Facts rows={paramRows(halt.params).map((r) => [r.label, r.value] as const)} />
      </View>
    </View>
  );
}

function NotRun() {
  return (
    <View className="mt-4 gap-3">
      <Meta>NOT RUN YET</Meta>
      <Text className="font-sans text-15 leading-[22px] text-bone">
        Every recorded candle of this pair is walked, oldest first. At each close the rule is put to the
        candles behind it, a pass is entered at that close, and each trade is counted a win, a loss, or
        cannot tell.
      </Text>
      <Text className="font-sans text-13 leading-5 text-ash">
        Candles with no price of their own decide nothing, and a candle that reached both the stop and the
        target is not guessed at.
      </Text>
      <Note text={NOT_AUTOPILOT} />
    </View>
  );
}

function Plain({ title, body }: { title: string; body: string }) {
  return (
    <View className="mt-4 gap-2 rounded-sm border border-hairline bg-panel px-4 py-3.5">
      <Meta>{title.toUpperCase()}</Meta>
      <FiguredText text={body} className="font-sans text-13 leading-5 text-bone" />
    </View>
  );
}

function Note({ text, className }: { text: string; className?: string | undefined }) {
  return (
    <View className={cx('flex-row gap-2.5 rounded-sm border border-hairline px-3.5 py-3', className)}>
      <View className="mt-0.5">
        <Icon name="info" size={14} color="ash" />
      </View>
      <Text className="min-w-0 flex-1 font-sans text-12 leading-[18px] text-ash">{text}</Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* The foot                                                                    */
/* -------------------------------------------------------------------------- */

/** The one action, bottom-anchored: run, run again, state an exit, or sign in. Absent when the answer is current. */
function Foot({ read }: { read: BacktestRead }) {
  const { state, running, note, canRun, run } = read;
  const { tap } = useHaptics();
  const press = () => {
    tap();
    run();
  };

  let action: ReactNode = null;
  if (state.status === 'result' && state.sample) {
    action = (
      <View className="min-h-11 items-center justify-center">
        <SignInLink lead="Sample figures." />
      </View>
    );
  } else if (state.status === 'halted') {
    const view = haltView(state.halt);
    if (view.action?.kind === 'review') action = <PrimaryButton href={routes.compileReview}>{view.action.label}</PrimaryButton>;
    else if (view.action?.kind === 'retry' && canRun)
      action = (
        <GhostButton onPress={press} disabled={running}>
          {running ? 'TESTING' : view.action.label}
        </GhostButton>
      );
  } else if (state.status === 'nothing') {
    action = <PrimaryButton href={routes.create}>DESCRIBE A RULE</PrimaryButton>;
  } else if (canRun && (state.status === 'not_run' || state.status === 'failed')) {
    action = (
      <PrimaryButton onPress={press} disabled={running}>
        {running ? 'TESTING' : state.status === 'failed' ? 'TRY AGAIN' : 'RUN THE TEST'}
      </PrimaryButton>
    );
  } else if (canRun && state.status === 'result' && (state.behindCandles ?? 0) > 0) {
    action = (
      <GhostButton onPress={press} disabled={running}>
        {running ? 'TESTING' : 'RUN AGAIN ON NEWER CANDLES'}
      </GhostButton>
    );
  }

  const line = running
    ? 'Reading the recorded candles. This takes a few seconds.'
    : note ?? (state.status === 'not_run' ? 'A run is stored, so opening this again reads nothing until a newer candle closes.' : null);
  if (!action && !line) return null;

  return (
    <Footer className="border-t border-hairline pt-4">
      <View className="gap-2.5" aria-busy={running}>
        {line ? (
          <Text accessibilityLiveRegion="polite" className="font-sans text-12 leading-[18px] text-ash">
            {line}
          </Text>
        ) : null}
        {action}
      </View>
    </Footer>
  );
}

/* -------------------------------------------------------------------------- */
/* Sheets                                                                      */
/* -------------------------------------------------------------------------- */

/** One trade's evidence: the predicate values it passed on, its levels, the candle it ended in and why. */
function TradeSheet({ trade, params, onClose }: { trade: BacktestTrade | null; params: BacktestParams; onClose: () => void }) {
  if (!trade) return null;
  const view = tradeSheet(trade, params);
  return (
    <BottomSheet open onClose={onClose} title={view.title} meta={view.label.toUpperCase()}>
      <View className="gap-4 pb-5">
        <View className="gap-2">
          <Badge label={view.label} icon={OUTCOME_ICON[trade.outcome]} size="md" />
          <FiguredText text={view.sentence} className="font-sans text-13 leading-5 text-bone" />
        </View>

        <Facts rows={view.facts} />

        <View className="gap-2">
          <Label>The rule passed on</Label>
          <View className="rounded-sm border border-hairline bg-panel">
            {view.predicates.map((p, i) => (
              <View key={p.id} className={cx('gap-1 px-3.5 py-2.5', i > 0 && 'border-t border-hairline')}>
                <View className="flex-row items-baseline justify-between gap-3">
                  <Text className="font-mono-medium text-12 text-bone">{p.symbol}</Text>
                  <Num className="shrink text-right text-12">{p.comparison}</Num>
                </View>
                <Num className="text-11 text-ash">{p.at}</Num>
              </View>
            ))}
          </View>
        </View>

        {view.exit ? (
          <View className="gap-2">
            <View className="flex-row items-baseline justify-between gap-3">
              <Label>Exit candle</Label>
              <Num className="text-11 text-ash">{view.exit.at}</Num>
            </View>
            {view.exit.candle ? (
              <Facts rows={view.exit.candle} dense />
            ) : (
              <Text className="font-sans text-12 leading-[18px] text-ash">No price was recorded for this candle.</Text>
            )}
            {view.exit.comparisons.map((c) => (
              <View key={c} className="flex-row items-center gap-2 rounded-sm border border-hairline bg-panel px-3.5 py-2">
                <Icon name="ruler" size={14} color="ash" />
                <Num className="text-12">{c}</Num>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </BottomSheet>
  );
}

function GapsSheet({ result, open, onClose }: { result: BacktestResult; open: boolean; onClose: () => void }) {
  const rows = gapRows(result);
  return (
    <BottomSheet open={open} onClose={onClose} title="GAPS" meta={String(rows.length)}>
      <View className="gap-3 pb-5">
        <FiguredText text={gapSummary(result)} className="font-sans text-13 leading-5 text-ash" />
        <View className="rounded-sm border border-hairline bg-panel">
          {rows.map((g, i) => (
            <View
              key={`${g.key}-${i}`}
              className={cx('min-h-10 flex-row items-center justify-between gap-3 px-3.5 py-2', i > 0 && 'border-t border-hairline')}
            >
              <Num className="shrink text-12">{g.span}</Num>
              <Num className="text-11 text-ash">{g.count}</Num>
            </View>
          ))}
        </View>
      </View>
    </BottomSheet>
  );
}
