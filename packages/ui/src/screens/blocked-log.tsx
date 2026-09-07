import { Text, View } from 'react-native';
import { formatDecimal } from '@kanon/spec';
import { Body, Screen, StatusBar, TabBar } from '../components/chrome';
import { Dot, Meta, Num } from '../components/ui';
import { Link } from '../nav';
import { BLOCKED } from '../lib/demo';
import { routes } from '../lib/routes';

/**
 * 07 · BLOCKED TRADES LOG.
 *
 * Trades refused, and how many would have lost. Adherence is the primary
 * metric, and this is where it is earned. Nothing here is styled as an error
 * and nothing apologises: a refusal is the product working.
 */
export function BlockedLogScreen() {
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
            <Meta>WOULD HAVE LOST</Meta>
            <Num className="font-mono-medium text-31 tracking-t30 leading-[0.9]">
              {formatDecimal(BLOCKED.wouldHaveLost)}
            </Num>
          </View>
        </View>
        <Text className="mt-2.5 font-mono text-10 text-ash leading-[1.5]">
          {BLOCKED.note}
        </Text>

        <View className="mt-6 pb-5">
          {BLOCKED.rows.map((row, i) => (
            <Link
              key={`${row.symbol}-${row.at}`}
              href={routes.refused}
              className="flex-row gap-3 border-t border-hairline py-3.5"
              aria-label={`Refusal ${i + 1} of ${BLOCKED.rows.length}: ${row.symbol}`}
            >
              <Dot className="mt-1.25 bg-refused" />
              <View className="flex-1 gap-2">
                <View className="flex-row items-baseline justify-between gap-3">
                  <Text className="font-mono-medium text-12 text-bone">{row.symbol}</Text>
                  <Num className="text-10 text-ash">{row.at}</Num>
                </View>
                {/* The predicate, and the number that failed it. Always both. */}
                <Num className="text-11p5 text-ash">{row.detail}</Num>
              </View>
            </Link>
          ))}
        </View>
      </Body>

      <TabBar active="trades" />
    </Screen>
  );
}
