import { Linking, Pressable, Text, View } from 'react-native';
import { formatDecimal } from '@kanon/spec';
import { AutopilotMark } from '../components/autopilot';
import { Body, Screen, StatusBar, TabBar } from '../components/chrome';
import { Dot, Meta, Num } from '../components/ui';
import { Link } from '../nav';
import { cx } from '../lib/cx';
import { useBlockedLog } from '../lib/domains';
import { lossAvoided } from '../lib/live-map';
import { routes, tradeRoute } from '../lib/routes';

/**
 * 07 · BLOCKED TRADES LOG.
 *
 * Trades refused, and the loss they kept the account out of. Adherence is the
 * primary metric, and this is where it is earned. Nothing here is styled as an
 * error and nothing apologises: a refusal is the product working, so its figure
 * is stated the way Analytics states it, as a loss avoided and never as a loss.
 *
 * A refusal the gate decided carries its transaction as its own pressable,
 * beside the row and not inside it: the row opens the evidence chain, the hash
 * opens the chain's explorer. One from before the gate says OFF-CHAIN there.
 */
export function BlockedLogScreen() {
  const BLOCKED = useBlockedLog();
  return (
    <Screen rail="bg-hairline" label="07 · BLOCKED TRADES LOG">
      <StatusBar />
      <View className="shrink-0 flex-row items-center justify-between px-5 pt-5.5">
        <Text className="font-mono text-11 tracking-w16 text-bone">BLOCKED</Text>
        <Text className="font-mono text-10 tracking-w12 text-ash">{BLOCKED.period}</Text>
      </View>

      <Body>
        <View className="mt-5.5 flex-row border-y border-hairline">
          <View className="flex-1 gap-2 py-4">
            <Meta>REFUSED</Meta>
            <Num className="font-mono-medium text-31 tracking-t30 leading-[0.9]">
              {String(BLOCKED.refused).padStart(2, '0')}
            </Num>
          </View>
          <View className="flex-[1.5] items-end gap-2 py-4">
            <Meta>LOSS AVOIDED</Meta>
            <Num className="font-mono-medium text-31 tracking-t30 leading-[0.9]">
              {BLOCKED.loading ? '—' : formatDecimal(lossAvoided(BLOCKED))}
            </Num>
          </View>
        </View>
        <Text className="mt-2.5 font-mono text-10 text-ash leading-[1.5]">
          {BLOCKED.note}
        </Text>
        <Link
          href={routes.analytics}
          aria-label="Analytics: adherence, risk and smart-money flow"
          className="mt-3.5 flex-row items-center justify-between border-y border-hairline py-3"
        >
          <Text className="font-mono text-11 tracking-w06 text-bone">ANALYTICS</Text>
          <Text className="font-mono text-10 tracking-w06 text-verified">ADHERENCE · RISK · FLOW ›</Text>
        </Link>

        {/* Straight under the Analytics row, whose lower hairline is the list's first rule: no band between two lines. */}
        <View className="pb-5">
          {BLOCKED.rows.length === 0 ? (
            <Text className="pt-4 font-mono text-11 text-ash leading-[1.5]">
              Every setup put to the rule so far satisfied it.
            </Text>
          ) : null}
          {BLOCKED.rows.map((row, i) => (
            <View
              key={row.tradeId ?? `${row.symbol}-${row.at}`}
              className={cx('py-3.5', i > 0 && 'border-t border-hairline')}
            >
              <Link
                href={row.tradeId ? tradeRoute(row.tradeId) : routes.refused}
                className="flex-row gap-3 active:opacity-60"
                aria-label={`Refusal ${i + 1} of ${BLOCKED.rows.length}: ${row.symbol}${row.autopilot ? ', by autopilot' : ''}`}
              >
                <Dot className="mt-1.25 bg-refused" />
                <View className="flex-1 gap-2">
                  <View className="flex-row items-baseline justify-between gap-3">
                    <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-2.5 gap-y-1">
                      <Text className="font-mono-medium text-12 text-bone">{row.symbol}</Text>
                      {/* Judged at a candle close, with nobody pressing anything. */}
                      {row.autopilot ? <AutopilotMark label="Autopilot" /> : null}
                    </View>
                    <Num className="text-10 text-ash">{row.at}</Num>
                  </View>
                  {/* The predicate, and the number that failed it. Always both. */}
                  <Num className="text-11p5 text-ash">{row.detail}</Num>
                </View>
              </Link>
              {/* The transaction is its own press, a sibling of the row's: one tap to the chain's word. */}
              {row.tx ? (
                <Pressable
                  role="link"
                  aria-label={`The gate transaction for refusal ${i + 1}, ${row.tx.short}, on ${row.tx.explorer}. Opens outside Kanon.`}
                  onPress={() => void Linking.openURL(row.tx!.url).catch(() => undefined)}
                  className="mt-1.5 ml-4.25 min-h-8 flex-row items-center self-start active:opacity-60"
                >
                  <Num className="text-10 tracking-w06 text-verified">GATE TX {row.tx.short}{'  ↗'}</Num>
                </Pressable>
              ) : row.decided === 'offchain' ? (
                <Text className="mt-1.5 ml-4.25 font-mono text-10 tracking-w06 text-ash">DECIDED OFF-CHAIN</Text>
              ) : null}
            </View>
          ))}
        </View>
      </Body>

      <TabBar active="home" />
    </Screen>
  );
}
