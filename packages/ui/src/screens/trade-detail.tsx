import { Text, View } from 'react-native';
import { formatBps, formatDecimal } from '@kanon/spec';
import { Body, Footer, NavBar, Screen } from '../components/chrome';
import { EvidenceChain } from '../components/evidence-chain';
import { EvidenceLink, Meta, Num } from '../components/ui';
import { RULE, TRADE } from '../lib/demo';
import { routes, shareRoute } from '../lib/routes';

/**
 * 06 · TRADE DETAIL · EVIDENCE.
 *
 * The result is stated once and the evidence chain gets the rest of the screen.
 * If verification took more than one tap, "verifiable" would be marketing and
 * this audience would treat it as marketing.
 */
export function TradeDetailScreen({ id }: { id: string }) {
  return (
    <Screen rail="bg-hairline" label="06 · TRADE DETAIL · EVIDENCE">
      <NavBar
        left="←  TRADES"
        leftHref={routes.blocked}
        leftClassName="text-ash tracking-w12"
        right={`TRADE ${id.toUpperCase()}`}
      />

      <Body>
        <View className="mt-6.5 flex-row items-end justify-between">
          <View className="gap-2.25">
            <Text className="font-mono text-11 tracking-w14 text-long">{TRADE.side}</Text>
            <Num className="font-mono-medium text-20 tracking-t20">{RULE.asset}</Num>
          </View>
          <View className="items-end gap-1.75">
            <Meta>RESULT</Meta>
            <Num className="font-mono-medium text-31 tracking-t30 text-long leading-[0.9]">
              {formatDecimal(TRADE.result, { signed: true })}
            </Num>
          </View>
        </View>

        <View className="mt-5.5 flex-row border-y border-hairline">
          <View className="flex-1 gap-1.75 py-3.25">
            <Meta>ENTRY</Meta>
            <Num className="font-mono-medium text-15">{formatDecimal(TRADE.entry)}</Num>
          </View>
          <View className="flex-1 gap-1.75 py-3.25">
            <Meta>EXIT</Meta>
            <Num className="font-mono-medium text-15">{formatDecimal(TRADE.exit)}</Num>
          </View>
          <View className="flex-1 items-end gap-1.75 py-3.25">
            <Meta>RETURN</Meta>
            <Num className="font-mono-medium text-15 text-long">
              {formatBps(TRADE.returnBps, { signed: true })}
            </Num>
          </View>
        </View>

        <Meta className="mt-6.5 tracking-w20">
          EVIDENCE CHAIN · {TRADE.claims.length} CLAIMS
        </Meta>
        <EvidenceChain claims={TRADE.claims} />
        <View className="pb-5" />
      </Body>

      <Footer>
        <EvidenceLink
          label="Verify on-chain"
          hash={RULE.txAbbrev}
          href={shareRoute(RULE.id)}
        />
      </Footer>
    </Screen>
  );
}
