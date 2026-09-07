import { Text, View } from 'react-native';
import { formatBps, formatDecimal } from '@kanon/spec';
import { Body, BrandBar, Footer, Screen, StatusBar } from '../components/chrome';
import { Enter } from '../components/motion';
import { Dot, EvidenceLink, GhostButton, Meta, Num, Panel } from '../components/ui';
import { REFUSAL, RULE, TRADE_ID } from '../lib/demo';
import { routes, tradeRoute } from '../lib/routes';

/**
 * 00 · REFUSAL.
 *
 * Full-bleed, never a toast. It names the predicate that failed and the number
 * that failed it. Refusal is a success state: nothing here apologises, and
 * nothing here is styled as an error.
 */
export function RefusalScreen() {
  return (
    <Screen rail="bg-refused" label="00 · REFUSAL">
      <StatusBar />
      <BrandBar />

      <Body>
        <Enter variant="refuse">
          <View className="mt-11 flex-row items-center gap-2.25">
            <Dot size="size-2" className="bg-refused" />
            <Text className="font-mono-bold text-11 tracking-w20 text-refused">
              REFUSED ON-CHAIN
            </Text>
          </View>

          <Text className="mt-3.5 font-sans text-34 font-medium tracking-t25 text-bone leading-[1.06]">
            Trade blocked by your own rule.
          </Text>

          <View className="mt-8.5 gap-2.5 border-t border-hairline pt-3.5">
            <View className="flex-row items-baseline gap-2.5">
              <Text className="font-mono text-10 tracking-w16 text-signal">
                {RULE.ordinal}
              </Text>
              <Text className="font-mono-medium text-13 text-bone">
                {REFUSAL.predicate}
              </Text>
            </View>
            <Text className="font-mono text-13 text-ash leading-[1.5]">
              {REFUSAL.reason}
            </Text>
          </View>

          <Panel className="mt-7.5">
            <View className="flex-row items-end justify-between gap-4.5 border-b border-hairline px-4 pt-4 pb-3.5">
              <View className="gap-1.75">
                <Meta>REQUIRED HIGH</Meta>
                <Text className="font-mono text-10 tracking-w10 text-ash">
                  PRIOR SWING
                </Text>
              </View>
              <Num className="font-mono-medium text-31 tracking-t30">
                {formatDecimal(REFUSAL.requiredHigh)}
              </Num>
            </View>
            <View className="flex-row items-end justify-between gap-4.5 border-b border-hairline px-4 pt-4 pb-3.5">
              <View className="gap-1.75">
                <Meta>CURRENT PRICE</Meta>
                <Text className="font-mono text-10 tracking-w10 text-ash">
                  {RULE.asset} · {RULE.timeframe}
                </Text>
              </View>
              <Num className="font-mono-medium text-31 tracking-t30">
                {formatDecimal(REFUSAL.currentPrice)}
              </Num>
            </View>
            {/* The number that failed it, given its own row and its own colour. */}
            <View className="flex-row items-center justify-between bg-raised px-4 py-3">
              <Meta>SHORTFALL</Meta>
              <View className="flex-row items-baseline gap-2.5">
                <Num className="text-11 text-ash">{formatBps(REFUSAL.shortfallBps)}</Num>
                <Num className="font-mono-medium text-18 tracking-t20 text-refused">
                  {formatDecimal(REFUSAL.shortfall)}
                </Num>
              </View>
            </View>
          </Panel>

          <View className="mt-4.5 mb-5 flex-row items-center justify-between">
            <Num className="text-10 tracking-w08 text-ash">{REFUSAL.at}</Num>
            <Num className="text-10 tracking-w08 text-ash">BLOCK {REFUSAL.block}</Num>
          </View>
        </Enter>
      </Body>

      <Footer>
        <EvidenceLink
          className="mb-4.5"
          label="View on-chain evidence"
          hash={RULE.txAbbrev}
          href={tradeRoute(TRADE_ID)}
        />
        <GhostButton href={routes.home}>ACKNOWLEDGE</GhostButton>
      </Footer>
    </Screen>
  );
}
