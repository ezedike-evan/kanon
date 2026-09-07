import { ScrollView, Text, View } from 'react-native';
import { formatBps } from '@kanon/spec';
import { Footer, NavBar, Screen } from '../components/chrome';
import { Dot, GhostButton, Meta, Num, PrimaryButton } from '../components/ui';
import { RULE, SHARE_CARD } from '../lib/demo';
import { routes } from '../lib/routes';

/**
 * 09 · SHAREABLE STRATEGY CARD.
 *
 * The growth loop, and the one artifact that leaves the app. It has to survive
 * being seen at thumbnail size, so the two figures that matter — adherence and
 * verified P&L — carry the card and everything else is supporting text.
 *
 * Nothing on it is self-reported. The link at the bottom is the whole claim.
 */
export function StrategyCardScreen() {
  return (
    <Screen label="09 · SHAREABLE STRATEGY CARD">
      <NavBar
        left={`←  ${RULE.ordinal}`}
        leftHref={routes.home}
        leftClassName="text-ash tracking-w12"
        right="SHARE CARD"
      />

      <ScrollView
        className="min-h-0 flex-1"
        contentContainerClassName="grow justify-center px-5"
        showsVerticalScrollIndicator={false}
      >
        <View className="border border-hairline bg-panel">
          <View className="border-b border-hairline px-4.5 pt-4.5 pb-4">
            <View className="flex-row items-center justify-between">
              <Text className="font-mono-bold text-11 tracking-w22 text-bone">KANON</Text>
              <View className="flex-row items-center gap-1.5">
                <Dot className="bg-verified" />
                <Text className="font-mono text-9 tracking-w16 text-verified">
                  VERIFIED ON-CHAIN
                </Text>
              </View>
            </View>
            <Text className="mt-5 font-mono-medium text-18 tracking-t20 text-bone">
              {RULE.name}
            </Text>
            <View className="mt-2.5 flex-row gap-3.5">
              <Num className="text-10 tracking-w10 text-ash">{RULE.asset}</Num>
              <Num className="text-10 tracking-w10 text-ash">{RULE.timeframe}</Num>
              <Num className="text-10 tracking-w10 text-ash">{SHARE_CARD.window}</Num>
            </View>
          </View>

          {/* The spec itself, compressed. A reader can check it against the hash. */}
          <View className="gap-2 border-b border-hairline px-4.5 py-3.5">
            {SHARE_CARD.summary.map((line) => (
              <Num key={line} className="text-11p5 text-ash">
                {line}
              </Num>
            ))}
          </View>

          <View className="flex-row border-b border-hairline">
            <View className="flex-1 gap-2 pt-4 pb-3.5 pl-4.5">
              <Meta className="tracking-w16">ADHERENCE</Meta>
              <Num className="font-mono-medium text-30 tracking-t35 text-signal leading-[0.9]">
                {formatBps(SHARE_CARD.adherenceBps, { dp: 1 })}
              </Num>
            </View>
            <View className="flex-1 items-end gap-2 pt-4 pr-4.5 pb-3.5">
              <Meta className="tracking-w16">VERIFIED P&amp;L</Meta>
              <Num className="font-mono-medium text-30 tracking-t35 text-long leading-[0.9]">
                {formatBps(SHARE_CARD.verifiedPnlBps, { signed: true, dp: 1 })}
              </Num>
            </View>
          </View>

          <View className="flex-row border-b border-hairline">
            <View className="flex-1 gap-1.75 py-3.25 pl-4.5">
              <Meta className="tracking-w16">TAKEN</Meta>
              <Num className="font-mono-medium text-15">{SHARE_CARD.taken}</Num>
            </View>
            <View className="flex-1 gap-1.75 py-3.25">
              <Meta className="tracking-w16">BLOCKED</Meta>
              <Num className="font-mono-medium text-15">{SHARE_CARD.blocked}</Num>
            </View>
            <View className="flex-1 items-end gap-1.75 py-3.25 pr-4.5">
              <Meta className="tracking-w16">OVERRIDES</Meta>
              {/* Zero, and it can only ever be zero. There is no override path. */}
              <Num className="font-mono-medium text-15">{SHARE_CARD.overrides}</Num>
            </View>
          </View>

          <View className="flex-row items-center justify-between gap-3 bg-raised px-4.5 py-3.25">
            <Num className="text-11 text-ash">{SHARE_CARD.url}</Num>
            <Text className="font-mono text-10 tracking-w10 text-verified">CHECK IT ↗</Text>
          </View>
        </View>
        <Text className="mt-3.5 font-mono text-10 text-ash leading-[1.5]">
          {SHARE_CARD.disclaimer}
        </Text>
      </ScrollView>

      <Footer className="flex-row gap-2.5">
        <GhostButton className="flex-1 py-4.25" textClassName="text-12 tracking-w12">
          SAVE IMAGE
        </GhostButton>
        <PrimaryButton className="flex-1 py-4.25" textClassName="text-12 tracking-w12">
          SHARE
        </PrimaryButton>
      </Footer>
    </Screen>
  );
}
