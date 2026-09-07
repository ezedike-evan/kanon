import { Text, View } from 'react-native';
import { formatBps, formatDecimal } from '@kanon/spec';
import { Body, BrandBar, Screen, StatusBar, TabBar } from '../components/chrome';
import { Dot, Meta, Num, Panel } from '../components/ui';
import { Link } from '../nav';
import { HOME, RULE, TRADE_ID } from '../lib/demo';
import { routes, tradeRoute } from '../lib/routes';
import { cx } from '../lib/cx';

/**
 * 01 · RULE CARD — home.
 *
 * The rule outranks the chart. The strategy is the hero; the price line is
 * small, monochrome and last. P&L sits below the fold of the rule card, never
 * above it — leading with profit drives the behaviour this product exists to
 * prevent.
 */
export function RuleCardScreen() {
  return (
    <Screen label="01 · RULE CARD (HOME)">
      <StatusBar />
      <BrandBar />

      <Body>
        <Meta className="mt-7.5 tracking-w20">ACTIVE STRATEGY</Meta>

        {/* Tapping the rule is how you reach the chart, not the other way round. */}
        <Panel className="mt-3">
          <Link
            href={routes.compileReview}
            className="border-b border-hairline px-4 pt-4 pb-3.5"
          >
            <View className="flex-row items-center justify-between">
              <Text className="font-mono text-10 tracking-w16 text-signal">
                {RULE.ordinal}
              </Text>
              <View className="flex-row items-center gap-1.5">
                <Dot className="bg-signal" />
                <Text className="font-mono text-9 tracking-w16 text-signal">
                  PINNED ON-CHAIN
                </Text>
              </View>
            </View>
            <Text className="mt-3 font-mono-medium text-17 tracking-t20 text-bone">
              {RULE.name}
            </Text>
            <View className="mt-2.5 flex-row gap-3.5">
              <Num className="text-11 tracking-w08 text-ash">{RULE.asset}</Num>
              <Num className="text-11 tracking-w08 text-ash">{RULE.timeframe}</Num>
              <Num className="text-11 tracking-w08 text-ash">{RULE.pinnedOn}</Num>
            </View>
          </Link>

          <View className="gap-2.75 px-4 pt-3.5 pb-4">
            <Meta className="tracking-w20">
              COMPILED PREDICATES · {RULE.predicates.length}
            </Meta>
            {RULE.predicates.map((text) => (
              <View key={text} className="flex-row items-start gap-2.5">
                <Dot className="mt-1.5 bg-signal" />
                <Text className="flex-1 font-mono text-12p5 text-bone leading-[1.45]">
                  {text}
                </Text>
              </View>
            ))}
          </View>
        </Panel>

        {/* Adherence is the primary metric. It is the largest figure on the screen. */}
        <View className="mt-6.5 flex-row border-y border-hairline">
          <View className="flex-1 gap-2 pt-4 pb-3.5">
            <Meta>TAKEN</Meta>
            <Num className="font-mono-medium text-20 tracking-t20">{HOME.taken}</Num>
          </View>
          <View className="flex-1 gap-2 pt-4 pb-3.5">
            <Meta>BLOCKED</Meta>
            <View className="flex-row items-center gap-1.75">
              <Dot className="bg-refused" />
              <Num className="font-mono-medium text-20 tracking-t20">
                {String(HOME.blocked).padStart(2, '0')}
              </Num>
            </View>
          </View>
          <Link href={routes.blocked} className="flex-[1.3] items-end gap-2 pt-4 pb-3.5">
            <Meta>ADHERENCE</Meta>
            <Num className="font-mono-medium text-34 tracking-t35 leading-[0.9]">
              {formatBps(HOME.adherenceBps, { dp: 1 })}
            </Num>
          </Link>
        </View>

        <View className="mt-3.5 flex-row items-center justify-between">
          <Text className="font-mono text-11 tracking-w06 text-ash">P&amp;L · 30D</Text>
          <Num className="text-11 text-long">
            {formatDecimal(HOME.pnl30d, { signed: true })}
          </Num>
        </View>

        <Link href={tradeRoute(TRADE_ID)} className="mt-auto pt-6 pb-5">
          <View className="w-full flex-row items-end justify-between">
            <View className="gap-1.75">
              <Meta>{RULE.asset}</Meta>
              <Num className="font-mono-medium text-26 tracking-t30">
                {formatDecimal(HOME.price)}
              </Num>
            </View>
            <Num className="text-11 text-refused">{formatBps(HOME.changeBps)}</Num>
          </View>
          <View className="mt-3.5 h-11 w-full flex-row items-end gap-0.5" aria-hidden>
            {HOME.sparkline.map((height, i) => (
              <View
                key={i}
                style={{ height: `${height}%` }}
                className={cx(
                  'flex-1',
                  i >= HOME.sparkline.length - HOME.sparklineHead
                    ? 'bg-ash'
                    : 'bg-hairline',
                )}
              />
            ))}
          </View>
        </Link>
      </Body>

      <TabBar active="rules" />
    </Screen>
  );
}
